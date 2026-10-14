import { describe, expect, it } from "vitest";
import { areChatgptConversationRoutesEquivalent } from "../src/chatgpt/route.js";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "6aa296e634348191b441d56fdab23b7b";
const ROUTE = `https://chatgpt.com/g/g-p-${PROJECT}/c/${CONVERSATION}`;
const ROUTE_ALIAS = `https://www.chatgpt.com/g/g-p-${PROJECT}-codex-with-chatgpt/c/${CONVERSATION}/`;
const OTHER_ROUTE = `https://chatgpt.com/g/g-p-${PROJECT}/c/99999999-9999-4999-8999-999999999999`;
describe("conversation route aliases", () => {
  it("accepts equivalent aliases and rejects a different conversation", () => {
    expect(areChatgptConversationRoutesEquivalent(ROUTE, ROUTE_ALIAS)).toBe(true);
    expect(areChatgptConversationRoutesEquivalent(ROUTE, OTHER_ROUTE)).toBe(false);
  });
});
