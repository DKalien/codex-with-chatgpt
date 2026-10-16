import { describe, expect, it } from "vitest";
import {
  ackNotification, claimNotification, listNotifications, listResults, readResult,
  recordResult, renderNotification, requeueNotification,
} from "../src/results/store.js";

const W = "aaaaaaaaaaaa";
const base = { workspaceId: W, status: "ok" as const, summary: "done" };

describe("results store", () => {
  it("records a result and a pending notification with exactly one ATTEMPT_ID line", () => {
    const { result, notification } = recordResult({ ...base, commandId: "c1", tests: "pass", output: "hello" });
    expect(readResult(W, "c1")).toEqual(result);
    expect(notification.state).toBe("pending");
    expect(notification.text).toBe(renderNotification(notification));
    expect(notification.text.match(/^ATTEMPT_ID: /gm)).toHaveLength(1);
    expect(notification.text).toContain(`ATTEMPT_ID: ${notification.id}`);
    expect(notification.text).toContain(`WORKSPACE_ID: ${W} | COMMAND_ID: c1 | STATUS: ok`);
  });

  it("rejects unsafe commandId and returns null for unknown results", () => {
    expect(() => recordResult({ ...base, commandId: "../x" })).toThrow(/commandId/);
    expect(readResult(W, "nope")).toBeNull();
  });

  it("caps summary/output, redacts secrets and flags truncation", () => {
    const { result } = recordResult({
      ...base, commandId: "big", summary: "s".repeat(20_000),
      output: `token ghp_${"a".repeat(30)}\n` + "x".repeat(300_000),
    });
    expect(Buffer.byteLength(result.summary)).toBe(8 * 1024);
    expect(result.output).not.toContain("ghp_");
    expect(result.outputTruncated).toBe(true);
    const rejected = recordResult({ ...base, commandId: "pk", output: "-----BEGIN PRIVATE KEY-----\nabc" });
    expect(rejected.result.output).not.toContain("BEGIN");
  });

  it("re-recording updates the pending notification in place, new one after claim", () => {
    const a = recordResult({ ...base, commandId: "re" }).notification;
    const b = recordResult({ ...base, commandId: "re", status: "failed" }).notification;
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("failed");
    expect(b.text).toContain("STATUS: failed");
    expect(listNotifications(W).filter((n) => n.commandId === "re")).toHaveLength(1);
    claimNotification(W, a.id);
    const c = recordResult({ ...base, commandId: "re" }).notification;
    expect(c.id).not.toBe(a.id);
    expect(listNotifications(W).filter((n) => n.commandId === "re")).toHaveLength(2);
  });

  it("follows pending -> claimed -> delivered; requeue only from claimed", () => {
    const { id } = recordResult({ ...base, commandId: "sm" }).notification;
    expect(() => ackNotification(W, id)).toThrow(/尚未被领取/);
    expect(() => requeueNotification(W, id)).toThrow(/只有已领取/);
    expect(claimNotification(W, id).state).toBe("claimed");
    expect(() => claimNotification(W, id)).toThrow(expect.objectContaining({ code: "NOTIFICATION_NOT_PENDING" }));
    const back = requeueNotification(W, id);
    expect(back.state).toBe("pending");
    expect(back.claimedAt).toBeUndefined();
    claimNotification(W, id);
    expect(ackNotification(W, id).state).toBe("delivered");
    expect(ackNotification(W, id).state).toBe("delivered");
    expect(() => requeueNotification(W, id)).toThrow(expect.objectContaining({ code: "NOTIFICATION_NOT_CLAIMED" }));
    expect(() => claimNotification(W, "missing")).toThrow(expect.objectContaining({ code: "NOTIFICATION_NOT_FOUND" }));
  });

  it("lists results newest first and keeps at most 200 notifications", () => {
    const W2 = "bbbbbbbbbbbb";
    for (let i = 0; i < 202; i++) recordResult({ workspaceId: W2, commandId: `n${i}`, status: "ok", summary: "x" });
    const notes = listNotifications(W2);
    expect(notes).toHaveLength(200);
    expect(notes[0].commandId).toBe("n2");
    const results = listResults(W2, 3);
    expect(results).toHaveLength(3);
    expect(results[0].recordedAt >= results[1].recordedAt).toBe(true);
    expect(listResults("cccccccccccc")).toEqual([]);
  });
});
