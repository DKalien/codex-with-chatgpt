import { assertCleanupStoreFile } from "../command-cleanup/fence.js";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { FeedbackError, isRouteAttestationVerified, panelGrantSchema, type FeedbackState } from "./schema.js";
import { feedbackStateFile, readFeedbackStatusState, requireInitializedState, withFeedbackLock, writeState } from "./state-store.js";

export function changePanelState<T>(workspaceId: string, action: (state: FeedbackState) => T, stateDir = getStateDir()): T {
  assertCleanupStoreFile(feedbackStateFile(workspaceId, stateDir), stateDir);
  return withFeedbackLock(workspaceId, stateDir, read => {
    assertCleanupStoreFile(feedbackStateFile(workspaceId, stateDir), stateDir);
    const state = requireInitializedState(read(), workspaceId);
    const result = action(state);
    writeState(workspaceId, stateDir, state);
    return result;
  });
}

/** Local CLI only; never exposed through MCP or Companion HTTP. */
export function grantPanelActions(input: {
  workspaceId: string; companionId: string; localUser: boolean; minutes?: number; stateDir?: string;
}) {
  const minutes = input.minutes ?? 15;
  if (!input.localUser || !Number.isInteger(minutes) || minutes < 1 || minutes > 60)
    throw new FeedbackError("PANEL_LOCAL_AUTHORIZATION_REQUIRED", "需要本机明确授权，有效期 1–60 分钟。");
  return changePanelState(input.workspaceId, state => {
    const companion = state.companion, binding = state.binding;
    if (!companion || !isRouteAttestationVerified(companion) || companion.companionId !== input.companionId
      || binding?.status !== "active" || companion.bindingId !== binding.bindingId || companion.epoch !== binding.epoch
      || companion.principalFingerprint !== binding.principalFingerprint)
      throw new FeedbackError("PANEL_IDENTITY_CHANGED", "当前已验证 Companion/receiver 身份不匹配。");
    const grant = panelGrantSchema.parse({ grantId: randomUUID(), companionId: companion.companionId,
      bindingId: binding.bindingId, epoch: binding.epoch, routeCanonical: companion.routeCanonical,
      actions: ["cancel_command", "cancel_return", "requeue_return", "cleanup"], expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() });
    state.panelGrant = grant;
    return grant;
  }, input.stateDir);
}

export function revokePanelActions(workspaceId: string, localUser: boolean, stateDir?: string): void {
  if (!localUser) throw new FeedbackError("PANEL_LOCAL_AUTHORIZATION_REQUIRED", "需要本机明确撤销授权。");
  changePanelState(workspaceId, state => { delete state.panelGrant; }, stateDir);
}

export function readPanelAuthorization(workspaceId: string, stateDir?: string) {
  assertCleanupStoreFile(feedbackStateFile(workspaceId, stateDir), stateDir ?? getStateDir());
  const state = readFeedbackStatusState(workspaceId, stateDir), grant = state.panelGrant, companion = state.companion;
  const valid = !!grant && !!companion && isRouteAttestationVerified(companion) && state.binding?.status === "active"
    && grant.companionId === companion.companionId && grant.bindingId === companion.bindingId && grant.epoch === companion.epoch
    && grant.bindingId === state.binding.bindingId && grant.epoch === state.binding.epoch
    && companion.principalFingerprint === state.binding.principalFingerprint
    && grant.routeCanonical === companion.routeCanonical && Date.parse(grant.expiresAt) > Date.now();
  return { enabled: valid, companionId: companion?.companionId ?? null,
    expiresAt: valid ? grant!.expiresAt : null, actions: valid ? grant!.actions : [],
    pending: (state.panelOperations ?? []).filter(item => item.status === "pending").map(item => ({ requestId: item.requestId, commandId: item.commandId, action: item.action })),
  };
}
