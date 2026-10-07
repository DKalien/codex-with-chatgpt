(() => {
  const target = document.getElementById("operations-summary");
  if (!target) return;
  let generation = 0;
  function refresh(workspaceId) {
    const current = ++generation;
    let deadline;
    const query = { type: "c2c.operations.read", ...(/^[a-f0-9]{12}$/.test(workspaceId ?? "") ? { workspaceId } : {}) };
    Promise.race([chrome.runtime.sendMessage(query),
      new Promise(resolve => { deadline = setTimeout(() => resolve({ ok: false }), 20_000); })])
      .then(response => {
        if (current !== generation) return;
        const view = C2COperations.derive(response);
        const attention = view.rows.filter(row => row.needsAttention).length;
        const archive = response?.isolationArchive;
        const archived = Array.isArray(archive?.entries) ? archive.entries : [];
        const isolated = archived.filter(entry => entry.status === "isolated").length;
        const terminalGone = archived.filter(entry => entry.status === "terminal_gone").length;
        const pending = archived.filter(entry => entry.status === "pending").length;
        target.textContent = `Codex：${view.codex} · 网页：${view.web}\n本项目 ${view.rows.length} 条任务（含历史）· ${attention} 条需要处理\n结果不明档案：${archive?.available !== true ? "档案不可读" : `${isolated} 条已隔离（未观察）· ${terminalGone} 条已核验离开来源 · ${pending} 条待确认`}`;
      }).catch(() => { if (current === generation) target.textContent = "状态无法读取，请打开任务面板重试查询。"; })
      .finally(() => { clearTimeout(deadline); });
  }
  document.addEventListener("c2c-project-selection", event => refresh(event.detail?.workspaceId));
  refresh();
})();
