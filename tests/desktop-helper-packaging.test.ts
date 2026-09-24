import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const python = process.env.C2C_DESKTOP_PYTHON || "python";

describe("Desktop helper packaging", () => {
  it("clean build 后 helper 唯一副本随 build 复制到 dist，runtime compatibility catalog 不再存在", () => {
    const dist = path.join(root, "dist");
    const destination = path.join(dist, "desktop", "helper");
    fs.rmSync(dist, { recursive: true, force: true });
    const buildCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "sh";
    const buildArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm run build"]
      : ["-c", "pnpm run build"];
    execFileSync(buildCommand, buildArgs, {
      cwd: root,
      windowsHide: true,
    });
    expect(fs.readFileSync(path.join(destination, "desktop_ipc.py"))).toEqual(
      fs.readFileSync(path.join(root, "src", "desktop", "helper", "desktop_ipc.py")),
    );
    expect(fs.existsSync(path.join(destination, "desktop_profiles.json"))).toBe(false);

    const probe = [
      "import pathlib, sys",
      "helper = pathlib.Path(sys.argv[1]).resolve()",
      "sys.path.insert(0, str(helper.parent))",
      "import desktop_ipc as h",
      "legacy = [name for name in ('VERIFIED_PROFILES', 'PROFILE_CATALOG_PATH',",
      "    '_compatibility_audit_for_paths', '_checked_runtime',",
      "    '_observe_runtime_versions', '_asar_audit_modules') if hasattr(h, name)]",
      "print(legacy)",
    ].join("\n");
    const result = execFileSync(
      python,
      ["-I", "-B", "-X", "utf8", "-c", probe, path.join(destination, "desktop_ipc.py")],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    expect(result.trim()).toBe("[]");
  });
});
