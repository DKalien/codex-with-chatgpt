import { cleanupStrict, fixtureProcessIdentity, stopFixtureProcess, type FixtureProcessIdentity } from "./strict-teardown.js";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTUP_LEASE_ENV } from "../src/core/startup-lease.js";
import {
  buildDaemonEnv,
  isPidAlive,
  resolveDaemonSpawnHelperPath,
  resolveDaemonSpawnPython,
  spawnDetachedDaemon,
} from "../src/process/daemon-spawn.js";
import { makeTmpDir, write } from "./helpers.js";

const temporaryDirs: string[] = [];
const fixtureProcesses: (FixtureProcessIdentity | null)[] = [];

afterEach(async () => {
  for (const identity of fixtureProcesses.splice(0)) await stopFixtureProcess(identity);
  await cleanupStrict(...temporaryDirs.splice(0));
});

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  temporaryDirs.push(dir);
  return dir;
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 ${file} 超时`);
}

function readLog(logFile: string): string {
  try {
    return fs.readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
}

describe("daemon spawn helpers", () => {
  it("resolveDaemonSpawnHelperPath 指向存在的 helper 脚本", () => {
    const helper = resolveDaemonSpawnHelperPath();
    expect(fs.existsSync(helper)).toBe(true);
    expect(helper.endsWith("daemon_spawn.py")).toBe(true);
  });

  it("isPidAlive：自身存活、已退出进程死亡", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeGreaterThan(0);
    expect(isPidAlive(exited.pid!)).toBe(false);
  });

  it("buildDaemonEnv：exact allowlist——sentinel secrets/任意 C2C_*/旧 lease 被排除，显式 C2C 配置与 OS/path 保留", () => {
    const parentEnv = {
      ...process.env,
      OPENAI_API_KEY: "SHOULD_NOT_LEAK",
      RANDOM_PRIVATE_TOKEN: "SHOULD_NOT_LEAK",
      CODEX_THREAD_ID: "SHOULD_NOT_LEAK",
      CODEX_SESSION_ID: "SHOULD_NOT_LEAK",
      SOME_UNKNOWN_PARENT_VAR: "SHOULD_NOT_LEAK",
      // exact allowlist：任意/未知 C2C_* 一律不投影（非前缀放行）。
      C2C_PRIVATE_TOKEN: "SHOULD_NOT_LEAK",
      C2C_RANDOM_SECRET: "SHOULD_NOT_LEAK",
      // 旧父进程 lease 绝不继承；fresh lease 由 daemon.ts 投影后注入。
      C2C_STARTUP_LEASE: "SHOULD_NOT_LEAK",
      // test-only receipt-finalizer 开关不传播到 daemon。
      C2C_RECEIPT_FINALIZER_NO_SPAWN: "SHOULD_NOT_LEAK",
      // 显式 allowlist 内的 C2C 配置保留。
      C2C_STATE_DIR: "state-dir-kept",
      C2C_LOG_LEVEL: "debug",
      C2C_ENABLE_FEEDBACK_PROBE: "1",
      C2C_ENABLE_WRITE_PROBE: "1",
      C2C_DESKTOP_PYTHON: "python-kept",
      C2C_DAEMON_PYTHON: "python-daemon-kept",
      C2C_DISABLE_RG: "0",
      C2C_RG_PATH: "rg-kept",
      C2C_CLOUDFLARED_PATH: "cf-kept",
      C2C_CODEX_EXECUTABLE: "codex-kept",
      // Bridge 实际读取的非 C2C 业务变量保留。
      TUNNEL_ORIGIN_CERT: "cert-kept",
      CODEX_HOME: "codex-home-kept",
      PATH: process.env.PATH ?? "",
    } as NodeJS.ProcessEnv;
    const projected = buildDaemonEnv(parentEnv);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    for (const key of [
      "OPENAI_API_KEY",
      "RANDOM_PRIVATE_TOKEN",
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "SOME_UNKNOWN_PARENT_VAR",
      "C2C_PRIVATE_TOKEN",
      "C2C_RANDOM_SECRET",
      "C2C_STARTUP_LEASE",
      "C2C_RECEIPT_FINALIZER_NO_SPAWN",
    ]) {
      expect(projected[key]).toBeUndefined();
    }
    expect(projected).toMatchObject({
      C2C_STATE_DIR: "state-dir-kept",
      C2C_LOG_LEVEL: "debug",
      C2C_ENABLE_FEEDBACK_PROBE: "1",
      C2C_ENABLE_WRITE_PROBE: "1",
      C2C_DESKTOP_PYTHON: "python-kept",
      C2C_DAEMON_PYTHON: "python-daemon-kept",
      C2C_DISABLE_RG: "0",
      C2C_RG_PATH: "rg-kept",
      C2C_CLOUDFLARED_PATH: "cf-kept",
      C2C_CODEX_EXECUTABLE: "codex-kept",
      TUNNEL_ORIGIN_CERT: "cert-kept",
      CODEX_HOME: "codex-home-kept",
    });
    expect(projected.PATH).toBe(process.env.PATH ?? "");
    // undefined 值不产生空条目。
    expect(Object.values(projected).every((value) => value !== undefined)).toBe(true);
  });

  it("buildDaemonEnv：旧 lease 不投影，投影后注入的 fresh startup lease 存活到 daemon env", () => {
    // 复刻 daemon.ts 的注入顺序：buildDaemonEnv 投影 → 显式注入 fresh lease。
    const projected = buildDaemonEnv({
      ...process.env,
      C2C_STATE_DIR: "state-dir-kept",
      C2C_STARTUP_LEASE: "STALE_PARENT_LEASE_SHOULD_NOT_SURVIVE",
    } as NodeJS.ProcessEnv);
    expect(projected[STARTUP_LEASE_ENV]).toBeUndefined();
    const env = { ...projected, [STARTUP_LEASE_ENV]: "fresh-lease-value" };
    expect(env[STARTUP_LEASE_ENV]).toBe("fresh-lease-value");
    expect(env.C2C_STARTUP_LEASE).toBe("fresh-lease-value");
    expect(env.C2C_STATE_DIR).toBe("state-dir-kept");
  });

  it("buildDaemonEnv：POSIX 平台按精确 allowlist + XDG_ 前缀投影", () => {
    const projected = buildDaemonEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      SHELL: "/bin/sh",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      XDG_CONFIG_HOME: "/xdg/config",
      SYSTEMROOT: "C:\\WINDOWS", // Windows 专属变量不得进入 POSIX 投影
      OPENAI_API_KEY: "SHOULD_NOT_LEAK",
    }, "linux");
    expect(projected).toMatchObject({ PATH: "/usr/bin", HOME: "/home/u", SHELL: "/bin/sh", LANG: "C.UTF-8", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/xdg/config" });
    expect(projected.SYSTEMROOT).toBeUndefined();
    expect(projected.OPENAI_API_KEY).toBeUndefined();
  });

  it("注入非 Windows 平台时直接 detached spawn 并写日志", async () => {
    const dir = tmp("daemon-direct");
    const marker = path.join(dir, "marker.txt");
    const logFile = path.join(dir, "daemon.log");
    const script = write(
      dir,
      "daemon.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "direct-ok");\n'
    );
    const result = await spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, marker],
      logFile,
      env: { ...process.env },
      platform: "linux",
    });
    fixtureProcesses.push(fixtureProcessIdentity(result.finalProcess));
    expect(result.mode).toBe("posix");
    expect(result.finalProcess.pid).toBe(result.pid);
    expect(result.spawner.pid).toBe(process.pid);
    expect(result.helperInJob).toBeNull();
    await waitForFile(marker);
    expect(fs.readFileSync(marker, "utf8")).toBe("direct-ok");
  });
});

const windowsTests = describe.skipIf(process.platform !== "win32");

windowsTests("daemon spawn Windows Job escape", () => {
  it("helper 为 null 时 fail closed（无法证明不在 Job 内）；显式逃生阀才允许 direct", async () => {
    const dir = tmp("daemon-fallback");
    const logFile = path.join(dir, "daemon.log");
    const script = write(dir, "daemon.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "direct-ok");\n');
    // 默认：fail closed，不得静默降级为注定被杀死的 direct daemon。
    await expect(spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, path.join(dir, "marker-should-not-exist.txt")],
      logFile,
      env: { ...process.env },
      helperPath: null,
    })).rejects.toThrow("拒绝无独立性的 direct fallback");
    expect(fs.existsSync(path.join(dir, "marker-should-not-exist.txt"))).toBe(false);
    // 显式逃生阀：恢复历史 direct 行为（不声称 lifetime independence）。
    const marker = path.join(dir, "marker.txt");
    const result = await spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, marker],
      logFile,
      env: { ...process.env },
      helperPath: null,
      allowUnprovenDirectFallback: true,
    });
    fixtureProcesses.push(fixtureProcessIdentity(result.finalProcess));
    expect(result.mode).toBe("direct");
    await waitForFile(marker);
    expect(readLog(logFile)).toContain("allowUnprovenDirectFallback");
  }, 60_000);

  it("helper 输出无效 JSON 时结果未知，显式逃生阀也不能重发", async () => {
    const dir = tmp("daemon-garbage-helper");
    const marker = path.join(dir, "marker-should-not-exist.txt");
    const fakeHelper = write(dir, "garbage-helper.py", "import sys; sys.stdout.write('not json\\n')\n");
    for (const allowUnprovenDirectFallback of [false, true]) {
      const spawnImpl = vi.fn(spawn);
      await expect(spawnDetachedDaemon({
        cmd: process.execPath, args: ["-e", ""], logFile: path.join(dir, "daemon.log"),
        env: { ...process.env }, helperPath: fakeHelper, spawnImpl, allowUnprovenDirectFallback,
      })).rejects.toThrow("禁止重发");
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    }
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it.each([true, null, "missing"])("helper 报成功但最终 Job 证据为 %s 时拒绝且只启动一次", async (inAnyJob) => {
    const dir = tmp("daemon-unproven-final");
    const payload = { ok: true, pid: 321, mode: "breakaway", in_job: false, final_probe: {
      pid: 321, status: "identified", executable: process.execPath, creationTime: "12345",
      inAnyJob, observedAt: new Date().toISOString(),
      errors: { process: null, executable: null, creationTime: null, inAnyJob: null },
    } };
    const fakeHelper = write(dir, "unproven-helper.py", `print(${JSON.stringify(JSON.stringify(payload))})\n`);
    const spawnImpl = vi.fn(spawn);
    await expect(spawnDetachedDaemon({ cmd: process.execPath, args: ["-e", ""],
      logFile: path.join(dir, "daemon.log"), env: { ...process.env }, helperPath: fakeHelper,
      spawnImpl, allowUnprovenDirectFallback: true,
    })).rejects.toThrow("禁止重发");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("helper 已开始创建但丢失 ACK 时，即使 in_job=false 也不得 fallback", async () => {
    const dir = tmp("daemon-unknown-start");
    const payload = { ok: false, in_job: false, spawn_started: true };
    const fakeHelper = write(dir, "unknown-helper.py", `print(${JSON.stringify(JSON.stringify(payload))})\n`);
    const spawnImpl = vi.fn(spawn);
    await expect(spawnDetachedDaemon({ cmd: process.execPath, args: ["-e", ""],
      logFile: path.join(dir, "daemon.log"), env: { ...process.env }, helperPath: fakeHelper,
      spawnImpl, allowUnprovenDirectFallback: true,
    })).rejects.toThrow("禁止重发");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("helper 超时（in_job 未知）时杀掉 helper 并 fail closed", async () => {
    const dir = tmp("daemon-slow-helper");
    const logFile = path.join(dir, "daemon.log");
    const script = write(dir, "daemon.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "direct-ok");\n');
    const slowHelper = write(dir, "slow-helper.py", "import time; time.sleep(30)\n");
    await expect(spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, path.join(dir, "marker-should-not-exist.txt")],
      logFile,
      env: { ...process.env },
      helperPath: slowHelper,
      helperTimeoutMs: 500,
      allowUnprovenDirectFallback: true,
    })).rejects.toThrow("禁止重发");
    expect(fs.existsSync(path.join(dir, "marker-should-not-exist.txt"))).toBe(false);
  }, 60_000);

  it("helper 失败但 in_job=false（证明不在 Job 内）→ 允许 direct fallback", async () => {
    const dir = tmp("daemon-not-in-job");
    const marker = path.join(dir, "marker.txt");
    const logFile = path.join(dir, "daemon.log");
    const script = write(dir, "daemon.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "direct-ok");\n');
    const fakeHelper = write(
      dir,
      "not-in-job-helper.py",
      "import sys, json; sys.stdout.write(json.dumps({'ok': False, 'code': 'spawn_failed', 'message': 'boom', 'in_job': False}) + '\\n')\n",
    );
    const result = await spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, marker],
      logFile,
      env: { ...process.env },
      helperPath: fakeHelper,
    });
    fixtureProcesses.push(fixtureProcessIdentity(result.finalProcess));
    expect(result.mode).toBe("direct");
    await waitForFile(marker);
    expect(readLog(logFile)).toContain("in_job=false");
  }, 60_000);

  it("helper 失败且 in_job=true（在 Job 内）→ fail closed", async () => {
    const dir = tmp("daemon-in-job");
    const logFile = path.join(dir, "daemon.log");
    const script = write(dir, "daemon.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "direct-ok");\n');
    const fakeHelper = write(
      dir,
      "in-job-helper.py",
      "import sys, json; sys.stdout.write(json.dumps({'ok': False, 'code': 'spawn_failed', 'message': 'boom', 'in_job': True}) + '\\n')\n",
    );
    await expect(spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, path.join(dir, "marker-should-not-exist.txt")],
      logFile,
      env: { ...process.env },
      helperPath: fakeHelper,
    })).rejects.toThrow("in_job=true");
    expect(fs.existsSync(path.join(dir, "marker-should-not-exist.txt"))).toBe(false);
  }, 60_000);

  it("真实 helper 在 Windows 上 spawn 独立 daemon（breakaway 或 WMI relay）", async () => {
    const dir = tmp("daemon-helper-live");
    const marker = path.join(dir, "marker.txt");
    const logFile = path.join(dir, "daemon.log");
    const script = write(
      dir,
      "daemon.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], process.env.C2C_DAEMON_TEST_MARKER ?? "missing");',
        'setTimeout(() => {}, 5000);',
      ].join("\n")
    );
    const result = await spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, marker],
      logFile,
      env: { ...process.env, C2C_DAEMON_TEST_MARKER: "env-ok" },
    });
    fixtureProcesses.push(fixtureProcessIdentity(result.finalProcess));
    expect(["helper-breakaway", "helper-wmi"]).toContain(result.mode);
    expect(result.spawnAttemptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.finalProcess).toMatchObject({ pid: result.pid, status: "identified" });
    expect(result.finalProcess.executable?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(result.finalProcess.creationTime).toMatch(/^[0-9]+$/);
    expect(result.finalProcess.inAnyJob).toBe(false);
    expect(typeof result.helperInJob).toBe("boolean");
    expect(result.spawner).toMatchObject({ pid: process.pid, status: "identified" });
    await waitForFile(marker, 30_000);
    expect(fs.readFileSync(marker, "utf8")).toBe("env-ok");
    expect(isPidAlive(result.pid)).toBe(true);
  }, 90_000);

  it("真实 helper 协议：in_job 是确定性 boolean（伪句柄截断回归）", () => {
    // 回归：_detect_in_job 曾用 ctypes 默认 int restype 接 GetCurrentProcess()
    // 伪句柄（-1），32 位截断令 IsProcessInJob 静默失败、in_job 恒为 null，
    // 使 Node 侧 fail-closed 策略（in_job === false 才允许 direct fallback）
    // 永远拿不到确定性证据。这里直调真实 helper 并断言 in_job 为 boolean。
    const dir = tmp("daemon-helper-in-job");
    const logFile = path.join(dir, "daemon.log");
    const envFile = path.join(dir, "env.json");
    write(dir, "env.json", JSON.stringify({ PATH: process.env.PATH ?? "" }));
    const script = write(dir, "daemon.mjs", 'setTimeout(() => {}, 1000);\n');
    const helper = resolveDaemonSpawnHelperPath();
    const proc = spawnSync(
      resolveDaemonSpawnPython(),
      [
        "-I", "-B", "-X", "utf8", helper,
        "--log", logFile,
        "--env-file", envFile,
        "--cwd", process.cwd(),
        "--", process.execPath, script,
      ],
      { encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
    expect(proc.status, `helper stderr: ${proc.stderr}`).toBe(0);
    const line = proc.stdout.trim().split("\n").filter(Boolean).pop();
    expect(line).toBeTruthy();
    const payload = JSON.parse(line!) as { ok: boolean; pid: number; mode: string; in_job?: boolean | null; final_probe: unknown };
    if (payload.ok) fixtureProcesses.push(fixtureProcessIdentity(payload.final_probe));
    expect(payload.ok).toBe(true);
    expect(["breakaway", "wmi"]).toContain(payload.mode);
    // 沙箱/CI 常把进程放进 Job（true）；普通桌面 shell 则为 false——但绝不
    // 允许退回 null（探测失效）。
    expect(typeof payload.in_job).toBe("boolean");
  }, 90_000);

  it("DAEMON_ENV_SANITIZATION：sentinel 经真实 helper 到达 daemon 的 env 不泄漏，exact allowlist C2C 配置/PATH 保留", async () => {
    const dir = tmp("daemon-env-projection");
    const marker = path.join(dir, "env-dump.json");
    const logFile = path.join(dir, "daemon.log");
    const script = write(
      dir,
      "daemon.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], JSON.stringify(process.env));',
        'setTimeout(() => {}, 5000);',
      ].join("\n")
    );
    const result = await spawnDetachedDaemon({
      cmd: process.execPath,
      args: [script, marker],
      logFile,
      // 模拟 daemon.ts 生产接线：完整父 env 先投影再交接。
      env: buildDaemonEnv({
        ...process.env,
        OPENAI_API_KEY: "SHOULD_NOT_LEAK",
        RANDOM_PRIVATE_TOKEN: "SHOULD_NOT_LEAK",
        CODEX_THREAD_ID: "SHOULD_NOT_LEAK",
        CODEX_SESSION_ID: "SHOULD_NOT_LEAK",
        // exact allowlist：任意/未知 C2C_* 不再放行（E）。
        C2C_DAEMON_TEST_PROJECTION: "SHOULD_NOT_LEAK",
        // 显式 allowlist 内的 C2C 配置经真实 helper 存活到 daemon env。
        C2C_LOG_LEVEL: "c2c-log-kept",
      }),
    });
    fixtureProcesses.push(fixtureProcessIdentity(result.finalProcess));
    expect(["helper-breakaway", "helper-wmi"]).toContain(result.mode);
    await waitForFile(marker, 30_000);
    const dumped = fs.readFileSync(marker, "utf8");
    // handoff payload（= daemon 实际 env）不得包含任何 sentinel。
    expect(dumped).not.toContain("SHOULD_NOT_LEAK");
    expect(dumped).not.toContain("OPENAI_API_KEY");
    expect(dumped).not.toContain("RANDOM_PRIVATE_TOKEN");
    expect(dumped).not.toContain("CODEX_THREAD_ID");
    expect(dumped).not.toContain("CODEX_SESSION_ID");
    const daemonEnv = JSON.parse(dumped) as Record<string, string>;
    // 任意 C2C_* 已被 exact allowlist 排除；显式配置保留。
    expect(daemonEnv.C2C_DAEMON_TEST_PROJECTION).toBeUndefined();
    expect(daemonEnv.C2C_LOG_LEVEL).toBe("c2c-log-kept");
    expect(daemonEnv.PATH).toBeTruthy();
    expect(isPidAlive(result.pid)).toBe(true);
  }, 90_000);
});
