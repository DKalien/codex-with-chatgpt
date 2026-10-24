/** 伴侣后台：把 Gateway 的待发通知投递到已绑定的 ChatGPT 对话标签页。凭据只存在 chrome.storage.local。 */
const DEFAULTS = { gatewayOrigin: "http://127.0.0.1:48766", token: "" };

export function conversationId(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !/^(www\.)?chatgpt\.com$/.test(u.hostname)) return null;
    return /\/c\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createBackground(chrome, fetchImpl) {
  const inFlight = new Set(); // 每个标签页同一时间只处理一次投递

  const getSettings = () => chrome.storage.local.get(DEFAULTS);
  // 最近一次心跳结果，供弹窗显示卡住的原因
  const setStatus = (text) => chrome.storage.local.set({ lastStatus: { at: new Date().toISOString(), text } }).catch(() => {});

  async function api(method, path, body) {
    const { gatewayOrigin, token } = await getSettings();
    const res = await fetchImpl(`${gatewayOrigin.replace(/\/+$/, "")}/companion/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), // 避免挂起的请求一直占住 inFlight
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Gateway 返回 ${res.status}`);
    return data;
  }

  async function heartbeat(message, sender) {
    const tabId = sender?.tab?.id;
    const convId = conversationId(sender?.url ?? message?.href);
    if (tabId == null || !convId || inFlight.has(tabId)) return;
    inFlight.add(tabId);
    // 通信失败（页面跳转等）或 30 秒无响应（如后台标签页被冻结）视为结果未知，返回 undefined；
    // 超时保证 inFlight 必定释放，否则同一 tabId 刷新页面后仍会被一直跳过
    const ask = (msg) => Promise.race([
      chrome.tabs.sendMessage(tabId, msg).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);
    try {
      const { workspaces } = await api("GET", "/state");
      for (const ws of workspaces) {
        if (conversationId(ws.conversationUrl) !== convId) continue;
        // 只有已连接的对话页才写状态，避免其他对话页的草稿覆盖真实原因
        if (!message?.safety?.safe) return void setStatus(`页面未就绪：${message?.safety?.reasons?.[0] ?? "unknown"}`);
        // 已领取但未确认：只读核对页面是否已出现该消息，出现则补 ack；否则结果未知，只能人工重发。
        const claimed = ws.notifications.find((n) => n.state === "claimed");
        if (claimed) {
          const found = await ask({ type: "c2c.check", text: claimed.text, attemptId: claimed.id });
          if (found?.observed) await api("POST", "/ack", { workspaceId: ws.workspaceId, id: claimed.id });
          setStatus(found?.observed ? `已确认 ${claimed.commandId}` : `${claimed.commandId} 已领取但页面未见该消息，可在弹窗重新发送`);
          continue;
        }
        const next = ws.notifications.filter((n) => n.state === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) { setStatus("空闲"); continue; }
        await api("POST", "/claim", { workspaceId: ws.workspaceId, id: next.id });
        const result = await ask({ type: "c2c.deliver", text: next.text, attemptId: next.id });
        if (result?.observed) await api("POST", "/ack", { workspaceId: ws.workspaceId, id: next.id });
        // 页面明确报告点击发送前就失败（如 ChatGPT 仍在回复）：确定未发送，放回队列等下次心跳
        else if (result?.sent === false) await api("POST", "/requeue", { workspaceId: ws.workspaceId, id: next.id });
        setStatus(result?.observed ? `已发送 ${next.commandId}` : `发送 ${next.commandId} 失败：${result?.reason ?? "页面无响应"}`);
        return;
      }
    } catch (error) {
      console.warn("c2c heartbeat failed:", error?.message ?? error);
      setStatus(`Gateway 请求失败：${error?.message ?? error}`);
    } finally {
      inFlight.delete(tabId);
    }
  }

  async function handle(message) {
    switch (message?.type) {
      case "c2c.settings.get": return getSettings();
      case "c2c.settings.set": {
        const { gatewayOrigin, token } = message;
        await chrome.storage.local.set({ gatewayOrigin: String(gatewayOrigin || DEFAULTS.gatewayOrigin), token: String(token || "") });
        return { ok: true };
      }
      case "c2c.state": return api("GET", "/state");
      case "c2c.connect": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !conversationId(tab.url)) throw new Error("请先在 chatgpt.com 打开一个具体对话（地址含 /c/…）");
        return api("POST", "/connect", { workspaceId: message.workspaceId, conversationUrl: tab.url });
      }
      case "c2c.disconnect": return api("POST", "/disconnect", { workspaceId: message.workspaceId });
      case "c2c.requeue": return api("POST", "/requeue", { workspaceId: message.workspaceId, id: message.id });
      default: throw new Error("未知消息");
    }
  }

  return { heartbeat, handle };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const bg = createBackground(chrome, (...args) => fetch(...args));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "c2c.heartbeat") {
      void bg.heartbeat(message, sender);
      respond({ ok: true });
      return false;
    }
    bg.handle(message).then(respond, (error) => respond({ error: error.message }));
    return true;
  });
}
