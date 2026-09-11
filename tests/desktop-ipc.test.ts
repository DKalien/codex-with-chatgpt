import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopIpcClient,
  resolveDesktopHelperPath,
  validateDesktopMessage,
  validateDesktopTarget,
} from "../src/desktop/ipc.js";
import { MAX_MESSAGE_BYTES } from "../src/desktop/store.js";

const target = {
  threadId: "01a00000-0000-7000-8000-000000000001",
  hostId: "local",
  projectId: "project_test",
  workspaceRoot: "D:\\python\\codex-with-chatgpt",
} as const;

type FakeRequest = Record<string, unknown> & { op?: string; id?: string };
type FakeReply = { ok: true; value: unknown } | { ok: false; code: string; notSent?: boolean };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function fakeSpawner(replyFor: (request: FakeRequest) => FakeReply = request => {
  if (request.op === "inspect" || request.op === "prepare") {
    return {
      ok: true,
      value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" },
    };
  }
  if (request.op === "send") {
    return { ok: true, value: { threadId: target.threadId, turnId: "01a00000-0000-7000-8000-000000000002" } };
  }
  return { ok: true, value: {} };
}) {
  const requests: FakeRequest[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn((_command: string, _args: string[], _options: unknown) => {
    const child = new FakeChild();
    children.push(child);
    let buffered = "";
    child.stdin.on("data", chunk => {
      buffered += Buffer.from(chunk).toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) {
          const request = JSON.parse(line) as FakeRequest;
          requests.push(request);
          const reply = replyFor(request);
          setImmediate(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`));
        }
        newline = buffered.indexOf("\n");
      }
    });
    return child as unknown as ChildProcess;
  });
  return { spawnImpl, requests, children };
}

function makeClient(spawnImpl: ReturnType<typeof fakeSpawner>["spawnImpl"]) {
  return new DesktopIpcClient({
    platform: "win32",
    helperPath: resolveDesktopHelperPath(),
    spawnImpl,
    requestTimeoutMs: 200,
    sendTimeoutMs: 200,
  });
}

describe("Desktop IPC wrapper（fake helper）", () => {
  it("本机确认超时关闭helper，不返回授权结果", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const client = new DesktopIpcClient({ platform: "win32", spawnImpl: () => child as unknown as ChildProcess });
      const result = expect(client.confirmCurrent(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CONFIRMATION_CANCELLED" });
      await vi.advanceTimersByTimeAsync(120_000);
      await result;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it("快捷身份/确认只传workspace，当前ID来自环境，确认取消不变成成功", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    try {
      const fake = fakeSpawner(request => request.op === "current_confirm" ?
        { ok: false, code: "DESKTOP_CONFIRMATION_CANCELLED", notSent: true } :
        { ok: true, value: { ...target, title: "当前会话", cwd: target.workspaceRoot, runtimeStatus: "active" } });
      const client = makeClient(fake.spawnImpl);
      expect((await client.currentIdentity(target.workspaceRoot)).runtimeStatus).toBe("active");
      await expect(client.confirmCurrent(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CONFIRMATION_CANCELLED" });
      for (const request of fake.requests) {
        expect(Object.keys(request).sort()).toEqual(["id", "op", "workspaceRoot"]);
        expect(request.workspaceRoot).toBe(target.workspaceRoot);
      }
      expect(fake.requests.map(r => r.op)).toEqual(["current_identity", "current_confirm"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("缺失/伪造当前ID或helper错目标不能绑定", async () => {
    const fake = fakeSpawner(() => ({ ok: true, value: { ...target, threadId: randomUUID(), title: "错误会话", cwd: target.workspaceRoot } }));
    try {
      vi.stubEnv("CODEX_THREAD_ID", "");
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CURRENT_CONTEXT_INVALID" });
      vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", randomUUID());
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CURRENT_CONTEXT_INVALID" });
      expect(fake.spawnImpl).not.toHaveBeenCalled();
      vi.stubEnv("CODEX_SESSION_ID", target.threadId);
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });
    } finally { vi.unstubAllEnvs(); }
  });
  it("使用隔离、无 shell 的 helper，并保留中文多行正文直到接受回执", async () => {
    const fake = fakeSpawner();
    const client = makeClient(fake.spawnImpl);
    const message = "请按已确认方案执行。\n\n```ts\nconst greeting = '你好';\n```";

    const connection = await client.prepare(target);
    await expect(connection.send(message)).resolves.toEqual({
      threadId: target.threadId,
      turnId: "01a00000-0000-7000-8000-000000000002",
    });
    connection.close();

    expect(fake.spawnImpl).toHaveBeenCalledWith(
      "python",
      ["-I", "-B", "-X", "utf8", resolveDesktopHelperPath()],
      expect.objectContaining({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }),
    );
    expect(fake.requests.map(request => request.op)).toEqual(["prepare", "send"]);
    expect(fake.requests[0]).toMatchObject({ op: "prepare", target });
    expect(fake.requests[1]).toMatchObject({ op: "send", message });
    expect(fake.requests[1]).not.toHaveProperty("model");
    expect(fake.requests[1]).not.toHaveProperty("provider");
    expect(fake.requests[1]).not.toHaveProperty("cwd");
    expect(fake.requests[1]).not.toHaveProperty("sandbox");
  });

  it("支持 UUIDv7，并在输入边界拒绝额外字段、非法 Unicode 与超限正文", () => {
    expect(validateDesktopTarget(target)).toEqual(target);
    expect(validateDesktopMessage("中".repeat(21845) + "x")).toHaveLength(21846);
    expect(Buffer.byteLength("中".repeat(21845) + "x", "utf8")).toBe(MAX_MESSAGE_BYTES);
    expect(() => validateDesktopTarget({ ...target, extra: true } as never)).toThrowError(/格式无效/);
    expect(() => validateDesktopMessage("中".repeat(21846))).toThrowError(/64 KiB/);
    expect(() => validateDesktopMessage("\ud800")).toThrowError(/格式无效/);
  });

  it("不在非 Windows 平台启动 helper", async () => {
    const spawnImpl = vi.fn();
    const client = new DesktopIpcClient({ platform: "linux", spawnImpl });
    await expect(client.inspect(target)).rejects.toMatchObject({ code: "DESKTOP_UNSUPPORTED_PLATFORM" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("helper 返回错目标或错回执时 fail closed，不伪造 accepted", async () => {
    const wrongInfo = fakeSpawner(request => {
      if (request.op === "inspect") {
        return { ok: true, value: { ...target, threadId: randomUUID(), title: "伪造", cwd: target.workspaceRoot } };
      }
      return { ok: true, value: {} };
    });
    await expect(makeClient(wrongInfo.spawnImpl).inspect(target)).rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });

    const wrongReceipt = fakeSpawner(request => {
      if (request.op === "send") return { ok: true, value: { threadId: randomUUID(), turnId: randomUUID() } };
      return {
        ok: true,
        value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot },
      };
    });
    const connection = await makeClient(wrongReceipt.spawnImpl).prepare(target);
    await expect(connection.send("执行修订")).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNKNOWN", notSent: false });
    connection.close();
  });

  it("helper 错误缺少 notSent 时，send 仍按结果不明处理", async () => {
    const fake = fakeSpawner(request => {
      if (request.op === "send") return { ok: false, code: "DESKTOP_BUSY" };
      return {
        ok: true,
        value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot },
      };
    });
    const connection = await makeClient(fake.spawnImpl).prepare(target);
    await expect(connection.send("执行修订")).rejects.toMatchObject({ code: "DESKTOP_BUSY", notSent: false });
    connection.close();
  });

  it("stdout 非法 UTF-8 作为协议错误处理，且不会把原始内容带回错误", async () => {
    const fake = fakeSpawner(request => {
      if (request.op === "inspect") return { ok: true, value: {} };
      return { ok: true, value: {} };
    });
    const child = fake.children;
    const client = makeClient(fake.spawnImpl);
    const inspection = client.inspect(target);
    await vi.waitFor(() => expect(child).toHaveLength(1));
    child[0].stdout.write(Buffer.from([0xff, 0x0a]));
    try {
      await inspection;
      throw new Error("非法 UTF-8 未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
      expect(String((error as Error).message)).not.toContain("ff");
    }
  });
});
