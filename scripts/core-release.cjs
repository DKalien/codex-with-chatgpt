"use strict";

// 安装与独立 launcher 共用的 Node-only release 格式；不加载 checkout 的包或代码。
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const HEX64 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
    "artifactSha256,checkoutRoot,installedAt,releaseRoot,runtimeBuildId,version";
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) {
    throw new Error("current.json 字段不严格");
  }
  if (value.version !== (legacy ? 1 : 2) || typeof value.checkoutRoot !== "string" || !path.isAbsolute(value.checkoutRoot) ||
      typeof value.runtimeBuildId !== "string" || !HEX64.test(value.runtimeBuildId) || typeof value.installedAt !== "string" || !ISO.test(value.installedAt) ||
      Number.isNaN(Date.parse(value.installedAt)) || new Date(value.installedAt).toISOString() !== value.installedAt ||
      (!legacy && (typeof value.releaseRoot !== "string" || !path.isAbsolute(value.releaseRoot) || typeof value.artifactSha256 !== "string" || !HEX64.test(value.artifactSha256)))) {
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

function verifyRelease(metadata, stateDir) {
  const expectedRoot = path.join(path.resolve(stateDir), "releases", metadata.runtimeBuildId);
  if (metadata.releaseRoot !== expectedRoot || fs.realpathSync(expectedRoot) !== expectedRoot) throw new Error("releaseRoot 身份不匹配");
  const manifest = readJson(path.join(expectedRoot, "release.json"));
  if (!manifest || Object.keys(manifest).sort().join(",") !== "artifactSha256,runtimeBuildId,version" || manifest.version !== 1 ||
      manifest.runtimeBuildId !== metadata.runtimeBuildId || manifest.artifactSha256 !== metadata.artifactSha256) throw new Error("release manifest 不匹配");
  if (!fs.statSync(path.join(expectedRoot, "bin", "c2c.js")).isFile() || !fs.statSync(path.join(expectedRoot, "dist", "cli", "index.js")).isFile() ||
      fs.readFileSync(path.join(expectedRoot, "dist", "build-id.txt"), "utf8").trim() !== metadata.runtimeBuildId ||
      buildId(path.join(expectedRoot, "dist")) !== metadata.runtimeBuildId || artifactHash(expectedRoot) !== metadata.artifactSha256) {
    throw new Error("已安装 release artifact 校验失败；拒绝运行或覆盖");
  }
  return metadata;
}

function readCurrent(stateDir) {
  const raw = readJson(path.join(stateDir, "current.json"));
  if (raw === null) return null;
  if (raw.version === 1) throw new Error("旧 current pointer 尚未冻结，请运行 dev-install");
  return verifyRelease(strictMetadata(raw), stateDir);
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
    fs.copyFileSync(useSnapshots ? path.join(assets, "c2c-entry.js") : path.join(root, "bin/c2c.js"), path.join(stage, "bin/c2c.js"));
    fs.copyFileSync(useSnapshots ? path.join(assets, "package.json") : path.join(root, "package.json"), path.join(stage, "package.json"));
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
    const metadata = { version: 2, checkoutRoot: root, releaseRoot, runtimeBuildId, artifactSha256, installedAt: new Date().toISOString() };
    if (fs.existsSync(releaseRoot)) verifyRelease(metadata, stateDir); // 不覆盖已有 release，同 ID 内容冲突拒绝。
    else {
      atomicWrite(path.join(stage, "release.json"), JSON.stringify({ version: 1, runtimeBuildId, artifactSha256 }));
      fs.renameSync(stage, releaseRoot);
      verifyRelease(metadata, stateDir);
    }
    return metadata;
  } finally {
    inside(path.join(path.resolve(stateDir), "releases"), stage);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function installCore(root, runtimeBuildId, stateDir, legacyFreeze = false) {
  const metadata = publishRelease(root, runtimeBuildId, stateDir, legacyFreeze);
  const bin = path.join(stateDir, "bin");
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

function protectCurrent(stateDir) {
  const value = readJson(path.join(stateDir, "current.json"));
  if (value === null) return null;
  if (value.version === 2) return readCurrent(stateDir);
  strictMetadata(value, true);
  // 必须在 frozen install/build 修改 checkout 之前冻结同一个已安装 A；失败则禁止继续构建。
  return installCore(value.checkoutRoot, value.runtimeBuildId, stateDir, true);
}

module.exports = { buildId, artifactHash, dependencyHash, readCurrent, installCore, protectCurrent };
