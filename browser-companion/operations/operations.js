(() => {
  const el = id => document.getElementById(id);
  let response = null;
  let filter = "all";
  let page = 0;
  let selected = null;
  let pending = false;
  let timer = null;
  let failures = 0;
  let actionPending = false;
  let actionPreview = null;
  const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无成功观察";
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = String(value ?? "—");
    if (className) node.className = className;
    return node;
  };
  function render() {
    const view = C2COperations.derive(response);
    document.body.classList.toggle("stale", !view.serviceFresh);
    for (const key of ["codex", "web", "bridge", "autonomy"]) el(key).textContent = view[key];
    el("checked-at").textContent = `最近观察：${time(view.observedAt)}`;
    el("scope").textContent = view.workspaceId ? `项目 ${view.workspaceId} · 全部任务  /  当前连接 ${view.route}` : "尚未取得当前连接；请在伴侣 popup 中完成配对与对话验证。";
    el("diagnostic").textContent = !view.serviceFresh ? `当前状态无法核验${view.reason ? `（${view.reason}）` : ""}。请勿据此重发消息。`
      : view.reason ? `Codex 状态待核验（${view.reason}）。` : "状态仅代表最近一次观察，发送前仍会重新检查。";
    const permission = response?.snapshot?.panelAuthorization;
    el("authorization").textContent = permission?.enabled
      ? `操作授权有效至 ${time(permission.expiresAt)}。手动操作前请暂停自动回流。`
      : `操作默认关闭。请在本机明确授权当前 Companion（${permission?.companionId ?? "尚未配对"}）：c2c operations authorize -w <项目路径> --companion-id <此 ID> --local-user；默认有效 15 分钟。`;
    el("pending-actions").replaceChildren();
    for (const operation of permission?.pending ?? []) {
      const item = text("button", `核验并收敛 ${operation.commandId} 的本地操作`, "quiet"); item.type = "button";
      item.disabled = !permission.enabled || actionPending;
      item.onclick = async () => {
        const result = await chrome.runtime.sendMessage({ type: "c2c.operations.action", phase: "reconcile", requestId: operation.requestId }).catch(() => null);
        el("operation-status").textContent = result?.status === "completed" ? "已证明本地操作的目标状态并收敛记录；未重新执行操作。" : `证据仍不足：${result?.reason ?? result?.status ?? "unknown"}；原记录保持待核验。`;
        await refresh();
      };
      el("pending-actions").append(item);
    }
    if (permission?.pending?.length) el("operation-status").textContent = `待核验操作：${permission.pending.map(item => `${item.commandId} (${item.requestId})`).join("；")}。不会自动重试。`;
    el("count").textContent = `${view.rows.length}${view.truncated ? "+" : ""}`;
    const query = el("search").value.trim().toLowerCase();
    const filtered = view.rows.filter(row => row.commandId.toLowerCase().includes(query)
      && (filter === "all" || (filter === "attention" ? row.needsAttention : filter === "historical" ? row.scope === "historical" : row.active)));
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 100) - 1));
    const rows = filtered.slice(page * 100, (page + 1) * 100);
    el("page-count").textContent = `第 ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / 100))} 页 · ${filtered.length} 条`;
    el("previous").disabled = page === 0; el("next").disabled = (page + 1) * 100 >= filtered.length;
    el("rows").replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.append(text("span", row.commandId, "task-id"), text("small", `${row.scopeLabel} · ${time(row.updatedAt)}`));
      if (row.issueLabels.length || row.administrativeLabel) name.append(text("small", [...row.issueLabels, row.administrativeLabel].filter(Boolean).join("；"), "issue"));
      tr.append(name);
      for (const label of [row.deliveryLabel, row.executionLabel, row.feedbackLabel]) {
        const td = document.createElement("td");
        td.append(text("span", label, `pill${row.needsAttention ? " attention" : ""}`));
        tr.append(td);
      }
      const action = document.createElement("td");
      const button = text("button", "查看", "quiet");
      button.type = "button";
      button.setAttribute("aria-label", `查看 ${row.commandId} 详情`);
      button.onclick = () => { selected = row.commandId; render(); el("detail").scrollIntoView({ block: "nearest" }); };
      action.append(button); tr.append(action); el("rows").append(tr);
    }
    el("empty").hidden = rows.length > 0;
    el("empty").textContent = response?.ok !== true ? "未取得任务数据。请检查连接后刷新。"
      : filter === "all" ? "没有仍可核验的任务记录。已清理的任务不会恢复。" : "当前筛选下没有记录。";
    const row = view.rows.find(item => item.commandId === selected);
    el("detail").hidden = !row;
    if (!row) return;
    el("detail-title").textContent = row.commandId;
    el("detail-note").textContent = [...row.issueLabels, row.administrativeLabel,
      row.delivery.reason, "行政结束等待不等于成功。操作会重新核验任务的精确状态。"].filter(Boolean).join("；");
    el("timeline").replaceChildren();
    const steps = [`下发：${row.deliveryLabel} · ${time(row.delivery.updatedAt)}`,
      ...row.executions.map(item => `执行 record：第 ${item.iteration} 次 · ${C2COperations.resultLabels[item.status] ?? "未知"} · ${time(item.createdAt)}`),
      ...row.feedback.map(item => `返回网页：第 ${item.iteration} 次 · ${item.label} · ${item.target === "historical" ? "历史目标" : item.target === "current" ? "当前目标" : "目标尚未冻结"} · ${time(item.updatedAt)}`)];
    for (const step of steps) el("timeline").append(text("li", step));
    el("task-actions").replaceChildren();
    const allowed = view.serviceFresh && permission?.enabled && !actionPending && response?.autonomy !== "armed";
    const button = (label, action, eventId, supported = true, reason = "") => {
      const item = text("button", label, "quiet"); item.type = "button";
      item.disabled = !allowed || !supported;
      item.title = reason || (!permission?.enabled ? "需要本机限时授权" : response?.autonomy === "armed" ? "请先暂停自动回流" : "逐条预览后确认");
      item.onclick = () => previewAction({ requestId: crypto.randomUUID(), commandId: row.commandId, action, ...(eventId ? { eventId } : {}) });
      el("task-actions").append(item);
    };
    button("取消尚未下发的指令", "cancel_command", null, row.delivery.status === "pending", "仅当核心证明尚无外部投递或执行证据时可用");
    button("重发指令", "cancel_command", null, false, "面板不保存原指令正文，无法证明重发内容与原指令精确一致；已接受或结果不明的指令禁止重发");
    for (const event of row.feedback) {
      if (event.source !== "result_bus") continue;
      if (event.status === "queued") button(`取消第 ${event.iteration} 次回流`, "cancel_return", event.eventId);
      if (event.status === "reserved") button(`重新排队第 ${event.iteration} 次回流`, "requeue_return", event.eventId);
    }
    button("预览清理本地记录", "cleanup");
    el("action-note").textContent = row.feedback.some(item => ["claimed", "outcome_unknown"].includes(item.status))
      ? "此任务存在已经开始或结果不明的回流，不能重新排队。保留原 attempt，先核验网页或使用本机行政处置入口。"
      : row.issues.length ? "残留锁不会由面板自动修复。清理若被阻止，会保留全部证据并显示原因。" : "清理前请核对任务；取消回流不撤回 Codex 已执行的工作。";
    el("identities").replaceChildren();
    const identities = [["commandId", row.commandId], ["deliveryId", row.delivery.deliveryId],
      ...row.executions.flatMap(item => [["resultId", item.resultId], ["outputId", item.outputId]]),
      ...row.feedback.flatMap(item => [["eventId", item.eventId], ["attemptId", item.attemptId]])];
    for (const [key, value] of identities) if (value != null) el("identities").append(text("dt", key), text("dd", value));
  }
  const actionReasons = {
    PANEL_LOCAL_AUTHORIZATION_REQUIRED: "操作未获本机授权或已过期，请重新授权当前 Companion。",
    PANEL_CONFIRMATION_MISMATCH: "预览后任务或授权发生变化，未执行操作；请刷新后重新预览。",
    PANEL_CLEANUP_REQUIRES_LOCAL_REVIEW: "任务仍在途、结果不明或未结束，必须先在本机核验和行政处置。",
    PANEL_CANCEL_UNSAFE: "无法证明指令尚未发送，已拒绝取消。",
    PANEL_OPERATION_PENDING: "此前操作尚待核验，禁止换 ID 重试。",
    panel_operation_unknown: "请求结果尚不明确。请点“核验上次操作”，不要再次提交。",
    pause_autonomy_before_manual_action: "请先在 popup 中暂停自动回流，等待正在执行的回流结束。",
    delivery_journal_requires_recovery: "浏览器仍有在途发送日志，请先核验原消息；不会清除日志来重试。",
    COMMAND_CLEANUP_BUSY: "任务生命周期锁无法取得，保留原证据；需要本机核验。",
  };
  async function previewAction(request) {
    if (actionPending) return;
    actionPending = true; render();
    try {
      const result = await chrome.runtime.sendMessage({ type: "c2c.operations.action", phase: "preview", request });
      if (!result?.ok) throw new Error(result?.reason ?? "preview_failed");
      actionPreview = result;
      el("confirm-task").textContent = request.commandId;
      el("confirm-notice").textContent = result.notice;
      el("confirm-check").checked = false; el("confirm-action").disabled = true;
      el("confirm-dialog").showModal();
    } catch (error) { el("operation-status").textContent = actionReasons[error.message] ?? `操作受阻：${error.message}`; }
    finally { actionPending = false; render(); }
  }
  el("confirm-check").onchange = () => { el("confirm-action").disabled = !el("confirm-check").checked; };
  el("confirm-cancel").onclick = () => { actionPreview = null; el("confirm-dialog").close(); };
  el("confirm-action").onclick = async () => {
    if (!actionPreview || !el("confirm-check").checked || actionPending) return;
    actionPending = true; el("confirm-action").disabled = true;
    const preview = actionPreview; actionPreview = null; el("confirm-dialog").close(); render();
    try {
      const result = await chrome.runtime.sendMessage({ type: "c2c.operations.action", phase: "confirm", request: preview.request,
        confirmationSha256: preview.confirmationSha256, confirmed: true });
      el("operation-status").textContent = result?.ok && result.status === "completed" ? "本地操作已完成。外部任务及消息状态请以详情中的证据为准。"
        : actionReasons[result?.reason] ?? `操作待核验：${result?.reason ?? result?.status ?? "unknown"}。请保留 requestId ${preview.request.requestId}。`;
    } catch { el("operation-status").textContent = actionReasons.panel_operation_unknown; }
    finally { actionPending = false; await refresh(); }
  };
  el("check-operation").onclick = async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: "c2c.operations.action", phase: "check", ...(selected ? { commandId: selected } : {}) });
      el("operation-status").textContent = result?.ok && result.status === "completed" ? "已核验上次本地操作完成。"
        : result?.status === "none" ? "没有待核验的本地操作。" : `上次操作：${result?.status ?? result?.reason ?? "unknown"}；未重新执行。`;
    } catch { el("operation-status").textContent = "无法核验上次操作；未重新执行。"; }
    await refresh();
  };
  async function refresh() {
    if (pending || document.hidden) return;
    pending = true; el("refresh").disabled = true; clearTimeout(timer);
    let deadline;
    try {
      response = await Promise.race([chrome.runtime.sendMessage({ type: "c2c.operations.read" }),
        new Promise(resolve => { deadline = setTimeout(() => resolve({ ok: false, reason: "query_timeout" }), 20_000); })]);
      failures = response?.ok ? 0 : Math.min(failures + 1, 2);
    } catch { response = { ok: false, reason: "extension_unavailable" }; failures = Math.min(failures + 1, 2); }
    finally {
      clearTimeout(deadline); pending = false; el("refresh").disabled = false; render();
      if (!document.hidden) timer = setTimeout(refresh, Math.min(30_000 * 2 ** failures, 120_000));
    }
  }
  el("refresh").onclick = refresh;
  el("search").oninput = () => { page = 0; render(); };
  el("previous").onclick = () => { page = Math.max(0, page - 1); render(); };
  el("next").onclick = () => { page += 1; render(); };
  el("close-detail").onclick = () => { selected = null; render(); };
  for (const button of document.querySelectorAll("[data-filter]")) button.onclick = () => {
    filter = button.dataset.filter;
    page = 0;
    for (const other of document.querySelectorAll("[data-filter]")) other.setAttribute("aria-pressed", String(other === button));
    render();
  };
  document.addEventListener("visibilitychange", () => { clearTimeout(timer); if (!document.hidden) void refresh(); });
  // Freshness ages locally even when a slow/unreachable service prevents new evidence.
  const ageTimer = setInterval(() => { if (!document.hidden && response) render(); }, 5000);
  window.addEventListener("pagehide", () => { clearTimeout(timer); clearInterval(ageTimer); });
  void refresh();
})();
