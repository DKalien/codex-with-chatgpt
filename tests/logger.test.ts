import { describe, expect, it } from "vitest";
import { redact } from "../src/logger/index.js";

describe("redact", () => {
  it("隐藏 OpenAI key（明文或已打码）", () => {
    const line = 'error":"invalid_api_key: Incorrect API key provided: sk-proj-abcd****************wxyz"';
    expect(redact(line)).toBe('error":"invalid_api_key: Incorrect API key provided: [REDACTED]"');
    expect(redact("key=sk-AbCdEf0123456789")).not.toContain("sk-AbCd");
  });
});
