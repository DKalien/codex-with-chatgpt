import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const href = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
function load({ safe = true, observed = true, navigateOnWrite = false } = {}) {
  let handler: any;
  const location = { href };
  const send = vi.fn(async () => ({ ok: true }));
  const write = vi.fn(() => { if (navigateOnWrite) location.href += '?changed'; return { ok: true, wrote: true }; });
  const click = vi.fn((_doc, _text, options) => options.mutationGuard() ? { ok: true, clicked: 1 } : { ok: false, reason: 'page_changed' });
  const context = { chrome: { runtime: { id: 'test', sendMessage: send, onMessage: { addListener: (fn: any) => { handler = fn; } } } },
    location, document: { addEventListener() {} }, window: { addEventListener() {} }, setInterval() {}, setTimeout,
    observeChatGptSafety: () => ({ safe }), findCanonicalUserTurn: () => ({ ok: observed }),
    resolveChatGptComposer: () => ({ editor: {} }), resolveChatGptAction: () => ({ kind: 'send', enabled: true }),
    __c2cWriteCanonicalMessage: write, __c2cDispatchNativeSend: click };
  vm.runInNewContext(fs.readFileSync('browser-companion/content-lite.js', 'utf8'), context);
  return { send, write, click, location, handle: (message: any) => new Promise<any>(resolve => handler(message, { id: 'test' }, resolve)) };
}
// 复用 makeSendDom 的 ProseMirror/原生按钮形状；仅模拟浏览器 DOM 原语。
function loadBuiltClassicChain() {
  let handler: any;
  const state = { blocks: [""], turns: [] as string[], clicks: 0, sendReady: false };
  const sendButton = {
    tagName: "BUTTON", className: "composer-submit-btn composer-submit-button-color", disabled: false,
    getAttribute: (name: string) => name === "data-testid" ? "send-button" : name === "type" ? "submit" : name === "aria-label" ? "发送提示词" : null,
    hasAttribute: (name: string) => name === "data-testid",
    click() {
      state.clicks += 1;
      state.turns.push(state.blocks.join("\n"));
      state.blocks = [""];
      state.sendReady = false;
    },
  };
  const voiceButton = {
    className: "composer-submit-button-color text-submit-btn-text", disabled: false,
    getAttribute: (name: string) => name === "aria-label" ? "启动语音功能" : null,
    hasAttribute: () => false,
  };
  const form = {
    querySelector: (selector: string) => selector === 'button[data-testid="send-button"]' ? state.sendReady ? sendButton : null
      : selector === "button.composer-submit-button-color" ? state.sendReady ? sendButton : voiceButton : null,
    querySelectorAll: (selector: string) => selector === "button" ? [state.sendReady ? sendButton : voiceButton] : [],
  };
  const editor = {
    tagName: "DIV", id: "prompt-textarea", className: "ProseMirror",
    getAttribute: (name: string) => name === "contenteditable" ? "true" : null,
    hasAttribute: () => false,
    closest: (selector: string) => selector === "form" ? form : null,
    focus() {},
    get children() { return state.blocks.map(textContent => ({ tagName: "P", textContent })); },
    get textContent() { return state.blocks.join("\n"); },
  };
  const insert = vi.fn((_command: string, _showUI: boolean, text: string) => {
    state.blocks = text.split("\n");
    state.sendReady = true;
    return true;
  });
  const document = {
    addEventListener() {},
    defaultView: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: insert,
    queryCommandSupported: () => true,
    querySelector: (selector: string) => selector === "#prompt-textarea" ? editor : null,
    querySelectorAll: (selector: string) => selector.includes("conversation-turn") || selector.includes("data-message-author-role")
      ? state.turns.map((text, index) => ({
        getAttribute: (name: string) => name === "data-message-author-role" ? "user" : name === "data-testid" ? `conversation-turn-${index}` : null,
        textContent: text, innerText: text,
        closest: () => ({ getAttribute: () => `conversation-turn-${index}` }),
        querySelector: () => null,
      })) : [],
  };
  const send = vi.fn(async () => ({ ok: true }));
  const context = vm.createContext({ document, location: { href }, window: { addEventListener() {} },
    chrome: { runtime: { id: "test", sendMessage: send, onMessage: { addListener: (listener: any) => { handler = listener; } } } },
    setInterval() {}, setTimeout, URL, console });
  const root = "dist/browser-companion";
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts: string[] = manifest.content_scripts[0].js;
  for (const script of scripts) vm.runInContext(fs.readFileSync(path.join(root, script), "utf8"), context, { filename: script });
  return { state, insert, send, scripts, handle: (message: any) => new Promise<any>(resolve => handler(message, { id: "test" }, resolve)) };
}
const delivery = { eventId: 'event', attemptId: 'attempt', message: 'Bridge result\nATTEMPT_ID: attempt' };
describe('轻量页面执行', () => {
  it('仅执行 Bridge 消息一次并回传正观察', async () => {
    const h = load();
    expect(await h.handle({ type: 'c2c.light.deliver', expectedHref: href, delivery })).toMatchObject({ ok: true, observed: true, eventId: 'event', attemptId: 'attempt' });
    expect(h.write).toHaveBeenCalledTimes(1); expect(h.click).toHaveBeenCalledTimes(1);
  });
  it('恢复只观察，输入框非空也不会修改或点击', async () => {
    const h = load({ safe: false });
    expect(await h.handle({ type: 'c2c.light.observe', expectedHref: href, delivery })).toMatchObject({ observed: true });
    expect(h.write).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
  });
  it('输入框忙时不覆盖草稿', async () => {
    const h = load({ safe: false });
    expect(await h.handle({ type: 'c2c.light.deliver', expectedHref: href, delivery })).toMatchObject({ ok: false, reason: 'composer_not_ready' });
    expect(h.write).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
  });
  it('写入期间页面导航后不会在新页面点击', async () => {
    const h = load({ navigateOnWrite: true });
    expect(await h.handle({ type: 'c2c.light.deliver', expectedHref: href, delivery })).toMatchObject({ ok: false, clicked: false });
    expect(h.click.mock.results[0].value.ok).toBe(false);
  });
  it('转发配对字段而不采信 popup 声称的页面身份', async () => {
    const h = load();
    await h.handle({ type: 'c2c.light.pair.request', workspaceId: 'aaaaaaaaaaaa', bridgeOrigin: 'https://bridge.test', intentId: 'intent', secret: 'secret', tabId: 99, routeCanonical: 'other' });
    expect(h.send).toHaveBeenLastCalledWith({ type: 'c2c.light.pair', workspaceId: 'aaaaaaaaaaaa', bridgeOrigin: 'https://bridge.test', intentId: 'intent', secret: 'secret' });
  });
  it("构建manifest真实六个classic脚本完成一次发送，恢复仅观察", async () => {
    const h = loadBuiltClassicChain();
    expect(h.scripts).toEqual(["route-global.js", "dom-adapter-global.js", "turn-observer-global.js", "composer-write-adapter.js", "send-click-adapter.js", "content-lite.js"]);
    expect(h.send.mock.calls[0][0]).toMatchObject({ type: "c2c.light.heartbeat", safety: { safe: true, composer: "empty", generation: "idle" } });
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const actualDelivery = { eventId: "event", attemptId, message: `本轮执行已结束，请读取结果。\nATTEMPT_ID: ${attemptId}` };
    expect(await h.handle({ type: "c2c.light.deliver", expectedHref: href, delivery: actualDelivery })).toMatchObject({ ok: true, wrote: true, clicked: true, observed: true, eventId: "event", attemptId });
    expect(h.insert).toHaveBeenCalledExactlyOnceWith("insertText", false, actualDelivery.message);
    expect(h.state.turns).toEqual([actualDelivery.message]);
    expect(h.state.clicks).toBe(1);
    expect(await h.handle({ type: "c2c.light.observe", expectedHref: href, delivery: actualDelivery })).toMatchObject({ ok: true, wrote: false, clicked: false, observed: true });
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.state.clicks).toBe(1);
  });
});
