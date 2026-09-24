import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindCurrentDesktop, disableDesktop } from "../src/desktop/service.js";
import { DesktopError, desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = { id: "desktop_current_test", root: process.cwd() };
const observed = { threadId: "01a00000-0000-7000-8000-000000000001", hostId: "local", projectId: "project_test",
  title: "当前会话", workspaceRoot: workspace.root, cwd: workspace.root, runtimeStatus: "active" };
let directory: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  directory = isolateStateDir(); exitCode = process.exitCode;
  vi.spyOn(desktopIpc, "currentIdentity").mockResolvedValue({ ...observed });
  vi.spyOn(desktopIpc, "confirmCurrent").mockResolvedValue({ ...observed });
  vi.spyOn(desktopIpc, "prepare").mockRejectedValue(new Error("绑定不应进入发送路径"));
});
afterEach(() => { vi.restoreAllMocks(); cleanup(directory); process.exitCode = exitCode; });
function bytes() { const f = desktopFile(workspace.id); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; }

it("active 当前会话一次原子绑定启用，再次操作验证身份但无需确认或换ID", async () => {
  const first = await bindCurrentDesktop(workspace);
  expect(first).toMatchObject({ alreadyEnabled: false, enabled: true, binding: { threadId: observed.threadId } });
  expect(readDesktop(workspace.id)?.revision).toBe(1);
  const before = bytes();
  expect(await bindCurrentDesktop(workspace)).toMatchObject({ alreadyEnabled: true, binding: first.binding });
  expect(bytes()).toBe(before);
  expect(desktopIpc.currentIdentity).toHaveBeenCalledTimes(2);
  expect(desktopIpc.confirmCurrent).toHaveBeenCalledTimes(1);
  expect(desktopIpc.prepare).not.toHaveBeenCalled();
});

it("同target disabled必须再次确认，复用bindingId", async () => {
  const first = await bindCurrentDesktop(workspace);
  disableDesktop(workspace);
  const second = await bindCurrentDesktop(workspace);
  expect(second.binding.bindingId).toBe(first.binding.bindingId);
  expect(desktopIpc.confirmCurrent).toHaveBeenCalledTimes(2);
});

it("不同target生成新bindingId，保持全部旧投递记录", async () => {
  const first = await bindCurrentDesktop(workspace);
  const record = { commandId: "old_id", clientId: "old_client", bindingId: first.binding.bindingId,
    threadId: observed.threadId, turnId: randomUUID(), messageSha256: "0".repeat(64), messageBytes: 3,
    deliveryStatus: "accepted" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  updateDesktop(workspace.id, state => { state!.deliveries.push(record); return { state: state!, result: undefined }; });
  const next = { ...observed, threadId: randomUUID(), title: "新的当前会话" };
  vi.mocked(desktopIpc.currentIdentity).mockResolvedValue(next);
  vi.mocked(desktopIpc.confirmCurrent).mockResolvedValue(next);
  const second = await bindCurrentDesktop(workspace);
  expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
  expect(readDesktop(workspace.id)?.deliveries).toEqual([record]);
});

it.each(["DESKTOP_CURRENT_CONTEXT_INVALID", "DESKTOP_PROJECT_MISMATCH", "DESKTOP_NO_OWNER",
  "DESKTOP_ELEVATED"])("%s 零绑定、零确认、零启用", async code => {
  vi.mocked(desktopIpc.currentIdentity).mockRejectedValue(new DesktopError(code, "拒绝"));
  await expect(bindCurrentDesktop(workspace)).rejects.toMatchObject({ code });
  expect(bytes()).toBeNull();
  expect(desktopIpc.confirmCurrent).not.toHaveBeenCalled();
});

it("取消本机确认，已有绑定和历史文件字节完全不变", async () => {
  await bindCurrentDesktop(workspace); disableDesktop(workspace);
  const before = bytes();
  vi.mocked(desktopIpc.confirmCurrent).mockRejectedValue(new DesktopError("DESKTOP_CONFIRMATION_CANCELLED", "取消"));
  await expect(bindCurrentDesktop(workspace)).rejects.toMatchObject({ code: "DESKTOP_CONFIRMATION_CANCELLED" });
  expect(bytes()).toBe(before);
});

it("确认期间重复disable仍提升revision，旧快照不能覆盖撤权", async () => {
  await bindCurrentDesktop(workspace); disableDesktop(workspace);
  vi.mocked(desktopIpc.confirmCurrent).mockImplementation(async () => { disableDesktop(workspace); return { ...observed }; });
  await expect(bindCurrentDesktop(workspace)).rejects.toMatchObject({ code: "DESKTOP_BINDING_CHANGED" });
  expect(readDesktop(workspace.id)?.enabled).toBe(false);
});

it("确认期间identity变化不落盘", async () => {
  vi.mocked(desktopIpc.confirmCurrent).mockResolvedValue({ ...observed, threadId: randomUUID() });
  await expect(bindCurrentDesktop(workspace)).rejects.toMatchObject({ code: "DESKTOP_BINDING_CHANGED" });
  expect(bytes()).toBeNull();
});

it("unknown历史在快速入口阻断，禁止借rebind/enable清理", async () => {
  const first = await bindCurrentDesktop(workspace);
  updateDesktop(workspace.id, state => {
    state!.deliveries.push({ commandId: "unknown_id", clientId: "client", bindingId: first.binding.bindingId,
      threadId: observed.threadId, messageSha256: "0".repeat(64), messageBytes: 3, deliveryStatus: "outcome_unknown",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return { state: state!, result: undefined };
  });
  const before = bytes();
  await expect(bindCurrentDesktop(workspace)).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
  expect(bytes()).toBe(before);
  expect(desktopIpc.confirmCurrent).toHaveBeenCalledTimes(1);
});

it("旧无revision状态可读，下一次受控写入才添加revision", async () => {
  await bindCurrentDesktop(workspace); disableDesktop(workspace);
  const state = JSON.parse(bytes()!); delete state.revision;
  fs.writeFileSync(desktopFile(workspace.id), JSON.stringify(state));
  const before = bytes();
  expect(readDesktop(workspace.id)?.revision).toBeUndefined(); expect(bytes()).toBe(before);
  await bindCurrentDesktop(workspace);
  expect(readDesktop(workspace.id)?.revision).toBe(1);
});

it("CLI 无需ID参数成功，拒绝target覆盖和免确认选项", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "bind-current", "--json"]);
  expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ ok: true, enabled: true, binding: { threadId: observed.threadId } });
  for (const option of ["--thread", "--project", "--host", "--binding", "--yes", "--accept-desktop-permissions"]) {
    const cli = new Command().exitOverride(); registerDesktopCommands(cli);
    await expect(cli.parseAsync(["node", "c2c", "desktop", "bind-current", option, "override"])).rejects.toThrow();
  }
  expect(desktopIpc.confirmCurrent).toHaveBeenCalledTimes(1);
});

it("CLI diagnose JSON 只读诊断，接受 workspace 参数但不初始化状态", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const diagnosis = {
    mode: "behavioral" as const,
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: true,
    followingChangedSent: true,
    stateReceived: true,
    stateChange: "snapshot" as const,
  };
  vi.spyOn(desktopIpc, "diagnose").mockResolvedValue(diagnosis);
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "diagnose", "-w", workspace.root, "--json"]);
  expect(JSON.parse(String(out.mock.calls[0][0]))).toEqual({ ok: true, ...diagnosis });
  expect(desktopIpc.diagnose).toHaveBeenCalledOnce();
  expect(bytes()).toBeNull();
});

it("CLI compatibility 别名仍调用 diagnose，且不做信任分类", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const diagnose = vi.spyOn(desktopIpc, "diagnose").mockResolvedValue({
    mode: "behavioral" as const,
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: false,
    followingChangedSent: true,
    stateReceived: false,
    stateChange: null,
  });
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "compatibility", "--json"]);
  expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ ok: true, processStable: true, stateChange: null });
  expect(diagnose).toHaveBeenCalledOnce();
});

it("CLI bind-current 错误只输出安全消息，不带回 helper 诊断对象", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const failure = new DesktopError("DESKTOP_STATE_UNAVAILABLE", "secret token pipe");
  (failure as DesktopError & { compatibility: unknown }).compatibility = {
    token: "secret-token",
    pipe: "\\\\.\\pipe\\secret",
  };
  vi.mocked(desktopIpc.currentIdentity).mockRejectedValue(failure);
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "bind-current", "--json"]);
  const payload = JSON.parse(String(out.mock.calls[0][0])) as Record<string, unknown>;
  expect(payload).toMatchObject({ ok: false, error: "DESKTOP_STATE_UNAVAILABLE" });
  expect(payload).not.toHaveProperty("compatibility");
  expect(payload).not.toHaveProperty("token");
  expect(payload).not.toHaveProperty("pipe");
  expect(String(payload.message)).not.toContain("secret");
  expect(bytes()).toBeNull();
});
