import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");

function javascriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".js") ? [absolute] : [];
  });
}

describe("task delivery / feedback return architecture boundary", () => {
  it("Browser Companion runtime has no task-delivery imports, calls, or task-control endpoints", () => {
    const files = javascriptFiles(companionRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const relative = path.relative(companionRoot, file).replaceAll(path.sep, "/");
      const taskSymbolSource = source.replace("不调用 codex_desktop_send，不执行开发任务。", "");
      expect(taskSymbolSource, relative).not.toMatch(/\b(?:codex_desktop_send|deliverCurrentCommand|sendDesktop)\b/);
      expect(source, relative).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:\/(?:src\/)?(?:desktop|routing)\/|\/current-command(?:-transport)?(?:\.|\/|["']))[^"']*["']/i);
      expect(source, relative).not.toMatch(/["'`][^"'`]*(?:\/api\/(?:desktop|command|task|routing)|thread-follower-start-turn|thread\/start|turn\/start)[^"'`]*/i);
    }
  });

  it("task delivery production graph is independent of Browser Companion and feedback authority", () => {
    const files = [
      "src/mcp/desktop.ts",
      "src/routing/current-command-transport.ts",
      "src/routing/current-command.ts",
      "src/routing/current-planner-route.ts",
      "src/routing/current-executor-route.ts",
      "src/routing/desktop-adapter.ts",
    ];
    for (const relative of files) {
      const source = fs.readFileSync(path.join(projectRoot, relative), "utf8");
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)]
        .map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier, `${relative} -> ${specifier}`).not.toMatch(/browser-companion|(?:^|\/)feedback(?:\/|$)|legacy-adapter/i);
      }
      expect(source, relative).not.toMatch(/companionApiUrl|fetchCompanion|\/api\/companion\/v1/i);
    }
    const planner = fs.readFileSync(path.join(projectRoot, "src/routing/current-planner-route.ts"), "utf8");
    expect(planner).not.toMatch(/projectLegacyRoutes|readFeedbackState|RouteAttestation/i);
    const executor = fs.readFileSync(path.join(projectRoot, "src/routing/current-executor-route.ts"), "utf8");
    expect(executor).toMatch(/desktop-adapter\.js/);
    expect(executor).not.toMatch(/legacy-adapter|feedback/i);
    const desktopAdapter = fs.readFileSync(path.join(projectRoot, "src/routing/desktop-adapter.ts"), "utf8");
    expect(desktopAdapter).toMatch(/from ["']\.\.\/desktop\/store\.js["']/);
    expect(desktopAdapter).not.toMatch(/feedback|legacy-adapter|browser-companion/i);
  });

  it("canonical Result Outbox and trusted receipt reconciliation are independent of Browser/feedback runtime", () => {
    for (const relative of [
      "src/routing/result-outbox-schema.ts",
      "src/routing/result-outbox-store.ts",
      "src/routing/execution-result-reconciler.ts",
    ]) {
      const source = fs.readFileSync(path.join(projectRoot, relative), "utf8");
      expect(source, relative).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:browser-companion|(?:^|\/)feedback(?:\/|$))[^"]*["']/i);
      expect(source, relative).not.toMatch(/\b(?:reconcileFeedbackOutbox|sendDesktop|reserveFeedback|ackFeedback)\s*\(/);
    }
  });
});
