import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "../src/gateway/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("Registry", () => {
  let state: string;
  let project: string;
  let file: string;
  beforeEach(() => {
    state = makeTmpDir("reg-state");
    project = makeTmpDir("reg-project");
    file = path.join(state, "gateway", "workspaces.json");
  });
  afterEach(() => {
    cleanup(state);
    cleanup(project);
  });

  it("读取旧格式并在写入时保留 clientIds", () => {
    const old = new Workspace(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces: [{ workspaceId: old.id, root: old.root, clientIds: ["client-a"] }] }));
    const registry = new Registry(state);
    expect(registry.list()).toEqual([{ workspaceId: old.id, root: old.root, name: old.name }]);

    const other = makeTmpDir("reg-other");
    try {
      const added = registry.add(other);
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved.version).toBe(1);
      expect(saved.workspaces).toEqual([
        { workspaceId: old.id, root: old.root, clientIds: ["client-a"] },
        { workspaceId: added.workspaceId, root: added.root, clientIds: [] },
      ]);
    } finally {
      cleanup(other);
    }
  });

  it("add 幂等，resolve 返回 Workspace，remove 删除", () => {
    const registry = new Registry(state);
    const a = registry.add(project);
    expect(registry.add(project)).toEqual(a);
    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve(a.workspaceId).root).toBe(a.root);
    expect(registry.remove(a.workspaceId)).toBe(true);
    expect(registry.remove(a.workspaceId)).toBe(false);
    expect(() => registry.resolve(a.workspaceId)).toThrow(expect.objectContaining({ code: "UNKNOWN_WORKSPACE" }));
  });

  it("目录不存在或 id 不匹配时 WORKSPACE_MOVED", () => {
    const registry = new Registry(state);
    const a = registry.add(project);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.workspaces.push({ workspaceId: "0123456789ab", root: project, clientIds: [] });
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(() => registry.resolve("0123456789ab")).toThrow(expect.objectContaining({ code: "WORKSPACE_MOVED" }));

    cleanup(project);
    expect(() => registry.resolve(a.workspaceId)).toThrow(expect.objectContaining({ code: "WORKSPACE_MOVED" }));
    expect(registry.list().map(e => e.name)).toContain(path.basename(a.root));
  });
});
