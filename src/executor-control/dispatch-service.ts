import { assertCommandNotCancelled } from "../routing/store.js";
import { readDesktop } from "../desktop/store.js";
import { createHash, randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  freezeExecutorDeliveryTarget,
  locatorExactEqual,
  type ExecutorDeliveryTargetSnapshot,
} from "../endpoints/schema.js";
import { readActiveExecutorBinding } from "./service.js";
import {
  EXECUTOR_DISPATCH_COMMAND_ID,
  ExecutorDispatchError,
  executorDispatchIntentSchema,
  parseExecutorDispatchEntry,
  type ExecutorDispatchEntry,
  type ExecutorDispatchIntent,
  type ExecutorDispatchState,
} from "./dispatch-schema.js";
import {
  assertDispatchEntriesWithinLimit,
  readExecutorDispatchState,
  updateExecutorDispatchDetailed,
} from "./dispatch-store.js";
import { withEndpointSwitchLock } from "../endpoint-switch/lock.js";
import { HEX64 } from "../core/hex.js";
import { assertCommandWritable, withCommandOperation } from "../command-cleanup/fence.js";

/**
 * R5e Executor Dispatch Service（Bridge-owned durable target pin + replay + 终结）。
 *
 * 不变量：
 * - unstarted 命令 → pin 当前 Active Executor Binding 的冻结 target snapshot；
 * - delivery-started 命令 → target 永久冻结；后续 Active 切换只影响新命令；
 * - replay 使用 entry 自身冻结的 target（允许 A pinned 后切换 B 再 replay X → 仍 A）；
 * - 新 commandId 的 pin 持有 endpoint switch lock（executor 域），与 bind-current 串行；
 *   existing entry 的 replay/recovery 只走 dispatch-store transaction，不读
 *   Active Executor、不取 endpoint switch lock（stale switch lock 不得阻塞 crash recovery）；
 * - R5E_DISPATCH_OWNER：started entry 持有 dispatchOwnerId；同 owner 的 started replay
 *   → EXECUTOR_DISPATCH_IN_FLIGHT（live in-flight，无 mutation/无 backend 调用）；
 *   异 owner（重启/second process）→ 保守收敛 outcome_unknown（无 backend 调用）；
 *   terminal replay 忽略 owner。owner 绝不进入公开 MCP DTO。
 */

/**
 * R5E_DISPATCH_OWNER：进程生命周期内唯一的 dispatch owner identity。
 * 生产 Bridge/MCP 进程启动时随机生成一次；重启后的进程/second process 持有不同
 * owner。owner 只落在 durable ledger 与内部错误路径，绝不进入公开 MCP DTO。
 */
const PROCESS_DISPATCH_OWNER_ID = randomUUID();
const CLEANUP_COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function getProcessDispatchOwnerId(): string {
  return PROCESS_DISPATCH_OWNER_ID;
}

export interface BeginExecutorDispatchInput {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  /** caller 期望的 bindingId（MCP input.bindingId）；pin 时必须等于当前 Active binding。 */
  readonly bindingId: string;
  readonly commandId: string;
  readonly intent: ExecutorDispatchIntent;
  readonly message: string;
  /** requestAuthoritySha256 = sha256Hex(planner fingerprint)。 */
  readonly requestAuthoritySha256: string;
  readonly stateDir?: string;
  /** 测试注入 owner（模拟重启/second process）；缺省 = 本进程 owner。 */
  readonly dispatchOwnerId?: string;
  /** New cleanup-aware sends opt in; absent entries remain legacy. */
  readonly lifecycle?: "ephemeral";
}

export type BeginExecutorDispatchResult =
  | { phase: "pinned"; entry: ExecutorDispatchEntry; target: ExecutorDeliveryTargetSnapshot }
  | { phase: "replay"; entry: ExecutorDispatchEntry; target: ExecutorDeliveryTargetSnapshot };

export interface FinalizeExecutorDispatchInput {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly commandId: string;
  readonly target: ExecutorDeliveryTargetSnapshot;
  readonly expectedDispatchGenerationId?: string;
  readonly result: {
    readonly deliveryStatus: "accepted" | "rejected" | "outcome_unknown";
    readonly deliveryId?: string;
    readonly errorCode?: string;
  };
  readonly stateDir?: string;
}

export interface MarkExecutorDispatchOutcomeUnknownInput {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly commandId: string;
  readonly target: ExecutorDeliveryTargetSnapshot;
  readonly expectedDispatchGenerationId?: string;
  readonly errorCode?: string;
  readonly stateDir?: string;
}

/** planner fingerprint → durable request authority digest。 */
export function hashRequestAuthority(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

function assertBoundedCommandId(commandId: string): void {
  if (!EXECUTOR_DISPATCH_COMMAND_ID.test(commandId)) {
    throw new ExecutorDispatchError("EXECUTOR_DISPATCH_ENTRY_INVALID", "commandId 不是有界安全值。");
  }
}

function assertHex64(value: string, code: string, message: string): void {
  if (!HEX64.test(value)) {
    throw new ExecutorDispatchError(code, message);
  }
}

/** 冻结 target 的完整 identity 精确比较（locator 结构化精确相等）。 */
function deliveryTargetEquals(a: ExecutorDeliveryTargetSnapshot, b: ExecutorDeliveryTargetSnapshot): boolean {
  return (
    a.version === b.version &&
    a.bindingId === b.bindingId &&
    a.pluginId === b.pluginId &&
    a.workspaceId === b.workspaceId &&
    a.workspaceRoot === b.workspaceRoot &&
    a.instanceId === b.instanceId &&
    a.sessionId === b.sessionId &&
    a.epoch === b.epoch &&
    a.frozenAt === b.frozenAt &&
    locatorExactEqual(a.locator, b.locator)
  );
}

function requireEntry(entries: readonly ExecutorDispatchEntry[], commandId: string): ExecutorDispatchEntry {
  const entry = entries.find(item => item.commandId === commandId);
  if (!entry) {
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_ENTRY_NOT_FOUND",
      `executor dispatch ledger 不存在 commandId=${commandId}。`,
    );
  }
  return entry;
}

function replaceEntry(
  entries: readonly ExecutorDispatchEntry[],
  commandId: string,
  entry: ExecutorDispatchEntry,
): ExecutorDispatchEntry[] {
  return entries.map(item => (item.commandId === commandId ? entry : item));
}

/**
 * begin：pin 或 replay（R5E_DISPATCH_OWNER + replay 免 endpoint switch lock）。
 *
 * 流程：
 * 1. strict read dispatch ledger（不取 switch lock；损坏 ledger 在此 fail closed）；
 * 2. commandId 已存在 → 仅 dispatch-store transaction 完成 replay/recovery：
 *    不读 Active Executor、不取 endpoint switch lock（stale switch lock 不阻塞
 *    crash recovery）；identity 漂移 → fail closed；bindingId 必须等于冻结 target
 *    的 bindingId（EXECUTOR_COMMAND_PINNED）；
 *    - started + 同 owner → EXECUTOR_DISPATCH_IN_FLIGHT（live in-flight；
 *      无 mutation、无 backend 调用）；
 *    - started + 异 owner（重启/second process/legacy 无 owner）→ 保守收敛
 *      outcome_unknown(interrupted_after_target_pin)，无 backend 调用
 *      （safety > availability：绝不因 split-brain 产生第二次 send）；
 *    - terminal → 幂等 noWrite replay（忽略 owner）；
 * 3. commandId 不存在 → 取 endpoint switch lock，锁内重读 store 并 recheck
 *    absence（期间被其他 caller 创建则走 existing-entry 语义），然后读取当前
 *    Active Executor Binding 并 pin（caller bindingId 必须当前，否则
 *    EXECUTOR_BINDING_STALE；写入 started entry + 冻结 target + 本进程 ownerId）。
 */
function beginExecutorDispatchLocked(input: BeginExecutorDispatchInput): BeginExecutorDispatchResult {
  assertBoundedCommandId(input.commandId);
  assertCommandNotCancelled({ id: input.workspaceId, root: input.workspaceRoot }, input.commandId, input.stateDir);
  executorDispatchIntentSchema.parse(input.intent);
  if (typeof input.message !== "string" || input.message.length === 0) {
    throw new ExecutorDispatchError("EXECUTOR_DISPATCH_ENTRY_INVALID", "message 不能为空。");
  }
  assertHex64(
    input.requestAuthoritySha256,
    "EXECUTOR_DISPATCH_ENTRY_INVALID",
    "requestAuthoritySha256 必须是 hex64。",
  );
  const payloadBytes = Buffer.byteLength(input.message, "utf8");
  const payloadSha256 = createHash("sha256").update(input.message, "utf8").digest("hex");
  const ownerId = input.dispatchOwnerId ?? PROCESS_DISPATCH_OWNER_ID;

  /** existing entry 的 owner-aware replay/recovery（在 dispatch-store transaction 内运行）。 */
  const replayExisting = (
    previous: ExecutorDispatchState,
    existing: ExecutorDispatchEntry,
  ): { state: ExecutorDispatchState; result: BeginExecutorDispatchResult; noWrite?: boolean } => {
    // replay：identity 漂移 → fail closed。
    if (
      existing.intent !== input.intent ||
      existing.payloadBytes !== payloadBytes ||
      existing.payloadSha256 !== payloadSha256 ||
      existing.requestAuthoritySha256 !== input.requestAuthoritySha256
    ) {
      throw new ExecutorDispatchError(
        "EXECUTOR_DISPATCH_IDENTITY_MISMATCH",
        "同 commandId 的 payload/identity 漂移；拒绝复用 dispatch entry。",
      );
    }
    if (input.bindingId !== existing.target.bindingId) {
      throw new ExecutorDispatchError(
        "EXECUTOR_COMMAND_PINNED",
        "该 commandId 已固定到其他 executor target；不随 Active binding 切换。",
      );
    }
    if (existing.deliveryStatus === "started") {
      if (existing.ownerId === ownerId) {
        // live in-flight：本 dispatcher 的 backend.send 仍在进行；绝不重复投递，
        // 绝不把它误判为 crash recovery（那会 poison 一次正常 accepted send）。
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_IN_FLIGHT",
          "该 commandId 的 dispatch 仍由本 dispatcher live 进行中（未到达 terminal）；拒绝重复投递。",
        );
      }
      // 异 owner：前一 dispatcher 不再权威（重启/split-brain/legacy 无 owner）。
      // 保守收敛 outcome_unknown，无 backend 调用。
      const now = new Date().toISOString();
      const recovered = parseExecutorDispatchEntry({
        ...existing,
        deliveryStatus: "outcome_unknown",
        outcomeReasonCode: "interrupted_after_target_pin",
        updatedAt: now,
        terminalAt: now,
      });
      const state = {
        ...previous,
        revision: previous.revision + 1,
        entries: replaceEntry(previous.entries, input.commandId, recovered),
      };
      return {
        state,
        result: { phase: "replay" as const, entry: recovered, target: recovered.target },
      };
    }
    // terminal replay：忽略 owner；immutable identity + 原 binding 权威；noWrite。
    return {
      state: previous,
      noWrite: true,
      result: { phase: "replay" as const, entry: existing, target: existing.target },
    };
  };

  // 1. strict read dispatch ledger（无锁；损坏状态 fail closed）。
  const strictExisting = readExecutorDispatchState(input.workspaceId, input.stateDir)
    ?.entries.find(item => item.commandId === input.commandId) ?? null;
  if (strictExisting) {
    // 2. existing → 仅 dispatch-store transaction；无 switch lock、无 Active Executor 读。
    return updateExecutorDispatchDetailed<BeginExecutorDispatchResult>(
      input.workspaceId,
      input.workspaceRoot,
      (previous) => {
        const existing = previous?.entries.find(item => item.commandId === input.commandId) ?? null;
        if (!previous || !existing) {
          // strict read 看到过该 entry；此刻消失说明 durable 状态被外部破坏。
          throw new ExecutorDispatchError(
            "EXECUTOR_DISPATCH_ENTRY_NOT_FOUND",
            `executor dispatch ledger 不存在 commandId=${input.commandId}（strict read 后消失）。`,
          );
        }
        return replayExisting(previous, existing);
      },
      input.stateDir,
    ).result;
  }
  // 3. absent → 取 endpoint switch lock，锁内 recheck 后 pin。
  return withEndpointSwitchLock("executor", input.workspaceId, () => {
    return updateExecutorDispatchDetailed<BeginExecutorDispatchResult>(
      input.workspaceId,
      input.workspaceRoot,
      (previous) => {
        const existing = previous?.entries.find(item => item.commandId === input.commandId) ?? null;
        // recheck：strict read 与 lock 之间被其他 caller 创建 → existing-entry 语义。
        if (existing) return replayExisting(previous!, existing);
        // pin：只有新 commandId 才读取当前 Active Executor Binding；
        // fail closed，无写入。
        const current = readActiveExecutorBinding(input.workspaceId, input.workspaceRoot);
        if (!current) {
          throw new ExecutorDispatchError(
            "EXECUTOR_CONTROL_NO_ACTIVE_BINDING",
            "尚未本地 bind-current；拒绝 pin executor dispatch target。",
          );
        }
        if (input.bindingId !== current.bindingId) {
          throw new ExecutorDispatchError(
            "EXECUTOR_BINDING_STALE",
            "bindingId 不是当前 active binding；不会自动切换目标。",
          );
        }
        const target = freezeExecutorDeliveryTarget(current);
        const now = new Date().toISOString();
        const entry = parseExecutorDispatchEntry({
          version: 1,
          commandId: input.commandId,
          ...(input.lifecycle === "ephemeral" ? { lifecycle: "ephemeral", dispatchGenerationId: randomUUID() } : {}),
          intent: input.intent,
          payloadBytes,
          payloadSha256,
          requestAuthoritySha256: input.requestAuthoritySha256,
          target,
          ownerId,
          deliveryStatus: "started",
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        });
        const baseEntries = previous?.entries ?? [];
        const entries = [...baseEntries, entry];
        assertDispatchEntriesWithinLimit(entries);
        const state = {
          version: 1 as const,
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          revision: (previous?.revision ?? 0) + 1,
          entries,
        };
        return { state, result: { phase: "pinned" as const, entry, target } };
      },
      input.stateDir,
    ).result;
  }, input.stateDir);
}

export function beginExecutorDispatch(input: BeginExecutorDispatchInput): BeginExecutorDispatchResult {
  if (!CLEANUP_COMMAND_ID.test(input.commandId)) {
    if (input.lifecycle === "ephemeral") {
      throw new ExecutorDispatchError("EXECUTOR_DISPATCH_ENTRY_INVALID", "ephemeral commandId 不符合 cleanup identity。");
    }
    return beginExecutorDispatchLocked(input);
  }
  return withCommandOperation(input.workspaceId, input.commandId, () => {
    assertCommandWritable(input.workspaceId, input.commandId, input.stateDir);
    return beginExecutorDispatchLocked(input);
  }, input.stateDir);
}

function assertDispatchGeneration(
  entry: ExecutorDispatchEntry,
  expectedDispatchGenerationId: string | undefined,
): void {
  if (entry.lifecycle === "ephemeral") {
    if (!expectedDispatchGenerationId || expectedDispatchGenerationId !== entry.dispatchGenerationId) {
      throw new ExecutorDispatchError("EXECUTOR_DISPATCH_GENERATION_MISMATCH", "dispatch generation 已变化；拒绝迟到的终结写入。");
    }
  } else if (expectedDispatchGenerationId !== undefined) {
    throw new ExecutorDispatchError("EXECUTOR_DISPATCH_GENERATION_MISMATCH", "dispatch generation 与 legacy entry 不匹配。");
  }
}

/**
 * finalize：started → terminal（accepted/rejected/outcome_unknown）。
 * - entry 必须仍是 started（否则 fail closed EXECUTOR_DISPATCH_INVALID_TRANSITION）；
 * - entry.target 必须与传入 target 精确一致（否则 fail closed）。
 */
export function finalizeExecutorDispatch(input: FinalizeExecutorDispatchInput): { entry: ExecutorDispatchEntry } {
  assertBoundedCommandId(input.commandId);
  const update = () => updateExecutorDispatchDetailed<{ entry: ExecutorDispatchEntry }>(
    input.workspaceId,
    input.workspaceRoot,
    (previous) => {
      const entry = requireEntry(previous?.entries ?? [], input.commandId);
      assertDispatchGeneration(entry, input.expectedDispatchGenerationId);
      if (entry.deliveryStatus !== "started") {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_INVALID_TRANSITION",
          `finalize 只接受 started；当前为 ${entry.deliveryStatus}。`,
        );
      }
      if (!deliveryTargetEquals(entry.target, input.target)) {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_TARGET_MISMATCH",
          "finalize target 与冻结 entry.target 不一致；拒绝写入 terminal。",
        );
      }
      const now = new Date().toISOString();
      const terminal = parseExecutorDispatchEntry({
        ...entry,
        deliveryStatus: input.result.deliveryStatus,
        ...(input.result.deliveryId !== undefined ? { deliveryId: input.result.deliveryId } : {}),
        ...(input.result.errorCode !== undefined ? { errorCode: input.result.errorCode } : {}),
        // outcome_unknown 经 finalize 收敛时同样必须携带 bounded outcomeReasonCode。
        ...(input.result.deliveryStatus === "outcome_unknown" ? { outcomeReasonCode: "send_failed" } : {}),
        updatedAt: now,
        terminalAt: now,
      });
      return {
        state: {
          ...previous!,
          revision: previous!.revision + 1,
          entries: replaceEntry(previous!.entries, input.commandId, terminal),
        },
        result: { entry: terminal },
      };
    },
    input.stateDir,
  ).result;
  return CLEANUP_COMMAND_ID.test(input.commandId)
    ? withCommandOperation(input.workspaceId, input.commandId, update, input.stateDir)
    : update();
}

/** Queue-only rollback after Codex's controlled preflight reports DESKTOP_BUSY.
 * Never called after an attempted send. The immutable mailbox still pins the binding.
 * Command authority excludes a concurrent sender/cleanup, generation + owner exclude
 * delayed callbacks, and any durable Desktop delivery forbids rollback.
 */
export function releaseUnsentExecutorPin(input: Omit<FinalizeExecutorDispatchInput, "result">): void {
  withCommandOperation(input.workspaceId, input.commandId, () => {
    const desktop = readDesktop(input.workspaceId, input.stateDir);
    if (desktop?.workspaceRoot !== input.workspaceRoot || desktop.deliveries.some(item => item.commandId === input.commandId))
      throw new ExecutorDispatchError("EXECUTOR_DISPATCH_INVALID_TRANSITION", "已有投递证据或工作区不符，不能撤销 pin。");
    updateExecutorDispatchDetailed(input.workspaceId, input.workspaceRoot, previous => {
      const entry = requireEntry(previous?.entries ?? [], input.commandId);
      assertDispatchGeneration(entry, input.expectedDispatchGenerationId);
      if (entry.deliveryStatus !== "started" || entry.ownerId !== PROCESS_DISPATCH_OWNER_ID ||
          !deliveryTargetEquals(entry.target, input.target))
        throw new ExecutorDispatchError("EXECUTOR_DISPATCH_INVALID_TRANSITION", "仅本次未发送的精确 pin 可撤销。");
      return { state: { ...previous!, revision: previous!.revision + 1,
        entries: previous!.entries.filter(item => item !== entry) }, result: undefined };
    }, input.stateDir);
  }, input.stateDir);
}

/**
 * backend throw / finalize 校验失败时的 outcome_unknown 收敛：started → outcome_unknown。
 * 已是 outcome_unknown → 幂等 noWrite；target 不一致 → fail closed。
 */
export function markExecutorDispatchOutcomeUnknown(
  input: MarkExecutorDispatchOutcomeUnknownInput,
): { entry: ExecutorDispatchEntry; noWrite: boolean } {
  assertBoundedCommandId(input.commandId);
  const update = () => updateExecutorDispatchDetailed<{ entry: ExecutorDispatchEntry; noWrite: boolean }>(
    input.workspaceId,
    input.workspaceRoot,
    (previous) => {
      const entry = requireEntry(previous?.entries ?? [], input.commandId);
      assertDispatchGeneration(entry, input.expectedDispatchGenerationId);
      if (!deliveryTargetEquals(entry.target, input.target)) {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_TARGET_MISMATCH",
          "mark target 与冻结 entry.target 不一致；拒绝写 outcome_unknown。",
        );
      }
      if (entry.deliveryStatus === "outcome_unknown") {
        return { state: previous!, noWrite: true, result: { entry, noWrite: true } };
      }
      if (entry.deliveryStatus !== "started") {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_INVALID_TRANSITION",
          `outcome_unknown 收敛只接受 started；当前为 ${entry.deliveryStatus}。`,
        );
      }
      const now = new Date().toISOString();
      const outcome = parseExecutorDispatchEntry({
        ...entry,
        deliveryStatus: "outcome_unknown",
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        outcomeReasonCode: "send_failed",
        updatedAt: now,
        terminalAt: now,
      });
      return {
        state: {
          ...previous!,
          revision: previous!.revision + 1,
          entries: replaceEntry(previous!.entries, input.commandId, outcome),
        },
        result: { entry: outcome, noWrite: false },
      };
    },
    input.stateDir,
  ).result;
  return CLEANUP_COMMAND_ID.test(input.commandId)
    ? withCommandOperation(input.workspaceId, input.commandId, update, input.stateDir)
    : update();
}

/** 只读查询单个 dispatch entry；不存在返回 null。 */
export function readExecutorDispatchEntry(
  workspaceId: string,
  commandId: string,
  stateDir: string = getStateDir(),
): ExecutorDispatchEntry | null {
  assertBoundedCommandId(commandId);
  return readExecutorDispatchState(workspaceId, stateDir)?.entries
    .find(item => item.commandId === commandId) ?? null;
}
