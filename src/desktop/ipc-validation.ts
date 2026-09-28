import { MAX_MESSAGE_BYTES } from "./store.js";
import {
  DESKTOP_RESULT_ACTIVITY_ITEM_TYPES,
  MAX_RESULT_CONTINUATION_CHAIN,
  type DesktopDiagnosis,
  type DesktopExecutionInfo,
  type DesktopResultActivityItemType,
  type DesktopResultActivityMarker,
  type DesktopResultActivityMarkerObservation,
  type DesktopResultClassification,
  type DesktopResultContext,
  type DesktopResultTurnStatus,
  type DesktopOriginAlias,
  type DesktopResultOwnership,
  type DesktopResultOwnershipExpectation,
  type DesktopResultTerminalFence,
  type DesktopResultTerminalFenceKind,
  type DesktopTarget,
  type DesktopTargetInfo,
  type DesktopUnknownReconcileExpectation,
  type DesktopUnknownReconcileObservation,
  type NativeContinuationSignature,
} from "./ipc-contracts.js";
import {
  error,
  isUuid,
  MAX_CONTROL_FRAME_BYTES,
  SEND_REQUEST_ID_PLACEHOLDER,
} from "./ipc-errors.js";

const MAX_RESULT_ACTIVITY_ITEMS = 4096;
const RESULT_ACTIVITY_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

export function validateTarget(value: DesktopTarget): DesktopTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["hostId", "projectId", "threadId", "workspaceRoot"].join(",")) throw error("DESKTOP_INVALID_REQUEST");
  if (!isUuid(value.threadId) || value.hostId !== "local" || typeof value.projectId !== "string" ||
      value.projectId.length < 1 || value.projectId.length > 128 || typeof value.workspaceRoot !== "string" || !value.workspaceRoot.trim()) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

export function validateMessage(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw error("DESKTOP_INVALID_REQUEST");
  const encoded = Buffer.from(value, "utf8");
  if (encoded.toString("utf8") !== value) throw error("DESKTOP_INVALID_REQUEST");
  if (encoded.byteLength > MAX_MESSAGE_BYTES) throw error("DESKTOP_MESSAGE_TOO_LARGE");
  return value;
}

export function validateDesktopWireMessage(value: string): string {
  const text = validateMessage(value);
  let encoded: string;
  try { encoded = JSON.stringify({ id: SEND_REQUEST_ID_PLACEHOLDER, op: "send", message: text }) + "\n"; }
  catch { throw error("DESKTOP_PROTOCOL_ERROR"); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_FRAME_BYTES) throw error("DESKTOP_MESSAGE_TOO_LARGE");
  return text;
}

export function validateInfo(value: unknown, target: DesktopTarget): DesktopTargetInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const info = value as Partial<DesktopTargetInfo>;
  if (info.threadId !== target.threadId || info.hostId !== target.hostId || info.projectId !== target.projectId ||
      info.workspaceRoot !== target.workspaceRoot) throw error("DESKTOP_TARGET_NOT_FOUND");
  if (typeof info.title !== "string" || !info.title.trim() || info.title.length > 300 || typeof info.cwd !== "string" ||
      normalizePath(info.cwd) !== normalizePath(target.workspaceRoot)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return { ...target, ...info } as DesktopTargetInfo;
}

export function validateExecutionInfo(value: unknown, target: DesktopTarget): DesktopExecutionInfo {
  const info = validateInfo(value, target);
  if (info.runtimeStatus !== "active" && info.runtimeStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  const activeTurnId = (value as { activeTurnId?: unknown }).activeTurnId;
  if (!isUuid(activeTurnId)) throw error("DESKTOP_STATE_UNAVAILABLE");
  return { ...info, activeTurnId };
}

export function validateResultContext(value: unknown, target: DesktopTarget): DesktopResultContext {
  const info = validateInfo(value, target);
  const input = value as { resultTurnId?: unknown; resultTurnStatus?: unknown };
  if (!isUuid(input.resultTurnId) || typeof input.resultTurnStatus !== "string" ||
      !(["inProgress", "completed", "failed", "interrupted", "cancelled"] as const).includes(input.resultTurnStatus as DesktopResultTurnStatus)) {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if (info.runtimeStatus === "idle" && input.resultTurnStatus === "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if ((info.runtimeStatus === "active" || info.runtimeStatus === "inProgress") && input.resultTurnStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if (info.runtimeStatus !== "idle" && info.runtimeStatus !== "active" && info.runtimeStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  return { ...info, resultTurnId: input.resultTurnId, resultTurnStatus: input.resultTurnStatus as DesktopResultTurnStatus };
}

export function validateTargetScopedResultContext(value: unknown, target: DesktopTarget): DesktopResultContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const keys = [
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId", "resultTurnId", "resultTurnStatus",
  ];
  if (Object.keys(input).sort().join(",") !== [...keys].sort().join(",")) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  if (input.workspaceKind !== "project" || input.resumeState !== "resumed" ||
      !Number.isSafeInteger(input.requestsCount) || (input.requestsCount as number) < 0 ||
      typeof input.ownerClientId !== "string" || !isUuid(input.ownerClientId)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return context;
}

export function validateDesktopResultActivityMarker(value: unknown): DesktopResultActivityMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "itemCount,itemIds,itemSha256,itemTypes,resultTurnId") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const itemIds = input.itemIds;
  const itemTypes = input.itemTypes;
  if (!isUuid(input.resultTurnId) || !Array.isArray(itemIds) || !Array.isArray(itemTypes) ||
      itemIds.length !== itemTypes.length || itemIds.length < 1 || itemIds.length > MAX_RESULT_ACTIVITY_ITEMS ||
      !Number.isSafeInteger(input.itemCount) || input.itemCount !== itemIds.length ||
      typeof input.itemSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.itemSha256) ||
      !itemIds.every(itemId => typeof itemId === "string" && RESULT_ACTIVITY_ITEM_ID_PATTERN.test(itemId)) ||
      new Set(itemIds).size !== itemIds.length ||
      !itemTypes.every(itemType => typeof itemType === "string" &&
        (DESKTOP_RESULT_ACTIVITY_ITEM_TYPES as readonly string[]).includes(itemType))) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    resultTurnId: input.resultTurnId,
    itemIds: [...itemIds] as string[],
    itemTypes: [...itemTypes] as DesktopResultActivityItemType[],
    itemCount: input.itemCount,
    itemSha256: input.itemSha256,
  };
}

export function validateDesktopResultActivityMarkerObservation(
  value: unknown,
  target: DesktopTarget,
): DesktopResultActivityMarkerObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !==
      "cwd,hostId,marker,ownerClientId,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const marker = validateDesktopResultActivityMarker(input.marker);
  const contextValue = { ...input };
  delete contextValue.marker;
  const context = validateTargetScopedResultContext(contextValue, target);
  if (marker.resultTurnId !== context.resultTurnId) throw error("DESKTOP_PROTOCOL_ERROR");
  return { ...context, marker };
}

export function validateDesktopResultTerminalFence(
  value: unknown,
  target: DesktopTarget,
): DesktopResultTerminalFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !==
      "cwd,fence,hostId,ownerClientId,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const contextValue = { ...input };
  delete contextValue.fence;
  const context = validateTargetScopedResultContext(contextValue, target);
  if (!(["inProgress", "safe_terminal", "post_record_activity", "unprovable"] as const).includes(input.fence as DesktopResultTerminalFenceKind)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const fence = input.fence as DesktopResultTerminalFenceKind;
  const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(context.resultTurnStatus);
  if ((fence === "inProgress" && context.resultTurnStatus !== "inProgress") ||
      (fence === "safe_terminal" && !terminal)) {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  return { ...context, fence };
}

export function validateDesktopDiagnosis(value: unknown): DesktopDiagnosis {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !==
      "followingChangedSent,initialize,mode,ownerDiscovery,processStable,stateChange,stateReceived") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (input.processStable !== true || input.initialize !== true || input.mode !== "behavioral" ||
      typeof input.ownerDiscovery !== "boolean" || typeof input.followingChangedSent !== "boolean" ||
      typeof input.stateReceived !== "boolean" ||
      (input.stateChange !== "snapshot" && input.stateChange !== "patches" && input.stateChange !== null)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    mode: "behavioral",
    processStable: true,
    initialize: true,
    ownerDiscovery: input.ownerDiscovery as boolean,
    followingChangedSent: input.followingChangedSent as boolean,
    stateReceived: input.stateReceived as boolean,
    stateChange: input.stateChange as DesktopDiagnosis["stateChange"],
  };
}

export function validateResultOwnershipExpectation(value: DesktopResultOwnershipExpectation): DesktopResultOwnershipExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  const baseKeys = ["commandId", "intent", "messageBytes", "messageSha256", "originTurnId", "workspaceId"].sort().join(",");
  const deliveryKeys = ["commandId", "deliveryId", "intent", "messageBytes", "messageSha256", "originTurnId", "workspaceId"].sort().join(",");
  if (keys.join(",") !== baseKeys &&
      (keys.join(",") !== deliveryKeys || !Object.prototype.hasOwnProperty.call(value, "deliveryId"))) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.commandId) ||
      !["development_plan", "revision"].includes(value.intent) || !isUuid(value.originTurnId) ||
      !Number.isSafeInteger(value.messageBytes) || value.messageBytes < 1 || value.messageBytes > MAX_MESSAGE_BYTES ||
      !/^[a-f0-9]{64}$/u.test(value.messageSha256) ||
      (Object.prototype.hasOwnProperty.call(value, "deliveryId") && !isUuid(value.deliveryId))) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

export function validateResultOwnership(value: unknown, target: DesktopTarget): DesktopResultOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "ownership", "originTurnId", "deliveryId", "originAlias",
    "chainTurnIds", "chainLength", "chainSignatures", "signature",
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  const ownership = input.ownership;
  const originTurnId = input.originTurnId;
  const deliveryId = input.deliveryId;
  const originAlias = input.originAlias;
  const chainTurnIds = input.chainTurnIds;
  const chainLength = input.chainLength;
  const chainSignatures = input.chainSignatures;
  const signature = input.signature;
  if ((ownership !== "origin" && ownership !== "native_continuation") ||
      !Object.prototype.hasOwnProperty.call(input, "originAlias") ||
      (originAlias !== null && originAlias !== "edit_user_message_v2_delivery") ||
      (Object.prototype.hasOwnProperty.call(input, "deliveryId") && !isUuid(deliveryId))) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (!isUuid(originTurnId) || !Array.isArray(chainTurnIds) ||
      chainTurnIds.length < 1 || chainTurnIds.length > MAX_RESULT_CONTINUATION_CHAIN + 1 ||
      !chainTurnIds.every(isUuid) || new Set(chainTurnIds).size !== chainTurnIds.length ||
      typeof chainLength !== "number" || !Number.isSafeInteger(chainLength) ||
      chainLength < 0 || chainLength > MAX_RESULT_CONTINUATION_CHAIN ||
      chainLength !== chainTurnIds.length - 1 || chainTurnIds[0] !== originTurnId ||
      chainTurnIds[chainTurnIds.length - 1] !== context.resultTurnId ||
      !Array.isArray(chainSignatures) || chainSignatures.length !== chainLength ||
      !chainSignatures.every(item => item === "capacity_retry_automatic" || item === "resume_interrupted_task")) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (ownership === "origin") {
    if (chainLength !== 0 || chainSignatures.length !== 0 || signature !== null || context.resultTurnId !== originTurnId || originAlias !== null) {
      throw error("DESKTOP_PROTOCOL_ERROR");
    }
  } else if (chainLength < 1 || signature !== chainSignatures[chainSignatures.length - 1] || context.resultTurnId === originTurnId) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (originAlias !== null &&
      (!Object.prototype.hasOwnProperty.call(input, "deliveryId") || ownership !== "native_continuation" ||
       chainSignatures[0] !== "resume_interrupted_task")) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    ...context,
    ownership,
    originTurnId,
    ...(Object.prototype.hasOwnProperty.call(input, "deliveryId") ? { deliveryId: deliveryId as string } : {}),
    originAlias: originAlias as DesktopOriginAlias | null,
    chainTurnIds: [...chainTurnIds],
    chainLength,
    chainSignatures: [...chainSignatures],
    signature: signature as NativeContinuationSignature | null,
  };
}

export function assertResultOwnershipExpectation(
  value: DesktopResultOwnership,
  expectation: DesktopResultOwnershipExpectation,
): DesktopResultOwnership {
  if (value.deliveryId !== expectation.deliveryId) throw error("DESKTOP_RECONCILIATION_CONFLICT");
  if (value.originAlias === null) {
    if (value.originTurnId !== expectation.originTurnId) throw error("DESKTOP_RECONCILIATION_CONFLICT");
  } else if (!expectation.deliveryId || value.originTurnId === expectation.originTurnId) {
    throw error("DESKTOP_RECONCILIATION_CONFLICT");
  }
  return value;
}

export function validateResultClassification(value: unknown, target: DesktopTarget): DesktopResultClassification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "classification", "workspaceId", "commandId", "intent",
    "messageBytes", "messageSha256", "deliveryId", "ownership", "originTurnId", "originAlias",
    "chainTurnIds", "chainLength", "chainSignatures", "signature",
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  if (input.classification === "not_applicable") {
    if (["workspaceId", "commandId", "intent", "messageBytes", "messageSha256", "deliveryId", "ownership", "originTurnId", "originAlias", "chainTurnIds", "chainLength", "chainSignatures", "signature"]
      .some(key => Object.prototype.hasOwnProperty.call(input, key))) {
      throw error("DESKTOP_PROTOCOL_ERROR");
    }
    return { ...context, classification: "not_applicable" };
  }
  if (input.classification !== "applicable") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  let attestation: DesktopUnknownReconcileExpectation;
  try {
    attestation = validateUnknownReconcileExpectation({
      workspaceId: input.workspaceId,
      commandId: input.commandId,
      intent: input.intent,
      messageBytes: input.messageBytes,
      messageSha256: input.messageSha256,
      ...(Object.prototype.hasOwnProperty.call(input, "deliveryId") ? { deliveryId: input.deliveryId as string } : {}),
    } as DesktopUnknownReconcileExpectation);
  } catch {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const ownershipInput = { ...input };
  delete ownershipInput.classification;
  for (const key of ["workspaceId", "commandId", "intent", "messageBytes", "messageSha256"]) delete ownershipInput[key];
  const ownership = validateResultOwnership(ownershipInput, target);
  return { ...ownership, ...attestation, classification: "applicable" };
}

export function validateUnknownReconcileExpectation(value: DesktopUnknownReconcileExpectation): DesktopUnknownReconcileExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  const baseKeys = ["commandId", "intent", "messageBytes", "messageSha256", "workspaceId"].sort().join(",");
  const exactDeliveryKeys = ["commandId", "deliveryId", "intent", "messageBytes", "messageSha256", "workspaceId"].sort().join(",");
  if (keys.join(",") !== baseKeys &&
      (keys.join(",") !== exactDeliveryKeys || !Object.prototype.hasOwnProperty.call(value, "deliveryId"))) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.commandId) ||
      !["development_plan", "revision"].includes(value.intent) ||
      !Number.isSafeInteger(value.messageBytes) || value.messageBytes < 1 || value.messageBytes > MAX_MESSAGE_BYTES ||
      !/^[a-f0-9]{64}$/u.test(value.messageSha256) ||
      (Object.prototype.hasOwnProperty.call(value, "deliveryId") && !isUuid(value.deliveryId))) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

export function validateUnknownReconcileObservation(value: unknown, target: DesktopTarget): DesktopUnknownReconcileObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Partial<DesktopUnknownReconcileObservation>;
  const candidates = input.candidates;
  if (input.threadId !== target.threadId || input.hostId !== target.hostId || input.projectId !== target.projectId ||
      input.workspaceRoot !== target.workspaceRoot || !Array.isArray(candidates) || candidates.length > 10_000 ||
      !candidates.every(candidate => isUuid(candidate))) {
    throw error("DESKTOP_RECONCILIATION_CONFLICT");
  }
  return { ...target, hostId: "local", candidates: [...candidates] };
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function validateReceipt(value: unknown, target: DesktopTarget): { threadId: string; turnId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_OUTCOME_UNKNOWN", { notSent: false });
  const receipt = value as Partial<{ threadId: string; turnId: string }>;
  if (!isUuid(receipt.threadId) || !isUuid(receipt.turnId) || receipt.threadId !== target.threadId) {
    throw error("DESKTOP_OUTCOME_UNKNOWN", { notSent: false });
  }
  return { threadId: receipt.threadId, turnId: receipt.turnId };
}
