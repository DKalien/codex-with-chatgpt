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
  DesktopTarget,
  DesktopTargetInfo,
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

  async inspect(rawTarget: DesktopTarget): Promise<DesktopTargetInfo> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect", { target });
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

  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_identity", workspaceRoot);
  }

  async currentExecution(workspaceRoot: string): Promise<DesktopExecutionInfo> {
    return this.currentOperation("current_execution", workspaceRoot, validateExecutionInfo) as Promise<DesktopExecutionInfo>;
  }

  /** Target-scoped active-turn observation for the Bridge server; no runner context required. */
  async inspectActiveExecution(rawTarget: DesktopTarget): Promise<DesktopExecutionInfo> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect_active_execution", { target });
      return validateExecutionInfo(value, target);
    } finally { session.close(); }
  }

  /** Detached receipt finalizer 的显式 target 观察；不读取 runner 环境，也不要求 runner ancestor。 */
  async inspectResultContext(rawTarget: DesktopTarget): Promise<DesktopResultContext> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_context", { target });
      return validateTargetScopedResultContext(value, target);
    } finally { session.close(); }
  }

  /** 读取当前 canonical turn 的无正文、有序 activity marker。 */
  async inspectResultActivityMarker(rawTarget: DesktopTarget): Promise<DesktopResultActivityMarkerObservation> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_activity_marker", { target });
      return validateDesktopResultActivityMarkerObservation(value, target);
    } finally { session.close(); }
  }

  /** 用之前捕获的 marker 做一次 target-scoped 终态 fence 校验。 */
  async inspectResultTerminalFence(
    rawTarget: DesktopTarget,
    rawMarker: DesktopResultActivityMarker,
  ): Promise<DesktopResultTerminalFence> {
    const target = validateTarget(rawTarget);
    const marker = validateDesktopResultActivityMarker(rawMarker);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_terminal_fence", { target, marker });
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
  ): Promise<DesktopResultOwnership> {
    const target = validateTarget(rawTarget);
    const expectation = validateResultOwnershipExpectation(rawExpectation);
    const session = this.open();
    try {
      const value = await session.request("inspect_result_ownership", { target, expectation });
      return assertResultOwnershipExpectation(validateResultOwnership(value, target), expectation);
    } finally { session.close(); }
  }

  /** 在单次 current-result 观测中读取 Desktop 自证 envelope，并由调用方与 durable delivery 精确匹配。 */
  async currentResultClassification(workspaceRoot: string): Promise<DesktopResultClassification> {
    return this.currentOperation("current_result_classification", workspaceRoot, validateResultClassification) as Promise<DesktopResultClassification>;
  }

  async confirmCurrent(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_confirm", workspaceRoot);
  }

  async reconcileUnknown(
    rawTarget: DesktopTarget,
    rawExpectation: DesktopUnknownReconcileExpectation,
  ): Promise<DesktopUnknownReconcileObservation> {
    const target = validateTarget(rawTarget);
    const expectation = validateUnknownReconcileExpectation(rawExpectation);
    const session = this.open();
    try {
      const value = await session.request("reconcile_unknown", { target, expectation });
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

  async prepare(rawTarget: DesktopTarget): Promise<DesktopIpcConnection> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("prepare", { target });
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

export const desktopIpc = new DesktopIpcClient();
