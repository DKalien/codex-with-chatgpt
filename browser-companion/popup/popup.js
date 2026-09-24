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
    connectChat: document.getElementById("connect-chat"),
    connectStatus: document.getElementById("connect-status"),
    userConnectionStatus: document.getElementById("user-connection-status"),
    userAutonomyStatus: document.getElementById("user-autonomy-status"),
    userActionHint: document.getElementById("user-action-hint"),
    bind: document.getElementById("bind"),
    unbind: document.getElementById("unbind"),
    transportStatus: document.getElementById("transport-status"),
    bridgeOrigin: document.getElementById("bridge-origin"),
    grantBridgeAccess: document.getElementById("grant-bridge-access"),
    bridgePermissionStatus: document.getElementById("bridge-permission-status"),
    pairJson: document.getElementById("pair-json"),
    pairConnect: document.getElementById("pair-connect"),
    firstUseSettings: document.getElementById("first-use-settings"),
    firstUseHint: document.getElementById("first-use-hint"),
    pairConnectHint: document.getElementById("pair-connect-hint"),
    applyPairJson: document.getElementById("apply-pair-json"),
    intentId: document.getElementById("intent-id"),
    pairSecret: document.getElementById("pair-secret"),
    pairHint: document.getElementById("pair-hint"),
    pair: document.getElementById("pair"),
    rebindStart: document.getElementById("rebind-start"),
    rebindComplete: document.getElementById("rebind-complete"),
    verifyRoute: document.getElementById("verify-route"),
    fetchState: document.getElementById("fetch-state"),
    reserve: document.getElementById("reserve"),
    release: document.getElementById("release"),
    recover: document.getElementById("recover"),
    autonomyStatus: document.getElementById("autonomy-status"),
    operationalHealth: document.getElementById("operational-health"),
    autonomyArmConfirm: document.getElementById("autonomy-arm-confirm"),
    autonomyShadow: document.getElementById("autonomy-shadow"),
    autonomyArm: document.getElementById("autonomy-arm"),
    autonomyDisable: document.getElementById("autonomy-disable"),
    retireUnknown: document.getElementById("retire-unknown"),
    retireUnknownConfirm: document.getElementById("retire-unknown-confirm"),
    shadowInspect: document.getElementById("shadow-inspect"),
    shadowEvidence: document.getElementById("shadow-evidence"),
    shadowControls: document.getElementById("shadow-controls"),
    shadowContainers: document.getElementById("shadow-containers"),
    writeProbe: document.getElementById("write-probe"),
    writeProbeResult: document.getElementById("write-probe-result"),
    sendProbe: document.getElementById("send-probe"),
    sendProbeConfirm: document.getElementById("send-probe-confirm"),
    sendProbeReset: document.getElementById("send-probe-reset"),
    sendProbeResult: document.getElementById("send-probe-result"),
    productionStatus: document.getElementById("production-status"),
    productionSend: document.getElementById("production-send"),
    productionSendConfirm: document.getElementById("production-send-confirm"),
    productionSendResult: document.getElementById("production-send-result"),
    clearTransport: document.getElementById("clear-transport"),
    bridgeState: document.getElementById("bridge-state"),
    connectDiagnostic: document.getElementById("connect-diagnostic"),
  };

  function setText(el, text, cls) {
    el.textContent = text;
    el.className = "value" + (cls ? " " + cls : "");
  }

  function friendlyConnectState(transport, isOwner, connectReason, connectState) {
    if (transport?.authStale) return ["连接需要修复", "bad"];
    if (connectReason === "bootstrap_tool_missing") {
      return ["当前对话缺少反馈连接工具", "bad"];
    }
    if (connectState === "WAITING_TAKEOVER") return ["正在等待当前 Chat 接管连接", "warn"];
    if (connectState === "TAKEOVER_DISPATCH" || connectState === "OUTCOME_UNKNOWN") {
      return ["连接发送结果待确认，请勿重复发送", "bad"];
    }
    if (connectReason === "bridge_permission_missing") {
      return ["需要授权连接服务", "warn"];
    }
    if (transport?.rebindPending) {
      return ["正在等待 ChatGPT 完成确认", "warn"];
    }
    if (transport?.connected && transport?.routeVerification !== "VERIFIED") {
      return ["还差一步完成连接", "warn"];
    }
    if (transport?.connected && transport?.routeVerification === "VERIFIED") {
      return isOwner === true
        ? ["当前对话已连接", "ok"]
        : ["当前页面需要重新连接", "warn"];
    }
    return ["可以连接当前对话", "warn"];
  }

  function friendlyConnectReason(reason) {
    switch (reason) {
      case "bridge_origin_invalid":
        return "连接地址需要检查，请展开连接设置查看详情。";
      case "bridge_permission_missing":
        return "首次使用需要授权连接服务，请展开连接设置完成授权。";
      case "tab_changed":
        return "当前页面已变化，请重新打开扩展后再试。";
      case "content_script_unavailable":
        return "当前页面暂时无法连接，请刷新 ChatGPT 页面后再试。";
      case "cold_pair_required":
        return "首次使用需要配对，请粘贴配对信息并点击一次完成连接。";
      case "bootstrap_tool_missing":
        return "当前对话缺少反馈连接工具，请检查 ChatGPT 工具连接后再继续。";
      default:
        return "连接遇到问题，请展开连接设置查看详情。";
    }
  }

  function openFirstUse({ focusPairing = false } = {}) {
    if (els.firstUseSettings) els.firstUseSettings.open = true;
    if (focusPairing && els.pairJson?.focus) {
      els.pairJson.focus();
    }
  }

  /** Bounded recover result — no message body / credential / secret. */
  function formatRecoverResult(res) {
    const j = res?.journal ?? {};
    const lines = [
      `ok=${res?.ok === true}`,
      `reason=${res?.reason ?? (res?.ok ? "ok" : "-")}`,
      `action=${res?.action ?? "-"}`,
      `retryAck=${res?.retryAck === true}`,
      `zeroWrite=${res?.zeroWrite === true}`,
      `zeroClick=${res?.zeroClick === true}`,
      `journal.state=${j.state ?? res?.journalState ?? "-"}`,
      `journal.eventId=${j.eventId ?? "-"}`,
      `journal.attemptId=${j.attemptId ?? "-"}`,
    ];
    const d = res?.diagnostic;
    if (d && typeof d === "object") {
      const safe = {
        candidateCount: d.candidateCount,
        exactTextMatchCount: d.exactTextMatchCount,
        exactAttemptMarkerCount: d.exactAttemptMarkerCount,
        ambiguousCount: d.ambiguousCount,
        targetLength: d.targetLength,
        firstMismatchIndex: d.firstMismatchIndex,
        candidateLengths: Array.isArray(d.candidateLengths)
          ? d.candidateLengths.slice(0, 5)
          : undefined,
      };
      for (const key of Object.keys(safe)) {
        if (safe[key] === undefined) delete safe[key];
      }
      lines.push(`diagnostic=${JSON.stringify(safe)}`);
    }
    return lines.join("\n");
  }

  /** Last known Arm gates from refresh. Change listener recomputes without RPC. */
  let lastAutonomyArmGates = {
    hasTransport: false,
    isOwner: false,
    storageProtected: false,
    productionEligible: false,
  };
  let lastRouteVerifyGates = {
    hasTransport: false,
    isOwner: false,
    routeVerification: "PENDING",
    routeAttestLatch: "NONE",
    routeAttestFence: "NONE",
  };

  function updateAutonomyArmEnabled() {
    if (!els.autonomyArm) return;
    // ARMED requires authenticated route VERIFIED — never treat "paired" as verified.
    els.autonomyArm.disabled = !(
      lastAutonomyArmGates.hasTransport
      && lastAutonomyArmGates.isOwner
      && lastAutonomyArmGates.storageProtected
      && lastAutonomyArmGates.productionEligible === true
      && els.autonomyArmConfirm?.checked === true
    );
  }

  function updateRouteVerifyEnabled() {
    if (!els.verifyRoute) return;
    // Popup never supplies message text; SW owns attestation payload.
      els.verifyRoute.disabled = !(
      lastRouteVerifyGates.hasTransport
      && lastRouteVerifyGates.isOwner
      && lastRouteVerifyGates.routeVerification === "PENDING"
      // Session latch AND durable fence must both be NONE. Fence survives browser restart.
      && lastRouteVerifyGates.routeAttestLatch === "NONE"
      && lastRouteVerifyGates.routeAttestFence === "NONE"
    );
  }

  // Bind once. refresh() must not re-register unbounded listeners.
  if (els.autonomyArmConfirm) {
    els.autonomyArmConfirm.addEventListener("change", updateAutonomyArmEnabled);
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
    const hasBridgeOrigin = Object.prototype.hasOwnProperty.call(obj, "bridgeOrigin");
    if (hasBridgeOrigin && typeof obj.bridgeOrigin !== "string") return null;
    if (!intentId || !secret) return null;
    return { intentId, secret, bridgeOrigin: hasBridgeOrigin ? obj.bridgeOrigin.trim() : undefined };
  }

  function bridgePermission(origin) {
    const url = new URL((origin ?? "").trim());
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase());
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      throw new Error("bridge_origin_invalid");
    }
    return { origin: url.origin, pattern: `${url.origin}/*` };
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
    if (transport?.rebindPending) {
      setText(els.transportStatus, "rebind pending — verify route, confirm in ChatGPT, then complete", "warn");
    } else if (transport?.connected) {
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
    const storageProtected = status?.storageProtected === true;
    const journalState = status?.journal?.state ?? "NONE";
    const sendProbeLatch = status?.sendProbeLatch ?? "NONE";
    const productionInFlight = status?.productionSendInFlight === true;
    const pageIdleSafe = safety?.safety?.safe === true
      && safety?.safety?.composer === "empty"
      && safety?.safety?.generation === "idle";

    els.bind.disabled = !parsed || !tab?.id;
    if (els.connectChat) els.connectChat.disabled = !parsed || !tab?.id;
    if (els.pairConnect) els.pairConnect.disabled = !parsed || !tab?.id;
    els.pair.disabled = !isOwner;
    if (els.rebindStart) {
      els.rebindStart.disabled = !isOwner || !transport?.bridgeOrigin || transport?.rebindPending === true;
    }
    if (els.rebindComplete) {
      els.rebindComplete.disabled = !isOwner || transport?.rebindPending !== true;
    }
    els.applyPairJson.disabled = false;
    els.fetchState.disabled = !hasTransport;
    els.reserve.disabled = !hasTransport || !isOwner;
    els.release.disabled = !hasTransport;
    els.recover.disabled = !hasTransport;

    const canRetire =
      hasTransport
      && journalState === "OUTCOME_UNKNOWN"
      && els.retireUnknownConfirm?.checked === true;
    if (els.retireUnknown) {
      els.retireUnknown.disabled = !canRetire;
    }
    els.clearTransport.disabled = !transport;

    const autonomy = status?.autonomy ?? {};
    const autonomyMode = autonomy.mode ?? "off";
    const armed = autonomyMode === "armed";
    const rearmOnConnect = autonomy.rearmOnConnect === true;
    const [connectionText, connectionClass] = friendlyConnectState(
      transport,
      isOwner,
      status?.connectReason,
      status?.connectState,
    );
    const ownerNeedsReconnect = connectionText === "当前页面需要重新连接";
    setText(els.userConnectionStatus, connectionText, connectionClass);
    setText(els.userAutonomyStatus, armed ? "已开启" : "未开启", armed ? "ok" : "warn");
    const actionHint = ownerNeedsReconnect
      ? "页面刷新后需要重新确认当前页面，请点击“连接当前对话”。"
      : connectionText === "当前对话已连接"
      ? (armed ? "执行结果会自动回到当前对话。" : "如需自动回流，请勾选确认后开启。")
        : (status?.connectReason === "bootstrap_tool_missing"
          ? "请在当前 Chat 启用 feedback_status 与 feedback_takeover 工具；不会自动重发自举消息。"
          : transport?.rebindPending
          ? "请回到 ChatGPT 完成确认。"
          : status?.connectState === "WAITING_TAKEOVER"
            ? "正在等待当前 Chat 完成反馈连接接管；完成后会自动继续验证。"
          : transport?.connected
            ? "请完成当前对话验证；如未自动出现验证消息，可展开连接设置。"
            : "点击“连接当前对话”开始使用。遇到问题可展开连接设置。");
    setText(
      els.userActionHint,
      rearmOnConnect && !armed ? `${actionHint} 连接后将自动恢复自动回流。` : actionHint,
      connectionClass,
    );
    if (els.autonomyStatus) {
      const hbSafety = autonomy.lastHeartbeatSafety;
      const ev = autonomy.lastEvaluatedEvidence;
      els.autonomyStatus.textContent = [
        `mode=${autonomyMode}`,
        `bindingId=${transport?.bindingId ?? "-"}`,
        `epoch=${transport?.epoch ?? "-"}`,
        `route=${transport?.routeCanonical ?? "-"}`,
        `Route verification: ${transport?.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING"}`,
        `Production eligible: ${transport?.productionEligible === true ? "yes" : "no"}`,
        `identityExact=${autonomy.identityExact === true}`,
        `tickInFlight=${autonomy.tickInFlight === true}`,
        `lastDecision=${autonomy.lastDecision ?? "-"}`,
        `lastReason=${autonomy.lastReason ?? "-"}`,
        `lastTickAt=${autonomy.lastTickAt ?? "-"}`,
        `lastProductionAttemptAt=${autonomy.lastProductionAttemptAt ?? "-"}`,
        `heartbeatAt=${autonomy.lastHeartbeatAt ?? "-"}`,
        `heartbeatOwnerExact=${autonomy.lastHeartbeatOwnerExact === true}`,
        `heartbeatSafety=${hbSafety ? `${hbSafety.composer ?? "-"}/${hbSafety.generation ?? "-"}/${hbSafety.safe === true}` : "-"}`,
        `evaluatedEvidence=${ev ? `${ev.composer ?? "-"}/${ev.generation ?? "-"}/${ev.safe === true} ageMs=${ev.ageMs ?? "-"}` : "-"}`,
        `recoveryAt=${autonomy.lastRecoveryAt ?? "-"}`,
        `recovery=${autonomy.lastRecoveryResult ? `ok=${autonomy.lastRecoveryResult.ok === true} reason=${autonomy.lastRecoveryResult.reason ?? "-"} action=${autonomy.lastRecoveryResult.action ?? "-"} retryAck=${autonomy.lastRecoveryResult.retryAck === true} journal=${autonomy.lastRecoveryResult.journalState ?? "-"}` : "-"}`,
        `recoveryDiagnostic=${autonomy.lastRecoveryResult?.diagnostic ? JSON.stringify(autonomy.lastRecoveryResult.diagnostic) : "-"}`,
      ].join("\n");
    }
    if (els.operationalHealth) {
      const health = status?.operationalHealth;
      els.operationalHealth.textContent = health ? [
        `state=${health.state} mode=${health.mode} reason=${health.reason ?? "-"}`,
        `identityExact=${health.identityExact} ownerAvailable=${health.ownerAvailable} storageProtected=${health.storageProtected}`,
        `transport=${health.transportPresent} authStale=${health.authStale} journal=${health.journalPhase}`,
        `productionInFlight=${health.productionSendInFlight} tickInFlight=${health.autonomyTickInFlight}`,
        `heartbeat=${health.heartbeatFreshness} ageMs=${health.heartbeatAgeMs ?? "-"} tick=${health.tickFreshness} tickAgeMs=${health.tickAgeMs ?? "-"}`,
        `cooldown=${health.cooldownActive}`,
        `lastDecision=${health.lastDecision ?? "-"} lastReason=${health.lastReason ?? "-"}`,
        `recoveryAction=${health.lastRecoveryAction ?? "-"} recoveryReason=${health.lastRecoveryReason ?? "-"}`,
      ].join("\n") : "—";
    }
    // Manual reserve/send must not race ARMED scheduler.
    // Reserve also disabled while route is not VERIFIED (server 409 remains authority).
    const routeVerified = transport?.routeVerification === "VERIFIED"
      || transport?.productionEligible === true;
    if (els.reserve) {
      els.reserve.disabled = !hasTransport || !isOwner || armed || !routeVerified;
    }
    if (els.autonomyShadow) {
      els.autonomyShadow.disabled = !hasTransport || !isOwner || !storageProtected || armed;
    }
    lastAutonomyArmGates = {
      hasTransport,
      isOwner,
      storageProtected,
      productionEligible: routeVerified,
    };
    lastRouteVerifyGates = {
      hasTransport,
      isOwner,
      routeVerification: routeVerified ? "VERIFIED" : "PENDING",
      routeAttestLatch: status?.routeAttestLatch ?? "NONE",
      routeAttestFence: status?.routeAttestFence ?? "NONE",
    };
    updateAutonomyArmEnabled();
    updateRouteVerifyEnabled();
    if (els.autonomyDisable) {
      els.autonomyDisable.disabled = autonomyMode === "off" && !rearmOnConnect;
    }

    if (els.productionStatus) {
      const j = status?.journal ?? { state: "NONE" };
      const lines = [
        `state=${j.state}`,
        `eventId=${j.eventId ?? "-"}`,
        `reservationId=${j.reservationId ?? "-"}`,
        `attemptId=${j.attemptId ?? "-"}`,
        `sendProbeLatch=${sendProbeLatch}`,
        `productionInFlight=${productionInFlight}`,
        `blocked=${journalState === "OUTCOME_UNKNOWN" || sendProbeLatch !== "NONE" || !hasTransport || !isOwner}`,
      ];
      els.productionStatus.textContent = lines.join("\n");
      els.productionStatus.className = "value" + (journalState === "RESERVED" ? " warn" : "");
    }

    if (els.productionSend && els.productionSendConfirm) {
      const autonomyMode = status?.autonomy?.mode ?? "off";
      const canProduction =
        isOwner
        && hasTransport
        && journalState === "RESERVED"
        && sendProbeLatch === "NONE"
        && !productionInFlight
        && pageIdleSafe
        && autonomyMode !== "armed"
        && els.productionSendConfirm.checked;
      els.productionSend.disabled = !canProduction;
    }

    if (els.connectChat) {
      els.connectChat.onclick = async () => {
        if (!tab?.id || !parsed) return;
        const origin = els.bridgeOrigin.value.trim();
        if (origin) {
          let permission;
          try {
            permission = bridgePermission(origin);
          } catch {
            setText(els.connectStatus, friendlyConnectReason("bridge_origin_invalid"), "bad");
            setText(els.connectDiagnostic, "bridge_origin_invalid", "bad");
            return;
          }
          // Keep the permission request inside the click user gesture. Do not await
          // contains or perform any page/storage work before requesting it.
          let granted = false;
          try {
            granted = await chrome.permissions.request({ origins: [permission.pattern] });
          } catch {
            granted = false;
          }
          if (!granted) {
            setText(els.connectStatus, "需要授权连接服务才能继续", "bad");
            setText(els.connectDiagnostic, "bridge_permission_denied", "bad");
            return;
          }
          await saveBridgeOrigin(permission.origin);
          els.bridgeOrigin.value = permission.origin;
        }
        const tabNow = await activeTab();
        if (!tabNow?.id || tabNow.id !== tab.id) {
          setText(els.connectStatus, friendlyConnectReason("tab_changed"), "bad");
          setText(els.connectDiagnostic, "tab_changed", "bad");
          return;
        }
        let res;
        try {
          // Fixed command only. Content script forwards real MessageSender identity.
          res = await chrome.tabs.sendMessage(tabNow.id, { type: "c2c.connect.request" });
        } catch {
          res = { ok: false, reason: "content_script_unavailable" };
        }
        const reason = res?.ok ? "" : (res?.reason || "connect_failed");
        const text = res?.ok
          ? (res.state === "CONNECTED"
              ? "当前对话已连接"
              : res.state === "WAITING_TAKEOVER"
                ? "正在等待当前 Chat 接管连接"
              : "已发送连接验证，请回到 ChatGPT 完成确认")
          : friendlyConnectReason(reason);
        setText(els.connectDiagnostic, reason || "ok", res?.ok ? "ok" : "bad");
        setText(els.connectStatus, text, res?.ok ? "ok" : "bad");
        await refresh();
        if (reason === "cold_pair_required") {
          openFirstUse({ focusPairing: true });
          setText(els.pairConnectHint, friendlyConnectReason(reason), "warn");
        }
      };
    }

    els.bind.onclick = async () => {
      if (!tab?.id || !parsed) return;
      let bindReason = "";
      let bindOk = false;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "c2c.bind.request" });
        bindOk = res?.ok === true;
        if (!bindOk) bindReason = res?.reason || "bind_failed";
      } catch {
        bindOk = false;
        bindReason = "content_script_unavailable";
      }
      await refresh();
      if (!bindOk) {
        setText(els.ownerStatus, `bind 失败: ${bindReason}`, "bad");
      }
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

    if (els.pairConnect) {
      els.pairConnect.onclick = async () => {
        const fields = extractPairingFields(els.pairJson?.value);
        if (!fields) {
          setText(els.pairConnectHint, "无法读取配对信息，请粘贴完整 pairing JSON。", "bad");
          return;
        }
        const originText = fields.bridgeOrigin ?? els.bridgeOrigin?.value?.trim() ?? "";
        let permission;
        try {
          permission = bridgePermission(originText);
        } catch {
          setText(els.pairConnectHint, "首次使用需要先在连接修复中设置有效的连接服务地址。", "bad");
          setText(els.connectDiagnostic, "bridge_origin_invalid", "bad");
          return;
        }

        // This call must happen synchronously in the click gesture, before any
        // storage, tab, or runtime work. Pairing secret remains popup memory.
        let granted = false;
        try {
          granted = await chrome.permissions.request({ origins: [permission.pattern] });
        } catch {
          granted = false;
        }
        if (!granted) {
          setText(els.pairConnectHint, "需要授权连接服务才能继续。配对信息仍保留在本次 popup 内存中。", "bad");
          setText(els.connectDiagnostic, "bridge_permission_denied", "bad");
          return;
        }

        await saveBridgeOrigin(permission.origin);
        await saveIntentSession(fields.intentId);
        if (els.bridgeOrigin) els.bridgeOrigin.value = permission.origin;
        const tabNow = await activeTab();
        if (!tabNow?.id || tabNow.id !== tab?.id) {
          setText(els.pairConnectHint, "当前页面已变化，请重新打开扩展后再试。", "bad");
          setText(els.connectDiagnostic, "tab_changed", "bad");
          return;
        }

        let proof;
        try {
          proof = await chrome.tabs.sendMessage(tabNow.id, { type: "c2c.owner-proof.request" });
        } catch {
          proof = null;
        }
        if (!proof?.ok || !proof.proof?.id) {
          setText(els.pairConnectHint, "当前页面无法完成安全校验，请刷新 ChatGPT 页面后再试。", "bad");
          setText(els.connectDiagnostic, proof?.reason || "owner_proof_missing", "bad");
          return;
        }

        let pairAttempted = false;
        let pairResult;
        try {
          pairAttempted = true;
          pairResult = await chrome.runtime.sendMessage({
            type: "c2c.pair",
            bridgeOrigin: permission.origin,
            intentId: fields.intentId,
            secret: fields.secret,
            ownerProofId: proof.proof.id,
          });
        } catch (error) {
          pairResult = { ok: false, reason: error?.message || "pair_runtime_error" };
        } finally {
          if (pairAttempted) await clearPairingForm({ includeIntent: true });
        }

        if (!pairResult?.ok) {
          const reason = pairResult?.reason || (typeof pairResult?.status === "number" ? `http_${pairResult.status}` : "pair_failed");
          setText(els.pairConnectHint, `配对未成功（${reason}），请重新粘贴配对信息。`, "bad");
          setText(els.connectDiagnostic, reason, "bad");
          await refresh();
          return;
        }

        let connectResult;
        try {
          connectResult = await chrome.tabs.sendMessage(tabNow.id, { type: "c2c.connect.request" });
        } catch {
          connectResult = { ok: false, reason: "content_script_unavailable" };
        }
        await refresh();
        const connectReason = connectResult?.ok ? "" : (connectResult?.reason || "connect_failed");
        if (connectResult?.ok) {
          const connected = connectResult.state === "CONNECTED";
          setText(els.pairConnectHint, connected
            ? "当前对话已连接。"
            : "已发送连接验证，请回到 ChatGPT 完成确认。", connected ? "ok" : "warn");
          setText(els.connectStatus, connected
            ? "当前对话已连接"
            : "已发送连接验证，请回到 ChatGPT 完成确认", connected ? "ok" : "warn");
          if (els.firstUseSettings) els.firstUseSettings.open = false;
        } else {
          setText(els.pairConnectHint, friendlyConnectReason(connectReason), "bad");
          setText(els.connectDiagnostic, connectReason, "bad");
        }
      };
    }

    els.grantBridgeAccess.onclick = async () => {
      let permission;
      try {
        permission = bridgePermission(els.bridgeOrigin.value);
      } catch {
        setText(els.bridgePermissionStatus, "bridge_origin_invalid", "bad");
        return;
      }

      const query = { origins: [permission.pattern] };
      // Invoke while the click user-gesture is still live.
      // Never await storage / contains / tabs / runtime before this call.
      const grantPromise = chrome.permissions.request(query);

      let granted = false;
      try {
        granted = await grantPromise;
      } catch {
        granted = false;
      }

      if (granted) {
        await saveBridgeOrigin(permission.origin);
        els.bridgeOrigin.value = permission.origin;
        setText(els.bridgePermissionStatus, "Bridge access granted", "ok");
      } else {
        setText(els.bridgePermissionStatus, "Bridge access denied", "bad");
      }
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
        let permission;
        try {
          permission = bridgePermission(origin);
        } catch {
          setText(els.transportStatus, "bridge_origin_invalid", "bad");
          return;
        }
        await saveBridgeOrigin(permission.origin);
        await saveIntentSession(intentId);
        els.bridgeOrigin.value = permission.origin;
        const granted = await chrome.permissions.contains({ origins: [permission.pattern] });
        if (!granted) {
          setText(els.transportStatus, "bridge_permission_missing", "bad");
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
          bridgeOrigin: permission.origin,
          intentId,
          secret,
          ownerProofId: proof.proof.id,
        });
        // refresh() rewrites transport-status; apply pair result AFTER it so HTTP reason is kept.
        await refresh();
        const failReason = res?.reason
          || (typeof res?.status === "number" ? `http_${res.status}` : "unknown");
        if (res?.ok) {
          setText(els.transportStatus, "paired — Route verification: PENDING", "bad");
          els.pairHint.textContent =
            "Pairing 成功。Route verification=PENDING。请在本 conversation 点击 Verify this conversation route；Production eligible=no。secret 已清空。";
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

    if (els.verifyRoute) {
      els.verifyRoute.onclick = async () => {
        // Popup MUST NOT supply attestation message text.
        const res = await chrome.runtime.sendMessage({ type: "c2c.route.attest.send" });
        setText(
          els.bridgeState,
          `route attest ok=${res?.ok === true} observed=${res?.observed === true} `
          + `serverConfirmed=${res?.serverConfirmed === true} reason=${res?.reason ?? (res?.ok ? "ok" : "-")}`,
          res?.ok ? "ok" : "bad",
        );
        await refresh();
      };
    }

    if (els.rebindStart) {
      els.rebindStart.onclick = async () => {
        const tabNow = await activeTab();
        if (!tabNow?.id) return;
        let proof = null;
        try {
          proof = await chrome.tabs.sendMessage(tabNow.id, { type: "c2c.owner-proof.request" });
        } catch { /* ignore */ }
        const res = proof?.ok && proof.proof?.id
          ? await chrome.runtime.sendMessage({
              type: "c2c.rebind.start",
              ownerProofId: proof.proof.id,
            })
          : { ok: false, reason: proof?.reason || "owner_proof_missing" };
        setText(
          els.bridgeState,
          res?.ok ? "rebind challenge ready" : `rebind start 失败: ${res?.reason || "unknown"}`,
          res?.ok ? "ok" : "bad",
        );
        await refresh();
      };
    }

    if (els.rebindComplete) {
      els.rebindComplete.onclick = async () => {
        const res = await chrome.runtime.sendMessage({ type: "c2c.rebind.complete" });
        setText(
          els.bridgeState,
          res?.ok
            ? "rebind complete — Route verification: VERIFIED"
            : `rebind complete 失败: ${res?.reason || "unknown"}`,
          res?.ok ? "ok" : "bad",
        );
        await refresh();
      };
    }

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
      setText(els.bridgeState, formatRecoverResult(res), res?.ok ? "ok" : "bad");
      await refresh();
    };

    if (els.autonomyShadow) {
      els.autonomyShadow.onclick = async () => {
        const res = await chrome.runtime.sendMessage({ type: "c2c.autonomy.enable.shadow" });
        setText(els.bridgeState, `shadow ok=${res?.ok === true} mode=${res?.mode ?? "-"} reason=${res?.reason ?? "ok"}`, res?.ok ? "ok" : "bad");
        await refresh();
      };
    }
    if (els.autonomyArm) {
      els.autonomyArm.onclick = async () => {
        if (!els.autonomyArmConfirm?.checked) return;
        const res = await chrome.runtime.sendMessage({ type: "c2c.autonomy.arm" });
        setText(els.bridgeState, `arm ok=${res?.ok === true} mode=${res?.mode ?? "-"} reason=${res?.reason ?? "ok"}`, res?.ok ? "ok" : "bad");
        await refresh();
      };
    }
    if (els.autonomyDisable) {
      els.autonomyDisable.onclick = async () => {
        const res = await chrome.runtime.sendMessage({ type: "c2c.autonomy.disable" });
        setText(els.bridgeState, `autonomy disable ok=${res?.ok === true} journal=${res?.journal?.state ?? "-"}`, res?.ok ? "ok" : "bad");
        await refresh();
      };
    }

    if (els.retireUnknown && els.retireUnknownConfirm) {
      els.retireUnknownConfirm.addEventListener("change", () => {
        const jState = status?.journal?.state ?? "NONE";
        els.retireUnknown.disabled = !(
          els.retireUnknownConfirm.checked
          && Boolean(status?.transport?.connected)
          && jState === "OUTCOME_UNKNOWN"
        );
      });
      els.retireUnknown.onclick = async () => {
        if (!els.retireUnknownConfirm.checked) return;
        els.retireUnknown.disabled = true;
        setText(els.bridgeState, "Retiring unknown event…", "warn");
        let res;
        try {
          // Identity always from durable SW journal; popup never supplies identity.
          res = await chrome.runtime.sendMessage({ type: "c2c.retire.unknown" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error" };
        }
        const j = res?.journal ?? {};
        setText(
          els.bridgeState,
          `retire ok=${res?.ok === true} reason=${res?.reason ?? (res?.ok ? "ok" : "unknown")} `
          + `eventId=${res?.eventId ?? j.eventId ?? "-"} journal=${j.state ?? "-"} `
          + `zeroWrite=${res?.zeroWrite === true} zeroClick=${res?.zeroClick === true}`,
          res?.ok ? "ok" : "bad",
        );
        await refresh();
      };
    }

    if (els.shadowInspect) {
      els.shadowInspect.onclick = async () => {
        setText(els.shadowEvidence, "inspecting…", "warn");
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: "c2c.shadow.send.inspect" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error" };
        }
        if (!res?.ok) {
          setText(
            els.shadowEvidence,
            `READ ONLY — inspect failed: ${res?.reason || "unknown"}`,
            "bad",
          );
          if (els.shadowControls) {
            setText(els.shadowControls, "—", "");
          }
          if (els.shadowContainers) {
            setText(els.shadowContainers, "—", "");
          }
          return;
        }
        const a = res.action || {};
        const c = res.composer || {};
        const s = res.safety || {};
        const se = a.stopEvidence || null;
        setText(
          els.shadowEvidence,
          `READ ONLY — no composer write / no Send | routeExact=${res.routeExact} | editor=${c.editorKind || "?"} composerEvidence=${c.evidence ?? "none"} | empty=${c.textEmpty} | action=${a.kind} evidence=${a.evidence ?? "none"} enabled=${a.enabled} sendButton=${a.hasExactSendButton} | stopSource=${se?.source ?? "none"} stopTestId=${se?.dataTestId ?? "-"} stopAria=${se?.ariaLabel ?? "-"} stopInForm=${se?.insideComposerForm ?? "-"} | gen=${s.generation} safe=${s.safe} | turns=${res.userTurnCount ?? "?"}`,
          s.safe === true ? "ok" : "warn",
        );
        if (els.shadowControls) {
          els.shadowControls.textContent = formatControlInventory(a.inventory);
          els.shadowControls.className = "value";
        }
        if (els.shadowContainers) {
          els.shadowContainers.textContent = formatContainerInventory(a.containerInventory);
          els.shadowContainers.className = "value";
        }
      };
    }

    if (els.writeProbe) {
      els.writeProbe.onclick = async () => {
        if (!els.writeProbeResult) return;
        els.writeProbeResult.textContent = "WRITES COMPOSER — DOES NOT SEND\nprobe running…";
        els.writeProbeResult.className = "value warn";
        let res;
        try {
          // Fixed probe only — never send arbitrary message payload.
          res = await chrome.runtime.sendMessage({ type: "c2c.write.probe.request" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error", retryAllowed: false };
        }
        const lines = [
          "NO SEND PERFORMED — WRITES COMPOSER — DOES NOT SEND",
          `ok=${res?.ok === true} reason=${res?.reason ?? (res?.ok ? "ok" : "unknown")}`,
          `mode=${res?.mode ?? "write_probe_no_send"} noSend=${res?.noSend === true || res?.noSendPerformed === true}`,
          `mutationAttempted=${res?.mutationAttempted === true} wrote=${res?.wrote === true} verified=${res?.verified === true}`,
          `editor=${res?.editorKind ?? "-"} composerEvidence=${res?.composerEvidence ?? "-"}`,
          `routeExact=${res?.routeExact === true} documentExact=${res?.documentIdExact === true} generationExact=${res?.generationExact === true}`,
          `generation=${res?.generation ?? "-"} route=${res?.canonicalRoute ?? "-"}`,
          `retryAllowed=${res?.retryAllowed === true} journal=${res?.journalState ?? res?.journal?.state ?? "-"}`,
        ];
        if (res?.reason === "composer_write_mismatch" || res?.mutationAttempted === true) {
          const rb = res?.readback;
          if (rb && typeof rb === "object") {
            const tc = rb.textContent || {};
            const it = rb.innerText || {};
            const ch = rb.childBlocks || {};
            lines.push(
              `textContent: len=${tc.length ?? "-"} lf=${tc.newlineCount ?? "-"} exact=${tc.exact === true} noFinalLf=${tc.exactWithoutFinalLf === true}`,
            );
            lines.push(
              `innerText: available=${it.available === true} len=${it.length ?? "-"} lf=${it.newlineCount ?? "-"} exact=${it.exact === true} noFinalLf=${it.exactWithoutFinalLf === true}`,
            );
            lines.push(
              `children: count=${ch.count ?? 0} tags=${(ch.firstTags || []).join(",") || "-"} joinedLfExact=${ch.joinedWithLfExact === true} joinedLfNoFinalLf=${ch.joinedWithLfExactWithoutFinalLf === true}`,
            );
            if (rb.canonical) {
              lines.push(
                `canonical: representation=${rb.canonical.representation ?? "-"} exact=${rb.canonical.exact === true} ok=${rb.canonical.ok === true}`,
              );
            }
          } else {
            lines.push("readback: (absent)");
          }
        }
        lines.push("Auto-clear disabled — 请手工清空 composer。");
        els.writeProbeResult.textContent = lines.join("\n");
        els.writeProbeResult.className = "value" + (res?.ok === true ? " ok" : " warn");
      };
    }

    if (els.sendProbe && els.sendProbeConfirm) {
      els.sendProbe.disabled = !els.sendProbeConfirm.checked;
      els.sendProbeConfirm.addEventListener("change", () => {
        els.sendProbe.disabled = !els.sendProbeConfirm.checked;
      });
      els.sendProbe.onclick = async () => {
        if (!els.sendProbeConfirm.checked || !els.sendProbeResult) return;
        els.sendProbe.disabled = true;
        els.sendProbeResult.textContent = "REAL SEND PROBE — sending…";
        els.sendProbeResult.className = "value warn";
        let res;
        try {
          // Fixed probe only — SW mints attemptId + message. Never supply payload.
          res = await chrome.runtime.sendMessage({ type: "c2c.send.probe.request" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error", retryAllowed: false };
        }
        const lines = [
          "REAL SEND PROBE",
          `ok=${res?.ok === true} reason=${res?.reason ?? (res?.ok ? "ok" : "unknown")}`,
          `mutationAttempted=${res?.mutationAttempted === true} wrote=${res?.wrote === true} verified=${res?.verified === true}`,
          `clickAttempted=${res?.clickAttempted === true} clicked=${res?.clicked === true} observed=${res?.observed === true}`,
          `routeExact=${res?.routeExact === true} documentExact=${res?.documentIdExact === true} generationExact=${res?.generationExact === true}`,
          `productionJournal=${res?.productionJournal ?? "-"} latch=${res?.latch ?? "-"} retryAllowed=${res?.retryAllowed === true}`,
          `attemptId=${res?.attemptId ?? "-"}`,
        ];
        els.sendProbeResult.textContent = lines.join("\n");
        els.sendProbeResult.className = "value" + (res?.ok === true ? " ok" : " warn");
        els.sendProbe.disabled = !els.sendProbeConfirm.checked;
      };
    }
    if (els.sendProbeReset && els.sendProbeResult) {
      els.sendProbeReset.onclick = async () => {
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: "c2c.send.probe.reset" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error" };
        }
        els.sendProbeResult.textContent =
          `REAL SEND PROBE RESET\nok=${res?.ok === true} reason=${res?.reason ?? "-"} latch=${res?.latch ?? "-"}`;
        els.sendProbeResult.className = "value" + (res?.ok === true ? " ok" : " warn");
      };
    }

    if (els.productionSend && els.productionSendConfirm && els.productionSendResult) {
      els.productionSendConfirm.addEventListener("change", () => {
        const jState = status?.journal?.state ?? "NONE";
        const latch = status?.sendProbeLatch ?? "NONE";
        const inFlight = status?.productionSendInFlight === true;
        const idleSafe = safety?.safety?.safe === true
          && safety?.safety?.composer === "empty"
          && safety?.safety?.generation === "idle";
        els.productionSend.disabled = !(
          els.productionSendConfirm.checked
          && status?.isOwner === true
          && Boolean(status?.transport?.connected)
          && jState === "RESERVED"
          && latch === "NONE"
          && !inFlight
          && idleSafe
        );
      });
      els.productionSend.onclick = async () => {
        if (!els.productionSendConfirm.checked || !els.productionSendResult) return;
        els.productionSend.disabled = true;
        els.productionSendResult.textContent = "PRODUCTION SEND — sending reserved feedback…";
        els.productionSendResult.className = "value warn";
        let res;
        try {
          // Identity/message always from durable SW journal — never supply payload.
          res = await chrome.runtime.sendMessage({ type: "c2c.production.send.request" });
        } catch (e) {
          res = { ok: false, reason: e?.message || "runtime_error", retryAllowed: false };
        }
        const lines = [
          "PRODUCTION SEND",
          `ok=${res?.ok === true} reason=${res?.reason ?? (res?.ok ? "ok" : "unknown")}`,
          `journal=${res?.journal?.state ?? res?.productionJournal ?? "-"}`,
          `eventId=${res?.eventId ?? res?.journal?.eventId ?? "-"}`,
          `attemptId=${res?.attemptId ?? res?.journal?.attemptId ?? "-"}`,
          `retryAllowed=${res?.retryAllowed === true} action=${res?.action ?? "-"}`,
          `zeroWrite=${res?.zeroWrite === true} zeroClick=${res?.zeroClick === true} retryAck=${res?.retryAck === true}`,
        ];
        els.productionSendResult.textContent = lines.join("\n");
        els.productionSendResult.className = "value" + (res?.ok === true ? " ok" : " warn");
        await refresh();
      };
    }

    function formatContainerInventory(inventory) {
      const header = "READ ONLY — no composer write / no Send";
      if (!inventory || typeof inventory !== "object") {
        return `${header}\ncontainerInventory: (absent)`;
      }
      const ancestors = Array.isArray(inventory.ancestors) ? inventory.ancestors : [];
      const controlContainers = Array.isArray(inventory.controlContainers)
        ? inventory.controlContainers
        : [];
      if (ancestors.length === 0 && controlContainers.length === 0) {
        return `${header}\nancestors: []\ncontrolContainers: []`;
      }
      const byDepth = new Map(controlContainers.map((c) => [c.depth, c]));
      const lines = [];
      for (const anc of ancestors) {
        const bits = [
          `depth=${anc.depth}`,
          anc.tagName != null ? anc.tagName : "?",
          anc.id != null ? `id=${anc.id}` : null,
          anc.dataTestId != null ? `testid=${anc.dataTestId}` : null,
          anc.role != null ? `role=${anc.role}` : null,
          anc.className != null ? `class=${anc.className}` : null,
          `buttons=${anc.descendantButtonCount ?? 0}`,
        ].filter((x) => x != null);
        lines.push(bits.join(" "));
        const container = byDepth.get(anc.depth);
        if (container) {
          const btns = Array.isArray(container.buttons) ? container.buttons : [];
          for (const b of btns) {
            const bbits = [
              b.dataTestId != null ? `testid=${b.dataTestId}` : null,
              b.ariaLabel != null ? `aria=${b.ariaLabel}` : null,
              b.title != null ? `title=${b.title}` : null,
              b.type != null ? `type=${b.type}` : null,
              b.name != null ? `name=${b.name}` : null,
              b.role != null ? `role=${b.role}` : null,
              b.className != null ? `class=${b.className}` : null,
              `disabled=${b.disabled === true}`,
              b.ariaDisabled != null ? `ariaDisabled=${b.ariaDisabled}` : null,
              `dist=${b.distanceFromEditor ?? b.ancestorDepth ?? "-"}`,
              `send=${b.matchesKnownSend === true}`,
              `slot=${b.matchesKnownActionSlot === true}`,
              `stop=${b.matchesKnownStop === true}`,
            ].filter((x) => x != null);
            lines.push(`  #${b.index}{${bbits.join(", ")}}`);
          }
        }
      }
      return [
        header,
        `ancestors=${ancestors.length}/8 controlContainers=${controlContainers.length}/3`,
        lines.join("\n"),
      ].join("\n");
    }

    function formatControlInventory(inventory) {
      const header = "READ ONLY — no composer write / no Send";
      if (!inventory || typeof inventory !== "object") {
        return `${header}\ninventory: (absent)`;
      }
      if (!inventory.formPresent) {
        return `${header}\nformPresent=false buttonCount=0\nbuttons: []`;
      }
      const buttons = Array.isArray(inventory.buttons) ? inventory.buttons : [];
      const lines = buttons.map((b) => {
        const bits = [
          b.dataTestId != null ? `testid=${b.dataTestId}` : null,
          b.ariaLabel != null ? `aria=${b.ariaLabel}` : null,
          b.title != null ? `title=${b.title}` : null,
          b.type != null ? `type=${b.type}` : null,
          b.name != null ? `name=${b.name}` : null,
          b.role != null ? `role=${b.role}` : null,
          b.className != null ? `class=${b.className}` : null,
          `disabled=${b.disabled === true}`,
          b.ariaDisabled != null ? `ariaDisabled=${b.ariaDisabled}` : null,
          `send=${b.matchesKnownSend === true}`,
          `slot=${b.matchesKnownActionSlot === true}`,
          `stop=${b.matchesKnownStop === true}`,
        ].filter((x) => x != null);
        return `#${b.index}{${bits.join(", ")}}`;
      });
      return [
        header,
        `formPresent=true buttonCount=${inventory.buttonCount} (dto=${buttons.length}/12)`,
        lines.length ? lines.join("\n") : "buttons: []",
      ].join("\n");
    }

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
