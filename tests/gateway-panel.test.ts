import fs from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

it("each operations panel keeps its explicit project when requesting state", () => {
  for (const workspaceId of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    const sendMessage = vi.fn(() => new Promise(() => {}));
    const context = vm.createContext({ URL, location: { href: `chrome-extension://test/operations/operations.html?workspaceId=${workspaceId}` },
      chrome: { runtime: { sendMessage } }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      document: { hidden: false, getElementById: () => ({}), querySelectorAll: () => [], addEventListener() {} },
      window: { addEventListener() {} },
    });
    vm.runInContext(fs.readFileSync("browser-companion/operations/operations.js", "utf8"), context);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "c2c.operations.read", workspaceId });
  }
});

it("popup selection scopes queries and ignores a late response from the previous project", async () => {
  const a = "aaaaaaaaaaaa", b = "bbbbbbbbbbbb";
  const target = { textContent: "" };
  const workspaceSelect = { value: "" };
  let selection!: (event: any) => void;
  const pending: ((value: unknown) => void)[] = [];
  const sendMessage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const readHistory = vi.fn(async () => ["hidden-b"]);
  const context = vm.createContext({
    document: {
      getElementById: (id: string) => id === "workspace-select" ? workspaceSelect : target,
      addEventListener: (_type: string, listener: any) => { selection = listener; },
    },
    chrome: { runtime: { sendMessage } }, setTimeout: () => 1, clearTimeout() {},
    C2CHistory: { read: readHistory },
  });
  // 使用真实摘要模型，避免 mock 缺少历史隐藏和待回流字段。
  vm.runInContext(fs.readFileSync("browser-companion/operations/view.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("browser-companion/popup/operations-summary.js", "utf8"), context);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(readHistory).not.toHaveBeenCalled();
  expect(target.textContent).toBe("请先选择项目，再查看任务。");

  selection({ detail: { workspaceId: a } });
  selection({ detail: { workspaceId: b } });
  expect(sendMessage.mock.calls.map(call => call[0])).toEqual([
    { type: "c2c.operations.read", workspaceId: a },
    { type: "c2c.operations.read", workspaceId: b },
  ]);
  const observedAt = new Date().toISOString();
  pending[1]!({ ok: true, autonomy: "armed", snapshot: {
    workspaceId: b, observedAt, executor: { state: "idle", observedAt },
    commands: [
      { commandId: "hidden-b", appServerTurn: { status: "completed" }, feedback: [
        { eventId: "queued-b", status: "queued" },
        { eventId: "unknown-b", status: "outcome_unknown", isolated: true },
      ] },
      { commandId: "active-b", appServerTurn: { status: "awaiting_approval" } },
    ],
  }, journal: { state: "OUTCOME_UNKNOWN", eventId: "unknown-b" },
  isolationArchive: { available: true, entries: [
    { status: "isolated" }, { status: "terminal_gone" }, { status: "pending" },
  ] } });
  await vi.waitFor(() => expect(target.textContent).toContain("本项目 1 条可见任务"));
  expect(readHistory).toHaveBeenCalledExactlyOnceWith(b);
  const projectBSummary = [
    "Codex：空闲 · 网页：无法确认",
    "本项目 1 条可见任务 · 已隐藏 1 条 · 1 条需要处理",
    "自动回流已开启 · 2 条排队、待确认或隔离回流（含隐藏任务） · 发送日志 OUTCOME_UNKNOWN",
    "结果不明档案：1 条已隔离（未观察）· 1 条已核验离开来源 · 1 条待确认",
  ].join("\n");
  expect(target.textContent).toBe(projectBSummary);

  pending[0]!({ ok: true, autonomy: "off", snapshot: {
    workspaceId: a, observedAt, executor: { state: "busy", observedAt }, commands: [],
  } });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  expect(target.textContent).toBe(projectBSummary);
  expect(readHistory).toHaveBeenCalledExactlyOnceWith(b);
  expect(sendMessage).toHaveBeenCalledTimes(2);
});
