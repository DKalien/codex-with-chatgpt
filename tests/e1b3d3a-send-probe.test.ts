import { describe, expect, it } from "vitest";

const ATTEMPT = "22222222-2222-4222-8222-222222222222";

const PROBE = `[C2C_SEND_PROBE]\nATTEMPT_ID: ${ATTEMPT}\n`;

describe("E1b3d3a observer exactness (pure)", () => {
  it("findCanonicalUserTurn ignores unrelated / handles zero/one/many", async () => {
    const { findCanonicalUserTurn, snapshotUserTurns, hasExactAttemptMarker } = await import(
      "../browser-companion/turn-observer.js"
    );
    expect(hasExactAttemptMarker(PROBE, ATTEMPT).ok).toBe(true);
    expect(hasExactAttemptMarker(PROBE, "11111111-1111-4111-8111-111111111111").ok).toBe(false);

    function docWithTurns(texts: string[]) {
      return {
        querySelectorAll: () => texts.map((text, i) => ({
          getAttribute: (n: string) =>
            n === "data-message-author-role" ? "user" : n === "data-testid" ? `conversation-turn-${i}` : null,
          textContent: text,
          innerText: text,
          closest: () => ({ getAttribute: () => `conversation-turn-${i}` }),
          querySelector: () => null,
        })),
      } as never;
    }

    const unrelated = findCanonicalUserTurn(docWithTurns(["hello world", "other"]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(unrelated.ok).toBe(false);
    expect(unrelated.reason).toBe("not_observed");

    const one = findCanonicalUserTurn(docWithTurns(["hello", PROBE]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(one.ok).toBe(true);

    const two = findCanonicalUserTurn(docWithTurns([PROBE, PROBE]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(two.ok).toBe(false);
    expect(two.reason).toBe("ambiguous");

    // baseline excludes existing identical turn
    const baseDoc = docWithTurns([PROBE]);
    const baseline = snapshotUserTurns(baseDoc);
    const same = findCanonicalUserTurn(baseDoc, {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline,
    });
    expect(same.ok).toBe(false);
    expect(same.reason).toBe("not_observed");
  });
});
