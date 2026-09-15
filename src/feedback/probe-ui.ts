/**
 * Phase E 反馈探针组件资产。
 * 轮询 / follow-up / MCP Apps JSON-RPC bridge 各有唯一实现；HTML 通过 Function.toString 嵌入。
 */
import { buildFollowUpPrompt } from "./probe-store.js";

export const PROBE_UI_TITLE = "C2C Feedback Probe";
export { buildFollowUpPrompt };

/** 标准 message transport 的 JSON-RPC 方法。 */
export const UI_INITIALIZE_METHOD = "ui/initialize";
export const UI_INITIALIZED_NOTIFICATION = "ui/notifications/initialized";
export const UI_MESSAGE_METHOD = "ui/message";
export const UI_PROTOCOL_VERSION = "2026-01-26";
export const UI_BRIDGE_TIMEOUT_MS = 8_000;

export type BridgeState = "initializing" | "standard" | "initialized_no_message" | "unavailable";
export type InitOutcome =
  | "pending"
  | "ok"
  | "timeout"
  | "rpc_error"
  | "post_error"
  | "invalid_result";

/**
 * 解析 resolved MCP result：isError:true 时抛出带 code 的错误。
 * 内联保证 toString 后浏览器可运行。
 */
function normalizeToolResult(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
    };
    if (obj.isError) {
      let code = "PROBE_TOOL_ERROR";
      let message = "tool call failed";
      const text = Array.isArray(obj.content)
        ? obj.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n")
        : "";
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          if (parsed && typeof parsed.error === "string" && parsed.error) code = parsed.error;
          if (parsed && typeof parsed.message === "string" && parsed.message) message = parsed.message;
        } catch { /* keep defaults */ }
      }
      const err = new Error(message) as Error & { code?: string };
      err.code = code;
      throw err;
    }
    if (obj.structuredContent && typeof obj.structuredContent === "object" && !Array.isArray(obj.structuredContent)) {
      return obj.structuredContent as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

/** 与 probe-store.unwrapToolResult 语义一致（成功路径）。 */
function unwrapToolResult(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as { structuredContent?: unknown };
    if (obj.structuredContent && typeof obj.structuredContent === "object" && !Array.isArray(obj.structuredContent)) {
      return obj.structuredContent as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

export { normalizeToolResult, unwrapToolResult };

export interface BridgeTimerHandle { }

export interface McpAppsBridgeDeps {
  postMessage: (message: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: unknown;
};

/**
 * 极小 MCP Apps JSON-RPC postMessage bridge。
 * 只接受 parent + jsonrpc 2.0；不猜 origin；不触 DOM/私有 API。
 */
export class McpAppsBridge {
  state: BridgeState = "initializing";
  hostCapabilities: unknown = null;
  messageTransportAvailable = false;
  negotiatedProtocol: string | null = null;
  /** 窄诊断：不暴露 hostContext/session/token/完整 caps。 */
  initOutcome: InitOutcome = "pending";
  initDetail: {
    rpcErrorCode?: number | string;
    rpcErrorMessage?: string;
    messageText?: boolean;
    serverTools?: boolean;
    serverResources?: boolean;
  } = {};
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private deps: McpAppsBridgeDeps;

  constructor(deps: McpAppsBridgeDeps) {
    this.deps = deps;
  }

  /** 仅处理 parent 的 JSON-RPC 2.0 响应；重复/未知 id 忽略。 */
  handleMessage(data: unknown, source: unknown, parent: unknown): boolean {
    if (source !== parent) return false;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const msg = data as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };
    if (msg.jsonrpc !== "2.0") return false;
    if (typeof msg.id !== "number" || !Number.isFinite(msg.id)) return false;
    const entry = this.pending.get(msg.id);
    if (!entry) return false;
    this.pending.delete(msg.id);
    this.clearTimer(entry.timer);
    if (msg.error) {
      const err = msg.error as { code?: number | string; message?: string };
      const e = new Error(err && typeof err.message === "string" ? err.message : "jsonrpc error") as Error & { code?: number | string };
      if (err && (typeof err.code === "number" || typeof err.code === "string")) e.code = err.code;
      entry.reject(e);
      return true;
    }
    entry.resolve(msg.result);
    return true;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      const timer = setTimer(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const e = new Error("bridge timeout: " + method) as Error & { code?: string };
        e.code = "PROBE_BRIDGE_TIMEOUT";
        reject(e);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.deps.postMessage(payload);
      } catch (error) {
        this.pending.delete(id);
        this.clearTimer(timer);
        const e = error instanceof Error ? error : new Error(String(error));
        (e as Error & { code?: string }).code = "PROBE_BRIDGE_POST_ERROR";
        reject(e);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.deps.postMessage({ jsonrpc: "2.0", method, params });
  }

  private clearTimer(handle: unknown): void {
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    try { clear(handle); } catch { /* ignore */ }
  }

  private truncateMessage(msg: string): string {
    return msg.length > 120 ? msg.slice(0, 120) : msg;
  }

  /**
   * ui/initialize → 保存窄诊断 → initialized notification。
   * 成功（合法 result）与 transport 失败分开；无 message 不等于 unavailable。
   */
  async initialize(timeoutMs: number = UI_BRIDGE_TIMEOUT_MS): Promise<{
    ok: boolean;
    messageTransport: boolean;
    outcome: InitOutcome;
  }> {
    try {
      const result = await this.request(UI_INITIALIZE_METHOD, {
        protocolVersion: UI_PROTOCOL_VERSION,
        appInfo: { name: "c2c-feedback-probe", version: "1" },
        appCapabilities: {},
      }, timeoutMs);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        this.initOutcome = "invalid_result";
        this.state = "unavailable";
        this.messageTransportAvailable = false;
        return { ok: false, messageTransport: false, outcome: this.initOutcome };
      }
      const init = result as {
        protocolVersion?: unknown;
        hostCapabilities?: {
          message?: { text?: unknown };
          tools?: unknown;
          resources?: unknown;
        } | null;
      };
      this.negotiatedProtocol = typeof init.protocolVersion === "string" ? init.protocolVersion : null;
      const caps = init.hostCapabilities && typeof init.hostCapabilities === "object"
        ? init.hostCapabilities
        : null;
      this.hostCapabilities = caps;
      this.initDetail.messageText = !!(caps && caps.message && caps.message.text !== undefined);
      this.initDetail.serverTools = !!(caps && caps.tools !== undefined);
      this.initDetail.serverResources = !!(caps && caps.resources !== undefined);
      this.messageTransportAvailable = this.initDetail.messageText === true;
      this.state = this.messageTransportAvailable ? "standard" : "initialized_no_message";
      this.initOutcome = "ok";
      this.notify(UI_INITIALIZED_NOTIFICATION, {});
      return { ok: true, messageTransport: this.messageTransportAvailable, outcome: this.initOutcome };
    } catch (error) {
      const e = error as { code?: string | number; message?: string };
      if (e && e.code === "PROBE_BRIDGE_TIMEOUT") {
        this.initOutcome = "timeout";
      } else if (e && e.code === "PROBE_BRIDGE_POST_ERROR") {
        this.initOutcome = "post_error";
        this.initDetail.rpcErrorMessage = this.truncateMessage(e.message || "postMessage failed");
      } else if (e && (typeof e.code === "number" || typeof e.code === "string")) {
        this.initOutcome = "rpc_error";
        this.initDetail.rpcErrorCode = e.code;
        this.initDetail.rpcErrorMessage = this.truncateMessage(e.message || "jsonrpc error");
      } else {
        this.initOutcome = "rpc_error";
        this.initDetail.rpcErrorMessage = this.truncateMessage((error as Error)?.message || String(error));
      }
      this.state = "unavailable";
      this.messageTransportAvailable = false;
      return { ok: false, messageTransport: false, outcome: this.initOutcome };
    }
  }

  /**
   * 标准 ui/message。schema 只有 isError?；不从 result.messageId/id 推导 sent。
   * 发出后绝不 fallback alias；成功 resolve 也只表示“已尝试”，调用方应 outcome_unknown。
   */
  async sendUserMessage(
    prompt: string,
    timeoutMs: number = UI_BRIDGE_TIMEOUT_MS,
  ): Promise<{ attempted: boolean; transport: "ui/message"; failed?: boolean; reason?: string }> {
    if (!this.messageTransportAvailable || this.state !== "standard") {
      return { attempted: false, transport: "ui/message", failed: true, reason: "message transport unavailable" };
    }
    try {
      const result = await this.request(UI_MESSAGE_METHOD, {
        role: "user",
        content: [{ type: "text", text: prompt }],
      }, timeoutMs);
      if (result && typeof result === "object" && (result as { isError?: boolean }).isError === true) {
        return { attempted: false, transport: "ui/message", failed: true, reason: "isError" };
      }
      // {} 或 {isError:false}：已尝试发送，仍无持久 messageId → outcome_unknown
      return { attempted: true, transport: "ui/message" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { attempted: false, transport: "ui/message", failed: true, reason };
    }
  }

  teardown(): void {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of entries) {
      this.clearTimer(entry.timer);
      const e = new Error("bridge teardown") as Error & { code?: string };
      e.code = "PROBE_BRIDGE_TEARDOWN";
      entry.reject(e);
    }
  }
}

export interface ProbePollDeps {
  now: () => number;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  isStopped: () => boolean;
}

export interface ProbePollConfig {
  bindingId: string;
  epoch: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  maxLifetimeMs?: number;
}

export type ProbePollOutcome =
  | { kind: "stopped" }
  | { kind: "timeout" }
  | { kind: "claimed"; probeId: string; attemptId: string; payload: string; payloadDigest: string; epoch: number }
  | { kind: "claim_conflict"; status: string }
  | { kind: "error"; code?: string; message: string };

/**
 * 唯一轮询实现：组件与离线测试共用。
 * 等待绑定上的未知未来 ready 事件；deadline 是主边界，默认覆盖完整 15 分钟。
 */
export async function pollForProbeEvent(
  config: ProbePollConfig,
  deps: ProbePollDeps,
): Promise<ProbePollOutcome> {
  const interval = config.pollIntervalMs ?? 3000;
  const lifetime = config.maxLifetimeMs ?? 900000;
  const maxAttempts = config.maxAttempts ?? Math.ceil(lifetime / interval);
  const deadline = deps.now() + lifetime;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (deps.isStopped()) return { kind: "stopped" };
    if (deps.now() >= deadline) return { kind: "timeout" };
    try {
      const raw = await deps.callTool("probe_status", {});
      const status = unwrapToolResult(raw) as {
        events?: Array<Record<string, unknown>>;
        binding?: Record<string, unknown> | null;
      };
      const binding = status.binding;
      if (!binding || binding.status !== "active" || binding.epoch !== config.epoch) {
        return { kind: "stopped" };
      }
      const event = (status.events ?? []).find((e) => e.status === "ready");
      if (event && typeof event.probeId === "string" && event.probeId) {
        const claimedRaw = await deps.callTool("probe_claim_event", {
          probeId: event.probeId,
          bindingId: config.bindingId,
          epoch: config.epoch,
        });
        const claimed = unwrapToolResult(claimedRaw) as {
          event?: { payload?: string; payloadDigest?: string; epoch?: number };
          attemptId?: string;
        };
        if (!claimed.attemptId || !claimed.event?.payload || !claimed.event?.payloadDigest) {
          return { kind: "error", message: "claim 返回缺少 attempt/payload/digest" };
        }
        return {
          kind: "claimed",
          probeId: event.probeId,
          attemptId: claimed.attemptId,
          payload: claimed.event.payload,
          payloadDigest: claimed.event.payloadDigest,
          epoch: typeof claimed.event.epoch === "number" ? claimed.event.epoch : config.epoch,
        };
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PROBE_EVENT_CLAIM_CONFLICT") {
        return { kind: "claim_conflict", status: "claimed_elsewhere" };
      }
      if (code === "PROBE_EPOCH_STALE") return { kind: "stopped" };
      if (code === "PROBE_PRINCIPAL_MISMATCH") return { kind: "stopped" };
      if (code === "PROBE_CHAT_IDENTITY_UNAVAILABLE") return { kind: "stopped" };
      if (code === "INSUFFICIENT_SCOPE") {
        return { kind: "error", code, message: (error as Error).message || "insufficient scope" };
      }
    }
    if (deps.isStopped()) return { kind: "stopped" };
    if (deps.now() + interval >= deadline) return { kind: "timeout" };
    await deps.sleep(interval);
  }
  return { kind: "timeout" };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderProbeHtml(): string {
  const pollSource = pollForProbeEvent.toString();
  const followUpSource = buildFollowUpPrompt.toString();
  const normalizeSource = normalizeToolResult.toString();
  const bridgeClassSource = McpAppsBridge.toString();
  // 浏览器侧常量必须来自同一 TS 导出，避免 McpAppsBridge free variable ReferenceError。
  const runtimeConsts = [
    `var UI_INITIALIZE_METHOD = ${JSON.stringify(UI_INITIALIZE_METHOD)};`,
    `var UI_INITIALIZED_NOTIFICATION = ${JSON.stringify(UI_INITIALIZED_NOTIFICATION)};`,
    `var UI_MESSAGE_METHOD = ${JSON.stringify(UI_MESSAGE_METHOD)};`,
    `var UI_PROTOCOL_VERSION = ${JSON.stringify(UI_PROTOCOL_VERSION)};`,
    `var UI_BRIDGE_TIMEOUT_MS = ${JSON.stringify(UI_BRIDGE_TIMEOUT_MS)};`,
  ].join("\n  ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${PROBE_UI_TITLE}</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; padding: 12px; background: transparent; color: inherit; }
main { border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 12px; }
h1 { font-size: 14px; margin: 0 0 8px; }
dl { display: grid; grid-template-columns: 110px 1fr; gap: 4px 8px; font-size: 12px; margin: 0 0 10px; }
dt { opacity: .7; }
dd { margin: 0; word-break: break-all; }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.5); background: transparent; cursor: pointer; }
button:disabled { opacity: .45; cursor: not-allowed; }
#status { font-size: 12px; margin-top: 8px; min-height: 1.2em; }
.note { font-size: 11px; opacity: .75; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>${PROBE_UI_TITLE}</h1>
  <dl>
    <dt>workspace</dt><dd id="workspaceId">—</dd>
    <dt>binding</dt><dd id="bindingId">—</dd>
    <dt>epoch</dt><dd id="epoch">—</dd>
    <dt>principal</dt><dd id="principal">—</dd>
    <dt>ownsBinding</dt><dd id="ownsBinding">—</dd>
    <dt>bridge</dt><dd id="bridge">initializing</dd>
    <dt>init.outcome</dt><dd id="initOutcome">pending</dd>
    <dt>protocol</dt><dd id="protocol">—</dd>
    <dt>host.message</dt><dd id="hostMessage">no</dd>
    <dt>host.serverTools</dt><dd id="hostServerTools">no</dd>
    <dt>event</dt><dd id="event">idle</dd>
  </dl>
  <div class="row">
    <button id="enable" type="button">启用 / 复用绑定</button>
    <button id="takeover" type="button">明确接管</button>
    <button id="stop" type="button" disabled>停止</button>
  </div>
  <div id="status"></div>
  <p class="note">自动测试事件，不是用户新授权。仅只读核验。事件由本机 CLI emit；发送走标准 ui/message，失败不换接口重发。</p>
</main>
<script>
(function () {
  "use strict";
  ${runtimeConsts}
  ${pollSource}
  ${followUpSource}
  ${normalizeSource}
  ${bridgeClassSource}
  var unwrapToolResult = ${unwrapToolResult.toString()};
  var host = (typeof window !== "undefined" && window.openai) || null;
  var state = { polling: false, stop: false, bindingId: null, epoch: null, principalFingerprint: null, ownsBinding: false };
  var bridge = new McpAppsBridge({
    postMessage: function (message) {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    },
  });

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? "—" : String(value);
  }
  function setStatus(msg) {
    var el = document.getElementById("status");
    if (el) el.textContent = msg;
  }
  function setBridgeDiagnostics() {
    setText("bridge", bridge.state);
    setText("initOutcome", bridge.initOutcome);
    setText("protocol", bridge.negotiatedProtocol);
    setText("hostMessage", bridge.messageTransportAvailable ? "yes" : "no");
    setText("hostServerTools", bridge.initDetail && bridge.initDetail.serverTools ? "yes" : "no");
  }
  function callTool(name, args) {
    if (!host || typeof host.callTool !== "function") {
      return Promise.reject({ code: "OPENAI_HOST_MISSING", message: "宿主未提供 window.openai.callTool" });
    }
    return Promise.resolve(host.callTool(name, args || {})).then(function (raw) {
      return normalizeToolResult(raw);
    });
  }
  function stopPolling() {
    state.polling = false;
    state.stop = true;
    document.getElementById("stop").disabled = true;
  }
  function applyStatus(status) {
    var binding = status.binding || null;
    state.bindingId = binding ? binding.bindingId : null;
    state.epoch = binding ? binding.epoch : null;
    state.principalFingerprint = binding ? binding.principalFingerprint : null;
    state.ownsBinding = !!status.ownsBinding;
    setText("workspaceId", status.workspaceId);
    setText("bindingId", state.bindingId);
    setText("epoch", state.epoch);
    setText("principal", state.principalFingerprint);
    setText("ownsBinding", state.ownsBinding ? "yes" : "no");
  }

  if (window.addEventListener) {
    window.addEventListener("message", function (event) {
      bridge.handleMessage(event && event.data, event && event.source, window.parent);
    });
  }

  async function ensureBridge() {
    try {
      if (bridge.state === "standard"
        || bridge.state === "initialized_no_message"
        || bridge.state === "unavailable") {
        setBridgeDiagnostics();
        return;
      }
      var init = await bridge.initialize();
      setBridgeDiagnostics();
      if (bridge.state === "initialized_no_message") {
        setStatus("init=ok 但无 message.text；不发送");
      } else if (!init.ok) {
        setStatus("bridge 不可用(" + bridge.initOutcome + ")；不 fallback alias");
      }
    } catch (e) {
      bridge.state = "unavailable";
      bridge.messageTransportAvailable = false;
      if (bridge.initOutcome === "pending") bridge.initOutcome = "rpc_error";
      setBridgeDiagnostics();
      setStatus("bridge 初始化异常: " + (e && e.message ? e.message : e));
    }
  }

  /**
   * 只走标准 ui/message。发出后绝不 fallback 到兼容 alias。
   * 标准结果无 messageId；成功也只是已尝试 → outcome_unknown。
   */
  async function sendFollowUpViaBridge(prompt) {
    await ensureBridge();
    var result = await bridge.sendUserMessage(prompt);
    return result;
  }

  async function startPollingAfterBind() {
    if (state.polling || !state.bindingId) return;
    state.polling = true;
    state.stop = false;
    document.getElementById("stop").disabled = false;
    setStatus("等待未知未来事件…（本机 CLI emit 后自动领取）");
    try {
      var outcome = await pollForProbeEvent({
        bindingId: state.bindingId,
        epoch: state.epoch,
      }, {
        now: function () { return Date.now(); },
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        isStopped: function () { return state.stop; },
        callTool: callTool,
      });
      if (state.stop) { setStatus("已停止"); return; }
      if (outcome.kind === "claimed") {
        setText("event", outcome.probeId + " / sending");
        var prompt = buildFollowUpPrompt({
          probeId: outcome.probeId,
          payloadDigest: outcome.payloadDigest,
          payload: outcome.payload,
          epoch: outcome.epoch,
        }, outcome.attemptId, state.principalFingerprint);
        var sent;
        try {
          sent = await sendFollowUpViaBridge(prompt);
        } catch (e) {
          await callTool("probe_report_send", {
            probeId: outcome.probeId, attemptId: outcome.attemptId, outcome: "outcome_unknown",
          });
          setStatus("发送异常：outcome_unknown，禁止换接口重发");
          stopPolling();
          return;
        }
        // 标准 ui/message 无持久 messageId：成功/失败一律 outcome_unknown，不伪造 sent。
        await callTool("probe_report_send", {
          probeId: outcome.probeId, attemptId: outcome.attemptId, outcome: "outcome_unknown",
        });
        setStatus(sent.failed
          ? ("ui/message 失败(" + (sent.reason || "?") + "): outcome_unknown，不 fallback")
          : "ui/message 已尝试：outcome_unknown，等待 model_observed");
        stopPolling();
        return;
      }
      if (outcome.kind === "claim_conflict") { setStatus("事件已被其它组件领取"); stopPolling(); return; }
      if (outcome.kind === "stopped") { setStatus("绑定已失效或已停止"); stopPolling(); return; }
      setStatus(outcome.kind === "timeout" ? "轮询结束" : ("轮询错误: " + outcome.message));
      stopPolling();
    } catch (e) {
      setStatus("轮询失败: " + (e && e.message ? e.message : e));
      stopPolling();
    }
  }
  async function refreshStatusThenMaybePoll() {
    try {
      var status = unwrapToolResult(await callTool("probe_status", {}));
      applyStatus(status);
      if (status.enabled && status.ownsBinding) {
        setStatus("已持有绑定 epoch=" + state.epoch + "；继续等待事件");
        startPollingAfterBind();
      } else if (status.enabled) {
        setStatus("已有其它主体绑定；请使用明确接管（expectedEpoch=" + state.epoch + "）");
      } else {
        setStatus("探针未启用；可点击启用");
      }
    } catch (e) {
      setStatus("读取状态失败: " + (e && e.message ? e.message : e));
    }
  }
  document.getElementById("enable").addEventListener("click", async function () {
    try {
      var created = unwrapToolResult(await callTool("probe_enable", {
        widgetId: "widget-" + Date.now().toString(36),
      }));
      state.bindingId = created.binding.bindingId;
      state.epoch = created.binding.epoch;
      state.principalFingerprint = created.binding.principalFingerprint;
      state.ownsBinding = true;
      setText("workspaceId", created.workspaceId);
      setText("bindingId", state.bindingId);
      setText("epoch", state.epoch);
      setText("principal", state.principalFingerprint);
      setText("ownsBinding", "yes");
      setStatus("已启用/复用绑定；等待未知未来事件");
      startPollingAfterBind();
    } catch (e) {
      setStatus("启用失败: " + (e && e.message ? e.message : e));
    }
  });
  document.getElementById("takeover").addEventListener("click", async function () {
    try {
      var expected = state.epoch;
      if (expected == null) {
        var st = unwrapToolResult(await callTool("probe_status", {}));
        applyStatus(st);
        expected = state.epoch;
      }
      if (expected == null) {
        setStatus("无法接管：读不到当前 epoch");
        return;
      }
      var taken = unwrapToolResult(await callTool("probe_takeover", {
        widgetId: "widget-" + Date.now().toString(36),
        expectedEpoch: expected,
      }));
      state.stop = true;
      state.bindingId = taken.bindingId;
      state.epoch = taken.epoch;
      state.principalFingerprint = taken.principalFingerprint || state.principalFingerprint;
      state.ownsBinding = true;
      setText("bindingId", state.bindingId);
      setText("epoch", state.epoch);
      setText("ownsBinding", "yes");
      setStatus("已接管 epoch=" + state.epoch + (taken.blockedEvents && taken.blockedEvents.length
        ? ("；阻塞交接: " + taken.blockedEvents.join(",")) : ""));
      state.stop = false;
      startPollingAfterBind();
    } catch (e) {
      setStatus("接管失败: " + (e && e.message ? e.message : e));
    }
  });
  document.getElementById("stop").addEventListener("click", async function () {
    stopPolling();
    try {
      await callTool("probe_stop", {});
      setStatus("已停止并关闭绑定");
    } catch (e) {
      setStatus("停止请求失败: " + (e && e.message ? e.message : e));
    }
  });
  ensureBridge().then(function () {
    refreshStatusThenMaybePoll();
  }).catch(function (e) {
    bridge.state = "unavailable";
    bridge.messageTransportAvailable = false;
    if (bridge.initOutcome === "pending") bridge.initOutcome = "rpc_error";
    setBridgeDiagnostics();
    setStatus("启动异常: " + (e && e.message ? e.message : e));
  });
})();
</script>
</body>
</html>`;
}
