import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindCurrentWebSink,
  canonicalizeChatgptWebSinkUrl,
  freezeActiveWebSinkTarget,
  isChatgptWebSinkUrl,
  listWebSinkSurfaces,
  projectChatgptRouteToWebSinkCandidate,
  readActiveWebSinkBinding,
  webSinkStatus,
} from "../src/web-sink-control/index.js";
import { bindCurrentExecutor, readActiveExecutorBinding } from "../src/executor-control/index.js";

const workspaceId = "2582910bf0d2";
const workspaceRoot = "D:\\python\\codex-with-chatgpt";
const URL_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const URL_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

describe("R5c endpoint datetime parity", () => {
  it("endpointInstantSchema and Browser boundAt validator accept the same language", async () => {
    const { endpointInstantSchema } = await import("../src/endpoints/schema.js");
    const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
    const cases: [string, boolean][] = [
      ["2026-09-29T00:00:00Z", true],
      ["2026-09-29T00:00:00.123Z", true],
      ["2026-09-29T08:00:00+08:00", false],
      ["2026-09-29", false],
      ["09/29/2026", false],
      ["2026-09-29T00:00:00", false],
    ];
    for (const [value, expected] of cases) {
      expect(endpointInstantSchema.safeParse(value).success, `endpoint ${value}`).toBe(expected);
      expect(ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value)), `browser ${value}`).toBe(expected);
    }
  });
});

describe("R5c web sink service and URL surface", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-web-sink-svc-"));
    previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("canonicalizes ChatGPT conversation URL and rejects others", () => {
    expect(canonicalizeChatgptWebSinkUrl(URL_A)).toBe(URL_A);
    // companion-facing rule：query/hash 直接拒绝，不静默剥离成另一 identity
    expect(() => canonicalizeChatgptWebSinkUrl(`${URL_A}?x=1`)).toThrow(/query|hash|URL_INVALID|无效/);
    expect(() => canonicalizeChatgptWebSinkUrl(`${URL_A}#frag`)).toThrow(/query|hash|URL_INVALID|无效/);
    expect(isChatgptWebSinkUrl("https://example.com/c/x")).toBe(false);
    expect(isChatgptWebSinkUrl("https://gemini.google.com/app/abc")).toBe(false);
    expect(() => projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: "https://evil.example/c/x",
    })).toThrow();
  });

  it("lists only production chatgpt-web surface", () => {
    const surfaces = listWebSinkSurfaces();
    expect(surfaces.map(s => `${s.pluginId}/${s.surfaceId}`)).toEqual(["browser-companion/chatgpt-web"]);
  });

  it("status reports no binding then available binding", async () => {
    const empty = await webSinkStatus(workspaceId);
    expect(empty.activeBinding).toBeNull();
    expect(empty.availability).toMatchObject({ available: false, reasonCode: "no_active_binding" });

    const bound = bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: URL_A,
    }));
    const status = await webSinkStatus(workspaceId, {
      companionAvailable: true,
      companionVerified: true,
      companionRouteCanonical: URL_A,
    });
    expect(status.activeBinding?.bindingId).toBe(bound.binding.bindingId);
    expect(status.availability).toEqual({ available: true });
    expect(JSON.stringify(status)).not.toMatch(/principalFingerprint|plannerRouteId|credential/);
  });

  it("freezeActiveWebSinkTarget keeps A after switch to B", () => {
    const a = bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: URL_A,
    }));
    const frozenA = freezeActiveWebSinkTarget(a.binding);
    const b = bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: URL_B,
    }));
    expect(frozenA.canonicalUrl).toBe(URL_A);
    expect(frozenA.bindingId).toBe(a.binding.bindingId);
    expect(readActiveWebSinkBinding(workspaceId)?.bindingId).toBe(b.binding.bindingId);
    expect(b.binding.epoch).toBe(a.binding.epoch + 1);
  });

  it("executor bind and web sink bind are independent", () => {
    bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: URL_A,
    }));
    const sinkBefore = readActiveWebSinkBinding(workspaceId);

    bindCurrentExecutor(workspaceId, workspaceRoot, {
      pluginId: "codex-desktop",
      workspaceId,
      workspaceRoot,
      instanceId: "local",
      sessionId: "sess-x",
      locator: { executorProjectId: "proj" },
    });
    expect(readActiveWebSinkBinding(workspaceId)).toEqual(sinkBefore);

    bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({
      workspaceId,
      routeCanonical: URL_B,
    }));
    expect(readActiveWebSinkBinding(workspaceId)?.canonicalUrl).toBe(URL_B);
    expect(readActiveExecutorBinding(workspaceId, workspaceRoot)?.sessionId).toBe("sess-x");
  });
});
