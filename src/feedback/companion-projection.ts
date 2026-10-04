import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  FeedbackError,
  isRouteAttestationVerified,
  type FeedbackState,
} from "./schema.js";
import { readFeedbackState, readFeedbackStatusState, recoverStaleInMemory } from "./state-store.js";
import { mutateCompanionPairing } from "./companion-state.js";
import {
  companionMatchesBinding,
  isActiveCompanion,
  isActiveRebindIntent,
} from "./companion-common.js";
import { formatRouteAttestationMessage } from "./schema.js";

/** Trusted：读 companion 元数据（无 secret）。 */
export function companionStatusForPrincipal(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): Record<string, unknown> {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  const state = readFeedbackStatusState(input.workspaceId, stateDir);
  if (
    !state.binding
    || state.binding.status !== "active"
    || state.binding.principalFingerprint !== input.principal.fingerprint
  ) {
    return {
      workspaceId: state.workspaceId,
      ownsBinding: false,
      companion: null,
      pairingIntentActive: false,
    };
  }
  const companion = isActiveCompanion(state.companion)
    && companionMatchesBinding(state.companion, state.binding)
    ? state.companion
    : null;
  const intent = state.pairingIntent && !state.pairingIntent.consumedAt
    && state.pairingIntent.bindingId === state.binding.bindingId
    && state.pairingIntent.epoch === state.binding.epoch
    ? state.pairingIntent
    : null;
  return {
    workspaceId: state.workspaceId,
    ownsBinding: true,
    companion: companion
      ? {
          companionId: companion.companionId,
          bindingId: companion.bindingId,
          epoch: companion.epoch,
          routeCanonical: companion.routeCanonical,
          pairedAt: companion.pairedAt,
          routeVerification: isRouteAttestationVerified(companion) ? "VERIFIED" : "PENDING",
        }
      : null,
    pairingIntentActive: Boolean(intent && Date.parse(intent.expiresAt) > Date.now()),
  };
}

/** Trusted bounded projection for new-Chat bootstrap decisions. */
export function companionBootstrapReadiness(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): Record<string, unknown> {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  let state: FeedbackState;
  try {
    state = recoverStaleInMemory(readFeedbackState(input.workspaceId, stateDir), Date.now());
  } catch (error) {
    if (error instanceof FeedbackError && error.code === "FEEDBACK_STATE_UNINITIALIZED") {
      return {
        workspaceId: input.workspaceId,
        state: "DISABLED",
        ownsBinding: false,
        inFlightStatus: null,
      };
    }
    throw error;
  }
  const binding = state.binding?.status === "active" ? state.binding : null;
  if (!binding) {
    return {
      workspaceId: state.workspaceId,
      state: "DISABLED",
      ownsBinding: false,
      inFlightStatus: null,
    };
  }
  const ownsBinding = binding.principalFingerprint === input.principal.fingerprint;
  const inFlightStatus = state.events.some((event) => event.status === "outcome_unknown")
    ? "outcome_unknown"
    : state.events.some((event) => event.status === "claimed")
      ? "claimed"
      : state.events.some((event) => event.status === "reserved")
        ? "reserved"
        : null;
  if (inFlightStatus) {
    return {
      workspaceId: state.workspaceId,
      state: "BLOCKED_INFLIGHT",
      ownsBinding,
      inFlightStatus,
    };
  }
  const currentCompanion = isActiveCompanion(state.companion)
    && companionMatchesBinding(state.companion, binding)
    ? state.companion
    : null;
  if (ownsBinding) {
    const predecessorAvailable = isActiveCompanion(state.companion)
      && state.rebindPredecessor?.companionId === state.companion.companionId
      && state.rebindPredecessor.bindingId === binding.bindingId
      && state.rebindPredecessor.epoch === binding.epoch;
    const nowMs = Date.now();
    const activeRebind = isActiveRebindIntent(state.rebindIntent, nowMs)
      ? state.rebindIntent
      : null;
    return {
      workspaceId: state.workspaceId,
      state: currentCompanion && isRouteAttestationVerified(currentCompanion)
        ? "OWNED_VERIFIED"
        : "OWNED_NEEDS_BROWSER_REBIND",
      ownsBinding: true,
      inFlightStatus: null,
      companionPresent: Boolean(currentCompanion),
      routeVerification: currentCompanion
        ? (isRouteAttestationVerified(currentCompanion) ? "VERIFIED" : "PENDING")
        : "NONE",
      rebindAvailable: predecessorAvailable && !activeRebind,
      rebindState: activeRebind
        ? (activeRebind.confirmedAt ? "CONFIRMED" : "PENDING")
        : "NONE",
    };
  }
  return {
    workspaceId: state.workspaceId,
    state: "FOREIGN_SAFE_TO_TAKEOVER",
    ownsBinding: false,
    inFlightStatus: null,
    expectedEpoch: binding.epoch,
    widgetId: binding.widgetId,
  };
}

/** Trusted：撤销 companion 与未消费 intent。 */
export function revokeCompanion(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): { revoked: boolean } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    if (
      !state.binding
      || state.binding.status !== "active"
      || state.binding.principalFingerprint !== input.principal.fingerprint
    ) {
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "调用主体与当前 receiver 绑定不一致");
    }
    const nowIso = new Date().toISOString();
    const hadActive = isActiveCompanion(state.companion);
    const companion = hadActive
      ? { ...state.companion!, supersededAt: nowIso }
      : state.companion;
    const intent = state.pairingIntent && !state.pairingIntent.consumedAt
      ? { ...state.pairingIntent, consumedAt: nowIso }
      : state.pairingIntent;
    return {
      state: { ...state, companion, pairingIntent: intent, rebindPredecessor: null, rebindIntent: null },
      result: { revoked: hadActive },
    };
  });
}

export function readCompanionState(workspaceId: string, stateDir = getStateDir()): FeedbackState {
  return readFeedbackState(workspaceId, stateDir);
}
