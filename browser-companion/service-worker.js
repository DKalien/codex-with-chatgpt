/**
 * C2C Browser Companion service worker (E1b1 review-fix).
 * Secrets stay here only; content scripts never see credentials.
 * Read-only ownership layer — no composer write, no Send.
 *
 * Hydration barrier: all ownership handlers await initPromise.
 * Missing sender.documentId is fail-closed (no synthetic identity).
 */

import {
  emptyOwnerState,
  bindOwner,
  invalidateOnTabRemoved,
  isOwner,
  ownerStatus,
  resetSessionOwnership,
  resolveSenderDocumentIdentity,
  applyObserveOwnership,
  OWNERSHIP_SCHEMA_VERSION,
} from "./ownership.js";
import { parseChatgptConversationRoute } from "./route-esm.js";

const LOCAL_KEY = "c2c_companion_local_v1";
const SESSION_OWNER_KEY = "c2c_companion_owner_v1";
const SESSION_REG_KEY = "c2c_companion_registry_v1";

let localState = { schemaVersion: 1, targetRoute: null, paired: false };
let ownerState = emptyOwnerState();
let hydrated = false;

const initPromise = (async () => {
  await hydrate();
})();

async function hydrate() {
  if (hydrated) return;
  const stored = await chrome.storage.local.get(LOCAL_KEY);
  const row = stored[LOCAL_KEY];
  if (row && typeof row === "object") {
    localState = {
      schemaVersion: 1,
      targetRoute: typeof row.targetRoute === "string" ? row.targetRoute : null,
      paired: row.paired === true,
    };
  } else {
    // initialize-if-missing only; never wipe durable state on update
    localState = { schemaVersion: 1, targetRoute: null, paired: false };
    await chrome.storage.local.set({ [LOCAL_KEY]: localState });
  }
  const live = await chrome.storage.session.get([SESSION_OWNER_KEY, SESSION_REG_KEY]);
  const owner = live[SESSION_OWNER_KEY];
  const registry = live[SESSION_REG_KEY];
  ownerState = {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: localState.targetRoute,
    owner: owner && typeof owner === "object" ? owner : null,
    registry: Array.isArray(registry) ? registry : [],
  };
  hydrated = true;
}

async function persistLocal() {
  await chrome.storage.local.set({ [LOCAL_KEY]: localState });
}

async function persistSessionOwnership() {
  await chrome.storage.session.set({
    [SESSION_OWNER_KEY]: ownerState.owner,
    [SESSION_REG_KEY]: ownerState.registry,
  });
}

function parseRouteSafe(href) {
  try {
    return parseChatgptConversationRoute(href, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
  } catch {
    return null;
  }
}

function statusPayload(tabId, documentId, extra = {}) {
  return {
    ok: true,
    targetRoute: localState.targetRoute,
    paired: localState.paired,
    hydrated,
    isOwner: documentId != null ? isOwner(ownerState, tabId, documentId) : false,
    ownership: documentId != null
      ? ownerStatus(ownerState, tabId, documentId)
      : ownerStatus(ownerState, -1, ""),
    ...extra,
  };
}

/** Unbind clears local target + session owner + in-memory owner atomically. */
async function unbindAll() {
  localState = { schemaVersion: 1, targetRoute: null, paired: false };
  ownerState = {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: null,
    owner: null,
    registry: [],
  };
  await persistLocal();
  await persistSessionOwnership();
  return { ok: true, targetRoute: null, isOwner: false, ownership: ownerStatus(ownerState, -1, "") };
}

async function handleMessage(message, sender) {
  await initPromise;
  if (!message || typeof message !== "object") return { ok: false, reason: "bad_message" };

  // Unbind is global (popup); status for ownership must come from page content script.
  if (message.type === "c2c.unbind") {
    return unbindAll();
  }

  const identity = resolveSenderDocumentIdentity(sender);
  const tabId =
    identity.ok || identity.reason === "document_id_unavailable" ? identity.tabId : null;
  const documentId = identity.ok ? identity.documentId : null;

  const href = typeof message.href === "string" ? message.href : sender?.url;
  const parsed = parseRouteSafe(href ?? "");
  const canonical = parsed ? parsed.canonical : null;
  const generation = Number.isFinite(message.generation) ? Number(message.generation) : 1;

  // Page-originated status/observe/bind (sender is ChatGPT content script).
  if (message.type === "c2c.status.page" || message.type === "c2c.observe") {
    if (!identity.ok && identity.reason !== "document_id_unavailable") {
      return { ok: false, reason: identity.reason };
    }
    ownerState = applyObserveOwnership(ownerState, {
      tabId: tabId ?? -1,
      documentId,
      canonicalRoute: canonical,
      generation,
      now: Date.now(),
    });
    await persistSessionOwnership();
    return statusPayload(tabId ?? -1, documentId, {
      canonicalRoute: canonical,
      documentIdAvailable: Boolean(documentId),
      source: "page",
    });
  }

  if (message.type === "c2c.bind") {
    if (!identity.ok) {
      return {
        ok: false,
        reason: identity.reason,
        canonicalRoute: canonical,
        targetRoute: localState.targetRoute,
      };
    }
    if (!canonical) return { ok: false, reason: "invalid_route" };
    const result = bindOwner(
      ownerState,
      {
        tabId: identity.tabId,
        documentId: identity.documentId,
        canonicalRoute: canonical,
        generation,
        frameId: 0,
        lastSeen: Date.now(),
      },
      canonical,
    );
    ownerState = result.state;
    if (result.ok) {
      localState = {
        ...localState,
        targetRoute: canonical,
        paired: true,
      };
      await persistLocal();
    }
    await persistSessionOwnership();
    return statusPayload(identity.tabId, identity.documentId, {
      reason: result.reason,
      canonicalRoute: canonical,
    });
  }

  return { ok: false, reason: "unknown_type" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: "internal" }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await initPromise;
    ownerState = invalidateOnTabRemoved(ownerState, tabId);
    await persistSessionOwnership();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await initPromise;
    // initialize-if-missing; do not reset durable targetRoute on update
    const stored = await chrome.storage.local.get(LOCAL_KEY);
    if (!stored[LOCAL_KEY]) {
      localState = { schemaVersion: 1, targetRoute: null, paired: false };
      await persistLocal();
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await initPromise;
    ownerState = resetSessionOwnership(emptyOwnerState());
    ownerState.targetRoute = localState.targetRoute;
    await persistSessionOwnership();
  })();
});
