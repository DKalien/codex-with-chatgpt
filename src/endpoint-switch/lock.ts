import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";

/**
 * R5e Endpoint Switch serialization lock（跨进程 fail closed）。
 *
 * 两个独立域：
 * - "executor"：序列化 Active Executor Binding 切换与 dispatch target pin；
 * - "web-sink"：序列化 Active Web Sink Binding 切换与 Result Bus reserve/begin-send。
 *
 * 设计约束：
 * - 锁文件 `<state>/endpoint-switch/<workspaceId>.<domain>.lock`，`wx` 原子创建；
 *   已存在 → ENDPOINT_SWITCH_LOCK_BUSY（fail closed，绝不等待或抢占）。
 * - 锁内容是有界 JSON（pid/domain/nonce/createdAt），无 credential、无消息、无
 *   planner 身份；nonce 是每次 acquire 随机生成的 ownership token。
 * - release（C：ownership 必须真实）：先读回当前锁路径，仅当其仍携带本 handle
 *   的 nonce 才删除；锁文件丢失、不可读、已被替代（nonce 不符）或 nonce 匹配但
 *   最终 unlink 失败时，绝不删除替代锁，并以 bounded ownership-lost 结果上报
 *   （release 绝不抛错，避免掩盖主结果/主错误；ownership loss 由
 *   withEndpointSwitchLock 传播，见下）。
 * - 本模块只依赖 node 标准库与 config/paths，绝不 import executor-control /
 *   web-sink-control / feedback / browser-companion / mcp（避免循环依赖）。
 * - 锁顺序约定：endpoint-switch lock → 各 store 自身 lock；禁止反序获取。
 */

export type EndpointSwitchDomain = "executor" | "web-sink";

export class EndpointSwitchLockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EndpointSwitchLockError";
  }
}

/**
 * release 结果：ownershipLost=true 表示归属无法证明（missing/unreadable/
 * nonce-mismatch）或清理未完成（unlink-failed，nonce 匹配但删除失败）；
 * 除幂等二次释放外，未删除任何文件。
 */
export type EndpointSwitchReleaseOutcome = {
  ownershipLost: boolean;
  /** ownershipLost 的有界原因。 */
  reason?: "missing" | "unreadable" | "nonce-mismatch" | "unlink-failed";
};

const WORKSPACE_ID = /^[a-f0-9]{12}$/;

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new EndpointSwitchLockError(
      "ENDPOINT_SWITCH_LOCK_INVALID",
      "workspaceId 非法，拒绝获取 endpoint switch lock。",
    );
  }
}

function assertDomain(domain: EndpointSwitchDomain): void {
  if (domain !== "executor" && domain !== "web-sink") {
    throw new EndpointSwitchLockError("ENDPOINT_SWITCH_LOCK_INVALID", "endpoint switch domain 非法。");
  }
}

export function endpointSwitchLockFile(
  domain: EndpointSwitchDomain,
  workspaceId: string,
  stateDir: string = getStateDir(),
): string {
  assertDomain(domain);
  assertWorkspaceId(workspaceId);
  return path.join(stateDir, "endpoint-switch", `${workspaceId}.${domain}.lock`);
}

export interface EndpointSwitchLockHandle {
  /** 释放锁；返回 bounded ownership 结果（绝不抛错，避免掩盖主结果/主错误）。 */
  release(): EndpointSwitchReleaseOutcome;
}

/**
 * 获取跨进程 endpoint switch lock。
 * 持有者必须在自己的 finally 中 release；release 只删除仍证明本 handle
 * nonce 归属的锁文件，绝不删除替代锁。
 */
export function acquireEndpointSwitchLock(
  domain: EndpointSwitchDomain,
  workspaceId: string,
  stateDir: string = getStateDir(),
): EndpointSwitchLockHandle {
  const file = endpointSwitchLockFile(domain, workspaceId, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    throw new EndpointSwitchLockError(
      "ENDPOINT_SWITCH_LOCK_BUSY",
      `endpoint switch lock（${domain}）被占用；拒绝并发切换/固定。`,
    );
  }
  // 随机 nonce：ownership token；release 时凭它证明锁仍归本 handle 所有。
  const nonce = randomUUID();
  try {
    // 有界 JSON 元数据：仅进程身份与时间，无业务数据。
    const payload = `${JSON.stringify({
      pid: process.pid,
      domain,
      nonce,
      createdAt: new Date().toISOString(),
    })}\n`;
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 保留主错误
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // 保留主错误
    }
    throw error;
  }
  let released = false;
  return {
    release(): EndpointSwitchReleaseOutcome {
      if (released) return { ownershipLost: false };
      released = true;
      try {
        fs.closeSync(fd);
      } catch {
        // fd 清理失败不阻断 ownership 校验
      }
      // ownership 校验：只有当前路径仍携带本 handle 的 nonce 才删除。
      let current: string | null = null;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        // missing → 无法证明归属
      }
      if (current === null) {
        return { ownershipLost: true, reason: "missing" };
      }
      let parsed: { nonce?: unknown };
      try {
        parsed = JSON.parse(current) as { nonce?: unknown };
      } catch {
        return { ownershipLost: true, reason: "unreadable" };
      }
      if (parsed.nonce !== nonce) {
        // 已被替代（或非本 handle 内容）→ 绝不删除替代锁。
        return { ownershipLost: true, reason: "nonce-mismatch" };
      }
      try {
        fs.unlinkSync(file);
      } catch {
        // nonce 匹配但最终删除失败：清理责任未完成，不得声称归属未丢失
        // （否则锁文件残留且后续归属无从证明）。
        return { ownershipLost: true, reason: "unlink-failed" };
      }
      return { ownershipLost: false };
    },
  };
}

/** 把有界 ownership-loss 证据附加到原始错误对象上（不替换主错误）。 */
function attachOwnershipLossEvidence(
  error: unknown,
  outcome: EndpointSwitchReleaseOutcome,
): void {
  if (error instanceof Error) {
    const target = error as Error & {
      endpointSwitchOwnershipLost?: boolean;
      endpointSwitchOwnershipLostReason?: string;
    };
    target.endpointSwitchOwnershipLost = true;
    target.endpointSwitchOwnershipLostReason = outcome.reason ?? "unknown";
  }
}

/**
 * 在 endpoint switch lock 内执行同步临界区；任何退出路径都释放锁，且
 * ownership loss 必须传播、绝不静默：
 * - fn() 成功但 release 无法证明归属 → 抛 ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST
 *   （有界 message）：成功的 authority mutation 不得在失去线性化归属后伪装为
 *   成功返回；
 * - fn() 抛错 → 原始错误仍是主错误原样抛出（绝不替换）；release 无法证明归属
 *   时把有界证据（endpointSwitchOwnershipLost / ...Reason）附加到原错误上。
 * 仅支持同步 fn：投递（backend.send）等异步阶段必须在锁外进行。
 */
export function withEndpointSwitchLock<T>(
  domain: EndpointSwitchDomain,
  workspaceId: string,
  fn: () => T,
  stateDir: string = getStateDir(),
): T {
  const lock = acquireEndpointSwitchLock(domain, workspaceId, stateDir);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const releaseOutcome = lock.release();
  if (!outcome.ok) {
    if (releaseOutcome.ownershipLost) {
      attachOwnershipLossEvidence(outcome.error, releaseOutcome);
    }
    throw outcome.error;
  }
  if (releaseOutcome.ownershipLost) {
    throw new EndpointSwitchLockError(
      "ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST",
      `endpoint switch lock（${domain}）release 无法证明归属（reason=${releaseOutcome.reason ?? "unknown"}）；本次临界区结果不得在失去线性化归属后静默返回成功。`,
    );
  }
  return outcome.value;
}
