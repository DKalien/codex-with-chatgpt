import {
  isProjectChatFingerprint,
  normalizeProjectChatEntry,
  normalizeProjectChats,
  parsePersistedProjectChats,
  removeProjectChatForFingerprint,
  upsertProjectChat,
  PROTOCOL_STATES,
  WAITING_FOR,
  type SavedSession,
  type SessionPatch,
} from "./schema.js";
import {
  currentCodexThreadId,
  normalizeProjectUrl,
  projectChatOwnerFingerprint,
  resolveConversation,
} from "./conversation.js";
import { updateSession } from "./store.js";

const CHECKPOINT_LIMITS = {
  originalGoal: 500,
  completedSubtasks: 800,
  knownIssues: 800,
  nextExpectedStep: 400,
} as const;

function capCheckpointText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function mergeSession(previous: SavedSession | null, patch: SessionPatch): SavedSession {
  const conversationMode = patch.conversationMode ?? previous?.conversationMode;
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  let projectUrl = rawProjectUrl;
  if (rawProjectUrl) {
    const normalized = normalizeProjectUrl(rawProjectUrl);
    if (!normalized) {
      throw new Error("project URL must look like https://chatgpt.com/g/g-p-…/project");
    }
    projectUrl = normalized;
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const url = patch.url ?? previous?.url;
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(patch.taskId ?? previous?.taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && conversationMode !== "long-chat" && !hasTask && !hasCheckpoint) {
    throw new Error("nothing to save: pass --url, --project-url, or --mode");
  }

  let checkpoint = previous?.checkpoint;
  if (patch.clearCheckpoint) {
    checkpoint = undefined;
  } else if (patch.checkpoint) {
    const taskId = patch.checkpoint.taskId ?? patch.taskId ?? previous?.checkpoint?.taskId ?? previous?.taskId;
    const iteration =
      patch.checkpoint.iteration ??
      patch.iteration ??
      previous?.checkpoint?.iteration ??
      previous?.iteration ??
      0;
    const protocolState = patch.checkpoint.protocolState ?? previous?.checkpoint?.protocolState;
    if (!taskId || !protocolState) {
      throw new Error("checkpoint requires task id and protocol state");
    }
    if (!PROTOCOL_STATES.includes(protocolState)) {
      throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
    }
    const waitingFor = patch.checkpoint.waitingFor ?? previous?.checkpoint?.waitingFor ?? "none";
    if (!WAITING_FOR.includes(waitingFor)) {
      throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
    }
    checkpoint = {
      taskId,
      iteration,
      protocolState,
      waitingFor,
      originalGoal: capCheckpointText(
        patch.checkpoint.originalGoal ?? previous?.checkpoint?.originalGoal,
        CHECKPOINT_LIMITS.originalGoal
      ),
      completedSubtasks: capCheckpointText(
        patch.checkpoint.completedSubtasks ?? previous?.checkpoint?.completedSubtasks,
        CHECKPOINT_LIMITS.completedSubtasks
      ),
      knownIssues: capCheckpointText(
        patch.checkpoint.knownIssues ?? previous?.checkpoint?.knownIssues,
        CHECKPOINT_LIMITS.knownIssues
      ),
      nextExpectedStep: capCheckpointText(
        patch.checkpoint.nextExpectedStep ?? previous?.checkpoint?.nextExpectedStep,
        CHECKPOINT_LIMITS.nextExpectedStep
      ),
      chatUrl: patch.checkpoint.chatUrl ?? previous?.checkpoint?.chatUrl ?? url,
      projectUrl: patch.checkpoint.projectUrl ?? previous?.checkpoint?.projectUrl ?? projectUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  const isProjectMode = conversationMode === "project" || (Boolean(projectUrl) && conversationMode !== "long-chat");
  // Strict: corrupt persisted projectChats must throw before any merge write.
  const projectChats = parsePersistedProjectChats(previous?.projectChats) ?? [];
  let nextProjectChats = projectChats;
  let chatOwnerFingerprint = previous?.chatOwnerFingerprint
    ? (isProjectChatFingerprint(previous.chatOwnerFingerprint) ? previous.chatOwnerFingerprint.toLowerCase() : undefined)
    : undefined;

  if (conversationMode === "long-chat") {
    chatOwnerFingerprint = undefined;
  } else if (isProjectMode) {
    const stampedFp = isProjectChatFingerprint(patch.chatOwnerFingerprint)
      ? patch.chatOwnerFingerprint.toLowerCase()
      : null;
    const mapEntry = patch.projectChat
      ? normalizeProjectChatEntry(patch.projectChat)
      : (stampedFp && typeof patch.url === "string" && patch.url
        ? { ownerFingerprint: stampedFp, url: patch.url }
        : null);

    if (mapEntry) {
      const upserted = upsertProjectChat(nextProjectChats, mapEntry);
      if (!upserted.ok) {
        throw new Error("project chat map capacity reached; maintenance required before saving another thread chat");
      }
      nextProjectChats = upserted.list;
      chatOwnerFingerprint = mapEntry.ownerFingerprint;
    } else if (patch.url !== undefined) {
      chatOwnerFingerprint = undefined;
    }
  }

  return {
    url,
    title: patch.title ?? previous?.title,
    taskId: patch.taskId ?? previous?.taskId,
    iteration: patch.iteration ?? previous?.iteration,
    lastState: patch.lastState ?? previous?.lastState,
    conversationMode: conversationMode === "project" && projectUrl ? "project" : conversationMode,
    projectUrl,
    connectorName: patch.connectorName ?? previous?.connectorName,
    chatOwnerFingerprint,
    projectChats: nextProjectChats.length > 0 ? nextProjectChats : undefined,
    checkpoint,
    webControl: previous?.webControl,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Project + known current thread: remove only that thread's mapping.
 * Project + current thread unknown: never guess — clear only non-authoritative latest pointer.
 * Thread A clear must retain Thread B mappings.
 */
export function clearChatPointer(workspaceId: string): { cleared: boolean; keptProject: boolean } {
  let result = { cleared: false, keptProject: false };
  updateSession(workspaceId, (previous) => {
    if (!previous) return null;
    const view = resolveConversation(previous);
    const keptProject = view.mode === "project" && Boolean(view.projectUrl);
    result = { cleared: true, keptProject };
    const maps = normalizeProjectChats(previous.projectChats);
    let nextMaps = maps;
    let nextUrl: string | undefined;
    let nextLatestFp = previous.chatOwnerFingerprint;

    if (!keptProject && !previous.webControl) return null;

    if (keptProject) {
      const threadId = currentCodexThreadId();
      if (threadId) {
        const fp = projectChatOwnerFingerprint(workspaceId, threadId);
        const removal = removeProjectChatForFingerprint(maps, fp);
        nextMaps = removal.list;
        if (removal.removed) {
          // Clear compatibility pointer only if it pointed at this thread's chat.
          if (previous.url === removal.removed.url || previous.chatOwnerFingerprint === fp) {
            nextUrl = undefined;
            nextLatestFp = undefined;
          } else {
            nextUrl = previous.url;
          }
        } else {
          nextUrl = previous.url;
        }
      } else {
        // Unknown current thread: do not delete other threads' owner mappings.
        nextMaps = maps;
        nextUrl = undefined;
        nextLatestFp = undefined;
      }
    }

    return {
      conversationMode: keptProject ? ("project" as const) : previous.conversationMode,
      projectUrl: keptProject ? view.projectUrl! : previous.projectUrl,
      url: keptProject ? nextUrl : undefined,
      connectorName: previous.connectorName,
      checkpoint: keptProject ? previous.checkpoint : previous.checkpoint,
      chatOwnerFingerprint: keptProject ? nextLatestFp : undefined,
      projectChats: keptProject && nextMaps.length > 0 ? nextMaps : (keptProject ? undefined : previous.projectChats),
      webControl: previous.webControl ? { ...previous.webControl, enabled: false, status: "disabled" } : undefined,
      savedAt: new Date().toISOString(),
    };
  });
  return result;
}
