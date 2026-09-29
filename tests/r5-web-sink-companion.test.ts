import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bindCurrentWebSinkFromVerifiedCompanionRoute,
  readActiveWebSinkBinding,
} from "../src/web-sink-control/index.js";
import type { FeedbackState } from "../src/feedback/schema.js";

const workspaceId = "2582910bf0d2";
const URL_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const URL_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

function feedbackWith(routeCanonical: string, verified: boolean): FeedbackState {
  const now = new Date().toISOString();
  return {
    version: 1,
    workspaceId,
    projectionCursor: 0,
    binding: null,
    events: [],
    pairingIntent: null,
    companion: {
      version: 1,
      companionId: randomUUID(),
      bindingId: randomUUID(),
      epoch: 1,
      principalFingerprint: "a".repeat(32),
      credentialHash: "b".repeat(64),
      routeCanonical,
      pairedAt: now,
      routeAttestation: {
        status: verified ? "verified" : "pending",
        challengeId: randomUUID(),
        challengeDigest: "c".repeat(64),
        routeCanonical,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(verified ? { verifiedAt: now } : {}),
      },
    },
    rebindIntent: null,
    rebindPredecessor: null,
  } as FeedbackState;
}

describe("R5c companion to web sink adapter", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-web-sink-comp-"));
    previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("verified route can project and bind candidate A", () => {
    const result = bindCurrentWebSinkFromVerifiedCompanionRoute({
      workspaceId,
      feedbackState: feedbackWith(URL_A, true),
    });
    expect(result.binding.canonicalUrl).toBe(URL_A);
    expect(result.binding.pluginId).toBe("browser-companion");
    expect(result.binding.surfaceId).toBe("chatgpt-web");
  });

  it("unverified route cannot bind sink", () => {
    expect(() =>
      bindCurrentWebSinkFromVerifiedCompanionRoute({
        workspaceId,
        feedbackState: feedbackWith(URL_A, false),
      }),
    ).toThrow(/UNVERIFIED|verified/);
  });

  it("caller expected route mismatch rejected", () => {
    expect(() =>
      bindCurrentWebSinkFromVerifiedCompanionRoute({
        workspaceId,
        feedbackState: feedbackWith(URL_A, true),
        expectedRouteCanonical: URL_B,
      }),
    ).toThrow(/MISMATCH|不一致/);
  });

  it("later verified B becomes active sink; identity is URL not planner principal", () => {
    const a = bindCurrentWebSinkFromVerifiedCompanionRoute({
      workspaceId,
      feedbackState: feedbackWith(URL_A, true),
    });
    const b = bindCurrentWebSinkFromVerifiedCompanionRoute({
      workspaceId,
      feedbackState: feedbackWith(URL_B, true),
    });
    expect(b.binding.bindingId).not.toBe(a.binding.bindingId);
    expect(b.binding.epoch).toBe(a.binding.epoch + 1);
    expect(readActiveWebSinkBinding(workspaceId)?.canonicalUrl).toBe(URL_B);
    // principalFingerprint not part of web sink identity
    expect(JSON.stringify(b.binding)).not.toMatch(/principalFingerprint/);
  });
});
