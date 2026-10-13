import { parseBridgeOrigin, companionApiUrl } from "./bridge-origin.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";
import { renderCompletionNotification } from "./completion-notification.js";
import { PROJECT_REGISTRY_KEY, PROJECT_SELECTION_KEY, parseProjectRegistry, projectStorageKey } from "./project-context.js";
import { handleBridgeOperation } from "./bridge-operations.js";

const TRANSPORT = "c2c_companion_transport_v1";
const PAGE = "c2c_companion_light_page_v1";
const PREFERENCE = "c2c_companion_light_autonomy_v1";
const LOCAL_ROUTE = "c2c_companion_light_route_request_v1";
const workspaceValid = value => typeof value === "string" && /^[a-f0-9]{12}$/.test(value);
const fail = reason => ({ ok: false, reason });

/** 浏览器仅关联请求与真实文档；全部身份、授权和 attempt 判定由 Bridge 执行。 */
export function createBridgeClient(chrome, fetcher = globalThis.fetch) {
  const busy = new Set();
  const tabQueues = new Map();
  let initialization;
  const key = (id, name) => projectStorageKey(id, name);
  const read = async (area, name) => (await chrome.storage[area].get(name))[name];
  const write = (area, name, value) => chrome.storage[area].set({ [name]: value });
  async function initialize() {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const parsed = parseProjectRegistry(await read("local", PROJECT_REGISTRY_KEY));
    if (!parsed.ok) throw new Error(parsed.reason);
    const legacy = await read("local", TRANSPORT);
    if (parsed.registry.legacyMigration === "pending" && workspaceValid(legacy?.workspaceId) && legacy?.bridgeOrigin) {
      const origin = parseBridgeOrigin(legacy.bridgeOrigin, { allowLoopbackHttp: true });
      const existing = parsed.registry.projects.find(p => p.workspaceId === legacy.workspaceId);
      if (existing && existing.bridgeOrigin !== origin) throw new Error("project_origin_conflict");
      if (!existing) parsed.registry.projects.push({ workspaceId: legacy.workspaceId, bridgeOrigin: origin, legacy: true });
      if (!await read("local", key(legacy.workspaceId, TRANSPORT))) await write("local", key(legacy.workspaceId, TRANSPORT), legacy);
      parsed.registry.legacyMigration = "migrated";
      await write("local", PROJECT_REGISTRY_KEY, parsed.registry);
    }
    for (const project of parsed.registry.projects) {
      const preferenceKey = key(project.workspaceId, PREFERENCE);
      if (!await read("local", preferenceKey)) {
        const old = await read("local", key(project.workspaceId, "c2c_companion_autonomy_v1"))
          ?? (project.legacy ? await read("local", "c2c_companion_autonomy_v1") : null);
        if (old) await write("local", preferenceKey, { enabled: old.mode === "armed" });
      }
    }
  }
  async function projects() {
    const parsed = parseProjectRegistry(await read("local", PROJECT_REGISTRY_KEY));
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.registry;
  }
  async function selected() {
    const stored = await read("session", PROJECT_SELECTION_KEY);
    return typeof stored === "string" ? stored : stored?.workspaceId;
  }
  function document(sender) {
    if (sender?.id !== chrome.runtime.id || !Number.isSafeInteger(sender?.tab?.id)
      || typeof sender.documentId !== "string" || !sender.documentId || typeof sender.url !== "string") throw new Error("document_sender_required");
    const url = new URL(sender.url);
    if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname) || (sender.frameId != null && sender.frameId !== 0)) throw new Error("document_sender_required");
    return { tabId: sender.tab.id, documentId: sender.documentId, url: sender.url };
  }
  async function requestFor(project, transport, path, options = {}) {
    if (!await chrome.permissions.contains({ origins: [`${project.bridgeOrigin}/*`] })) throw new Error("bridge_permission_missing");
    const response = await fetcher(companionApiUrl(project.bridgeOrigin, path), {
      ...options, cache: "no-store", headers: { "content-type": "application/json", ...(transport?.credential ? { authorization: `Bearer ${transport.credential}` } : {}) },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    return { ok: response.ok, status: response.status, body };
  }
  const publicConnection = body => body ? Object.fromEntries(Object.entries(body).filter(([name]) => !["pairing", "candidatePairing", "credential"].includes(name))) : null;
  const publicResult = response => response.ok ? { ...publicConnection(response.body), ok: true } : { ...fail(response.body?.error || `http_${response.status}`), status: response.status };
  async function savePair(project, pairing) {
    if (!pairing || pairing.workspaceId !== project.workspaceId || typeof pairing.credential !== "string" || !pairing.credential
      || typeof pairing.companionId !== "string" || typeof pairing.bindingId !== "string" || !Number.isInteger(pairing.epoch)
      || typeof pairing.routeCanonical !== "string") throw new Error("pair_response_invalid");
    await write("local", key(project.workspaceId, TRANSPORT), { ...pairing, schemaVersion: 1, bridgeOrigin: project.bridgeOrigin });
    return read("local", key(project.workspaceId, TRANSPORT));
  }
  async function localStatus(project, transport) {
    const pending = await read("local", key(project.workspaceId, LOCAL_ROUTE));
    if (!pending) return null;
    let response = await requestFor(project, transport, `/route/local/status?requestId=${encodeURIComponent(pending.requestId)}`, { method: "GET" });
    if (!response.ok && ["LOCAL_ROUTE_UNKNOWN", "LOCAL_ROUTE_EXPIRED"].includes(response.body?.error)) {
      await chrome.storage.local.remove(key(project.workspaceId, LOCAL_ROUTE));
    }
    if (response.ok && response.body.state === "CONFIRMED") {
      response = await requestFor(project, transport, "/route/local/commit", { method: "POST", body: JSON.stringify(pending) });
    }
    if (response.ok && response.body.state === "COMMITTED") {
      transport = await savePair(project, response.body.pairing);
      const bound = await requestFor(project, transport, "/web-sink/bind-current", { method: "POST", body: JSON.stringify({ routeCanonical: pending.routeCanonical }) });
      if (!bound.ok) return bound;
      await chrome.storage.local.remove(key(project.workspaceId, LOCAL_ROUTE));
    } else if (response.ok && ["CANCELLED", "EXPIRED"].includes(response.body.state)) {
      await chrome.storage.local.remove(key(project.workspaceId, LOCAL_ROUTE));
    }
    return response;
  }
  async function connect(project, transport, page) {
    await write("session", key(project.workspaceId, PAGE), page);
    const pending = await localStatus(project, transport);
    if (pending) return pending.ok ? { ok: true, connected: pending.body.state === "COMMITTED", state: pending.body.state, localRoute: publicConnection(pending.body) } : publicResult(pending);
    const state = await requestFor(project, transport, "/state", { method: "GET" });
    if (!state.ok) return publicResult(state);
    if (state.body.routeVerification === "VERIFIED" && areChatgptConversationRoutesEquivalent(state.body.routeCanonical, page.url)) {
      const bound = await requestFor(project, transport, "/web-sink/bind-current", { method: "POST", body: JSON.stringify({ routeCanonical: page.url }) });
      return { ...publicResult(bound), connected: bound.ok };
    }
    const local = { requestId: crypto.randomUUID(), routeCanonical: page.url };
    await write("local", key(project.workspaceId, LOCAL_ROUTE), local);
    const response = await requestFor(project, transport, "/route/local/request", { method: "POST", body: JSON.stringify(local) });
    if (!response.ok) return publicResult(response);
    return { ok: true, state: response.body.state, localRoute: publicConnection(response.body) };
  }
  async function pageSend(page, type, delivery) {
    const prior = tabQueues.get(page.tabId) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => chrome.tabs.sendMessage(page.tabId, {
      type, expectedHref: page.url, delivery,
    }, { documentId: page.documentId }));
    tabQueues.set(page.tabId, operation);
    try { return await operation; } finally { if (tabQueues.get(page.tabId) === operation) tabQueues.delete(page.tabId); }
  }
  async function tick(project, transport, page, safety) {
    const request = (path, options) => requestFor(project, transport, path, options);
    const state = await request("/state", { method: "GET" });
    if (!state.ok) return publicResult(state);
    let delivery = state.body.inFlight;
    let type = "c2c.light.observe";
    if (!delivery) {
      if (safety?.safe !== true || !(await read("local", key(project.workspaceId, PREFERENCE)))?.enabled) return { ok: true, status: publicConnection(state.body) };
      const reserved = await request("/reserve", { method: "POST", body: JSON.stringify({ routeCanonical: page.url }) });
      if (!reserved.ok) return publicResult(reserved);
      delivery = { ...reserved.body.delivery, reservationId: reserved.body.reservationId };
    }
    if (delivery.status === "reserved") {
      if (safety?.safe !== true || !(await read("local", key(project.workspaceId, PREFERENCE)))?.enabled) return { ok: true, status: publicConnection(state.body) };
      const begun = await request("/begin-send", { method: "POST", body: JSON.stringify({ routeCanonical: page.url,
        eventId: delivery.eventId, reservationId: delivery.reservationId, once: true }) });
      if (!begun.ok) return publicResult(begun);
      if (begun.body.eventId !== delivery.eventId || begun.body.status !== "claimed") return fail("delivery_response_invalid");
      delivery = begun.body;
      type = "c2c.light.deliver";
    } else if (!["claimed", "outcome_unknown"].includes(delivery.status)) return fail("delivery_response_invalid");
    if (typeof delivery.eventId !== "string" || typeof delivery.attemptId !== "string") return fail("delivery_response_invalid");
    if (delivery.signal && (delivery.signal.workspaceId !== project.workspaceId || delivery.signal.attemptId !== delivery.attemptId)) return fail("delivery_response_invalid");
    const message = delivery.signal ? renderCompletionNotification(delivery.signal) : delivery.message;
    if (typeof message !== "string" || !message) return fail("delivery_response_invalid");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (delivery.messageSha256 !== sha256) return fail("delivery_response_invalid");
    const payload = publicConnection({ ...delivery, message, routeCanonical: page.url });
    const result = await pageSend(page, type, payload);
    if (result?.ok !== true || result.observed !== true || result.eventId !== delivery.eventId || result.attemptId !== delivery.attemptId) return { ok: true, observed: false, reason: result?.reason };
    const ack = await request("/ack", { method: "POST", body: JSON.stringify({ routeCanonical: page.url, eventId: delivery.eventId,
      attemptId: delivery.attemptId, ...(delivery.terminalWitness ? { terminalWitness: delivery.terminalWitness } : {}) }) });
    return { ...publicResult(ack), observed: true };
  }
  async function handle(message, sender) {
    try {
      initialization ??= initialize();
      await initialization;
      if (!message || typeof message.type !== "string" || sender?.id !== chrome.runtime.id) return fail("bad_message");
      const registry = await projects();
      if (message.type.startsWith("c2c.light.projects.")) {
        if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return fail("extension_sender_required");
        if (message.type === "c2c.light.projects.add") {
          if (!workspaceValid(message.workspaceId)) return fail("workspace_selection_invalid");
          const bridgeOrigin = parseBridgeOrigin(message.bridgeOrigin, { allowLoopbackHttp: true });
          const existing = registry.projects.find(p => p.workspaceId === message.workspaceId);
          if (existing && existing.bridgeOrigin !== bridgeOrigin) return fail("project_origin_conflict");
          if (!existing) registry.projects.push({ workspaceId: message.workspaceId, bridgeOrigin });
          await write("local", PROJECT_REGISTRY_KEY, registry);
        }
        if (["c2c.light.projects.add", "c2c.light.projects.select"].includes(message.type)) {
          if (!registry.projects.some(p => p.workspaceId === message.workspaceId)) return fail("project_not_found");
          await write("session", PROJECT_SELECTION_KEY, { workspaceId: message.workspaceId });
        }
        return { ok: true, projects: registry.projects, selectedWorkspaceId: await selected() ?? registry.projects[0]?.workspaceId ?? null };
      }
      if (message.type === "c2c.light.heartbeat" && message.workspaceId == null) {
        const page = document(sender);
        const results = [];
        for (const project of registry.projects) {
          const target = await read("session", key(project.workspaceId, PAGE));
          const pending = await read("local", key(project.workspaceId, LOCAL_ROUTE));
          const transport = await read("local", key(project.workspaceId, TRANSPORT));
          if (target?.tabId === page.tabId || (!target && areChatgptConversationRoutesEquivalent(pending?.routeCanonical ?? transport?.routeCanonical, page.url))) {
            if (!target) await write("session", key(project.workspaceId, PAGE), page);
            results.push(await handle({ ...message, workspaceId: project.workspaceId }, sender));
          }
        }
        return { ok: true, results };
      }
      const workspaceId = message.workspaceId ?? await selected() ?? registry.projects[0]?.workspaceId;
      const project = registry.projects.find(p => p.workspaceId === workspaceId);
      if (!project) return fail("project_not_found");
      if (busy.has(workspaceId)) return fail("project_request_busy");
      busy.add(workspaceId);
      try {
        let transport = await read("local", key(workspaceId, TRANSPORT));
        if (transport && (transport.workspaceId !== workspaceId || transport.bridgeOrigin !== project.bridgeOrigin)) return fail("transport_identity_mismatch");
        let request = (path, options) => requestFor(project, transport, path, options);
        if (["c2c.light.connect", "c2c.light.pair", "c2c.light.heartbeat"].includes(message.type)) {
          const page = document(sender);
          if (message.type === "c2c.light.heartbeat") {
            const target = await read("session", key(workspaceId, PAGE));
            if (target?.tabId !== page.tabId) return fail("document_not_connected");
            await write("session", key(workspaceId, PAGE), { ...page, observedAt: Date.now(),
              composer: message.safety?.composer === "dirty" ? "nonempty" : ["empty", "nonempty"].includes(message.safety?.composer) ? message.safety.composer : "unknown",
              generation: ["idle", "streaming", "generating"].includes(message.safety?.generation) ? message.safety.generation : "unknown",
              safe: message.safety?.safe === true });
            const pending = await localStatus(project, transport);
            if (pending && (!pending.ok || pending.body.state !== "COMMITTED")) return pending.ok ? { ok: true, state: pending.body.state } : publicResult(pending);
            transport = await read("local", key(workspaceId, TRANSPORT));
            return await tick(project, transport, page, message.safety);
          }
          if (message.type === "c2c.light.pair") {
            if (parseBridgeOrigin(message.bridgeOrigin, { allowLoopbackHttp: true }) !== project.bridgeOrigin) return fail("project_origin_conflict");
            if (typeof message.intentId !== "string" || typeof message.secret !== "string" || !message.secret) return fail("pairing_input_invalid");
            const response = await requestFor(project, null, "/pair", { method: "POST", body: JSON.stringify({ intentId: message.intentId, secret: message.secret, routeCanonical: page.url }) });
            if (!response.ok) return publicResult(response);
            transport = await savePair(project, response.body);
            await chrome.storage.local.remove(key(workspaceId, LOCAL_ROUTE));
          }
          if (!transport?.credential) return fail("transport_unavailable");
          return await connect(project, transport, page);
        }
        if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return fail("extension_sender_required");
        if (message.type === "c2c.light.autonomy") {
          if (typeof message.enabled !== "boolean") return fail("bad_message");
          await write("local", key(workspaceId, PREFERENCE), { enabled: message.enabled });
          return { ok: true, autonomy: { enabled: message.enabled } };
        }
        if (message.type === "c2c.light.status") {
          const pending = transport?.credential ? await localStatus(project, transport) : null;
          transport = await read("local", key(workspaceId, TRANSPORT));
          if (pending && !pending.ok) return { ...publicResult(pending), connected: false, localRoute: publicConnection(pending.body) };
          if (pending && ["CANCELLED", "EXPIRED"].includes(pending.body.state)) return { ok: false, reason: `LOCAL_ROUTE_${pending.body.state}`, connected: false, localRoute: publicConnection(pending.body) };
          const state = transport?.credential ? await requestFor(project, transport, "/state", { method: "GET" }) : null;
          const sink = state?.ok ? await requestFor(project, transport, "/web-sink/status", { method: "GET" }) : null;
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return { ok: state?.ok ?? true, ...(state && !state.ok ? { reason: state.body?.error } : {}), workspaceId,
            paired: !!transport?.credential, connected: state?.ok === true && state.body?.routeVerification === "VERIFIED" && sink?.ok === true && areChatgptConversationRoutesEquivalent(sink.body?.activeBinding?.canonicalUrl, state.body?.routeCanonical) && areChatgptConversationRoutesEquivalent(activeTab?.url, sink.body?.activeBinding?.canonicalUrl) && (!pending || pending.body?.state === "COMMITTED"), autonomy: await read("local", key(workspaceId, PREFERENCE)) ?? { enabled: false },
            status: publicConnection(state?.body), localRoute: publicConnection(pending?.body) };
        }
        if (message.type === "c2c.operations.read") {
          const response = await request("/operations", { method: "GET" });
          if (!response.ok) return publicResult(response);
          const state = await request("/state", { method: "GET" });
          const sink = state.ok ? await request("/web-sink/status", { method: "GET" }) : null;
          const page = await read("session", key(workspaceId, PAGE));
          let tab;
          if (page) { try { tab = await chrome.tabs.get(page.tabId); } catch { /* 页面已关闭，保留原观察时间供显示。 */ } }
          const routeMatches = state.ok && areChatgptConversationRoutesEquivalent(tab?.url, state.body?.routeCanonical)
            && areChatgptConversationRoutesEquivalent(page?.url, tab?.url);
          const inFlight = state.ok ? state.body?.inFlight : null;
          return { ok: true, runtime: "lightweight", formatPending: !!await read("local", key(workspaceId, "c2c.panel.format.v1")), snapshot: publicConnection(response.body), autonomy: (await read("local", key(workspaceId, PREFERENCE)))?.enabled ? "armed" : "off",
            web: { observedAt: page?.observedAt ?? null, routeCanonical: state.body?.routeCanonical,
              verified: state.ok && state.body?.routeVerification === "VERIFIED", paired: !!transport?.credential,
              ownerAvailable: !!tab && typeof page?.observedAt === "number", routeMatches,
              composer: page?.composer ?? "unknown", generation: page?.generation ?? "unknown", safe: page?.safe === true,
              connectionReadiness: { ready: routeMatches && sink?.ok === true
                && areChatgptConversationRoutesEquivalent(sink.body?.activeBinding?.canonicalUrl, tab?.url) } },
            ...(inFlight ? { journal: { state: inFlight.status === "outcome_unknown" ? "OUTCOME_UNKNOWN" : inFlight.status?.toUpperCase(), eventId: inFlight.eventId, attemptId: inFlight.attemptId } } : {}),
            isolationArchive: { available: false, entries: [] } };
        }
        if (message.type === "c2c.operations.result.read") {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(message.commandId ?? "") || !Number.isSafeInteger(message.iteration) || message.iteration < 1) return fail("bad_message");
          const response = await request(`/operations/result?commandId=${encodeURIComponent(message.commandId)}&iteration=${message.iteration}`, { method: "GET" });
          return response.ok ? { ok: true, result: publicConnection(response.body) } : publicResult(response);
        }
        if (["c2c.operations.action", "c2c.operations.format"].includes(message.type)) return await handleBridgeOperation(message, sender, { project, transport, request });
        return fail("bad_message");
      } finally { busy.delete(workspaceId); }
    } catch (error) { return fail(error?.message === "bridge_permission_missing" ? error.message : error?.message ?? "bridge_unavailable"); }
  }
  return { handle: async (...args) => publicConnection(await handle(...args)) };
}

if (globalThis.chrome?.runtime?.onMessage) {
  const client = createBridgeClient(globalThis.chrome);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    client.handle(message, sender).then(respond);
    return true;
  });
}
