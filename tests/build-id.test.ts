import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuildId, writeBuildId } from "../scripts/write-build-id.mjs";
import { getRuntimeBuildId } from "../src/build-id.js";
import { startBridge } from "../src/bridge/server.js";
import { adminFetch, readRuntimeState } from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const idA = "a".repeat(64);
const idB = "b".repeat(64);

describe("runtime build ID", () => {
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
        const healthBefore = await fetch(`${bridge.localBaseUrl()}/health`).then(response => response.json()) as Record<string, unknown>;
        expect(healthBefore.runtimeBuildId).toBe(idA);

        writeBuildId(pointerDist);
        fs.writeFileSync(path.join(pointerDist, "index.js"), "pointer-v2");
        writeBuildId(pointerDist);

        const healthAfter = await fetch(`${bridge.localBaseUrl()}/health`).then(response => response.json()) as Record<string, unknown>;
        const info = await adminFetch<Record<string, unknown>>(runtime!, "GET", "/admin/info");
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
