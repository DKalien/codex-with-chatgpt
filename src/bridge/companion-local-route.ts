import { createHmac, randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { withEndpointSwitchLock } from "../endpoint-switch/lock.js";
import { withDeliveryArbiter, assertNoResultBusInFlight } from "./delivery-arbiter.js";
import { readWebSinkControl } from "../web-sink-control/store.js";
import { readFeedbackState, requireInitializedState, withFeedbackLock, writeState } from "../feedback/state-store.js";
import { type FeedbackState, routeChallengeDigest } from "../feedback/schema.js";
import { CompanionError, assertNoInFlightDelivery, hashEqual, normalizeChatgptRoute, sha256Hex } from "../feedback/companion-common.js";

export const LOCAL_ROUTE_TTL_MS = 120_000;
type RequestRecord = NonNullable<FeedbackState["localRouteRequests"]>[number];
export type LocalRouteInput = {
  workspaceId: string; workspaceRoot: string; credential: string; requestId: string; stateDir?: string;
};
const reject = (code: string, message: string): never => { throw new CompanionError(code, message); };
const digest = (value: unknown) => sha256Hex(JSON.stringify(value));
const authority = (state: FeedbackState) => digest({ binding: state.binding, companion: state.companion });

function requireCurrent(state: FeedbackState, credential: string) {
  const companion = state.companion;
  if (!companion || companion.supersededAt || !hashEqual(companion.credentialHash, sha256Hex(credential))
    || state.binding?.status !== "active") reject("COMPANION_UNAUTHORIZED", "companion 或本机授权已撤销");
  return companion!;
}

function guarded<T>(input: LocalRouteInput, action: (state: FeedbackState) => { state: FeedbackState; result: T }): T {
  const stateDir = input.stateDir ?? getStateDir();
  requireCurrent(readFeedbackState(input.workspaceId, stateDir), input.credential);
  // 固定顺序：arbiter -> endpoint switch -> Feedback；弹窗不持有任何锁。
  return withDeliveryArbiter(input, () => withEndpointSwitchLock("web-sink", input.workspaceId, () => {
    assertNoResultBusInFlight(input);
    return withFeedbackLock(input.workspaceId, stateDir, read => {
      const state = requireInitializedState(read(), input.workspaceId);
      requireCurrent(state, input.credential);
      assertNoInFlightDelivery(state);
      const next = action(state);
      if (next.state !== state) writeState(input.workspaceId, stateDir, next.state);
      return next.result;
    });
  }, stateDir));
}

function recordFor(state: FeedbackState, input: LocalRouteInput): RequestRecord {
  const record = state.localRouteRequests?.find(item => item.requestId === input.requestId);
  if (!record || record.workspaceRoot !== input.workspaceRoot) return reject("LOCAL_ROUTE_UNKNOWN", "未找到本次本机确认请求");
  return record;
}
function assertUnchanged(state: FeedbackState, record: RequestRecord, input: LocalRouteInput): void {
  if (record.authoritySha256 !== authority(state) || record.sinkRevision !== (readWebSinkControl(input.workspaceId)?.revision ?? 0))
    reject("LOCAL_ROUTE_CHANGED", "确认期间 companion、receiver 或当前 Web Sink 已变化，请重新发起连接");
}
function replace(state: FeedbackState, record: RequestRecord): FeedbackState {
  return { ...state, localRouteRequests: state.localRouteRequests!.map(item => item.requestId === record.requestId ? record : item) };
}
function credentialFor(previousCredential: string, record: RequestRecord): string {
  return `c2c_comp_${createHmac("sha256", previousCredential).update(JSON.stringify([
    "c2c-local-route-v1", record.workspaceRoot, record.requestId, record.companionId, record.challengeId,
  ])).digest("base64url")}`;
}
function project(input: LocalRouteInput, state: FeedbackState, record: RequestRecord) {
  const expired = Date.parse(record.expiresAt) <= Date.now();
  const status = expired ? "EXPIRED" as const : record.status;
  let pairing;
  if (status === "COMMITTED" || status === "CONFIRMED") {
    const companion = state.companion!;
    const credential = hashEqual(sha256Hex(input.credential), record.previousCredentialHash)
      ? credentialFor(input.credential, record) : input.credential;
    if (status === "COMMITTED" && !hashEqual(sha256Hex(credential), companion.credentialHash)) reject("COMPANION_UNAUTHORIZED", "恢复凭据无效");
    pairing = { credential, companionId: record.companionId, bindingId: companion.bindingId,
      epoch: companion.epoch, challengeId: record.challengeId, routeVerification: "VERIFIED" as const,
      workspaceId: input.workspaceId, routeCanonical: record.routeCanonical };
  }
  return { requestId: record.requestId, state: status, workspaceId: input.workspaceId,
    routeCanonical: record.routeCanonical, expiresAt: record.expiresAt, ...(pairing ? status === "CONFIRMED" ? { candidatePairing: pairing } : { pairing } : {}) };
}

/** 只读恢复；旧 credential 仅在短期内读取 exact successor，不能用于一般 /state。 */
export function localRouteStatus(input: LocalRouteInput) {
  const state = readFeedbackState(input.workspaceId, input.stateDir);
  const record = recordFor(state, input);
  const companion = state.companion;
  if (!companion || companion.supersededAt || state.binding?.status !== "active"
    || digest(state.binding) !== record.bindingSha256
    || ![record.previousCredentialHash, companion.credentialHash].some(hash => hashEqual(hash, sha256Hex(input.credential))))
    return reject("COMPANION_UNAUTHORIZED", "请求授权已失效");
  if (record.status === "COMMITTED") {
    if (companion.companionId !== record.companionId || companion.routeCanonical !== record.routeCanonical
      || companion.routeAttestation?.challengeId !== record.challengeId || companion.routeAttestation.proofKind !== "local_user")
      return reject("COMPANION_UNAUTHORIZED", "本次 successor 已失效");
  } else {
    requireCurrent(state, input.credential);
    assertUnchanged(state, record, input);
  }
  return project(input, state, record);
}

/** 只登记单次请求；调用方仅在 created=true 后启动本机确认。 */
// ponytail: 每个现存 authority 最多保留100个申请；只有旧authority过期记录可回收。
function retainedRequests(state: FeedbackState) {
  return (state.localRouteRequests ?? []).filter(record => Date.parse(record.expiresAt) > Date.now()
    || record.previousCompanionId === state.companion?.companionId);
}
export function requestLocalRoute(input: LocalRouteInput & { routeCanonical: string }) {
  const route = normalizeChatgptRoute(input.routeCanonical);
  const existing = retainedRequests(readFeedbackState(input.workspaceId, input.stateDir)).find(item => item.requestId === input.requestId);
  if (existing) {
    if (existing.routeCanonical !== route) return reject("LOCAL_ROUTE_CHANGED", "requestId 已用于另一个 URL");
    return { created: false, response: localRouteStatus(input) };
  }
  return guarded(input, previous => {
    const state = { ...previous, localRouteRequests: retainedRequests(previous) };
    if (state.localRouteRequests?.some(item => item.requestId === input.requestId)) return reject("LOCAL_ROUTE_REPLAY", "请求已登记");
    if (state.localRouteRequests?.some(item => ["PENDING", "CONFIRMED"].includes(item.status) && Date.parse(item.expiresAt) > Date.now()))
      return reject("LOCAL_ROUTE_BUSY", "已有本机确认正在进行");
    if ((state.localRouteRequests?.length ?? 0) >= 100) return reject("LOCAL_ROUTE_LEDGER_FULL", "本机确认记录已达上限，请维护记录后重试");
    const now = Date.now();
    const record: RequestRecord = {
      requestId: input.requestId, workspaceRoot: input.workspaceRoot, routeCanonical: route,
      previousCompanionId: state.companion!.companionId, previousCredentialHash: state.companion!.credentialHash,
      bindingSha256: digest(state.binding), authoritySha256: authority(state),
      sinkRevision: readWebSinkControl(input.workspaceId)?.revision ?? 0,
      companionId: randomUUID(), challengeId: randomUUID(), createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LOCAL_ROUTE_TTL_MS).toISOString(), status: "PENDING",
    };
    const next = { ...state, localRouteRequests: [...(state.localRouteRequests ?? []), record] };
    return { state: next, result: { created: true, response: project(input, next, record) } };
  });
}

export function finishLocalRouteConfirmation(input: LocalRouteInput, confirmed: boolean): void {
  guarded(input, state => {
    const record = recordFor(state, input);
    assertUnchanged(state, record, input);
    if (record.status !== "PENDING") return reject("LOCAL_ROUTE_REPLAY", "本机确认已经结束");
    const accepted = confirmed && Date.parse(record.expiresAt) > Date.now();
    return { state: replace(state, { ...record, status: accepted ? "CONFIRMED" : "CANCELLED",
      ...(accepted ? { confirmedAt: new Date().toISOString() } : {}) }), result: undefined };
  });
}

export function commitLocalRoute(input: LocalRouteInput & { routeCanonical: string }) {
  const route = normalizeChatgptRoute(input.routeCanonical);
  return guarded(input, state => {
    const record = recordFor(state, input);
    if (record.status === "COMMITTED") return reject("LOCAL_ROUTE_REPLAY", "请求已消费；只能查询状态");
    if (Date.parse(record.expiresAt) <= Date.now()) return reject("LOCAL_ROUTE_EXPIRED", "本机确认已过期");
    if (record.status !== "CONFIRMED" || !record.confirmedAt) return reject("LOCAL_ROUTE_NOT_CONFIRMED", "尚未取得本机确认");
    if (record.routeCanonical !== route) return reject("LOCAL_ROUTE_CHANGED", "提交 URL 与本机确认不一致");
    assertUnchanged(state, record, input);
    const previous = state.companion!;
    const credential = credentialFor(input.credential, record);
    const companion = { ...previous, companionId: record.companionId, credentialHash: sha256Hex(credential),
      routeCanonical: route, pairedAt: new Date().toISOString(), routeAttestation: {
        status: "verified" as const, proofKind: "local_user" as const, challengeId: record.challengeId,
        challengeDigest: routeChallengeDigest({ workspaceId: input.workspaceId, bindingId: previous.bindingId,
          epoch: previous.epoch, companionId: record.companionId, routeCanonical: route, challengeId: record.challengeId }),
        routeCanonical: route, expiresAt: record.expiresAt, verifiedAt: record.confirmedAt, consumedAt: new Date().toISOString(),
      } };
    const completed = { ...record, status: "COMMITTED" as const };
    const next = { ...replace(state, completed), companion, pairingIntent: null, rebindIntent: null,
      rebindPredecessor: null, panelGrant: undefined };
    return { state: next, result: project(input, next, completed) };
  });
}
