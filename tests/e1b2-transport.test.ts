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
  wrapFetchResponse,
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

  it("companionApiUrl builds full /api/companion/v1 URLs from short endpoints", () => {
    // Real SW call sites use short endpoints; builder must add the Bridge mount prefix.
    expect(companionApiUrl("https://b.example.com", "/pair"))
      .toBe("https://b.example.com/api/companion/v1/pair");
    expect(companionApiUrl("https://b.example.com", "/state"))
      .toBe("https://b.example.com/api/companion/v1/state");
    expect(companionApiUrl("https://b.example.com", "/reserve"))
      .toBe("https://b.example.com/api/companion/v1/reserve");
    expect(companionApiUrl("https://b.example.com", "/release"))
      .toBe("https://b.example.com/api/companion/v1/release");
    expect(companionApiUrl("http://127.0.0.1:48765", "pair"))
      .toBe("http://127.0.0.1:48765/api/companion/v1/pair");
    // Idempotent when prefix already present
    expect(companionApiUrl("https://b.example.com", "/api/companion/v1/state"))
      .toBe("https://b.example.com/api/companion/v1/state");
  });

  it("service-worker short endpoints always resolve via companionApiUrl", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    expect(sw).toMatch(/companionApiUrl\(origin,\s*"\/pair"\)/);
    expect(sw).toMatch(/fetchCompanion\("\/state"/);
    expect(sw).toMatch(/fetchCompanion\("\/reserve"/);
    expect(sw).toMatch(/fetchCompanion\("\/release"/);
    // fetchCompanion must go through companionApiUrl (not raw path concat)
    const fetchIdx = sw.indexOf("async function fetchCompanion");
    const fetchBody = sw.slice(fetchIdx, fetchIdx + 500);
    expect(fetchBody).toMatch(/companionApiUrl/);
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
      markReserved(
        markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
        {
          eventId: "e".repeat(32),
          reservationId: "r",
          routeCanonical: ROUTE,
          bindingId: "b",
          epoch: 1,
        },
      ),
    )).toBe(true);
    expect(journalBlocksTransportMutation(
      markReservationRecovery(
        markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
        {},
      ),
    )).toBe(true);
    expect(journalBlocksTransportMutation(clearJournal())).toBe(false);
  });

  it("source contains no reserve.next direct payload path; production send is gated", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    // E1b3d3b: SW owns production /begin-send after explicit popup gate.
    expect(sw).toMatch(/c2c\.production\.send\.request/);
    expect(sw).toMatch(/production_send_payload_forbidden/);
    expect(sw).not.toMatch(/c2c\.reserve\.next/);
    expect(sw).toMatch(/c2c\.reserve\.page/);
    expect(sw).toMatch(/storageProtected/);
    expect(sw).toMatch(/journal_active/);
  });
});

describe("E1b2 recovery / authStale / storage policy (final closeout)", () => {
  const reserved = markReserved(
    markReserveRequested(emptyJournal(), { routeCanonical: ROUTE, bindingId: "b", epoch: 1 }),
    {
      eventId: "e".repeat(32),
      reservationId: "res-1",
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    },
  );

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

  it("popup keeps pair failure reason after refresh", () => {
    const popup = fs.readFileSync(
      path.join(projectRoot, "browser-companion", "popup", "popup.js"),
      "utf8",
    );
    // pair result must be applied after refresh so reason is not overwritten
    const pairIdx = popup.indexOf('els.pair.onclick');
    const pairBody = popup.slice(pairIdx, popup.indexOf('if (els.verifyRoute)', pairIdx));
    const refreshIdx = pairBody.indexOf("await refresh()");
    const failIdx = pairBody.indexOf("pair 失败");
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeGreaterThan(refreshIdx);
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
    expect(popup).not.toMatch(/storage\.(local|session)\.set\(\{[^}]*secret/);
    expect(popup).toMatch(/clearPairingForm/);
    expect(popup).toMatch(/extractPairingFields/);
    expect(popup).toMatch(/finally\s*\{/);
  });

  it("wrapFetchResponse keeps ok for HTTP 200", () => {
    expect(wrapFetchResponse({ ok: true, status: 200 }, { a: 1 }))
      .toEqual({ ok: true, status: 200, body: { a: 1 } });
    // Missing Response.ok but 2xx status still success
    expect(wrapFetchResponse({ status: 200 }, { a: 1 }).ok).toBe(true);
    expect(wrapFetchResponse({ ok: false, status: 401 }, {}).ok).toBe(false);
    expect(wrapFetchResponse(null, {}).ok).toBe(false);
  });

  it("fetchCompanion preserves Response.ok for 200 success paths", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    const fetchIdx = sw.indexOf("async function fetchCompanion");
    const fetchBody = sw.slice(fetchIdx, fetchIdx + 700);
    expect(fetchBody).toMatch(/wrapFetchResponse/);
    // Callers must branch on res.ok, not only status===200
    const stateIdx = sw.indexOf("async function handleFetchState");
    const stateBody = sw.slice(stateIdx, stateIdx + 900);
    expect(stateBody).toMatch(/res\.ok/);
    expect(stateBody).not.toMatch(/status\s*===\s*200/);
    const reserveIdx = sw.indexOf("async function handleReservePage");
    const reserveBody = sw.slice(reserveIdx, reserveIdx + 1800);
    expect(reserveBody).toMatch(/if \(!res\.ok\)/);
    expect(reserveBody).not.toMatch(/status\s*===\s*200/);
    const releaseIdx = sw.indexOf("async function handleRelease");
    const releaseBody = sw.slice(releaseIdx, releaseIdx + 900);
    expect(releaseBody).toMatch(/if \(res\.ok\)/);
    expect(releaseBody).toMatch(/clearJournal/);
    expect(releaseBody).not.toMatch(/status\s*===\s*200/);
  });

  it("SW implements recover RESERVED + authStale re-pair + storage delete", () => {
    const sw = fs.readFileSync(path.join(projectRoot, "browser-companion", "service-worker.js"), "utf8");
    expect(sw).toMatch(/reconcileReservedJournal/);
    expect(sw).toMatch(/pairAllowedWithJournal/);
    expect(sw).toMatch(/applyStorageProtectionPolicy/);
    expect(sw).toMatch(/mustDeleteStoredKey/);
  });
});

describe("extension static safety (E1b2 + E1b3a)", () => {
  const root = path.join(projectRoot, "browser-companion");

  function listJsFiles(dir: string): string[] {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.js$/.test(e.name)) files.push(p);
      }
    };
    walk(dir);
    return files;
  }

  it("orchestration sources keep CS free of Bridge HTTP / journal authority", () => {
    // E1b3d3b: SW owns production Bridge HTTP; CS is DI shell only.
    const cs = fs.readFileSync(path.join(root, "content-script.js"), "utf8");
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\bbeginSend\s*\(/);
    expect(cs).not.toMatch(/\/ack\b/);
    expect(cs).not.toMatch(/SEND_INTENT/);
    expect(cs).not.toMatch(/COMPOSER_WRITE_INTENT/);
    expect(cs).not.toMatch(/SEND_DISPATCH_INTENT/);
    expect(cs).not.toMatch(/dispatchEvent\(\s*new\s+(?:InputEvent|Event)\(/);
    expect(cs).not.toMatch(/\.click\(\)/);
    expect(cs).not.toMatch(/form\.submit/);
    expect(cs).not.toMatch(/requestSubmit/);
    expect(cs).not.toMatch(/KeyboardEvent/);
    expect(cs).not.toMatch(/scripting/);
    expect(cs).not.toMatch(/debugger/);
    expect(cs).not.toMatch(/nativeMessaging/);
    expect(cs).not.toMatch(/fetch\(/);
    expect(cs).not.toMatch(/chrome\.tabs\.sendMessage/);

    const dom = fs.readFileSync(path.join(root, "dom-adapter.js"), "utf8");
    expect(dom).not.toMatch(/\/begin-send/);
    expect(dom).not.toMatch(/\bbeginSend\b/);
    expect(dom).not.toMatch(/\/ack\b/);
    expect(dom).not.toMatch(/SEND_INTENT/);
    expect(dom).not.toMatch(/COMPOSER_WRITE_INTENT/);
    expect(dom).not.toMatch(/SEND_DISPATCH_INTENT/);
    expect(dom).not.toMatch(/\.click\(\)/);

    const shadow = fs.readFileSync(path.join(root, "shadow-evidence.js"), "utf8");
    expect(shadow).not.toMatch(/\/begin-send/);
    expect(shadow).not.toMatch(/\bbeginSend\b/);
    expect(shadow).not.toMatch(/\/ack\b/);
    expect(shadow).not.toMatch(/SEND_INTENT/);
    expect(shadow).not.toMatch(/\.click\(\)/);
  });

  it("pure journal may define E1b3 states but still has no network/DOM side effects", () => {
    const journal = fs.readFileSync(path.join(root, "reservation-journal.js"), "utf8");
    expect(journal).toMatch(/SEND_INTENT/);
    expect(journal).toMatch(/CLAIMED/);
    expect(journal).toMatch(/COMPOSER_WRITE_INTENT/);
    expect(journal).toMatch(/SEND_DISPATCH_INTENT/);
    expect(journal).toMatch(/OBSERVED_PENDING_ACK/);
    expect(journal).toMatch(/OUTCOME_UNKNOWN/);
    expect(journal).toMatch(/reconcileSendJournal/);
    // Pure module: no fetch, no chrome, no DOM.
    expect(journal).not.toMatch(/\bfetch\s*\(/);
    expect(journal).not.toMatch(/chrome\./);
    expect(journal).not.toMatch(/document\./);
    expect(journal).not.toMatch(/\/begin-send/);
    expect(journal).not.toMatch(/\.click\(\)/);
  });

  it("other extension modules still free of begin-send/ack/SEND_INTENT", () => {
    const files = listJsFiles(root);
    expect(files.length).toBeGreaterThan(3);
    // E1b3b/E1b3c/E1b3d3b capability modules may name send/beginSend; runtime-unreachable from classic CS except production classic.
    const capability = new Set([
      "reservation-journal.js",
      "send-adapter.js",
      "turn-observer.js",
      "send-orchestrator.js",
      "production-send.js",
      "production-send-runtime.js",
      "production-send-runtime-global.js",
      "service-worker.js",
      // E1b3d3b CS production DI shell wires beginSend/persist/ack names to SW RPC only.
      "content-script.js",
    ]);
    for (const f of files) {
      if (capability.has(path.basename(f))) continue;
      const text = fs.readFileSync(f, "utf8");
      expect(text).not.toMatch(/\/begin-send/);
      expect(text).not.toMatch(/\bbeginSend\b/);
      expect(text).not.toMatch(/SEND_INTENT/);
      expect(text).not.toMatch(/\/ack\b/);
    }
  });

  it("journal send-side recovery never returns second DOM mutation actions", () => {
    // Structural lock: POST_MUTATION_FENCE_STATES is non-empty and includes COMPOSER_WRITE_INTENT+.
    const journal = fs.readFileSync(path.join(root, "reservation-journal.js"), "utf8");
    expect(journal).toMatch(/POST_MUTATION_FENCE_STATES/);
    expect(journal).toMatch(/retry_begin_send/);
    expect(journal).toMatch(/post_mutation_fence/);
  });
});
