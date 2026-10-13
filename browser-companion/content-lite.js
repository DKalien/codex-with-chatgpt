/** 页面只报告 DOM 状态、执行 Bridge 单次许可、观察结果；不持有连接凭据。 */
(function () {
  "use strict";
  if (globalThis.__c2cLightLoaded) return;
  globalThis.__c2cLightLoaded = true;
  let busy = false;
  const send = message => chrome.runtime.sendMessage(message);
  const safety = () => {
    try { return observeChatGptSafety(document, { routeValid: true }); }
    catch { return { safe: false, composer: "unknown", generation: "unknown" }; }
  };
  function heartbeat() {
    void send({ type: "c2c.light.heartbeat", href: location.href, safety: safety() }).catch(() => {});
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function execute(request) {
    const delivery = request.delivery;
    if (!delivery || typeof delivery.message !== "string" || !delivery.message
      || typeof delivery.attemptId !== "string" || typeof delivery.eventId !== "string") {
      return { ok: false, reason: "delivery_invalid" };
    }
    const result = { eventId: delivery.eventId, attemptId: delivery.attemptId, wrote: false, clicked: false, observed: false };
    const samePage = () => location.href === request.expectedHref;
    const observed = () => samePage() && findCanonicalUserTurn(document, delivery).ok === true;
    if (!samePage()) return { ...result, ok: false, reason: "page_changed" };
    if (request.type === "c2c.light.observe") return { ...result, ok: true, observed: observed() };
    if (busy) return { ...result, ok: false, reason: "dom_busy" };
    busy = true;
    try {
      if (!safety().safe) return { ...result, ok: false, reason: "composer_not_ready" };
      const wrote = globalThis.__c2cWriteCanonicalMessage(document, delivery.message, { routeValid: true, mutationGuard: samePage });
      result.wrote = wrote.wrote === true;
      if (!wrote.ok) return { ...result, ok: false, reason: wrote.reason };
      // 编辑器启用 Send 可能晚于 input 事件；只等待，不重复写入或点击。
      const readyUntil = Date.now() + 3000;
      while (samePage() && Date.now() < readyUntil) {
        const { editor } = resolveChatGptComposer(document);
        const action = resolveChatGptAction(document, editor);
        if (action.kind === "send" && action.enabled) break;
        if (action.kind === "stop" || action.kind === "unknown") break;
        await wait(100);
      }
      const clicked = globalThis.__c2cDispatchNativeSend(document, delivery.message, { routeValid: true, mutationGuard: samePage });
      result.clicked = clicked.ok === true;
      if (!clicked.ok) return { ...result, ok: false, reason: clicked.reason };
      const deadline = Date.now() + 10000;
      do {
        if (observed()) return { ...result, ok: true, observed: true };
        if (!samePage()) return { ...result, ok: false, reason: "page_changed" };
        await wait(200);
      } while (Date.now() < deadline);
      return { ...result, ok: false, reason: "observation_pending" };
    } catch { return { ...result, ok: false, reason: "dom_execution_failed" }; }
    finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (["c2c.light.pair.request", "c2c.light.connect.request"].includes(message?.type)) {
      const forwarded = { type: message.type.replace(".request", ""), workspaceId: message.workspaceId };
      if (message.type === "c2c.light.pair.request") Object.assign(forwarded, {
        bridgeOrigin: message.bridgeOrigin, intentId: message.intentId, secret: message.secret,
      });
      void send(forwarded).then(respond, () => respond({ ok: false, reason: "extension_unavailable" }));
      return true;
    }
    if (["c2c.light.deliver", "c2c.light.observe"].includes(message?.type)) {
      void execute(message).then(respond, () => respond({ ok: false, reason: "dom_execution_failed" }));
      return true;
    }
    return false;
  });
  setInterval(heartbeat, 5000);
  window.addEventListener("pageshow", heartbeat);
  window.addEventListener("focus", heartbeat);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) heartbeat(); });
  heartbeat();
})();
