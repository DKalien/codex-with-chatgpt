import { readResultBus } from "../result-bus/store.js";
import { withDeliveryArbiter, assertNoResultBusInFlight } from "./delivery-arbiter.js";
import { ensureFeedbackState, readFeedbackStatusState } from "../feedback/state-store.js";
import { assertNoInFlightDelivery } from "../feedback/companion-common.js";
import { readExecutionRecordsStrict } from "../execution/records.js";

/** Binding changes share the delivery arbiter, never command history/cleanup locks.
 * Receiver changes fence Bus in-flight; Companion changes preserve its frozen targets.
 * Legacy Feedback in-flight remains a fence until explicit lifecycle recovery.
 * Order: delivery arbiter -> Feedback store. No external work in this section.
 */
export function withConnectionMutation<T>(input: {
  workspaceId: string; workspaceRoot: string; stateDir?: string; initialize?: boolean; kind?: "receiver" | "companion";
}, action: () => T): T {
  return withDeliveryArbiter(input, identity => {
    // Companion pairing changes credentials, not canonical Bus ownership or frozen targets.
    // Preserve the independent Web Sink contract while validating existing Bus integrity.
    if (input.kind === "companion") readResultBus(identity, input.stateDir);
    else assertNoResultBusInFlight(input);
    assertNoInFlightDelivery(readFeedbackStatusState(input.workspaceId, input.stateDir));
    if (input.initialize) ensureFeedbackState(input.workspaceId,
      readExecutionRecordsStrict(input.workspaceId, input.stateDir).length, input.stateDir);
    return action();
  });
}
