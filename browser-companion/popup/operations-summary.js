(() => {
  const target = document.getElementById("operations-summary");
  if (!target) return;
  let deadline;
  Promise.race([chrome.runtime.sendMessage({ type: "c2c.operations.read" }),
    new Promise(resolve => { deadline = setTimeout(() => resolve({ ok: false }), 20_000); })])
    .then(response => {
      const view = C2COperations.derive(response);
      const attention = view.rows.filter(row => row.needsAttention).length;
      target.textContent = `Codex：${view.codex} · 网页：${view.web}\n本项目 ${view.rows.length} 条任务（含历史）· ${attention} 条需要处理`;
    }).catch(() => { target.textContent = "状态无法读取，请打开任务面板重试查询。"; })
    .finally(() => { clearTimeout(deadline); });
})();
