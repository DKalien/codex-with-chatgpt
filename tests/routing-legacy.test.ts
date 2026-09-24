import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { RoutingError } from "../src/routing/schema.js";
import { projectLegacyRoutes, type LegacyRouteCandidate } from "../src/routing/legacy-adapter.js";
import type { RoutingWorkspaceIdentity } from "../src/routing/store.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000101";
const BINDING_ID = randomUUID();
const COMPANION_ID = randomUUID();
const CHALLENGE_ID = randomUUID();
const CONVERSATION_ID = "018c0000-0000-7000-8000-00000000c2c1";
const ROUTE_CANONICAL = `https://chatgpt.com/c/${CONVERSATION_ID}`;
const HEX32 = "a".repeat(32);
const HEX64 = "b".repeat(64);

let stateDir: string;
let workspaceRoot: string;
let identity: RoutingWorkspaceIdentity;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-routing-legacy-"));
  process.env.C2C_STATE_DIR = stateDir;
  // workspace identity 派生校验要求 root 真实存在；用真实临时目录 + 生产同款派生。
  workspaceRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-legacy-root-")));
  identity = { id: new Workspace(workspaceRoot).id, root: workspaceRoot };
});

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeLegacyStates(options: { attestation?: { status: "pending" | "verified"; verifiedAt?: string } } = {}) {
  const desktopDir = path.join(stateDir, "desktop-control");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(
    path.join(desktopDir, `${identity.id}.json`),
    JSON.stringify({
      version: 1,
      workspaceId: identity.id,
      workspaceRoot: identity.root,
      enabled: true,
      binding: {
        threadId: THREAD_ID,
        hostId: "local",
        projectId: "proj_alpha",
        bindingId: BINDING_ID,
        title: "test binding",
        boundAt: new Date().toISOString(),
      },
      deliveries: [],
    }),
  );
  const feedbackDir = path.join(stateDir, "feedback");
  fs.mkdirSync(feedbackDir, { recursive: true });
  const attestation = options.attestation
    ? {
        status: options.attestation.status,
        challengeId: CHALLENGE_ID,
        challengeDigest: HEX64,
        routeCanonical: ROUTE_CANONICAL,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(options.attestation.verifiedAt ? { verifiedAt: options.attestation.verifiedAt } : {}),
      }
    : undefined;
  fs.writeFileSync(
    path.join(feedbackDir, `${identity.id}.json`),
    JSON.stringify({
      version: 1,
      workspaceId: identity.id,
      projectionCursor: 0,
      binding: null,
      events: [],
      pairingIntent: null,
      companion: {
        version: 1,
        companionId: COMPANION_ID,
        bindingId: BINDING_ID,
        epoch: 0,
        principalFingerprint: HEX32,
        credentialHash: HEX64,
        routeCanonical: ROUTE_CANONICAL,
        pairedAt: new Date().toISOString(),
        ...(attestation ? { routeAttestation: attestation } : {}),
      },
      rebindIntent: null,
      rebindPredecessor: null,
    }),
  );
}

function snapshotDir(): string {
  const files: Array<{ file: string; content: string; mtimeMs: number }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ file: full, content: fs.readFileSync(full, "utf8"), mtimeMs: fs.statSync(full).mtimeMs });
    }
  };
  walk(stateDir);
  return JSON.stringify(files);
}

describe("routing legacy projection", () => {
  it("8/16. 只读且确定：多次调用不产生随机 identity、不写任何旧/新 state", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const before = snapshotDir();
    const first = projectLegacyRoutes(identity);
    const second = projectLegacyRoutes(identity);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.executorCandidate?.legacyReferenceId).toBe(BINDING_ID);
    expect(first.plannerCandidate?.legacyReferenceId).toBe(BINDING_ID);
    expect(snapshotDir()).toBe(before);
    expect(fs.existsSync(path.join(stateDir, "routing"))).toBe(false);
  });

  it("desktop binding 投影 executor candidate：threadId/hostId/projectId/bindingId", () => {
    writeLegacyStates();
    const { executorCandidate } = projectLegacyRoutes(identity);
    expect(executorCandidate).toEqual({
      kind: "executor",
      platform: "codex_desktop",
      conversationId: THREAD_ID,
      locator: { hostId: "local", executorProjectId: "proj_alpha" },
      legacyReferenceId: BINDING_ID,
    });
  });

  it("14. unverified legacy Companion 不生成 planner candidate", () => {
    // 无 attestation。
    writeLegacyStates();
    expect(projectLegacyRoutes(identity).plannerCandidate).toBeNull();
    // pending attestation。
    writeLegacyStates({ attestation: { status: "pending" } });
    expect(projectLegacyRoutes(identity).plannerCandidate).toBeNull();
  });

  it("15. verified route 才投影 planner candidate", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const candidate: LegacyRouteCandidate | null = projectLegacyRoutes(identity).plannerCandidate;
    expect(candidate).toEqual({
      kind: "planner",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: {},
      legacyReferenceId: BINDING_ID,
      routeCanonical: ROUTE_CANONICAL,
    });
  });

  it("legacy state 缺失/损坏/root 不匹配 → candidate 为 none（fail closed）", () => {
    const verified = { attestation: { status: "verified" as const, verifiedAt: new Date().toISOString() } };
    // 完全没有旧 state。
    expect(projectLegacyRoutes(identity)).toEqual({ executorCandidate: null, plannerCandidate: null });
    // desktop 损坏：executor 为 none，verified feedback 不受影响。
    writeLegacyStates(verified);
    fs.writeFileSync(path.join(stateDir, "desktop-control", `${identity.id}.json`), "{ broken");
    const projection = projectLegacyRoutes(identity);
    expect(projection.executorCandidate).toBeNull();
    expect(projection.plannerCandidate).not.toBeNull();
    // 持久化 workspaceRoot 与调用方不符：executor candidate 为 none。
    writeLegacyStates(verified);
    const desktop = JSON.parse(fs.readFileSync(path.join(stateDir, "desktop-control", `${identity.id}.json`), "utf8")) as Record<string, unknown>;
    desktop.workspaceRoot = "D:\\somewhere-else";
    fs.writeFileSync(path.join(stateDir, "desktop-control", `${identity.id}.json`), JSON.stringify(desktop));
    expect(projectLegacyRoutes(identity).executorCandidate).toBeNull();
  });

  it("伪造 workspace id/root → 入口直接拒绝，不读任何旧 state", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const before = snapshotDir();
    // id 与 root 派生值不符。
    expect(() => projectLegacyRoutes({ id: "000000000000", root: workspaceRoot })).toThrow(RoutingError);
    try {
      projectLegacyRoutes({ id: "000000000000", root: workspaceRoot });
    } catch (error) {
      expect((error as RoutingError).code).toBe("ROUTING_WORKSPACE_IDENTITY_MISMATCH");
    }
    // root 不存在，无法派生 canonical workspace。
    expect(() =>
      projectLegacyRoutes({ id: identity.id, root: path.resolve(os.tmpdir(), "c2c-nonexistent-legacy-root") }),
    ).toThrow(RoutingError);
    // 未读旧 state、未写任何文件。
    expect(snapshotDir()).toBe(before);
  });
});
