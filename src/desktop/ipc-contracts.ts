import type { ChildProcess, SpawnOptions } from "node:child_process";

/** 已绑定的本机 Desktop 会话；字段来自用户明确选择的目标。 */
export interface DesktopTarget {
  threadId: string;
  hostId: string;
  projectId: string;
  workspaceRoot: string;
}

export interface DesktopTargetInfo extends DesktopTarget {
  title: string;
  cwd: string;
  workspaceKind?: string;
  resumeState?: string;
  runtimeStatus?: string;
  requestsCount?: number;
  /** 内部诊断字段；不会由 MCP 直接返回。 */
  ownerClientId?: string | null;
}

export interface DesktopExecutionInfo extends DesktopTargetInfo {
  activeTurnId: string;
}

export type DesktopResultTurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "cancelled";

export interface DesktopResultContext extends DesktopTargetInfo {
  resultTurnId: string;
  resultTurnStatus: DesktopResultTurnStatus;
}

export const DESKTOP_RESULT_ACTIVITY_ITEM_TYPES = [
  "userMessage", "reasoning", "agentMessage", "commandExecution", "subAgentActivity",
  "collabAgentToolCall", "error", "modelChanged", "contextCompaction", "fileChange",
  "hookPrompt", "functionCallOutput", "plan", "mcpToolCall", "dynamicToolCall",
  "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode",
] as const;

export type DesktopResultActivityItemType = typeof DESKTOP_RESULT_ACTIVITY_ITEM_TYPES[number];

/** canonical turn.items 的无正文、有序 activity 标记。 */
export interface DesktopResultActivityMarker {
  resultTurnId: string;
  itemIds: string[];
  itemTypes: DesktopResultActivityItemType[];
  itemCount: number;
  itemSha256: string;
}

export type DesktopResultTerminalFenceKind = "inProgress" | "safe_terminal" | "post_record_activity" | "unprovable";

export interface DesktopResultActivityMarkerObservation extends DesktopResultContext {
  marker: DesktopResultActivityMarker;
}

export interface DesktopResultTerminalFence extends DesktopResultContext {
  fence: DesktopResultTerminalFenceKind;
}

export type DesktopResultOwnershipKind = "origin" | "native_continuation";
export type NativeContinuationSignature = "capacity_retry_automatic" | "resume_interrupted_task";
export type DesktopOriginAlias = "edit_user_message_v2_delivery";

export interface DesktopResultOwnershipExpectation extends DesktopUnknownReconcileExpectation {
  originTurnId: string;
}

export interface DesktopResultOwnership extends DesktopResultContext {
  ownership: DesktopResultOwnershipKind;
  originTurnId: string;
  deliveryId?: string;
  originAlias: DesktopOriginAlias | null;
  chainTurnIds: string[];
  chainLength: number;
  chainSignatures: NativeContinuationSignature[];
  signature: NativeContinuationSignature | null;
}

export type DesktopResultClassificationKind = "applicable" | "not_applicable";

/** 当前 canonical result turn 的一次性 self-attestation 分类结果。 */
export type DesktopResultClassification =
  | (DesktopResultContext & { classification: "not_applicable" })
  | (DesktopResultOwnership & DesktopUnknownReconcileExpectation & { classification: "applicable" });

export interface DesktopUnknownReconcileExpectation {
  workspaceId: string;
  commandId: string;
  intent: "development_plan" | "revision";
  messageBytes: number;
  messageSha256: string;
  deliveryId?: string;
}

export interface DesktopUnknownReconcileObservation {
  threadId: string;
  hostId: "local";
  projectId: string;
  workspaceRoot: string;
  candidates: string[];
}

export const MAX_RESULT_CONTINUATION_CHAIN = 8;
export interface DesktopIpcConnection {
  send(message: string): Promise<{ threadId: string; turnId: string }>;
  close(): void;
}

export interface DesktopIpcOptions {
  /** 仅测试替换；产品默认使用 Node spawn，shell 永远为 false。 */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  pythonExecutable?: string;
  helperPath?: string;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  sendTimeoutMs?: number;
}

export interface DesktopDiagnosis {
  mode: "behavioral";
  processStable: true;
  initialize: true;
  ownerDiscovery: boolean;
  followingChangedSent: boolean;
  stateReceived: boolean;
  stateChange: "snapshot" | "patches" | null;
}
