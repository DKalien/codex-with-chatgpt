import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

// 每个测试文件执行前的状态目录安全网：为本测试文件创建全新的 ignored 沙箱
// （随机 UUID，位于 <root>/.tooling/test-tmp，git 忽略），并赋给
// process.env.C2C_STATE_DIR。
// - 无条件覆盖：即使同一 worker 内前一个测试文件 delete 了该变量，本文件仍从
//   全新沙箱起步，兜底不可被前序文件击败；机器真实状态目录绝不会成为兜底目标。
// - 沙箱按文件隔离：不同测试文件（无论串行还是 test:parallel 多 worker）不共享
//   同一 fallback 目录。
// - 显式调用 isolateStateDir() 的测试继续按测试内语义覆盖（各自 cleanup）。
// - 文件级 afterAll 只清理本文件自己的沙箱（不触碰 isolateStateDir 的目录）。
const sandboxDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".tooling",
  "test-tmp",
  `state-sandbox-${randomUUID()}`,
);
fs.mkdirSync(sandboxDir, { recursive: true });
process.env.C2C_STATE_DIR = sandboxDir;

afterAll(() => {
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  } catch {
    // best effort；沙箱清理失败不影响测试结果
  }
});
