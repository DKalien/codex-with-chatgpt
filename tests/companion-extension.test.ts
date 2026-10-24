import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error 纯 JS 模块
import { conversationId, createBackground } from "../browser-companion/background.js";

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist", "browser-companion");

const CONV = "https://chatgpt.com/c/abc-123";
const SAFE = { safe: true };
const ws = (notifications: unknown[], conversationUrl: string | null = CONV, workspaceId = "a".repeat(12)) => ({
  workspaceId, name: "demo", conversationUrl, notifications,
});
const note = (id: string, state: string, createdAt = "2026-01-01T00:00:00Z") => ({ id, commandId: "c1", state, createdAt, text: `msg\nATTEMPT_ID: ${id}` });

function setup(workspaces: unknown[], deliverResult: unknown = { ok: true, observed: true }) {
  const calls: string[] = [];
  const sent: unknown[] = [];
  const stored: Record<string, unknown> = {};
  const chrome = {
    storage: { local: { get: async (d: object) => ({ ...d, token: "tok" }), set: async (v: object) => { Object.assign(stored, v); } } },
    tabs: {
      query: async () => [{ url: CONV }],
      sendMessage: async (_tab: number, msg: unknown) => { sent.push(msg); return deliverResult; },
    },
  };
  const fetchImpl = async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const p = new URL(url).pathname.replace("/companion/v1", "");
    calls.push(`${init.method} ${p}${init.body ? ` ${init.body}` : ""}`);
    expect(init.headers.authorization).toBe("Bearer tok");
    return { ok: true, status: 200, json: async () => (p === "/state" ? { workspaces } : {}) };
  };
  const status = () => (stored.lastStatus as { text: string } | undefined)?.text;
  return { bg: createBackground(chrome, fetchImpl), calls, sent, status };
}
const tab = { tab: { id: 7 }, url: CONV };

describe("companion background", () => {
  it("claims the oldest pending, delivers, then acks", async () => {
    const { bg, calls, sent } = setup([ws([note("n2", "pending", "2026-01-02T00:00:00Z"), note("n1", "pending")])]);
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["GET /state", "POST /claim", "POST /ack"]);
    expect(calls[1]).toContain('"id":"n1"');
    expect(sent).toEqual([{ type: "c2c.deliver", text: "msg\nATTEMPT_ID: n1", attemptId: "n1" }]);
  });

  it("does not ack when the page did not observe the message", async () => {
    const { bg, calls } = setup([ws([note("n1", "pending")])], { ok: false, sent: true, reason: "observation_pending" });
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls.some((c) => c.startsWith("POST /ack") || c.startsWith("POST /requeue"))).toBe(false);
  });

  it("requeues when the page reports a failure before clicking send", async () => {
    const { bg, calls, status } = setup([ws([note("n1", "pending")])], { ok: false, sent: false, reason: "composer_not_ready" });
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["GET /state", "POST /claim", "POST /requeue"]);
    expect(status()).toBe("发送 c1 失败：composer_not_ready");
  });

  it("never resends while a claimed notification exists", async () => {
    const { bg, calls, sent } = setup([ws([note("n1", "claimed"), note("n2", "pending")])], { observed: false });
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls).toEqual(["GET /state"]);
    expect(sent).toEqual([{ type: "c2c.check", text: "msg\nATTEMPT_ID: n1", attemptId: "n1" }]);
  });

  it("acks a claimed notification once the page shows the message", async () => {
    const { bg, calls } = setup([ws([note("n1", "claimed"), note("n2", "pending")])], { observed: true });
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls.map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["GET /state", "POST /ack"]);
    expect(calls[1]).toContain('"id":"n1"');
  });

  it("ignores workspaces bound to another conversation or unbound", async () => {
    const { bg, calls } = setup([
      ws([note("n1", "pending")], "https://chatgpt.com/c/other"),
      ws([note("n2", "pending")], null, "b".repeat(12)),
    ]);
    await bg.heartbeat({ safety: SAFE }, tab);
    expect(calls).toEqual(["GET /state"]);
  });

  it("does nothing on an unsafe page", async () => {
    const { bg, calls, status } = setup([ws([note("n1", "pending")])]);
    await bg.heartbeat({ safety: { safe: false, reasons: ["generating"] } }, tab);
    expect(calls).toEqual(["GET /state"]);
    expect(status()).toBe("页面未就绪：generating");
  });

  it("does not report status for an unconnected conversation page", async () => {
    const { bg, status } = setup([ws([note("n1", "pending")], "https://chatgpt.com/c/other")]);
    await bg.heartbeat({ safety: { safe: false, reasons: ["composer_dirty"] } }, tab);
    expect(status()).toBeUndefined();
  });

  it("releases the tab when the page never answers", async () => {
    vi.useFakeTimers();
    try {
      const { bg, calls, sent, status } = setup([ws([note("n1", "pending")])], new Promise(() => {}));
      const first = bg.heartbeat({ safety: SAFE }, tab);
      while (!sent.length) await Promise.resolve(); // 超时计时器与 sendMessage 同步注册
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      expect(status()).toBe("发送 c1 失败：页面无响应");
      await bg.heartbeat({ safety: { safe: false, reasons: ["generating"] } }, tab); // 未被 inFlight 跳过
      expect(calls.filter((c) => c.startsWith("GET /state"))).toHaveLength(2);
      expect(status()).toBe("页面未就绪：generating");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles one delivery per tab at a time", async () => {
    const { bg, calls } = setup([ws([note("n1", "pending")])]);
    await Promise.all([bg.heartbeat({ safety: SAFE }, tab), bg.heartbeat({ safety: SAFE }, tab)]);
    expect(calls.filter((c) => c.startsWith("POST /claim"))).toHaveLength(1);
  });

  it("connect uses the active tab and rejects non-conversation pages", async () => {
    const { bg, calls } = setup([]);
    await bg.handle({ type: "c2c.connect", workspaceId: "a".repeat(12) });
    expect(calls[0]).toContain(`"conversationUrl":"${CONV}"`);
    expect(conversationId("https://chatgpt.com/")).toBeNull();
    expect(conversationId("http://chatgpt.com/c/x")).toBeNull();
    expect(conversationId("https://evil.example/c/x")).toBeNull();
  });
});

describe("build-browser-companion", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "scripts", "build-browser-companion.mjs")], { stdio: "pipe" });
  });

  it("emits manifest files and classic content scripts that expose the DOM API", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
    const scripts: string[] = manifest.content_scripts[0].js;
    expect(scripts).toEqual(["dom-adapter-global.js", "turn-observer-global.js", "composer-write-adapter.js", "send-click-adapter.js", "content.js"]);
    for (const f of [...scripts, manifest.background.service_worker, manifest.action.default_popup, "popup/popup.js"]) {
      expect(fs.existsSync(path.join(dist, f)), f).toBe(true);
    }
    const ctx = vm.createContext({});
    for (const f of scripts.filter((s) => s !== "content.js")) {
      expect(() => new Function(fs.readFileSync(path.join(dist, f), "utf8")), f).not.toThrow();
      vm.runInContext(fs.readFileSync(path.join(dist, f), "utf8"), ctx);
    }
    for (const name of ["observeChatGptSafety", "resolveChatGptComposer", "resolveChatGptAction", "findCanonicalUserTurn", "__c2cWriteCanonicalMessage", "__c2cReadCanonicalComposerText", "__c2cDispatchNativeSend", "__c2cClearComposerIfExact"]) {
      expect(typeof ctx[name], name).toBe("function");
    }
    expect(() => new Function(fs.readFileSync(path.join(dist, "content.js"), "utf8"))).not.toThrow();
  });
});
