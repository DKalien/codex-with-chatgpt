import { createHash } from "node:crypto";
import { C2CError } from "../errors.js";
import { DesktopClient, DesktopIpcError } from "./ipc.js";
import { readDesktop, updateDesktop, type DesktopBinding, type DesktopDelivery } from "./store.js";

export const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MESSAGE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DesktopDeps { connect?: typeof DesktopClient.connect; busyWaitMs?: number; pollMs?: number }
interface SendInput { workspaceId: string; commandId: string; message: string }

export function formatDesktopTask(input: SendInput): string {
  return `[C2C_DESKTOP_TASK] workspaceId=${input.workspaceId} commandId=${input.commandId}\n\n${input.message}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function requireBinding(workspaceId: string): DesktopBinding {
  const { binding } = readDesktop(workspaceId);
  if (!binding) throw new C2CError("DESKTOP_NOT_BOUND", "当前项目尚未绑定 Codex Desktop 会话，请先在 Codex 会话中运行 desktop bind-current");
  return binding;
}

export async function sendToDesktop(input: SendInput, opts: DesktopDeps = {}): Promise<DesktopDelivery> {
  const { workspaceId, commandId, message } = input;
  if (!COMMAND_ID.test(commandId)) throw new C2CError("INVALID_COMMAND_ID", "commandId 只能包含字母、数字、下划线和连字符，长度 1-128");
  if (!message.trim()) throw new C2CError("EMPTY_MESSAGE", "消息不能为空");
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw new C2CError("MESSAGE_TOO_LARGE", "消息超过 64 KiB");
  const binding = requireBinding(workspaceId);
  const messageSha256 = sha256(message);

  const prior = () => {
    const found = readDesktop(workspaceId).deliveries.find((d) => d.commandId === commandId);
    if (!found) return undefined;
    if (found.messageSha256 !== messageSha256) throw new C2CError("COMMAND_CONFLICT", "该 commandId 已用于不同的消息，请换一个 commandId");
    return found.status === "rejected" ? undefined : found;
  };
  const existing = prior();
  if (existing) return existing;

  const { busyWaitMs = 60_000, pollMs = 1_000 } = opts;
  const client = await (opts.connect ?? DesktopClient.connect)();
  try {
    const deadline = Date.now() + busyWaitMs;
    while ((await client.snapshot(binding.threadId)).busy) {
      if (Date.now() + pollMs > deadline) throw new C2CError("DESKTOP_BUSY", "Codex Desktop 当前会话正忙，消息未发送，请稍后重试");
      await sleep(pollMs);
    }

    const now = new Date().toISOString();
    const claimed = updateDesktop(workspaceId, (state) => {
      const found = state.deliveries.find((d) => d.commandId === commandId);
      if (found && found.status !== "rejected") return found;
      const record: DesktopDelivery = { commandId, status: "sending", messageSha256, createdAt: found?.createdAt ?? now, updatedAt: now };
      state.deliveries = [...state.deliveries.filter((d) => d !== found), record];
      return null;
    });
    if (claimed) return claimed;

    const finish = (patch: Partial<DesktopDelivery>) => updateDesktop(workspaceId, (state) => {
      const record = state.deliveries.find((d) => d.commandId === commandId)!;
      return Object.assign(record, { error: undefined, ...patch, updatedAt: new Date().toISOString() });
    });
    try {
      const { turnId } = await client.startTurn(binding.threadId, formatDesktopTask(input));
      return finish({ status: "accepted", turnId });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // ponytail: 不自动重发；unknown 由 ChatGPT 换新 commandId 决定是否重试
      return finish({ status: error instanceof DesktopIpcError && !error.sent ? "rejected" : "unknown", error: text });
    }
  } finally {
    client.close();
  }
}

export async function desktopStatus(workspaceId: string, opts: DesktopDeps = {}):
  Promise<{ binding: DesktopBinding | null; available: boolean; busy?: boolean; error?: string }> {
  const { binding } = readDesktop(workspaceId);
  if (!binding) return { binding, available: false };
  try {
    const client = await (opts.connect ?? DesktopClient.connect)();
    try {
      return { binding, available: true, busy: (await client.snapshot(binding.threadId)).busy };
    } finally {
      client.close();
    }
  } catch (error) {
    return { binding, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 绑定当前 Codex 会话（threadId 来自 CODEX_THREAD_ID）。 */
export async function bindCurrentDesktop(workspaceId: string, opts: DesktopDeps & { env?: NodeJS.ProcessEnv } = {}): Promise<DesktopBinding> {
  const threadId = (opts.env ?? process.env).CODEX_THREAD_ID ?? "";
  if (!UUID.test(threadId)) throw new C2CError("DESKTOP_NO_THREAD", "未找到当前 Codex 会话（CODEX_THREAD_ID），请在 Codex Desktop 会话内运行");
  const client = await (opts.connect ?? DesktopClient.connect)();
  let title: string | undefined;
  try {
    await client.discoverOwner(threadId);
    title = await client.snapshot(threadId).then((s) => s.title, () => undefined);
  } finally {
    client.close();
  }
  const binding: DesktopBinding = { threadId, ...(title ? { title } : {}), boundAt: new Date().toISOString() };
  updateDesktop(workspaceId, (state) => { state.binding = binding; });
  return binding;
}

export function unbindDesktop(workspaceId: string): void {
  updateDesktop(workspaceId, (state) => { state.binding = null; });
}
