import { getStateDir } from "../config/paths.js";
import {
  type FeedbackState,
  type PairingIntent,
} from "./schema.js";
import {
  recoverStaleInMemory,
  requireInitializedState,
  withFeedbackLock,
  writeState,
} from "./state-store.js";

export function putPairingIntent(input: {
  workspaceId: string;
  intent: PairingIntent;
  stateDir?: string;
}): FeedbackState {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const next: FeedbackState = { ...previous, pairingIntent: input.intent };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function mutateCompanionPairing<T>(
  workspaceId: string,
  stateDir: string,
  fn: (state: FeedbackState) => { state: FeedbackState; result: T },
): T {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) writeState(workspaceId, stateDir, recovered);
    const { state: next, result } = fn(recovered);
    if (next !== recovered) writeState(workspaceId, stateDir, next);
    return result;
  });
}
