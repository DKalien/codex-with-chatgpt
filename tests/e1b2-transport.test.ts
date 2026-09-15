import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseBridgeOrigin,
  companionApiUrl,
  BridgeOriginError,
} from "../browser-companion/bridge-origin.js";
import {
  mintOwnerProof,
  consumeOwnerProof,
  markProofUsed,
  journalBlocksTransportMutation,
} from "../browser-companion/owner-proof.js";
import {
  emptyJournal,
  markReserveRequested,
  markReserved,
  markReservationRecovery,
  clearJournal,
  evaluateReserveEligibility,
  validateStateIdentity,
  assertNoForbiddenFields,
  journalActive,
  reconcileReservedJournal,
  pairAllowedWithJournal,
  applyStorageProtectionPolicy,
} from "../browser-companion/reservation-journal.js";
import { companionPublicState } from "../src/feedback/companion.js";
import {
  enableReceiver,
  readFeedbackState,
} from "../src/feedback/store.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { CODEX_FEEDBACK_SCOPE } from "../src/feedback/store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import {
  appendExecutionRecordLocked,
  withExecutionRecordsLock,
} from "../src/execution/records.js";
import { updateDesktop } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { createPairingIntent, exchangePairingIntent, verifyCompanionCredential } from "../src/feedback/companion.js";
import { reserveNext } from "../src/feedback/store.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

describe("bridge origin parser", () => {
  it("accepts HTTPS origin only by default", () => {
    expect(parseBridgeOrigin("https://bridge.example.com")).toBe("https://bridge.example.com");
    expect(parseBridgeOrigin("https://bridge.example.com:8443")).toBe("https://bridge.example.com:8443");
    expect(() => parseBridgeOrigin("http://evil.example.com")).toThrow(BridgeOriginError);
    expect(() => parseBridgeOrigin("https://bridge.example.com/path")).toThrow(BridgeOriginError);
    expect(() => parseBridgeOrigin("https://bridge.example.com?x=1")).toThrow(BridgeOriginError);
  });

  it("loopback HTTP only when explicitly allowed", () => {
    expect(() => parseBridgeOrigin("http://127.0.0.1:5000")).toThrow(BridgeOriginError);
    expect(parseBridgeOrigin("http://127.0.0.1:5000", { allowLoopbackHttp: true }))
      .toBe("http://127.0.0.1:5000");
    expect(parseBridgeOrigin("http://localhost:5000", { allowLoopbackHttp: true }))
      .toBe("http://localhost:5000");
    expect(() => parseBridgeOrigin("http://example.com", { allowLoopbackHttp: true }))
      .toThrow(BridgeOriginError);
  });

  it("companionApiUrl appends exact path", () => {
    expect(companionApiUrl("https://b.example.com", "/api/companion/v1/state"))
      .toBe("https://b.example.com/api/companion/v1/state");
  });
});

describe("reservation journal + eligibility", () => {
  it("reserve requested → reserved → release clear", () => {
    let j = emptyJournal();
    expect(journalActive(j)).toBe(false);
    j = markReserveRequested(j, { routeCanonical: ROUTE, bindingId: "b", epoch: 1 });
    expect(j.state).toBe("RESERVE_REQUESTED");
    j = markReserved(j, { eventId: "e".repeat(32), reservationId: "r", routeCanonical: ROUTE, bindingId: "b", epoch: 1 });
    expect(j.state).toBe("RESERVED");
    expect(journalActive(j)).toBe(true);
    j = clearJournal();
    expect(j.state).toBe("NONE");
  });

  it("lost response → recovery", () => {
    let j = markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 });
    j = markReservationRecovery(j, {});
    expect(j.state).toBe("RESERVATION_RECOVERY");
  });

  it("fresh safe owner evidence eligible; stale/dirty/generating/unknown not", () => {
    const base = {
      transportValid: true,
      authStale: false,
      isOwner: true,
      ownerRoute: ROUTE,
      pairedRoute: ROUTE,
      documentId: "d1",
      journal: emptyJournal(),
      now: 1_000_000,
      evidence: {
        observedAt: 1_000_000 - 2_000,
        documentId: "d1",
        canonicalRoute: ROUTE,
        composer: "empty",
        generation: "idle",
        safe: true,
      },
    };
    expect(evaluateReserveEligibility(base).ok).toBe(true);
    expect(evaluateReserveEligibility({
      ...base,
      evidence: { ...base.evidence, observedAt: 1_000_000 - 60_000 },
    }).reason).toBe("evidence_stale");
    expect(evaluateReserveEligibility({
      ...base,
      evidence: { ...base.evidence, composer: "dirty" },
    }).reason).toBe("composer_not_empty");
    expect(evaluateReserveEligibility({
      ...base,
      evidence: { ...base.evidence, generation: "generating" },
    }).reason).toBe("generation_not_idle");
    expect(evaluateReserveEligibility({
      ...base,
      evidence: { ...base.evidence, generation: "unknown" },
    }).reason).toBe("generation_not_idle");
    expect(evaluateReserveEligibility({
      ...base,
      evidence: { ...base.evidence, documentId: "d2" },
    }).reason).toBe("evidence_document_mismatch");
    expect(evaluateReserveEligibility({ ...base, isOwner: false }).reason).toBe("not_owner");
    expect(evaluateReserveEligibility({
      ...base,
      journal: markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
    }).reason).toBe("journal_active");
  });

  it("validateStateIdentity + forbidden fields", () => {
    const persisted = {
      workspaceId: "w",
      bindingId: "b",
      epoch: 1,
      companionId: "c",
      routeCanonical: ROUTE,
    };
    expect(validateStateIdentity(persisted, persisted).ok).toBe(true);
    expect(validateStateIdentity(persisted, { ...persisted, epoch: 2 }).ok).toBe(false);
    expect(() => assertNoForbiddenFields({ principalFingerprint: "x" })).toThrow(/forbidden/);
    expect(() => assertNoForbiddenFields({ reservedBy: "x" })).toThrow(/forbidden/);
    expect(() => assertNoForbiddenFields({ inFlight: { eventId: "e", reservationId: "r" } })).not.toThrow();
  });
});

describe("server /state inFlight recovery projection", () => {
  let stateDir: string;
  let wsRoot: string;
  let workspace: Workspace;

  function principalA() {
    return resolveConversationPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
      _meta: { "openai/session": "sess-A" },
    });
  }

  function seed(commandId: string) {
    updateDesktop(workspace.id, (previous) => {
      const base = previous ?? {
        version: 1 as const,
        workspaceId: workspace.id,
        workspaceRoot: wsRoot,
        enabled: true,
        binding: {
          threadId: "11111111-1111-4111-8111-111111111111",
          hostId: "local" as const,
          projectId: "p",
          bindingId: "22222222-2222-4222-8222-222222222222",
          title: "t",
          boundAt: new Date().toISOString(),
        },
        deliveries: [] as never[],
      };
      return {
        state: {
          ...base,
          deliveries: [
            {
              commandId,
              clientId: "c",
              bindingId: "22222222-2222-4222-8222-222222222222",
              messageSha256: "a".repeat(64),
              messageBytes: 1,
              threadId: "11111111-1111-4111-8111-111111111111",
              turnId: "33333333-3333-4333-8333-333333333333",
              deliveryStatus: "accepted" as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        } as never,
        result: null as never,
      };
    });
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: `desktop_${commandId}`,
        iteration: 1,
        changedFiles: ["a.ts"],
        tests: "1 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        commandId,
        desktopReceiptSha256: "b".repeat(64),
        outputAvailable: true,
      } as never);
    });
  }

  beforeEach(() => {
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("e1b2-ws");
    workspace = new Workspace(wsRoot);
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(wsRoot);
  });

  it("authenticated companion recovers own reservationId; no forbidden fields", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seed("cmd-inflight");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const intent = createPairingIntent({ workspaceId: workspace.id, principal: principalA(), stateDir });
    const paired = exchangePairingIntent({
      workspaceId: workspace.id,
      intentId: intent.intentId,
      secret: intent.secret,
      routeCanonical: ROUTE,
      stateDir,
    });
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = reserveNext({
      workspaceId: workspace.id,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint,
      companionId: ctx.companionId,
      stateDir,
    });
    const state = companionPublicState({ workspaceId: workspace.id, ctx, stateDir });
    expect(state.inFlight).toEqual({
      eventId: reserved.event.eventId,
      status: "reserved",
      reservationId: reserved.reservationId,
    });
    const json = JSON.stringify(state);
    expect(json).not.toContain("principalFingerprint");
    expect(json).not.toContain("reservedBy");
    expect(json).not.toContain("credentialHash");
  });
});

describe("owner proof + journal mutation guards (E1b2 review-fix)", () => {
  it("owner proof one-use / expired / wrong document", () => {
    const proof = mintOwnerProof({
      tabId: 1,
      documentId: "d1",
      routeCanonical: ROUTE,
      now: 1000,
      ttlMs: 1000,
    });
    expect(
      consumeOwnerProof(proof, { tabId: 1, documentId: "d1", routeCanonical: ROUTE, now: 1500 }).ok,
    ).toBe(true);
    const used = markProofUsed(proof);
    expect(consumeOwnerProof(used, { tabId: 1, documentId: "d1", routeCanonical: ROUTE, now: 1500 }).reason)
      .toBe("owner_proof_used");
    expect(consumeOwnerProof(proof, { tabId: 1, documentId: "d1", routeCanonical: ROUTE, now: 5000 }).reason)
      .toBe("owner_proof_expired");
    expect(
      consumeOwnerProof(proof, { tabId: 2, documentId: "d1", routeCanonical: ROUTE, now: 1500 }).reason,
    ).toBe("owner_proof_document_mismatch");
  });

  it("active journal blocks transport clear / pair", () => {
    expect(journalBlocksTransportMutation(emptyJournal())).toBe(false);
    expect(journalBlocksTransportMutation(
      markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
    )).toBe(true);
    expect(journalBlocksTransportMutation(
      markReserved(emptyJournal(), {
        eventId: "e".repeat(32),
        reservationId: "r",
        routeCanonical: ROUTE,
        bindingId: "b",
        epoch: 1,
      }),
    )).toBe(true);
    expect(journalBlocksTransportMutation(
      markReservationRecovery(
        markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
        {},
      ),
    )).toBe(true);
    expect(journalBlocksTransportMutation(clearJournal())).toBe(false);
  });

  it("source contains no reserve.next direct payload path and no begin-send", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    expect(sw).not.toMatch(/\/begin-send/);
    expect(sw).not.toMatch(/c2c\.reserve\.next/);
    expect(sw).toMatch(/c2c\.reserve\.page/);
    expect(sw).toMatch(/storageProtected/);
    expect(sw).toMatch(/journal_active/);
  });
});

describe("E1b2 recovery / authStale / storage policy (final closeout)", () => {
  const reserved = markReserved(emptyJournal(), {
    eventId: "e".repeat(32),
    reservationId: "res-1",
    routeCanonical: ROUTE,
    bindingId: "b",
    epoch: 1,
  });

  it("RESERVED + /state no inFlight => clear to NONE", () => {
    const rec = reconcileReservedJournal(reserved, null);
    expect(rec.action).toBe("clear");
    expect(rec.journal.state).toBe("NONE");
  });

  it("RESERVED + same inFlight => keep", () => {
    const rec = reconcileReservedJournal(reserved, {
      status: "reserved",
      eventId: "e".repeat(32),
      reservationId: "res-1",
    });
    expect(rec.action).toBe("keep");
    expect(rec.journal.state).toBe("RESERVED");
  });

  it("RESERVED + different/claimed inFlight => conflict, keep journal", () => {
    const rec = reconcileReservedJournal(reserved, {
      status: "claimed",
      eventId: "e".repeat(32),
      reservationId: "res-1",
      attemptId: "a",
    });
    expect(rec.action).toBe("conflict");
    expect(rec.journal.state).toBe("RESERVED");
  });

  it("authStale + active journal allows explicit re-pair; healthy journal blocks pair", () => {
    const active = markReserveRequested(emptyJournal(), {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expect(pairAllowedWithJournal(active, false)).toBe(false);
    expect(pairAllowedWithJournal(active, true)).toBe(true);
    expect(pairAllowedWithJournal(emptyJournal(), false)).toBe(true);
  });

  it("storage protection failure deletes stored credential (protected-or-absent)", () => {
    const stored = { credential: "secret", authStale: false, workspaceId: "w" };
    const bad = applyStorageProtectionPolicy(false, stored);
    expect(bad.transport).toBeNull();
    expect(bad.mustDeleteStoredKey).toBe(true);
    const ok = applyStorageProtectionPolicy(true, stored);
    expect(ok.transport?.credential).toBe("secret");
    expect(ok.mustDeleteStoredKey).toBe(false);
  });

  it("owner-proof and reserve atomically refresh route before action", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    expect(sw).toMatch(/refreshPageObservation/);
    expect(sw).toMatch(/isOwnerExact/);
    // mint and reserve both refresh first
    expect(sw.indexOf("async function handleMintOwnerProof")).toBeGreaterThan(-1);
    const mintIdx = sw.indexOf("async function handleMintOwnerProof");
    const mintBody = sw.slice(mintIdx, mintIdx + 800);
    expect(mintBody).toMatch(/refreshPageObservation/);
    const reserveIdx = sw.indexOf("async function handleReservePage");
    const reserveBody = sw.slice(reserveIdx, reserveIdx + 900);
    expect(reserveBody).toMatch(/refreshPageObservation/);
  });

  it("popup persists origin local + intent session; never stores secret", () => {
    const popup = fs.readFileSync(
      path.join(projectRoot, "browser-companion", "popup", "popup.js"),
      "utf8",
    );
    expect(popup).toMatch(/chrome\.storage\.local\.set/);
    expect(popup).toMatch(/chrome\.storage\.session\.set/);
    expect(popup).toMatch(/LOCAL_ORIGIN_KEY/);
    expect(popup).toMatch(/SESSION_INTENT_KEY/);
    // Secret must not be written to any storage key.
    expect(popup).not.toMatch(/storage\.(local|session)\.set\(\{[^}]*secret/);
    expect(popup).toMatch(/clearPairingForm/);
    expect(popup).toMatch(/extractPairingFields/);
    expect(popup).toMatch(/finally\s*\{/);
  });

  it("SW implements recover RESERVED + authStale re-pair + storage delete", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    expect(sw).toMatch(/reconcileReservedJournal/);
    expect(sw).toMatch(/pairAllowedWithJournal/);
    expect(sw).toMatch(/applyStorageProtectionPolicy/);
    expect(sw).toMatch(/mustDeleteStoredKey/);
  });
});

describe("extension static safety (E1b2)", () => {
  it("no /begin-send, no beginSend, no SEND_INTENT in extension sources", () => {
    const root = path.join(projectRoot, "browser-companion");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.js$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(text).not.toMatch(/\/begin-send/);
      expect(text).not.toMatch(/\bbeginSend\b/);
      expect(text).not.toMatch(/SEND_INTENT/);
      expect(text).not.toMatch(/\/ack\b/);
    }
  });
});
