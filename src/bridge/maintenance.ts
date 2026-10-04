import { projectAvailableResultBusCommands } from "../result-bus/service.js";
import { recoverStaleResultBusEntries } from "../result-bus/delivery-lifecycle.js";
import { reconcileResultBusCutover } from "./result-bus-delivery.js";
import { getStateDir } from "../config/paths.js";
import { resumeWorkspaceCommandCleanups } from "../command-cleanup/service.js";
import { readFeedbackStatusState } from "../feedback/state-store.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";
import { withDeliveryArbiter } from "./delivery-arbiter.js";

/** One bounded batch per tick, no external actions and no new state on pristine workspaces.
 * Delivery arbiter -> command lifecycle -> cleanup -> stores. The timer holds no lock
 * between ticks; unknown/corrupt command authority is reported, never reclaimed here.
 */
export function createWorkspaceMaintenance(identity: { id: string; root: string }, stateDir = getStateDir()) {
  let after: string | undefined, projectionAfter: string | undefined;
  return () => withDeliveryArbiter({ workspaceId: identity.id, workspaceRoot: identity.root, stateDir }, () => {
    const cleanup = resumeWorkspaceCommandCleanups(identity, stateDir, { limit: 10, after });
    after = cleanup.next;
    const state = readFeedbackStatusState(identity.id, stateDir);
    if (!state.binding && !state.companion) return { cleanup, projected: 0 };
    const projection = projectAvailableResultBusCommands(identity, stateDir, { limit: 25, after: projectionAfter });
    projectionAfter = projection.next;
    recoverStaleResultBusEntries(identity, {}, stateDir);
    let legacyPending = false, projected = 0;
    try { projected = reconcileFeedbackOutbox(identity.id, stateDir, identity.root, 25).projected; }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "COMMAND_CLEANUP_BUSY" && code !== "COMMAND_CLEANUP_IN_PROGRESS") throw error;
      legacyPending = true;
    }
    reconcileResultBusCutover({ identity, stateDir, maintenanceOnly: true });
    return { cleanup, projected: projected + projection.projected, legacyPending, skipped: projection.skipped.length };
  });
}
