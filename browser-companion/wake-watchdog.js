/**
 * Pure policy for the MV3 sleep/wake discovery alarm.
 * It never authorizes a reserve, send, DOM mutation, or autonomy transition.
 */

export const WAKE_WATCHDOG_ALARM_NAME = "c2c.feedback.discovery";
export const WAKE_WATCHDOG_PERIOD_MINUTES = 1;

export function wakeWatchdogAlarmMatches(alarm) {
  return alarm?.name === WAKE_WATCHDOG_ALARM_NAME
    && alarm?.periodInMinutes === WAKE_WATCHDOG_PERIOD_MINUTES;
}

export function createWakeWatchdogController(getAlarms) {
  let desired = null;
  let installed = null;
  let queue = Promise.resolve();

  function sync(enabled, { verify = false } = {}) {
    const nextDesired = enabled === true;
    const previousDesired = desired;
    desired = nextDesired;
    const run = async () => {
      const alarms = getAlarms();
      if (!alarms?.get || !alarms?.create || !alarms?.clear) {
        return { ok: false, reason: "alarms_unavailable" };
      }

      if (nextDesired) {
        if (installed === true && !verify) {
          return { ok: true, action: "noop", desired: true, installed: true };
        }
        const existing = await alarms.get(WAKE_WATCHDOG_ALARM_NAME);
        installed = wakeWatchdogAlarmMatches(existing);
        if (!installed) {
          await alarms.create(WAKE_WATCHDOG_ALARM_NAME, {
            periodInMinutes: WAKE_WATCHDOG_PERIOD_MINUTES,
          });
          installed = true;
          return { ok: true, action: "create", desired: true, installed: true };
        }
        return { ok: true, action: "verified", desired: true, installed: true };
      }

      if (previousDesired === true || installed === true) {
        await alarms.clear(WAKE_WATCHDOG_ALARM_NAME);
        installed = false;
        return { ok: true, action: "clear", desired: false, installed: false };
      }
      if (previousDesired === null && installed === null) {
        const existing = await alarms.get(WAKE_WATCHDOG_ALARM_NAME);
        installed = false;
        if (existing) {
          await alarms.clear(WAKE_WATCHDOG_ALARM_NAME);
          return { ok: true, action: "clear", desired: false, installed: false };
        }
      }
      return { ok: true, action: "noop", desired: false, installed };
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return { sync };
}

const ACTIVE_JOURNAL_STATES = new Set([
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

export function wakeWatchdogEligible(input = {}) {
  const transport = input.transport;
  if (
    input.storageProtected !== true
    || !transport
    || transport.authStale === true
    || typeof transport.bridgeOrigin !== "string"
    || transport.bridgeOrigin.length === 0
  ) {
    return false;
  }
  return input.autonomyMode === "armed"
    || input.autonomyMode === "shadow"
    || ACTIVE_JOURNAL_STATES.has(input.journalState);
}

export function normalizeWakeReason(reason) {
  return [
    "auth_stale",
    "network_unreachable",
    "transport_missing",
    "storage_unprotected",
    "rebind_pending",
    "COMPANION_REPAIR_BLOCKED",
  ].includes(reason)
    ? reason
    : "state_discovery_failed";
}
