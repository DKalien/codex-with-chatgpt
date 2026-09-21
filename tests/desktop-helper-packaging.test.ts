import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const python = process.env.C2C_DESKTOP_PYTHON || "python";
const expectedRuntimePairs = [
  ["26.903.9818.0", "0.153.4"],
  ["26.908.4834.0", "0.154.0-alpha.6.2"],
  ["26.908.9136.0", "0.154.0-alpha.6.2"],
  ["26.915.4065.0", "0.155.0-alpha.9.2"],
];

describe("Desktop helper packaging", () => {
  it("clean build 后 helper 从相邻 catalog 加载 4 个 exact runtime", () => {
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
    for (const file of ["desktop_ipc.py", "desktop_profiles.json"]) {
      expect(fs.readFileSync(path.join(destination, file))).toEqual(
        fs.readFileSync(path.join(root, "src", "desktop", "helper", file)),
      );
    }

    const probe = [
      "import json, pathlib, sys",
      "helper = pathlib.Path(sys.argv[1]).resolve()",
      "sys.path.insert(0, str(helper.parent))",
      "import desktop_ipc as h",
      "print(json.dumps({",
      "  'catalog': str(h.PROFILE_CATALOG_PATH.resolve()),",
      "  'runtimes': [[r['desktopVersion'], r['appServerVersion']] for rs in h.VERIFIED_PROFILES.values() for r in rs],",
      "}))",
    ].join("\n");
    const result = JSON.parse(execFileSync(python, ["-I", "-B", "-X", "utf8", "-c", probe, path.join(destination, "desktop_ipc.py")], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    })) as { catalog: string; runtimes: string[][] };
    expect(result.catalog).toBe(path.join(destination, "desktop_profiles.json"));
    expect(result.runtimes).toEqual(expectedRuntimePairs);
  });
});
