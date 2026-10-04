import { cleanupStrict } from "./strict-teardown.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPidAlive,
  resolveDaemonSpawnHelperPath,
  resolveDaemonSpawnPython,
} from "../src/process/daemon-spawn.js";
import { makeTmpDir, write } from "./helpers.js";
import type { DaemonSpawnResult } from "../src/process/daemon-spawn.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await cleanupStrict(...temporaryDirs.splice(0));
});

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  temporaryDirs.push(dir);
  return dir;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 ${file} 超时`);
}

async function pollUntil(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(check(), what).toBe(true);
}

/** breakaway try 块首行注入 raise 的唯一锚点（posix 块同一调用以 ", 0)" 结尾，不匹配）。 */
const BREAKAWAY_ANCHOR =
  '        try:\n            pid = _spawn_detached(command, options["log"], env, options["cwd"],\n';

/** 生成强制 breakaway 失败的 helper 副本：生产代码原样落入 WMI relay 路径。 */
function writeForcedWmiHelper(dir: string): string {
  const original = fs.readFileSync(resolveDaemonSpawnHelperPath(), "utf8");
  expect(original).toContain(BREAKAWAY_ANCHOR);
  const patched = original.replace(
    BREAKAWAY_ANCHOR,
    `${BREAKAWAY_ANCHOR.slice(0, BREAKAWAY_ANCHOR.indexOf("\n") + 1)}            raise OSError("breakaway disabled by test")\n${BREAKAWAY_ANCHOR.slice(BREAKAWAY_ANCHOR.indexOf("\n") + 1)}`,
  );
  expect(patched).toContain('raise OSError("breakaway disabled by test")');
  return write(dir, "daemon_spawn_forced_wmi.py", patched);
}

interface ParentDeathOutcome {
  spawned: DaemonSpawnResult;
  info: { parentPid: number; canaryPid: number; runnerCode: number; parentInJob: boolean | null };
  parentStderr: string;
}

/**
 * R5f prework：Windows-only parent-death E2E 公共流程。
 *
 * sacrificial parent 经生产 spawn helper 路径启动 daemon（node linger 脚本，
 * 非真实 Bridge），随后测试用 taskkill /T /F 对 parent 全树击杀（等价于
 * parent/Job 关闭的杀伤向量）。canary（未逃生的树内子进程）被树杀杀死，
 * 证明击杀确实生效；daemon 必须存活。之后安全收尾 sacrificial daemon。
 * 不触达真实安装的 Bridge/workspace。
 */
async function runParentDeathE2E(
  name: string,
  helperPath?: string,
  onAlive?: (spawned: DaemonSpawnResult) => void,
): Promise<ParentDeathOutcome> {
  const dir = tmp(name);
  const resultFile = path.join(dir, "daemon-result.json");
  const infoFile = path.join(dir, "parent-info.json");
  const marker = path.join(dir, "daemon-marker.txt");
  const logFile = path.join(dir, "daemon.log");

  // runner：经生产 spawnDetachedDaemon 启动 linger daemon，把结果写给测试。
  const runner = write(
    dir,
    "parent-death-runner.mts",
    [
      `import fs from "node:fs";`,
      `import { buildDaemonEnv, spawnDetachedDaemon } from ${JSON.stringify(
        path
          .relative(dir, path.resolve("src/process/daemon-spawn.js"))
          .split(path.sep)
          .join("/"),
      )};`,
      `const [resultFile, daemonScript, marker, logFile, helperPath] = process.argv.slice(2);`,
      `const result = await spawnDetachedDaemon({`,
      `  cmd: process.execPath,`,
      `  args: [daemonScript, marker],`,
      `  logFile,`,
      `  env: buildDaemonEnv(process.env),`,
      `  ...(helperPath ? { helperPath } : {}),`,
      `});`,
      `fs.writeFileSync(resultFile, JSON.stringify(result));`,
    ].join("\n"),
  );
  const daemonScript = write(
    dir,
    "daemon.mjs",
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(process.argv[2], "alive");`,
      `setTimeout(() => {}, 60_000);`,
    ].join("\n"),
  );
  const runnerCmd = [
    process.execPath,
    "--import",
    "tsx",
    runner,
    resultFile,
    daemonScript,
    marker,
    logFile,
    ...(helperPath ? [helperPath] : []),
  ];
  const fixture = path.resolve("tests/fixtures/daemon_parent_death_parent.py");

  const parent = spawn(resolveDaemonSpawnPython(), [fixture, JSON.stringify(runnerCmd), infoFile, "90"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const parentStderr: string[] = [];
  parent.stderr?.on("data", (chunk) => parentStderr.push(String(chunk)));
  const parentStderrText = (): string => parentStderr.join("");

  await waitForFile(infoFile, 60_000);
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8")) as ParentDeathOutcome["info"];
  expect(info.runnerCode, `parent stderr: ${parentStderrText()}`).toBe(0);

  const spawned = JSON.parse(fs.readFileSync(resultFile, "utf8")) as ParentDeathOutcome["spawned"];

  try {
    // daemon 必须真正执行（marker 落盘）。
    await waitForFile(marker, 30_000);

    // 父死亡：taskkill /T /F 全树击杀。kill-on-close Job 在沙箱环境无法自建
    // （kernel 对 Job 内/breakaway/WMI relay 调用者一律拒绝
    // SetInformationJobObject(KILL_ON_JOB_CLOSE)，实测 ERROR_INVALID_PARAMETER），
    // 树杀是另一个文档化的杀伤向量（daemon.ts 注释："Windows 下还需脱离
    // Job（kill-on-close）与 taskkill /T 父链"）。
    const killed = spawnSync("taskkill", ["/T", "/F", "/PID", String(info.parentPid)], {
      windowsHide: true,
      encoding: "utf8",
    });
    expect(killed.status, `taskkill stderr: ${killed.stderr}`).toBe(0);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`parent 未在 10s 内退出；stderr: ${parentStderrText()}`)), 10_000);
      parent.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // canary（未逃生，仍在树内）必须被树杀杀死——证明击杀确实生效。
    await pollUntil(() => !isPidAlive(info.canaryPid), 10_000, "canary 未被树杀杀死");

    // daemon 存活，且并非父死亡瞬时竞态假象。
    expect(isPidAlive(spawned.pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(isPidAlive(spawned.pid)).toBe(true);

    // daemon 仍存活时的额外断言窗口（如 Job 成员不变量探测）。
    onAlive?.(spawned);

    // 安全收尾：终止 sacrificial daemon 并确认停止。
    expect(() => process.kill(spawned.pid)).not.toThrow();
    await pollUntil(() => !isPidAlive(spawned.pid), 10_000, "daemon 未被终止");
  } finally {
    // leak-safe：sacrificial daemon PID 一旦已知，任何失败路径（taskkill/断言/
    // 探测失败）都在此 best-effort 终止（不用 expect，避免掩盖原始错误），
    // 绝不让 detached daemon 泄漏到后续 suite。
    if (isPidAlive(spawned.pid)) {
      try {
        process.kill(spawned.pid);
      } catch {
        // best-effort
      }
      const deadline = Date.now() + 10_000;
      while (isPidAlive(spawned.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (isPidAlive(spawned.pid)) {
        try {
          spawnSync("taskkill", ["/F", "/PID", String(spawned.pid)], {
            windowsHide: true,
            encoding: "utf8",
          });
        } catch {
          // best-effort
        }
      }
    }
  }

  return { spawned, info, parentStderr: parentStderrText() };
}

/**
 * Job 逃生不变量探测：daemon 不在任何 Job 内（IsProcessInJob(daemon) ===
 * false），任何祖先 kill-on-close Job 都无法波及——kernel 可证的 escape
 * 证据，仅对 WMI relay 路径断言（本沙箱会把 breakaway 后的 node.exe 重新
 * 纳入宿主管理 Job，属于环境伪影，不代表生产语义）。
 */
function probeJobMembership(pid: number): { ok: boolean; inJob: boolean } {
  const membershipProbe = path.resolve("tests/fixtures/daemon_job_membership_probe.py");
  const probe = spawnSync(resolveDaemonSpawnPython(), [membershipProbe, String(pid)], {
    windowsHide: true,
    encoding: "utf8",
  });
  expect(probe.status, `probe stdout: ${probe.stdout} stderr: ${probe.stderr}`).toBe(0);
  return JSON.parse(probe.stdout) as { ok: boolean; inJob: boolean };
}

const windowsTests = describe.skipIf(process.platform !== "win32");

windowsTests("daemon survives parent tree kill (R5f prework)", () => {
  it("自然路径：taskkill /T 全树击杀后 canary 死亡而 daemon 存活", async () => {
    const { spawned } = await runParentDeathE2E("daemon-parent-death");
    expect(["helper-breakaway", "helper-wmi"]).toContain(spawned.mode);
    expect(spawned.finalProcess).toMatchObject({ pid: spawned.pid, status: "identified" });
  }, 180_000);

  it("强制 WMI 路径：全树击杀后 daemon 存活且不在任何 Job 内（kernel 可证 Job 逃生）", async () => {
    const dir = tmp("daemon-forced-wmi-helper");
    const forcedHelper = writeForcedWmiHelper(dir);
    await runParentDeathE2E("daemon-parent-death-wmi", forcedHelper, (spawned) => {
      expect(spawned.mode).toBe("helper-wmi");
      expect(spawned.finalProcess).toMatchObject({ pid: spawned.pid, status: "identified", inAnyJob: false });
      // daemon 存活窗口内断言 kernel 不变量：不在任何 Job 内——任何祖先
      // kill-on-close Job 都杀不到它。
      const membership = probeJobMembership(spawned.pid);
      expect(membership.ok).toBe(true);
      expect(membership.inJob).toBe(false);
    });
  }, 180_000);
});
