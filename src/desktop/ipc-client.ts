import { spawn } from "node:child_process";
import type {
  DesktopDiagnosis,
  DesktopExecutionInfo,
  DesktopIpcConnection,
  DesktopIpcOptions,
  DesktopResultActivityMarker,
  DesktopResultActivityMarkerObservation,
  DesktopResultClassification,
  DesktopResultContext,
  DesktopResultOwnership,
  DesktopResultOwnershipExpectation,
  DesktopResultTerminalFence,
  DesktopRuntimeFence,
  DesktopTarget,
  DesktopTargetInfo,
  DesktopTargetInfoInternal,
  DesktopUnknownReconcileExpectation,
  DesktopUnknownReconcileObservation,
} from "./ipc-contracts.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  error,
  isUuid,
  timeout,
} from "./ipc-errors.js";
import {
  assertResultOwnershipExpectation,
  validateDesktopDiagnosis,
  validateDesktopResultActivityMarker,
  validateDesktopResultActivityMarkerObservation,
  validateDesktopResultTerminalFence,
  validateExecutionInfo,
  validateInternalInfo,
  validateInfo,
  validateMessage,
  validateReceipt,
  validateResultClassification,
  validateResultContext,
  validateResultOwnership,
  validateResultOwnershipExpectation,
  validateTarget,
  validateTargetScopedResultContext,
  validateUnknownReconcileExpectation,
  validateUnknownReconcileObservation,
} from "./ipc-validation.js";
import { openHelperSession, resolveDesktopHelperPath } from "./ipc-transport.js";

export class DesktopIpcClient {
  private readonly spawnImpl: NonNullable<DesktopIpcOptions["spawnImpl"]>;
  private readonly pythonExecutable: string;
  private readonly helperPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly requestTimeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(options: DesktopIpcOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.pythonExecutable = options.pythonExecutable ?? process.env.C2C_DESKTOP_PYTHON?.trim() ?? "python";
    this.helperPath = options.helperPath ?? resolveDesktopHelperPath();
    this.platform = options.platform ?? process.platform;
    this.requestTimeoutMs = timeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.sendTimeoutMs = timeout(options.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS);
  }

  async discoverForBinding(rawTarget: DesktopTarget): Promise<DesktopTargetInfoInternal> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect_for_binding", { target });
      return validateInternalInfo(value, target);
    } finally {
      session.close();
    }
  }

  async inspect(rawTarget: DesktopTarget, runtimeFence?: DesktopRuntimeFence): Promise<DesktopTargetInfo> {
    const target = validateTarget(rawTarget);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect", withRuntimeFence({ target }, runtimeFence));
      return validateInfo(value, target);
    } finally {
      session.close();
    }
  }

  /** 只读 live handshake 诊断；不做信任分类，也不输出版本或 bundle 信息。 */
  async diagnose(workspaceRoot: string): Promise<DesktopDiagnosis> {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_INVALID_REQUEST");
    const session = this.open();
    try {
      const value = await session.request("diagnose", { workspaceRoot });
      return validateDesktopDiagnosis(value);
    } finally { session.close(); }
  }

  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfoInternal> {
    return this.currentOperation("current_identity", workspaceRoot, validateInternalInfo) as Promise<DesktopTargetInfoInternal>;
  }

  async currentExecution(workspaceRoot: string): Promise<DesktopExecutionInfo> {
    return this.currentOperation("current_execution", workspaceRoot, validateExecutionInfo) as Promise<DesktopExecutionInfo>;
  }

  /** Target-scoped active-turn observation for the Bridge server; no runner context required. */
  async inspectActiveExecution(rawTarget: DesktopTarget, runtimeFence?: DesktopRuntimeFence): Promise<DesktopExecutionInfo> {
    const target = validateTarget(rawTarget);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_active_execution", withRuntimeFence({ target }, runtimeFence));
      return validateExecutionInfo(value, target);
    } finally { session.close(); }
  }

  /** Detached receipt finalizer 的显式 target 观察；不读取 runner 环境，也不要求 runner ancestor。 */
  async inspectResultContext(rawTarget: DesktopTarget, runtimeFence?: DesktopRuntimeFence): Promise<DesktopResultContext> {
    const target = validateTarget(rawTarget);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_context", withRuntimeFence({ target }, runtimeFence));
      return validateTargetScopedResultContext(value, target);
    } finally { session.close(); }
  }

  /** 读取当前 canonical turn 的无正文、有序 activity marker。 */
  async inspectResultActivityMarker(rawTarget: DesktopTarget, runtimeFence?: DesktopRuntimeFence): Promise<DesktopResultActivityMarkerObservation> {
    const target = validateTarget(rawTarget);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_activity_marker", withRuntimeFence({ target }, runtimeFence));
      return validateDesktopResultActivityMarkerObservation(value, target);
    } finally { session.close(); }
  }

  /** 用之前捕获的 marker 做一次 target-scoped 终态 fence 校验。 */
  async inspectResultTerminalFence(
    rawTarget: DesktopTarget,
    rawMarker: DesktopResultActivityMarker,
    runtimeFence?: DesktopRuntimeFence,
  ): Promise<DesktopResultTerminalFence> {
    const target = validateTarget(rawTarget);
    const marker = validateDesktopResultActivityMarker(rawMarker);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_terminal_fence", withRuntimeFence({ target, marker }, runtimeFence));
      return validateDesktopResultTerminalFence(value, target);
    } finally { session.close(); }
  }

  async currentResultContext(workspaceRoot: string): Promise<DesktopResultContext> {
    return this.currentOperation("current_result_context", workspaceRoot, validateResultContext) as Promise<DesktopResultContext>;
  }

  /** 当前 result turn 对 accepted origin 的严格归属证明；只读且要求当前 runner 身份。 */
  async currentResultOwnership(
    workspaceRoot: string,
    rawExpectation: DesktopResultOwnershipExpectation,
  ): Promise<DesktopResultOwnership> {
    const expectation = validateResultOwnershipExpectation(rawExpectation);
    const value = await this.currentOperation("current_result_ownership", workspaceRoot, validateResultOwnership, { expectation }) as unknown as DesktopResultOwnership;
    return assertResultOwnershipExpectation(value, expectation);
  }

  /** Detached receipt finalizer's explicit-target, read-only ownership re-attestation. */
  async inspectResultOwnership(
    rawTarget: DesktopTarget,
    rawExpectation: DesktopResultOwnershipExpectation,
    runtimeFence?: DesktopRuntimeFence,
  ): Promise<DesktopResultOwnership> {
    const target = validateTarget(rawTarget);
    const expectation = validateResultOwnershipExpectation(rawExpectation);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_ownership", withRuntimeFence({ target, expectation }, runtimeFence));
      return assertResultOwnershipExpectation(validateResultOwnership(value, target), expectation);
    } finally { session.close(); }
  }

  /** Frozen v3 draft recovery: exact historical ownership and activity in one snapshot. */
  async inspectPendingReceipt(
    rawTarget: DesktopTarget,
    rawExpectation: DesktopResultOwnershipExpectation,
    rawMarker: DesktopResultActivityMarker,
    runtimeFence: DesktopRuntimeFence,
  ): Promise<DesktopResultOwnership & Pick<DesktopResultTerminalFence, "fence">> {
    const target = validateTarget(rawTarget);
    const expectation = validateResultOwnershipExpectation(rawExpectation);
    const marker = validateDesktopResultActivityMarker(rawMarker);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("inspect_pending_receipt", withRuntimeFence({ target, expectation, marker }, runtimeFence));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "fence,ownership") throw error("DESKTOP_PROTOCOL_ERROR");
      const input = value as { ownership: unknown; fence: DesktopResultTerminalFence["fence"] };
      const ownership = assertResultOwnershipExpectation(validateResultOwnership(input.ownership, target, true), expectation);
      if (ownership.resultTurnId !== marker.resultTurnId ||
          !["inProgress", "safe_terminal", "post_record_activity", "unprovable"].includes(input.fence) ||
          (input.fence === "safe_terminal" && ownership.resultTurnStatus === "inProgress") ||
          (input.fence === "inProgress" && ownership.resultTurnStatus !== "inProgress")) throw error("DESKTOP_PROTOCOL_ERROR");
      return { ...ownership, fence: input.fence };
    } finally { session.close(); }
  }

  /** 在单次 current-result 观测中读取 Desktop 自证 envelope，并由调用方与 durable delivery 精确匹配。 */
  async currentResultClassification(workspaceRoot: string): Promise<DesktopResultClassification> {
    return this.currentOperation("current_result_classification", workspaceRoot, validateResultClassification) as Promise<DesktopResultClassification>;
  }

  async confirmCurrent(workspaceRoot: string): Promise<DesktopTargetInfoInternal> {
    return this.currentOperation("current_confirm", workspaceRoot, validateInternalInfo) as Promise<DesktopTargetInfoInternal>;
  }

  async reconcileUnknown(
    rawTarget: DesktopTarget,
    rawExpectation: DesktopUnknownReconcileExpectation,
    runtimeFence?: DesktopRuntimeFence,
  ): Promise<DesktopUnknownReconcileObservation> {
    const target = validateTarget(rawTarget);
    const expectation = validateUnknownReconcileExpectation(rawExpectation);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("reconcile_unknown", withRuntimeFence({ target, expectation }, runtimeFence));
      return validateUnknownReconcileObservation(value, target);
    } finally { session.close(); }
  }

  private async currentOperation(operation: string, workspaceRoot: string,
    validate: (value: unknown, target: DesktopTarget) => DesktopTargetInfo = validateInfo,
    extra: Record<string, unknown> = {}): Promise<DesktopTargetInfo> {
    const threadId = process.env.CODEX_THREAD_ID;
    if (!isUuid(threadId) || (process.env.CODEX_SESSION_ID && process.env.CODEX_SESSION_ID !== threadId) ||
      typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_CURRENT_CONTEXT_INVALID");
    const session = this.open();
    try {
      // 不传 thread/project/host：helper 从继承的当前 Agent 上下文和 Desktop 映射精确解析。
      const value = await session.request<DesktopTargetInfo>(operation, { workspaceRoot, ...extra });
      const target = validateTarget({ threadId, hostId: "local", projectId: value?.projectId, workspaceRoot });
      return validate(value, target);
    } finally { session.close(); }
  }

  async prepare(rawTarget: DesktopTarget, runtimeFence?: DesktopRuntimeFence): Promise<DesktopIpcConnection> {
    const target = validateTarget(rawTarget);
    requireRuntimeFence(runtimeFence);
    const session = this.open();
    try {
      const value = await session.request("prepare", withRuntimeFence({ target }, runtimeFence));
      validateInfo(value, target);
      return {
        send: async (message: string) => {
          const text = validateMessage(message);
          const receipt = await session.request("send", { message: text });
          return validateReceipt(receipt, target);
        },
        close: () => session.close(),
      };
    } catch (failure) {
      session.close();
      throw failure;
    }
  }

  private open(): ReturnType<typeof openHelperSession> {
    return openHelperSession(
      this.platform,
      this.helperPath,
      this.pythonExecutable,
      this.spawnImpl,
      this.requestTimeoutMs,
      this.sendTimeoutMs,
    );
  }
}

function withRuntimeFence<T extends Record<string, unknown>>(request: T, runtimeFence?: DesktopRuntimeFence): T & { runtimeFence?: DesktopRuntimeFence } {
  return runtimeFence === undefined ? request : { ...request, runtimeFence };
}

function requireRuntimeFence(runtimeFence: DesktopRuntimeFence | undefined): DesktopRuntimeFence {
  if (!runtimeFence) throw error("DESKTOP_RUNTIME_FENCE_MISSING");
  return runtimeFence;
}

export const desktopIpc = new DesktopIpcClient();
