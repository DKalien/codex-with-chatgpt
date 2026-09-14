"use strict";

// 安装与独立 launcher 共用的 Node-only release 格式；不加载 checkout 的包或代码。
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const HEX64 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// 固定入口清单，不允许 manifest 自选/删减需验证的 bootstrap。
const BOOTSTRAP = ["bin/c2c.js", "package.json", "dist/build-id.txt", "dist/cli/index.js",
  "scripts/core-release.cjs", "scripts/core-launcher.cjs", "scripts/install-core.mjs",
  "dist/core-assets/core-release.cjs", "dist/core-assets/core-launcher.cjs", "dist/core-assets/install-core.mjs",
  "dist/core-assets/c2c-entry.js", "dist/core-assets/package.json", "dist/core-assets/dependencies-sha256.txt"];
function sha256(body) { return createHash("sha256").update(body).digest("hex"); }
function regularFile(root, name) {
  const file = path.join(root, name);
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error("bootstrap 路径身份不匹配");
  return fs.readFileSync(file);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("release 链接越过安装边界");
  }
  return relative.split(path.sep).join("/");
}

function files(root, relative = "") {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name);
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function buildId(dist) {
  const hash = createHash("sha256");
  for (const name of files(dist)) {
    if (name === "build-id.txt") continue;
    if (!fs.lstatSync(path.join(dist, name)).isFile()) throw new Error("dist 含非普通构建文件");
    hash.update(name.split(path.sep).join("/")).update("\0").update(fs.readFileSync(path.join(dist, name))).update("\0");
  }
  return hash.digest("hex");
}

function artifactHash(root, linkRoot = root, checkTargets = true, exclude = () => false) {
  const hash = createHash("sha256");
  for (const name of files(root)) {
    if (name === "release.json" || exclude(name.split(path.sep).join("/"))) continue;
    const file = path.join(root, name), stat = fs.lstatSync(file);
    hash.update(name.split(path.sep).join("/")).update("\0");
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.join(linkRoot, path.dirname(name)), fs.readlinkSync(file));
      const relative = inside(linkRoot, target);
      if (checkTargets) inside(root, fs.realpathSync(file));
      if (checkTargets && fs.statSync(file).isFile()) hash.update("file\0").update(fs.readFileSync(file));
      else hash.update("link\0").update(relative);
    } else if (stat.isFile()) hash.update("file\0").update(fs.readFileSync(file));
    else throw new Error("release 含不支持的文件类型");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dependencyMetadata(name) {
  return name.split("/").some(part => [".bin", ".cache", ".vite", ".vite-temp"].includes(part)) ||
    [".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json", ".pnpm/lock.yaml"].includes(name);
}
function dependencyHash(root, linkRoot = root, checkTargets = true) {
  return artifactHash(root, linkRoot, checkTargets, dependencyMetadata);
}

function strictMetadata(value, legacy = false) {
  const keys = legacy ? "checkoutRoot,installedAt,runtimeBuildId,version" :
    value?.version === 3 ? "artifactSha256,checkoutRoot,installedAt,manifestSha256,releaseRoot,runtimeBuildId,version" :
      "artifactSha256,checkoutRoot,installedAt,releaseRoot,runtimeBuildId,version";
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) {
    throw new Error("current.json 字段不严格");
  }
  if (!(legacy ? value.version === 1 : [2, 3].includes(value.version)) || typeof value.checkoutRoot !== "string" || !path.isAbsolute(value.checkoutRoot) ||
      typeof value.runtimeBuildId !== "string" || !HEX64.test(value.runtimeBuildId) || typeof value.installedAt !== "string" || !ISO.test(value.installedAt) ||
      Number.isNaN(Date.parse(value.installedAt)) || new Date(value.installedAt).toISOString() !== value.installedAt ||
      (!legacy && (typeof value.releaseRoot !== "string" || !path.isAbsolute(value.releaseRoot) || typeof value.artifactSha256 !== "string" || !HEX64.test(value.artifactSha256))) ||
      (value.version === 3 && (typeof value.manifestSha256 !== "string" || !HEX64.test(value.manifestSha256)))) {
    throw new Error("current.json 值无效");
  }
  return value;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("无法读取安装 metadata"); }
  try { return JSON.parse(raw); } catch { throw new Error("安装 metadata 不是有效 JSON"); }
}

function verifyRelease(metadata, stateDir, mode = "full") {
  if (!["fast", "full"].includes(mode)) throw new Error("未知 release 验证模式");
  const expectedRoot = path.join(path.resolve(stateDir), "releases", metadata.runtimeBuildId);
  if (metadata.releaseRoot !== expectedRoot || fs.realpathSync(expectedRoot) !== expectedRoot) throw new Error("releaseRoot 身份不匹配");
  const manifestBody = regularFile(expectedRoot, "release.json");
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  const modern = metadata.version === 3;
  if (!manifest || Object.keys(manifest).sort().join(",") !== (modern ? "artifactSha256,bootstrap,runtimeBuildId,version" : "artifactSha256,runtimeBuildId,version") || manifest.version !== (modern ? 2 : 1) ||
      manifest.runtimeBuildId !== metadata.runtimeBuildId || manifest.artifactSha256 !== metadata.artifactSha256) throw new Error("release manifest 不匹配");
  if (modern) {
    const dependencies = path.join(expectedRoot, "node_modules");
    if (!fs.lstatSync(dependencies).isDirectory() || fs.realpathSync(dependencies) !== dependencies) throw new Error("node_modules 路径身份不匹配");
    if (sha256(manifestBody) !== metadata.manifestSha256 || !manifest.bootstrap || Array.isArray(manifest.bootstrap) ||
        typeof manifest.bootstrap !== "object" || Object.keys(manifest.bootstrap).sort().join(",") !== [...BOOTSTRAP].sort().join(",")) {
      throw new Error("release manifest/bootstrap 绑定不匹配");
    }
    for (const name of BOOTSTRAP) {
      if (typeof manifest.bootstrap[name] !== "string" || !HEX64.test(manifest.bootstrap[name]) ||
          sha256(regularFile(expectedRoot, name)) !== manifest.bootstrap[name]) throw new Error(`bootstrap artifact 校验失败：${name}`);
    }
    if (fs.readFileSync(path.join(expectedRoot, "dist", "build-id.txt"), "utf8").trim() !== metadata.runtimeBuildId) {
      throw new Error("release build-id 不匹配");
    }
    // ponytail: fast 仅认证固定 bootstrap，不声称深层 dist/依赖完整性；维护使用 full。
    if (mode === "fast") return metadata;
  }
  if (!fs.statSync(path.join(expectedRoot, "bin", "c2c.js")).isFile() || !fs.statSync(path.join(expectedRoot, "dist", "cli", "index.js")).isFile() ||
      fs.readFileSync(path.join(expectedRoot, "dist", "build-id.txt"), "utf8").trim() !== metadata.runtimeBuildId ||
      buildId(path.join(expectedRoot, "dist")) !== metadata.runtimeBuildId || artifactHash(expectedRoot) !== metadata.artifactSha256) {
    throw new Error("已安装 release artifact 校验失败；拒绝运行或覆盖");
  }
  return metadata;
}

function readPointer(stateDir) {
  stateDir = path.resolve(stateDir);
  const raw = readJson(path.join(stateDir, "current.json"));
  if (raw === null) return null;
  if (fs.realpathSync(path.join(stateDir, "current.json")) !== path.join(stateDir, "current.json") ||
      !fs.lstatSync(path.join(stateDir, "current.json")).isFile()) throw new Error("current pointer 路径身份不匹配");
  return raw;
}

function readCurrent(stateDir, mode = "full") {
  const raw = readPointer(stateDir);
  if (raw === null) return null;
  if (raw.version === 1) throw new Error("旧 current pointer 尚未冻结，请运行 dev-install");
  return verifyRelease(strictMetadata(raw), stateDir, mode);
}

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function publishRelease(checkoutRoot, runtimeBuildId, stateDir, legacyFreeze) {
  if (typeof checkoutRoot !== "string" || !path.isAbsolute(checkoutRoot)) throw new Error("checkoutRoot 必须是绝对路径");
  const root = fs.realpathSync(checkoutRoot);
  for (const file of ["bin/c2c.js", "dist/cli/index.js", "package.json"]) {
    if (!fs.existsSync(path.join(root, file)) || !fs.statSync(path.join(root, file)).isFile()) throw new Error(`checkout 缺少 ${file}`);
  }
  if (typeof runtimeBuildId !== "string" || !HEX64.test(runtimeBuildId)) throw new Error("runtimeBuildId 必须是 64 位小写十六进制字符串");
  if (fs.readFileSync(path.join(root, "dist/build-id.txt"), "utf8").trim() !== runtimeBuildId || buildId(path.join(root, "dist")) !== runtimeBuildId) {
    throw new Error("dist/build-id.txt 与实际 runtime artifact 不一致");
  }
  const releaseRoot = path.join(path.resolve(stateDir), "releases", runtimeBuildId);
  const stage = `${releaseRoot}.${randomUUID()}.tmp`;
  const assets = path.join(root, "dist", "core-assets");
  const useSnapshots = fs.existsSync(assets);
  if (!useSnapshots && !legacyFreeze) throw new Error("构建缺少 core-assets 快照，请重新 build");
  const dependencies = useSnapshots ? fs.readFileSync(path.join(assets, "dependencies-sha256.txt"), "utf8").trim() : null;
  if (useSnapshots && (!HEX64.test(dependencies) || dependencyHash(path.join(root, "node_modules")) !== dependencies)) {
    throw new Error("依赖内容在 build 后已改变，请重新 build");
  }
  const links = [];
  // ponytail: 保存完整已安装依赖布局（含开发依赖）；先保证独立与可验证，不重新实现包管理器。
  function copy(source, target) {
    const relative = path.relative(root, source).split(path.sep).join("/");
    // 这些是包管理器/测试的可变缓存或 checkout 映射，不属于 Node 运行依赖。
    if (relative.startsWith("node_modules/") && dependencyMetadata(relative.slice("node_modules/".length))) return;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      const relative = inside(root, fs.realpathSync(source));
      links.push({ target, destination: path.join(releaseRoot, relative), directory: fs.statSync(source).isDirectory() });
    } else if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } else throw new Error("checkout 含不支持的文件类型");
  }
  try {
    fs.mkdirSync(stage, { recursive: true });
    for (const name of ["dist", "node_modules"]) {
      copy(path.join(root, name), path.join(stage, name));
    }
    fs.mkdirSync(path.join(stage, "bin"));
    fs.writeFileSync(path.join(stage, "bin/c2c.js"), regularFile(root, useSnapshots ? "dist/core-assets/c2c-entry.js" : "bin/c2c.js"), { flag: "wx" });
    fs.writeFileSync(path.join(stage, "package.json"), regularFile(root, useSnapshots ? "dist/core-assets/package.json" : "package.json"), { flag: "wx" });
    fs.mkdirSync(path.join(stage, "scripts"));
    for (const name of ["core-release.cjs", "core-launcher.cjs", "install-core.mjs"]) {
      fs.copyFileSync(path.join(useSnapshots ? assets : __dirname, name), path.join(stage, "scripts", name));
    }
    for (const link of links) {
      fs.mkdirSync(path.dirname(link.target), { recursive: true });
      if (process.platform === "win32" && link.directory) fs.symlinkSync(link.destination, link.target, "junction");
      else {
        // 相对链接保持目录 rename 后可用；普通文件链接直接复制，避免 Windows 管理员权限。
        const sourceTarget = path.join(root, inside(releaseRoot, link.destination));
        if (!link.directory) fs.copyFileSync(sourceTarget, link.target, fs.constants.COPYFILE_EXCL);
        else fs.symlinkSync(path.relative(path.join(releaseRoot, path.relative(stage, path.dirname(link.target))), link.destination), link.target, "dir");
      }
    }
    const artifactSha256 = artifactHash(stage, releaseRoot, false);
    // 拷贝过程中源构建发生变化必须拒绝；不能把部分 B 当作 A 安装。
    if (buildId(path.join(stage, "dist")) !== runtimeBuildId || buildId(path.join(root, "dist")) !== runtimeBuildId) throw new Error("构建在安装期间发生变化");
    if (useSnapshots && dependencyHash(path.join(stage, "node_modules"), path.join(releaseRoot, "node_modules"), false) !== dependencies) {
      throw new Error("依赖在安装期间发生变化");
    }
    // 旧 build 的安装脚本可能不识别 v3。只有本版 bootstrap 快照才能发布新格式；旧快照保留 v2。
    const modern = useSnapshots && ["core-release.cjs", "core-launcher.cjs"].every(name =>
      fs.readFileSync(path.join(stage, "scripts", name)).equals(fs.readFileSync(path.join(__dirname, name))));
    const existing = fs.existsSync(releaseRoot);
    // 已存在的 immutable release 不重写 manifest；重装旧格式仍按 full 校验。
    const manifestVersion = existing ? readJson(path.join(releaseRoot, "release.json"))?.version : modern ? 2 : 1;
    if (![1, 2].includes(manifestVersion) || (manifestVersion === 2 && !modern)) throw new Error("release manifest 版本不兼容");
    const manifest = { version: manifestVersion, runtimeBuildId, artifactSha256,
      ...(manifestVersion === 2 ? { bootstrap: Object.fromEntries(BOOTSTRAP.map(name => [name, sha256(regularFile(stage, name))])) } : {}) };
    const manifestBody = JSON.stringify(manifest);
    const metadata = { version: manifestVersion === 2 ? 3 : 2, checkoutRoot: root, releaseRoot, runtimeBuildId, artifactSha256,
      ...(manifestVersion === 2 ? { manifestSha256: sha256(manifestBody) } : {}), installedAt: new Date().toISOString() };
    if (existing) verifyRelease(metadata, stateDir); // 不覆盖已有 release，同 ID 内容冲突拒绝。
    else {
      atomicWrite(path.join(stage, "release.json"), manifestBody);
      fs.renameSync(stage, releaseRoot);
      verifyRelease(metadata, stateDir);
    }
    return metadata;
  } finally {
    inside(path.join(path.resolve(stateDir), "releases"), stage);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Machine-wide maintenance lock. Atomic exclusive create; never steal stale locks.
 * Owner token is required to release; replaced/unmatched lock is not unlinked.
 * Fresh stateDir is created by the lock itself (install bootstrap must not depend on caller mkdir).
 */
function tryAcquireMaintenanceLock(stateDir, operation) {
  const dir = path.resolve(stateDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }
  const file = path.join(dir, "maintenance.lock");
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") return { ok: false, code: "MAINTENANCE_BUSY" };
    throw error;
  }
  const token = randomUUID();
  const record = {
    version: 1,
    operation: String(operation || "unknown"),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw error;
  }
  let released = false;
  return {
    ok: true,
    token,
    path: file,
    release() {
      if (released) return true;
      let current = null;
      try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
      if (!current || current.token !== token) return false;
      try { fs.closeSync(fd); } catch { return false; }
      try { fs.unlinkSync(file); } catch { return false; }
      // unlink 失败时不能宣称 released；留下 lock 供人工核对。
      released = true;
      return true;
    },
  };
}

function withMaintenanceLock(stateDir, operation, action) {
  const lock = tryAcquireMaintenanceLock(stateDir, operation);
  if (!lock.ok) {
    const error = new Error("machine maintenance lock busy");
    error.code = "MAINTENANCE_BUSY";
    throw error;
  }
  let result;
  let actionError = null;
  try {
    result = action(lock);
  } catch (error) {
    actionError = error;
  }
  const released = lock.release();
  if (actionError) throw actionError;
  if (!released) {
    const error = new Error("maintenance lock release failed; lock may remain for manual recovery");
    error.code = "MAINTENANCE_RELEASE_FAILED";
    error.result = result;
    throw error;
  }
  return result;
}

function installCoreLocked(root, runtimeBuildId, stateDir, legacyFreeze = false) {
  stateDir = path.resolve(stateDir);
  const bin = path.join(stateDir, "bin");
  try {
    const stat = fs.lstatSync(bin);
    if (!stat.isDirectory() || fs.realpathSync(bin) !== bin) throw new Error("machine bootstrap 路径身份不匹配");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    fs.mkdirSync(bin);
  }
  const metadata = publishRelease(root, runtimeBuildId, stateDir, legacyFreeze);
  const sources = [[path.join(bin, "core-release.cjs"), fs.readFileSync(path.join(metadata.releaseRoot, "scripts/core-release.cjs"))],
    [path.join(bin, "c2c.js"), fs.readFileSync(path.join(metadata.releaseRoot, "scripts/core-launcher.cjs"))]];
  const prior = sources.map(([file]) => fs.existsSync(file) ? fs.readFileSync(file) : null);
  try {
    for (const [file, body] of sources) atomicWrite(file, body);
    atomicWrite(path.join(stateDir, "current.json"), JSON.stringify(metadata));
  } catch (error) {
    for (let index = 0; index < sources.length; index++) {
      if (prior[index] === null) fs.rmSync(sources[index][0], { force: true });
      else atomicWrite(sources[index][0], prior[index]);
    }
    throw new Error(`安装原子切换失败，保留旧 pointer：${error.message}`);
  }
  return metadata;
}

function installCore(root, runtimeBuildId, stateDir, legacyFreeze = false) {
  // publish → machine bin → atomic current switch 均在 maintenance 锁内，避免与 GC apply 相撞。
  return withMaintenanceLock(stateDir, "install", () => installCoreLocked(root, runtimeBuildId, stateDir, legacyFreeze));
}

function protectCurrent(stateDir) {
  const value = readPointer(stateDir);
  if (value === null) return null;
  if (value.version === 2 || value.version === 3) return readCurrent(stateDir);
  strictMetadata(value, true);
  // 必须在 frozen install/build 修改 checkout 之前冻结同一个已安装 A；失败则禁止继续构建。
  return installCore(value.checkoutRoot, value.runtimeBuildId, stateDir, true);
}

module.exports = {
  buildId, artifactHash, dependencyHash, readCurrent, installCore, protectCurrent,
  tryAcquireMaintenanceLock, withMaintenanceLock,
};
