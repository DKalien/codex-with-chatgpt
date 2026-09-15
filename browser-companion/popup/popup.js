/**
 * Popup: ownership via content→SW; pairing/reserve via SW only.
 * Pairing secret is never persisted and never goes through content script.
 */
(function () {
  "use strict";

  const els = {
    pageRoute: document.getElementById("page-route"),
    ownerStatus: document.getElementById("owner-status"),
    domSafety: document.getElementById("dom-safety"),
    bind: document.getElementById("bind"),
    unbind: document.getElementById("unbind"),
    transportStatus: document.getElementById("transport-status"),
    bridgeOrigin: document.getElementById("bridge-origin"),
    intentId: document.getElementById("intent-id"),
    pairSecret: document.getElementById("pair-secret"),
    pair: document.getElementById("pair"),
    fetchState: document.getElementById("fetch-state"),
    reserve: document.getElementById("reserve"),
    release: document.getElementById("release"),
    recover: document.getElementById("recover"),
    clearTransport: document.getElementById("clear-transport"),
    bridgeState: document.getElementById("bridge-state"),
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

  async function clearSecretInputs() {
    els.pairSecret.value = "";
    els.intentId.value = "";
  }

  async function requestBridgePermission(origin) {
    try {
      const url = new URL(origin);
      const pattern = `${url.protocol}//${url.hostname}/*`;
      const granted = await chrome.permissions.request({ origins: [pattern] });
      return granted;
    } catch {
      return false;
    }
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
      } catch { /* ignore */ }
      try {
        status = await pageStatus(tab.id);
      } catch { /* ignore */ }
    }

    if (safety?.safety) {
      const s = safety.safety;
      setText(
        els.domSafety,
        `composer=${s.composer} generation=${s.generation} safe=${s.safe}`,
        s.safe ? "ok" : "warn",
      );
    } else {
      setText(els.domSafety, "content script 未响应", "warn");
    }

    const target = status?.targetRoute ?? null;
    if (status?.isOwner === true) {
      setText(els.ownerStatus, "是 owner", "ok");
    } else if (status?.ownership?.hasOwner) {
      setText(els.ownerStatus, "已有 owner，但不是当前 document", "warn");
    } else {
      setText(els.ownerStatus, "否", target ? "bad" : "");
    }

    const transport = status?.transport ?? null;
    if (transport?.connected) {
      setText(
        els.transportStatus,
        `connected origin=${transport.bridgeOrigin} companion=${transport.companionId}`,
        "ok",
      );
    } else if (transport?.authStale) {
      setText(els.transportStatus, "auth stale — 需重新 pair", "bad");
    } else {
      setText(els.transportStatus, "未配对", "warn");
    }

    const isOwner = status?.isOwner === true;
    const hasTransport = Boolean(transport?.connected);
    els.bind.disabled = !parsed || !tab?.id;
    els.pair.disabled = !isOwner;
    els.fetchState.disabled = !hasTransport;
    els.reserve.disabled = !hasTransport || !isOwner;
    els.release.disabled = !hasTransport;
    els.recover.disabled = !hasTransport;
    els.clearTransport.disabled = !transport;

    els.bind.onclick = async () => {
      if (!tab?.id || !parsed) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "c2c.bind.request" });
      } catch { /* ignore */ }
      await refresh();
    };

    els.unbind.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "c2c.unbind" });
      await refresh();
    };

    els.pair.onclick = async () => {
      const origin = els.bridgeOrigin.value.trim();
      const intentId = els.intentId.value.trim();
      const secret = els.pairSecret.value;
      if (!origin || !intentId || !secret) {
        setText(els.transportStatus, "缺少 origin / intentId / secret", "bad");
        return;
      }
      if (!tab?.id) return;
      try {
        // 1) permission FIRST; 2) mint proof from current document; 3) pair immediately
        const granted = await requestBridgePermission(origin);
        if (!granted) {
          setText(els.transportStatus, "未授予 Bridge origin 权限；transport 禁用", "bad");
          return;
        }
        const tabNow = await activeTab();
        if (!tabNow?.id || tabNow.id !== tab.id) {
          setText(els.transportStatus, "tab 已变化；请重开 popup", "bad");
          return;
        }
        let proof;
        try {
          proof = await chrome.tabs.sendMessage(tabNow.id, { type: "c2c.owner-proof.request" });
        } catch {
          proof = null;
        }
        if (!proof?.ok || !proof.proof?.id) {
          setText(els.transportStatus, `owner proof 失败: ${proof?.reason || "no_content"}`, "bad");
          return;
        }
        const res = await chrome.runtime.sendMessage({
          type: "c2c.pair",
          bridgeOrigin: origin,
          intentId,
          secret,
          ownerProofId: proof.proof.id,
        });
        if (res?.ok) {
          setText(els.transportStatus, "paired", "ok");
        } else {
          setText(els.transportStatus, `pair 失败: ${res?.reason || "unknown"}`, "bad");
        }
        await refresh();
      } catch (e) {
        setText(els.transportStatus, `pair 异常: ${e?.message || "runtime"}`, "bad");
      } finally {
        // Always destroy one-time secret from the form.
        await clearSecretInputs();
      }
    };

    els.fetchState.onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: "c2c.fetch.state" });
      if (res?.ok) {
        setText(
          els.bridgeState,
          `ready=${res.status.pendingReady} reserved=${res.status.reserved} claimed=${res.status.claimed} outcome=${res.status.outcomeUnknown} inFlight=${res.status.inFlight ? res.status.inFlight.status + ":" + res.status.inFlight.eventId : "none"}`,
          "ok",
        );
      } else {
        setText(els.bridgeState, `state 失败: ${res?.reason || "unknown"}`, "bad");
      }
    };

    els.reserve.onclick = async () => {
      if (!tab?.id) return;
      let res;
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: "c2c.reserve.request" });
      } catch {
        res = { ok: false, reason: "no_content" };
      }
      if (res?.ok) {
        setText(els.bridgeState, `reserved ${res.eventId} ${res.reservationId}`, "ok");
      } else {
        setText(els.bridgeState, `reserve 失败: ${res?.reason || "unknown"}`, "bad");
      }
      await refresh();
    };

    els.release.onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: "c2c.release" });
      if (res?.ok) {
        setText(els.bridgeState, "released", "ok");
      } else {
        setText(els.bridgeState, `release 失败: ${res?.reason || "unknown"}`, "bad");
      }
      await refresh();
    };

    els.recover.onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: "c2c.recover" });
      setText(els.bridgeState, JSON.stringify(res?.journal ?? res), res?.ok ? "ok" : "bad");
      await refresh();
    };

    els.clearTransport.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "c2c.transport.clear" });
      await refresh();
    };
  }

  refresh().catch(() => {
    setText(els.pageRoute, "popup 初始化失败", "bad");
  });
})();
