import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("R5d1 Result Bus architecture fence", () => {
  it("keeps the bus planner-independent and outside feedback/browser/control paths", () => {
    const files = fs.readdirSync(path.join(root, "src/result-bus"), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
      .map(entry => `src/result-bus/${entry.name}`);
    expect(files).toEqual(expect.arrayContaining([
      "src/result-bus/schema.ts", "src/result-bus/store.ts", "src/result-bus/service.ts", "src/result-bus/index.ts",
    ]));
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/plannerRouteId|plannerPrincipalFingerprint/);
      expect(source, file).not.toMatch(/feedback|browser-companion|src\/mcp|src\/cli|remote|executor-control/);
      expect(source, file).not.toMatch(/readActiveExecutorBinding|executor-binding-store|active-executor/);
    }
  });

  it("keeps R4 outbox independent from Web Sink state and plannerRoute-pinned", () => {
    const outbox = read("src/routing/result-outbox-store.ts");
    expect(outbox, "R4 outbox 必须 pin plannerRoute").toMatch(/plannerRouteId/);
    expect(outbox).not.toMatch(/web-sink-control|readActiveWebSinkBinding|webSinkStatus/);
    expect(outbox).not.toMatch(/result-bus/);
    expect(read("src/routing/execution-result-digest.ts")).not.toMatch(/result-outbox-store/);
    expect(fs.existsSync(path.join(root, "src/routing/result-outbox-store.ts"))).toBe(true);
  });

  it("keeps the Result Bus shadow-only: no R5d2 delivery transition surface", () => {
    const files = fs.readdirSync(path.join(root, "src/result-bus"), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
      .map(entry => `src/result-bus/${entry.name}`);
    for (const file of files) {
      expect(read(file), file).not.toMatch(/beginSend|begin-send|reserveResultBus|ackResultBus|acknowledgeResultBus/);
    }
  });

  it("routes the feedback projector through the R4 outbox, never the Result Bus", () => {
    const projector = read("src/feedback/projector.ts");
    expect(projector).toMatch(/result-outbox-store/);
    expect(projector).not.toMatch(/result-bus/);
    expect(read("src/routing/execution-result-reconciler.ts")).toMatch(/result-bus\/service\.js/);
  });

  it("keeps Web Sink delivery on the Companion path, not on the Result Bus", () => {
    for (const file of ["src/bridge/companion.ts", "src/feedback/companion-route.ts", "src/feedback/companion-delivery.ts"]) {
      expect(read(file), file).not.toMatch(/result-bus/);
    }
  });
});
