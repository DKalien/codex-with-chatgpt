import { projectStorageKey, PROJECT_REGISTRY_KEY } from "./project-context.js";

const ACTION = "c2c.panel.action.v1";
const FORMAT = "c2c.panel.format.v1";
const TRANSPORT = "c2c_companion_transport_v1";
const HASH = /^[a-f0-9]{64}$/;

// 只保留查询操作结果的标识；授权、重放与恢复判定全部交给 Bridge。
export async function handleBridgeOperation(message, sender, { project, request }) {
  const workspaceId = project.workspaceId;
  const storage = chrome.storage.local;
  const key = projectStorageKey(workspaceId, message.type === "c2c.operations.format" ? FORMAT : ACTION);
  const stored = (await storage.get(key))[key];
  const reply = response => response.ok ? { ...response.body, ok: true }
    : { ok: false, reason: response.body?.error ?? `http_${response.status}` };
  if (message.type === "c2c.operations.action") {
    const operations = Array.isArray(stored?.operations) ? stored.operations : [];
    if (message.phase === "check") {
      const last = operations.filter(item => item.workspaceId === workspaceId
        && (!message.commandId || item.request?.commandId === message.commandId)).at(-1);
      if (!last) return { ok: true, status: "none" };
      return reply(await request(`/operations/result?requestId=${encodeURIComponent(last.request.requestId)}`, { method: "GET" }));
    }
    if (message.phase === "reconcile") return reply(await request("/operations/reconcile", {
      method: "POST", body: JSON.stringify({ requestId: message.requestId }),
    }));
    if (!["preview", "confirm"].includes(message.phase)) return { ok: false, reason: "bad_message" };
    const input = { request: message.request };
    if (message.phase === "confirm") {
      input.confirmationSha256 = message.confirmationSha256;
      // 请求标识先落盘，丢失 HTTP 响应后仍能只读查询原操作。
      await storage.set({ [key]: { version: 1, operations: [...operations.filter(item =>
        item.request?.requestId !== message.request?.requestId),
        { workspaceId, request: message.request, status: "pending" }] } });
    }
    const response = await request(`/operations/${message.phase}`, { method: "POST", body: JSON.stringify(input) });
    if (message.phase === "confirm" && response.ok && response.body?.requestId === message.request?.requestId) {
      await storage.set({ [key]: { version: 1, operations: [...operations.filter(item =>
        item.request?.requestId !== message.request.requestId),
        { workspaceId, request: message.request, status: response.body.status }] } });
    }
    return reply(response);
  }
  if (message.type !== "c2c.operations.format" || !["preview", "confirm", "check"].includes(message.phase)) {
    return { ok: false, reason: "bad_message" };
  }
  if (message.phase === "preview") return reply(await request("/operations/format/preview", { method: "POST", body: "{}" }));
  const hash = message.phase === "check" ? stored?.confirmationSha256 : message.confirmationSha256;
  if (message.phase === "check" && !stored) return { ok: true, status: "none" };
  if (!HASH.test(hash ?? "")) return { ok: false, reason: "bad_message" };
  if (message.phase === "confirm") await storage.set({ [key]: { version: 1, workspaceId, confirmationSha256: hash } });
  const response = await request(message.phase === "check" ? `/operations/format/result?confirmationSha256=${hash}`
    : "/operations/format/confirm", message.phase === "check" ? { method: "GET" }
    : { method: "POST", body: JSON.stringify({ confirmationSha256: hash }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) {
    if (response.body?.noMutation === true && response.body.workspaceId === workspaceId
      && response.body.confirmationSha256 === hash) await storage.remove(key);
    return reply(response);
  }
  if (response.body?.workspaceId !== workspaceId || response.body.confirmationSha256 !== hash) {
    return { ok: false, reason: "format_response_mismatch" };
  }
  if (response.body.status === "cleaned") {
    await clearBrowserHistory(project, storage);
    await storage.remove(key);
  }
  return reply(response);
}

async function clearBrowserHistory(project, storage) {
  const workspaceId = project.workspaceId;
  const legacyKeys = ["c2c_companion_outcome_unknown_archive_v1", ACTION, "c2c_companion_journal_v1"];
  const scopedAction = projectStorageKey(workspaceId, ACTION);
  const raw = await storage.get([...legacyKeys, scopedAction, TRANSPORT, PROJECT_REGISTRY_KEY]);
  const legacyOwned = raw[PROJECT_REGISTRY_KEY]?.legacyMigration === "migrated"
    && raw[PROJECT_REGISTRY_KEY]?.projects?.some(row => row.workspaceId === workspaceId && row.legacy === true)
    && raw[TRANSPORT]?.workspaceId === workspaceId && raw[TRANSPORT]?.bridgeOrigin === project.bridgeOrigin;
  const keys = [...legacyKeys.map(name => projectStorageKey(workspaceId, name)),
    `c2c.panel.hidden.v1.${workspaceId}`, ...(legacyOwned ? legacyKeys : [])];
  // 旧面板记录可能含其他 workspace，保留它们，不清连接或项目注册。
  for (const name of [scopedAction, ...(legacyOwned ? [ACTION] : [])]) {
    const value = raw[name];
    if (value === undefined) continue;
    if (value?.version !== 1 || !Array.isArray(value.operations)
      || value.operations.some(item => typeof item?.workspaceId !== "string")) throw new Error("panel_journal_corrupt");
    const foreign = value.operations.filter(item => item.workspaceId !== workspaceId);
    if (foreign.length) {
      await storage.set({ [name]: { version: 1, operations: foreign } });
      keys.splice(keys.indexOf(name), 1);
    }
  }
  await storage.remove(keys);
}
