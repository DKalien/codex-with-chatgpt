/**
 * E1b3b send capability — NOT runtime-loaded.
 * Re-exports write (composer-write-adapter) and click (send-click-adapter)
 * for existing pure tests / API compatibility.
 *
 * Runtime loads: composer-write-adapter.js + send-click-adapter.js only.
 * send-orchestrator.js stays inert.
 */

export {
  inspectComposerWriteCapability,
  writeCanonicalMessage,
  verifyCanonicalComposer,
  readCanonicalComposerText,
} from "./composer-write-adapter.js";

export { dispatchNativeSend } from "./send-click-adapter.js";
