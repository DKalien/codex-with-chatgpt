import { describe, expect, it } from "vitest";
import {
  parseChatgptConversationRoute,
  normalizeChatgptConversationRoute,
  normalizeControlConversationUrl,
  isChatgptConversationRoute,
  ChatGptRouteError,
} from "../src/chatgpt/route.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const CANONICAL = `https://chatgpt.com/c/${UUID}`;

describe("ChatGPT route parser", () => {
  it("accepts /c/<id> and canonicalizes host/slash", () => {
    expect(normalizeChatgptConversationRoute(CANONICAL)).toBe(CANONICAL);
    expect(normalizeChatgptConversationRoute(CANONICAL + "/")).toBe(CANONICAL);
    expect(normalizeChatgptConversationRoute(`https://www.chatgpt.com/c/${UUID}`)).toBe(CANONICAL);
    expect(normalizeChatgptConversationRoute(`https://ChatGPT.com/c/${UUID}`)).toBe(CANONICAL);
  });

  it("accepts project/GPT-shaped route /g/g-.../c/<id>", () => {
    const raw = `https://chatgpt.com/g/g-abc123/c/${UUID}`;
    const parsed = parseChatgptConversationRoute(raw, { conversationIdPolicy: "uuid" });
    expect(parsed.canonical).toBe(raw);
    expect(parsed.kind).toBe("gpt-conversation");
    expect(parsed.gptId).toBe("g-abc123");
    expect(parsed.conversationId).toBe(UUID);
  });

  it("rejects malformed host/protocol/path", () => {
    expect(() => normalizeChatgptConversationRoute(`https://chat.openai.com/c/${UUID}`)).toThrow(ChatGptRouteError);
    expect(() => normalizeChatgptConversationRoute(`http://chatgpt.com/c/${UUID}`)).toThrow(ChatGptRouteError);
    expect(() => normalizeChatgptConversationRoute("https://chatgpt.com/chat/x")).toThrow(ChatGptRouteError);
    expect(() => normalizeChatgptConversationRoute("https://chatgpt.com/g/notgpt/c/" + UUID)).toThrow(ChatGptRouteError);
  });

  it("companion-strict rejects query/hash; web-control strips them", () => {
    expect(() => normalizeChatgptConversationRoute(CANONICAL + "?x=1")).toThrow(ChatGptRouteError);
    expect(() => normalizeChatgptConversationRoute(CANONICAL + "#f")).toThrow(ChatGptRouteError);
    expect(normalizeControlConversationUrl(CANONICAL + "?x=1")).toBe(CANONICAL);
    expect(normalizeControlConversationUrl(CANONICAL + "#f")).toBe(CANONICAL);
  });

  it("rejects credentials and port", () => {
    expect(() => normalizeChatgptConversationRoute(`https://user:pass@chatgpt.com/c/${UUID}`)).toThrow(ChatGptRouteError);
    expect(() => normalizeChatgptConversationRoute(`https://chatgpt.com:8443/c/${UUID}`)).toThrow(ChatGptRouteError);
  });

  it("isChatgptConversationRoute", () => {
    expect(isChatgptConversationRoute(CANONICAL)).toBe(true);
    expect(isChatgptConversationRoute(`https://chatgpt.com/g/g-x/c/${UUID}`)).toBe(true);
    expect(isChatgptConversationRoute("https://example.com")).toBe(false);
  });
});
