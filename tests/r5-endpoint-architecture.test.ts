import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function endpointSourceFiles(): string[] {
  const dir = path.join(root, "src/endpoints");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join("src/endpoints", entry.name));
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("R5a generic endpoint architecture fence", () => {
  it("src/endpoints never imports desktop/feedback/browser-companion/mcp/cli/remote", () => {
    const files = endpointSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const relative of files) {
      const source = read(relative);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${relative} -> ${specifier}`).not.toMatch(
          /(?:^|\/)(?:desktop|feedback|browser-companion|mcp|cli|remote)(?:\/|$)/i,
        );
      }
      expect(source, relative).not.toMatch(/from ["']\.\.\/(?:desktop|feedback|browser-companion|mcp|cli|remote)\//);
    }
  });

  it("generic executor contract and schema avoid product-specific identity fields", () => {
    for (const relative of [
      "src/endpoints/executor-contract.ts",
      "src/endpoints/schema.ts",
    ]) {
      const source = read(relative);
      expect(source, relative).not.toMatch(/codex/i);
      expect(source, relative).not.toMatch(/threadId/);
      expect(source, relative).not.toMatch(/turnId/);
      expect(source, relative).not.toMatch(/hostId/);
      expect(source, relative).not.toMatch(/projectId/);
    }
  });

  it("Bridge owns binding stamp fields; plugin contracts only discover candidates", () => {
    const schema = read("src/endpoints/schema.ts");
    expect(schema).toMatch(/createExecutorBinding/);
    expect(schema).toMatch(/executorBindingCandidateSchema/);
    const contract = read("src/endpoints/executor-contract.ts");
    expect(contract).toMatch(/discoverCurrent/);
    expect(contract).not.toMatch(/currentBinding/);
    const sink = read("src/endpoints/web-sink-contract.ts");
    expect(sink).toMatch(/discoverCurrent/);
    expect(sink).not.toMatch(/currentBinding/);
  });

  it("generic web sink contract avoids surface/principal/route identity", () => {
    for (const relative of ["src/endpoints/web-sink-contract.ts", "src/endpoints/schema.ts"]) {
      const source = read(relative);
      expect(source, relative).not.toMatch(/chatgpt/i);
      expect(source, relative).not.toMatch(/plannerRouteId/);
      expect(source, relative).not.toMatch(/principalFingerprint/);
      expect(source, relative).not.toMatch(/executorRouteId/);
    }
    // generic bindingId is allowed; feedback-specific binding schema must not be imported
    const sink = read("src/endpoints/web-sink-contract.ts");
    expect(sink).not.toMatch(/from ["'].*feedback/i);
  });

  it("generic registry has no dynamic plugin discovery", () => {
    const raw = read("src/endpoints/registry.ts");
    // 去掉注释后再查代码本体，避免文档用词误报。
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/readdir|process\.env/);
    expect(source).not.toMatch(/fetch\s*\(|require\(["']fs|from ["']node:fs/);
    expect(source).toMatch(/PLUGIN_ID_DUPLICATE/);
    expect(source).toMatch(/PLUGIN_UNKNOWN/);
    expect(source).toMatch(/createPluginRegistry/);
    expect(raw).toMatch(/createPluginRegistry/);
  });

  it("Codex adapter may depend on generic endpoints; generic core never reverse-depends", () => {
    const adapter = read("src/executor/index.ts");
    expect(adapter).toMatch(/from ["']\.\.\/endpoints\//);
    expect(adapter).toMatch(/translateGenericToCodexTarget|translateBindingToCodexTarget/);
    const generic = endpointSourceFiles().map(read).join("\n");
    expect(generic).not.toMatch(/from ["']\.\.\/executor\//);
    expect(generic).not.toMatch(/from ["']\.\.\/desktop\//);
    expect(generic).not.toMatch(/codexDesktopAdapter|CodexDesktopAdapter|desktopIpc/);
  });

  it("executor trust gates parse descriptors at runtime", () => {
    const contract = read("src/endpoints/executor-contract.ts");
    expect(contract).toMatch(/parseExecutorPluginDescriptor\(descriptorInput\)/);
    expect(contract).toMatch(/validateExecutorPlugin/);
    expect(contract).toMatch(/createExecutorPluginRegistry/);
  });

  it("current routing/feedback/browser architecture files remain free of generic-endpoint rewiring", () => {
    for (const relative of [
      "src/routing/schema.ts",
      "src/routing/result-outbox-schema.ts",
      "src/routing/result-outbox-store.ts",
      "src/routing/execution-result-reconciler.ts",
      "src/feedback/schema.ts",
    ]) {
      const source = read(relative);
      expect(source, relative).not.toMatch(/from ["'].*\/endpoints\//);
      expect(source, relative).not.toMatch(/endpoints\/schema|endpoints\/index/);
    }
  });
});
