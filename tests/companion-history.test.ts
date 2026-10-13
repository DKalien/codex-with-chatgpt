import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const a = "aaaaaaaaaaaa", b = "bbbbbbbbbbbb";
const key = (id: string) => `c2c.panel.hidden.v1.${id}`;
const command = (commandId: string, status = "completed", feedback: any[] = []) => ({ commandId,
  appServerTurn: { status }, delivery: { status: "unknown" }, executions: [], feedback, issues: [] });
const data = (workspaceId = a) => ({ ok: true, autonomy: "off", snapshot: { workspaceId,
  observedAt: new Date().toISOString(), commands: [command("old", "completed", [
    { eventId: "queued", status: "queued" }, { eventId: "claimed", status: "claimed" },
    { eventId: "unknown", status: "outcome_unknown", isolated: true },
  ]), command("active", "running"), command("new") ] },
  journal: { state: "OUTCOME_UNKNOWN", eventId: "unknown" },
  isolationArchive: { available: true, entries: [{ status: "isolated", eventId: "unknown" }] } });
function harness(stored: Record<string, any> = {}) {
  const elements = new Map<string, any>();
  const node = () => ({ textContent: "", value: "", hidden: false, disabled: false, children: [] as any[],
    showModal: vi.fn(), close: vi.fn(),
    append(...items: any[]) { this.children.push(...items); },
    replaceChildren(...items: any[]) { this.children = items; }, setAttribute() {}, scrollIntoView() {} });
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const listeners: Record<string, any> = {};
  const chrome = { storage: { local: {
    get: vi.fn(async (name: string) => ({ [name]: stored[name] })),
    set: vi.fn(async (values: any) => { Object.assign(stored, values); }),
  } }, runtime: { sendMessage: vi.fn(async (_message: any) => data()) } };
  const context = vm.createContext({ chrome, URL, console, Date,
    location: { href: `chrome-extension://test/operations/operations.html?workspaceId=${a}` },
    document: { getElementById: el, createElement: node, querySelectorAll: () => [], hidden: false,
      body: { classList: { toggle() {} } }, addEventListener: (name: string, fn: any) => { listeners[name] = fn; } },
    window: { addEventListener() {} }, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
  });
  const run = (file: string) => vm.runInContext(fs.readFileSync(`browser-companion/${file}`, "utf8"), context);
  el("workspace-select").value = a;
  run("operations/view.js"); run("operations/history.js");
  return { context, chrome, stored, el, listeners, run, history: context.C2CHistory, model: context.C2COperations };
}

describe("Companion 本地历史显示", () => {
  it("只隐藏精确终态 ID；活动、不明与新任务可见，安全数据保持原样", async () => {
    const h = harness(), response = data(), before = JSON.stringify(response);
    await h.history.write(a, ["old", "active"]);
    const hidden = await h.history.read(a);
    const view = h.model.derive(response, Date.now(), hidden);
    expect(view.rows.map((row: any) => row.commandId)).toEqual(["active", "new"]);
    expect(view.pendingFeedback).toHaveLength(3);
    expect(JSON.stringify(response)).toBe(before);
    response.snapshot.commands[0].appServerTurn.status = "running";
    expect(h.model.derive(response, Date.now(), hidden).rows).toHaveLength(3);
    for (const status of ["queued", "starting", "awaiting_approval", "needs_reconciliation", "unknown"])
      expect(h.model.canHide(command("x", status))).toBe(false);
    for (const status of ["completed", "failed", "cancelled"])
      expect(h.model.canHide(command("x", status))).toBe(true);
    expect(h.model.canHide({ delivery: { status: "accepted" }, executions: [] })).toBeFalsy();
    expect(h.model.canHide({ delivery: { status: "accepted" }, executions: [{ status: "ok" }] })).toBe(true);
    expect(h.model.canHide({ delivery: { status: "outcome_unknown" } })).toBeFalsy();
    expect(h.model.canHide({ administrative: "abandoned" })).toBe(true);
    expect(await h.history.read(b)).toEqual([]);
    expect(h.model.canHide({ ...command("x"), issues: ["delivery_identity_conflict"] })).toBe(false);
    const pending = { ...response, snapshot: { ...response.snapshot, panelAuthorization: { pending: [{ commandId: "new" }] } } };
    expect(h.model.derive(pending, Date.now(), ["new"]).rows.map((row: any) => row.commandId)).toContain("new");
    expect(Object.keys(h.stored)).toEqual([key(a)]);
    expect(h.stored[key(a)]).toEqual(["old", "active"]);
  });
  it("打开与刷新零写；明确点击后仅改显示 key，恢复可撤销且不动 journal/档案", async () => {
    const stored = { journal: { state: "OUTCOME_UNKNOWN" }, archive: { secret: "protected" } };
    const h = harness(stored); h.run("operations/operations.js");
    await vi.waitFor(() => expect(h.el("count").textContent).toBe("3"));
    await h.el("refresh").onclick();
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
    await h.el("clear-history").onclick();
    expect(h.el("count").textContent).toBe("1");
    expect(h.el("feedback-status").textContent).toContain("3 条");
    expect(h.el("feedback-status").textContent).toContain("OUTCOME_UNKNOWN");
    expect(h.el("feedback-status").textContent).toContain("已暂停");
    expect(h.el("feedback-pending").children).toHaveLength(3);
    expect(h.el("isolation-entries").children).toHaveLength(1);
    expect(stored.journal).toEqual({ state: "OUTCOME_UNKNOWN" });
    expect(stored.archive).toEqual({ secret: "protected" });
    expect(h.chrome.runtime.sendMessage.mock.calls.every(([message]) => message.type === "c2c.operations.read")).toBe(true);
    h.run("popup/operations-summary.js");
    await vi.waitFor(() => expect(h.el("operations-summary").textContent).toContain("1 条可见任务"));
    expect(h.el("operations-summary").textContent).toContain("3 条排队");
    await h.el("restore-history").onclick();
    expect(h.el("count").textContent).toBe("3");
    expect(h.stored[key(a)]).toEqual([]);
  });
  it("损坏或读取失败显示全部，写入失败不假清空", async () => {
    const h = harness({ [key(a)]: { malformed: true } }); h.run("operations/operations.js");
    await vi.waitFor(() => expect(h.el("history-status").textContent).toContain("无法读取"));
    expect(h.el("count").textContent).toBe("3");
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
    h.chrome.storage.local.set.mockRejectedValue(new Error("disk"));
    await h.el("clear-history").onclick();
    expect(h.el("count").textContent).toBe("3");
    expect(h.el("history-status").textContent).toContain("保存失败");
    h.chrome.storage.local.get.mockRejectedValue(new Error("read"));
    await h.el("refresh").onclick();
    expect(h.el("count").textContent).toBe("3");
    await expect(h.history.write("bad", [])).rejects.toThrow("项目标识无效");
  });
  it("popup 项目切换后 A 的迟到偏好不会覆盖 B", async () => {
    const h = harness({ [key(b)]: [] });
    let finish!: (value: any) => void;
    h.chrome.storage.local.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.run("popup/operations-summary.js");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.chrome.runtime.sendMessage.mockResolvedValue(data(b));
    h.listeners["c2c-project-selection"]({ detail: { workspaceId: b } });
    await vi.waitFor(() => expect(h.el("operations-summary").textContent).toContain("3 条可见任务"));
    finish({ [key(a)]: ["old", "new"] });
    await Promise.resolve(); await Promise.resolve();
    expect(h.el("operations-summary").textContent).toContain("3 条可见任务");
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it("返回项目不匹配时不读写其他项目；存储 ID 与条数均有界", async () => {
    const h = harness(); h.chrome.runtime.sendMessage.mockResolvedValue(data(b));
    h.run("operations/operations.js"); h.run("popup/operations-summary.js");
    await vi.waitFor(() => expect(h.el("history-status").textContent).toContain("项目不一致"));
    await vi.waitFor(() => expect(h.el("operations-summary").textContent).toContain("不一致"));
    await h.el("clear-history").onclick();
    expect(h.chrome.storage.local.get).not.toHaveBeenCalled();
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
    for (const ids of [["bad id"], ["x".repeat(129)], new Array(10001).fill("x")]) {
      await expect(h.history.write(a, ids)).rejects.toThrow("设置无效");
      h.stored[key(a)] = ids;
      await expect(h.history.read(a)).rejects.toThrow("设置损坏");
    }
  });
  it("两个入口均以 classic script 在调用前加载共享显示存储", () => {
    for (const [file, script] of [["operations/operations.html", "operations.js"], ["popup/popup.html", "operations-summary.js"]]) {
      const html = fs.readFileSync(`browser-companion/${file}`, "utf8");
      expect(html.indexOf('history.js"></script>')).toBeLessThan(html.indexOf(`${script}"></script>`));
    }
    expect(() => new vm.Script(fs.readFileSync("browser-companion/operations/history.js", "utf8"))).not.toThrow();
  });
});

describe("格式化按钮", () => {
  it("无本机授权禁用；预览绑定项目并明确不可恢复，勾选后才confirm", async () => {
    const h = harness(); h.run("operations/operations.js");
    await vi.waitFor(() => expect(h.el("count").textContent).toBe("3"));
    expect(h.el("format-history").disabled).toBe(true);
    const authorized = { ...data(), journal: { state: "NONE" }, snapshot: { ...data().snapshot, panelAuthorization: { enabled: true } } };
    h.chrome.runtime.sendMessage.mockImplementation(async (message: any) => message.type === "c2c.operations.format"
      ? { ok: true, status: message.phase === "preview" ? "preview" : "cleaned", workspaceId: a, confirmationSha256: "f".repeat(64), counts: { tasks: 16, outputs: 2, feedback: 3 }, browserArchiveCount: 1, notice: "永久删除本项目任务与回流历史" } : authorized);
    await h.el("refresh").onclick();
    expect(h.el("format-history").disabled).toBe(false);
    await h.el("format-history").onclick();
    expect(h.el("confirm-title").textContent).toContain("不可恢复");
    expect(h.el("confirm-task").textContent).toContain(a);
    expect(h.el("confirm-notice").textContent).toContain("无法恢复");
    expect(h.el("confirm-notice").textContent).toContain("任务 16 条");
    expect(h.el("confirm-notice").textContent).toContain("本机隔离档案 1 条");
    await h.el("confirm-action").onclick();
    expect(h.chrome.runtime.sendMessage.mock.calls.some(([m]) => m.phase === "confirm")).toBe(false);
    h.el("confirm-check").checked = true;
    await h.el("confirm-action").onclick();
    expect(h.chrome.runtime.sendMessage.mock.calls.find(([m]) => m.phase === "confirm")?.[0]).toMatchObject({
      type: "c2c.operations.format", workspaceId: a, phase: "confirm", confirmationSha256: "f".repeat(64), confirmed: true });
    expect(h.el("operation-status").textContent).toContain("永久清空");
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe("格式化预览受阻提示", () => {
  it("错误紧邻按钮显示，保持精确拒绝原因且不打开确认或删除", async () => {
    const h = harness();
    const authorized = { ...data(), snapshot: { ...data().snapshot, panelAuthorization: { enabled: true } } };
    h.chrome.runtime.sendMessage.mockImplementation(async (message: any) => message.type === "c2c.operations.format"
      ? { ok: false, reason: "format_send_fence_active" } : authorized);
    h.run("operations/operations.js");
    await vi.waitFor(() => expect(h.el("format-history").disabled).toBe(false));
    await h.el("format-history").onclick();
    expect(h.el("format-status").textContent).toContain("安全屏障");
    expect(h.el("format-status").textContent).toBe(h.el("operation-status").textContent);
    expect(h.el("confirm-dialog").showModal).not.toHaveBeenCalled();
    expect(h.chrome.runtime.sendMessage.mock.calls.some(([message]) => message.phase === "confirm")).toBe(false);
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
    const html = fs.readFileSync("browser-companion/operations/operations.html", "utf8");
    expect(html.indexOf('id="format-status"')).toBeGreaterThan(html.indexOf('id="format-history"'));
    expect(html.indexOf('id="format-status"')).toBeLessThan(html.indexOf('id="history-status"'));
  });
});
