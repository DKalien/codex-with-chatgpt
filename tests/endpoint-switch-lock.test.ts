import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEndpointSwitchLock,
  endpointSwitchLockFile,
  EndpointSwitchLockError,
  withEndpointSwitchLock,
} from "../src/endpoint-switch/lock.js";
import type { EndpointSwitchLockHandle } from "../src/endpoint-switch/lock.js";
import { cleanup, isolateStateDir } from "./helpers.js";

// C：switch lock ownership 必须真实——release 凭随机 nonce 校验当前锁路径，
// 只删除仍归本 handle 所有的锁文件；missing/replaced 绝不删替代锁，且以
// bounded ownership-lost 结果上报（绝不抛错掩盖主结果/主错误）。

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  cleanup(stateDir);
});

const WS = "aabbccddeeff";

function expectLockBusy(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected ENDPOINT_SWITCH_LOCK_BUSY");
  } catch (error) {
    expect(error).toBeInstanceOf(EndpointSwitchLockError);
    expect((error as { code?: string }).code).toBe("ENDPOINT_SWITCH_LOCK_BUSY");
  }
}

function expectOwnershipLost(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST");
  } catch (error) {
    expect(error).toBeInstanceOf(EndpointSwitchLockError);
    expect((error as { code?: string }).code).toBe("ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST");
  }
}

interface OwnershipLossEvidence {
  endpointSwitchOwnershipLost?: boolean;
  endpointSwitchOwnershipLostReason?: string;
}

for (const domain of ["executor", "web-sink"] as const) {
  describe(`endpoint switch lock ownership（${domain} 域）`, () => {
    it("A 释放失去归属的锁时绝不删除 B 的替代锁；B 释放后 C 才能获取", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      const a = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(fs.existsSync(file)).toBe(true);
      // 锁 payload 携带随机 nonce ownership token。
      const payloadA = JSON.parse(fs.readFileSync(file, "utf8")) as { nonce?: string; domain: string; pid: number };
      expect(payloadA.nonce).toBeTruthy();
      expect(payloadA.domain).toBe(domain);
      expect(payloadA.pid).toBe(process.pid);
      // 手动移除 A 的锁文件（stale owner 丢失文件）。
      fs.rmSync(file);
      // B 获取替代锁。
      const b = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(fs.existsSync(file)).toBe(true);
      // A.release()：当前路径携带的是 B 的 nonce → ownership lost，绝不删除 B 的锁。
      expect(a.release()).toMatchObject({ ownershipLost: true, reason: "nonce-mismatch" });
      expect(fs.existsSync(file)).toBe(true);
      // C 获取仍 LOCK_BUSY（B 的锁未被 A 误删）。
      expectLockBusy(() => acquireEndpointSwitchLock(domain, WS, stateDir));
      // B 正常释放 → 删除自己的锁 → C 可获取。
      expect(b.release()).toMatchObject({ ownershipLost: false });
      expect(fs.existsSync(file)).toBe(false);
      const c = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(c.release()).toMatchObject({ ownershipLost: false });
    });

    it("锁文件 missing 时 release 上报 ownership-lost(missing) 且不抛错；二次 release 幂等", () => {
      const a = acquireEndpointSwitchLock(domain, WS, stateDir);
      fs.rmSync(endpointSwitchLockFile(domain, WS, stateDir));
      let outcome: { ownershipLost: boolean; reason?: string } | undefined;
      expect(() => {
        outcome = a.release();
      }).not.toThrow();
      expect(outcome).toMatchObject({ ownershipLost: true, reason: "missing" });
      // 二次 release 幂等且不抛错。
      expect(() => a.release()).not.toThrow();
      // 锁路径可用（A 未删除任何替代文件）。
      const again = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(again.release()).toMatchObject({ ownershipLost: false });
    });

    it("withEndpointSwitchLock：fn 成功但锁被替代 → ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST，绝不删除替代锁", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      let replacement: EndpointSwitchLockHandle | undefined;
      expectOwnershipLost(() =>
        withEndpointSwitchLock(domain, WS, () => {
          // 锁内强制归属丢失：移除本 handle 的锁文件，让 B 取得替代锁。
          fs.rmSync(file);
          replacement = acquireEndpointSwitchLock(domain, WS, stateDir);
          return "mutation-done";
        }, stateDir),
      );
      // 成功 mutation 不得在归属丢失后静默返回（wrapper 已抛错，见上）。
      // 替代锁未被误删；C 仍 LOCK_BUSY；B 正常释放后 C 才能获取。
      expect(fs.existsSync(file)).toBe(true);
      expectLockBusy(() => acquireEndpointSwitchLock(domain, WS, stateDir));
      expect(replacement!.release()).toMatchObject({ ownershipLost: false });
      const c = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(c.release()).toMatchObject({ ownershipLost: false });
    });

    it("withEndpointSwitchLock：fn 成功但锁文件 missing → ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      expectOwnershipLost(() =>
        withEndpointSwitchLock(domain, WS, () => {
          fs.rmSync(file);
        }, stateDir),
      );
      // 锁路径可重新获取。
      const next = acquireEndpointSwitchLock(domain, WS, stateDir);
      expect(next.release()).toMatchObject({ ownershipLost: false });
    });

    it("withEndpointSwitchLock：fn 抛错且归属丢失 → 原始错误为主错误并附加有界 ownership 证据", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      const actionError = new Error("action failed");
      let caught: unknown;
      try {
        withEndpointSwitchLock(domain, WS, () => {
          fs.rmSync(file); // 强制 ownership loss（missing）
          throw actionError;
        }, stateDir);
        expect.unreachable("expected fn error");
      } catch (error) {
        caught = error;
      }
      // 原始错误对象原样传播，绝不被替换。
      expect(caught).toBe(actionError);
      const evidence = actionError as Error & OwnershipLossEvidence;
      expect(evidence.endpointSwitchOwnershipLost).toBe(true);
      expect(evidence.endpointSwitchOwnershipLostReason).toBe("missing");
    });

    it("withEndpointSwitchLock：fn 抛错且归属正常 → 原始错误传播、无 ownership 附加证据", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      const actionError = new Error("action failed");
      let caught: unknown;
      try {
        withEndpointSwitchLock(domain, WS, () => {
          throw actionError;
        }, stateDir);
        expect.unreachable("expected fn error");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(actionError);
      expect(fs.existsSync(file)).toBe(false);
      expect(actionError as Error & OwnershipLossEvidence).not.toHaveProperty("endpointSwitchOwnershipLost");
    });

    it("withEndpointSwitchLock：正常 release → fn 结果原样返回、锁文件清理", () => {
      const file = endpointSwitchLockFile(domain, WS, stateDir);
      const value = withEndpointSwitchLock(domain, WS, () => "ok", stateDir);
      expect(value).toBe("ok");
      expect(fs.existsSync(file)).toBe(false);
    });
  });
}
