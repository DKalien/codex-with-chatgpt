const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message).then((r) => {
  if (r?.error) throw new Error(r.error);
  return r;
});
const STATE_TEXT = { pending: "待发送", claimed: "已领取（结果未知）" };

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", async () => {
    try { await onClick(); $("msg").textContent = ""; } catch (e) { $("msg").textContent = e.message; }
    await refresh();
  });
  return b;
}

async function refresh() {
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  // 心跳每 5 秒一次（后台标签页会被限流）；长时间没更新多半是扩展重载后对话页未刷新
  const stale = lastStatus && Date.now() - Date.parse(lastStatus.at) > 90_000;
  $("status").textContent = lastStatus
    ? `最近状态：${lastStatus.text}（${new Date(lastStatus.at).toLocaleTimeString()}）${stale ? "——已连接的对话页没有心跳：请确认它已打开（地址与连接时一致），必要时刷新" : ""}`
    : "尚无心跳：请打开已连接的对话页";
  const list = $("workspaces");
  list.replaceChildren();
  try {
    const { workspaces } = await send({ type: "c2c.state" });
    if (!workspaces.length) list.textContent = "尚未登记项目";
    for (const ws of workspaces) {
      const li = document.createElement("li");
      li.append(`${ws.name}：${ws.conversationUrl ? "已连接" : "未连接"} `);
      li.append(ws.conversationUrl
        ? button("断开", () => send({ type: "c2c.disconnect", workspaceId: ws.workspaceId }))
        : button("连接当前对话", () => send({ type: "c2c.connect", workspaceId: ws.workspaceId })));
      const ul = document.createElement("ul");
      for (const n of ws.notifications) {
        const item = document.createElement("li");
        item.append(`${n.commandId} · ${STATE_TEXT[n.state] ?? n.state} `);
        if (n.state === "claimed") item.append(button("重新发送", () => send({ type: "c2c.requeue", workspaceId: ws.workspaceId, id: n.id })));
        ul.append(item);
      }
      li.append(ul);
      list.append(li);
    }
  } catch (e) {
    $("msg").textContent = e.message;
  }
}

$("save").addEventListener("click", async () => {
  await send({ type: "c2c.settings.set", gatewayOrigin: $("origin").value.trim(), token: $("token").value.trim() });
  await refresh();
});

(async () => {
  const s = await send({ type: "c2c.settings.get" });
  $("origin").value = s.gatewayOrigin;
  $("token").value = s.token;
  await refresh();
})();
