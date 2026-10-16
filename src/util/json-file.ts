import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { C2CError } from "../errors.js";

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** ENOENT → fallback；内容损坏时报错而不是静默覆盖。 */
export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new C2CError("STATE_CORRUPT", `状态文件损坏：${file}`);
  }
}

/** 原子写入（临时文件 + rename），仅属主可读写。 */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ponytail: 超过 30s 的锁视为崩溃遗留直接删除；持锁操作必须是短的同步读改写。
function acquire(lockFile: string): number {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
      } catch { /* 锁刚被释放 */ }
      if (Date.now() > deadline) throw new C2CError("STATE_BUSY", `状态文件正被占用：${lockFile}`);
      sleepSync(25);
    }
  }
}

/** 进程间互斥的同步临界区。 */
export function withLock<T>(file: string, fn: () => T): T {
  const lockFile = `${file}.lock`;
  const fd = acquire(lockFile);
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}

/** 加锁读改写：fn 可直接修改 value，返回值透传。 */
export function updateJson<T, R>(file: string, fallback: T, fn: (value: T) => R): R {
  return withLock(file, () => {
    const value = readJson(file, fallback);
    const result = fn(value);
    writeJson(file, value);
    return result;
  });
}
