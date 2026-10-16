import path from "node:path";
import { randomBytes } from "node:crypto";
import { C2CError } from "../errors.js";
import { getStateDir } from "../config/paths.js";
import { readJson, updateJson } from "../util/json-file.js";

interface CompanionState { token: string; conversations: Record<string, string> }

const file = () => path.join(getStateDir(), "companion.json");
const empty = (): CompanionState => ({ token: "", conversations: {} });

export function companionToken(opts?: { rotate?: boolean }): string {
  return updateJson(file(), empty(), (s) => {
    if (!s.token || opts?.rotate) s.token = randomBytes(32).toString("base64url");
    return s.token;
  });
}

function isConversationUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "chatgpt.com" || u.hostname === "www.chatgpt.com") && /\/c\/[\w-]+/.test(u.pathname); // 含项目对话 /g/<project>/c/<id>
  } catch {
    return false;
  }
}

export function setConversation(workspaceId: string, url: string | null): void {
  if (url !== null && !isConversationUrl(url)) throw new C2CError("INVALID_CONVERSATION_URL", "对话地址必须是 https://chatgpt.com/c/<id>");
  updateJson(file(), empty(), (s) => {
    s.conversations ??= {};
    if (url === null) delete s.conversations[workspaceId];
    else s.conversations[workspaceId] = url;
  });
}

export function getConversations(): Record<string, string> {
  return readJson(file(), empty()).conversations ?? {};
}
