import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const python = process.env.C2C_DESKTOP_PYTHON || "python";
const helperFiles = [
  "desktop_ipc.py",
  "c2c_desktop_ipc/__init__.py",
  "c2c_desktop_ipc/common.py",
  "c2c_desktop_ipc/dispatch.py",
  "c2c_desktop_ipc/history.py",
  "c2c_desktop_ipc/identity.py",
  "c2c_desktop_ipc/operations.py",
  "c2c_desktop_ipc/reconciliation.py",
  "c2c_desktop_ipc/result.py",
  "c2c_desktop_ipc/transport.py",
];

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
    const packagedFiles = [];
    const visit = (directory, prefix = "") => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name).replaceAll(path.sep, "/");
        if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
        else packagedFiles.push(relative);
      }
    };
    visit(destination);
    expect(packagedFiles.sort()).toEqual([...helperFiles].sort());
    for (const relative of helperFiles) {
      expect(fs.readFileSync(path.join(destination, relative))).toEqual(
        fs.readFileSync(path.join(root, "src", "desktop", "helper", relative)),
      );
    }
    expect(fs.existsSync(path.join(destination, "desktop_profiles.json"))).toBe(false);

    const probe = [
      "import importlib.util, pathlib, sys, types",
      "helper = pathlib.Path(sys.argv[1]).resolve()",
      "stale = types.ModuleType('c2c_desktop_ipc')",
      "stale.__file__ = None",
      "sys.modules['c2c_desktop_ipc'] = stale",
      "sys.modules['c2c_desktop_ipc.common'] = types.ModuleType('c2c_desktop_ipc.common')",
      "spec = importlib.util.spec_from_file_location('desktop_ipc_probe', helper)",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules['desktop_ipc_probe'] = module",
      "spec.loader.exec_module(module)",
      "assert pathlib.Path(module._PACKAGE.__file__).resolve() == helper.parent / 'c2c_desktop_ipc' / '__init__.py'",
      "assert pathlib.Path(sys.modules['c2c_desktop_ipc.common'].__file__).resolve() == helper.parent / 'c2c_desktop_ipc' / 'common.py'",
      "h = module",
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
