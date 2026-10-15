import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { installCore, type InstallMetadata } from "../src/core/install.js";
import { writeBuildId } from "../scripts/write-build-id.mjs";
import { buildCoreFixture, makeTmpDir, write } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

/** 包含空目录，并拒绝 junction、symlink 和 hardlink。 */
export function gcFixtureSnapshot(root: string): string {
  assert.equal(fs.realpathSync.native(root), root);
  const digest = createHash("sha256");
  function visit(relative: string): void {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    digest.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file"]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
      digest.update(fs.readFileSync(file));
    }
  }
  visit("");
  return digest.digest("hex");
}

/** 保留原 fixture 的真实构建/安装序列；同步调用期间临时隔离 state。 */
export function installGcFixture(state: string, root: string, markers: string[]): InstallMetadata[] {
  const previousState = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = state;
  try {
    write(root, "bin/c2c.js", "// fixture");
    write(root, "dist/cli/index.js", "// fixture");
    write(root, "package.json", '{"type":"module"}');
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    return markers.map((marker, index) => {
      write(root, "dist/cli/index.js", `// ${marker}`);
      return installCore(root, index === 0 ? buildCoreFixture(root) : writeBuildId(path.join(root, "dist")));
    });
  } finally {
    if (previousState === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousState;
  }
}

/** 每个测试文件创建自己的 cache，case 只获得普通独立副本。 */
export function createGcFixtureCache() {
  const seedDirs: string[] = [];
  type Seed = {
    bundle: string; state: string; root: string; releases: InstallMetadata[];
    snapshot: string; stateSnapshot: string; rootSnapshot: string;
  };
  const seeds = new Map<string, Seed>();
  const usedSeeds = new Set<Seed>();
  return {
    copy(state: string, root: string, markers: string[]) {
      const key = JSON.stringify(markers);
      let seed = seeds.get(key);
      if (!seed) {
        const bundle = makeTmpDir("gc-seed");
        seedDirs.push(bundle); // 安装中途失败的 seed 也必须严格清理。
        const seedState = path.join(bundle, "state");
        const seedRoot = path.join(bundle, "checkout");
        fs.mkdirSync(seedState);
        fs.mkdirSync(seedRoot);
        const releases = installGcFixture(seedState, seedRoot, markers);
        seed = { bundle, state: seedState, root: seedRoot, releases,
          snapshot: gcFixtureSnapshot(bundle), stateSnapshot: gcFixtureSnapshot(seedState),
          rootSnapshot: gcFixtureSnapshot(seedRoot) };
        seeds.set(key, seed);
      }
      usedSeeds.add(seed);
      assert.equal(gcFixtureSnapshot(seed.bundle), seed.snapshot);
      fs.cpSync(seed.state, state, { recursive: true, force: false, errorOnExist: true });
      fs.cpSync(seed.root, root, { recursive: true, force: false, errorOnExist: true });
      assert.equal(gcFixtureSnapshot(state), seed.stateSnapshot);
      assert.equal(gcFixtureSnapshot(root), seed.rootSnapshot);
      const releases = seed.releases.map(metadata => ({ ...metadata, checkoutRoot: root,
        releaseRoot: path.join(state, "releases", metadata.runtimeBuildId) }));
      if (releases.length) write(state, "current.json", JSON.stringify(releases[releases.length - 1]));
      return { state, root, releases };
    },
    assertUnchanged() {
      try {
        for (const seed of usedSeeds) assert.equal(gcFixtureSnapshot(seed.bundle), seed.snapshot);
      } finally {
        usedSeeds.clear();
      }
    },
    async cleanup() {
      try {
        for (const seed of seeds.values()) assert.equal(gcFixtureSnapshot(seed.bundle), seed.snapshot);
      } finally {
        await cleanupStrict(...seedDirs);
      }
    },
  };
}
