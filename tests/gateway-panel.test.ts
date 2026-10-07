import fs from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

it("each operations panel keeps its explicit project when requesting state", () => {
  for (const workspaceId of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    const sendMessage = vi.fn(() => new Promise(() => {}));
    const context = vm.createContext({ URL, location: { href: `chrome-extension://test/operations/operations.html?workspaceId=${workspaceId}` },
      chrome: { runtime: { sendMessage } }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      document: { hidden: false, getElementById: () => ({}), querySelectorAll: () => [], addEventListener() {} },
      window: { addEventListener() {} },
    });
    vm.runInContext(fs.readFileSync("browser-companion/operations/operations.js", "utf8"), context);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "c2c.operations.read", workspaceId });
  }
});

it("popup selection scopes queries and ignores a late response from the previous project", async () => {
  const target = { textContent: "" };
  let selection!: (event: any) => void;
  const pending: ((value: unknown) => void)[] = [];
  const sendMessage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const context = vm.createContext({
    document: { getElementById: () => target, addEventListener: (_type: string, listener: any) => { selection = listener; } },
    chrome: { runtime: { sendMessage } }, setTimeout: () => 1, clearTimeout() {},
    C2COperations: { derive: (response: any) => ({ codex: response.name, web: "observed", rows: [] }) },
  });
  vm.runInContext(fs.readFileSync("browser-companion/popup/operations-summary.js", "utf8"), context);
  selection({ detail: { workspaceId: "aaaaaaaaaaaa" } });
  selection({ detail: { workspaceId: "bbbbbbbbbbbb" } });
  expect(sendMessage.mock.calls.slice(1).map(call => call[0])).toEqual([
    { type: "c2c.operations.read", workspaceId: "aaaaaaaaaaaa" },
    { type: "c2c.operations.read", workspaceId: "bbbbbbbbbbbb" },
  ]);
  pending[2]!({ name: "project-b" });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  expect(target.textContent).toContain("project-b");
  pending[1]!({ name: "project-a" });
  pending[0]!({ name: "legacy" });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  expect(target.textContent).toContain("project-b");
  expect(target.textContent).not.toContain("project-a");
});
