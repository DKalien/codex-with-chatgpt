/**
 * E1b3d3a fixed Send probe message — single semantic source.
 * Loaded as classic runtime script before send-probe-run.js.
 */

export const SEND_PROBE_TOKEN = "e1b3d3";

/** Fresh SW-generated attemptId only. No terminal LF (observer is exact). */
export function buildSendProbeMessage(attemptId) {
  if (typeof attemptId !== "string" || !attemptId) return null;
  return `[C2C_SEND_PROBE]\nNO_PRODUCTION_EVENT=1\nATTEMPT_ID: ${attemptId}\nTOKEN=${SEND_PROBE_TOKEN}`;
}
