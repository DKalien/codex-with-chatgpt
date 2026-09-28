/**
 * Session 稳定公开 facade。
 *
 * 领域实现位于 schema/conversation/store/operations；既有调用方继续从
 * 本模块导入，避免把持久化和会话策略耦合到 CLI/Web Control。
 */
export {
  webControlStateSchema,
  PROTOCOL_STATES,
  WAITING_FOR,
  PROJECT_CHATS_MAX,
  normalizeProjectChatEntry,
  normalizeProjectChats,
  parsePersistedProjectChats,
  validateProjectChatState,
  upsertProjectChat,
  removeProjectChatForFingerprint,
} from "./schema.js";
export type {
  WebControlState,
  ConversationMode,
  ConversationReason,
  ProtocolState,
  WaitingFor,
  TaskCheckpoint,
  SavedSession,
  SessionPatch,
  ProjectChatEntry,
  ProjectChatBinding,
} from "./schema.js";

export {
  projectChatOwnerFingerprint,
  currentCodexThreadId,
  projectChatForCurrentThread,
  projectChatBinding,
  conversationChatKnown,
  resolveThreadConversation,
  normalizeProjectUrl,
  projectIdFromUrl,
  resolveConversation,
} from "./conversation.js";
export type { ThreadConversationProjection, ConversationView } from "./conversation.js";

export { sessionFile, readSession, writeSession, updateSession } from "./store.js";

export { mergeSession, clearChatPointer } from "./operations.js";
