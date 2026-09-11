import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("Python helper 离线协议与安全门禁（不连接真实 Desktop）", () => {
  const result = spawnSync(process.env.C2C_DESKTOP_PYTHON || "python", [
    "-I", "-B", "-X", "utf8", "-m", "unittest", "discover", "-s", "tests", "-p", "desktop*_test.py", "-v",
  ], { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
  expect(result.error, "需要 Python 3.11+；可通过 C2C_DESKTOP_PYTHON 指定解释器").toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stderr).toContain("OK");
});
