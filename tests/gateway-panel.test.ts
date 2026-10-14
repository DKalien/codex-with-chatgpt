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
