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

  it("canonicalizes observed Project bare-id and slug aliases", () => {
    const projectId = "6aa296e634348191b441d56fdab23b7b";
    const bare = `https://chatgpt.com/g/g-p-${projectId}/c/${UUID}`;
    const slugged = `https://chatgpt.com/g/g-p-${projectId}-codex-with-chatgpt/c/${UUID}`;
    expect(normalizeChatgptConversationRoute(bare)).toBe(bare);
    expect(normalizeChatgptConversationRoute(slugged)).toBe(bare);
    expect(parseChatgptConversationRoute(slugged, { conversationIdPolicy: "uuid" }).gptId)
      .toBe(`g-p-${projectId}`);
  });

  it("keeps different Project ids and conversations distinct", () => {
    const project = "6aa296e634348191b441d56fdab23b7b";
    const otherProject = "7bb307f745459292c552e67efbc34c8c";
    const first = `https://chatgpt.com/g/g-p-${project}/c/${UUID}`;
    expect(normalizeChatgptConversationRoute(`https://chatgpt.com/g/g-p-${otherProject}-slug/c/${UUID}`)).not.toBe(first);
    expect(normalizeChatgptConversationRoute(`https://chatgpt.com/g/g-p-${project}-slug/c/22222222-2222-4222-8222-222222222222`)).not.toBe(first);
  });

  it("does not strip suffixes from ordinary g-* routes", () => {
    const raw = `https://chatgpt.com/g/g-6aa296e634348191b441d56fdab23b7b-codex-with-chatgpt/c/${UUID}`;
    expect(normalizeChatgptConversationRoute(raw)).toBe(raw);
  });

  it("does not treat malformed Project-like ids as aliases", () => {
    const raw = `https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7-codex-with-chatgpt/c/${UUID}`;
    expect(normalizeChatgptConversationRoute(raw)).toBe(raw);
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
