import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBridgeProvenance } from "../src/process/bridge-provenance.js";
import { adminFetch, findBridgeObservation, type RuntimeState } from "../src/bridge/runtime.js";
import { isPidAlive } from "../src/process/daemon-spawn.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

// R5f prework（F）：Windows-only 真实生产路径 parent-death 集成——
// sacrificial parent 经生产 ensureBridge()（maintenance lock + startup lease +
// detached spawn helper + 健康等待）在临时 state/workspace 上启动真实 Bridge，
// 测试确认健康后 taskkill /T /F 树杀 sacrificial parent，Bridge 必须以相同
// pid/startedAt/admin identity 保持健康；此 synthetic 向量不覆盖真实 updater；
// 最后经认证 admin shutdown 安全收尾。全程只用临时状态：无安装 runtime、
// 无真实 workspace 变更、无真实 tunnel。
//
// 这里只证明 synthetic parent-tree independence，不能泛化为所有 Codex close/update；
// forced-WMI 低层测试见 tests/daemon-parent-death.test.ts（作为补充证据保留）。

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) cleanup(temporaryDirs.pop()!);
});

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 ${file} 超时`);
}

async function pollUntilHealthy(
  workspaceId: string,
  expected: RuntimeState,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observation = await findBridgeObservation(workspaceId);
    if (observation.state === "healthy" &&
      observation.runtime.pid === expected.pid &&
      observation.runtime.startedAt === expected.startedAt &&
      observation.runtime.adminToken === expected.adminToken &&
      observation.runtime.port === expected.port) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what}（最后状态：${observation.state}${"reason" in observation ? `/${observation.reason}` : ""}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const windowsTests = describe.skipIf(process.platform !== "win32");

windowsTests("real Bridge survives spawner death (R5f prework, production path)", () => {
  it("sacrificial parent 经生产 ensureBridge 启动真实 Bridge → 树杀 parent → Bridge 同 pid/startedAt/admin identity 保持健康 → 认证 shutdown 停止", async () => {
    const dir = makeTmpDir("bridge-parent-death");
    temporaryDirs.push(dir);
    const wsRoot = makeTmpDir("bridge-parent-death-ws");
    temporaryDirs.push(wsRoot);
    const stateDir = makeTmpDir("bridge-parent-death-state");
    temporaryDirs.push(stateDir);
    makeGitRepo(wsRoot);

    const runtimeFile = path.join(dir, "runtime.json");
    // sacrificial parent：走生产 ensureBridge（ensureUnlocked → spawnDetachedDaemon
    // → Python helper Job 逃生 → 等待健康），把 runtime identity 写给测试后 linger。
    const parentScript = write(
      dir,
      "bridge-parent.mts",
      [
        `import fs from "node:fs";`,
        `import { ensureBridge } from ${JSON.stringify(
          path.relative(dir, path.resolve("src/process/daemon.js")).split(path.sep).join("/"),
        )};`,
        `const [runtimeFile, workspaceRoot] = process.argv.slice(2);`,
        `const { runtime, spawned } = await ensureBridge(workspaceRoot, { port: 0 });`,
        `fs.writeFileSync(runtimeFile, JSON.stringify({ runtime, spawned }));`,
        `setInterval(() => {}, 60_000); // linger until killed`,
      ].join("\n"),
    );

    const parent = spawn(process.execPath, ["--import", "tsx", parentScript, runtimeFile, wsRoot], {
      cwd: process.cwd(),
      env: { ...process.env, C2C_STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const parentStderr: string[] = [];
    parent.stderr?.on("data", (chunk) => parentStderr.push(String(chunk)));
    const stderrText = (): string => parentStderr.join("");

    // 测试进程的观察面切到 sacrificial state（结束后恢复）。
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    // leak-safe：runtime 一旦已知，finally 保证 best-effort 认证 shutdown（即使
    // spawn 之后任何断言失败）；sacrificial parent 若仍存活也保证终止。
    let runtime: RuntimeState | null = null;
    try {
      await waitForFile(runtimeFile, 120_000);
      const parsed = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as {
        runtime: RuntimeState;
        spawned: boolean;
      };
      runtime = parsed.runtime;
      expect(parsed.spawned, `parent stderr: ${stderrText()}`).toBe(true);
      expect(runtime.workspaceRoot).toBe(fs.realpathSync.native(wsRoot));
      expect(runtime.port).toBeGreaterThan(0);

      // 树杀前：真实 Bridge 健康，且 admin identity 与 runtime identity 一致。
      await pollUntilHealthy(runtime.workspaceId, runtime, 15_000, "树杀前 Bridge 未达健康");
      const infoBefore = await adminFetch<{ pid: number; startedAt: string; workspaceId: string }>(
        runtime, "GET", "/admin/info", 5000,
      );
      expect(infoBefore.pid).toBe(runtime.pid);
      expect(infoBefore.startedAt).toBe(runtime.startedAt);
      expect(infoBefore.workspaceId).toBe(runtime.workspaceId);
      const provenance = readBridgeProvenance(runtime);
      expect(provenance.spawn.status).toBe("matching");
      if (provenance.spawn.status === "matching") {
        expect(provenance.spawn.record.finalProcess.pid).toBe(runtime.pid);
        expect(provenance.spawn.record.healthyProcess.status).toBe("identified");
      }

      // Synthetic parent/树死亡；不等价于真实 Codex updater/process-host 的全部终止路径。
      const killed = spawnSync("taskkill", ["/T", "/F", "/PID", String(parent.pid!)], {
        windowsHide: true,
        encoding: "utf8",
      });
      expect(killed.status, `taskkill stderr: ${killed.stderr}`).toBe(0);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`sacrificial parent 未退出；stderr: ${stderrText()}`)), 10_000);
        parent.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(isPidAlive(parent.pid!), "sacrificial parent 必须已死亡").toBe(false);

      // Bridge 仍存活且身份不变（不是重启后的新实例：pid/startedAt/adminToken 相同）。
      expect(isPidAlive(runtime.pid), "Bridge daemon 必须在 parent 树杀后存活").toBe(true);
      await pollUntilHealthy(runtime.workspaceId, runtime, 20_000, "树杀后 Bridge 未保持健康");
      const infoAfter = await adminFetch<{ pid: number; startedAt: string; workspaceId: string }>(
        runtime, "GET", "/admin/info", 5000,
      );
      expect(infoAfter.pid).toBe(runtime.pid);
      expect(infoAfter.startedAt).toBe(runtime.startedAt);
      expect(infoAfter.workspaceId).toBe(runtime.workspaceId);
      expect(readBridgeProvenance(runtime)).toEqual(provenance);

      // 认证临时 shutdown → 验证停止。
      await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
      const deadline = Date.now() + 15_000;
      while (isPidAlive(runtime.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(isPidAlive(runtime.pid), "认证 shutdown 后 Bridge 必须停止").toBe(false);
      expect(readBridgeProvenance(runtime).shutdown).toMatchObject({ status: "matching", record: { reason: "admin_shutdown" } });
      const observation = await findBridgeObservation(runtime.workspaceId);
      expect(observation.state).toBe("stopped");
    } finally {
      // leak-safe 收尾（任何失败路径都执行；全程 best-effort，不掩盖原始错误）：
      // 1) 临时 Bridge runtime 已知 → 认证 shutdown；拒绝退出则树杀该临时实例。
      if (runtime) {
        try {
          await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
        } catch {
          // best-effort：保留原错误
        }
        const shutdownDeadline = Date.now() + 15_000;
        while (isPidAlive(runtime.pid) && Date.now() < shutdownDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (isPidAlive(runtime.pid)) {
          try {
            spawnSync("taskkill", ["/T", "/F", "/PID", String(runtime.pid)], {
              windowsHide: true,
              encoding: "utf8",
            });
          } catch {
            // best-effort
          }
        }
      }
      // 2) sacrificial parent 仍存活 → 终止（含树内残留），不泄漏到后续 suite。
      if (parent.pid && isPidAlive(parent.pid)) {
        try {
          spawnSync("taskkill", ["/T", "/F", "/PID", String(parent.pid)], {
            windowsHide: true,
            encoding: "utf8",
          });
        } catch {
          // best-effort
        }
      }
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  }, 240_000);
});
