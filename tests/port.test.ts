import { cleanupStrict } from "./strict-teardown.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, write, isolateStateDir } from "./helpers.js";

const directories: string[] = [];
const bridges: Bridge[] = [];
let previousState: string | undefined;
function tmp(name: string): string {
  const dir = makeTmpDir(name); directories.push(dir); return dir;
}
beforeEach(() => {
  previousState = process.env.C2C_STATE_DIR;
  directories.push(isolateStateDir());
});
afterEach(async () => {
  try { for (const bridge of bridges.splice(0)) await bridge.close(); } finally {
    if (previousState === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousState;
    await cleanupStrict(...directories.splice(0));
  }
});

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    const rootA = tmp("port-a");
    const rootB = tmp("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");


    const bridgeA = await startBridge({
      workspaceRoot: rootA,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(tmp("auth"), "a.json"),
    });
    bridges.push(bridgeA);
    const preferred = bridgeA.port;
    expect(preferred).toBeGreaterThan(0);
    const bridgeB = await startBridge({
      workspaceRoot: rootB,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(tmp("auth"), "b.json"),
    });

    bridges.push(bridgeB);
    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // health identifies each bridge's workspace, so callers can detect reuse
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.workspaceId).toBe(bridgeA.workspace.id);
    expect(healthB?.workspaceId).toBe(bridgeB.workspace.id);
    expect(healthA?.workspaceId).not.toBe(healthB?.workspaceId);


  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = tmp("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ workspaceRoot: root, host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);

  });
});
