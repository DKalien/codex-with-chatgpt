import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { C2CError } from "../errors.js";
import { readJson, updateJson, writeJson } from "../util/json-file.js";
import { workspaceDir } from "../state.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";

export type ResultStatus = "ok" | "failed" | "blocked";
export interface ResultInput { workspaceId: string; commandId: string; status: ResultStatus; summary: string; tests?: string; changedFiles?: string[]; notes?: string; output?: string }
export interface ResultRecord extends ResultInput { recordedAt: string; outputTruncated?: boolean }
export type NotificationState = "pending" | "claimed" | "delivered";
export interface Notification { id: string; workspaceId: string; commandId: string; status: ResultStatus; text: string; state: NotificationState; createdAt: string; claimedAt?: string; deliveredAt?: string }

const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_NOTIFICATIONS = 200;

function capBytes(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  // 截断可能切在多字节字符中间，去掉末尾的替换字符
  return { text: buf.subarray(0, max).toString("utf8").replace(/�+$/, ""), truncated: true };
}

function resultFile(workspaceId: string, commandId: string): string {
  if (!COMMAND_ID.test(commandId)) throw new C2CError("INVALID_COMMAND_ID", "commandId 只能包含字母、数字、下划线和连字符（最长 128）");
  return path.join(workspaceDir(workspaceId), "results", `${commandId}.json`);
}

const notificationsFile = (workspaceId: string) => path.join(workspaceDir(workspaceId), "notifications.json");

export function renderNotification(n: Pick<Notification, "id" | "workspaceId" | "commandId" | "status">): string {
  return [
    "[C2C] Codex 已执行完毕（自动通知，不是新指令）。请调用 codex_task_result 读取结果并 Review。",
    `WORKSPACE_ID: ${n.workspaceId} | COMMAND_ID: ${n.commandId} | STATUS: ${n.status}`,
    `ATTEMPT_ID: ${n.id}`,
  ].join("\n");
}

export function recordResult(input: ResultInput): { result: ResultRecord; notification: Notification } {
  const file = resultFile(input.workspaceId, input.commandId);
  const result: ResultRecord = {
    workspaceId: input.workspaceId,
    commandId: input.commandId,
    status: input.status,
    summary: capBytes(input.summary, MAX_SUMMARY_BYTES).text,
    recordedAt: new Date().toISOString(),
  };
  if (input.tests !== undefined) result.tests = capBytes(input.tests, MAX_SUMMARY_BYTES).text;
  if (input.changedFiles) result.changedFiles = input.changedFiles;
  if (input.notes !== undefined) result.notes = capBytes(input.notes, MAX_SUMMARY_BYTES).text;
  if (input.output !== undefined) {
    const capped = capBytes(input.output, MAX_OUTPUT_BYTES);
    const clean = sanitizeExecutionOutput(capped.text);
    if (clean.allowed) {
      result.output = clean.text;
      if (capped.truncated || clean.truncated) result.outputTruncated = true;
    } else {
      result.output = "[输出已被拒绝：包含私钥等敏感内容]";
    }
  }
  writeJson(file, result);

  const notification = updateJson<Notification[], Notification>(notificationsFile(input.workspaceId), [], (list) => {
    const pending = list.find((n) => n.commandId === input.commandId && n.state === "pending");
    if (pending) {
      pending.status = result.status;
      pending.text = renderNotification(pending);
      return pending;
    }
    const n: Notification = { id: randomUUID(), workspaceId: input.workspaceId, commandId: input.commandId, status: result.status, text: "", state: "pending", createdAt: result.recordedAt };
    n.text = renderNotification(n);
    list.push(n);
    if (list.length > MAX_NOTIFICATIONS) list.splice(0, list.length - MAX_NOTIFICATIONS);
    return n;
  });
  return { result, notification };
}

export function readResult(workspaceId: string, commandId: string): ResultRecord | null {
  return readJson<ResultRecord | null>(resultFile(workspaceId, commandId), null);
}

export function listResults(workspaceId: string, limit = 20): ResultRecord[] {
  const dir = path.join(workspaceDir(workspaceId), "results");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .map((f) => readJson<ResultRecord | null>(path.join(dir, f), null))
    .filter((r): r is ResultRecord => r !== null)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, limit);
}

export function listNotifications(workspaceId: string): Notification[] {
  return readJson<Notification[]>(notificationsFile(workspaceId), []);
}

function transition(workspaceId: string, id: string, fn: (n: Notification) => void): Notification {
  return updateJson<Notification[], Notification>(notificationsFile(workspaceId), [], (list) => {
    const n = list.find((item) => item.id === id);
    if (!n) throw new C2CError("NOTIFICATION_NOT_FOUND", `通知不存在：${id}`);
    fn(n);
    return n;
  });
}

export function claimNotification(workspaceId: string, id: string): Notification {
  return transition(workspaceId, id, (n) => {
    if (n.state !== "pending") throw new C2CError("NOTIFICATION_NOT_PENDING", `通知不是待发送状态（当前 ${n.state}）`);
    n.state = "claimed";
    n.claimedAt = new Date().toISOString();
  });
}

export function ackNotification(workspaceId: string, id: string): Notification {
  return transition(workspaceId, id, (n) => {
    if (n.state === "delivered") return;
    if (n.state !== "claimed") throw new C2CError("NOTIFICATION_NOT_CLAIMED", `通知尚未被领取（当前 ${n.state}）`);
    n.state = "delivered";
    n.deliveredAt = new Date().toISOString();
  });
}

export function requeueNotification(workspaceId: string, id: string): Notification {
  return transition(workspaceId, id, (n) => {
    if (n.state !== "claimed") throw new C2CError("NOTIFICATION_NOT_CLAIMED", `只有已领取的通知可以重发（当前 ${n.state}）`);
    n.state = "pending";
    delete n.claimedAt;
  });
}
