import { readDesktop } from "../desktop/store.js";
import type { RoutingWorkspaceIdentity } from "./store.js";

export interface DesktopExecutorCandidate {
  kind: "executor";
  platform: "codex_desktop";
  conversationId: string;
  locator: { hostId: "local"; executorProjectId: string };
  /** Desktop bindingId 仅作 current target fence。 */
  legacyReferenceId: string;
}

/** Caller must validate the routing workspace identity before projecting Desktop state. */
export function projectDesktopExecutorCandidate(
  identity: RoutingWorkspaceIdentity,
): DesktopExecutorCandidate | null {
  try {
    const state = readDesktop(identity.id);
    const binding = state?.binding;
    if (!state || !binding || state.workspaceRoot !== identity.root) return null;
    return {
      kind: "executor",
      platform: "codex_desktop",
      conversationId: binding.threadId,
      locator: { hostId: binding.hostId, executorProjectId: binding.projectId },
      legacyReferenceId: binding.bindingId,
    };
  } catch {
    return null;
  }
}
