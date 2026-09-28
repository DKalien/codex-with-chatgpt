import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
function facadeExports(source: string): string[] {
  const names: string[] = [];
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
    for (const item of block[1].split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      names.push((parts[1] ?? parts[0]).trim());
    }
  }
  for (const match of source.matchAll(/^\s*export\s+(?:(?:async)\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(match[1]);
  }
  if (/^\s*export\s+default\b/m.test(source)) names.push("default");
  if (/^\s*export\s+\*\s+from\b/m.test(source)) names.push("*");
  return names;
}
const sorted = (items: string[]) => [...items].sort();

describe("feedback domain decomposition boundaries", () => {
  it("preserves the exact stable facade export surfaces", () => {
    const storeExpected = [
      "C2CExecutedFeedbackEvent", "CODEX_FEEDBACK_SCOPE", "COMPANION_PAIRING_TTL_MS", "COMPANION_ROUTE_ATTEST_TTL_MS", "CompanionRebindIntent", "CompanionRecord", "FEEDBACK_CLAIM_STALE_MS", "FEEDBACK_CONTROL_EVENT_VERSION", "FEEDBACK_EVENT_KIND", "FEEDBACK_RESERVATION_STALE_MS", "FINAL_RECEIPT_REQUIRED_EVENT_KIND", "FINAL_RECEIPT_REQUIRED_REASONS", "FeedbackBinding", "FeedbackError", "FeedbackEvent", "FeedbackState", "FinalReceiptRepairResult", "FinalReceiptRequiredEvent", "PairingIntent", "RouteAttestation", "ackObserved", "applyProjection", "beginSend", "c2cExecutedEventSchema", "claimNext", "companionRebindIntentSchema", "companionRebindPredecessorSchema", "companionRecordSchema", "enableReceiver", "ensureFeedbackState", "feedbackBindingSchema", "feedbackEventId", "feedbackEventSchema", "feedbackStateFile", "feedbackStateSchema", "feedbackStatusSummary", "finalReceiptRequiredEventId", "finalReceiptRequiredEventSchema", "finalReceiptRequiredInputSchema", "formatRouteAttestationMessage", "isRouteAttestationVerified", "mutateCompanionPairing", "pairingIntentSchema", "publicCompanionDeliveryEvent", "publicFeedbackEvent", "putPairingIntent", "readFeedbackState", "recoverStaleFeedback", "recoverStaleInMemory", "releaseReservation", "repairFinalReceiptRequired", "repairForwardFeedbackControlEvents", "reserveNext", "retireOutcomeUnknown", "routeAttestationSchema", "routeChallengeDigest", "stopReceiver", "takeoverReceiver",
    ];
    const companionExpected = [
      "CompanionAuthContext", "CompanionError", "companionAckObserved", "companionBeginSend", "companionBootstrapReadiness", "companionPublicState", "companionRebindStatus", "companionRelease", "companionReserveNext", "companionRetireOutcomeUnknown", "companionStatusForPrincipal", "completeCompanionRebind", "confirmRouteAttestation", "createPairingIntent", "exchangePairingIntent", "initiateCompanionRebind", "normalizeChatgptRoute", "readCompanionState", "revokeCompanion", "verifyCompanionCredential",
    ];
    const storeExports = facadeExports(read("src/feedback/store.ts"));
    const companionExports = facadeExports(read("src/feedback/companion.ts"));
    expect(storeExports).toHaveLength(58);
    expect(sorted(storeExports)).toEqual(sorted(storeExpected));
    expect(companionExports).toHaveLength(20);
    expect(sorted(companionExports)).toEqual(sorted(companionExpected));
  });

  it("keeps transaction ownership and domain dependency fences explicit", () => {
    const files = fs.readdirSync(path.join(root, "src/feedback")).filter((name) => name.endsWith(".ts") && name !== "probe-store.ts" && name !== "probe-ui.ts");
    const sources = files.map((name) => read(`src/feedback/${name}`));
    expect(sources.reduce((n, source) => n + (source.match(/\b(?:export\s+)?function\s+withFeedbackLock(?:<[^>]+>)?\s*\(/g) ?? []).length, 0)).toBe(1);
    expect(sources.reduce((n, source) => n + (source.match(/\b(?:export\s+)?function\s+writeState\s*\(/g) ?? []).length, 0)).toBe(1);
    expect(read("src/feedback/state-store.ts")).toMatch(/\b(?:export\s+)?function\s+withFeedbackLock/);
    expect(read("src/feedback/state-store.ts")).toMatch(/\b(?:export\s+)?function\s+writeState/);
    for (const [index, source] of sources.entries()) {
      if (files[index] === "state-store.ts") continue;
      expect(source).not.toMatch(/\b(?:export\s+)?function\s+(?:withFeedbackLock|writeState)\b/);
    }
    const stateStore = read("src/feedback/state-store.ts");
    const companion = read("src/feedback/companion.ts");
    const delivery = read("src/feedback/companion-delivery.ts");
    expect(stateStore).not.toMatch(/receipt-finalizer|conversation-principal|from ["']\.\.["']\/(bridge|mcp|routing)/);
    expect(companion).not.toMatch(/from ["']\.\.\/(?:routing|bridge|mcp|browser)[^"']*["']/);
    expect(companion).not.toMatch(/from ["']\.\/store\.js["']/);
    expect(delivery).not.toMatch(/status:\s*["']observed["']/);
    expect(delivery).toContain("ackObservedForCompanion");
    expect(delivery).toMatch(/export function companionAckObserved[\s\S]*?return ackObservedForCompanion\(\{/);
    expect(delivery).not.toMatch(/export function companionAckObserved[\s\S]*?return\s*\{[\s\S]*?status:/);
    for (const name of fs.readdirSync(path.join(root, "src/feedback")).filter((n) => n.startsWith("companion-") && n.endsWith(".ts"))) {
      expect(read(`src/feedback/${name}`)).not.toMatch(/executor|routing-command|result-outbox|execution-result-projector|Desktop.*(?:send|IPC)/i);
    }
    const routingImports = `${read("src/routing/execution-result-projector.ts")}\n${read("src/routing/result-outbox-store.ts")}`
      .split(/\r?\n/).filter((line) => /^\s*import\b/.test(line)).join("\n");
    expect(routingImports).not.toMatch(/feedback|browser-companion/);
  });
});
