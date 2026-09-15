/**
 * Popup: ownership via content→SW; pairing/reserve via SW only.
 * Pairing secret NEVER persisted (not local, not session) — popup memory only.
 * Bridge origin: storage.local (not a secret). intentId: storage.session only.
 */
(function () {
  "use strict";

  const LOCAL_ORIGIN_KEY = "c2c_companion_bridge_origin_v1";
  const SESSION_INTENT_KEY = "c2c_companion_pair_intent_v1";

  const els = {
    pageRoute: document.getElementById("page-route"),
    ownerStatus: document.getElementById("owner-status"),
    domSafety: document.getElementById("dom-safety"),
    bind: document.getElementById("bind"),
    unbind: document.getElementById("unbind"),
    transportStatus: document.getElementById("transport-status"),
    bridgeOrigin: document.getElementById("bridge-origin"),
    pairJson: document.getElementById("pair-json"),
    applyPairJson: document.getElementById("apply-pair-json"),
    intentId: document.getElementById("intent-id"),
    pairSecret: document.getElementById("pair-secret"),
    pairHint: document.getElementById("pair-hint"),
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

  async function loadPairingPrefs() {
    try {
      const local = await chrome.storage.local.get(LOCAL_ORIGIN_KEY);
      if (typeof local[LOCAL_ORIGIN_KEY] === "string" && local[LOCAL_ORIGIN_KEY]) {
        els.bridgeOrigin.value = local[LOCAL_ORIGIN_KEY];
      }
    } catch { /* ignore */ }
    try {
      const session = await chrome.storage.session.get(SESSION_INTENT_KEY);
      if (typeof session[SESSION_INTENT_KEY] === "string" && session[SESSION_INTENT_KEY]) {
        els.intentId.value = session[SESSION_INTENT_KEY];
      }
    } catch { /* ignore */ }
  }

  async function saveBridgeOrigin(origin) {
    const value = (origin ?? "").trim();
    if (!value) return;
    try {
      await chrome.storage.local.set({ [LOCAL_ORIGIN_KEY]: value });
    } catch { /* ignore */ }
  }

  async function saveIntentSession(intentId) {
    try {
      if (intentId) {
        await chrome.storage.session.set({ [SESSION_INTENT_KEY]: intentId });
      } else {
        await chrome.storage.session.remove(SESSION_INTENT_KEY);
      }
    } catch { /* ignore */ }
  }

  /** Destroy secret from DOM + clear session intentId. Never touch secret storage. */
  async function clearPairingForm({ includeIntent = true } = {}) {
    els.pairSecret.value = "";
    els.pairJson.value = "";
    if (includeIntent) {
      els.intentId.value = "";
      await saveIntentSession(null);
    }
  }

  function extractPairingFields(raw) {
    let text = (raw ?? "").trim();
    if (!text) return null;
    // Tolerate markdown fences / surrounding prose: take first JSON object.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced?.[1]) text = fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const intentId = typeof obj.intentId === "string" ? obj.intentId.trim() : "";
    const secret = typeof obj.secret === "string" ? obj.secret : "";
    if (!intentId || !secret) return null;
    return { intentId, secret };
  }

  async function requestBridgePermission(origin) {
    try {
      const url = new URL(origin);
      const pattern = `${url.protocol}//${url.hostname}/*`;
      return await chrome.permissions.request({ origins: [pattern] });
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
      // Remember last connected origin (not a secret).
      if (transport.bridgeOrigin) {
        els.bridgeOrigin.value = transport.bridgeOrigin;
        void saveBridgeOrigin(transport.bridgeOrigin);
      }
    } else if (transport?.authStale) {
      setText(els.transportStatus, "auth stale — 需重新 pair", "bad");
    } else {
      setText(els.transportStatus, "未配对", "warn");
    }

    const isOwner = status?.isOwner === true;
    const hasTransport = Boolean(transport?.connected);
    els.bind.disabled = !parsed || !tab?.id;
    els.pair.disabled = !isOwner;
    els.applyPairJson.disabled = false;
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

    els.applyPairJson.onclick = async () => {
      const fields = extractPairingFields(els.pairJson.value);
      if (!fields) {
        els.pairHint.textContent = "无法从 JSON 提取 intentId + secret；请粘贴完整 pairing 输出。";
        els.pairHint.className = "note bad";
        return;
      }
      els.intentId.value = fields.intentId;
      els.pairSecret.value = fields.secret;
      await saveIntentSession(fields.intentId);
      els.pairJson.value = "";
      els.pairHint.textContent = "已提取 intentId / secret（secret 仅内存）。立即 Pair。";
      els.pairHint.className = "note ok";
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
      await saveBridgeOrigin(origin);
      await saveIntentSession(intentId);
      try {
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
        // refresh() rewrites transport-status; apply pair result AFTER it so HTTP reason is kept.
        await refresh();
        const failReason = res?.reason
          || (typeof res?.status === "number" ? `http_${res.status}` : "unknown");
        if (res?.ok) {
          setText(els.transportStatus, "paired", "ok");
          els.pairHint.textContent = "Pairing 成功。secret 已清空。";
          els.pairHint.className = "note ok";
        } else {
          setText(els.transportStatus, `pair 失败: ${failReason}`, "bad");
          els.pairHint.textContent = `Pairing 未成功（${failReason}）；secret/intentId 已清空，可重新粘贴 pairing JSON。`;
          els.pairHint.className = "note bad";
        }
      } catch (e) {
        await refresh().catch(() => undefined);
        setText(els.transportStatus, `pair 异常: ${e?.message || "runtime"}`, "bad");
      } finally {
        await clearPairingForm({ includeIntent: true });
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

  (async () => {
    await loadPairingPrefs();
    // Popup may be destroyed on blur (e.g. copying JSON) — save on input, not change.
    els.bridgeOrigin.addEventListener("input", () => {
      void saveBridgeOrigin(els.bridgeOrigin.value);
    });
    els.intentId.addEventListener("input", () => {
      void saveIntentSession(els.intentId.value.trim() || null);
    });
    // Secret input: never write to storage.
    await refresh();
  })().catch(() => {
    setText(els.pageRoute, "popup 初始化失败", "bad");
  });
})();
