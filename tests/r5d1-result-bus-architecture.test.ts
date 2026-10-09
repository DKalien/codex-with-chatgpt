import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("R5d1/R5d2/R5d3 Result Bus architecture fence", () => {
  it("keeps the bus planner-independent and outside feedback/browser/control paths", () => {
    const files = fs.readdirSync(path.join(root, "src/result-bus"), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
      .map(entry => `src/result-bus/${entry.name}`);
    expect(files).toEqual(expect.arrayContaining([
      "src/result-bus/schema.ts", "src/result-bus/store.ts", "src/result-bus/service.ts", "src/result-bus/index.ts",
      "src/result-bus/cutover-schema.ts", "src/result-bus/cutover-store.ts",
    ]));
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/plannerRouteId|plannerPrincipalFingerprint/);
      expect(source, file).not.toMatch(/feedback|browser-companion|src\/mcp|src\/cli|remote|executor-control/);
      expect(source, file).not.toMatch(/readActiveExecutorBinding|executor-binding-store|active-executor/);
    }
  });

  it("keeps R4 outbox independent from Web Sink state and plannerRoute-pinned", () => {
    const outbox = read("src/routing/result-outbox-store.ts");
    expect(outbox, "R4 outbox 必须 pin plannerRoute").toMatch(/plannerRouteId/);
    expect(outbox).not.toMatch(/web-sink-control|readActiveWebSinkBinding|webSinkStatus/);
    const legacyWriter = outbox.slice(outbox.indexOf("export function enqueueResultOutboxEntry"));
    expect(legacyWriter).not.toMatch(/result-bus|listResultBusEntries/);
    expect(read("src/routing/execution-result-digest.ts")).not.toMatch(/result-outbox-store/);
    expect(fs.existsSync(path.join(root, "src/routing/result-outbox-store.ts"))).toBe(true);
  });

  it("keeps R5d2 delivery lifecycle inside the generic core", () => {
    // lifecycle 只经由 generic web-sink-control service 读 Active Web Sink，
    // 不触碰 store/companion-adapter/registry 内部。
    const lifecycle = read("src/result-bus/delivery-lifecycle.ts");
    expect(lifecycle).toMatch(/web-sink-control\/service\.js/);
    expect(lifecycle).not.toMatch(/web-sink-control\/(store|companion-adapter|registry|chatgpt-surface)/);
    expect(lifecycle).not.toMatch(/feedback|browser-companion|src\/mcp|src\/cli|executor-control/);
  });

  it("R5d3: companion router reaches Result Bus only through the delivery adapter", () => {
    const companion = read("src/bridge/companion.ts");
    // adapter 是唯一入口；companion router 不得直接触碰 result-bus core。
    expect(companion).toMatch(/result-bus-delivery\.js/);
    expect(companion).not.toMatch(/result-bus\/(store|schema|service|delivery-lifecycle|cutover-store)/);
    // MCP 只允许 neutral arbiter/read fence 与 adapter helper（FIX 5）；
    // 不得触碰 result-bus core，也不得调用 Bus lifecycle mutation。
    for (const file of fs.readdirSync(path.join(root, "src/mcp")).filter(name => name.endsWith(".ts"))) {
      const source = read(`src/mcp/${file}`);
      expect(source, file).not.toMatch(/result-bus\/(store|schema|service|delivery-lifecycle|cutover-store)/);
      expect(source, file).not.toMatch(/reserveNextResultBusEntry|beginResultBusSend|ackResultBusObserved|releaseResultBusReservation|retireResultBusOutcomeUnknown|markResultBusOutcomeUnknown/);
      if (source.match(/delivery-arbiter|result-bus-delivery/)) {
        expect(file).toBe("feedback.ts");
      }
    }
  });

  it("R5d3: delivery adapter targets Active Web Sink only, never planner identity", () => {
    const adapter = read("src/bridge/result-bus-delivery.ts");
    expect(adapter).toMatch(/readActiveWebSinkBinding/);
    expect(adapter).toMatch(/verifyCompanionCredentialForWebSink/);
    // 目标选择绝不读 planner 身份值（canonical 分类只做 `in` 存在性检查）。
    expect(adapter).not.toMatch(/\.plannerRouteId|\.plannerPrincipalFingerprint/);
  });

  it("keeps the transaction boundary free of skip-style bypasses", () => {
    const store = read("src/result-bus/store.ts");
    expect(store).not.toMatch(/\bskip\b/);
    expect(store).toMatch(/noWrite/);
  });

  it("R5d3: feedback projector is no longer a production consumer of the R4 outbox or Result Bus", () => {
    const projector = read("src/feedback/projector.ts");
    expect(projector).not.toMatch(/result-outbox|result-bus|canonical-compat/);
    // 历史写入器只用于 fixture；新 release 不暴露生产 compat writer。
    expect(fs.existsSync(path.join(root, "src/feedback/canonical-compat.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "tests/helpers/canonical-compat.ts"))).toBe(true);
    expect(read("src/routing/execution-result-reconciler.ts")).toMatch(/result-bus\/service\.js/);
  });

  it("R5d3: legacy feedback lifecycle never reserves canonical-pinned events", () => {
    const lifecycle = read("src/feedback/delivery-lifecycle.ts");
    const reserveNext = lifecycle.slice(lifecycle.indexOf("export function reserveNext"));
    const claimNext = lifecycle.slice(lifecycle.indexOf("export function claimNext"));
    for (const [name, source] of [["reserveNext", reserveNext], ["claimNext", claimNext]] as const) {
      expect(source, name).toMatch(/plannerRouteId/);
    }
  });

  it("生产 Feedback 新获取与 begin 仅允许控制通知，历史执行只能恢复", () => {
    for (const file of ["src/bridge/result-bus-delivery.ts", "src/feedback/companion-delivery.ts", "src/mcp/feedback.ts"]) {
      const calls = [...read(file).matchAll(/\b(?:reserveNext|claimNext|beginSend)\(\{([\s\S]*?)\}\)/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call[1], file).toContain("controlOnly: true");
    }
    const projector = read("src/feedback/projector.ts");
    expect(projector).not.toMatch(/kind: "C2C_EXECUTED"|isTrustedDesktopReceipt|readDesktop/);
    expect(projector).toMatch(/FINAL_RECEIPT_REQUIRED_EVENT_KIND/);
  });
});
