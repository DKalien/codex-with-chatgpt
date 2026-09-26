import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  RoutingError,
  commandDeliveryTransitionInputSchema,
  commandInputSchema,
  resultInputSchema,
  routeRegistrationSchema,
  routingStateSchema,
  routingWorkspaceIdSchema,
  type CommandInput,
  type CommandDeliveryTransitionInput,
  type ResultInput,
  type RouteRegistration,
  type RoutingCommand,
  type RoutingResult,
  type RoutingRoute,
  type RoutingState,
} from "./schema.js";

/**
 * Routing R1 durable store。
 *
 * 对齐 desktop store 范式：per-workspace 单文件 + wx 文件锁 + tmp/rename/fsync
 * 原子写 + revision 单调 + 损坏 fail closed（保留文件、不重置、人工核对）。
 * 每次 read/update 都用调用方传入的 workspace identity 对象核对
 * state 的 workspaceId/workspaceRoot，任一不匹配 fail closed；
 * 不接受彼此独立的两个裸字符串。
 */
export type RoutingWorkspaceIdentity = Pick<Workspace, "id" | "root">;

/**
 * workspace identity 派生校验：workspace 是安全边界，只认 "id 确实由 canonical
 * root 派生" 的组合，不接受任意 (id, root) 字符串对。
 * 用 new Workspace(root) 走与生产完全一致的 realpath + sha256 派生；
 * root 不存在 / id 不符 / root 不符（含大小写变体）一律 fail closed。
 */
export function resolveWorkspaceIdentity(identity: RoutingWorkspaceIdentity): {
  id: string;
  root: string;
} {
  let resolved: Workspace;
  try {
    resolved = new Workspace(identity.root);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw new RoutingError(
        "ROUTING_WORKSPACE_IDENTITY_MISMATCH",
        `workspace root 无法解析为 canonical workspace：${error.message}`,
      );
    }
    throw error;
  }
  if (resolved.id !== identity.id || resolved.root !== identity.root) {
    throw new RoutingError(
      "ROUTING_WORKSPACE_IDENTITY_MISMATCH",
      "workspace id 与 canonical root 不匹配；拒绝伪造的 identity 组合。",
    );
  }
  return { id: resolved.id, root: resolved.root };
}

export function routingFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(
    path.resolve(stateDir),
    "routing",
    `${routingWorkspaceIdSchema.parse(workspaceId)}.json`,
  );
}

function corrupt(): RoutingError {
  return new RoutingError(
    "ROUTING_STATE_CORRUPT",
    "Routing 状态损坏、未初始化历史缺失或 workspace identity 不匹配；保留文件并人工核对，不能重置 ID 历史。",
  );
}

function emptyState(identity: RoutingWorkspaceIdentity): RoutingState {
  return {
    version: 1,
    workspaceId: identity.id,
    workspaceRoot: identity.root,
    // transient 空状态显式 revision 0；首次 durable write 后变为 1。
    revision: 0,
    routes: [],
    commands: [],
    results: [],
  };
}

/** 读取时核对 workspaceId 与 workspaceRoot；任一不匹配按损坏处理（fail closed）。 */
export function readRouting(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): RoutingState | null {
  const resolved = resolveWorkspaceIdentity(identity);
  const file = routingFile(resolved.id, stateDir);
  try {
    const state = routingStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (state.workspaceId !== identity.id || state.workspaceRoot !== identity.root) {
      throw corrupt();
    }
    return state;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !fs.existsSync(`${file}.initialized`)
    ) {
      return null;
    }
    throw corrupt();
  }
}

/**
 * module-private 通用写事务；不 export。
 * 对外只暴露语义 API，防止调用方绕过 delivery transition 约束直接任意改写 state。
 * `transitionCommandDelivery()` 负责 pending 到首个 Desktop delivery 终态的显式转换。
 *
 * callback 返回 noWrite: true 表示 exact replay：不 bump revision、不重写主 state 文件。
 * noWrite 附带内部断言：previous 必须存在，且 next.state 与 previous 语义完全相同；
 * 违反即内部不变量错误（fail fast），防止内部代码误把 mutation 标成 noWrite。
 */
function updateRouting<T>(
  identity: RoutingWorkspaceIdentity,
  change: (state: RoutingState | null) => { state: RoutingState; result: T; noWrite?: boolean },
  stateDir = getStateDir(),
): T {
  const resolved = resolveWorkspaceIdentity(identity);
  const file = routingFile(resolved.id, stateDir);
  ensureDir(path.dirname(file));
  let lock: number;
  try {
    lock = fs.openSync(`${file}.lock`, "wx", 0o600);
  } catch {
    throw new RoutingError(
      "ROUTING_STORE_BUSY",
      "Routing 状态写锁繁忙；遗留锁须人工核对进程和历史后恢复，不要删除 ID 历史。",
    );
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    const previous = readRouting(identity, stateDir);
    const next = change(previous);
    // exact replay：返回原记录，不 bump revision、不重写主 state 文件。
    if (next.noWrite) {
      if (!previous) {
        throw new RoutingError(
          "ROUTING_INTERNAL_INVARIANT",
          "noWrite replay 要求已存在的 previous state；这是内部不变量错误。",
        );
      }
      if (JSON.stringify(next.state) !== JSON.stringify(previous)) {
        throw new RoutingError(
          "ROUTING_INTERNAL_INVARIANT",
          "noWrite replay 不允许携带状态变更；请改用显式 mutation API。",
        );
      }
      return next.result;
    }
    const revision = (previous?.revision ?? 0) + 1;
    const valid = routingStateSchema.parse({ ...next.state, revision });
    if (valid.workspaceId !== resolved.id || valid.workspaceRoot !== resolved.root) {
      throw corrupt();
    }
    if (!fs.existsSync(`${file}.initialized`)) {
      const marker = fs.openSync(`${file}.initialized`, "wx", 0o600);
      try {
        fs.writeFileSync(marker, "1\n");
        fs.fsyncSync(marker);
      } finally {
        fs.closeSync(marker);
      }
    }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(valid));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    return next.result;
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(`${file}.lock`);
    }
  }
}

function locatorEquals(
  left: RoutingRoute["locator"],
  right: RoutingRoute["locator"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function findRoute(
  state: RoutingState,
  platform: RoutingRoute["platform"],
  conversationId: string,
): RoutingRoute | undefined {
  return state.routes.find(
    (route) => route.platform === platform && route.conversationId === conversationId,
  );
}

/**
 * Route 注册幂等：同 (platform, conversationId) 再注册时
 * - role、locator 完全一致 → 返回既有 route；
 * - role 不同 → ROUTE_ROLE_CONFLICT；
 * - locator 漂移 → ROUTE_LOCATOR_CONFLICT。
 * role 注册后不可变；换 role 须新会话。
 */
export function registerRoute(
  identity: RoutingWorkspaceIdentity,
  input: RouteRegistration,
  stateDir = getStateDir(),
): RoutingRoute {
  const registration = routeRegistrationSchema.parse(input);
  return updateRouting(
    identity,
    (previous) => {
      const state = previous ?? emptyState(identity);
      // codex_desktop conversationId 为 UUID：canonical 化为 lowercase，
      // 大小写变体不形成两个 identity；chatgpt_web 保持平台原样字符串语义。
      const conversationId =
        registration.platform === "codex_desktop"
          ? registration.conversationId.toLowerCase()
          : registration.conversationId;
      const existing = findRoute(state, registration.platform, conversationId);
      if (existing) {
        if (existing.role !== registration.role) {
          throw new RoutingError(
            "ROUTE_ROLE_CONFLICT",
            "同一 (platform, conversationId) 已注册为不同 role；role 不可变，换 role 须新会话。",
          );
        }
        if (!locatorEquals(existing.locator, registration.locator)) {
          throw new RoutingError(
            "ROUTE_LOCATOR_CONFLICT",
            "同一 route identity 的 locator 不允许静默漂移。",
          );
        }
        return { state, result: existing, noWrite: true };
      }
      const now = new Date().toISOString();
      const route: RoutingRoute = {
        ...registration,
        conversationId,
        routeId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      return { state: { ...state, routes: [...state.routes, route] }, result: route };
    },
    stateDir,
  );
}

const COMMAND_IDENTITY_FIELDS = [
  "plannerRouteId",
  "executorRouteId",
  "intent",
  "payloadBytes",
  "payloadSha256",
] as const;

/**
 * commandId 严格幂等（对齐 Desktop replay 语义）：
 * 同 commandId + 完全相同 routes/intent/digest/bytes → 返回旧记录；
 * 任一字段不同 → COMMAND_CONFLICT。创建入口不接受初始 deliveryStatus，
 * 一律产生 pending；后续状态只能由 transport 阶段的明确转换 API 写入。
 */
export function createCommand(
  identity: RoutingWorkspaceIdentity,
  input: CommandInput,
  stateDir = getStateDir(),
): RoutingCommand {
  const parsed = commandInputSchema.parse(input);
  return updateRouting(
    identity,
    (previous) => {
      const state = previous ?? emptyState(identity);
      const existing = state.commands.find((item) => item.commandId === parsed.commandId);
      if (existing) {
        const conflict = COMMAND_IDENTITY_FIELDS.some((field) => existing[field] !== parsed[field]);
        if (conflict) {
          throw new RoutingError(
            "COMMAND_CONFLICT",
            "相同 commandId 但 routes/intent/payload 指纹不一致；拒绝重放不同正文。",
          );
        }
        return { state, result: existing, noWrite: true };
      }
      const planner = state.routes.find((route) => route.routeId === parsed.plannerRouteId);
      if (!planner) {
        throw new RoutingError("ROUTING_ROUTE_NOT_FOUND", "plannerRouteId 不存在于本 workspace 状态。");
      }
      if (planner.role !== "planner") {
        throw new RoutingError("ROUTING_ROLE_MISMATCH", "plannerRouteId 不是 planner role。");
      }
      const executor = state.routes.find((route) => route.routeId === parsed.executorRouteId);
      if (!executor) {
        throw new RoutingError("ROUTING_ROUTE_NOT_FOUND", "executorRouteId 不存在于本 workspace 状态。");
      }
      if (executor.role !== "executor") {
        throw new RoutingError("ROUTING_ROLE_MISMATCH", "executorRouteId 不是 executor role。");
      }
      const now = new Date().toISOString();
      const command: RoutingCommand = {
        ...parsed,
        deliveryStatus: "pending",
        createdAt: now,
        updatedAt: now,
      };
      return { state: { ...state, commands: [...state.commands, command] }, result: command };
    },
    stateDir,
  );
}

/** 持久化首次 Desktop delivery outcome；相同终态 replay 只读返回。 */
export function transitionCommandDelivery(
  identity: RoutingWorkspaceIdentity,
  input: CommandDeliveryTransitionInput,
  stateDir = getStateDir(),
): RoutingCommand {
  const parsed = commandDeliveryTransitionInputSchema.parse(input);
  return updateRouting(identity, (previous) => {
    const state = previous ?? emptyState(identity);
    const command = state.commands.find((item) => item.commandId === parsed.commandId);
    if (!command) {
      throw new RoutingError("ROUTING_COMMAND_NOT_FOUND", "delivery transition 必须引用本 workspace 已存在的 Command。");
    }
    if (command.deliveryStatus === parsed.deliveryStatus) {
      return { state, result: command, noWrite: true };
    }
    if (command.deliveryStatus !== "pending") {
      throw new RoutingError(
        "ROUTING_COMMAND_DELIVERY_CONFLICT",
        "Command 已有不同 delivery 终态；拒绝覆盖或重新解释既有结果。",
      );
    }
    const updated: RoutingCommand = {
      ...command,
      deliveryStatus: parsed.deliveryStatus,
      updatedAt: new Date().toISOString(),
    };
    return {
      state: {
        ...state,
        commands: state.commands.map((item) => item.commandId === parsed.commandId ? updated : item),
      },
      result: updated,
    };
  }, stateDir);
}

/**
 * ExecutionResult 幂等：(commandId, iteration) 是幂等身份，resultId 只是引用 ID。
 * - 同 commandId + iteration + executorRouteId + status + summary + evidence 完全一致 → 返回既有 result；
 * - 同 (commandId, iteration) 但内容不同 → RESULT_CONFLICT；
 * - 不因每次生成新 resultId 让同一 execution receipt 重放成两条结果。
 */
export function appendResult(
  identity: RoutingWorkspaceIdentity,
  input: ResultInput,
  stateDir = getStateDir(),
): RoutingResult {
  const parsed = resultInputSchema.parse(input);
  return updateRouting(
    identity,
    (previous) => {
      const state = previous ?? emptyState(identity);
      const command = state.commands.find((item) => item.commandId === parsed.commandId);
      if (!command) {
        throw new RoutingError("ROUTING_COMMAND_NOT_FOUND", "result 必须引用本 workspace 状态内的真实 command。");
      }
      // 幂等身份是 (commandId, iteration)：先判 replay/conflict，
      // 再对首次写入校验 executor 归属，两类错误语义分开。
      const existing = state.results.find(
        (item) => item.commandId === parsed.commandId && item.iteration === parsed.iteration,
      );
      if (existing) {
        if (existing.executorRouteId !== parsed.executorRouteId || existing.status !== parsed.status ||
            !("rawSummary" in existing) || !("machineEvidence" in existing) ||
            existing.rawSummary !== parsed.rawSummary ||
            JSON.stringify(existing.machineEvidence) !== JSON.stringify(parsed.machineEvidence)) {
          throw new RoutingError(
            "RESULT_CONFLICT",
            "相同 (commandId, iteration) 但 executor/status/summary/evidence 不一致；拒绝覆盖既有 execution receipt。",
          );
        }
        return { state, result: existing, noWrite: true };
      }
      if (command.executorRouteId !== parsed.executorRouteId) {
        throw new RoutingError(
          "ROUTING_RESULT_ROUTE_MISMATCH",
          "result 的 executorRouteId 必须与 command 的 executorRouteId 完全一致。",
        );
      }
      const now = new Date().toISOString();
      const result: RoutingResult = { ...parsed, resultId: randomUUID(), createdAt: now, updatedAt: now };
      return { state: { ...state, results: [...state.results, result] }, result };
    },
    stateDir,
  );
}

export function listRoutes(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): RoutingRoute[] {
  return readRouting(identity, stateDir)?.routes ?? [];
}

export function listCommands(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): RoutingCommand[] {
  return readRouting(identity, stateDir)?.commands ?? [];
}

export function listResults(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): RoutingResult[] {
  return readRouting(identity, stateDir)?.results ?? [];
}
