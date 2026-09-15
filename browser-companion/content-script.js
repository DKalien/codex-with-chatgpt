/**
 * Content script: passive SPA route observation + read-only DOM safety.
 * Never receives companion credentials. Never mutates ChatGPT DOM. Never sends.
 */
(function () {
  "use strict";
  if (window.__c2cCompanionLoaded) return;
  window.__c2cCompanionLoaded = true;

  let lastHref = location.href;
  let generation = 1;

  function parseRoute(href) {
    try {
      if (typeof parseChatgptConversationRoute !== "function") return null;
      return parseChatgptConversationRoute(href, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      });
    } catch {
      return null;
    }
  }

  function observeSafety() {
    try {
      if (typeof observeChatGptSafety !== "function") {
        return {
          safe: false,
          reasons: ["adapter_missing"],
          composer: "unknown",
          generation: "unknown",
          adapterSupported: false,
          routeValid: false,
        };
      }
      const parsed = parseRoute(location.href);
      return observeChatGptSafety(document, { routeValid: Boolean(parsed) });
    } catch {
      return {
        safe: false,
        reasons: ["adapter_error"],
        composer: "unknown",
        generation: "unknown",
        adapterSupported: false,
        routeValid: false,
      };
    }
  }

  function buildObserveMessage() {
    const parsed = parseRoute(location.href);
    const safety = observeSafety();
    return {
      type: "c2c.observe",
      href: location.href,
      canonicalRoute: parsed ? parsed.canonical : null,
      generation,
      safety: {
        composer: safety.composer,
        generation: safety.generation,
        safe: safety.safe,
        adapterSupported: safety.adapterSupported,
        routeValid: safety.routeValid,
        reasons: safety.reasons,
      },
    };
  }

  function sendToWorker(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: "runtime_error" });
            return;
          }
          resolve(response ?? { ok: false, reason: "empty" });
        });
      } catch {
        resolve({ ok: false, reason: "runtime_throw" });
      }
    });
  }

  function report() {
    void sendToWorker(buildObserveMessage());
  }

  function heartbeat() {
    void sendToWorker({ ...buildObserveMessage(), type: "c2c.heartbeat" });
  }

  function onMaybeNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    generation += 1;
    report();
  }

  setInterval(onMaybeNavigate, 800);
  // E1b2: periodic passive freshness evidence (~5s)
  setInterval(heartbeat, 5000);
  window.addEventListener("popstate", onMaybeNavigate);
  window.addEventListener("hashchange", onMaybeNavigate);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      report();
      heartbeat();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, reason: "bad_message" });
      return false;
    }
    if (message.type === "c2c.popup.ping") {
      const msg = buildObserveMessage();
      sendResponse({
        ok: true,
        href: msg.href,
        canonicalRoute: msg.canonicalRoute,
        safety: msg.safety,
      });
      return false;
    }
    if (message.type === "c2c.status.request") {
      // Forward to SW so MessageSender is this real ChatGPT document.
      const msg = buildObserveMessage();
      void sendToWorker({ ...msg, type: "c2c.status.page" }).then((response) => {
        sendResponse(response);
      });
      return true;
    }
    if (message.type === "c2c.bind.request") {
      const msg = buildObserveMessage();
      void sendToWorker({ ...msg, type: "c2c.bind" }).then((response) => {
        sendResponse(response);
      });
      return true;
    }
    if (message.type === "c2c.owner-proof.request") {
      // Carry current route/safety so SW can atomically refresh before mint.
      void sendToWorker({ ...buildObserveMessage(), type: "c2c.owner-proof.request" }).then((response) => {
        sendResponse(response);
      });
      return true;
    }
    if (message.type === "c2c.reserve.request") {
      // Reserve uses MessageSender identity only; payload tab/document ignored by SW.
      void sendToWorker({ ...buildObserveMessage(), type: "c2c.reserve.page" }).then((response) => {
        sendResponse(response);
      });
      return true;
    }
    return false;
  });

  report();
})();
