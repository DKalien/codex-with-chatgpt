/**
 * Content script: passive SPA route observation + production send DI shell.
 * Never holds Bridge secrets. Never owns journal authority.
 * Composer write / native Send only via production-send-runtime globals (explicit popup).
 */
(function () {
  "use strict";
  if (window.__c2cCompanionLoaded) return;
  window.__c2cCompanionLoaded = true;

  let lastHref = location.href;
  let generation = 1;
  let lastWakeHeartbeatAt = 0;

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
    let feedbackBootstrapToolMissing = false;
    try {
      feedbackBootstrapToolMissing = globalThis.__c2cFeedbackBootstrapToolMissingReply?.(document) === true;
    } catch {
      feedbackBootstrapToolMissing = false;
    }
    return {
      type: "c2c.observe",
      href: location.href,
      canonicalRoute: parsed ? parsed.canonical : null,
      generation,
      feedbackBootstrapToolMissing,
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

  function wakeHeartbeat() {
    const now = Date.now();
    if (now - lastWakeHeartbeatAt < 1000) return;
    lastWakeHeartbeatAt = now;
    report();
    heartbeat();
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
  window.addEventListener("pageshow", wakeHeartbeat);
  window.addEventListener("focus", wakeHeartbeat);

  // Resume evidence immediately after the document is installed; no DOM mutation.
  heartbeat();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    if (message.type === "c2c.wake.refresh") {
      if (!document.hidden) wakeHeartbeat();
      sendResponse({ ok: true, refreshed: !document.hidden });
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
    if (message.type === "c2c.connect.request") {
      // Fixed popup request. Route/document/tab authority comes from this CS MessageSender.
      const msg = buildObserveMessage();
      void sendToWorker({ ...msg, type: "c2c.connect.page" }).then((response) => {
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
    if (message.type === "c2c.send.shadow.inspect") {
      // E1b3d1: read-only shadow evidence. No DOM mutation / Send.
      let evidence;
      try {
        evidence = typeof globalThis.__c2cInspectShadowEvidence === "function"
          ? globalThis.__c2cInspectShadowEvidence(document, { locationHref: location.href })
          : { ok: false, reason: "capability_missing", mode: "read_only" };
      } catch {
        evidence = { ok: false, reason: "inspect_error", mode: "read_only" };
      }
      const parsed = parseRoute(location.href);
      sendResponse({
        ...evidence,
        type: "c2c.send.shadow.evidence",
        generation,
        documentHref: location.href,
        documentCanonicalRoute: parsed ? parsed.canonical : null,
      });
      return false;
    }
    if (message.type === "c2c.write.probe.execute") {
      // E1b3d2a: fixed write probe. Zero Send. Local fences only; same handler, no await.
      const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
      const expectedGeneration = message.expectedGeneration;
      if (typeof globalThis.__c2cRunWriteProbe !== "function") {
        sendResponse({
          ok: false,
          reason: "write_capability_missing",
          mode: "write_probe_no_send",
          noSend: true,
          generation,
        });
        return false;
      }
      let result;
      try {
        result = globalThis.__c2cRunWriteProbe(document, {
          expectedRoute,
          expectedGeneration,
          locationHref: location.href,
          localGeneration: generation,
        });
      } catch {
        result = { ok: false, reason: "write_probe_error", wrote: false, verified: false };
      }
      const parsed = parseRoute(location.href);
      sendResponse({
        ok: result?.ok === true,
        mode: "write_probe_no_send",
        reason: result?.ok ? undefined : (result?.reason || "write_probe_failed"),
        wrote: result?.wrote === true,
        verified: result?.verified === true,
        mutationAttempted: result?.mutationAttempted === true,
        readback: result?.readback ?? null,
        editorKind: result?.editorKind ?? null,
        composerEvidence: result?.composerEvidence ?? null,
        canonicalRoute: parsed ? parsed.canonical : null,
        generation,
        noSend: true,
        type: "c2c.write.probe.result",
      });
      return false;
    }
    if (message.type === "c2c.send.probe.execute") {
      // E1b3d3a: one-shot REAL Send probe. Zero production journal. No auto-retry.
      const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
      const expectedGeneration = message.expectedGeneration;
      const attemptId = typeof message.attemptId === "string" ? message.attemptId : "";
      const probeMessage = typeof message.probeMessage === "string" ? message.probeMessage : "";
      if (typeof globalThis.__c2cRunRealSendProbe !== "function") {
        sendResponse({
          ok: false,
          reason: "send_probe_capability_missing",
          mode: "send_probe_real",
          mutationAttempted: false,
          clickAttempted: false,
          generation,
        });
        return false;
      }
      void (async () => {
        let result;
        try {
          result = await globalThis.__c2cRunRealSendProbe(document, {
            expectedRoute,
            expectedGeneration,
            attemptId,
            probeMessage,
            locationHref: location.href,
            getCurrentGeneration: () => generation,
          });
        } catch {
          result = {
            ok: false,
            reason: "send_probe_error",
            mutationAttempted: true,
            clickAttempted: true,
            clicked: false,
            observed: false,
          };
        }
        const parsed = parseRoute(location.href);
        sendResponse({
          ok: result?.ok === true,
          mode: "send_probe_real",
          reason: result?.ok ? undefined : (result?.reason || "send_probe_failed"),
          mutationAttempted: result?.mutationAttempted === true,
          wrote: result?.wrote === true,
          verified: result?.verified === true,
          clickAttempted: result?.clickAttempted === true,
          clicked: result?.clicked === true,
          observed: result?.observed === true,
          attemptId,
          canonicalRoute: parsed ? parsed.canonical : null,
          generation,
          type: "c2c.send.probe.result",
        });
      })();
      return true;
    }
    if (message.type === "c2c.route.attest.execute") {
      // G3 route attestation: SW-owned fixed message only. No production journal.
      const attestationMessage = typeof message.attestationMessage === "string" ? message.attestationMessage : "";
      const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
      const expectedGeneration = message.expectedGeneration;
      if (typeof globalThis.__c2cRunRouteAttestationSend !== "function") {
        sendResponse({
          ok: false,
          reason: "route_attest_capability_missing",
          mode: "route_attestation_send",
          mutationAttempted: false,
          clickAttempted: false,
          generation,
        });
        return false;
      }
      void (async () => {
        let result;
        try {
          result = await globalThis.__c2cRunRouteAttestationSend(document, {
            attestationMessage,
            expectedRoute,
            expectedGeneration,
            locationHref: location.href,
            getCurrentGeneration: () => generation,
            snapshotUserTurns:
              typeof globalThis.snapshotUserTurns === "function"
                ? (doc) => globalThis.snapshotUserTurns(doc)
                : undefined,
            normalizeText:
              typeof globalThis.normalizeCanonicalDomText === "function"
                ? (text) => globalThis.normalizeCanonicalDomText(text)
                : undefined,
          });
        } catch {
          result = {
            ok: false,
            reason: "route_attest_error",
            mutationAttempted: true,
            clickAttempted: true,
            clicked: false,
            observed: false,
          };
        }
        const parsed = parseRoute(location.href);
        sendResponse({
          ok: result?.ok === true,
          mode: "route_attestation_send",
          reason: result?.ok ? undefined : (result?.reason || "route_attest_failed"),
          mutationAttempted: result?.mutationAttempted === true,
          wrote: result?.wrote === true,
          clickAttempted: result?.clickAttempted === true,
          clicked: result?.clicked === true,
          observed: result?.observed === true,
          canonicalRoute: parsed ? parsed.canonical : null,
          generation,
          type: "c2c.route.attest.result",
        });
      })();
      return true;
    }
    if (message.type === "c2c.feedback.bootstrap.execute") {
      // MV3 service-worker MessageSender.url is not stable; internal senders have no tab.
      if (sender?.id !== chrome.runtime.id || sender?.tab != null) {
        sendResponse({ ok: false, reason: "bootstrap_sender_invalid", mutationAttempted: false });
        return false;
      }
      const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
      const expectedGeneration = message.expectedGeneration;
      if (typeof globalThis.__c2cRunFeedbackBootstrapSend !== "function") {
        sendResponse({ ok: false, reason: "bootstrap_capability_missing", mutationAttempted: false });
        return false;
      }
      void (async () => {
        let result;
        try {
          result = await globalThis.__c2cRunFeedbackBootstrapSend(document, {
            expectedRoute,
            expectedGeneration,
            locationHref: location.href,
            getCurrentGeneration: () => generation,
            snapshotUserTurns: typeof globalThis.snapshotUserTurns === "function"
              ? (doc) => globalThis.snapshotUserTurns(doc)
              : undefined,
            normalizeText: typeof globalThis.normalizeCanonicalDomText === "function"
              ? (text) => globalThis.normalizeCanonicalDomText(text)
              : undefined,
          });
        } catch {
          result = { ok: false, reason: "bootstrap_outcome_unknown", mutationAttempted: true, clickAttempted: true };
        }
        const parsed = parseRoute(location.href);
        sendResponse({
          ok: result?.ok === true,
          mode: "feedback_bootstrap_send",
          reason: result?.ok ? undefined : (result?.reason || "bootstrap_failed"),
          mutationAttempted: result?.mutationAttempted === true,
          wrote: result?.wrote === true,
          clickAttempted: result?.clickAttempted === true,
          clicked: result?.clicked === true,
          observed: result?.observed === true,
          canonicalRoute: parsed ? parsed.canonical : null,
          generation,
          type: "c2c.feedback.bootstrap.result",
        });
      })();
      return true;
    }
    if (message.type === "c2c.production.send.execute") {
      // E1b3d3b: exact-document production one-shot. SW holds journal/secret authority.
      return handleProductionExecute(message, sendResponse);
    }
    if (message.type === "c2c.production.send.recover") {
      return handleProductionRecover(message, sendResponse);
    }
    return false;
  });

  function swRpc(payload) {
    return sendToWorker(payload);
  }

  function buildProductionDomDeps() {
    return {
      doc: document,
      getCurrentRoute: () => {
        const parsed = parseRoute(location.href);
        return parsed ? parsed.canonical : "";
      },
      getCurrentGeneration: () => generation,
      inspectComposerWriteCapability:
        typeof globalThis.__c2cInspectComposerWriteCapability === "function"
          ? (doc, opts) => globalThis.__c2cInspectComposerWriteCapability(doc, opts)
          : undefined,
      writeCanonicalMessage:
        typeof globalThis.__c2cWriteCanonicalMessage === "function"
          ? (doc, message, opts) => globalThis.__c2cWriteCanonicalMessage(doc, message, opts)
          : undefined,
      verifyCanonicalComposer:
        typeof globalThis.__c2cVerifyCanonicalComposer === "function"
          ? (doc, message, opts) => globalThis.__c2cVerifyCanonicalComposer(doc, message, opts)
          : undefined,
      dispatchNativeSend:
        typeof globalThis.__c2cDispatchNativeSend === "function"
          ? (doc, message, opts) => globalThis.__c2cDispatchNativeSend(doc, message, opts)
          : undefined,
      snapshotUserTurns:
        typeof globalThis.snapshotUserTurns === "function"
          ? (doc) => globalThis.snapshotUserTurns(doc)
          : undefined,
      findCanonicalUserTurn:
        typeof globalThis.findCanonicalUserTurn === "function"
          ? (doc, input) => globalThis.findCanonicalUserTurn(doc, input)
          : undefined,
      hasExactAttemptMarker:
        typeof globalThis.hasExactAttemptMarker === "function"
          ? (message, attemptId) => globalThis.hasExactAttemptMarker(message, attemptId)
          : undefined,
      // Send-ready readiness DI — reuse already-packaged runtime globals only.
      resolveChatGptComposer:
        typeof globalThis.resolveChatGptComposer === "function"
          ? (doc) => globalThis.resolveChatGptComposer(doc)
          : undefined,
      resolveChatGptAction:
        typeof globalThis.resolveChatGptAction === "function"
          ? (doc, editor) => globalThis.resolveChatGptAction(doc, editor)
          : undefined,
      readCanonicalComposerText:
        typeof globalThis.__c2cReadCanonicalComposerText === "function"
          ? (editor) => globalThis.__c2cReadCanonicalComposerText(editor)
          : undefined,
      normalizeCanonicalDomText:
        typeof globalThis.normalizeCanonicalDomText === "function"
          ? (text) => globalThis.normalizeCanonicalDomText(text)
          : undefined,
    };
  }

  function buildProductionNetworkDeps() {
    let currentJournal = null;
    return {
      get currentJournal() {
        return currentJournal;
      },
      setCurrentJournal(j) {
        currentJournal = j;
      },
      persistJournal: async (next) => {
        const res = await swRpc({
          type: "c2c.production.journal.persist",
          expectedPrevious: currentJournal,
          proposed: next,
        });
        if (!res || res.ok !== true) {
          throw new Error(res?.reason || "production_persist_failed");
        }
        currentJournal = next;
        return next;
      },
      beginSend: async (input) => {
        const res = await swRpc({
          type: "c2c.production.begin.send",
          eventId: input?.eventId,
          reservationId: input?.reservationId,
          routeCanonical: input?.routeCanonical,
          bindingId: input?.bindingId,
          epoch: input?.epoch,
        });
        if (!res || res.ok !== true) {
          const err = new Error(res?.reason || "begin_send_failed");
          err.productionReason = res?.reason;
          throw err;
        }
        return {
          eventId: res.eventId,
          status: res.status,
          attemptId: res.attemptId,
          message: res.message,
          messageSha256: res.messageSha256,
        };
      },
      ackObserved: async (input) => {
        const res = await swRpc({
          type: "c2c.production.ack",
          eventId: input?.eventId,
          attemptId: input?.attemptId,
          reservationId: input?.reservationId,
        });
        if (!res || res.ok !== true) {
          const err = new Error(res?.reason || "ack_failed");
          err.productionReason = res?.reason;
          err.retryAck = res?.retryAck === true;
          throw err;
        }
        return { eventId: res.eventId, status: res.status };
      },
    };
  }

  function handleProductionExecute(message, sendResponse) {
    const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
    const expectedGeneration = message.expectedGeneration;
    const startJournal = message.startJournal;
    if (typeof globalThis.__c2cRunProductionSend !== "function") {
      sendResponse({
        ok: false,
        reason: "production_send_capability_missing",
        mode: "production_send",
        journalState: startJournal?.state ?? "NONE",
        zeroWrite: true,
        zeroClick: true,
      });
      return false;
    }
    if (!startJournal || startJournal.state !== "RESERVED") {
      sendResponse({
        ok: false,
        reason: "production_start_journal_invalid",
        mode: "production_send",
        zeroWrite: true,
        zeroClick: true,
      });
      return false;
    }
    void (async () => {
      const dom = buildProductionDomDeps();
      const net = buildProductionNetworkDeps();
      net.setCurrentJournal(startJournal);
      let result;
      try {
        result = await globalThis.__c2cRunProductionSend({
          ...dom,
          journal: startJournal,
          expectedRoute,
          expectedGeneration,
          routeCanonical: startJournal.routeCanonical,
          bindingId: startJournal.bindingId,
          epoch: startJournal.epoch,
          persistJournal: net.persistJournal,
          beginSend: net.beginSend,
          ackObserved: net.ackObserved,
        });
      } catch {
        result = {
          ok: false,
          reason: "production_send_error",
          journal: net.currentJournal,
        };
      }
      sendResponse({
        ok: result?.ok === true,
        mode: "production_send",
        reason: result?.ok ? undefined : (result?.reason || "production_send_failed"),
        attemptId: result?.attemptId ?? result?.journal?.attemptId ?? null,
        eventId: result?.journal?.eventId ?? startJournal.eventId,
        journalState: result?.journal?.state ?? net.currentJournal?.state ?? startJournal.state,
        retryAck: result?.retryAck === true,
        zeroWrite: result?.zeroWrite === true,
        zeroClick: result?.zeroClick === true,
        action: result?.action,
        generation,
        type: "c2c.production.send.result",
      });
    })();
    return true;
  }

  function handleProductionRecover(message, sendResponse) {
    const expectedRoute = typeof message.expectedRoute === "string" ? message.expectedRoute : "";
    const expectedGeneration = message.expectedGeneration;
    const startJournal = message.startJournal;
    const inFlight = message.inFlight ?? null;
    if (typeof globalThis.__c2cRecoverProductionSend !== "function") {
      sendResponse({
        ok: false,
        reason: "production_recover_capability_missing",
        mode: "production_recover",
        journalState: startJournal?.state ?? "NONE",
        zeroWrite: true,
        zeroClick: true,
      });
      return false;
    }
    void (async () => {
      const dom = buildProductionDomDeps();
      const net = buildProductionNetworkDeps();
      net.setCurrentJournal(startJournal);
      let result;
      try {
        result = await globalThis.__c2cRecoverProductionSend({
          ...dom,
          journal: startJournal,
          expectedRoute,
          expectedGeneration,
          routeCanonical: startJournal.routeCanonical,
          bindingId: startJournal.bindingId,
          epoch: startJournal.epoch,
          inFlight,
          persistJournal: net.persistJournal,
          beginSend: net.beginSend,
          ackObserved: net.ackObserved,
        });
      } catch {
        result = {
          ok: false,
          reason: "production_recover_error",
          journal: net.currentJournal,
          zeroWrite: true,
          zeroClick: true,
        };
      }
      sendResponse({
        ok: result?.ok === true,
        mode: "production_recover",
        reason: result?.ok ? undefined : (result?.reason || "production_recover_failed"),
        recovered: result?.ok === true,
        action: result?.action,
        journalState: result?.journal?.state ?? net.currentJournal?.state ?? startJournal?.state,
        retryAck: result?.retryAck === true,
        zeroWrite: result?.zeroWrite === true,
        zeroClick: result?.zeroClick === true,
        diagnostic: result?.diagnostic ?? null,
        generation,
        type: "c2c.production.recover.result",
      });
    })();
    return true;
  }

  report();
})();
