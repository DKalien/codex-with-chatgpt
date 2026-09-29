import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_SINK_READ_SCOPE } from "../src/auth/store.js";

describe("R5c MCP web sink tools surface", () => {
  it("uses codex.websink.read and has no bind/switch tools", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/web-sink-tools.ts"), "utf8");
    expect(source).toMatch(/from ["']\.\.\/auth\/store\.js["']/);
    expect(source).toMatch(/WEB_SINK_READ_SCOPE/);
    expect(source).toMatch(/"web_sink_list"/);
    expect(source).toMatch(/"web_sink_status"/);
    expect(source).not.toMatch(/registerTool\(\s*"web_sink_bind"/);
    expect(source).not.toMatch(/registerTool\(\s*"web_sink_switch"/);
    expect(source).not.toMatch(/principalFingerprint|plannerRouteId/);
    expect(WEB_SINK_READ_SCOPE).toBe("codex.websink.read");
  });
});
