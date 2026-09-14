import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stateDir: string;
let wsRoot: string;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("serve-fence-ws");
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
  delete process.env.C2C_STATE_DIR;
});

describe("hidden serve startup fencing", () => {
  it("GC/maintenance 持有时直接 serve 失败，无 runtime、无 start.lock 残留", () => {
    const held = tryAcquireMaintenanceLock(stateDir, "gc-apply");
    expect(held.ok).toBe(true);
    const entry = path.join(project, "src/cli/index.ts");
    const result = spawnSync(process.execPath, [
      "--import", "tsx", entry, "serve",
      "--workspace", wsRoot, "--port", "0",
    ], {
      cwd: project,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, C2C_STATE_DIR: stateDir },
      timeout: 20000,
    });
    if (held.ok) held.handle.release();
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/maintenance|繁忙|busy/i);
    const runtimeDir = path.join(stateDir, "runtime");
    const leftovers = fs.existsSync(runtimeDir)
      ? fs.readdirSync(runtimeDir).filter((n) => n.endsWith(".start.lock"))
      : [];
    expect(leftovers).toEqual([]);
    const wsId = new Workspace(wsRoot).id;
    expect(fs.existsSync(path.join(runtimeDir, `${wsId}.json`))).toBe(false);
  }, 30000);
});
