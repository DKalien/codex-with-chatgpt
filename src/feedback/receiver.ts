import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  FeedbackError,
  type FeedbackBinding,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import {
  recoverStaleInMemory,
  requireInitializedState,
  withFeedbackLock,
  writeState,
} from "./state-store.js";

export function requireActiveBinding(state: FeedbackState, principal: ConversationPrincipal): FeedbackBinding {
  if (!state.binding || state.binding.status !== "active") {
    throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
  }
  if (state.binding.principalFingerprint !== principal.fingerprint) {
    throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "调用主体与当前 receiver 绑定不一致");
  }
  return state.binding;
}

function eventMayBind(event: FeedbackEvent, binding: FeedbackBinding): boolean {
  return !("plannerPrincipalFingerprint" in event)
    || event.plannerPrincipalFingerprint === binding.principalFingerprint;
}

function retargetEvent(event: FeedbackEvent, binding: FeedbackBinding, now: string): FeedbackEvent {
  if (eventMayBind(event, binding)) {
    return { ...event, status: "ready", targetBindingId: binding.bindingId, targetEpoch: binding.epoch, targetPrincipalFingerprint: binding.principalFingerprint, updatedAt: now };
  }
  return { ...event, status: "queued", targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, updatedAt: now };
}

export function enableReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  widgetId: string;
  stateDir?: string;
}): FeedbackState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (previous.binding && previous.binding.status === "active") {
      if (previous.binding.principalFingerprint === input.principal.fingerprint) {
        return previous;
      }
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_REQUIRED",
        "已有其它 receiver 绑定；请使用 takeover(expectedEpoch)",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleInMemory(previous, now);
    const epoch = (recovered.binding?.epoch ?? 0) + 1;
    const binding: FeedbackBinding = {
      version: 1,
      bindingId: randomUUID(),
      epoch,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next: FeedbackState = {
      ...recovered,
      binding,
      rebindIntent: null,
      rebindPredecessor: null,
      events: recovered.events.map((event) =>
        event.status === "queued" || event.status === "ready" ? retargetEvent(event, binding, new Date(now).toISOString()) : event,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function takeoverReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  widgetId: string;
  expectedEpoch: number;
  stateDir?: string;
}): { state: FeedbackState } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (!previous.binding || previous.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "当前没有可接管的 receiver 绑定");
    }
    if (previous.binding.epoch !== input.expectedEpoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_CONFLICT", "绑定代次已变化，接管失败");
    }
    if (previous.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown" || e.status === "reserved")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown/reserved 事件；禁止接管以免重发",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleInMemory(previous, now);
    if (recovered.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown" || e.status === "reserved")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown/reserved 事件；禁止接管以免重发",
      );
    }
    const binding: FeedbackBinding = {
      version: 1,
      bindingId: randomUUID(),
      epoch: previous.binding.epoch + 1,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next: FeedbackState = {
      ...recovered,
      binding,
      rebindIntent: null,
      rebindPredecessor: recovered.companion
        && !recovered.companion.supersededAt
        && recovered.companion.bindingId === previous.binding.bindingId
        && recovered.companion.epoch === previous.binding.epoch
        && recovered.companion.principalFingerprint === previous.binding.principalFingerprint
        ? {
            version: 1,
            companionId: recovered.companion.companionId,
            previousBindingId: previous.binding.bindingId,
            previousEpoch: previous.binding.epoch,
            bindingId: binding.bindingId,
            epoch: binding.epoch,
          }
        : null,
      events: recovered.events.map((event) =>
        event.status === "queued" || event.status === "ready" ? retargetEvent(event, binding, new Date(now).toISOString()) : event,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return { state: next };
  });
}

export function stopReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): FeedbackState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (!previous.binding) return previous;
    if (previous.binding.principalFingerprint !== input.principal.fingerprint) {
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "停止主体与当前 receiver 绑定不一致");
    }
    const now = Date.now();
    const next: FeedbackState = {
      ...recoverStaleInMemory(previous, now),
      binding: { ...previous.binding, status: "superseded" },
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}
