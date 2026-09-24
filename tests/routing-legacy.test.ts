import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { RoutingError } from "../src/routing/schema.js";
import { projectLegacyRoutes, type LegacyRouteCandidate } from "../src/routing/legacy-adapter.js";
import { ensureCurrentPlannerRoute, resolveCurrentPlannerRoute } from "../src/routing/current-planner-route.js";
import { ensureCurrentExecutorRoute, resolveCurrentExecutorRoute } from "../src/routing/current-executor-route.js";
import { createCurrentCommand } from "../src/routing/current-command.js";
import { deliverCurrentCommand } from "../src/routing/current-command-transport.js";
import * as desktopService from "../src/desktop/service.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { readDesktop, updateDesktop, type DesktopDelivery } from "../src/desktop/store.js";
import { listCommands, listRoutes, readRouting, registerRoute, routingFile, transitionCommandDelivery, type RoutingWorkspaceIdentity } from "../src/routing/store.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000101";
const THREAD_ID_2 = "01a00000-0000-7000-8000-000000000102";
const BINDING_ID = randomUUID();
const BINDING_ID_2 = randomUUID();
const COMPANION_ID = randomUUID();
const CHALLENGE_ID = randomUUID();
const CONVERSATION_ID = "018c0000-0000-7000-8000-00000000c2c1";
const CONVERSATION_ID_2 = "018c0000-0000-7000-8000-00000000c2c2";
const ROUTE_CANONICAL = `https://chatgpt.com/c/${CONVERSATION_ID}`;
const HEX32 = "a".repeat(32);
const HEX64 = "b".repeat(64);
const CURRENT_PAYLOAD = "交付当前 route：中文 + ✅";

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
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeLegacyStates(options: {
  attestation?: { status: "pending" | "verified"; verifiedAt?: string };
  routeCanonical?: string;
  desktopThreadId?: string;
  desktopProjectId?: string;
  desktopEnabled?: boolean;
  desktopBindingPresent?: boolean;
  desktopBindingId?: string;
  desktopDeliveries?: DesktopDelivery[];
} = {}) {
  const routeCanonical = options.routeCanonical ?? ROUTE_CANONICAL;
  const desktopDir = path.join(stateDir, "desktop-control");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(
    path.join(desktopDir, `${identity.id}.json`),
    JSON.stringify({
      version: 1,
      workspaceId: identity.id,
      workspaceRoot: identity.root,
      enabled: options.desktopEnabled ?? true,
      binding: options.desktopBindingPresent === false ? null : {
        threadId: options.desktopThreadId ?? THREAD_ID,
        hostId: "local",
        projectId: options.desktopProjectId ?? "proj_alpha",
        bindingId: options.desktopBindingId ?? BINDING_ID,
        title: "test binding",
        boundAt: new Date().toISOString(),
      },
      deliveries: options.desktopDeliveries ?? [],
    }),
  );
  const feedbackDir = path.join(stateDir, "feedback");
  fs.mkdirSync(feedbackDir, { recursive: true });
  const attestation = options.attestation
    ? {
        status: options.attestation.status,
        challengeId: CHALLENGE_ID,
        challengeDigest: HEX64,
        routeCanonical,
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
        routeCanonical,
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

function desktopResult(
  request: Parameters<typeof desktopService.sendDesktop>[1],
  deliveryStatus: "accepted" | "rejected" | "outcome_unknown",
): Awaited<ReturnType<typeof desktopService.sendDesktop>> {
  const now = new Date().toISOString();
  return {
    commandId: request.commandId,
    bindingId: request.bindingId,
    threadId: THREAD_ID,
    turnId: deliveryStatus === "accepted" ? randomUUID() : undefined,
    deliveryStatus,
    createdAt: now,
    updatedAt: now,
    intent: request.intent,
    error: deliveryStatus === "rejected" ? "DESKTOP_BUSY" : undefined,
    message: deliveryStatus === "accepted" ? "accepted" : deliveryStatus,
  };
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

  it("verified candidate 显式 ensure 注册，read-only resolution 返回精确 route", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    expect(resolveCurrentPlannerRoute(identity)).toBeNull();
    expect(fs.existsSync(routingFile(identity.id))).toBe(false);
    const registered = ensureCurrentPlannerRoute(identity);
    expect(registered).toMatchObject({
      role: "planner",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: {},
    });
    expect(resolveCurrentPlannerRoute(identity)).toEqual(registered);
    expect(readRouting(identity)?.revision).toBe(1);
  });

  it("exact ensure replay 不 bump revision 或重写 routing state 文件", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const first = ensureCurrentPlannerRoute(identity);
    const file = routingFile(identity.id);
    const before = fs.statSync(file, { bigint: true });
    const bytes = fs.readFileSync(file);
    expect(ensureCurrentPlannerRoute(identity)).toEqual(first);
    const after = fs.statSync(file, { bigint: true });
    expect(readRouting(identity)?.revision).toBe(1);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("当前 Desktop binding 显式 ensure/只读解析精确 route，且不写 Desktop state", () => {
    writeLegacyStates({ desktopEnabled: false });
    const desktopFile = path.join(stateDir, "desktop-control", `${identity.id}.json`);
    const before = fs.readFileSync(desktopFile);
    expect(resolveCurrentExecutorRoute(identity)).toBeNull();
    const registered = ensureCurrentExecutorRoute(identity);
    expect(registered).toMatchObject({
      role: "executor",
      platform: "codex_desktop",
      conversationId: THREAD_ID,
      locator: { hostId: "local", executorProjectId: "proj_alpha" },
    });
    const routeFile = routingFile(identity.id);
    const beforeReplay = fs.statSync(routeFile, { bigint: true });
    const routeBytes = fs.readFileSync(routeFile);
    expect(ensureCurrentExecutorRoute(identity)).toEqual(registered);
    const afterReplay = fs.statSync(routeFile, { bigint: true });
    expect(resolveCurrentExecutorRoute(identity)).toEqual(registered);
    expect(readRouting(identity)?.revision).toBe(1);
    expect(fs.readFileSync(routeFile)).toEqual(routeBytes);
    expect(afterReplay.ino).toBe(beforeReplay.ino);
    expect(afterReplay.mtimeNs).toBe(beforeReplay.mtimeNs);
    expect(fs.readFileSync(desktopFile)).toEqual(before);
  });

  it("Desktop binding 切换后旧 route 不再是 current", () => {
    writeLegacyStates();
    const oldRoute = ensureCurrentExecutorRoute(identity);
    writeLegacyStates({ desktopThreadId: THREAD_ID_2, desktopProjectId: "proj_beta" });
    expect(resolveCurrentExecutorRoute(identity)).toBeNull();
    const current = ensureCurrentExecutorRoute(identity);
    expect(current).toMatchObject({
      role: "executor",
      conversationId: THREAD_ID_2,
      locator: { hostId: "local", executorProjectId: "proj_beta" },
    });
    expect(current?.routeId).not.toBe(oldRoute?.routeId);
    expect(listRoutes(identity)).toHaveLength(2);
  });

  it("ensure 期间 Desktop binding 切换时 fail closed，旧 candidate 只保留为历史 route", () => {
    writeLegacyStates();
    const initializedMarker = `${routingFile(identity.id)}.initialized`;
    const existsSync = fs.existsSync.bind(fs);
    let switched = false;
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((file) => {
      if (!switched && typeof file === "string" && file === initializedMarker) {
        switched = true;
        writeLegacyStates({ desktopThreadId: THREAD_ID_2, desktopProjectId: "proj_beta" });
      }
      return existsSync(file);
    });

    try {
      expect(() => ensureCurrentExecutorRoute(identity)).toThrowError(
        expect.objectContaining({ code: "ROUTE_AUTHORITY_CHANGED" }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(switched).toBe(true);
    expect(listRoutes(identity)).toMatchObject([
      { role: "executor", platform: "codex_desktop", conversationId: THREAD_ID },
    ]);
    expect(resolveCurrentExecutorRoute(identity)).toBeNull();
  });

  it("current planner + executor 生成 pending Command，UTF-8 bytes/hash 正确且不写 legacy state", () => {
    writeLegacyStates({
      attestation: { status: "verified", verifiedAt: new Date().toISOString() },
      desktopEnabled: false,
    });
    const desktopFile = path.join(stateDir, "desktop-control", `${identity.id}.json`);
    const feedbackFile = path.join(stateDir, "feedback", `${identity.id}.json`);
    const desktopBefore = fs.readFileSync(desktopFile);
    const feedbackBefore = fs.readFileSync(feedbackFile);
    const payload = "修复当前路由：确认 ✅";

    const command = createCurrentCommand(identity, {
      commandId: "r3c-current-utf8",
      intent: "development_plan",
      payload,
    });
    const routes = listRoutes(identity);

    expect(command).toMatchObject({
      plannerRouteId: routes.find((route) => route.role === "planner")?.routeId,
      executorRouteId: routes.find((route) => route.role === "executor")?.routeId,
      intent: "development_plan",
      payloadBytes: Buffer.byteLength(payload, "utf8"),
      payloadSha256: createHash("sha256").update(payload, "utf8").digest("hex"),
      deliveryStatus: "pending",
    });
    expect(fs.readFileSync(desktopFile)).toEqual(desktopBefore);
    expect(fs.readFileSync(feedbackFile)).toEqual(feedbackBefore);
  });

  it("current Command exact replay 不 bump revision 或重写 routing state 文件", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const input = { commandId: "r3c-current-replay", intent: "revision" as const, payload: "same payload" };
    const first = createCurrentCommand(identity, input);
    const file = routingFile(identity.id);
    const before = fs.statSync(file, { bigint: true });
    const bytes = fs.readFileSync(file);

    expect(createCurrentCommand(identity, input)).toEqual(first);

    const after = fs.statSync(file, { bigint: true });
    expect(readRouting(identity)?.revision).toBe(3);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("current Command 缺 planner authority 时不猜历史 route", () => {
    writeLegacyStates();
    registerRoute(identity, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: {},
    });

    expect(() => createCurrentCommand(identity, {
      commandId: "r3c-no-planner",
      intent: "development_plan",
      payload: "payload",
    })).toThrowError(expect.objectContaining({ code: "ROUTING_ROUTE_NOT_FOUND" }));
    expect(listCommands(identity)).toHaveLength(0);
  });

  it("current Command 缺 executor binding 时不猜历史 route", () => {
    writeLegacyStates({
      attestation: { status: "verified", verifiedAt: new Date().toISOString() },
      desktopEnabled: false,
      desktopBindingPresent: false,
    });
    registerRoute(identity, {
      role: "executor",
      platform: "codex_desktop",
      conversationId: THREAD_ID,
      locator: { hostId: "local", executorProjectId: "proj_alpha" },
    });

    expect(() => createCurrentCommand(identity, {
      commandId: "r3c-no-executor",
      intent: "development_plan",
      payload: "payload",
    })).toThrowError(expect.objectContaining({ code: "ROUTING_ROUTE_NOT_FOUND" }));
    expect(listCommands(identity)).toHaveLength(0);
    expect(listRoutes(identity).some((route) => route.role === "planner")).toBe(true);
  });

  it("current Command 同 commandId 的 payload 或 intent 不同由 store 拒绝", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const input = { commandId: "r3c-current-conflict", intent: "development_plan" as const, payload: "original" };
    const first = createCurrentCommand(identity, input);

    expect(() => createCurrentCommand(identity, { ...input, payload: "changed" })).toThrowError(
      expect.objectContaining({ code: "COMMAND_CONFLICT" }),
    );
    expect(() => createCurrentCommand(identity, { ...input, intent: "revision" })).toThrowError(
      expect.objectContaining({ code: "COMMAND_CONFLICT" }),
    );
    expect(listCommands(identity)).toEqual([first]);
  });

  it("没有 verified Companion 时历史 planner route 不会变成 current", () => {
    registerRoute(identity, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: {},
    });
    writeLegacyStates();
    expect(resolveCurrentPlannerRoute(identity)).toBeNull();
    expect(ensureCurrentPlannerRoute(identity)).toBeNull();
    expect(listRoutes(identity)).toHaveLength(1);
  });

  it("Companion 切换 conversation 后旧 registered route 不再是 current", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const oldRoute = ensureCurrentPlannerRoute(identity);
    writeLegacyStates({
      attestation: { status: "verified", verifiedAt: new Date().toISOString() },
      routeCanonical: `https://chatgpt.com/c/${CONVERSATION_ID_2}`,
    });
    expect(resolveCurrentPlannerRoute(identity)).toBeNull();
    const current = ensureCurrentPlannerRoute(identity);
    expect(current?.conversationId).toBe(CONVERSATION_ID_2);
    expect(current?.routeId).not.toBe(oldRoute?.routeId);
    expect(resolveCurrentPlannerRoute(identity)).toEqual(current);
  });

  it("ensure 期间 authority 切换时 fail closed，旧 candidate 只保留为历史 route", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const initializedMarker = `${routingFile(identity.id)}.initialized`;
    const existsSync = fs.existsSync.bind(fs);
    let switched = false;
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((file) => {
      if (!switched && typeof file === "string" && file === initializedMarker) {
        switched = true;
        writeLegacyStates({
          attestation: { status: "verified", verifiedAt: new Date().toISOString() },
          routeCanonical: `https://chatgpt.com/c/${CONVERSATION_ID_2}`,
        });
      }
      return existsSync(file);
    });

    try {
      expect(() => ensureCurrentPlannerRoute(identity)).toThrowError(
        expect.objectContaining({ code: "ROUTE_AUTHORITY_CHANGED" }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(switched).toBe(true);
    expect(listRoutes(identity)).toMatchObject([
      { role: "planner", platform: "chatgpt_web", conversationId: CONVERSATION_ID },
    ]);
    expect(resolveCurrentPlannerRoute(identity)).toBeNull();
  });

  it("同一 route identity 的 role 冲突 fail closed", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    registerRoute(identity, {
      role: "executor",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: {},
    });
    expect(() => resolveCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTE_ROLE_CONFLICT" }),
    );
    expect(() => ensureCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTE_ROLE_CONFLICT" }),
    );
  });

  it("同一 route identity 的 locator 冲突 fail closed", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    registerRoute(identity, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: CONVERSATION_ID,
      locator: { gptId: "g-previous" },
    });
    expect(() => resolveCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTE_LOCATOR_CONFLICT" }),
    );
    expect(() => ensureCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTE_LOCATOR_CONFLICT" }),
    );
  });

  it("workspace mismatch 与损坏 routing state 均 fail closed", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const mismatched = { id: "000000000000", root: workspaceRoot };
    expect(() => resolveCurrentPlannerRoute(mismatched)).toThrowError(
      expect.objectContaining({ code: "ROUTING_WORKSPACE_IDENTITY_MISMATCH" }),
    );
    expect(() => ensureCurrentPlannerRoute(mismatched)).toThrowError(
      expect.objectContaining({ code: "ROUTING_WORKSPACE_IDENTITY_MISMATCH" }),
    );

    const file = routingFile(identity.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ broken");
    fs.writeFileSync(`${file}.initialized`, "1\n");
    expect(() => resolveCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTING_STATE_CORRUPT" }),
    );
    expect(() => ensureCurrentPlannerRoute(identity)).toThrowError(
      expect.objectContaining({ code: "ROUTING_STATE_CORRUPT" }),
    );
  });

  it("current planner helper 从不写 feedback state", () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const feedbackFile = path.join(stateDir, "feedback", `${identity.id}.json`);
    const before = fs.readFileSync(feedbackFile);
    const first = ensureCurrentPlannerRoute(identity);
    expect(resolveCurrentPlannerRoute(identity)).toEqual(first);
    expect(fs.readFileSync(feedbackFile)).toEqual(before);
  });

  it("Desktop accepted/rejected/outcome_unknown 都同步到既有 routing Command", async () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const cases = ["accepted", "rejected", "outcome_unknown"] as const;
    const sender = vi.spyOn(desktopService, "sendDesktop");
    for (const deliveryStatus of cases) {
      const commandId = `r3d-${deliveryStatus}`;
      sender.mockImplementation(async (_workspace, request) => desktopResult(request, deliveryStatus));
      const result = await deliverCurrentCommand(identity, {
        commandId,
        intent: "development_plan",
        payload: CURRENT_PAYLOAD,
        userConfirmed: true,
      }, "test-client", () => {});

      expect(result.command.deliveryStatus).toBe(deliveryStatus);
      expect(result.delivery?.deliveryStatus).toBe(deliveryStatus);
    }
    expect(listCommands(identity).map((command) => command.deliveryStatus)).toEqual(cases);
  });

  it("Desktop sender 收到与 Command digest/bytes 完全相同的原始 payload", async () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const desktopFile = path.join(stateDir, "desktop-control", `${identity.id}.json`);
    const before = fs.readFileSync(desktopFile);
    const authorize = vi.fn();
    const sender = vi.spyOn(desktopService, "sendDesktop")
      .mockImplementation(async (_workspace, request) => desktopResult(request, "accepted"));
    const result = await deliverCurrentCommand(identity, {
      commandId: "r3d-payload-integrity",
      intent: "revision",
      payload: CURRENT_PAYLOAD,
      userConfirmed: true,
    }, "test-client", authorize);

    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][1]).toMatchObject({
      workspaceId: identity.id,
      bindingId: BINDING_ID,
      commandId: "r3d-payload-integrity",
      intent: "revision",
      userConfirmed: true,
      message: CURRENT_PAYLOAD,
    });
    expect(sender.mock.calls[0][3]).toBe(authorize);
    expect(result.command).toMatchObject({
      payloadBytes: Buffer.byteLength(CURRENT_PAYLOAD, "utf8"),
      payloadSha256: createHash("sha256").update(CURRENT_PAYLOAD, "utf8").digest("hex"),
      deliveryStatus: "accepted",
    });
    expect(fs.readFileSync(desktopFile)).toEqual(before);
  });

  it("current route 切换后 terminal replay 仍只返回旧 Command，payload/intent 冲突仍拒绝", async () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const input = {
      commandId: "r3d-exact-replay",
      intent: "development_plan" as const,
      payload: CURRENT_PAYLOAD,
      userConfirmed: true as const,
    };
    const sender = vi.spyOn(desktopService, "sendDesktop")
      .mockImplementation(async (_workspace, request) => desktopResult(request, "accepted"));
    const first = await deliverCurrentCommand(identity, input, "test-client", () => {});
    const file = routingFile(identity.id);
    const before = fs.readFileSync(file);
    const beforeStat = fs.statSync(file, { bigint: true });

    writeLegacyStates({
      attestation: { status: "verified", verifiedAt: new Date().toISOString() },
      routeCanonical: `https://chatgpt.com/c/${CONVERSATION_ID_2}`,
      desktopThreadId: THREAD_ID_2,
      desktopProjectId: "proj_beta",
      desktopBindingId: BINDING_ID_2,
    });
    const replay = await deliverCurrentCommand(identity, input, "test-client", () => {});
    const transitionReplay = transitionCommandDelivery(identity, {
      commandId: input.commandId,
      deliveryStatus: "accepted",
    });

    expect(sender).toHaveBeenCalledOnce();
    expect(replay).toEqual({ command: first.command, delivery: null });
    await expect(deliverCurrentCommand(identity, {
      ...input,
      payload: `${CURRENT_PAYLOAD}!`,
    }, "test-client", () => {})).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    await expect(deliverCurrentCommand(identity, {
      ...input,
      intent: "revision",
    }, "test-client", () => {})).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    expect(transitionReplay).toEqual(first.command);
    expect(() => transitionCommandDelivery(identity, {
      commandId: input.commandId,
      deliveryStatus: "rejected",
    })).toThrowError(expect.objectContaining({ code: "ROUTING_COMMAND_DELIVERY_CONFLICT" }));
    expect(() => transitionCommandDelivery(identity, {
      commandId: "r3d-missing-command",
      deliveryStatus: "accepted",
    })).toThrowError(expect.objectContaining({ code: "ROUTING_COMMAND_NOT_FOUND" }));
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(beforeStat.mtimeNs);
  });

  it("Desktop durable result 后 routing sync 失败，重复 commandId 只收敛不二次发送", async () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const routeFile = routingFile(identity.id);
    let pendingState: Buffer | undefined;
    const close = vi.fn();
    const physicalSend = vi.fn(async () => {
      pendingState = fs.readFileSync(routeFile);
      fs.writeFileSync(routeFile, "{ corrupt routing state");
      return { threadId: THREAD_ID, turnId: randomUUID() };
    });
    const prepare = vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send: physicalSend, close } as never);
    const input = {
      commandId: "r3d-sync-recovery",
      intent: "development_plan" as const,
      payload: CURRENT_PAYLOAD,
      userConfirmed: true as const,
    };

    await expect(deliverCurrentCommand(identity, input, "test-client", () => {}))
      .rejects.toMatchObject({ code: "ROUTING_STATE_CORRUPT" });
    expect(physicalSend).toHaveBeenCalledOnce();
    expect(readDesktop(identity.id)?.deliveries).toMatchObject([
      { commandId: input.commandId, deliveryStatus: "accepted" },
    ]);
    expect(pendingState).toBeDefined();
    fs.writeFileSync(routeFile, pendingState!);

    const durableDeliveries = readDesktop(identity.id)!.deliveries;
    writeLegacyStates({
      attestation: { status: "verified", verifiedAt: new Date().toISOString() },
      routeCanonical: `https://chatgpt.com/c/${CONVERSATION_ID_2}`,
      desktopThreadId: THREAD_ID_2,
      desktopProjectId: "proj_beta",
      desktopBindingId: BINDING_ID_2,
      desktopDeliveries: durableDeliveries,
    });
    const replay = await deliverCurrentCommand(identity, input, "test-client", () => {});
    expect(prepare).toHaveBeenCalledOnce();
    expect(physicalSend).toHaveBeenCalledOnce();
    expect(replay.command.deliveryStatus).toBe("accepted");
    expect(replay.delivery?.deliveryStatus).toBe("accepted");
    expect(readDesktop(identity.id)?.deliveries).toMatchObject([
      { commandId: input.commandId, deliveryStatus: "accepted" },
    ]);
  });

  it.each([
    ["clientId", (record: DesktopDelivery) => ({ ...record, clientId: "different-client" })],
    ["intent", (record: DesktopDelivery) => ({ ...record, intent: "revision" as const })],
    ["messageSha256", (record: DesktopDelivery) => ({ ...record, messageSha256: "c".repeat(64) })],
    ["messageBytes", (record: DesktopDelivery) => ({ ...record, messageBytes: record.messageBytes + 1 })],
    ["threadId", (record: DesktopDelivery) => ({ ...record, threadId: THREAD_ID_2 })],
  ])("Desktop durable %s 不匹配时拒绝同步且不发送", async (_field, alter) => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const input = {
      commandId: `r3d-ledger-${String(_field)}`,
      intent: "development_plan" as const,
      payload: CURRENT_PAYLOAD,
      userConfirmed: true as const,
    };
    const command = createCurrentCommand(identity, input);
    const timestamp = new Date().toISOString();
    const record: DesktopDelivery = {
      commandId: input.commandId,
      clientId: "test-client",
      bindingId: BINDING_ID,
      intent: input.intent,
      messageSha256: command.payloadSha256,
      messageBytes: command.payloadBytes,
      threadId: THREAD_ID,
      turnId: randomUUID(),
      deliveryStatus: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    updateDesktop(identity.id, (previous) => {
      if (!previous) throw new Error("expected Desktop state");
      return { state: { ...previous, deliveries: [...previous.deliveries, alter(record)] }, result: undefined };
    });
    const sender = vi.spyOn(desktopService, "sendDesktop");

    await expect(deliverCurrentCommand(identity, input, "test-client", () => {}))
      .rejects.toMatchObject({ code: "ROUTING_DESKTOP_DELIVERY_MISMATCH" });
    expect(sender).not.toHaveBeenCalled();
    expect(listCommands(identity)).toMatchObject([{ commandId: input.commandId, deliveryStatus: "pending" }]);
  });

  it("pending Command 落盘后、transport 调用前 authority 改变时拒绝投递", async () => {
    writeLegacyStates({ attestation: { status: "verified", verifiedAt: new Date().toISOString() } });
    const input = {
      commandId: "r3d-authority-change",
      intent: "development_plan" as const,
      payload: CURRENT_PAYLOAD,
      userConfirmed: true as const,
    };
    const file = routingFile(identity.id);
    const rename = fs.renameSync.bind(fs);
    let switched = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      if (switched || typeof destination !== "string" || destination !== file) return;
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
        commands?: Array<{ commandId: string }>;
      };
      if (state.commands?.some((command) => command.commandId === input.commandId)) {
        switched = true;
        writeLegacyStates({
          attestation: { status: "verified", verifiedAt: new Date().toISOString() },
          routeCanonical: `https://chatgpt.com/c/${CONVERSATION_ID_2}`,
          desktopThreadId: THREAD_ID_2,
          desktopProjectId: "proj_beta",
        });
      }
    });
    const sender = vi.spyOn(desktopService, "sendDesktop");

    await expect(deliverCurrentCommand(identity, input, "test-client", () => {}))
      .rejects.toMatchObject({ code: "ROUTE_AUTHORITY_CHANGED" });
    expect(switched).toBe(true);
    expect(sender).not.toHaveBeenCalled();
    expect(listCommands(identity)).toMatchObject([{ commandId: input.commandId, deliveryStatus: "pending" }]);
  });
});
