/** 页面只上报 DOM 安全状态，并按后台指令把一条消息写入输入框、点击发送、确认它出现在对话中。 */
(function () {
  "use strict";
  if (globalThis.__c2cLoaded) return;
  globalThis.__c2cLoaded = true;
  let busy = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 只要求输入框为空且未在生成；发送按钮可用性留到点击前由 __c2cDispatchNativeSend 校验
  const safety = () => {
    try {
      const { editor } = resolveChatGptComposer(document);
      if (!editor) return { safe: false, reasons: ["composer_absent"] };
      if (editor.textContent.trim()) return { safe: false, reasons: ["composer_dirty"] };
      if (resolveChatGptAction(document, editor).kind === "stop") return { safe: false, reasons: ["generating"] };
      return { safe: true };
    } catch {
      return { safe: false, reasons: ["dom_error"] };
    }
  };

  function heartbeat() {
    chrome.runtime.sendMessage({ type: "c2c.heartbeat", href: location.href, safety: safety() }).catch(() => {});
  }

  // 每个请求最多写一次、点一次；任何一步失败都直接返回，不重试。
  async function deliver({ text, attemptId }) {
    if (typeof text !== "string" || !text || typeof attemptId !== "string") return { ok: false, reason: "invalid_request" };
    if (busy) return { ok: false, reason: "dom_busy" };
    busy = true;
    const href = location.href;
    const samePage = () => location.href === href;
    let sent = false; // 点击发送之后才为 true；之前失败即确定未发送
    try {
      const s = safety();
      if (!s.safe) return { ok: false, sent, reason: (s.reasons || [])[0] || "composer_not_ready" };
      const wrote = __c2cWriteCanonicalMessage(document, text, { routeValid: true, mutationGuard: samePage });
      if (!wrote.ok) return { ok: false, sent, reason: wrote.reason };
      const readyUntil = Date.now() + 3000;
      while (samePage() && Date.now() < readyUntil) {
        const action = resolveChatGptAction(document, resolveChatGptComposer(document).editor);
        if (action.kind === "send" && action.enabled) break;
        if (action.kind === "stop" || action.kind === "unknown") break;
        await wait(100);
      }
      const clicked = __c2cDispatchNativeSend(document, text, { routeValid: true, mutationGuard: samePage });
      if (!clicked.ok) return { ok: false, sent, reason: clicked.reason };
      sent = true;
      const deadline = Date.now() + 10000;
      do {
        if (!samePage()) return { ok: false, sent, reason: "page_changed" };
        if (findCanonicalUserTurn(document, { message: text, attemptId }).ok) return { ok: true, sent, observed: true };
        await wait(200);
      } while (Date.now() < deadline);
      return { ok: false, sent, reason: "observation_pending" };
    } catch {
      return { ok: false, sent, reason: "dom_execution_failed" };
    } finally {
      // 未点击发送：撤销本次写入（仅当输入框仍与该消息完全一致），避免残留文字卡住后续心跳
      if (!sent && samePage()) __c2cClearComposerIfExact(document, text);
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (message?.type === "c2c.check") { // 只读：页面上是否已有带该 ATTEMPT_ID 的消息
      respond({ observed: findCanonicalUserTurn(document, { message: message.text, attemptId: message.attemptId }).ok });
      return false;
    }
    if (message?.type !== "c2c.deliver") return false;
    deliver(message).then(respond, () => respond({ ok: false, reason: "dom_execution_failed" }));
    return true;
  });

  setInterval(heartbeat, 5000);
  window.addEventListener("focus", heartbeat);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) heartbeat(); });
  heartbeat();
})();
