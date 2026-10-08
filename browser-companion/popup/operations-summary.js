(() => {
  const target = document.getElementById("operations-summary");
  if (!target) return;
  let generation = 0;
  function refresh(workspaceId) {
    const current = ++generation;
    if (!/^[a-f0-9]{12}$/.test(workspaceId ?? "")) {
      target.textContent = "请先选择项目，再查看任务。"; return;
    }
    let deadline;
    const query = { type: "c2c.operations.read", ...(/^[a-f0-9]{12}$/.test(workspaceId ?? "") ? { workspaceId } : {}) };
    Promise.race([chrome.runtime.sendMessage(query),
      new Promise(resolve => { deadline = setTimeout(() => resolve({ ok: false }), 20_000); })])
      .then(async response => {
        if (current !== generation) return;
        if (response?.ok && response.snapshot?.workspaceId !== workspaceId) {
          target.textContent = "返回项目与当前选择不一致；未读取历史显示设置，请重新选择项目。"; return;
        }
        let hiddenIds = [];
        let historyError = "";
        if (response?.ok && response.snapshot?.workspaceId) {
          try { hiddenIds = await C2CHistory.read(workspaceId); }
          catch { historyError = "\n历史显示设置不可读；显示全部任务。"; }
        }
        if (current !== generation) return;
        const view = C2COperations.derive(response, Date.now(), hiddenIds);
        const attention = view.rows.filter(row => row.needsAttention).length;
        const archive = response?.isolationArchive;
        const archived = Array.isArray(archive?.entries) ? archive.entries : [];
        const isolated = archived.filter(entry => entry.status === "isolated").length;
        const terminalGone = archived.filter(entry => entry.status === "terminal_gone").length;
        const pending = archived.filter(entry => entry.status === "pending").length;
        target.textContent = `Codex：${view.codex} · 网页：${view.web}\n本项目 ${view.rows.length} 条可见任务 · 已隐藏 ${view.hiddenCount} 条 · ${attention} 条需要处理\n自动回流${view.autonomy} · ${view.pendingFeedback.length} 条排队、待确认或隔离回流（含隐藏任务）${response?.journal?.state && response.journal.state !== "NONE" ? ` · 发送日志 ${response.journal.state}` : ""}\n结果不明档案：${archive?.available !== true ? "档案不可读" : `${isolated} 条已隔离（未观察）· ${terminalGone} 条已核验离开来源 · ${pending} 条待确认`}${historyError}`;
      }).catch(() => { if (current === generation) target.textContent = "状态无法读取，请打开任务面板重试查询。"; })
      .finally(() => { clearTimeout(deadline); });
  }
  document.addEventListener("c2c-project-selection", event => refresh(event.detail?.workspaceId));
  refresh(document.getElementById("workspace-select")?.value);
})();
