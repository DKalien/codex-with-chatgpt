/* 仅扩展页面的显示偏好；不修改任务、发送日志或隔离档案。 */
(() => {
  const key = workspaceId => {
    if (!/^[a-f0-9]{12}$/.test(workspaceId ?? "")) throw new Error("项目标识无效");
    return `c2c.panel.hidden.v1.${workspaceId}`;
  };
  const valid = ids => Array.isArray(ids) && ids.length <= 10_000
    && ids.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  async function read(workspaceId) {
    const name = key(workspaceId);
    const value = (await chrome.storage.local.get(name))[name];
    if (value !== undefined && !valid(value)) throw new Error("历史显示设置损坏");
    return value ?? [];
  }
  async function write(workspaceId, ids) {
    if (!valid(ids)) throw new Error("历史显示设置无效");
    await chrome.storage.local.set({ [key(workspaceId)]: [...new Set(ids)] });
  }
  globalThis.C2CHistory = Object.freeze({ read, write });
})();
