/**
 * Popup: ownership status via content script → SW (real MessageSender identity).
 * Unbind goes directly to SW.
 */
(function () {
  "use strict";

  const els = {
    pageRoute: document.getElementById("page-route"),
    targetRoute: document.getElementById("target-route"),
    ownerStatus: document.getElementById("owner-status"),
    domSafety: document.getElementById("dom-safety"),
    bind: document.getElementById("bind"),
    unbind: document.getElementById("unbind"),
  };

  function setText(el, text, cls) {
    el.textContent = text;
    el.className = "value" + (cls ? " " + cls : "");
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
  }

  async function pageStatus(tabId) {
    return chrome.tabs.sendMessage(tabId, { type: "c2c.status.request" });
  }

  async function swUnbind() {
    return chrome.runtime.sendMessage({ type: "c2c.unbind" });
  }

  async function refresh() {
    const tab = await activeTab();
    const href = tab?.url ?? "";
    let parsed = null;
    try {
      parsed = parseChatgptConversationRoute(href, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      });
    } catch {
      parsed = null;
    }
    setText(
      els.pageRoute,
      parsed ? parsed.canonical : href || "(非 ChatGPT conversation)",
      parsed ? "ok" : "bad",
    );

    let safety = null;
    let status = null;
    if (tab?.id != null && parsed) {
      try {
        safety = await chrome.tabs.sendMessage(tab.id, { type: "c2c.popup.ping" });
      } catch {
        safety = null;
      }
      try {
        status = await pageStatus(tab.id);
      } catch {
        status = null;
      }
    }

    if (safety && safety.safety) {
      const s = safety.safety;
      setText(
        els.domSafety,
        `composer=${s.composer} generation=${s.generation} safe=${s.safe}`,
        s.safe ? "ok" : "warn",
      );
    } else {
      setText(els.domSafety, "content script 未响应（请刷新 ChatGPT 页面）", "warn");
    }

    const target = status?.targetRoute ?? null;
    setText(els.targetRoute, target || "未绑定", target ? "ok" : "warn");

    if (status?.isOwner === true) {
      setText(els.ownerStatus, "是 owner", "ok");
    } else if (status?.ownership?.hasOwner) {
      setText(els.ownerStatus, "已有 owner，但不是当前 document", "warn");
    } else {
      setText(els.ownerStatus, "否", target ? "bad" : "");
    }

    els.bind.disabled = !parsed || !tab?.id;
    els.bind.onclick = async () => {
      if (!tab?.id || !parsed) return;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "c2c.bind.request" });
        await refresh();
        if (!res?.ok) {
          setText(els.ownerStatus, `绑定失败: ${res?.reason || "unknown"}`, "bad");
        }
      } catch {
        setText(els.ownerStatus, "绑定失败: content script 不可用", "bad");
      }
    };

    els.unbind.onclick = async () => {
      await swUnbind();
      await refresh();
    };
  }

  refresh().catch(() => {
    setText(els.pageRoute, "popup 初始化失败", "bad");
  });
})();
