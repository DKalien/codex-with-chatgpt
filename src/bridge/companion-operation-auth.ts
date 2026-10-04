import { verifyCompanionCredentialForWebSink } from "../web-sink-control/companion-adapter.js";
import { verifyCompanionCredentialReadOnly } from "../feedback/companion-delivery.js";
import { readFeedbackState } from "../feedback/state-store.js";
import { CompanionError } from "../feedback/companion-common.js";

export function authenticateOperations(input: { workspaceId: string; credential: string; stateDir?: string }) {
  const auth = verifyCompanionCredentialForWebSink(input);
  const ctx = verifyCompanionCredentialReadOnly(input);
  const binding = readFeedbackState(input.workspaceId, input.stateDir).binding;
  if (binding?.status !== "active" || binding.bindingId !== ctx.bindingId || binding.epoch !== ctx.epoch
      || binding.principalFingerprint !== ctx.principalFingerprint)
    throw new CompanionError("COMPANION_EPOCH_STALE", "当前 receiver 身份不匹配；无法查看或操作项目任务。");
  return { auth, ctx };
}
