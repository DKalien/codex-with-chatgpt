import { isResultBusInFlight } from "../result-bus/schema.js";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { readResultBus } from "../result-bus/store.js";
import { recoverStaleFeedback } from "../feedback/state-store.js";
import { INFLIGHT_FENCE_STATUSES } from "../feedback/delivery-lifecycle.js";
import { FeedbackError } from "../feedback/schema.js";
import { ResultBusDeliveryError } from "./result-bus-delivery.js";

/**
 * R5d3 review-fix：Bridge-owned 全局投递 arbiter。
 *
 * 不变量：跨 Result Bus（reserved/claimed/outcome_unknown）与 Feedback
 * （reserved/claimed/outcome_unknown）至多一个 production in-flight；
 * 第二次获取必须在写 durable state 之前被拒绝。
 *
 * 实现：per-workspace 文件锁串行化「in-flight 检查 + store mutation」整个
 * 获取窗口。所有 production 获取路径都必须参与：
 * - Browser Result Bus reserve（adapter）
 * - Browser legacy/control reserve（adapter legacy fallback）
 * - MCP feedback_claim_next（neutral read fence；不是 Result Bus mutation 工具）
 * - legacy canonical ACK/retire 终态化（与 disposition 写入、新 reserve 串行，
 *   关闭 terminalization TOCTOU 窗口）
 *
 * Result Bus core 不 import 本模块；依赖方向 bridge → result-bus/feedback 单向。
 */


const FEEDBACK_INFLIGHT = INFLIGHT_FENCE_STATUSES;

export function deliveryArbiterLockFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "delivery-arbiter", `${workspaceId}.lock`);
}

/**
 * 在 per-workspace arbiter 锁内执行获取/终态化窗口。
 * 锁内允许跨 store 检查 + mutation；并发第二个获取者得到 RESULT_BUS_ARBITER_BUSY。
 */
export function withDeliveryArbiter<T>(
  input: { workspaceId: string; workspaceRoot?: string; stateDir?: string },
  fn: (identity: RoutingWorkspaceIdentity) => T,
): T {
  const stateDir = input.stateDir ?? getStateDir();
  const identity = resolveWorkspaceIdentity({ id: input.workspaceId, root: input.workspaceRoot! });
  const lockFile = deliveryArbiterLockFile(identity.id, stateDir);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let lock: number;
  try {
    lock = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ResultBusDeliveryError(
        "RESULT_BUS_ARBITER_BUSY",
        "另一 production 获取/终态化正在仲裁；稍后重试。",
      );
    }
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    return fn(identity);
  } finally {
    try { fs.closeSync(lock); } finally { fs.rmSync(lockFile, { force: true }); }
  }
}

/**
 * Neutral read fence（供 MCP feedback_claim_next 等非 adapter 获取路径使用）：
 * Result Bus 存在 durable in-flight 时拒绝新的 production 获取。
 * Feedback 自身 single-flight 由其 lifecycle 负责。
 */
export function assertNoResultBusInFlight(input: {
  workspaceId: string;
  workspaceRoot?: string;
  stateDir?: string;
}): void {
  const stateDir = input.stateDir ?? getStateDir();
  const identity = resolveWorkspaceIdentity({ id: input.workspaceId, root: input.workspaceRoot! });
  const busInFlight = (readResultBus(identity, stateDir)?.entries ?? [])
    .filter(isResultBusInFlight);
  if (busInFlight.length > 0) {
    throw new FeedbackError(
      "FEEDBACK_INFLIGHT_FENCE",
      "Result Bus 存在 reserved/claimed/outcome_unknown；禁止并发 production 获取",
    );
  }
}

/** arbiter 内的全局 in-flight 检查：跨 Bus/Feedback 双源，任一即拒绝第二获取。 */
export function assertNoProductionInFlight(input: {
  identity: RoutingWorkspaceIdentity;
  stateDir?: string;
}): void {
  const stateDir = input.stateDir ?? getStateDir();
  const busInFlight = (readResultBus(input.identity, stateDir)?.entries ?? [])
    .filter(isResultBusInFlight);
  const feedbackInFlight = recoverStaleFeedback(input.identity.id, stateDir)
    .events.filter(event => FEEDBACK_INFLIGHT.has(event.status));
  if (busInFlight.length > 0 && feedbackInFlight.length > 0) {
    throw new ResultBusDeliveryError(
      "RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT",
      "legacy Feedback 与 Result Bus 同时存在 durable in-flight；migration 状态冲突，fail closed。",
    );
  }
  if (busInFlight.length > 0 || feedbackInFlight.length > 0) {
    // 已有唯一 in-flight：新的获取必须被拒（由调用方决定以各自 wire 语义抛错）。
    throw busInFlight.length > 0
      ? new ResultBusDeliveryError("RESULT_BUS_INFLIGHT_FENCE", "Result Bus 已有 in-flight attempt；禁止并发获取。")
      : new FeedbackError("FEEDBACK_INFLIGHT_FENCE", "存在 legacy reserved/claimed/outcome_unknown 事件；禁止并发预占");
  }
}
