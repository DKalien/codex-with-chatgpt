import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

const JOURNAL_STATES = new Set([
  "NONE",
  "RESERVE_REQUESTED",
  "RESERVED",
  "RESERVATION_RECOVERY",
  ["SEND", "INTENT"].join("_"),
  "CLAIMED",
  "COMPOSER_WRITE_INTENT",
  "SEND_DISPATCH_INTENT",
  "OBSERVED_PENDING_ACK",
  "OUTCOME_UNKNOWN",
]);

const ERROR_TEXT = "C2C：连接需要处理";
const WARNING_TEXT = "C2C：需要完成连接或开启自动回流";
const NORMAL_TEXT = "C2C：当前对话已连接，自动回流已开启";

function result(severity, reason) {
  const badgeText = severity === "normal" ? "C" : severity === "error" ? "C×" : "C!";
  return {
    severity,
    badgeText,
    title: severity === "normal" ? NORMAL_TEXT : severity === "error" ? ERROR_TEXT : WARNING_TEXT,
    reason,
  };
}

function hasTransport(input) {
  return input?.transportPresent === true
    || Boolean(input?.transport?.bridgeOrigin || input?.transport?.workspaceId);
}

function routeMismatch(input, transitioning) {
  const owner = input?.owner;
  const transportRoute = input?.transport?.routeCanonical;
  const ownerRoute = owner?.canonicalRoute;
  return !transitioning
    && owner?.available === true
    && typeof ownerRoute === "string"
    && typeof transportRoute === "string"
    && !areChatgptConversationRoutesEquivalent(ownerRoute, transportRoute);
}

/**
 * Derive the toolbar indicator from bounded trusted state only.
 * The return value intentionally has no identity, route, credential, or raw error data.
 */
export function deriveCompanionIndicator(input = {}) {
  const transport = input.transport && typeof input.transport === "object" ? input.transport : {};
  const autonomy = input.autonomy && typeof input.autonomy === "object" ? input.autonomy : {};
  const journal = input.journal && typeof input.journal === "object" ? input.journal : { state: "NONE" };
  const routeFence = input.routeAttestFence?.state ?? input.routeAttestFence ?? "NONE";
  const connectFlow = input.connectFlow?.state ?? input.connectFlow ?? "NONE";
  const rebindPending = transport.rebindPending === true;
  const transitioning = rebindPending || ["ATTEST_REQUESTED", "COMPLETE_REQUESTED"].includes(connectFlow);

  if (input.bridgeOriginInvalid === true) return result("error", "bridge_origin_invalid");
  if (transport.authStale === true) return result("error", "auth_stale");
  if (input.storageProtected !== true && (input.hydrated === true || hasTransport(input))) {
    return result("error", "storage_unprotected");
  }
  if (journal.state === "OUTCOME_UNKNOWN") return result("error", "journal_outcome_unknown");
  if (routeFence === "OUTCOME_UNKNOWN") return result("error", "route_attest_outcome_unknown");
  if (connectFlow === "OUTCOME_UNKNOWN") return result("error", "connect_outcome_unknown");
  if (!JOURNAL_STATES.has(journal.state ?? "NONE")) return result("error", "journal_state_unknown");
  if (routeMismatch(input, transitioning)) return result("error", "route_identity_mismatch");

  if (input.hydrated !== true) return result("warning", "startup_pending");
  if (!hasTransport(input)) return result("warning", "transport_missing");
  if (!transport.bridgeOrigin) return result("warning", "transport_missing");
  if (input.bridgeOriginInvalid !== true
    && transport.bridgeOrigin
    && input.bridgePermissionGranted !== true) {
    return result("warning", "bridge_permission_missing");
  }
  if (input.owner?.available !== true) return result("warning", "owner_missing");
  if (rebindPending) return result("warning", "rebind_pending");
  if (connectFlow === "ATTEST_REQUESTED" || connectFlow === "COMPLETE_REQUESTED") {
    return result("warning", "connect_pending");
  }
  if (transport.routeVerification !== "VERIFIED") return result("warning", "route_pending");
  if (autonomy.mode === "shadow") return result("warning", "autonomy_shadow");
  if (autonomy.mode !== "armed") return result("warning", "autonomy_off");
  if (autonomy.identityExact !== true) return result("warning", "autonomy_identity_pending");
  if (input.productionSendInFlight === true || autonomy.tickInFlight === true) {
    return result("warning", "in_flight");
  }
  if (autonomy.lastDecision === "cooldown" || autonomy.lastReason === "production_cooldown") {
    return result("warning", "autonomy_cooldown");
  }
  if (transport.connected !== true) return result("warning", "transport_not_ready");
  return result("normal", "ready");
}

export function createCompanionIndicatorApplier(getAction) {
  let lastKey = null;
  return async (indicator) => {
    const action = typeof getAction === "function" ? getAction() : getAction;
    if (!action || typeof action.setBadgeText !== "function" || typeof action.setTitle !== "function") {
      return false;
    }
    const key = `${indicator.severity}|${indicator.badgeText}|${indicator.title}|${indicator.reason}`;
    if (key === lastKey) return false;
    let ok = true;
    try {
      await action.setBadgeText({ text: indicator.badgeText });
    } catch {
      ok = false;
    }
    try {
      await action.setTitle({ title: indicator.title });
    } catch {
      ok = false;
    }
    if (ok) lastKey = key;
    return ok;
  };
}
