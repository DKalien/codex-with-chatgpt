import { requestHttp } from "./http-json.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { computeBuildId, writeBuildId } from "../scripts/write-build-id.mjs";
import release from "../scripts/core-release.cjs";
import { getRuntimeBuildId } from "../src/build-id.js";
import { startBridge } from "../src/bridge/server.js";
import { readRuntimeState } from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const idA = "a".repeat(64);
const idB = "b".repeat(64);

describe("runtime build ID", () => {
  it("canonical build 在所有打包步骤之后发布 ID；partial companion build 不发布 Core ID", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const steps = scripts.build.split("&&").map((step: string) => step.trim());
    expect(steps).toEqual([
      "tsc -p tsconfig.json",
      "node scripts/copy-desktop-helper.mjs",
      "node scripts/copy-daemon-helper.mjs",
      "node scripts/build-browser-companion.mjs",
      "node scripts/write-build-id.mjs",
    ]);
    // Partial build 只打包；产物改变时旧 ID 由 installer 重算拒绝，不冒充完整 release。
    expect(scripts["build:companion"]).toBe("tsc -p tsconfig.json && node scripts/build-browser-companion.mjs");
  });

  it("真实 finalizer 先复制 bootstrap/package/lock/依赖快照，再发布稳定的完整 artifact ID", () => {
    const dist = makeTmpDir("build-finalizer");
    try {
      write(dist, "cli/index.js", "// compiled CLI");
      write(dist, "browser-companion/bridge-client.js", "// packaged Companion");
      write(dist, "build-id.txt", idA);
      write(dist, "feedback/canonical-compat.js", "// retired compatibility writer");
      write(dist, "feedback/canonical-compat.js.map", "{}");
      const finalize = () => execFileSync(process.execPath, [path.resolve("scripts/write-build-id.mjs"), dist], { windowsHide: true });
      finalize();
      expect(fs.existsSync(path.join(dist, "feedback/canonical-compat.js"))).toBe(false);
      expect(fs.existsSync(path.join(dist, "feedback/canonical-compat.js.map"))).toBe(false);
      const first = fs.readFileSync(path.join(dist, "build-id.txt"), "utf8").trim();
      expect(first).not.toBe(idA);
      expect(first).toBe(computeBuildId(dist));
      expect(first).toBe(release.buildId(dist));
      for (const [source, destination] of [
        ["scripts/core-release.cjs", "core-release.cjs"],
        ["scripts/core-launcher.cjs", "core-launcher.cjs"],
        ["scripts/install-core.mjs", "install-core.mjs"],
        ["bin/c2c.js", "c2c-entry.js"],
        ["package.json", "package.json"],
        ["pnpm-lock.yaml", "pnpm-lock.yaml"],
      ]) {
        expect(fs.readFileSync(path.join(dist, "core-assets", destination))).toEqual(fs.readFileSync(path.resolve(source)));
      }
      expect(fs.readFileSync(path.join(dist, "core-assets/dependencies-sha256.txt"), "utf8"))
        .toBe(release.dependencyHash(path.resolve("node_modules")));
      // 重复完整 finalizer 由 packaging 完整 pipeline 覆盖，此处验证同一自定义目录重复发布 ID。
      writeBuildId(dist);
      expect(fs.readFileSync(path.join(dist, "build-id.txt"), "utf8").trim()).toBe(first);
      fs.appendFileSync(path.join(dist, "core-assets/core-launcher.cjs"), "\n// changed");
      expect(computeBuildId(dist)).not.toBe(first);
      expect(release.buildId(dist)).toBe(computeBuildId(dist));
    } finally { cleanup(dist); }
  });

  it("只按相对路径和内容计算，忽略 mtime，包含 Desktop helper", () => {
    const dist = makeTmpDir("build-id-stable");
    try {
      write(dist, "bridge/server.js", "bridge-v1");
      write(dist, "desktop/helper/desktop_ipc.py", "helper-v1");
      const first = computeBuildId(dist);
      const file = path.join(dist, "bridge/server.js");
      const date = new Date("2020-01-01T00:00:00Z");
      fs.utimesSync(file, date, date);
      expect(computeBuildId(dist)).toBe(first);

      fs.writeFileSync(path.join(dist, "desktop/helper/desktop_ipc.py"), "helper-v2");
      expect(computeBuildId(dist)).not.toBe(first);
    } finally {
      cleanup(dist);
    }
  });

  it("内容变化产生不同 ID，build-id.txt 自身不参与 hash", () => {
    const dist = makeTmpDir("build-id-content");
    try {
      write(dist, "bridge/server.js", "content-a");
      const first = computeBuildId(dist);
      fs.writeFileSync(path.join(dist, "build-id.txt"), idA);
      expect(computeBuildId(dist)).toBe(first);
      fs.writeFileSync(path.join(dist, "build-id.txt"), idB);
      expect(computeBuildId(dist)).toBe(first);

      fs.writeFileSync(path.join(dist, "bridge/server.js"), "content-b");
      expect(computeBuildId(dist)).not.toBe(first);
    } finally {
      cleanup(dist);
    }
  });

  it("原子写入 build-id.txt，并保持相同产物稳定", () => {
    const dist = makeTmpDir("build-id-write");
    try {
      write(dist, "index.js", "stable");
      const first = writeBuildId(dist);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.readFileSync(path.join(dist, "build-id.txt"), "utf8")).toBe(`${first}\n`);
      expect(writeBuildId(dist)).toBe(first);
    } finally {
      cleanup(dist);
    }
  });

  it("Bridge 在启动时捕获 runtimeBuildId，后续 pointer 变化不污染运行实例", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("build-id-bridge");
    const pointerDist = makeTmpDir("build-id-pointer");
    write(pointerDist, "index.js", "pointer-v1");
    try {
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: true,
        runtimeBuildId: idA,
        authStoreFile: path.join(stateDir, "auth.json"),
      });
      try {
        const runtime = readRuntimeState(bridge.workspace.id);
        expect(runtime?.runtimeBuildId).toBe(idA);
        const healthBefore = await requestHttp(`${bridge.localBaseUrl()}/health`).then(response => response.json()) as Record<string, unknown>;
        expect(healthBefore.runtimeBuildId).toBe(idA);

        writeBuildId(pointerDist);
        fs.writeFileSync(path.join(pointerDist, "index.js"), "pointer-v2");
        writeBuildId(pointerDist);

        const healthAfter = await requestHttp(`${bridge.localBaseUrl()}/health`).then(response => response.json()) as Record<string, unknown>;
        const infoResponse = await requestHttp(`${bridge.localBaseUrl()}/admin/info`, {
          headers: { Authorization: `Bearer ${runtime!.adminToken}` },
        });
        expect(infoResponse.status).toBe(200);
        const info = await infoResponse.json() as Record<string, unknown>;
        expect(healthAfter.runtimeBuildId).toBe(idA);
        expect(info.runtimeBuildId).toBe(idA);
      } finally {
        await bridge.close();
      }
    } finally {
      cleanup(root);
      cleanup(pointerDist);
      cleanup(stateDir);
    }
  });

  it("source 运行时没有 dist artifact 时返回 null", () => {
    expect(getRuntimeBuildId()).toBeNull();
  });
});
