import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map(m => m[1]);
}

describe("R5c architecture fence", () => {
  it("web-sink-control generic store/service do not import routing/outbox/desktop/executor-control", () => {
    for (const file of ["schema.ts", "store.ts", "service.ts", "registry.ts"]) {
      const source = read(`src/web-sink-control/${file}`);
      for (const specifier of importsOf(source)) {
        expect(specifier, `${file} -> ${specifier}`).not.toMatch(/routing|result-outbox|desktop|executor-control/);
      }
    }
  });

  it("generic endpoint core does not import web-sink-control", () => {
    for (const file of fs.readdirSync(path.join(root, "src/endpoints"))) {
      if (!file.endsWith(".ts")) continue;
      const source = read(`src/endpoints/${file}`);
      for (const specifier of importsOf(source)) {
        expect(specifier).not.toMatch(/web-sink-control/);
      }
    }
  });

  it("ChatGPT URL parser only in surface adapter", () => {
    const surface = read("src/web-sink-control/chatgpt-surface.ts");
    expect(surface).toMatch(/normalizeChatgptConversationRoute/);
    for (const file of ["schema.ts", "store.ts", "service.ts", "registry.ts"]) {
      const source = read(`src/web-sink-control/${file}`);
      expect(source, file).not.toMatch(/normalizeChatgpt|chatgpt\.com\/c\/|parseChatgpt/);
    }
  });

  it("web sink persisted state has no private product identity", () => {
    const schema = read("src/web-sink-control/schema.ts");
    expect(schema).not.toMatch(/principalFingerprint|plannerRouteId|executorBindingId|threadId|turnId/);
    const store = read("src/web-sink-control/store.ts");
    expect(store).not.toMatch(/principalFingerprint|plannerRouteId/);
  });

  it("no MCP web_sink_bind; production registry only ChatGPT surface", () => {
    const tools = read("src/mcp/web-sink-tools.ts");
    expect(tools).not.toMatch(/registerTool\(\s*"web_sink_bind"/);
    const registry = read("src/web-sink-control/registry.ts");
    expect(registry).toMatch(/chatgptWebSinkSurfaceDescriptor/);
    expect(registry).not.toMatch(/gemini|claude-code/i);
    expect(registry).not.toMatch(/readdir|process\.env|import\(/);
  });

  it("companion adapter is the only legacy companion to web sink bridge", () => {
    const adapter = read("src/web-sink-control/companion-adapter.ts");
    expect(adapter).toMatch(/bindCurrentWebSinkFromDurableCompanion/);
    expect(adapter).toMatch(/bindCurrentWebSinkFromVerifiedCompanionRoute/);
    expect(adapter).toMatch(/verifyCompanionCredentialForWebSink/);
    expect(adapter).toMatch(/isWebSinkRouteVerified/);
    expect(adapter).not.toMatch(/principalFingerprint/);
    const service = read("src/web-sink-control/service.ts");
    expect(service).not.toMatch(/from ["'].*feedback|from ["'].*companion/i);
    expect(service).not.toMatch(/principalFingerprint|plannerRouteId/);
    const companion = read("src/bridge/companion.ts");
    expect(companion).toMatch(/web-sink\/bind-current/);
    expect(companion).toMatch(/bindCurrentWebSinkFromDurableCompanion/);
    const allow = read("browser-companion/bridge-origin.js");
    expect(allow).toMatch(/web-sink\/bind-current/);
    const sw = read("browser-companion/service-worker.js");
    expect(sw).toMatch(/web-sink\/bind-current/);
    expect(sw).toMatch(/convergeExplicitVerifiedConnect/);
  });

  it("legacy R4 result routing does not read active web sink", () => {
    for (const file of [
      "src/routing/result-outbox-store.ts",
      "src/routing/current-command-transport.ts",
      "src/routing/execution-result-reconciler.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/web-sink-control|readActiveWebSinkBinding|webSinkStatus/);
    }
  });

  it("companion web-sink/status is read-only and never binds", () => {
    const companion = read("src/bridge/companion.ts");
    expect(companion).toMatch(/router\.get\("\/web-sink\/status"/);
    const statusIdx = companion.indexOf('router.get("/web-sink/status"');
    const statusBlock = companion.slice(statusIdx, statusIdx + 800);
    expect(statusBlock).not.toMatch(/bindCurrentWebSink/);
    const allow = read("browser-companion/bridge-origin.js");
    expect(allow).toMatch(/\/web-sink\/status/);
    const sw = read("browser-companion/service-worker.js");
    expect(sw).toMatch(/syncActiveWebSinkFromBridge/);
    expect(sw).toMatch(/activeWebSinkProjection/);
    const outbox = read("src/routing/result-outbox-store.ts");
    expect(outbox).not.toMatch(/web-sink-control|readActiveWebSinkBinding/);
  });
});
