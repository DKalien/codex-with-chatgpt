import { parseBridgeOrigin } from "../bridge-origin.js";

const ids = ["project", "status", "autonomy-status", "connect", "autonomy", "pair-json", "grant", "pair", "error", "refresh", "operations"];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let projects = [];
let selectedWorkspaceId = null;
let enabled = false;
let busy = false;
let open = true;

function selectedProject() {
  const project = projects.find(row => row.workspaceId === selectedWorkspaceId);
  if (!project) throw new Error("请先选择项目（workspace_required）");
  return project;
}

function pairing() {
  let input;
  try {
    const text = el["pair-json"].value.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    input = JSON.parse(text);
  } catch { throw new Error("配对 JSON 无效（pairing_input_invalid）"); }
  if (!/^[a-f0-9]{12}$/.test(input?.workspaceId ?? "") || typeof input?.intentId !== "string" || !input.intentId || typeof input?.secret !== "string" || !input.secret) {
    throw new Error("配对 JSON 需要 workspaceId、bridgeOrigin、intentId 和 secret（pairing_input_invalid）");
  }
  return { workspaceId: input.workspaceId, bridgeOrigin: parseBridgeOrigin(input.bridgeOrigin, { allowLoopbackHttp: true }), intentId: input.intentId, secret: input.secret };
}

async function response(promise) {
  let timer;
  try {
    const result = await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("等待超时，操作结果尚未确认；请刷新状态后检查，不会自动重试（request_timeout）")), 15000);
    })]);
    if (result?.ok !== true) throw new Error(result?.reason || "Bridge 未返回成功结果（bridge_response_invalid）");
    return result;
  } finally { clearTimeout(timer); }
}

function rpc(type, fields = {}) {
  return response(chrome.runtime.sendMessage({ type: `c2c.light.${type}`, ...fields }));
}

function renderProjects(result) {
  projects = result.projects;
  selectedWorkspaceId = result.selectedWorkspaceId ?? null;
  el.project.replaceChildren(new Option("请选择项目", ""), ...projects.map(row => new Option(`${row.workspaceId} · ${row.bridgeOrigin}`, row.workspaceId)));
  el.project.value = selectedWorkspaceId ?? "";
  el.operations.href = `../operations/operations.html${selectedWorkspaceId ? `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}` : ""}`;
}

async function refresh() {
  if (!selectedWorkspaceId) {
    el.status.textContent = "请选择项目，或粘贴配对 JSON。";
    enabled = false;
  } else {
    const result = await rpc("status", { workspaceId: selectedWorkspaceId });
    el.status.textContent = result.connected === true ? "当前对话已连接" : result.paired ? `Bridge 已配对${result.localRoute?.state ? ` · ${result.localRoute.state}` : " · 尚未连接当前对话"}` : "Bridge 尚未配对";
    enabled = result.autonomy?.enabled === true;
  }
  el["autonomy-status"].textContent = enabled ? "自动回流：已开启" : "自动回流：未开启";
  el.autonomy.textContent = enabled ? "暂停自动回流" : "开启自动回流";
}

async function action(work) {
  if (busy) return;
  busy = true;
  el.error.textContent = "";
  const controls = ["project", "connect", "autonomy", "grant", "pair", "refresh", "pair-json"];
  for (const id of controls) el[id].disabled = true;
  try { await work(); }
  catch (error) { el.error.textContent = error?.message || String(error); }
  finally { busy = false; for (const id of controls) el[id].disabled = false; }
}

async function pageRequest(type, fields) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error("当前页不可用（active_tab_missing）");
  return response(chrome.tabs.sendMessage(tab.id, { type: `c2c.light.${type}.request`, ...fields }));
}

async function showConnection(result) {
  if (result.state !== "PENDING" && result.localRoute?.state !== "PENDING") {
    el.status.textContent = `连接请求成功${result.state ? ` · ${result.state}` : ""}`;
    return;
  }
  el.status.textContent = "请在本机确认连接；正在等待 Bridge 完成连接…";
  for (let attempt = 0; attempt < 60 && open; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (!open) return;
    const current = await rpc("status", { workspaceId: selectedWorkspaceId });
    if (current.connected === true) {
      el.status.textContent = "当前对话已连接";
      return;
    }
  }
  if (open) throw new Error("连接尚未完成；请完成本机确认后刷新状态（connection_pending）");
}

el.project.onchange = () => action(async () => {
  try {
    renderProjects(await rpc("projects.select", { workspaceId: el.project.value || null }));
    await refresh();
  } finally { el.project.value = selectedWorkspaceId ?? ""; }
});
el.grant.onclick = () => action(async () => {
  const project = el["pair-json"].value.trim() ? pairing() : selectedProject();
  const origin = parseBridgeOrigin(project.bridgeOrigin, { allowLoopbackHttp: true });
  // 权限请求必须保持在用户点击的同步调用路径上。
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error("Bridge 访问授权未获批准（bridge_permission_missing）");
  el.status.textContent = "Bridge 访问已授权，可以配对或连接。";
});
el.pair.onclick = () => action(async () => {
  const fields = pairing();
  if (!await chrome.permissions.contains({ origins: [`${fields.bridgeOrigin}/*`] })) {
    throw new Error("请先点击“授权 Bridge 访问”（bridge_permission_missing）");
  }
  await rpc("projects.add", { workspaceId: fields.workspaceId, bridgeOrigin: fields.bridgeOrigin });
  renderProjects(await rpc("projects.select", { workspaceId: fields.workspaceId }));
  const result = await pageRequest("pair", fields);
  el["pair-json"].value = "";
  await showConnection(result);
});
el.connect.onclick = () => action(async () => {
  const project = selectedProject();
  if (!await chrome.permissions.contains({ origins: [`${project.bridgeOrigin}/*`] })) throw new Error("请先点击“授权 Bridge 访问”（bridge_permission_missing）");
  const result = await pageRequest("connect", { workspaceId: project.workspaceId, bridgeOrigin: project.bridgeOrigin });
  await showConnection(result);
});
el.autonomy.onclick = () => action(async () => {
  await rpc("autonomy", { workspaceId: selectedProject().workspaceId, enabled: !enabled });
  await refresh();
});
el.refresh.onclick = () => action(refresh);
globalThis.addEventListener("pagehide", () => { open = false; el["pair-json"].value = ""; });
void action(async () => { renderProjects(await rpc("projects.list")); await refresh(); });
