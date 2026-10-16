import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCli } from "../src/cli/index.js";
import { readDesktop } from "../src/desktop/store.js";
import { listNotifications, readResult } from "../src/results/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { FakeDesktop } from "./fake-desktop.js";

let root: string;
let out: string;
let err: string;

async function c2c(...args: string[]): Promise<number> {
  out = "";
  err = "";
  return runCli(["node", "c2c", ...args]);
}

beforeEach(() => {
  root = makeTmpDir("cli");
  out = err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => { err += String(s); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanup(root);
});

describe("workspace", () => {
  it("add / list / remove", async () => {
    const id = new Workspace(root).id;
    expect(await c2c("workspace", "add", "-w", root)).toBe(0);
    expect(out).toContain(`新登记 ${id}`);
    expect(await c2c("workspace", "add", "-w", root)).toBe(0);
    expect(out).toContain(`已登记过 ${id}`);

    await c2c("workspace", "list", "--json");
    expect(JSON.parse(out)).toEqual([expect.objectContaining({ workspaceId: id, root: new Workspace(root).root })]);

    expect(await c2c("workspace", "remove", id)).toBe(0);
    await c2c("workspace", "list", "--json");
    expect(JSON.parse(out)).toEqual([]);
  });

  it("defaults -w to the current directory", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await c2c("workspace", "add");
    await c2c("workspace", "list", "--json");
    expect(JSON.parse(out)[0].workspaceId).toBe(new Workspace(root).id);
  });
});

describe("record", () => {
  it("writes a result and a pending notification", async () => {
    const id = new Workspace(root).id;
    const file = path.join(root, "out.txt");
    fs.writeFileSync(file, "all green\n");
    const code = await c2c("record", "-w", root, "--command-id", "cmd-1", "--status", "ok", "--summary", "完成",
      "--changed-files", "a.ts, b.ts", "--output-file", file, "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, result: { commandId: "cmd-1", status: "ok" } });

    expect(readResult(id, "cmd-1")).toMatchObject({ summary: "完成", changedFiles: ["a.ts", "b.ts"], output: expect.stringContaining("all green") });
    expect(listNotifications(id)).toEqual([expect.objectContaining({ commandId: "cmd-1", state: "pending" })]);
  });

  it("caps --output-file at 256 KiB", async () => {
    const file = path.join(root, "big.txt");
    fs.writeFileSync(file, "x".repeat(300 * 1024));
    await c2c("record", "-w", root, "--command-id", "cmd-2", "--status", "failed", "--summary", "s", "--output-file", file);
    const result = readResult(new Workspace(root).id, "cmd-2");
    expect(result?.output?.length).toBeLessThanOrEqual(256 * 1024);
    expect(result?.outputTruncated).toBe(true);
  });
});

describe("desktop", () => {
  it("bind-current via CODEX_THREAD_ID, then status and unbind", async () => {
    const fake = await new FakeDesktop({ title: "我的会话" }).start();
    const thread = randomUUID();
    vi.stubEnv("C2C_DESKTOP_PIPE", fake.pipe);
    vi.stubEnv("CODEX_THREAD_ID", thread);
    try {
      const id = new Workspace(root).id;
      expect(await c2c("desktop", "bind-current", "-w", root, "--json")).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ threadId: thread, title: "我的会话" });
      expect(readDesktop(id).binding?.threadId).toBe(thread);

      await c2c("desktop", "status", "-w", root, "--json");
      expect(JSON.parse(out)).toMatchObject({ available: true, busy: false, binding: { threadId: thread } });

      await c2c("workspace", "add", "-w", root);
      await c2c("status", "--json");
      expect(JSON.parse(out).workspaces).toContainEqual(expect.objectContaining({ workspaceId: id, pending: 0, claimed: 0, binding: expect.objectContaining({ threadId: thread }) }));

      expect(await c2c("desktop", "unbind", "-w", root)).toBe(0);
      expect(readDesktop(id).binding).toBeNull();
    } finally {
      await fake.stop();
    }
  });
});

describe("companion token", () => {
  it("is stable unless --rotate", async () => {
    await c2c("companion", "token");
    const first = out.trim();
    expect(first.length).toBeGreaterThan(20);
    await c2c("companion", "token");
    expect(out.trim()).toBe(first);
    await c2c("companion", "token", "--rotate");
    expect(out.trim()).not.toBe(first);
  });
});

describe("errors", () => {
  it("prints 错误 <code>: <message> and exits 1", async () => {
    expect(await c2c("desktop", "bind-current", "-w", root)).toBe(1);
    expect(err).toMatch(/^错误 DESKTOP_\w+: /);
    expect(out).toBe("");
  });

  it("prints JSON errors in --json mode", async () => {
    expect(await c2c("record", "-w", root, "--command-id", "bad id", "--status", "ok", "--summary", "s", "--json")).toBe(1);
    expect(JSON.parse(err)).toMatchObject({ ok: false, error: "INVALID_COMMAND_ID" });
  });

  it("gateway pair reports a missing gateway", async () => {
    expect(await c2c("gateway", "pair")).toBe(1);
    expect(err).toContain("GATEWAY_NOT_RUNNING");
  });

  it("returns non-zero for usage errors", async () => {
    expect(await c2c("record", "-w", root)).not.toBe(0);
  });
});
