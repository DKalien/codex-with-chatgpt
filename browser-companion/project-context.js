import { BridgeOriginError, parseBridgeOrigin } from "./bridge-origin.js";
import { parseChatgptConversationRoute } from "./route-esm.js";

export const PROJECT_REGISTRY_KEY = "c2c_companion_projects_v1";
export const PROJECT_SELECTION_KEY = "c2c_companion_project_selection_v1";
export const PROJECT_CONTEXT_PREFIX = "c2c_companion_project_v1:";

function workspaceToken(value) {
  return typeof value === "string" && /^[a-f0-9]{12}$/.test(value);
}

function projectOrigin(value) {
  try {
    return parseBridgeOrigin(value, { allowLoopbackHttp: true });
  } catch (error) {
    if (error instanceof BridgeOriginError) return null;
    return null;
  }
}

export function projectStorageKey(workspaceId, key) {
  if (!workspaceToken(workspaceId) || typeof key !== "string" || !key) {
    throw new TypeError("project storage identity is invalid");
  }
  return `${PROJECT_CONTEXT_PREFIX}${workspaceId}:${key}`;
}

export function parseProjectRegistry(raw) {
  if (raw == null) return { ok: true, registry: { schemaVersion: 1, projects: [], legacyMigration: "pending" } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.schemaVersion !== 1 || !Array.isArray(raw.projects)
    || !["pending", "none", "migrated", "blocked"].includes(raw.legacyMigration)) {
    return { ok: false, reason: "project_registry_invalid" };
  }
  const projects = [];
  const seen = new Set();
  for (const row of raw.projects) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some(key => !["workspaceId", "bridgeOrigin", "legacy"].includes(key))
      || !workspaceToken(row.workspaceId) || typeof row.bridgeOrigin !== "string") {
      return { ok: false, reason: "project_registry_invalid" };
    }
    const origin = projectOrigin(row.bridgeOrigin);
    if (!origin || origin !== row.bridgeOrigin || seen.has(row.workspaceId)) {
      return { ok: false, reason: "project_registry_invalid" };
    }
    seen.add(row.workspaceId);
    projects.push({ workspaceId: row.workspaceId, bridgeOrigin: origin, ...(row.legacy === true ? { legacy: true } : {}) });
  }
  return {
    ok: true,
    registry: { schemaVersion: 1, projects, legacyMigration: raw.legacyMigration },
  };
}

function scopedStorageArea(area, workspaceId) {
  const prefix = `${PROJECT_CONTEXT_PREFIX}${workspaceId}:`;
  const mapKey = key => projectStorageKey(workspaceId, key);
  const unmap = row => Object.fromEntries(Object.entries(row ?? {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]));
  return new Proxy(area, {
    get(target, property) {
      if (property === "get") return async keys => {
        if (keys == null) return unmap(await target.get(null));
        const mapped = typeof keys === "string"
          ? mapKey(keys)
          : Array.isArray(keys)
            ? keys.map(mapKey)
            : Object.fromEntries(Object.entries(keys).map(([key, value]) => [mapKey(key), value]));
        const stored = await target.get(mapped);
        if (typeof keys === "string") return { [keys]: stored[mapKey(keys)] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, stored[mapKey(key)]]));
        if (keys && typeof keys === "object") {
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(stored, mapKey(key)) ? stored[mapKey(key)] : fallback,
          ]));
        }
        return {};
      };
      if (property === "set") return row => target.set(
        Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [mapKey(key), value])),
      );
      if (property === "remove") return keys => target.remove(
        typeof keys === "string" ? mapKey(keys) : (keys ?? []).map(mapKey),
      );
      if (property === "clear") return async () => {
        const owned = Object.keys(await target.get(null)).filter(key => key.startsWith(prefix));
        if (owned.length) await target.remove(owned);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function scopedAlarms(alarms, workspaceId) {
  if (!alarms) return alarms;
  const prefix = `${PROJECT_CONTEXT_PREFIX}${workspaceId}:alarm:`;
  const mapName = name => `${prefix}${name}`;
  const scoped = new Proxy(alarms, {
    get(target, property) {
      if (["create", "get", "clear"].includes(property)) {
        return (name, ...args) => target[property](mapName(name), ...args);
      }
      if (property === "onAlarm") {
        return new Proxy(target.onAlarm, {
          get(event, eventProperty) {
            if (eventProperty === "addListener") return listener => event.addListener(alarm => {
              if (typeof alarm?.name === "string" && alarm.name.startsWith(prefix)) {
                listener({ ...alarm, name: alarm.name.slice(prefix.length) });
              }
            });
            const value = Reflect.get(event, eventProperty, event);
            return typeof value === "function" ? value.bind(event) : value;
          },
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return scoped;
}

function selectedAction(action, isSelected) {
  if (!action) return action;
  return new Proxy(action, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (["setBadgeText", "setTitle", "setBadgeBackgroundColor"].includes(property)) {
        return (...args) => isSelected() ? value.apply(target, args) : false;
      }
      return value.bind(target);
    },
  });
}

const PAGE_MUTATION_TYPES = new Set([
  "c2c.feedback.bootstrap.execute",
  "c2c.route.attest.execute",
  "c2c.write.probe.execute",
  "c2c.send.probe.execute",
  "c2c.production.send.execute",
  "c2c.production.send.recover",
]);
const SELECTED_PAGE_WORKSPACE_TYPES = new Set([
  "c2c.bind",
  "c2c.connect.page",
  "c2c.owner-proof.request",
]);

export function createProjectChrome(browser, workspaceId, isSelected = () => false, withPageSendLock = null) {
  return new Proxy(browser, {
    get(target, property) {
      if (property === "storage") return new Proxy(target.storage, {
        get(storage, area) {
          if (area === "local" || area === "session") return scopedStorageArea(storage[area], workspaceId);
          const value = Reflect.get(storage, area, storage);
          return typeof value === "function" ? value.bind(storage) : value;
        },
      });
      if (property === "alarms") return scopedAlarms(target.alarms, workspaceId);
      if (property === "action") return selectedAction(target.action, isSelected);
      if (property === "tabs" && withPageSendLock) return new Proxy(target.tabs, {
        get(tabs, tabProperty) {
          if (tabProperty === "sendMessage") return (tabId, message, ...args) => {
            const send = () => Reflect.apply(tabs.sendMessage, tabs, [tabId, message, ...args]);
            return PAGE_MUTATION_TYPES.has(message?.type)
              ? withPageSendLock(tabId, send, {
                  workspaceId,
                  documentId: args[0]?.documentId,
                  type: message.type,
                })
              : send();
          };
          const value = Reflect.get(tabs, tabProperty, tabs);
          return typeof value === "function" ? value.bind(tabs) : value;
        },
      });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function routeMatches(a, b, equivalent) {
  return typeof a === "string" && typeof b === "string" && equivalent(a, b);
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function hasValues(row) {
  return Object.values(row ?? {}).some(value => value !== undefined);
}

function isCanonicalChatRoute(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = parseChatgptConversationRoute(value, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
    return parsed?.canonical === value;
  } catch {
    return false;
  }
}

function isLegacyOperationsPanelSender(sender, browser) {
  if (sender?.id !== browser?.runtime?.id || !Number.isSafeInteger(sender?.tab?.id)) return false;
  try {
    const expected = new URL(browser.runtime.getURL("operations/operations.html"));
    const exactLegacyUrl = value => {
      const url = new URL(value);
      return url.protocol === expected.protocol && url.hostname === expected.hostname && url.port === expected.port
        && url.pathname === expected.pathname && !url.search && !url.hash;
    };
    return exactLegacyUrl(sender.url) && sender.url === sender.tab.url;
  } catch { return false; }
}

export function createProjectContextRouter({
  browser = globalThis.chrome,
  createContext,
  localKeys = [],
  sessionKeys = [],
  transportKey = "c2c_companion_transport_v1",
  localIdentityKey = "c2c_companion_local_v1",
  journalKey = "c2c_companion_journal_v1",
  journalStates = [],
  isInternalSender = sender => Boolean(sender && sender.tab == null),
  isLegacyPanelSender = sender => isLegacyOperationsPanelSender(sender, browser),
  validateLegacyJournal = ({ journal, transport }) => journal?.state === "NONE"
    || (journal?.routeCanonical === transport?.routeCanonical
      && journal?.bindingId === transport?.bindingId && journal?.epoch === transport?.epoch),
  routesEquivalent = (a, b) => a === b,
}) {
  const contexts = new Map();
  const selections = new Map();
  const sendQueues = new Map();
  const selectionBusyTabs = new Set();
  const pendingMutations = new Map();
  const routeQueues = new Map();
  let registry = null;
  let registryError = null;
  let registryPromise = null;
  let registryMutationQueue = Promise.resolve();
  let selectedWorkspaceId = null;
  let selectionLoadPromise = null;
  let storageAccessPromise = null;

  async function serialize(queue, key, work) {
    const previous = queue.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    queue.set(key, queued);
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (queue.get(key) === queued) queue.delete(key);
    }
  }

  async function withRegistryMutation(work) {
    const previous = registryMutationQueue;
    let release;
    registryMutationQueue = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try { return await work(); }
    finally { release(); }
  }

  function withTabRouteLock(tabId, work) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return Promise.resolve({ ok: false, reason: "owner_document_invalid" });
    return serialize(routeQueues, tabId, work);
  }

  async function saveRegistry() {
    await browser.storage.local.set({ [PROJECT_REGISTRY_KEY]: registry });
  }

  async function loadSelections() {
    const stored = await browser.storage.session.get(PROJECT_SELECTION_KEY);
    const rows = stored[PROJECT_SELECTION_KEY];
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && Number.isSafeInteger(row.tabId) && row.tabId >= 0
        && workspaceToken(row.workspaceId) && isCanonicalChatRoute(row.canonicalRoute)) {
        selections.set(row.tabId, { workspaceId: row.workspaceId, canonicalRoute: row.canonicalRoute });
      }
    }
  }

  async function persistSelections(source = selections) {
    const rows = [...source].slice(-64).map(([tabId, row]) => ({ tabId, ...row }));
    await browser.storage.session.set({ [PROJECT_SELECTION_KEY]: rows });
  }

  async function migrateLegacyState(candidateRegistry) {
    const oldLocal = await browser.storage.local.get(localKeys);
    const oldSession = await browser.storage.session.get(sessionKeys);
    if (!hasValues(oldLocal) && !hasValues(oldSession)) {
      candidateRegistry.legacyMigration = "none";
      return { ok: true, registry: candidateRegistry };
    }
    const transport = oldLocal[transportKey];
    const workspaceId = transport?.workspaceId;
    const origin = projectOrigin(transport?.bridgeOrigin);
    if (!plainObject(transport) || !workspaceToken(workspaceId) || !origin
      || origin !== transport.bridgeOrigin
      || !isCanonicalChatRoute(transport.routeCanonical)
      || typeof transport.credential !== "string" || !transport.credential
      || typeof transport.companionId !== "string" || !transport.companionId
      || typeof transport.bindingId !== "string" || !transport.bindingId
      || !plainObject(oldLocal[localIdentityKey])
      || oldLocal[localIdentityKey].schemaVersion !== 1
      || typeof oldLocal[localIdentityKey].paired !== "boolean"
      || (oldLocal[journalKey] != null
        && (!plainObject(oldLocal[journalKey]) || !["NONE", ...journalStates].includes(oldLocal[journalKey].state)
          || !validateLegacyJournal({ journal: oldLocal[journalKey], transport })))) {
      candidateRegistry.legacyMigration = "blocked";
      return { ok: false, reason: "legacy_state_identity_unknown", registry: candidateRegistry };
    }
    if (oldLocal[localIdentityKey].targetRoute != null
      && !routeMatches(oldLocal[localIdentityKey].targetRoute, transport.routeCanonical, routesEquivalent)) {
      candidateRegistry.legacyMigration = "blocked";
      return { ok: false, reason: "legacy_state_identity_unknown", registry: candidateRegistry };
    }
    const duplicate = candidateRegistry.projects.find(project => project.workspaceId === workspaceId);
    if (duplicate && duplicate.bridgeOrigin !== origin) {
      candidateRegistry.legacyMigration = "blocked";
      return { ok: false, reason: "legacy_state_identity_unknown", registry: candidateRegistry };
    }
    if (!duplicate && candidateRegistry.projects.length > 0) {
      candidateRegistry.legacyMigration = "blocked";
      return { ok: false, reason: "legacy_state_identity_unknown", registry: candidateRegistry };
    }
    const legacyProject = duplicate ?? { workspaceId, bridgeOrigin: origin, legacy: true };
    if (!duplicate) candidateRegistry.projects.push(legacyProject);

    const localCopy = Object.fromEntries(Object.entries(oldLocal)
      .filter(([key, value]) => localKeys.includes(key) && value !== undefined)
      .map(([key, value]) => [projectStorageKey(workspaceId, key), value]));
    const sessionCopy = Object.fromEntries(Object.entries(oldSession)
      .filter(([key, value]) => sessionKeys.includes(key) && value !== undefined)
      .map(([key, value]) => [projectStorageKey(workspaceId, key), value]));
    const [targetLocal, targetSession] = await Promise.all([
      browser.storage.local.get(Object.keys(localCopy)),
      browser.storage.session.get(Object.keys(sessionCopy)),
    ]);
    for (const [key, value] of Object.entries(localCopy)) {
      if (targetLocal[key] !== undefined && stableJson(targetLocal[key]) !== stableJson(value)) {
        candidateRegistry.legacyMigration = "blocked";
        return { ok: false, reason: "legacy_state_conflict", registry: candidateRegistry };
      }
    }
    for (const [key, value] of Object.entries(sessionCopy)) {
      if (targetSession[key] !== undefined && stableJson(targetSession[key]) !== stableJson(value)) {
        candidateRegistry.legacyMigration = "blocked";
        return { ok: false, reason: "legacy_state_conflict", registry: candidateRegistry };
      }
    }
    if (Object.keys(sessionCopy).length) await browser.storage.session.set(sessionCopy);
    candidateRegistry.legacyMigration = "migrated";
    await browser.storage.local.set({ ...localCopy, [PROJECT_REGISTRY_KEY]: candidateRegistry });
    return { ok: true, registry: candidateRegistry };
  }

  async function establishStorageAccess() {
    if (!storageAccessPromise) storageAccessPromise = (async () => {
      try {
        if (typeof browser.storage?.local?.setAccessLevel !== "function") throw new Error("storage_access_unavailable");
        await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        return true;
      } catch {
        let all = null;
        try { all = await browser.storage.local.get(null); } catch { /* try exact known keys below */ }
        const keys = new Set([transportKey]);
        if (all && typeof all === "object") {
          for (const key of Object.keys(all)) {
            if (/^c2c_companion_project_v1:[a-f0-9]{12}:c2c_companion_transport_v1$/.test(key)) keys.add(key);
          }
        }
        try {
          const stored = await browser.storage.local.get(PROJECT_REGISTRY_KEY);
          const parsed = parseProjectRegistry(stored[PROJECT_REGISTRY_KEY]);
          if (parsed.ok) {
            for (const project of parsed.registry.projects) {
              keys.add(projectStorageKey(project.workspaceId, transportKey));
            }
          }
        } catch { /* unknown projects remain untouched; access stays blocked */ }
        for (const key of keys) {
          try {
            const stored = await browser.storage.local.get(key);
            const value = stored?.[key];
            if (!plainObject(value) || typeof value.credential !== "string") continue;
            const safe = { ...value };
            delete safe.credential;
            try { await browser.storage.local.set({ [key]: safe }); }
            catch { await browser.storage.local.remove(key).catch(() => undefined); }
          } catch {
            await browser.storage.local.remove(key).catch(() => undefined);
          }
        }
        return false;
      }
    })();
    return storageAccessPromise;
  }

  async function ensureRegistry() {
    if (!registryPromise) registryPromise = (async () => {
      if (!await establishStorageAccess()) {
        registryError = "storage_unprotected";
        return;
      }
      const stored = await browser.storage.local.get(PROJECT_REGISTRY_KEY);
      const parsed = parseProjectRegistry(stored[PROJECT_REGISTRY_KEY]);
      if (!parsed.ok) {
        registryError = parsed.reason;
        return;
      }
      const result = parsed.registry.legacyMigration === "pending"
        ? await migrateLegacyState(parsed.registry)
        : { ok: parsed.registry.legacyMigration !== "blocked", reason: "legacy_state_identity_unknown", registry: parsed.registry };
      registry = result.registry;
      if (!registry) registryError = result.reason;
      else if (!result.ok) {
        registryError = result.reason;
        await saveRegistry().catch(() => undefined);
      } else if (stored[PROJECT_REGISTRY_KEY] === undefined) {
        await saveRegistry();
      }
      selectionLoadPromise = loadSelections().catch(() => {});
    })().catch(() => { registryError = "project_registry_unavailable"; });
    await registryPromise;
    await selectionLoadPromise;
    if (registryError) return { ok: false, reason: registryError };
    return { ok: true, registry };
  }

  function contextFor(project) {
    let context = contexts.get(project.workspaceId);
    if (!context) {
      context = createContext(project, () => selectedWorkspaceId === project.workspaceId, withPageSendLock);
      contexts.set(project.workspaceId, context);
    }
    return context;
  }

  function findProject(workspaceId) {
    return registry?.projects.find(project => project.workspaceId === workspaceId) ?? null;
  }

  async function listProjects() {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    const projects = await Promise.all(registry.projects.map(async project => ({
      ...project,
      status: await contextFor(project).summary(),
    })));
    return { ok: true, projects, migration: registry.legacyMigration };
  }

  async function addProject(project) {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    if (!project || typeof project !== "object" || Array.isArray(project)
      || Object.keys(project).some(key => !["workspaceId", "bridgeOrigin"].includes(key))
      || !workspaceToken(project.workspaceId) || typeof project.bridgeOrigin !== "string") {
      return { ok: false, reason: "project_identity_invalid" };
    }
    const origin = projectOrigin(project.bridgeOrigin);
    if (!origin || origin !== project.bridgeOrigin) return { ok: false, reason: "bridge_origin_invalid" };
    return withRegistryMutation(async () => {
      const existing = findProject(project.workspaceId);
      if (existing) {
        if (existing.bridgeOrigin !== origin) return { ok: false, reason: "project_origin_conflict" };
        return { ok: true, project: existing };
      }
      const added = { workspaceId: project.workspaceId, bridgeOrigin: origin };
      const nextRegistry = { ...registry, projects: [...registry.projects, added] };
      try { await browser.storage.local.set({ [PROJECT_REGISTRY_KEY]: nextRegistry }); }
      catch { return { ok: false, reason: "project_registry_persist_failed" }; }
      registry = nextRegistry;
      return { ok: true, project: added };
    });
  }

  async function selectProject(message, sender) {
    if (!isInternalSender(sender, message.workspaceId)) return { ok: false, reason: "popup_sender_required" };
    const tabId = message.tabId;
    const canonicalRoute = message.canonicalRoute;
    if (!Number.isSafeInteger(tabId) || tabId < 0 || !isCanonicalChatRoute(canonicalRoute)) {
      return { ok: false, reason: "workspace_selection_invalid" };
    }
    return withTabRouteLock(tabId, async () => {
      const project = findProject(message.workspaceId);
      if (!project) return { ok: false, reason: "workspace_not_registered" };
      if (sendQueues.has(tabId)) return { ok: false, reason: "workspace_operation_busy" };
      for (const other of registry.projects) {
        if (other.workspaceId === project.workspaceId) continue;
        if (await contextFor(other).ownsTabRoute(tabId, canonicalRoute)) {
          return { ok: false, reason: "workspace_binding_conflict" };
        }
      }
      if (sendQueues.has(tabId)) return { ok: false, reason: "workspace_operation_busy" };
      selectionBusyTabs.add(tabId);
      try {
        return await withRegistryMutation(async () => {
          const currentProject = findProject(project.workspaceId);
          if (!currentProject || currentProject.bridgeOrigin !== project.bridgeOrigin) {
            return { ok: false, reason: "workspace_not_registered" };
          }
          if (sendQueues.has(tabId)) return { ok: false, reason: "workspace_operation_busy" };
          const previousSelections = new Map(selections);
          const nextSelections = new Map(selections);
          nextSelections.set(tabId, { workspaceId: currentProject.workspaceId, canonicalRoute });
          try { await persistSelections(nextSelections); }
          catch { return { ok: false, reason: "workspace_selection_persist_failed" }; }
          if (sendQueues.has(tabId)) {
            try { await persistSelections(previousSelections); } catch { /* keep the in-memory route authoritative */ }
            return { ok: false, reason: "workspace_operation_busy" };
          }
          selections.set(tabId, { workspaceId: currentProject.workspaceId, canonicalRoute });
          const selectionChanged = selectedWorkspaceId !== currentProject.workspaceId;
          selectedWorkspaceId = currentProject.workspaceId;
          if (selectionChanged) await contextFor(currentProject).refreshSelectedIndicator?.();
          return { ok: true, workspaceId: currentProject.workspaceId, tabId, canonicalRoute };
        });
      } finally { selectionBusyTabs.delete(tabId); }
    });
  }

  async function routePageMessage(message, sender) {
    const tabId = sender?.tab?.id;
    const route = typeof message?.canonicalRoute === "string" ? message.canonicalRoute : null;
    const selected = Number.isSafeInteger(tabId) ? selections.get(tabId) : null;
    if (selected && selected.canonicalRoute === route && findProject(selected.workspaceId)) {
      return { ok: true, workspaceId: selected.workspaceId, context: contextFor(findProject(selected.workspaceId)) };
    }
    const matching = [];
    for (const project of registry.projects) {
      if (await contextFor(project).matchesOwner(sender, message)) matching.push(contextFor(project));
    }
    if (matching.length === 1) {
      const project = registry.projects.find(row => contextFor(row) === matching[0]);
      return { ok: true, workspaceId: project.workspaceId, context: matching[0] };
    }
    return { ok: false, reason: matching.length > 1 ? "workspace_route_ambiguous" : "workspace_selection_required" };
  }

  async function withPageSendLock(tabId, work, metadata = {}) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return { ok: false, reason: "owner_document_invalid" };
    if (selectionBusyTabs.has(tabId)) return { ok: false, reason: "workspace_operation_busy" };
    return serialize(sendQueues, tabId, async () => {
      if (selectionBusyTabs.has(tabId)) return { ok: false, reason: "workspace_operation_busy" };
      if (!workspaceToken(metadata.workspaceId) || typeof metadata.documentId !== "string" || !metadata.documentId) {
        return { ok: false, reason: "owner_document_invalid" };
      }
      const key = `${tabId}\u0000${metadata.documentId}`;
      if (pendingMutations.has(key)) return { ok: false, reason: "workspace_operation_busy" };
      const pending = { workspaceId: metadata.workspaceId, tabId, documentId: metadata.documentId, type: metadata.type };
      pendingMutations.set(key, pending);
      try { return await work(); }
      finally { if (pendingMutations.get(key) === pending) pendingMutations.delete(key); }
    });
  }

  async function handle(message, sender = {}, routeLockHeld = false) {
    if (!message || typeof message !== "object") return { ok: false, reason: "bad_message" };
    if (["c2c.project.list", "c2c.project.add", "c2c.project.select", "c2c.project.resolve"].includes(message.type)) {
      if (!isInternalSender(sender)) return { ok: false, reason: "popup_sender_required" };
      if (message.type === "c2c.project.list") return listProjects();
      const ready = await ensureRegistry();
      if (!ready.ok) return ready;
      if (message.type === "c2c.project.add") return addProject(message.project);
      if (message.type === "c2c.project.resolve") {
        if (!Number.isSafeInteger(message.tabId) || message.tabId < 0 || !isCanonicalChatRoute(message.canonicalRoute)) {
          return { ok: false, reason: "workspace_selection_invalid" };
        }
        const selection = selections.get(message.tabId);
        return selection?.canonicalRoute === message.canonicalRoute && findProject(selection.workspaceId)
          ? { ok: true, workspaceId: selection.workspaceId }
          : { ok: true, workspaceId: null };
      }
      return selectProject(message, sender);
    }
    if (!routeLockHeld && message.type === "c2c.pair" && sender?.tab == null
      && isInternalSender(sender, message.workspaceId)) {
      const tabId = message.tabId;
      const canonicalRoute = message.canonicalRoute;
      if (!Number.isSafeInteger(tabId) || tabId < 0 || !isCanonicalChatRoute(canonicalRoute)) {
        return { ok: false, reason: "workspace_selection_invalid" };
      }
      return withTabRouteLock(tabId, async () => {
        const selection = selections.get(tabId);
        if (selection?.workspaceId !== message.workspaceId || selection.canonicalRoute !== canonicalRoute) {
          return { ok: false, reason: "workspace_selection_mismatch" };
        }
        return handle(message, sender, true);
      });
    }
    if (!routeLockHeld && Number.isSafeInteger(sender?.tab?.id)
      && ["c2c.bind", "c2c.connect.page", "c2c.observe", "c2c.heartbeat", "c2c.owner-proof.request"].includes(message.type)) {
      return withTabRouteLock(sender.tab.id, () => handle(message, sender, true));
    }
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    const pinnedCallback = [
      "c2c.production.journal.persist",
      "c2c.production.begin.send",
      "c2c.production.ack",
    ].includes(message.type);
    let context;
    let contextWorkspaceId;
    if (pinnedCallback) {
      const tabId = sender?.tab?.id;
      const documentId = sender?.documentId;
      const key = Number.isSafeInteger(tabId) && typeof documentId === "string"
        ? `${tabId}\u0000${documentId}`
        : "";
      const pending = sender?.id === browser.runtime?.id ? pendingMutations.get(key) : null;
      if (!pending || pending.tabId !== tabId || pending.documentId !== documentId) {
        return { ok: false, reason: "workspace_callback_unbound" };
      }
      const project = findProject(pending.workspaceId);
      if (!project) return { ok: false, reason: "workspace_callback_unbound" };
      context = contextFor(project);
      contextWorkspaceId = project.workspaceId;
    }
    if (message.workspaceId != null) {
      if (pinnedCallback) {
        if (message.workspaceId !== contextWorkspaceId) {
          return { ok: false, reason: "workspace_callback_unbound" };
        }
      } else {
        const selection = sender?.tab?.id != null ? selections.get(sender.tab.id) : null;
        const selectedPageMessage = SELECTED_PAGE_WORKSPACE_TYPES.has(message.type)
          && sender?.id === browser.runtime?.id
          && Number.isSafeInteger(sender?.tab?.id)
          && selection?.workspaceId === message.workspaceId
          && selection.canonicalRoute === message.canonicalRoute;
        if (!selectedPageMessage && !isInternalSender(sender, message.workspaceId)) {
          return { ok: false, reason: "popup_sender_required" };
        }
        if (SELECTED_PAGE_WORKSPACE_TYPES.has(message.type) && sender?.tab?.id != null
          && !selectedPageMessage) {
          return { ok: false, reason: "workspace_selection_mismatch" };
        }
      }
    }
    let routeResult = null;
    if (message.workspaceId != null) {
      const project = findProject(message.workspaceId);
      if (!project) return { ok: false, reason: "workspace_not_registered" };
      if (!context) {
        context = contextFor(project);
        contextWorkspaceId = project.workspaceId;
      }
    } else if (!context && sender?.tab?.id != null && isLegacyPanelSender(sender)) {
      const legacyProjects = registry.projects.filter(project => project.legacy === true);
      if (legacyProjects.length !== 1) return { ok: false, reason: "workspace_selection_required" };
      context = contextFor(legacyProjects[0]);
      contextWorkspaceId = legacyProjects[0].workspaceId;
    } else if (!context && sender?.tab?.id != null) {
      routeResult = await routePageMessage(message, sender);
      if (!routeResult.ok) return routeResult;
      context = routeResult.context;
      contextWorkspaceId = routeResult.workspaceId;
    } else if (!context) {
      const compatible = registry.projects.filter(project => project.legacy === true);
      if (compatible.length !== 1) return { ok: false, reason: "workspace_selection_required" };
      context = contextFor(compatible[0]);
      contextWorkspaceId = compatible[0].workspaceId;
    }
    const { workspaceId: _workspaceId, ...payload } = message;
    if (sender?.tab?.id != null && message.type === "c2c.observe") {
      await Promise.all(registry.projects
        .filter(project => project.workspaceId !== contextWorkspaceId)
        .map(async project => {
          const other = contextFor(project);
          if (await other.matchesDocument(sender)) await other.handleMessage(payload, sender);
        }));
    }
    const response = await context.handleMessage(payload, sender);
    await context.afterMessage?.(message.type);
    return response;
  }

  async function initialize() {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    await Promise.all(registry.projects.map(project => contextFor(project).initialize?.()));
    return { ok: true };
  }

  async function dispatchToProjects(method, ...args) {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    return Promise.all(registry.projects.map(project => contextFor(project)[method]?.(...args)));
  }

  async function handleAlarm(alarm) {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    const name = typeof alarm?.name === "string" ? alarm.name : "";
    const namespaced = name.match(/^c2c_companion_project_v1:([a-f0-9]{12}):alarm:(.+)$/);
    if (namespaced) {
      const project = findProject(namespaced[1]);
      return project
        ? contextFor(project).handleAlarm?.({ ...alarm, name: namespaced[2] }) ?? { ok: false, reason: "alarm_unsupported" }
        : { ok: false, reason: "alarm_ignored" };
    }
    const legacyProjects = registry.projects.filter(project => project.legacy === true);
    if (name === "c2c.feedback.discovery" && legacyProjects.length === 1) {
      return contextFor(legacyProjects[0]).handleAlarm?.(alarm) ?? { ok: false, reason: "alarm_unsupported" };
    }
    return { ok: false, reason: "alarm_ignored" };
  }

  async function handleTabRemoved(tabId) {
    const ready = await ensureRegistry();
    if (!ready.ok) return ready;
    await withRegistryMutation(async () => {
      if (!selections.has(tabId)) return;
      const nextSelections = new Map(selections);
      nextSelections.delete(tabId);
      try { await persistSelections(nextSelections); }
      catch { return; }
      selections.delete(tabId);
    });
    return dispatchToProjects("handleTabRemoved", tabId);
  }

  function handleActiveOwnerRefresh(tabId) {
    return dispatchToProjects("handleActiveOwnerRefresh", tabId);
  }

  const handleInstalled = (...args) => dispatchToProjects("handleInstalled", ...args);
  const handleStartup = (...args) => dispatchToProjects("handleStartup", ...args);

  return {
    handle,
    initialize,
    handleAlarm,
    handleTabRemoved,
    handleActiveOwnerRefresh,
    handleInstalled,
    handleStartup,
    isSelected: workspaceId => selectedWorkspaceId === workspaceId,
    getSelectedWorkspaceId: () => selectedWorkspaceId,
  };
}
