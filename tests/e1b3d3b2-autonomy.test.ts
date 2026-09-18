import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTONOMY_PRODUCTION_COOLDOWN_MS,
  AUTONOMY_STORAGE_KEY,
  emptyAutonomyPolicy,
  parseAutonomyPolicy,
  policyIdentityExact,
  disarmOnIdentityChange,
  withProductionAttemptStamp,
  evaluateAutonomyGates,
  planAutonomyTick,
  autonomySummary,
  isTransportUsable,
  isExactOwnerHeartbeat,
  buildHeartbeatSafetySnapshot,
  buildEvaluatedEvidenceSnapshot,
  sanitizeHeartbeatSafetySnapshot,
  sanitizeEvaluatedEvidenceSnapshot,
  sanitizeRecoveryDiagnostic,
  sanitizeRecoveryResult,
} from "../browser-companion/autonomy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const BINDING = "b".repeat(36);
/** Real SW internal transport — no presentation-only `connected`. */
const TRANSPORT = {
  authStale: false,
  bindingId: BINDING,
  epoch: 1,
  routeCanonical: ROUTE,
  workspaceId: "2582910bf0d2",
  companionId: "c".repeat(36),
  credential: "secret-not-in-autonomy-payload",
};

function armedPolicy(overrides = {}) {
  return {
    ...emptyAutonomyPolicy(),
    mode: "armed",
    bindingId: BINDING,
    epoch: 1,
    routeCanonical: ROUTE,
    armedAt: Date.now(),
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    policy: armedPolicy(),
    storageProtected: true,
    transport: TRANSPORT,
    owner: { tabId: 7, documentId: "doc-1", canonicalRoute: ROUTE },
    evidence: {
      tabId: 7,
      documentId: "doc-1",
      canonicalRoute: ROUTE,
      observedAt: Date.now(),
      composer: "empty",
      generation: "idle",
      safe: true,
    },
    journal: { state: "NONE" },
    sendProbeLatch: "NONE",
    productionSendInFlight: false,
    autonomyTickInFlight: false,
    inFlight: null,
    pendingReady: 1,
    now: Date.now(),
    ...overrides,
  };
}

describe("E1b3d3b2 autonomy policy", () => {
  it("A. default / hydrate parse → OFF", () => {
    expect(emptyAutonomyPolicy().mode).toBe("off");
    expect(parseAutonomyPolicy(undefined).mode).toBe("off");
    expect(parseAutonomyPolicy(null).mode).toBe("off");
    expect(parseAutonomyPolicy({ mode: "nope" }).mode).toBe("off");
  });

  it("A2. parse keeps valid mode and identity fields", () => {
    const p = parseAutonomyPolicy({
      mode: "armed",
      bindingId: BINDING,
      epoch: 1,
      routeCanonical: ROUTE,
      armedAt: 1,
      lastProductionAttemptAt: 2,
    });
    expect(p.mode).toBe("armed");
    expect(p.lastProductionAttemptAt).toBe(2);
  });

  it("B. shadow ready>0 → would_reserve_and_send with zero mutations planned", () => {
    const policy = { ...armedPolicy(), mode: "shadow" };
    const plan = planAutonomyTick(baseState({ policy }));
    expect(plan.decision).toBe("would_reserve_and_send");
    expect(plan.mode).toBe("shadow");
  });

  it("A-real. real internal transport without connected field works", () => {
    expect(TRANSPORT.connected).toBeUndefined();
    expect(isTransportUsable(TRANSPORT)).toBe(true);
    expect(isTransportUsable({ ...TRANSPORT, authStale: true })).toBe(false);
    expect(isTransportUsable({ bindingId: BINDING, epoch: 1, routeCanonical: ROUTE })).toBe(true);
    const plan = planAutonomyTick(baseState());
    expect(plan.decision).toBe("would_reserve_and_send");
    const gates = evaluateAutonomyGates({
      mode: "armed",
      policy: armedPolicy(),
      storageProtected: true,
      transport: { bindingId: BINDING, epoch: 1, routeCanonical: ROUTE },
      owner: baseState().owner,
      evidence: baseState().evidence,
      journal: { state: "NONE" },
      sendProbeLatch: "NONE",
      productionSendInFlight: false,
      now: Date.now(),
    });
    expect(gates.ok).toBe(true);
  });

  it("B-foreign. foreign heartbeat does not satisfy exact owner gate", () => {
    const owner = baseState().owner;
    expect(isExactOwnerHeartbeat({
      identityOk: true,
      tabId: owner.tabId,
      documentId: owner.documentId,
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    })).toBe(true);
    expect(isExactOwnerHeartbeat({
      identityOk: true,
      tabId: 99,
      documentId: owner.documentId,
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    })).toBe(false);
    expect(isExactOwnerHeartbeat({
      identityOk: true,
      tabId: owner.tabId,
      documentId: "other-doc",
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    })).toBe(false);
    expect(isExactOwnerHeartbeat({
      identityOk: false,
      tabId: owner.tabId,
      documentId: owner.documentId,
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    })).toBe(false);
  });

  it("C. armed ready>0 → would_reserve_and_send", () => {
    const plan = planAutonomyTick(baseState());
    expect(plan.decision).toBe("would_reserve_and_send");
    expect(plan.mode).toBe("armed");
  });

  it("D. tick already in flight → gate_failed", () => {
    const plan = planAutonomyTick(baseState({ autonomyTickInFlight: true }));
    expect(plan.decision).toBe("gate_failed");
    expect(plan.reason).toBe("tick_in_flight");
  });

  it("E. 30s cooldown blocks second event", () => {
    const now = Date.now();
    const evidence = { ...baseState().evidence, observedAt: now };
    const plan = planAutonomyTick(
      baseState({
        now,
        evidence,
        policy: armedPolicy({ lastProductionAttemptAt: now - 1000 }),
      }),
    );
    expect(plan.decision).toBe("cooldown");
  });

  it("F. cooldown survives parse/hydrate (durable field)", () => {
    const stamp = withProductionAttemptStamp(emptyAutonomyPolicy(), 12345);
    const hydrated = parseAutonomyPolicy(JSON.parse(JSON.stringify(stamp)));
    expect(hydrated.lastProductionAttemptAt).toBe(12345);
    const now = 12345 + 1000;
    const evidence = {
      tabId: 7,
      documentId: "doc-1",
      canonicalRoute: ROUTE,
      observedAt: now,
      composer: "empty",
      generation: "idle",
      safe: true,
    };
    const ready = planAutonomyTick(
      baseState({
        now,
        evidence,
        policy: { ...hydrated, mode: "armed", bindingId: BINDING, epoch: 1, routeCanonical: ROUTE },
      }),
    );
    expect(ready.decision).toBe("cooldown");
    const after = planAutonomyTick(
      baseState({
        now: 12345 + AUTONOMY_PRODUCTION_COOLDOWN_MS + 1,
        evidence: { ...evidence, observedAt: 12345 + AUTONOMY_PRODUCTION_COOLDOWN_MS + 1 },
        policy: { ...hydrated, mode: "armed", bindingId: BINDING, epoch: 1, routeCanonical: ROUTE },
      }),
    );
    expect(after.decision).toBe("would_reserve_and_send");
  });

  it("G. wrong route/binding/epoch → gate_failed", () => {
    for (const patch of [
      { transport: { ...TRANSPORT, bindingId: "x" } },
      { transport: { ...TRANSPORT, epoch: 9 } },
      { transport: { ...TRANSPORT, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" } },
    ]) {
      const plan = planAutonomyTick(baseState(patch));
      expect(plan.decision).toBe("gate_failed");
      expect(plan.reason).toBe("policy_identity_mismatch");
    }
  });

  it("H. owner/generation drift → zero mutation (gate)", () => {
    expect(evaluateAutonomyGates({
      mode: "armed",
      policy: armedPolicy(),
      storageProtected: true,
      transport: TRANSPORT,
      owner: { tabId: 7, documentId: "other", canonicalRoute: ROUTE },
      evidence: baseState().evidence,
      journal: { state: "NONE" },
      sendProbeLatch: "NONE",
      productionSendInFlight: false,
      now: Date.now(),
    }).ok).toBe(false);
  });

  it("I. stale / non-empty / generating evidence → fail closed", () => {
    const base = baseState();
    for (const evidence of [
      { ...base.evidence, safe: false },
      { ...base.evidence, composer: "dirty" },
      { ...base.evidence, generation: "generating" },
      { ...base.evidence, observedAt: Date.now() - 60_000 },
    ]) {
      const plan = planAutonomyTick(baseState({ evidence }));
      expect(plan.decision).toBe("gate_failed");
    }
  });

  it("J. OUTCOME_UNKNOWN → recovering, no new reserve", () => {
    const plan = planAutonomyTick(baseState({ journal: { state: "OUTCOME_UNKNOWN" }, pendingReady: 3 }));
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("OUTCOME_UNKNOWN");
  });

  it("K. OBSERVED_PENDING_ACK → recovering only", () => {
    const plan = planAutonomyTick(baseState({ journal: { state: "OBSERVED_PENDING_ACK" } }));
    expect(plan.decision).toBe("recovering");
  });

  it("L. recovered-to-NONE is a distinct path (same tick no next reserve is SW contract)", () => {
    // Planner returns recovering; SW stops after clear.
    const plan = planAutonomyTick(baseState({ journal: { state: "CLAIMED" } }));
    expect(plan.decision).toBe("recovering");
  });

  it("M. local NONE + server inFlight → server_inflight_without_local_journal", () => {
    const plan = planAutonomyTick(baseState({
      inFlight: { status: "claimed", eventId: "e".repeat(32) },
    }));
    expect(plan.decision).toBe("server_inflight_without_local_journal");
  });

  it("N. identity change disarms armed policy", () => {
    const armed = armedPolicy();
    const same = disarmOnIdentityChange(armed, TRANSPORT);
    expect(same.changed).toBe(false);
    const other = disarmOnIdentityChange(armed, { ...TRANSPORT, epoch: 2 });
    expect(other.changed).toBe(true);
    expect(other.policy.mode).toBe("off");
    const noTransport = disarmOnIdentityChange(armed, null);
    expect(noTransport.policy.mode).toBe("off");
  });

  it("O. disable does not touch journal (policy only)", () => {
    // Policy helper never receives journal mutation.
    const off = emptyAutonomyPolicy();
    expect(off.mode).toBe("off");
    expect(policyIdentityExact(off, TRANSPORT)).toBe(true);
  });

  it("E. exact RESERVED after restart → plan recovering (SW continues send, no second reserve)", () => {
    const plan = planAutonomyTick(baseState({
      journal: {
        state: "RESERVED",
        eventId: "e".repeat(32),
        reservationId: "11111111-1111-4111-8111-111111111111",
      },
      pendingReady: 5,
      policy: armedPolicy({ lastProductionAttemptAt: Date.now() - 100 }),
    }));
    // Cooldown must NOT block RESERVED continuation.
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("RESERVED");
  });

  it("F. RESERVED + shadow mode → recovering only (SW keeps, zero send)", () => {
    const plan = planAutonomyTick(baseState({
      policy: { ...armedPolicy(), mode: "shadow" },
      journal: { state: "RESERVED", eventId: "e".repeat(32), reservationId: "r" },
    }));
    expect(plan.decision).toBe("recovering");
    expect(plan.mode).toBe("shadow");
  });

  it("G/H. RESERVED recovery outcomes are SW contracts after handleRecover", () => {
    // Pure planner always returns recovering for RESERVED; SW maps:
    // server missing → clear NONE + stop; mismatch → block.
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tickEnd = sw.indexOf("async function handleProductionSend", tickStart);
    const tick = sw.slice(tickStart, tickEnd);
    expect(tick).toMatch(/journalBefore === "RESERVED" \|\| after === "RESERVED"/);
    expect(tick).toMatch(/shadow_keep_reserved/);
    expect(tick).toMatch(/No second reserve/);
    expect(tick).toMatch(/canStartProductionSend/);
    expect(tick).toMatch(/Same tick must NOT reserve next event/);
  });

  it("C/D durable commit first: arm and stamp never mutate memory before persist", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/async function commitAutonomyPolicy/);
    expect(sw).toMatch(/Memory authority changes only after persist success/);
    const commitStart = sw.indexOf("async function commitAutonomyPolicy");
    const commitBlock = sw.slice(commitStart, commitStart + 600);
    expect(commitBlock).toMatch(/autonomy_persist_failed/);
    expect(commitBlock).toMatch(/previous/);
    // Arm uses commit, not direct assign-then-persist.
    const armIdx = sw.indexOf('const proposed = {\n      schemaVersion: 1,\n      mode,');
    expect(armIdx).toBeGreaterThan(0);
    expect(sw.slice(armIdx, armIdx + 500)).toMatch(/await commitAutonomyPolicy\(proposed\)/);
    // Stamp uses commit before reserve.
    const stampIdx = sw.indexOf("const stamped = withProductionAttemptStamp");
    expect(stampIdx).toBeGreaterThan(0);
    const stampBlock = sw.slice(stampIdx, stampIdx + 450);
    expect(stampBlock).toMatch(/await commitAutonomyPolicy\(stamped\)/);
    expect(stampBlock).toMatch(/zero reserve/);
  });

  it("summary is diagnostic-only safe fields", () => {
    const s = autonomySummary(armedPolicy({ lastProductionAttemptAt: 99 }), {
      identityExact: true,
      lastDecision: "cooldown",
      lastReason: "production_cooldown",
    });
    expect(s.mode).toBe("armed");
    expect(JSON.stringify(s)).not.toContain("credential");
    expect(JSON.stringify(s)).not.toContain("message");
    expect(s.lastProductionAttemptAt).toBe(99);
  });
});

describe("E1b3d3b2 SW / popup static contract", () => {
  it("P. popup cannot inject payload identity", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.autonomy\.enable\.shadow/);
    expect(sw).toMatch(/c2c\.autonomy\.arm/);
    expect(sw).toMatch(/c2c\.autonomy\.disable/);
    expect(sw).toMatch(/autonomy_payload_forbidden/);
    const start = sw.indexOf("c2c.autonomy.enable.shadow");
    const block = sw.slice(start, start + 2200);
    expect(block).toMatch(/message\.message != null/);
    expect(block).toMatch(/message\.eventId != null/);
    expect(block).toMatch(/message\.bindingId != null/);
    expect(block).toMatch(/popup_sender_required/);
    expect(block).toMatch(/bindingId: transport\.bindingId/);
    expect(block).toMatch(/routeCanonical: transport\.routeCanonical/);
    expect(block).toMatch(/commitAutonomyPolicy/);
  });

  it("heartbeat-only scheduler + exact owner gate + no auto retire in tick", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tickEnd = sw.indexOf("async function handleProductionSend", tickStart);
    const tick = sw.slice(tickStart, tickEnd);
    expect(tick).toMatch(/planAutonomyTick/);
    expect(tick).toMatch(/withProductionAttemptStamp/);
    expect(tick).toMatch(/Same tick must NOT reserve next event/);
    expect(tick).not.toMatch(/handleRetireUnknown/);
    expect(tick).not.toMatch(/c2c\.retire/);
    expect(sw).toMatch(/isExactOwnerHeartbeat/);
    expect(sw).toMatch(/not_exact_owner_heartbeat/);
    expect(sw).toMatch(/void maybeRunAutonomyTick\(\{\s*sender,\s*message,/);
  });

  it("Q. source autonomy.js exists and SW imports it; build keeps ESM", () => {
    const autonomy = fs.readFileSync(path.join(companionRoot, "autonomy.js"), "utf8");
    expect(autonomy).toMatch(/AUTONOMY_STORAGE_KEY = "c2c_companion_autonomy_v1"/);
    expect(autonomy).toMatch(/AUTONOMY_PRODUCTION_COOLDOWN_MS = 30_000/);
    expect(autonomy).toMatch(/export function planAutonomyTick/);
    expect(autonomy).not.toMatch(/chrome\./);
    expect(autonomy).not.toMatch(/fetch\(/);
    // Strip comments before secret-bearing token scan.
    expect(autonomy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .not.toMatch(/credential/);
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/from "\.\/autonomy\.js"/);
    const build = fs.readFileSync(
      path.join(projectRoot, "scripts", "build-browser-companion.mjs"),
      "utf8",
    );
    expect(build).toMatch(/"autonomy\.js"/);
    const dist = path.join(projectRoot, "dist", "browser-companion", "autonomy.js");
    if (fs.existsSync(dist)) {
      expect(fs.readFileSync(dist, "utf8")).toMatch(/export function planAutonomyTick/);
    }
  });

  it("popup has explicit arm confirm and no payload injection", () => {
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/autonomy-arm-confirm/);
    expect(html).toMatch(/automatically send production feedback/);
    expect(html).toMatch(/Enable Shadow/);
    expect(html).toMatch(/Arm Production/);
    expect(html).toMatch(/Disable Autonomy/);
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/c2c\.autonomy\.enable\.shadow/);
    expect(js).toMatch(/c2c\.autonomy\.arm/);
    expect(js).toMatch(/c2c\.autonomy\.disable/);
    expect(js).toMatch(/autonomyArmConfirm/);
    expect(js).not.toMatch(/c2c\.autonomy\.arm[^}]*message:/);
  });
});

describe("E1b3d3b2 Arm checkbox enable UX", () => {
  const popupJs = () => fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");

  it("checkbox change re-enables Arm when gates met; uncheck disables immediately", () => {
    const js = popupJs();
    expect(js).toMatch(/autonomyArmConfirm\.addEventListener\("change", updateAutonomyArmEnabled\)/);
    expect(js).toMatch(/function updateAutonomyArmEnabled/);
    // Change path must not send arm RPC.
    const changeIdx = js.indexOf('autonomyArmConfirm.addEventListener("change"');
    const changeBlock = js.slice(changeIdx, changeIdx + 200);
    expect(changeBlock).not.toMatch(/c2c\.autonomy\.arm/);
    expect(changeBlock).not.toMatch(/sendMessage/);
    // Gates still required together.
    const fnIdx = js.indexOf("function updateAutonomyArmEnabled");
    const fnBlock = js.slice(fnIdx, fnIdx + 450);
    expect(fnBlock).toMatch(/hasTransport/);
    expect(fnBlock).toMatch(/isOwner/);
    expect(fnBlock).toMatch(/storageProtected/);
    expect(fnBlock).toMatch(/autonomyArmConfirm\?\.checked === true/);
  });

  it("listener bound once outside refresh; refresh only updates gates", () => {
    const js = popupJs();
    const addCount = (js.match(/autonomyArmConfirm\.addEventListener/g) || []).length;
    expect(addCount).toBe(1);
    // Not inside refresh by checking addEventListener position vs refresh.
    const addIdx = js.indexOf('autonomyArmConfirm.addEventListener');
    const refreshIdx = js.indexOf("async function refresh");
    if (refreshIdx >= 0) {
      expect(addIdx).toBeLessThan(refreshIdx);
    }
    expect(js).toMatch(/lastAutonomyArmGates = \{ hasTransport, isOwner, storageProtected \}/);
    expect(js).toMatch(/updateAutonomyArmEnabled\(\)/);
  });

  it("SW arm gate unchanged — change never arms", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.autonomy\.arm/);
    expect(sw).toMatch(/commitAutonomyPolicy/);
    // Popup still only sends arm on button click with checked confirm.
    const js = popupJs();
    const armClick = js.indexOf("els.autonomyArm.onclick");
    expect(armClick).toBeGreaterThan(0);
    const clickBlock = js.slice(armClick, armClick + 350);
    expect(clickBlock).toMatch(/autonomyArmConfirm\?\.checked/);
    expect(clickBlock).toMatch(/c2c\.autonomy\.arm/);
  });
});

describe("E1b3d3b2 shadow evidence diagnostics", () => {
  it("A. dirty heartbeat safety is bounded", () => {
    const snap = buildHeartbeatSafetySnapshot({
      composer: "dirty",
      generation: "generating",
      safe: false,
      routeValid: true,
      adapterSupported: true,
      reasons: ["composer_dirty", "raw DOM text should not appear"],
    });
    expect(snap.composer).toBe("dirty");
    expect(snap.generation).toBe("generating");
    expect(snap.safe).toBe(false);
    expect(snap.routeValid).toBe(true);
    expect(snap.adapterSupported).toBe(true);
    expect(Object.keys(snap).sort()).toEqual([
      "adapterSupported",
      "composer",
      "generation",
      "routeValid",
      "safe",
    ]);
  });

  it("B. safe heartbeat safety is bounded", () => {
    const snap = buildHeartbeatSafetySnapshot({
      composer: "empty",
      generation: "idle",
      safe: true,
      routeValid: true,
      adapterSupported: true,
    });
    expect(snap).toEqual({
      composer: "empty",
      generation: "idle",
      safe: true,
      routeValid: true,
      adapterSupported: true,
    });
  });

  it("C. foreign heartbeat records ownerExact=false and does not schedule", () => {
    const owner = baseState().owner;
    const ownerExact = isExactOwnerHeartbeat({
      identityOk: true,
      tabId: 99,
      documentId: owner.documentId,
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    });
    expect(ownerExact).toBe(false);
    // SW still records diagnostic then skips tick — static contract.
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/lastHeartbeatOwnerExact = ownerExact === true/);
    expect(sw).toMatch(/if \(ownerExact\) \{/);
    expect(sw).toMatch(/lastHeartbeatSafety = buildHeartbeatSafetySnapshot/);
  });

  it("D. evaluated evidence snapshot has safe/composer/generation/age + exact flags", () => {
    const now = 1_700_000_000_000;
    const snap = buildEvaluatedEvidenceSnapshot({
      evidence: {
        composer: "empty",
        generation: "idle",
        safe: true,
        observedAt: now - 123,
        documentId: "doc-1",
        canonicalRoute: ROUTE,
      },
      now,
      documentExact: true,
      routeExact: false,
    });
    expect(snap.composer).toBe("empty");
    expect(snap.generation).toBe("idle");
    expect(snap.safe).toBe(true);
    expect(snap.ageMs).toBe(123);
    expect(snap.documentExact).toBe(true);
    expect(snap.routeExact).toBe(false);
    expect(snap.observedAt).toBe(now - 123);
  });

  it("E. diagnostics never include message/raw text/reasons/credential/principal/documentId/tabId", () => {
    const hb = buildHeartbeatSafetySnapshot({
      composer: "empty",
      generation: "idle",
      safe: true,
      routeValid: true,
      adapterSupported: true,
      reasons: ["secret reason"],
    });
    const ev = buildEvaluatedEvidenceSnapshot({
      evidence: {
        composer: "empty",
        generation: "idle",
        safe: true,
        observedAt: 1,
        documentId: "doc-should-not-appear",
        tabId: 42,
      },
      now: 2,
      documentExact: true,
      routeExact: true,
    });
    const dump = JSON.stringify({ hb, ev });
    expect(dump).not.toContain("secret");
    expect(dump).not.toContain("doc-should-not-appear");
    expect(dump).not.toContain("credential");
    expect(dump).not.toContain("principal");
    expect(dump).not.toContain("documentId");
    expect(dump).not.toContain("tabId");
    expect(dump).not.toContain("reasons");
    const summary = autonomySummary(emptyAutonomyPolicy(), {
      lastHeartbeatAt: 10,
      lastHeartbeatOwnerExact: false,
      lastHeartbeatSafety: { ...hb, message: "raw", credential: "x", documentId: "d" },
      lastEvaluatedEvidence: { ...ev, message: "raw", reasons: ["x"] },
    });
    const sd = JSON.stringify(summary);
    expect(sd).not.toContain("raw");
    expect(sd).not.toContain('"credential"');
    expect(sd).not.toContain("reasons");
  });

  it("F. popup renders heartbeat/evaluated evidence fields", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/heartbeatAt=\$\{/);
    expect(js).toMatch(/heartbeatOwnerExact=\$\{/);
    expect(js).toMatch(/heartbeatSafety=\$\{/);
    expect(js).toMatch(/evaluatedEvidence=\$\{/);
    expect(js).toMatch(/ageMs=/);
  });

  it("G/H. diagnostics are side-channel only — SHADOW/ARMED decision paths unchanged", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tickEnd = sw.indexOf("async function handleProductionSend", tickStart);
    const tick = sw.slice(tickStart, tickEnd);
    expect(tick).toMatch(/lastEvaluatedEvidence = buildEvaluatedEvidenceSnapshot/);
    // Snapshot is recorded before planAutonomyTick, not used as gate.
    const snapIdx = tick.indexOf("lastEvaluatedEvidence = buildEvaluatedEvidenceSnapshot");
    const planIdx = tick.indexOf("const plan = planAutonomyTick");
    expect(snapIdx).toBeGreaterThan(0);
    expect(planIdx).toBeGreaterThan(snapIdx);
    // Zero mutation semantics unchanged.
    expect(tick).toMatch(/plan\.mode === "shadow"/);
    expect(tick).toMatch(/withProductionAttemptStamp/);
    expect(tick).not.toMatch(/handleRetireUnknown/);
    const status = sw.slice(sw.indexOf("function statusPayload"), sw.indexOf("async function fetchCompanion"));
    expect(status).toMatch(/lastHeartbeatAt/);
    expect(status).toMatch(/lastEvaluatedEvidence/);
  });

  it("sanitize helpers reject non-objects", () => {
    expect(sanitizeHeartbeatSafetySnapshot(null)).toBeNull();
    expect(sanitizeEvaluatedEvidenceSnapshot(null)).toBeNull();
    expect(buildHeartbeatSafetySnapshot(undefined).safe).toBe(false);
    expect(buildEvaluatedEvidenceSnapshot({}).ageMs).toBeNull();
  });
});

describe("E1b3d3b2 autonomous recovery diagnostic", () => {
  it("A/B. allowlist shows observation counts and strips secrets", () => {
    const diag = sanitizeRecoveryDiagnostic({
      candidateCount: 3,
      exactTextMatchCount: 0,
      exactAttemptMarkerCount: 1,
      ambiguousCount: 0,
      targetLength: 120,
      candidateLengths: [10, 20, 30],
      firstMismatchIndex: 0,
      candidates: [{ directRole: "user", nestedUser: false, text: "RAW MESSAGE" }],
      message: "RAW MESSAGE",
      credential: "secret",
      documentId: "doc-1",
      reasons: ["composer_dirty"],
    });
    expect(diag).toBeTruthy();
    expect(diag?.candidateCount).toBe(3);
    expect(diag?.exactTextMatchCount).toBe(0);
    expect(diag?.exactAttemptMarkerCount).toBe(1);
    expect(diag?.candidates?.[0]).toEqual({ directRole: "user", nestedUser: false });
    const dump = JSON.stringify(diag);
    expect(dump).not.toContain("RAW MESSAGE");
    expect(dump).not.toContain("secret");
    expect(dump).not.toContain("doc-1");
    expect(dump).not.toContain("reasons");
  });

  it("C. null diagnostic is safe", () => {
    expect(sanitizeRecoveryDiagnostic(null)).toBeNull();
    expect(sanitizeRecoveryResult(null)).toBeNull();
    const r = sanitizeRecoveryResult({
      ok: false,
      reason: "outcome_unknown",
      action: "block",
      retryAck: false,
      journalState: "OUTCOME_UNKNOWN",
      diagnostic: null,
    });
    expect(r?.diagnostic).toBeNull();
    expect(r?.ok).toBe(false);
    expect(r?.reason).toBe("outcome_unknown");
  });

  it("D-F. recording does not change recover decision; zero mutation paths intact", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tickEnd = sw.indexOf("async function handleProductionSend", tickStart);
    const tick = sw.slice(tickStart, tickEnd);
    const recIdx = tick.indexOf("const rec = await handleRecover()");
    const recordIdx = tick.indexOf("lastRecoveryResult = sanitizeRecoveryResult");
    expect(recIdx).toBeGreaterThan(0);
    expect(recordIdx).toBeGreaterThan(recIdx);
    // Record immediately after recover, before branching decisions.
    expect(recordIdx).toBeLessThan(tick.indexOf('if (journalBefore === "RESERVED"'));
    expect(tick).toMatch(/Never changes recover\/ACK\/journal semantics/);
    expect(tick).not.toMatch(/handleRetireUnknown/);
    expect(tick).toMatch(/withProductionAttemptStamp/);
    const status = sw.slice(sw.indexOf("function statusPayload"), sw.indexOf("async function fetchCompanion"));
    expect(status).toMatch(/lastRecoveryAt/);
    expect(status).toMatch(/lastRecoveryResult/);
  });

  it("G. popup shows bounded recovery diagnostic", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/recoveryAt=\$\{/);
    expect(js).toMatch(/recovery=\$\{/);
    expect(js).toMatch(/recoveryDiagnostic=\$\{/);
    expect(js).toMatch(/lastRecoveryResult/);
  });

  it("H. dist companion ships autonomy recovery diagnostic helpers", () => {
    const dist = path.join(projectRoot, "dist", "browser-companion", "autonomy.js");
    if (fs.existsSync(dist)) {
      expect(fs.readFileSync(dist, "utf8")).toMatch(/sanitizeRecoveryResult/);
    }
    const distPopup = path.join(projectRoot, "dist", "browser-companion", "popup", "popup.js");
    if (fs.existsSync(distPopup)) {
      expect(fs.readFileSync(distPopup, "utf8")).toMatch(/recoveryDiagnostic=/);
    }
  });
});
