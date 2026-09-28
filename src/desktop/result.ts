export {
  DesktopResultError,
  DesktopResultPendingError,
  desktopResultInput,
  type DesktopResultInput,
  type DesktopResultReceipt,
  type DesktopResultWorkspace,
} from "./result-schema.js";
export { discoverCurrentDesktopDelivery } from "./result-evidence.js";
export { finalizeReceiptFinalizationDraft } from "./result-finalization.js";
export { recordDesktopResult } from "./result-record.js";
export type { CurrentDesktopDelivery } from "./result-schema.js";
