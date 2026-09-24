import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  RoutingError,
  commandInputSchema,
  routingStateSchema,
} from "../src/routing/schema.js";
import {
  appendResult,
  createCommand,
  listCommands,
  listResults,
  listRoutes,
  readRouting,
  registerRoute,
  routingFile,
  type RoutingWorkspaceIdentity,
} from "../src/routing/store.js";

const HEX64 = "b".repeat(64);
const PLANNER_THREAD = "018c0000-0000-7000-8000-00000000c2c1";
const EXECUTOR_THREAD_1 = "01a00000-0000-7000-8000-000000000101";
const EXECUTOR_THREAD_2 = "01a00000-0000-7000-8000-000000000102";

let stateDir: string;
let rootA: string;
let rootB: string;
let identityA: RoutingWorkspaceIdentity;
let identityB: RoutingWorkspaceIdentity;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-routing-"));
  process.env.C2C_STATE_DIR = stateDir;
  // workspace identity 派生校验要求 root 真实存在；用真实临时目录 + 生产同款派生。
  rootA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-routing-root-a-")));
  rootB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-routing-root-b-")));
  identityA = { id: new Workspace(rootA).id, root: rootA };
  identityB = { id: new Workspace(rootB).id, root: rootB };
});

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

function plannerRegistration() {
  return {
    role: "planner" as const,
    platform: "chatgpt_web" as const,
    conversationId: PLANNER_THREAD,
    locator: {},
  };
}

function executorRegistration(threadId: string, projectId = "proj_alpha") {
  return {
    role: "executor" as const,
    platform: "codex_desktop" as const,
    conversationId: threadId,
    locator: { hostId: "local" as const, executorProjectId: projectId },
  };
}

function commandInput(plannerRouteId: string, executorRouteId: string, commandId = "cmd-001") {
  return {
    commandId,
    plannerRouteId,
    executorRouteId,
    intent: "development_plan" as const,
    payloadBytes: 42,
    payloadSha256: HEX64,
  };
}

function setupRoutes() {
  const planner = registerRoute(identityA, plannerRegistration());
  const executor = registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1));
  return { planner, executor };
}

/** 执行并返回 RoutingError.code；未抛错或抛错类型不符时失败。 */
function routingErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RoutingError) return error.code;
    throw error;
  }
  throw new Error("expected RoutingError but none was thrown");
}

function stateSnapshot(identity: RoutingWorkspaceIdentity) {
  const file = routingFile(identity.id);
  return {
    content: fs.readFileSync(file, "utf8"),
    mtimeMs: fs.statSync(file).mtimeMs,
    revision: (JSON.parse(fs.readFileSync(file, "utf8")) as { revision: number }).revision,
  };
}

describe("routing route identity", () => {
  it("1/9. route identity 唯一：exact 重复注册幂等返回既有 route", () => {
    const first = registerRoute(identityA, plannerRegistration());
    const second = registerRoute(identityA, plannerRegistration());
    expect(second).toEqual(first);
    expect(listRoutes(identityA)).toHaveLength(1);
  });

  it("2. 同 conversationId 不同 platform 不冲突", () => {
    // UUID 字符串同时满足两个平台的 conversationId 校验。
    const planner = registerRoute(identityA, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: EXECUTOR_THREAD_1,
      locator: {},
    });
    const executor = registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1));
    expect(planner.routeId).not.toBe(executor.routeId);
    expect(listRoutes(identityA)).toHaveLength(2);
  });

  it("3. 同 Project 多 route：多个 executor route 挂同一 executorProjectId", () => {
    registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1, "proj_alpha"));
    registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_2, "proj_alpha"));
    const routes = listRoutes(identityA);
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((route) => route.routeId)).size).toBe(2);
    for (const route of routes) {
      expect(route.locator).toEqual({ hostId: "local", executorProjectId: "proj_alpha" });
    }
  });

  it("4. 跨 workspace 不串线：状态互不可见、引用不可解析", () => {
    const { planner, executor } = setupRoutes();
    // 同 registration 在另一 workspace 注册得到独立 routeId。
    const mirror = registerRoute(identityB, plannerRegistration());
    expect(mirror.routeId).not.toBe(planner.routeId);
    expect(listRoutes(identityB)).toHaveLength(1);
    // B 的 command 引用 A 的 routeId → 拒绝。
    expect(
      routingErrorCode(() =>
        createCommand(identityB, commandInput(planner.routeId, executor.routeId, "cmd-cross")),
      ),
    ).toBe("ROUTING_ROUTE_NOT_FOUND");
    expect(listCommands(identityB)).toHaveLength(0);
  });

  it("10. 相同 identity 不同 role → ROUTE_ROLE_CONFLICT", () => {
    registerRoute(identityA, plannerRegistration());
    expect(
      routingErrorCode(() =>
        registerRoute(identityA, { ...plannerRegistration(), role: "executor" }),
      ),
    ).toBe("ROUTE_ROLE_CONFLICT");
  });

  it("11. locator 漂移 → ROUTE_LOCATOR_CONFLICT", () => {
    registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1, "proj_alpha"));
    expect(
      routingErrorCode(() =>
        registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1, "proj_beta")),
      ),
    ).toBe("ROUTE_LOCATOR_CONFLICT");
    registerRoute(identityA, plannerRegistration());
    expect(
      routingErrorCode(() =>
        registerRoute(identityA, { ...plannerRegistration(), locator: { gptId: "g-test" } }),
      ),
    ).toBe("ROUTE_LOCATOR_CONFLICT");
  });

  it("codex_desktop UUID 大小写不形成两个 identity（canonical lowercase）", () => {
    const first = registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1.toUpperCase()));
    expect(first.conversationId).toBe(EXECUTOR_THREAD_1);
    const second = registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1));
    expect(second.routeId).toBe(first.routeId);
    expect(listRoutes(identityA)).toHaveLength(1);
  });
});

describe("routing command", () => {
  it("5. commandId 幂等：完全相同字段重放返回旧记录", () => {
    const { planner, executor } = setupRoutes();
    const input = commandInput(planner.routeId, executor.routeId);
    const first = createCommand(identityA, input);
    const replay = createCommand(identityA, input);
    expect(replay).toEqual(first);
    expect(listCommands(identityA)).toHaveLength(1);
  });

  it("12. commandId 相同但 payload/routes 不同 → COMMAND_CONFLICT", () => {
    const { planner, executor } = setupRoutes();
    const input = commandInput(planner.routeId, executor.routeId);
    createCommand(identityA, input);
    expect(
      routingErrorCode(() => createCommand(identityA, { ...input, payloadSha256: "c".repeat(64) })),
    ).toBe("COMMAND_CONFLICT");
    expect(
      routingErrorCode(() => createCommand(identityA, { ...input, payloadBytes: 43 })),
    ).toBe("COMMAND_CONFLICT");
    expect(
      routingErrorCode(() =>
        createCommand(identityA, { ...input, plannerRouteId: executor.routeId, executorRouteId: planner.routeId }),
      ),
    ).toBe("COMMAND_CONFLICT");
    expect(listCommands(identityA)).toHaveLength(1);
  });

  it("13. planner/executor 角色放反 → 拒绝（store 与 schema 双层）", () => {
    const { planner, executor } = setupRoutes();
    expect(
      routingErrorCode(() =>
        createCommand(identityA, commandInput(executor.routeId, planner.routeId, "cmd-swapped")),
      ),
    ).toBe("ROUTING_ROLE_MISMATCH");
    // schema 层：合法 routeId 放错位置同样拒绝。
    const now = new Date().toISOString();
    const state = {
      version: 1,
      workspaceId: identityA.id,
      workspaceRoot: rootA,
      revision: 1,
      routes: [
        { routeId: planner.routeId, role: "planner", platform: "chatgpt_web", conversationId: PLANNER_THREAD, locator: {}, createdAt: now, updatedAt: now },
        { routeId: executor.routeId, role: "executor", platform: "codex_desktop", conversationId: EXECUTOR_THREAD_1, locator: { hostId: "local", executorProjectId: "proj_alpha" }, createdAt: now, updatedAt: now },
      ],
      commands: [
        { commandId: "cmd-bad", plannerRouteId: executor.routeId, executorRouteId: planner.routeId, intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64, deliveryStatus: "pending", createdAt: now, updatedAt: now },
      ],
      results: [],
    };
    expect(() => routingStateSchema.parse(state)).toThrow();
  });

  it("17. command 创建无法伪造非 pending 初始状态", () => {
    const { planner, executor } = setupRoutes();
    // 创建入口 schema strict：不接受 deliveryStatus 字段。
    expect(() =>
      commandInputSchema.parse({ ...commandInput(planner.routeId, executor.routeId), deliveryStatus: "accepted" }),
    ).toThrow();
    const command = createCommand(identityA, commandInput(planner.routeId, executor.routeId));
    expect(command.deliveryStatus).toBe("pending");
  });
});

describe("routing result", () => {
  it("6. result 必须引用真实 command；首次写入 executor 不符 → ROUTE_MISMATCH", () => {
    const { planner, executor } = setupRoutes();
    const command = createCommand(identityA, commandInput(planner.routeId, executor.routeId));
    expect(
      routingErrorCode(() =>
        appendResult(identityA, { commandId: "cmd-missing", executorRouteId: executor.routeId, iteration: 1, status: "ok" }),
      ),
    ).toBe("ROUTING_COMMAND_NOT_FOUND");
    expect(
      routingErrorCode(() =>
        appendResult(identityA, { commandId: command.commandId, executorRouteId: planner.routeId, iteration: 2, status: "ok" }),
      ),
    ).toBe("ROUTING_RESULT_ROUTE_MISMATCH");
    expect(listResults(identityA)).toHaveLength(0);
  });

  it("18. result exact replay 幂等：同 commandId+iteration+executor+status 返回既有", () => {
    const { planner, executor } = setupRoutes();
    const command = createCommand(identityA, commandInput(planner.routeId, executor.routeId));
    const input = { commandId: command.commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok" as const };
    const first = appendResult(identityA, input);
    const replay = appendResult(identityA, input);
    expect(replay).toEqual(first);
    expect(listResults(identityA)).toHaveLength(1);
  });

  it("19. 同 (commandId, iteration) 已存在但 executor/status 不同 → RESULT_CONFLICT", () => {
    const { planner, executor } = setupRoutes();
    const command = createCommand(identityA, commandInput(planner.routeId, executor.routeId));
    appendResult(identityA, { commandId: command.commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok" });
    // status 不同 → RESULT_CONFLICT。
    expect(
      routingErrorCode(() =>
        appendResult(identityA, { commandId: command.commandId, executorRouteId: executor.routeId, iteration: 1, status: "failed" }),
      ),
    ).toBe("RESULT_CONFLICT");
    // executor 不同（即使 status 相同）→ RESULT_CONFLICT，而非 ROUTE_MISMATCH。
    expect(
      routingErrorCode(() =>
        appendResult(identityA, { commandId: command.commandId, executorRouteId: planner.routeId, iteration: 1, status: "ok" }),
      ),
    ).toBe("RESULT_CONFLICT");
    expect(listResults(identityA)).toHaveLength(1);
    // 不同 iteration 是新结果，不冲突。
    const second = appendResult(identityA, { commandId: command.commandId, executorRouteId: executor.routeId, iteration: 2, status: "failed" });
    expect(second.iteration).toBe(2);
    expect(listResults(identityA)).toHaveLength(2);
  });
});

describe("routing durable store", () => {
  it("7. 损坏状态 fail closed：写事务公开 API → ROUTING_STATE_CORRUPT，文件保留、锁清理", () => {
    const { planner, executor } = setupRoutes();
    // 先建一条真实 command，再篡改它以破坏引用完整性。
    createCommand(identityA, commandInput(planner.routeId, executor.routeId));
    const file = routingFile(identityA.id);
    const before = fs.readFileSync(file, "utf8");
    // 篡改：把 command 的 executorRouteId 改成不存在的 route，破坏引用完整性。
    const state = JSON.parse(before) as { commands: Array<{ executorRouteId: string }> };
    state.commands[0].executorRouteId = "00000000-0000-7000-8000-00000000000a";
    fs.writeFileSync(file, JSON.stringify(state));

    // 损坏后走公开写 API（registerRoute / createCommand）都应 fail closed，
    // 而不是绕过读取直接写入（测试不再直接调用内部 updateRouting）。
    expect(routingErrorCode(() => registerRoute(identityA, plannerRegistration()))).toBe(
      "ROUTING_STATE_CORRUPT",
    );
    expect(
      routingErrorCode(() =>
        createCommand(
          identityA,
          commandInput(
            "00000000-0000-7000-8000-00000000000b",
            "00000000-0000-7000-8000-00000000000c",
            "cmd-corrupt",
          ),
        ),
      ),
    ).toBe("ROUTING_STATE_CORRUPT");

    // 损坏文件被原样保留，不自动重置；读侧同样 fail closed。
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(state));
    expect(routingErrorCode(() => readRouting(identityA))).toBe("ROUTING_STATE_CORRUPT");
    // 写事务失败后 wx 锁已清理，后续写事务可正常进行。
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("20. 伪造 workspace id/root → 拒绝；持久化 root 不符 → fail closed", () => {
    setupRoutes();
    // 伪造 id：root 真实存在但 id 与派生值不符。
    expect(
      routingErrorCode(() => readRouting({ id: "000000000000", root: rootA })),
    ).toBe("ROUTING_WORKSPACE_IDENTITY_MISMATCH");
    // 伪造 root：目录不存在，无法派生 canonical workspace。
    expect(
      routingErrorCode(() =>
        readRouting({ id: identityA.id, root: path.resolve(os.tmpdir(), "c2c-nonexistent-root") }),
      ),
    ).toBe("ROUTING_WORKSPACE_IDENTITY_MISMATCH");

    // 纵深防御：id 匹配文件名但持久化 workspaceRoot 被人工改坏 → fail closed。
    const file = routingFile(identityA.id);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    state.workspaceRoot = "D:\\somewhere-else";
    fs.writeFileSync(file, JSON.stringify(state));
    expect(routingErrorCode(() => readRouting(identityA))).toBe("ROUTING_STATE_CORRUPT");
  });

  it("revision 缺失 → ROUTING_STATE_CORRUPT（不静默从 0 重计）", () => {
    setupRoutes();
    const file = routingFile(identityA.id);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete state.revision;
    fs.writeFileSync(file, JSON.stringify(state));
    // 读侧与写侧（公开 API）都 fail closed，revision 单调性不被破坏。
    expect(routingErrorCode(() => readRouting(identityA))).toBe("ROUTING_STATE_CORRUPT");
    expect(routingErrorCode(() => registerRoute(identityA, plannerRegistration()))).toBe(
      "ROUTING_STATE_CORRUPT",
    );
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("revision 单调：每次 mutation +1，exact replay 不 bump", () => {
    const { planner } = setupRoutes();
    const revisionAfterSetup = stateSnapshot(identityA).revision;
    // 新 route 是 mutation：+1（EXECUTOR_THREAD_2 尚未注册）。
    registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_2));
    const afterSecond = stateSnapshot(identityA);
    expect(afterSecond.revision).toBe(revisionAfterSetup + 1);
    // exact replay：不产生新 revision。
    registerRoute(identityA, executorRegistration(EXECUTOR_THREAD_1));
    expect(stateSnapshot(identityA).revision).toBe(afterSecond.revision);
    // 新 command 是 mutation：+1。
    createCommand(identityA, commandInput(planner.routeId, listRoutes(identityA)[1].routeId, "cmd-rev"));
    expect(stateSnapshot(identityA).revision).toBe(afterSecond.revision + 1);
  });

  describe("exact replay 不修改状态", () => {
    it("route exact replay → revision 与文件 mtime 不变", () => {
      registerRoute(identityA, plannerRegistration());
      const before = stateSnapshot(identityA);
      const replay = registerRoute(identityA, plannerRegistration());
      const after = stateSnapshot(identityA);
      expect(after.content).toBe(before.content);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.revision).toBe(before.revision);
      expect(replay.updatedAt).toBe(
        (JSON.parse(before.content) as { routes: Array<{ updatedAt: string }> }).routes[0].updatedAt,
      );
    });

    it("command exact replay → revision 与文件 mtime 不变", () => {
      const { planner, executor } = setupRoutes();
      const input = commandInput(planner.routeId, executor.routeId);
      createCommand(identityA, input);
      const before = stateSnapshot(identityA);
      const replay = createCommand(identityA, input);
      const after = stateSnapshot(identityA);
      expect(after.content).toBe(before.content);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.revision).toBe(before.revision);
      expect(replay.updatedAt).toBe(
        (JSON.parse(before.content) as { commands: Array<{ updatedAt: string }> }).commands[0]
          .updatedAt,
      );
    });

    it("result exact replay → revision 与文件 mtime 不变", () => {
      const { planner, executor } = setupRoutes();
      const command = createCommand(identityA, commandInput(planner.routeId, executor.routeId));
      const input = {
        commandId: command.commandId,
        executorRouteId: executor.routeId,
        iteration: 1,
        status: "ok" as const,
      };
      appendResult(identityA, input);
      const before = stateSnapshot(identityA);
      const replay = appendResult(identityA, input);
      const after = stateSnapshot(identityA);
      expect(after.content).toBe(before.content);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.revision).toBe(before.revision);
      expect(replay.updatedAt).toBe(
        (JSON.parse(before.content) as { results: Array<{ updatedAt: string }> }).results[0]
          .updatedAt,
      );
    });
  });
});
