import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindDesktop, desktopStatus, disableDesktop, enableDesktop, sendDesktop } from "../src/desktop/service.js";
import { desktopFile, DesktopError, MAX_MESSAGE_BYTES, readDesktop, sendInput, updateDesktop } from "../src/desktop/store.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let dir: string;
const workspace = { id: "desktop_test", root: process.cwd() };
const target = { threadId: "01a00000-0000-7000-8000-000000000001", projectId: "project_test", hostId: "local" as const };
let bindingId: string;
let send: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const input = (overrides = {}) => ({ intent: "development_plan" as const, userConfirmed: true as const, workspaceId: workspace.id, bindingId, commandId: "command_1", message: "中文计划\n\n```ts\nconst x = '你好';\n```", ...overrides });

beforeEach(async () => {
  dir = isolateStateDir();
  send = vi.fn(async () => ({ threadId: target.threadId, turnId: randomUUID() }));
  close = vi.fn();
  vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ ...target, workspaceRoot: workspace.root, cwd: workspace.root, title: "明确绑定的测试任务" } as never);
  vi.spyOn(desktopIpc, "prepare").mockImplementation(async () => ({ send, close }));
  bindingId = (await bindDesktop(workspace, target)).bindingId;
});
afterEach(() => { vi.restoreAllMocks(); cleanup(dir); });

describe("Desktop 持久化投递", () => {
  it.each(["development_plan", "revision"] as const)("%s 完整正文和意图持久化，意图变化拒绝重放", async intent => {
    enableDesktop(workspace, bindingId);
    const request = { ...input(), intent };
    const first = await sendDesktop(workspace, request, "client");
    expect(first.intent).toBe(intent);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: "C2C_DESKTOP_TASK", version: 1,
      workspaceId: workspace.id, commandId: request.commandId, intent, message: request.message });
    expect(readDesktop(workspace.id)?.deliveries[0].intent).toBe(intent);
    expect(await sendDesktop(workspace, request, "client")).toEqual(first);
    await expect(sendDesktop(workspace, { ...request, intent: intent === "revision" ? "development_plan" : "revision" }, "client"))
      .rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["accepted", "outcome_unknown", "rejected"] as const)("旧 %s 无 intent 记录兼容读取且保留历史", async deliveryStatus => {
    enableDesktop(workspace, bindingId);
    await sendDesktop(workspace, input(), "client");
    const file = desktopFile(workspace.id);
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    const record = old.deliveries[0];
    delete record.intent;
    record.deliveryStatus = deliveryStatus;
    if (deliveryStatus !== "accepted") delete record.turnId;
    if (deliveryStatus === "rejected") { record.errorCode = "DESKTOP_BUSY"; record.errorMessage = "目标忙"; }
    fs.writeFileSync(file, JSON.stringify(old));
    const original = fs.readFileSync(file, "utf8");
    expect(readDesktop(workspace.id)?.deliveries[0].intent).toBeUndefined();
    expect((await desktopStatus(workspace, "command_1")).delivery).toMatchObject({ deliveryStatus, intent: undefined });
    await expect(sendDesktop(workspace, input(), "client")).rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    if (deliveryStatus === "outcome_unknown")
      await expect(sendDesktop(workspace, input({ commandId: "new_command" }), "client")).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
    disableDesktop(workspace);
    expect(readDesktop(workspace.id)?.deliveries).toEqual(old.deliveries);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("新workspace状态查询不创建状态、不连接Desktop", async () => {
    const other = { ...workspace, id: "unbound_test" };
    vi.mocked(desktopIpc.inspect).mockClear();
    expect(await desktopStatus(other)).toMatchObject({ enabled: false, binding: null, delivery: null });
    expect(fs.existsSync(desktopFile(other.id))).toBe(false);
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });
  it("默认关闭；查询不发送，显式启用后才允许投递", async () => {
    expect((await desktopStatus(workspace)).enabled).toBe(false);
    await expect(sendDesktop(workspace, input(), "client")).rejects.toMatchObject({ code: "DESKTOP_DISABLED" });
    expect(send).not.toHaveBeenCalled();
    enableDesktop(workspace, bindingId);
    const result = await sendDesktop(workspace, input(), "client");
    expect(result).toMatchObject({ deliveryStatus: "accepted", threadId: target.threadId });
    expect(result.turnId).toBeTruthy();
    expect(result).not.toHaveProperty("completed");
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ type: "C2C_DESKTOP_TASK", message: input().message });
    await desktopStatus(workspace, "command_1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("保留 64 KiB UTF-8、换行、代码块；超限和额外设置字段拒绝", () => {
    const text = "中".repeat(21845) + "x";
    expect(Buffer.byteLength(text)).toBe(MAX_MESSAGE_BYTES);
    expect(sendInput.parse(input({ message: text })).message).toBe(text);
    expect(() => sendInput.parse(input({ message: text + "x" }))).toThrow();
    for (const field of ["model", "provider", "cwd", "effort", "sandbox", "approval", "permissions", "rpc", "input"])
      expect(() => sendInput.parse({ ...input(), [field]: "override" })).toThrow();
    expect(() => sendInput.parse(input({ message: "\ud800" }))).toThrow();
  });

  it("同 ID 重放返回原记录；客户端/正文冲突拒绝且状态不保存正文", async () => {
    enableDesktop(workspace, bindingId);
    const first = await sendDesktop(workspace, input(), "client");
    expect(await sendDesktop(workspace, input(), "client")).toEqual(first);
    await expect(sendDesktop(workspace, input(), "other_client")).rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    await expect(sendDesktop(workspace, input({ message: "修改" }), "client")).rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
    const stored = fs.readFileSync(desktopFile(workspace.id), "utf8");
    expect(stored).not.toContain("中文计划");
    expect(stored).toContain("messageSha256");
    const status = JSON.stringify(await desktopStatus(workspace, "command_1"));
    expect(status).not.toContain("messageSha256");
    expect(status).not.toContain("clientId");
  });

  it("重新绑定生成新 ID 且关闭；旧请求不切换目标，同command不同binding拒绝", async () => {
    enableDesktop(workspace, bindingId);
    await sendDesktop(workspace, input(), "client");
    const next = await bindDesktop(workspace, target);
    expect(next.bindingId).not.toBe(bindingId);
    expect(readDesktop(workspace.id)?.enabled).toBe(false);
    enableDesktop(workspace, next.bindingId);
    await expect(sendDesktop(workspace, input(), "client")).rejects.toMatchObject({ code: "DESKTOP_BINDING_MISMATCH" });
    await expect(sendDesktop(workspace, input({ bindingId: next.bindingId }), "client")).rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["disable", "rebind", "oauth"])("预检期间 %s 在提交点重新校验，零发送", async change => {
    enableDesktop(workspace, bindingId);
    let valid = true;
    vi.mocked(desktopIpc.prepare).mockImplementation(async () => {
      if (change === "disable") disableDesktop(workspace);
      if (change === "rebind") await bindDesktop(workspace, target);
      valid = false;
      return { send, close };
    });
    await expect(sendDesktop(workspace, input(), "client", () => {
      if (change === "oauth" && !valid) throw new DesktopError("INSUFFICIENT_SCOPE", "授权已撤销");
    })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(0);
    expect(close).toHaveBeenCalled();
  });

  it.each(["DESKTOP_BUSY", "DESKTOP_AWAITING_APPROVAL", "DESKTOP_NO_OWNER", "DESKTOP_WRONG_PROJECT", "DESKTOP_VERSION_UNSUPPORTED", "DESKTOP_ELEVATED"])("%s 预检失败零发送", async code => {
    enableDesktop(workspace, bindingId);
    vi.mocked(desktopIpc.prepare).mockRejectedValue(new DesktopError(code, "预检阻断"));
    await expect(sendDesktop(workspace, input(), "client")).rejects.toMatchObject({ code });
    expect(send).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(0);
  });

  it("先持久化可能已发送；回执丢失不重发也不能更换commandId或绑定绕过", async () => {
    enableDesktop(workspace, bindingId);
    send.mockImplementation(async () => {
      expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
      throw new Error("机密正文 不应出现在响应");
    });
    const result = await sendDesktop(workspace, input(), "client");
    expect(result.deliveryStatus).toBe("outcome_unknown");
    expect(JSON.stringify(result)).not.toContain("机密正文");
    expect(await sendDesktop(workspace, input(), "client")).toEqual(result);
    await expect(sendDesktop(workspace, input({ commandId: "command_2" }), "client")).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
    const next = await bindDesktop(workspace, target);
    enableDesktop(workspace, next.bindingId);
    await expect(sendDesktop(workspace, input({ bindingId: next.bindingId, commandId: "command_2" }), "client")).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("已越过提交点后撤权不会伪称撤回消息", async () => {
    enableDesktop(workspace, bindingId);
    send.mockImplementation(async () => {
      disableDesktop(workspace);
      return { threadId: target.threadId, turnId: randomUUID() };
    });
    expect((await sendDesktop(workspace, input(), "client")).deliveryStatus).toBe("accepted");
    expect(readDesktop(workspace.id)?.enabled).toBe(false);
    expect((await desktopStatus(workspace, "command_1")).delivery?.deliveryStatus).toBe("accepted");
  });

  it.each(["DESKTOP_BUSY", "DESKTOP_APPROVAL_PENDING", "DESKTOP_NO_OWNER"])("最后重检 %s 确定零发送时保存rejected及原因，不永久阻断workspace", async code => {
    enableDesktop(workspace, bindingId);
    send.mockRejectedValue(Object.assign(new DesktopError(code, "不能泄露的底层正文"), { notSent: true }));
    const rejected = await sendDesktop(workspace, input(), "client");
    expect(rejected).toMatchObject({ deliveryStatus: "rejected", error: code });
    expect(rejected.message).not.toContain("底层正文");
    expect(await sendDesktop(workspace, input(), "client")).toEqual(rejected);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await desktopStatus(workspace)).unresolvedDelivery).toBe(false);
    send.mockResolvedValue({ threadId: target.threadId, turnId: randomUUID() });
    expect((await sendDesktop(workspace, input({ commandId: "explicit_new_request" }), "client")).deliveryStatus).toBe("accepted");
  });

  it("没有明确notSent证据不能将busy错误当成零发送", async () => {
    enableDesktop(workspace, bindingId);
    send.mockRejectedValue(new DesktopError("DESKTOP_BUSY", "busy"));
    expect((await sendDesktop(workspace, input(), "client")).deliveryStatus).toBe("outcome_unknown");
  });

  it("提交记录已替换但清理锁失败，返回unknown且实际零发送", async () => {
    enableDesktop(workspace, bindingId);
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (String(file) === `${desktopFile(workspace.id)}.lock`) throw new Error("锁清理失败");
      unlink(file);
    });
    const result = await sendDesktop(workspace, input(), "client");
    expect(result.deliveryStatus).toBe("outcome_unknown");
    expect(send).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(1);
  });

  it.each([{}, { threadId: randomUUID(), turnId: randomUUID() }, { threadId: target.threadId, turnId: "fake" }])("缺失或错误真实回执不能 accepted", async receipt => {
    enableDesktop(workspace, bindingId);
    send.mockResolvedValue(receipt);
    expect((await sendDesktop(workspace, input(), "client")).deliveryStatus).toBe("outcome_unknown");
  });

  it("接受回执后落盘失败保持unknown，重启不重发", async () => {
    enableDesktop(workspace, bindingId);
    send.mockImplementation(async () => {
      fs.writeFileSync(`${desktopFile(workspace.id)}.lock`, "模拟其他进程或崩溃遗留锁");
      return { threadId: target.threadId, turnId: randomUUID() };
    });
    expect((await sendDesktop(workspace, input(), "client")).deliveryStatus).toBe("outcome_unknown");
    expect((await sendDesktop(workspace, input(), "client")).deliveryStatus).toBe("outcome_unknown");
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("状态损坏、已初始化文件丢失和重复ID均拒绝重置", async () => {
    fs.writeFileSync(desktopFile(workspace.id), "bad json");
    expect(() => readDesktop(workspace.id)).toThrow(DesktopError);
    fs.unlinkSync(desktopFile(workspace.id));
    expect(() => readDesktop(workspace.id)).toThrow(DesktopError);
    await expect(bindDesktop(workspace, target)).rejects.toMatchObject({ code: "DESKTOP_STATE_CORRUPT" });
    expect(send).not.toHaveBeenCalled();
  });

  it("重复ID及伪造accepted状态视为损坏；提交前原子写失败零发送", async () => {
    enableDesktop(workspace, bindingId);
    const original = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === desktopFile(workspace.id)) throw new Error("模拟状态落盘失败");
      return original(from, to);
    });
    await expect(sendDesktop(workspace, input(), "client")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(0);
    rename.mockRestore();
    await sendDesktop(workspace, input(), "client");
    expect(() => updateDesktop(workspace.id, state => {
      state!.deliveries.push({ ...state!.deliveries[0] });
      return { state: state!, result: undefined };
    })).toThrow();
    const broken = readDesktop(workspace.id)!;
    delete broken.deliveries[0].turnId;
    fs.writeFileSync(desktopFile(workspace.id), JSON.stringify(broken));
    expect(() => readDesktop(workspace.id)).toThrow(DesktopError);
  });

  it("不等待执行完成，只等待接受；读取状态失败不修改历史", async () => {
    enableDesktop(workspace, bindingId);
    const result = await sendDesktop(workspace, input(), "client");
    expect(result.deliveryStatus).toBe("accepted");
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    vi.mocked(desktopIpc.inspect).mockRejectedValue(new DesktopError("DESKTOP_OFFLINE", "Desktop 离线"));
    expect((await desktopStatus(workspace)).availability.error).toBe("DESKTOP_OFFLINE");
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
  });
});

function child(script: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", script], { env: globalThis.process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    process.stderr.on("data", chunk => { errors += chunk; });
    process.once("error", reject);
    process.once("exit", code => code === 0 || code === 7 || code === 8 ? resolve(code) : reject(new Error(errors)));
  });
}
function workerScript(mode: string): string {
  const service = pathToFileURL(path.resolve("src/desktop/service.ts")).href;
  const ipc = pathToFileURL(path.resolve("src/desktop/ipc.ts")).href;
  const script = path.join(dir, `worker-${mode}.mjs`);
  fs.writeFileSync(script, `import fs from 'node:fs';
import { sendDesktop } from ${JSON.stringify(service)};
import { desktopIpc } from ${JSON.stringify(ipc)};
desktopIpc.prepare = async () => {
  await new Promise(r => setTimeout(r, 20));
  return {close(){}, async send() {
    if (${JSON.stringify(mode)} === 'before') process.exit(7);
    fs.appendFileSync(${JSON.stringify(path.join(dir, "attempts.txt"))}, 'attempt\\n');
    if (${JSON.stringify(mode)} === 'after') process.exit(8);
    await new Promise(r => setTimeout(r, 80));
    return {threadId:${JSON.stringify(target.threadId)},turnId:'01a00000-0000-7000-8000-000000000002'};
  }};
};
try { await sendDesktop(${JSON.stringify(workspace)}, ${JSON.stringify(input())}, 'client'); }
catch(e) { if (!['DESKTOP_STORE_BUSY','DESKTOP_OUTCOME_UNRESOLVED'].includes(e.code)) throw e; }
`);
  return script;
}
describe("跨进程与崩溃边界（假 Desktop）", () => {
  it("多个并发请求最多一次进入真实发送尝试", async () => {
    enableDesktop(workspace, bindingId);
    const script = workerScript("normal");
    await Promise.all(Array.from({ length: 8 }, () => child(script)));
    expect(fs.readFileSync(path.join(dir, "attempts.txt"), "utf8")).toBe("attempt\n");
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(1);
  }, 20000);
  it.each(["before", "after"])("%s 发送时硬崩溃，进程重启不重发", async mode => {
    enableDesktop(workspace, bindingId);
    await child(workerScript(mode));
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
    await child(workerScript("normal"));
    const count = path.join(dir, "attempts.txt");
    expect(fs.existsSync(count) ? fs.readFileSync(count, "utf8") : "").toBe(mode === "before" ? "" : "attempt\n");
  }, 20000);
});
