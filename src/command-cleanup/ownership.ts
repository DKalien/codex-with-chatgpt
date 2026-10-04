import { readDesktop } from "../desktop/store.js";

/** Lifecycle metadata only; never chooses an executor or a result sink. */
export function isEphemeralCommand(workspaceId: string, commandId: string, stateDir: string): boolean {
  // Current canonical production results require a trusted Desktop receipt.
  // A new dispatch wrapping an old accepted delivery must not promote legacy history.
  return readDesktop(workspaceId, stateDir)?.deliveries.some(item => item.commandId === commandId && item.lifecycle === "ephemeral") === true;
}
