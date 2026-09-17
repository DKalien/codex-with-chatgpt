/**
 * E1b3d1 read-only shadow DOM evidence.
 * Browser-safe ESM; classic packaging attaches inspectShadowEvidence only.
 * NEVER mutates DOM, never clicks, never focuses, never execCommand.
 */

function resolveHelpers(opts = {}) {
  const g = globalThis;
  return {
    observeChatGptSafety: opts.observeChatGptSafety || g.observeChatGptSafety,
    resolveChatGptComposer: opts.resolveChatGptComposer || g.resolveChatGptComposer,
    resolveChatGptAction: opts.resolveChatGptAction || g.resolveChatGptAction,
    inspectChatGptActionEvidence: opts.inspectChatGptActionEvidence || g.inspectChatGptActionEvidence,
    inspectActiveComposerControls: opts.inspectActiveComposerControls || g.inspectActiveComposerControls,
    inspectComposerContainerInventory: opts.inspectComposerContainerInventory || g.inspectComposerContainerInventory,
    normalizeCanonicalDomText: opts.normalizeCanonicalDomText || g.normalizeCanonicalDomText,
    snapshotUserTurns: opts.snapshotUserTurns || g.snapshotUserTurns,
    parseChatgptConversationRoute: opts.parseChatgptConversationRoute || g.parseChatgptConversationRoute,
  };
}

/**
 * Read-only structured evidence for owner ChatGPT document.
 * @param {Document} doc
 * @param {{ locationHref?: string, now?: number, [k: string]: unknown }} [opts]
 */
export function inspectShadowEvidence(doc, opts = {}) {
  const helpers = resolveHelpers(opts);
  try {
    if (
      typeof helpers.observeChatGptSafety !== "function"
      || typeof helpers.resolveChatGptComposer !== "function"
      || typeof helpers.resolveChatGptAction !== "function"
    ) {
      return { ok: false, reason: "capability_missing", mode: "read_only" };
    }
    const href = opts.locationHref
      ?? (typeof location !== "undefined" ? location.href : "");
    const parsed = (typeof helpers.parseChatgptConversationRoute === "function" && href)
      ? helpers.parseChatgptConversationRoute(href, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      })
      : null;
    const canonicalRoute = parsed && parsed.canonical ? parsed.canonical : null;
    const routeValid = Boolean(canonicalRoute);

    const { editor, kind, evidence: composerEvidence } = helpers.resolveChatGptComposer(doc);
    const action = helpers.resolveChatGptAction(doc, editor);
    const diagnostic = typeof helpers.inspectChatGptActionEvidence === "function"
      ? helpers.inspectChatGptActionEvidence(doc, editor)
      : null;
    const inventory = diagnostic?.inventory
      ?? (typeof helpers.inspectActiveComposerControls === "function"
        ? helpers.inspectActiveComposerControls(doc, editor)
        : { formPresent: false, buttonCount: 0, buttons: [] });
    const containerInventory = diagnostic?.containerInventory
      ?? (typeof helpers.inspectComposerContainerInventory === "function"
        ? helpers.inspectComposerContainerInventory(doc, editor)
        : { ancestors: [], controlContainers: [] });
    const safety = helpers.observeChatGptSafety(doc, { routeValid });

    let textEmpty = null;
    if (editor) {
      const raw = typeof editor.value === "string" ? editor.value : (editor.textContent ?? "");
      const normalized = (typeof helpers.normalizeCanonicalDomText === "function")
        ? helpers.normalizeCanonicalDomText(String(raw))
        : String(raw)
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/ /g, " ");
      textEmpty = normalized.replace(/ /g, " ").trim().length === 0;
    }

    let hasExactSendButton = false;
    try {
      const form = editor && typeof editor.closest === "function" ? editor.closest("form") : null;
      if (form && typeof form.querySelector === "function") {
        hasExactSendButton = Boolean(form.querySelector('button[data-testid="send-button"]'));
      }
    } catch {
      hasExactSendButton = false;
    }

    let userTurnCount = 0;
    try {
      if (typeof helpers.snapshotUserTurns === "function") {
        userTurnCount = (helpers.snapshotUserTurns(doc) || []).length;
      }
    } catch {
      userTurnCount = 0;
    }

    return {
      ok: true,
      mode: "read_only",
      canonicalRoute,
      href,
      composer: {
        present: Boolean(editor),
        editorKind: kind,
        evidence: composerEvidence ?? null,
        textEmpty,
      },
      action: {
        kind: action.kind,
        enabled: action.enabled === true,
        hasExactSendButton: diagnostic?.hasExactSendButton
          ?? (() => {
            try {
              const form = editor && typeof editor.closest === "function" ? editor.closest("form") : null;
              return Boolean(form && form.querySelector?.('button[data-testid="send-button"]'));
            } catch {
              return false;
            }
          })(),
        evidence: action.evidence ?? null,
        stopEvidence: diagnostic?.stopEvidence ?? null,
        inventory,
        containerInventory,
      },
      safety: {
        generation: safety.generation,
        safe: safety.safe === true,
        composer: safety.composer,
      },
      userTurnCount,
      observedAt: typeof opts.now === "number" ? opts.now : Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "inspect_error",
      mode: "read_only",
      error: String(error?.message || error),
    };
  }
}
