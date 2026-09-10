import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { RemoteController, processAlive } from "../remote/controller.js";
import { authorized, controllerOnline, readRemote, remoteFile, RemoteError, setRemoteEnabled, updateRemote } from "../remote/store.js";

export function remoteStatus(workspaceId: string) {
  const state = readRemote(workspaceId);
  return { remoteControl: state?.enabled ?? false, controller: state && controllerOnline(state) ? state.controller!.appServer === "starting" ? "starting" : "running" : "offline",
    appServer: state?.controller?.appServer === "unknown" ? "unknown" : state && controllerOnline(state) ? state.controller!.appServer : "offline",
    error: state?.controller?.error,
    queued: state?.tasks.filter(t => t.status === "queued").length ?? 0,
    needsReconciliation: [...(state?.tasks ?? []), ...(state?.threads ?? [])].filter(t => t.status === "needs_reconciliation").length };
}
async function status(workspace: Workspace) {
  const bridge = await findBridgeObservation(workspace.id);
  let tunnel = "offline";
  if (bridge.state === "healthy") {
    const info = await adminFetch<{ tunnel: { running: boolean } }>(bridge.runtime, "GET", "/admin/info", 5000);
    tunnel = info.tunnel.running ? "running" : "offline";
  }
  return { workspaceId: workspace.id, ...remoteStatus(workspace.id), bridge: bridge.state, tunnel, stateFile: remoteFile(workspace.id) };
}
export function registerRemoteCommands(program: Command): void {
  const remote = program.command("remote").description("本地授权和检查跨设备 MCP Remote Control");
  for (const action of ["enable", "disable", "status"] as const) {
    remote.command(action).option("-w, --workspace <path>").option("--json").action(async opts => {
      const workspace = new Workspace(opts.workspace ?? process.cwd());
      if (action !== "status") setRemoteEnabled(workspace, action === "enable");
      process.stdout.write(JSON.stringify(await status(workspace), null, opts.json ? undefined : 2) + "\n");
    });
  }
  remote.command("reconcile").description("仅在人工确认旧执行已停止后，保留 ID 并结束待核对记录")
    .option("-w, --workspace <path>").option("--task <taskId>").option("--request <requestId>")
    .requiredOption("--confirm-stopped", "确认已在本机核对旧 Codex 执行已停止")
    .action(opts => {
      const workspace = new Workspace(opts.workspace ?? process.cwd());
      if (!!opts.task === !!opts.request) throw new RemoteError("INVALID_INPUT", "指定且仅指定 --task 或 --request。");
      updateRemote(workspace.id, state => {
        if (!state) throw new RemoteError("UNKNOWN_WORKSPACE");
        if (state.controller && processAlive(state.controller.pid)) throw new RemoteError("WORKSPACE_BUSY", "先停止 Controller 再核对。");
        const record = opts.task ? state.tasks.find(t => t.taskId === opts.task) : state.threads.find(t => t.requestId === opts.request);
        if (!record || record.status !== "needs_reconciliation") throw new RemoteError("INVALID_STATE");
        record.status = "cancelled"; record.error = "LOCALLY_RECONCILED"; record.updatedAt = new Date().toISOString();
        return { state, result: undefined };
      });
      process.stdout.write("已保留防重放 ID，记录结束为 cancelled；不会重跑。\n");
    });
  const controller = program.command("controller").description("管理独立本机 Controller（不设置开机启动）");
  controller.command("run", { hidden: true }).option("-w, --workspace <path>").action(async opts => {
    const service = new RemoteController(new Workspace(opts.workspace ?? process.cwd()));
    process.once("SIGTERM", () => service.stop()); process.once("SIGINT", () => service.stop());
    await service.run();
  });
  controller.command("start").option("-w, --workspace <path>").option("--codex <executable>", "本地 Codex 可执行文件路径（默认 C2C_CODEX_EXECUTABLE 或 PATH）").option("--json").action(async opts => {
    const workspace = new Workspace(opts.workspace ?? process.cwd());
    const state = authorized(readRemote(workspace.id));
    if (controllerOnline(state) && state.controller!.appServer !== "running") throw new RemoteError("CODEX_APP_SERVER_UNAVAILABLE", "Controller 仍在初始化，尚未就绪，请稍后查询状态。");
    if (!controllerOnline(state)) {
      if (state.controller && processAlive(state.controller.pid)) throw new RemoteError("WORKSPACE_BUSY", "旧 Controller PID 仍在运行，先核对其状态。");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const js = path.join(here, "index.js");
      const args = fs.existsSync(js) ? [js] : ["--import", "tsx/esm", path.join(here, "index.ts")];
      const logs = ensureDir(path.join(getStateDir(), "logs"));
      const fd = fs.openSync(path.join(logs, `controller-${workspace.id}.log`), "a", 0o600);
      const child = spawn(process.execPath, [...args, "controller", "run", "-w", workspace.root], {
        cwd: workspace.root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...(opts.codex ? { C2C_CODEX_EXECUTABLE: path.resolve(opts.codex) } : {}) },
      });
      fs.closeSync(fd);
      let spawnError = false;
      child.on("error", () => { spawnError = true; }); child.unref();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const current = readRemote(workspace.id);
        if (current && controllerOnline(current) && current.controller!.appServer === "running") break;
        if (spawnError || child.exitCode !== null) throw new RemoteError("CODEX_APP_SERVER_UNAVAILABLE");
      }
      const current = readRemote(workspace.id);
      if (!current || !controllerOnline(current) || current.controller!.appServer !== "running") throw new RemoteError("CODEX_APP_SERVER_UNAVAILABLE");
    }
    process.stdout.write(JSON.stringify(await status(workspace), null, opts.json ? undefined : 2) + "\n");
  });
  controller.command("stop").option("-w, --workspace <path>").action(async opts => {
    const workspace = new Workspace(opts.workspace ?? process.cwd());
    if (readRemote(workspace.id)?.controller) updateRemote(workspace.id, state => {
      state!.controller!.stopRequested = true; return { state: state!, result: undefined };
    });
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const state = readRemote(workspace.id);
      if (!state?.controller || state.controller.appServer === "offline" || !processAlive(state.controller.pid)) {
        process.stdout.write("Controller 已停止。未确认结束的任务保留待核对状态。\n"); return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new RemoteError("WORKSPACE_BUSY", "停止请求已保存，Controller 尚未确认停止。");
  });
  controller.command("status").option("-w, --workspace <path>").option("--json").action(async opts => {
    process.stdout.write(JSON.stringify(await status(new Workspace(opts.workspace ?? process.cwd())), null, opts.json ? undefined : 2) + "\n");
  });
}
