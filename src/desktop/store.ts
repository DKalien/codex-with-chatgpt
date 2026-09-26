import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

export class DesktopError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const desktopId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const desktopIntent = z.enum(["development_plan", "revision"]);
export const sendInput = z.object({
  workspaceId: desktopId, bindingId: z.string().uuid(), commandId: desktopId,
  intent: desktopIntent, userConfirmed: z.literal(true),
  message: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
    "正文超过 64 KiB UTF-8 上限；拒绝投递，不截断。")
    .refine(value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "正文包含无效 Unicode。"),
}).strict();
export const statusInput = z.object({ workspaceId: desktopId, commandId: desktopId.optional() }).strict();
export const targetInput = z.object({ threadId: z.string().uuid(), hostId: z.literal("local"), projectId: desktopId }).strict();
const bindingSchema = targetInput.extend({ bindingId: z.string().uuid(), title: z.string().min(1).max(300), boundAt: z.string().datetime() }).strict();
const deliverySchema = z.object({
  commandId: desktopId, deliveryId: z.string().uuid().optional(), clientId: z.string().min(1).max(256), bindingId: z.string().uuid(),
  // 兼容旧记录：缺失表示历史未记录意图，不回填、不推断确认或授权。
  intent: desktopIntent.optional(),
  messageSha256: z.string().regex(/^[a-f0-9]{64}$/), messageBytes: z.number().int().positive().max(MAX_MESSAGE_BYTES),
  threadId: z.string().uuid(), turnId: z.string().uuid().optional(),
  deliveryStatus: z.enum(["outcome_unknown", "accepted", "rejected"]),
  errorCode: z.string().regex(/^DESKTOP_[A-Z_]{1,64}$/).optional(), errorMessage: z.string().min(1).max(256).optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if ((value.deliveryStatus === "accepted") !== !!value.turnId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "投递回执与状态不一致" });
  if ((value.deliveryStatus === "rejected") !== !!(value.errorCode && value.errorMessage) ||
    (value.deliveryStatus !== "rejected" && (value.errorCode || value.errorMessage)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "拒绝状态与原因不一致" });
});
const stateSchema = z.object({
  version: z.literal(1), workspaceId: desktopId, workspaceRoot: z.string().min(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  enabled: z.boolean(), binding: bindingSchema.nullable(), deliveries: z.array(deliverySchema).max(10000),
}).strict().superRefine((state, ctx) => {
  if ((state.enabled && !state.binding) || new Set(state.deliveries.map(item => item.commandId)).size !== state.deliveries.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "绑定或投递 ID 历史不一致" });
});
export type DesktopState = z.infer<typeof stateSchema>;
export type DesktopBinding = z.infer<typeof bindingSchema>;
export type DesktopDelivery = z.infer<typeof deliverySchema>;

export function desktopFile(workspaceId: string): string {
  return path.join(getStateDir(), "desktop-control", `${desktopId.parse(workspaceId)}.json`);
}
function corrupt(): DesktopError {
  return new DesktopError("DESKTOP_STATE_CORRUPT", "Desktop 状态损坏或已初始化的历史缺失；保留文件并人工核对，不能重置投递 ID。");
}
export function readDesktop(workspaceId: string): DesktopState | null {
  const file = desktopFile(workspaceId);
  try {
    const state = stateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (state.workspaceId !== workspaceId) throw corrupt();
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(`${file}.initialized`)) return null;
    throw corrupt();
  }
}

// ponytail: 每工作区短文件锁和最多一万条永久 ID；容量达到上限后人工迁移，绝不淘汰防重放历史。
export function updateDesktop<T>(workspaceId: string, change: (state: DesktopState | null) => { state: DesktopState; result: T }): T {
  const file = desktopFile(workspaceId);
  ensureDir(path.dirname(file));
  let lock: number;
  try { lock = fs.openSync(`${file}.lock`, "wx", 0o600); }
  catch { throw new DesktopError("DESKTOP_STORE_BUSY", "Desktop 状态写锁繁忙；遗留锁须人工核对进程和历史后恢复，不要删除投递记录。"); }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); fs.fsyncSync(lock);
    const previous = readDesktop(workspaceId);
    const revision = (previous?.revision ?? 0) + 1;
    const next = change(previous);
    const valid = stateSchema.parse({ ...next.state, revision });
    if (valid.workspaceId !== workspaceId) throw corrupt();
    if (!fs.existsSync(`${file}.initialized`)) {
      const marker = fs.openSync(`${file}.initialized`, "wx", 0o600);
      try { fs.writeFileSync(marker, "1\n"); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
    }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(valid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    return next.result;
  } finally {
    try { fs.rmSync(temporary, { force: true }); }
    finally { fs.closeSync(lock); fs.unlinkSync(`${file}.lock`); }
  }
}

export function publicDelivery(record: DesktopDelivery) {
  const { commandId, bindingId, threadId, turnId, deliveryStatus, createdAt, updatedAt, intent } = record;
  return { commandId, bindingId, threadId, turnId, deliveryStatus, createdAt, updatedAt, intent, error: record.errorCode,
    message: deliveryStatus === "accepted" ? "Desktop 已接受投递；这不是任务完成或测试通过。" :
      deliveryStatus === "rejected" ? record.errorMessage! :
      "投递结果不明，消息可能已执行；不要重发或更换 commandId 绕过，请在 Desktop 人工核对。" };
}
