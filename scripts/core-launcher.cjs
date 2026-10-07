#!/usr/bin/env node
"use strict";

async function main() {
  // 仅加载机器 bin 下随 launcher 安装的 Node-only 格式校验器，不加载 checkout。
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { pathToFileURL } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const { createHash, randomUUID } = await import("node:crypto");
  const launcher = path.resolve(process.argv[1]);
  const bin = path.dirname(launcher);
  const helper = path.join(bin, "core-release.cjs");
  // machine bin 是本机信任根；允许更新后的 helper 在 pointer 切换前验证旧 release。
  for (const file of [launcher, helper]) {
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error("machine bootstrap 路径身份不匹配");
  }
  const { default: release } = await import(pathToFileURL(helper).href);
  const stateDir = path.dirname(bin);
  const args = process.argv.slice(2);
  let launchPin = null;
  let gatewayLaunchPin = null;
  let metadata;
  if (args[0] === "supervisor" && args[1] === "run") {
    // Pin BEFORE loading any release code. GC/install share this maintenance fence.
    // An interrupted launcher leaves a conservative pin; never guess that its child died.
    const options = new Map();
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i] === "-w" ? "--workspace" : args[i];
      if (!["--workspace", "--state-dir"].includes(key) || options.has(key) || !args[i + 1])
        throw new Error("SUPERVISOR_LAUNCH_ARGUMENTS_INVALID");
      options.set(key, args[i + 1]);
    }
    const root = options.get("--workspace");
    if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root || options.get("--state-dir") !== stateDir)
      throw new Error("SUPERVISOR_LAUNCH_IDENTITY_INVALID");
    const workspaceId = createHash("sha256").update(process.platform === "win32" || process.platform === "darwin" ? root.toLowerCase() : root).digest("hex").slice(0, 12);
    const folder = path.join(stateDir, "bridge-supervisor");
    for (let current = folder; current !== path.parse(current).root; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current)
        throw new Error("SUPERVISOR_LAUNCH_PATH_INVALID");
    }
    const configFile = path.join(folder, `${workspaceId}.json`);
    const configStat = fs.lstatSync(configFile);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1 || fs.realpathSync(configFile) !== configFile)
      throw new Error("SUPERVISOR_LAUNCH_CONFIG_INVALID");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (config.workspaceId !== workspaceId || config.workspaceRoot !== root)
      throw new Error("SUPERVISOR_LAUNCH_CONFIG_INVALID");
    const maintenance = release.tryAcquireMaintenanceLock(stateDir, "supervisor-launch");
    if (!maintenance.ok) throw new Error("MAINTENANCE_BUSY");
    try {
      metadata = release.readCurrent(stateDir, "fast");
      if (!metadata) throw new Error("current.json 缺失");
      const nonce = randomUUID();
      const file = path.join(folder, `${workspaceId}.${nonce}.launch.json`);
      const raw = JSON.stringify({ version: 1, workspaceId, workspaceRoot: root, buildId: metadata.runtimeBuildId,
        nonce, launcherPath: launcher, createdAt: new Date().toISOString() });
      const fd = fs.openSync(file, "wx", 0o600);
      let created;
      try {
        fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
        created = fs.fstatSync(fd);
      } finally { fs.closeSync(fd); }
      // Windows may finalize write timestamps on close; preserve the created
      // file ID, then capture the closed-file identity delivered to the child.
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== created.dev || stat.ino !== created.ino ||
          fs.realpathSync(file) !== file || fs.readFileSync(file, "utf8") !== raw)
        throw new Error("SUPERVISOR_LAUNCH_PIN_CHANGED");
      const { dev, ino, size, mtimeMs, ctimeMs } = stat;
      launchPin = { file, identity: JSON.stringify({ dev, ino, size, mtimeMs, ctimeMs,
        sha256: createHash("sha256").update(raw).digest("hex") }) };
    } finally { if (!maintenance.release()) throw new Error("MAINTENANCE_RELEASE_FAILED"); }
  } else if (args[0] === "gateway" && args[1] === "supervisor" && args[2] === "run") {
    if (args.length > 3 && (args.length !== 5 || args[3] !== "--state-dir" || path.resolve(args[4]) !== stateDir))
      throw new Error("GATEWAY_SUPERVISOR_LAUNCH_ARGUMENTS_INVALID");
    if (launcher !== path.join(stateDir, "bin", "c2c.js")) throw new Error("GATEWAY_SUPERVISOR_LAUNCH_PATH_INVALID");
    const folder = path.join(stateDir, "gateway");
    for (let current = folder; current !== path.parse(current).root; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current)
        throw new Error("GATEWAY_SUPERVISOR_LAUNCH_PATH_INVALID");
    }
    const configFile = path.join(folder, "supervisor.json");
    const configStat = fs.lstatSync(configFile);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1 || configStat.size > 64 * 1024 || fs.realpathSync(configFile) !== configFile)
      throw new Error("GATEWAY_SUPERVISOR_LAUNCH_CONFIG_INVALID");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (config.scope !== "machine" || config.stableLauncher !== launcher)
      throw new Error("GATEWAY_SUPERVISOR_LAUNCH_CONFIG_INVALID");
    const maintenance = release.tryAcquireMaintenanceLock(stateDir, "gateway-supervisor-launch");
    if (!maintenance.ok) throw new Error("MAINTENANCE_BUSY");
    try {
      const currentConfigStat = fs.lstatSync(configFile);
      if (!currentConfigStat.isFile() || currentConfigStat.isSymbolicLink() || currentConfigStat.nlink !== 1 || currentConfigStat.size > 64 * 1024 ||
          fs.realpathSync(configFile) !== configFile) throw new Error("GATEWAY_SUPERVISOR_LAUNCH_CONFIG_INVALID");
      const currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (currentConfig.scope !== "machine" || currentConfig.stableLauncher !== launcher)
        throw new Error("GATEWAY_SUPERVISOR_LAUNCH_CONFIG_INVALID");
      metadata = release.readCurrent(stateDir, "fast");
      if (!metadata) throw new Error("current.json 缺失");
      const nonce = randomUUID();
      const file = path.join(folder, `supervisor.${nonce}.launch.json`);
      const raw = JSON.stringify({ version: 1, scope: "machine", buildId: metadata.runtimeBuildId,
        nonce, launcherPath: launcher, createdAt: new Date().toISOString() });
      const fd = fs.openSync(file, "wx", 0o600);
      let created;
      try {
        fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
        created = fs.fstatSync(fd);
      } finally { fs.closeSync(fd); }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== created.dev || stat.ino !== created.ino ||
          fs.realpathSync(file) !== file || fs.readFileSync(file, "utf8") !== raw)
        throw new Error("GATEWAY_SUPERVISOR_LAUNCH_PIN_CHANGED");
      const { dev, ino, size, mtimeMs, ctimeMs } = stat;
      gatewayLaunchPin = { file, identity: JSON.stringify({ dev, ino, size, mtimeMs, ctimeMs,
        sha256: createHash("sha256").update(raw).digest("hex") }) };
    } finally { if (!maintenance.release()) throw new Error("MAINTENANCE_RELEASE_FAILED"); }
  } else metadata = release.readCurrent(stateDir, "fast");
  if (!metadata) throw new Error("current.json 缺失");
  const entry = path.join(metadata.releaseRoot, "bin", "c2c.js");
  // Windows broadcasts console Ctrl+C to the launcher and child; keep this parent alive for async child cleanup.
  const holdSignal = () => {};
  const holdWindowsSignals = process.platform === "win32";
  if (holdWindowsSignals) {
    process.on("SIGINT", holdSignal);
    process.on("SIGTERM", holdSignal);
  }
  let result;
  try {
    result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit", windowsHide: true,
      ...(launchPin ? { env: { ...process.env, C2C_SUPERVISOR_LAUNCH_PIN: launchPin.file,
        C2C_SUPERVISOR_LAUNCH_IDENTITY: launchPin.identity } } : gatewayLaunchPin ? { env: { ...process.env,
        C2C_STATE_DIR: stateDir, C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN: gatewayLaunchPin.file,
        C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY: gatewayLaunchPin.identity } } : {}) });
  } finally {
    if (holdWindowsSignals) {
      process.off("SIGINT", holdSignal);
      process.off("SIGTERM", holdSignal);
    }
  }
  // The release supervisor consumes its exact startup pin only after durable
  // runtime handoff. Exit alone proves no handoff; retain pre-handoff evidence.
  if (result.error) throw result.error;
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}
main().catch(error => {
  process.stderr.write(`c2c launcher: ${error instanceof Error ? error.message : "启动失败"}\n`);
  process.exitCode = 1;
});
