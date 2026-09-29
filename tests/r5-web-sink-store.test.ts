import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WEB_SINK_MAX_EPOCH,
  WebSinkControlError,
  bindCurrentWebSink,
  nextWebSinkEpoch,
  readActiveWebSinkBinding,
  readWebSinkControl,
  updateWebSinkControlDetailed,
  webSinkControlFile,
  webSinkControlInitializedFile,
} from "../src/web-sink-control/index.js";
import type { WebSinkBindingCandidate } from "../src/endpoints/schema.js";

const workspaceId = "2582910bf0d2";

function candidate(overrides: Partial<WebSinkBindingCandidate> = {}): WebSinkBindingCandidate {
  return {
    pluginId: "browser-companion",
    surfaceId: "chatgpt-web",
    workspaceId,
    canonicalUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

describe("R5c web sink control store", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-web-sink-"));
    previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("initial state is null", () => {
    expect(readActiveWebSinkBinding(workspaceId)).toBeNull();
  });

  it("first bind creates epoch=1 and initialized marker", () => {
    const result = bindCurrentWebSink(workspaceId, candidate());
    expect(result.created).toBe(true);
    expect(result.binding.epoch).toBe(1);
    expect(fs.existsSync(webSinkControlInitializedFile(workspaceId))).toBe(true);
  });

  it("same exact URL is noWrite idempotent", () => {
    const first = bindCurrentWebSink(workspaceId, candidate());
    const file = webSinkControlFile(workspaceId);
    const before = fs.readFileSync(file, "utf8");
    const second = bindCurrentWebSink(workspaceId, candidate());
    expect(second.created).toBe(false);
    expect(second.noWrite).toBe(true);
    expect(second.binding.bindingId).toBe(first.binding.bindingId);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("URL A to B creates new bindingId and epoch+1", () => {
    const a = bindCurrentWebSink(workspaceId, candidate());
    const b = bindCurrentWebSink(workspaceId, candidate({
      canonicalUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    }));
    expect(b.binding.bindingId).not.toBe(a.binding.bindingId);
    expect(b.binding.epoch).toBe(2);
    expect(b.binding.canonicalUrl).toContain("22222222");
  });

  it("corrupt initialized state fails closed", () => {
    bindCurrentWebSink(workspaceId, candidate());
    fs.writeFileSync(webSinkControlFile(workspaceId), "{ bad", "utf8");
    expect(() => readWebSinkControl(workspaceId)).toThrow(/损坏|CORRUPT/);
  });

  it("initialized marker present with missing file is corrupt not null", () => {
    bindCurrentWebSink(workspaceId, candidate());
    fs.unlinkSync(webSinkControlFile(workspaceId));
    expect(() => readWebSinkControl(workspaceId)).toThrow(/损坏|CORRUPT/);
  });

  it("lock busy fails closed", () => {
    const file = webSinkControlFile(workspaceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "", "utf8");
    expect(() => bindCurrentWebSink(workspaceId, candidate())).toThrow(/LOCK_BUSY|锁/);
  });

  it("epoch overflow fails closed", () => {
    expect(() => nextWebSinkEpoch(WEB_SINK_MAX_EPOCH)).toThrow(/EPOCH_OVERFLOW|上限/);
  });

  it("workspace mismatch and unknown surface rejected", () => {
    expect(() =>
      bindCurrentWebSink("aaaaaaaaaaaa", candidate()),
    ).toThrow(WebSinkControlError);
    expect(() =>
      bindCurrentWebSink(workspaceId, candidate({ surfaceId: "gemini-web" })),
    ).toThrow(/UNKNOWN_SURFACE|production/);
  });

  it("noWrite without previous state fails closed", () => {
    expect(() =>
      updateWebSinkControlDetailed(workspaceId, () => ({
        state: { version: 1, workspaceId, revision: 1, activeBinding: null },
        result: 1,
        noWrite: true,
      })),
    ).toThrow(/noWrite|损坏/);
  });

  it("persisted state contains no planner/feedback/executor product fields", () => {
    bindCurrentWebSink(workspaceId, candidate());
    const raw = fs.readFileSync(webSinkControlFile(workspaceId), "utf8");
    expect(raw).not.toMatch(/plannerRouteId|principalFingerprint|executorBindingId|threadId|turnId/);
  });
});
