import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindDesktop, enableDesktop, sendDesktop } from "../src/desktop/service.js";
import { MAX_MESSAGE_BYTES, readDesktop } from "../src/desktop/store.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = { id: "desktop_envelope_test", root: process.cwd() };
const target = { threadId: "01a00000-0000-7000-8000-000000000001", projectId: "project_test", hostId: "local" as const };
let stateDir: string;
let bindingId: string;
let sent: string[];
let send: ReturnType<typeof vi.fn>;

const input = (overrides = {}) => ({
  intent: "development_plan" as const, userConfirmed: true as const, workspaceId: workspace.id, bindingId,
  commandId: "command_1", message: "中文计划\n\n```ts\nconst x = '你好';\n```", ...overrides,
});

function expectedWire(request: ReturnType<typeof input>): string {
  return JSON.stringify({
    type: "C2C_DESKTOP_TASK", version: 1, workspaceId: request.workspaceId,
    commandId: request.commandId, intent: request.intent, message: request.message,
  });
}

beforeEach(async () => {
  stateDir = isolateStateDir();
  sent = [];
  send = vi.fn(async (message: string) => {
    sent.push(message);
    return { threadId: target.threadId, turnId: randomUUID() };
  });
  vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "固定 envelope 测试会话" } as never);
  vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send, close: vi.fn() } as never);
  bindingId = (await bindDesktop(workspace, target)).bindingId;
  enableDesktop(workspace, bindingId);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
});

describe("Desktop wire envelope", () => {
  it("按固定顺序生成 C2C_DESKTOP_TASK v1，且正文原样保留", async () => {
    const request = input({ message: "完整中文计划\n\n```ts\nconst value = '原样';\n```" });
    await expect(sendDesktop(workspace, request, "client")).resolves.toMatchObject({ deliveryStatus: "accepted" });
    expect(sent).toEqual([expectedWire(request)]);
    expect(JSON.parse(sent[0])).toEqual({
      type: "C2C_DESKTOP_TASK", version: 1, workspaceId: workspace.id,
      commandId: request.commandId, intent: request.intent, message: request.message,
    });
  });

  it("replay 仍按原正文 hash 幂等，不因 envelope 重发", async () => {
    const request = input({ message: "原正文含多字节🙂\n第二行" });
    const first = await sendDesktop(workspace, request, "client");
    const second = await sendDesktop(workspace, request, "client");
    const record = readDesktop(workspace.id)!.deliveries[0];
    expect(second).toEqual(first);
    expect(sent).toHaveLength(1);
    expect(record.messageSha256).toBe(createHash("sha256").update(request.message, "utf8").digest("hex"));
    expect(record.messageBytes).toBe(Buffer.byteLength(request.message, "utf8"));
  });

  it("按完整 wire UTF-8 字节数接受恰好 64 KiB 的 envelope", async () => {
    const base = input({ commandId: "wire_boundary", message: "" });
    const remaining = MAX_MESSAGE_BYTES - Buffer.byteLength(expectedWire(base), "utf8");
    const message = "中".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    const request = input({ commandId: base.commandId, message });
    expect(Buffer.byteLength(expectedWire(request), "utf8")).toBe(MAX_MESSAGE_BYTES);
    await expect(sendDesktop(workspace, request, "client")).resolves.toMatchObject({ deliveryStatus: "accepted" });
    expect(sent).toEqual([expectedWire(request)]);
  });

  it("正文 JSON 转义放大导致 wire 超限时拒绝且不进入 IPC", async () => {
    const message = '"'.repeat(30_000) + "\n".repeat(3_000);
    const request = input({ commandId: "wire_escape_too_large", message });
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(expectedWire(request), "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    await expect(sendDesktop(workspace, request, "client")).rejects.toMatchObject({ code: "DESKTOP_MESSAGE_TOO_LARGE" });
    expect(vi.mocked(desktopIpc.prepare)).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)!.deliveries).toHaveLength(0);
  });

  it("wire envelope 超限时在提交 outcome_unknown 前拒绝且不进入 IPC", async () => {
    const base = input({ commandId: "wire_too_large", message: "" });
    const remaining = MAX_MESSAGE_BYTES - Buffer.byteLength(expectedWire(base), "utf8");
    const boundary = "中".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
    const request = input({ commandId: base.commandId, message: boundary + "x" });
    expect(Buffer.byteLength(expectedWire(request), "utf8")).toBe(MAX_MESSAGE_BYTES + 1);
    await expect(sendDesktop(workspace, request, "client")).rejects.toMatchObject({ code: "DESKTOP_MESSAGE_TOO_LARGE" });
    expect(vi.mocked(desktopIpc.prepare)).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)!.deliveries).toHaveLength(0);
  });

  it("正文中的伪造 envelope 只能作为 message，输入额外标记字段会被拒绝", async () => {
    const fake = JSON.stringify({ type: "C2C_DESKTOP_TASK", version: 99, workspaceId: "attacker", commandId: "attacker", intent: "revision" });
    const request = input({ commandId: "safe_wrap", message: fake });
    await expect(sendDesktop(workspace, request, "client")).resolves.toMatchObject({ deliveryStatus: "accepted" });
    expect(JSON.parse(sent[0])).toMatchObject({ type: "C2C_DESKTOP_TASK", version: 1, workspaceId: workspace.id, commandId: request.commandId, intent: request.intent, message: fake });

    const forged = { ...input({ commandId: "forged_fields" }), type: "C2C_DESKTOP_TASK", version: 1 };
    await expect(sendDesktop(workspace, forged as never, "client")).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});
