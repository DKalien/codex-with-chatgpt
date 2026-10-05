import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("R5e architecture fence", () => {
  it("dispatch-schema 保持 identity-only：无外层身份/URL/路由 token，target 复用 generic snapshot", () => {
    const source = read("src/executor-control/dispatch-schema.ts");
    expect(source, "dispatch-schema 不得出现 chatgpt/credential/canonicalUrl/planner token")
      .not.toMatch(/chatgpt|credential|canonicalurl|planner/i);
    expect(source).toMatch(/executorDeliveryTargetSnapshotSchema/);
    expect(source).toMatch(/EXECUTOR_DISPATCH_MAX_ENTRIES = 10000/);
    expect(source).toMatch(/interrupted_after_target_pin|started/);
  });

  it("dispatch ledger/store/service 不含 production transport 与 planner 身份", () => {
    for (const file of [
      "src/executor-control/dispatch-schema.ts",
      "src/executor-control/dispatch-store.ts",
      "src/executor-control/dispatch-service.ts",
    ]) {
      const source = read(file);
      expect(source, `${file} 不得触碰 deliverCurrentCommand`).not.toMatch(/deliverCurrentCommand/);
      expect(source, `${file} 不得含 plannerRouteId`).not.toMatch(/plannerRouteId|plannerPrincipalFingerprint/);
      expect(source, `${file} 不得含 canonicalUrl`).not.toMatch(/canonicalUrl/);
    }
  });

  it("executor 域 switch lock：bind-current 与 dispatch pin 均持 withEndpointSwitchLock(\"executor\")", () => {
    const service = read("src/executor-control/service.ts");
    expect(service.match(/withEndpointSwitchLock\("executor"/g)?.length).toBe(1);
    const dispatchService = read("src/executor-control/dispatch-service.ts");
    expect(dispatchService).toMatch(/withEndpointSwitchLock\("executor"/);
    expect(dispatchService).toMatch(/interrupted_after_target_pin/);
    expect(dispatchService).toMatch(/EXECUTOR_DISPATCH_IDENTITY_MISMATCH/);
    expect(dispatchService).toMatch(/EXECUTOR_COMMAND_PINNED/);
  });

  it("web-sink 域 switch lock：bindCurrentWebSink + reserve/begin-send 持锁，recover/ack/mark/retire 不持锁", () => {
    const sinkService = read("src/web-sink-control/service.ts");
    expect(sinkService).toMatch(/withEndpointSwitchLock\("web-sink"/);
    const lifecycle = read("src/result-bus/delivery-lifecycle.ts");
    const occurrences = lifecycle.match(/withEndpointSwitchLock\("web-sink"/g)?.length ?? 0;
    expect(occurrences, "delivery lifecycle 只有 reserve/begin-send 两处持 switch lock").toBe(2);
    expect(lifecycle).toMatch(/web-sink-control\/service\.js/);
  });

  it("endpoint-switch/lock 只依赖 node 标准库与 config/paths，fail closed", () => {
    const source = read("src/endpoint-switch/lock.ts");
    for (const specifier of [...source.matchAll(/from\s*["']([^"']+)["']/g)].map(m => m[1])) {
      expect(specifier, `endpoint-switch/lock.ts -> ${specifier}`)
        .toMatch(/^node:|\.\.\/config\/paths\.js$/);
      expect(specifier).not.toMatch(/codex-backend|browser-companion|\/mcp\/|executor-control|web-sink-control|feedback/);
    }
    expect(source).toMatch(/openSync\(file, "wx", 0o600\)/);
    expect(source).toMatch(/ENDPOINT_SWITCH_LOCK_BUSY/);
    expect(source).toMatch(/fsyncSync/);
  });

  it("不新增 MCP bind/switch 工具：executor 与 web-sink MCP 均无 switch 面", () => {
    const executorTools = read("src/mcp/executor-tools.ts");
    expect(executorTools).not.toMatch(/registerTool\(\s*"executor_bind"/);
    expect(executorTools).not.toMatch(/registerTool\(\s*"executor_switch"/);
    expect(executorTools).toMatch(/dispatchExecutorCommand/);
    const executorSend = read("src/executor-control/send.ts");
    expect(executorSend).toMatch(/beginExecutorDispatch/);
    expect(executorSend).toMatch(/hashRequestAuthority\(plannerFingerprint\)/);
    expect(executorSend).toMatch(/expectedDispatchGenerationId/);
    expect(executorSend).toMatch(/finalizeExecutorDispatch/);
    const webSinkTools = read("src/mcp/web-sink-tools.ts");
    expect(webSinkTools).not.toMatch(/registerTool\(\s*"web_sink_switch"/);
  });

  it("codex backend 只认冻结 target snapshot，不再接收 activeBinding", () => {
    const backend = read("src/executor-control/codex-backend.ts");
    expect(backend, "backend 不得引用 activeBinding").not.toMatch(/activeBinding/);
    expect(backend).toMatch(/readonly target: ExecutorDeliveryTargetSnapshot/);
    expect(backend).toMatch(/deliverCurrentCommand/);
    expect(backend).toMatch(/assertGenericMatchesLegacyDesktop/);
  });

  it("R5d3 companion delivery adapter 关键导出保持不变", () => {
    const adapter = read("src/bridge/result-bus-delivery.ts");
    for (const name of [
      "resultBusCompanionReserve",
      "resultBusCompanionBeginSend",
      "resultBusCompanionAck",
      "resultBusCompanionRelease",
      "resultBusCompanionRetire",
      "resultBusCompanionState",
    ]) {
      expect(adapter, name).toMatch(new RegExp(name));
    }
  });

  it("R4 各 durable store 文件保持存在", () => {
    for (const file of [
      "src/executor-control/store.ts",
      "src/feedback/state-store.ts",
      "src/result-bus/store.ts",
      "src/routing/store.ts",
      "src/routing/result-outbox-store.ts",
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("dispatch ledger 有界：entries 上限 + 本地 commandId regex + fail closed 锁", () => {
    const schema = read("src/executor-control/dispatch-schema.ts");
    expect(schema).toMatch(/EXECUTOR_DISPATCH_COMMAND_ID/);
    expect(schema).toMatch(/max\(EXECUTOR_DISPATCH_MAX_ENTRIES\)/);
    const store = read("src/executor-control/dispatch-store.ts");
    expect(store).toMatch(/EXECUTOR_DISPATCH_LOCK_BUSY/);
    expect(store).toMatch(/EXECUTOR_DISPATCH_ENTRY_LIMIT/);
    expect(store).toMatch(/\.initialized/);
    expect(store).toMatch(/fsyncSync/);
    expect(store).toMatch(/noWrite/);
  });
});
