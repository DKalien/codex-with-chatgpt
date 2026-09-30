import { createHash, timingSafeEqual } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { readFeedbackState, type FeedbackState } from "../feedback/store.js";
import { isRouteAttestationVerified, type CompanionRecord } from "../feedback/schema.js";
import { WebSinkControlError } from "./schema.js";
import {
  bindCurrentWebSink,
  type ActiveWebSinkBindingResult,
} from "./service.js";
import { projectChatgptRouteToWebSinkCandidate } from "./chatgpt-surface.js";

function sha256Hex(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function hashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface WebSinkCompanionAuthContext {
  readonly workspaceId: string;
  readonly companionId: string;
  readonly routeCanonical: string;
  /** 传输层兼容元数据：来自 Companion record，不与 active Feedback receiver 校验。 */
  readonly bindingId: string;
  readonly epoch: number;
}

/**
 * Web Sink 专用 Companion 认证边界。
 *
 * 权威仅：
 * - 当前 active、非 superseded Companion
 * - credential hash exact match
 * - workspace exact
 * - verified exact route attestation
 *
 * 不要求 planner principal / Feedback receiver binding 相等。
 * 不削弱 R4 feedback 的 verifyCompanionCredential()。
 */
export function verifyCompanionCredentialForWebSink(input: {
  readonly workspaceId: string;
  readonly credential: string;
  readonly stateDir?: string;
}): WebSinkCompanionAuthContext {
  const stateDir = input.stateDir ?? getStateDir();
  let state: FeedbackState | null;
  try {
    state = readFeedbackState(input.workspaceId, stateDir);
  } catch {
    throw new WebSinkControlError("WEB_SINK_COMPANION_UNAVAILABLE", "companion 状态不可读。");
  }
  const companion: CompanionRecord | null = state?.companion ?? null;
  if (!companion || companion.supersededAt) {
    throw new WebSinkControlError("WEB_SINK_COMPANION_UNAUTHORIZED", "companion credential 无效或已撤销。");
  }
  if (!hashEqual(companion.credentialHash, sha256Hex(input.credential))) {
    throw new WebSinkControlError("WEB_SINK_COMPANION_UNAUTHORIZED", "companion credential 无效或已撤销。");
  }
  if (!isRouteAttestationVerified(companion)) {
    throw new WebSinkControlError("WEB_SINK_ROUTE_UNVERIFIED", "companion route 尚未 verified。");
  }
  const attestation = companion.routeAttestation;
  if (!attestation || attestation.routeCanonical !== companion.routeCanonical) {
    throw new WebSinkControlError("WEB_SINK_ROUTE_UNVERIFIED", "route attestation 与 companion route 不一致。");
  }
  return {
    workspaceId: state!.workspaceId,
    companionId: companion.companionId,
    routeCanonical: companion.routeCanonical,
    bindingId: companion.bindingId,
    epoch: companion.epoch,
  };
}

/**
 * Production bind-current：从 durable Feedback/Companion state 建立 Web Sink。
 * 调用方不得提供 FeedbackState 或 binding 元数据。
 */
export function bindCurrentWebSinkFromDurableCompanion(input: {
  readonly workspaceId: string;
  readonly credential: string;
  readonly routeCanonical: string;
  readonly stateDir?: string;
}): ActiveWebSinkBindingResult {
  const auth = verifyCompanionCredentialForWebSink({
    workspaceId: input.workspaceId,
    credential: input.credential,
    stateDir: input.stateDir,
  });
  const candidate = projectChatgptRouteToWebSinkCandidate({
    workspaceId: input.workspaceId,
    routeCanonical: input.routeCanonical,
  });
  if (candidate.canonicalUrl !== auth.routeCanonical) {
    throw new WebSinkControlError(
      "WEB_SINK_ROUTE_MISMATCH",
      "caller URL 与 verified durable route 不一致。",
    );
  }
  return bindCurrentWebSink(input.workspaceId, candidate);
}

/** 测试/纯函数路径：已验证 companion route 投影 candidate 并绑定。 */
export function bindCurrentWebSinkFromVerifiedCompanionRoute(input: {
  readonly workspaceId: string;
  readonly feedbackState: FeedbackState | null;
  readonly expectedRouteCanonical?: string;
}): ActiveWebSinkBindingResult {
  const state = input.feedbackState;
  if (!state || !state.companion) {
    throw new WebSinkControlError("WEB_SINK_ROUTE_UNVERIFIED", "当前没有可用的 Browser Companion route。");
  }
  if (state.workspaceId !== input.workspaceId) {
    throw new WebSinkControlError("WEB_SINK_WORKSPACE_MISMATCH", "companion state workspace 不匹配。");
  }
  const companion = state.companion;
  if (!isRouteAttestationVerified(companion)) {
    throw new WebSinkControlError("WEB_SINK_ROUTE_UNVERIFIED", "Browser Companion route 尚未 verified；拒绝绑定 Web Sink。");
  }
  const routeCanonical = companion.routeCanonical;
  if (input.expectedRouteCanonical !== undefined && input.expectedRouteCanonical !== routeCanonical) {
    throw new WebSinkControlError("WEB_SINK_ROUTE_MISMATCH", "caller URL 与 verified current route 不一致。");
  }
  const candidate = projectChatgptRouteToWebSinkCandidate({
    workspaceId: input.workspaceId,
    routeCanonical,
  });
  return bindCurrentWebSink(input.workspaceId, candidate);
}

export type { FeedbackState };
