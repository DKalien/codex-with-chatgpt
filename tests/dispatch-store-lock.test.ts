import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutorDispatchError } from "../src/executor-control/dispatch-schema.js";
import {
  acquireExecutorDispatchLedgerLock,
  executorDispatchFile,
  readExecutorDispatchState,
  updateExecutorDispatchDetailed,
} from "../src/executor-control/dispatch-store.js";
import { isPidAlive } from "../src/process/daemon-spawn.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

// R5e dispatch ledger 事务锁 ownership（generation-numbered wx 仲裁协议）：
// 锁路径 `<base>.<gen>` 单调递增；唯一破坏性动作是 openSync(next, "wx") 原子仲裁，
// 无 rename、绝不 unlink 同代/更高代 → live owner 的锁不可能被他方移除/替换；
// stale（pid 确证死亡）才被更高代取代；live/未知 owner 一律 BUSY fail closed；
// commit 点 recheck（own-gen nonce + 更高代缺席）保证同一 previous revision
// 最多一个 durable commit；成功 mutation 后 cleanup/ownership 失败不伪装成功。

let stateDir: string;
const temporaryDirs: string[] = [];

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  while (temporaryDirs.length > 0) cleanup(temporaryDirs.pop()!);
  cleanup(stateDir);
  vi.restoreAllMocks();
});

const WS = "aabbccddeeff";
// strict schema 要求 nonce 为小写 UUID 格式。
const NONCE_STALE = "0a0b0c0d-0001-4c01-8001-000000000001";
const NONCE_REPLACEMENT = "0a0b0c0d-0002-4c02-8002-000000000002";
const NONCE_FRESH = "0a0b0c0d-0003-4c03-8003-000000000003";

function lockBase(): string {
  return `${executorDispatchFile(WS, stateDir)}.lock`;
}

function genPath(gen: number): string {
  return `${lockBase()}.${gen}`;
}

function writeLockPayload(payload: { pid: number; nonce: string }, gen: number = 1): string {
  const file = genPath(gen);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = `${JSON.stringify({ ...payload, createdAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(file, raw, { mode: 0o600 });
  return raw;
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  expect(exited.status).toBe(0);
  return exited.pid!;
}

function readLockNonce(file: string): string {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { nonce: string }).nonce;
}

/** 现存 generation 锁文件名（`.lock.<正整数>`）。 */
function lockResidues(): string[] {
  return fs
    .readdirSync(path.dirname(lockBase()))
    .filter((name) => /^aabbccddeeff\.json\.lock\.\d+$/.test(name))
    .sort();
}

function seedState(root: string): void {
  updateExecutorDispatchDetailed(WS, root, (state) => ({
    state: { version: 1, workspaceId: WS, workspaceRoot: root, revision: (state?.revision ?? 0) + 1, entries: [] },
    result: "seed",
  }), stateDir);
}

function expectLockBusy(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected EXECUTOR_DISPATCH_LOCK_BUSY");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorDispatchError);
    expect((error as { code?: string }).code).toBe("EXECUTOR_DISPATCH_LOCK_BUSY");
  }
}

function expectOwnershipLost(fn: () => unknown): unknown {
  try {
    fn();
    expect.unreachable("expected EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorDispatchError);
    expect((error as { code?: string }).code).toBe("EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST");
    return error;
  }
}

describe("dispatch ledger lock ownership（generation 仲裁，R5e）", () => {
  it("live owner 不可抢：二次 acquire BUSY 且当前代 payload 不变；release 后可重取", () => {
    const a = acquireExecutorDispatchLedgerLock(lockBase());
    expect(fs.existsSync(genPath(1))).toBe(true);
    const nonceA = readLockNonce(genPath(1));
    expectLockBusy(() => acquireExecutorDispatchLedgerLock(lockBase()));
    // BUSY 路径绝不替换/删除 live 锁。
    expect(readLockNonce(genPath(1))).toBe(nonceA);
    expect(a.release()).toMatchObject({ ownershipLost: false });
    expect(lockResidues()).toHaveLength(0);
    // 释放后可重新获取。
    const b = acquireExecutorDispatchLedgerLock(lockBase());
    expect(b.release()).toMatchObject({ ownershipLost: false });
  });

  it("dead-owner stale lock（pid 确证死亡）被更高代安全取代并清理", () => {
    const stale = deadPid();
    expect(isPidAlive(stale)).toBe(false);
    writeLockPayload({ pid: stale, nonce: NONCE_STALE }, 1);
    const handle = acquireExecutorDispatchLedgerLock(lockBase());
    // 取代成功：gen-2 为当前进程 payload，stale gen-1 已清理。
    expect(readLockNonce(genPath(2))).not.toBe(NONCE_STALE);
    expect(lockResidues()).toEqual(["aabbccddeeff.json.lock.2"]);
    expect(handle.release()).toMatchObject({ ownershipLost: false });
    expect(lockResidues()).toHaveLength(0);
  });

  it("live/未知 owner fail closed：live 或不可解析的当前代 → BUSY，文件原样保留", () => {
    writeLockPayload({ pid: process.pid, nonce: NONCE_REPLACEMENT }, 1);
    expectLockBusy(() => acquireExecutorDispatchLedgerLock(lockBase()));
    expect(readLockNonce(genPath(1))).toBe(NONCE_REPLACEMENT);
    // unreadable payload（未知 owner）同样 fail closed。
    fs.writeFileSync(genPath(1), "not-json\n", { mode: 0o600 });
    expectLockBusy(() => acquireExecutorDispatchLedgerLock(lockBase()));
    expect(fs.readFileSync(genPath(1), "utf8")).toBe("not-json\n");
    expect(lockResidues()).toEqual(["aabbccddeeff.json.lock.1"]);
  });

  it("并发 reclaimer 输掉 wx 仲裁：扫描只见 stale 代，gen 已被对方占据 → 重扫见 live → BUSY，对方锁逐字节完好", () => {
    const staleRaw = writeLockPayload({ pid: deadPid(), nonce: NONCE_STALE }, 1);
    // 对方（并发接管者）已创建 live gen-2；本方首次扫描被确定性欺骗为只看到 gen-1
    //（等价于本方读取发生在对方创建之前）。
    const replacementRaw = writeLockPayload({ pid: process.pid, nonce: NONCE_REPLACEMENT }, 2);
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => [path.basename(genPath(1))]);
    expectLockBusy(() => acquireExecutorDispatchLedgerLock(lockBase()));
    // wx(gen-2) EEXIST → 重扫发现 live gen-2 → BUSY：无 gen-3，双方锁都未被触碰。
    expect(fs.readFileSync(genPath(1), "utf8")).toBe(staleRaw);
    expect(fs.readFileSync(genPath(2), "utf8")).toBe(replacementRaw);
    expect(lockResidues()).toEqual(["aabbccddeeff.json.lock.1", "aabbccddeeff.json.lock.2"]);
  });

  it("verify PASS 后 authority 被更高代接管（注入最坏情况）→ commit 被拒：A 永不落盘，C 从 previous 读到唯一一次提交", () => {
    const root = makeTmpDir("dispatch-lock-root");
    temporaryDirs.push(root);
    seedState(root); // revision 1（其 gen-1 锁已随 release 清理 → A 的事务重新从 gen-1 起算）
    const caught = expectOwnershipLost(() =>
      updateExecutorDispatchDetailed(WS, root, (state) => {
        // A（gen-1）事务中：注入"协议违规"的更高代 gen-2（pid 已死，C 可接管）。
        // 这是旧 rename-takeover 协议下"B 搬走 A 锁 + C 获锁"的确定性等价物。
        writeLockPayload({ pid: deadPid(), nonce: NONCE_FRESH }, 2);
        expect(state?.revision).toBe(1);
        return {
          state: { version: 1, workspaceId: WS, workspaceRoot: root, revision: state!.revision + 1, entries: [] },
          result: "a-mutated",
        };
      }, stateDir),
    );
    // commit 点 recheck 发现更高代 → A 的 durable commit 被拒绝：revision 停留 1。
    expect((caught as Error).message).toContain("gen > 1");
    expect(readExecutorDispatchState(WS, stateDir)?.revision).toBe(1);
    // gen-2 仍在（A 的 release 只清自己的 gen-1）。
    expect(readLockNonce(genPath(2))).toBe(NONCE_FRESH);
    // C 接管：max=2（pid 死）→ gen-3 → 从 previous（revision 1）提交。
    updateExecutorDispatchDetailed(WS, root, (state) => ({
      state: { version: 1, workspaceId: WS, workspaceRoot: root, revision: state!.revision + 1, entries: [] },
      result: "c-commit",
    }), stateDir);
    // 最终 durable revision == 2：最多一个 durable commit 发生（A 的提交被永久拒绝）。
    expect(readExecutorDispatchState(WS, stateDir)?.revision).toBe(2);
    expect(lockResidues()).toHaveLength(0);
  });

  it("事务内 own-gen 被替换为 foreign nonce → commit 前 recheck 拒绝提交：mutation 不落盘 + 证据 nonce-mismatch", () => {
    const root = makeTmpDir("dispatch-lock-root");
    temporaryDirs.push(root);
    seedState(root);
    const caught = expectOwnershipLost(() =>
      updateExecutorDispatchDetailed(WS, root, (state) => {
        // own-gen（gen-1）被协议违规地覆盖为 foreign payload。
        writeLockPayload({ pid: process.pid, nonce: NONCE_REPLACEMENT }, 1);
        return {
          state: { version: 1, workspaceId: WS, workspaceRoot: root, revision: state!.revision + 1, entries: [] },
          result: "mutated",
        };
      }, stateDir),
    );
    // durable state 停留在 revision 1（单写者假设未被破坏）。
    expect(readExecutorDispatchState(WS, stateDir)?.revision).toBe(1);
    const evidence = caught as Error & {
      executorDispatchLockOwnershipLost?: boolean;
      executorDispatchLockOwnershipLostReason?: string;
    };
    expect(evidence.executorDispatchLockOwnershipLost).toBe(true);
    expect(evidence.executorDispatchLockOwnershipLostReason).toBe("nonce-mismatch");
    // foreign 锁未被 release 误删。
    expect(readLockNonce(genPath(1))).toBe(NONCE_REPLACEMENT);
    fs.rmSync(genPath(1), { force: true });
  });

  it("change 抛错 + release 无法证明归属（own-gen 被破坏）→ 原始错误为主错误并附加有界证据", () => {
    const root = makeTmpDir("dispatch-lock-root");
    temporaryDirs.push(root);
    seedState(root);
    const actionError = new Error("action failed");
    let caught: unknown;
    try {
      updateExecutorDispatchDetailed(WS, root, () => {
        writeLockPayload({ pid: process.pid, nonce: NONCE_REPLACEMENT }, 1);
        throw actionError;
      }, stateDir);
      expect.unreachable("expected change error");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(actionError);
    const evidence = actionError as Error & { executorDispatchLockOwnershipLost?: boolean; executorDispatchLockOwnershipLostReason?: string };
    expect(evidence.executorDispatchLockOwnershipLost).toBe(true);
    expect(evidence.executorDispatchLockOwnershipLostReason).toBe("nonce-mismatch");
    fs.rmSync(genPath(1), { force: true });
  });

  it("成功 mutation 后 cleanup 失败（unlink-failed）→ 抛 OWNERSHIP_LOST（不伪装成功）", () => {
    const root = makeTmpDir("dispatch-lock-root");
    temporaryDirs.push(root);
    seedState(root);
    // 确定性注入：release 的最终 unlink 抛 EPERM（等价真实 cleanup 失败）。
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("unlink blocked"), { code: "EPERM" });
    });
    expectOwnershipLost(() =>
      updateExecutorDispatchDetailed(WS, root, (state) => ({
        state: { version: 1, workspaceId: WS, workspaceRoot: root, revision: state!.revision + 1, entries: [] },
        result: "mutated",
      }), stateDir),
    );
    // cleanup 未完成 → A 的 gen-1 锁文件残留，但事务结果未被伪装为成功。
    expect(fs.existsSync(genPath(1))).toBe(true);
    fs.rmSync(genPath(1), { force: true });
  });

  it("lock payload strict schema：malformed-but-JSON（含 dead pid）一律 BUSY fail closed，绝不取代", () => {
    const iso = new Date().toISOString();
    const dead = deadPid();
    const variants: Array<[string, string]> = [
      ["extra key", JSON.stringify({ pid: dead, nonce: NONCE_STALE, createdAt: iso, extra: 1 })],
      ["missing nonce", JSON.stringify({ pid: dead, createdAt: iso })],
      ["missing createdAt", JSON.stringify({ pid: dead, nonce: NONCE_STALE })],
      ["pid=0", JSON.stringify({ pid: 0, nonce: NONCE_STALE, createdAt: iso })],
      ["pid 负数", JSON.stringify({ pid: -5, nonce: NONCE_STALE, createdAt: iso })],
      ["pid 浮点", JSON.stringify({ pid: 1.5, nonce: NONCE_STALE, createdAt: iso })],
      ["pid 字符串", JSON.stringify({ pid: String(dead), nonce: NONCE_STALE, createdAt: iso })],
      ["nonce 非 UUID", JSON.stringify({ pid: dead, nonce: "stale-nonce", createdAt: iso })],
      ["nonce 大写", JSON.stringify({ pid: dead, nonce: NONCE_STALE.toUpperCase(), createdAt: iso })],
      ["createdAt 非 canonical", JSON.stringify({ pid: dead, nonce: NONCE_STALE, createdAt: "2026-01-01T00:00:00Z" })],
      ["createdAt 乱码", JSON.stringify({ pid: dead, nonce: NONCE_STALE, createdAt: "not-a-date" })],
      ["JSON 数组", "[]"],
      ["JSON null", "null"],
      ["JSON 数字", "42"],
    ];
    for (const [name, raw] of variants) {
      fs.mkdirSync(path.dirname(genPath(1)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(genPath(1), `${raw}\n`, { mode: 0o600 });
      expectLockBusy(() => acquireExecutorDispatchLedgerLock(lockBase()));
      // fail closed：锁文件原样保留（未取代、未删除），也未创建任何更高代。
      expect(fs.readFileSync(genPath(1), "utf8"), name).toBe(`${raw}\n`);
      expect(lockResidues(), name).toEqual(["aabbccddeeff.json.lock.1"]);
      fs.rmSync(genPath(1), { force: true });
    }
  });
});
