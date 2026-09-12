import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import release from "./core-release.cjs";

const BUILD_ID_FILE = "build-id.txt";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function artifactFiles(distDir, relative = "") {
  const directory = path.join(distDir, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) return artifactFiles(distDir, entryRelative);
    if (!entry.isFile() || entryRelative === BUILD_ID_FILE) return [];
    return [entryRelative];
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** Hash runtime artifacts by stable relative name and content only. */
export function computeBuildId(distDir) {
  const hash = createHash("sha256");
  for (const relative of artifactFiles(distDir)) {
    const normalized = relative.split(path.sep).join("/");
    hash.update(normalized, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(path.join(distDir, relative)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

/** Atomically publish the build ID after all runtime artifacts are present. */
export function writeBuildId(distDir = path.join(projectRoot, "dist")) {
  const buildId = computeBuildId(distDir);
  const destination = path.join(distDir, BUILD_ID_FILE);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${buildId}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return buildId;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // launcher/格式实现也属于实际程序版本；只改安装代码也必须生成新 buildId。
  const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, "dist");
  const assets = path.join(dist, "core-assets");
  fs.mkdirSync(assets, { recursive: true });
  for (const name of ["core-release.cjs", "core-launcher.cjs", "install-core.mjs"]) {
    fs.copyFileSync(path.join(projectRoot, "scripts", name), path.join(assets, name));
  }
  for (const [source, destination] of [["bin/c2c.js", "c2c-entry.js"], ["package.json", "package.json"], ["pnpm-lock.yaml", "pnpm-lock.yaml"]]) {
    fs.copyFileSync(path.join(projectRoot, source), path.join(assets, destination));
  }
  fs.writeFileSync(path.join(assets, "dependencies-sha256.txt"), release.dependencyHash(path.join(projectRoot, "node_modules")));
  writeBuildId(dist);
}
