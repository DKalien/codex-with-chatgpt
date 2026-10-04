import { defineConfig } from "vitest/config";

// 测试状态目录安全网已移入 tests/setup-state-dir.ts：每个测试文件 setup 时创建
// 全新的 ignored 沙箱（随机 UUID）并赋给 process.env.C2C_STATE_DIR；主进程不再
// 预先分配共享 fallback 目录（多 worker/多文件共享同一目录不安全）。
// 并行度不在配置中固化：完整回归门禁是 `pnpm test --maxWorkers=1 --testTimeout=90000`；
// 实验性并行走 `pnpm test:parallel`（有界 worker 数，未经独立审计不得作为门禁）。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    setupFiles: ["tests/setup-state-dir.ts"],
  },
});
