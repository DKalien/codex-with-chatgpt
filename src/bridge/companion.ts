import { requestLocalRoute, finishLocalRouteConfirmation, commitLocalRoute, localRouteStatus } from "./companion-local-route.js";
import { confirmLocalRoute } from "../feedback/local-route-confirm.js";
import { authenticateOperations } from "./companion-operation-auth.js";
import { previewPanelAction, confirmPanelAction, reconcilePanelAction } from "./companion-actions.js";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import {
  companionAckObserved,
  companionBeginSend,
  companionPublicState,
  companionRelease,
  companionReserveNext,
  companionRetireOutcomeUnknown,
  companionRebindStatus,
  completeCompanionRebind,
  exchangePairingIntent,
  initiateCompanionRebind,
  verifyCompanionCredential,
  type CompanionAuthContext,
} from "../feedback/companion.js";
import { CompanionError } from "../feedback/companion.js";
import { FeedbackError } from "../feedback/store.js";
import { CommandCleanupError } from "../command-cleanup/schema.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";
import { bindCurrentWebSinkFromDurableCompanion, verifyCompanionCredentialForWebSink } from "../web-sink-control/companion-adapter.js";
import { WebSinkControlError } from "../web-sink-control/schema.js";
import { webSinkStatus, readActiveWebSinkBinding } from "../web-sink-control/service.js";
import { readFeedbackState } from "../feedback/store.js";
import { isWebSinkRouteVerified } from "../feedback/schema.js";
import { routingCommandIdSchema } from "../routing/schema.js";
import { withConnectionMutation } from "./connection.js";
import { readCompanionOperations } from "./companion-operations.js";
import {
  ResultBusCutoverError,
  ResultBusDeliveryError,
  resultBusCompanionAck,
  resultBusCompanionBeginSend,
  resultBusCompanionIsolate,
  resultBusCompanionRelease,
  resultBusCompanionReserve,
  resultBusCompanionResult,
  resultBusCompanionTerminalGone,
  resultBusCompanionRetire,
  resultBusCompanionState,
} from "./result-bus-delivery.js";

const pairBodySchema = z.object({
  intentId: z.string().uuid(),
  secret: z.string().min(8).max(256),
  routeCanonical: z.string().min(1).max(512),
}).strict();

const routeBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
}).strict();

const rebindCompleteBodySchema = z.object({
  challengeId: z.string().uuid(),
  routeCanonical: z.string().min(1).max(512),
}).strict();

const rebindStatusQuerySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  challengeId: z.string().uuid(),
}).strict();

const releaseBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  reservationId: z.string().uuid(),
}).strict();

const beginSendBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  reservationId: z.string().uuid(),
}).strict();

const ackBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  attemptId: z.string().uuid(),
  terminalWitness: z.string().min(1).max(4096).optional(),
}).strict();

const retireUnknownBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  reservationId: z.string().uuid(),
  attemptId: z.string().uuid(),
}).strict();

const isolateAttemptBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  reservationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  messageSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const terminalGoneBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  attemptId: z.string().uuid(),
  terminalWitness: z.string().min(1).max(4096),
}).strict();

const companionResultQuerySchema = z.object({
  commandId: routingCommandIdSchema,
  iteration: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger),
}).strict();

const webSinkBindCurrentBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
}).strict();

function sendError(res: Response, error: unknown): void {
  if (error && typeof error === "object" && "panelNoMutation" in error && error.panelNoMutation === true) {
    res.status(409).json({ error: (error as { code?: string }).code ?? "PANEL_ACTION_REJECTED", noMutation: true, requestId: (error as { panelRequestId?: string }).panelRequestId });
    return;
  }
  if (error instanceof ResultBusCutoverError) {
    res.status(409).json({ error: error.code, stage: "result_bus_cutover" });
    return;
  }
  if (error instanceof CommandCleanupError) {
    res.status(409).json({ error: error.code, stage: "command_lifecycle",
      ...(error.commandId ? { commandId: error.commandId } : {}) });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "COMPANION_VALIDATION",
      message: "request body validation failed",
    });
    return;
  }
  if (error instanceof WebSinkControlError) {
    const status = error.code === "WEB_SINK_COMPANION_UNAUTHORIZED"
      || error.code === "WEB_SINK_COMPANION_UNAVAILABLE"
      && error.message.includes("缺少")
      ? 401
      : error.code === "WEB_SINK_ROUTE_UNVERIFIED"
        ? 409
        : error.code === "WEB_SINK_ROUTE_MISMATCH"
          ? 400
          : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof CompanionError || error instanceof FeedbackError) {
    const status = error.code.startsWith("LOCAL_ROUTE_")
      || error.code === "COMPANION_REPAIR_BLOCKED"
      || error.code === "COMPANION_ROUTE_UNVERIFIED"
      || error.code === "COMPANION_REBIND_NOT_CONFIRMED"
      || error.code === "COMPANION_REBIND_NOT_SUCCESSOR"
      || error.code === "COMPANION_REBIND_ALREADY_INITIATED"
      || error.code === "RESULT_BUS_LEGACY_DRAIN_REQUIRED"
      ? 409
      : error.code === "FEEDBACK_INFLIGHT_FENCE"
        || error.code === "FEEDBACK_RESERVED_FENCE"
        ? 409
        : error.code === "FEEDBACK_NO_READY_EVENT"
          ? 404
          : error.code === "FEEDBACK_NOT_ENABLED"
            ? 503
            : error.code === "COMPANION_UNAUTHORIZED"
              || error.code === "COMPANION_EPOCH_STALE"
              || error.code === "COMPANION_REBIND_INVALID"
              || error.code === "COMPANION_REBIND_EXPIRED"
              || error.code.startsWith("PAIRING_")
              ? 401
              : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof ResultBusDeliveryError) {
    const status = error.code === "RESULT_BUS_STALE_RESERVATION"
      || error.code === "COMMAND_CLEANUP_BUSY"
      || error.code === "RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT"
      || error.code === "RESULT_BUS_DELIVERY_ID_CONFLICT"
      || error.code === "RESULT_BUS_CONFLICT"
      || error.code === "RESULT_BUS_ATTEMPT_MISMATCH"
      || error.code === "RESULT_BUS_ISOLATION_UNSUPPORTED"
      || error.code === "COMPANION_RESULT_HISTORICAL_REFUSED"
      || error.code === "COMPANION_TERMINAL_WITNESS_INVALID"
      || error.code === "RESULT_BUS_LEGACY_DRAIN_REQUIRED"
      ? 409
      : error.code === "COMPANION_RESULT_NOT_FOUND"
        ? 404
      : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: "COMPANION_INTERNAL", message: "internal error" });
}

function bearerCredential(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export interface CompanionRouterOptions {
  workspaceId: string;
  workspaceRoot?: string;
  stateDir?: string;
}

/**
 * 窄公共 companion 合同。不使用 Bridge admin token，不代理 MCP/Desktop。
 * Production 经 named tunnel 暴露；localhost 仅开发/测试。
 */
export function createCompanionRouter(opts: CompanionRouterOptions): Router {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  const auth = (req: Request): CompanionAuthContext => {
    const credential = bearerCredential(req);
    if (!credential) {
      throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
    }
    return verifyCompanionCredential({
      workspaceId: opts.workspaceId,
      credential,
      stateDir: opts.stateDir,
    });
  };

  const connection = <T>(action: () => T): T => opts.workspaceRoot
    ? withConnectionMutation({ ...opts, workspaceRoot: opts.workspaceRoot, kind: "companion" }, action) : action();

  const localRouteBody = z.object({ requestId: z.string().uuid(), routeCanonical: z.string().min(1).max(512) }).strict();
  const localInput = (req: Request, requestId: string) => {
    const credential = bearerCredential(req);
    if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
    if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
    return { ...opts, workspaceRoot: opts.workspaceRoot, credential, requestId };
  };
  router.post("/route/local/request", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = localRouteBody.parse(req.body);
      const input = { ...localInput(req, body.requestId), routeCanonical: body.routeCanonical };
      const result = requestLocalRoute(input);
      res.status(result.created ? 202 : 200).json(result.response);
      if (result.created) {
        void confirmLocalRoute({ workspaceId: opts.workspaceId, workspaceRoot: input.workspaceRoot,
          routeCanonical: result.response.routeCanonical }).then(confirmed => {
          finishLocalRouteConfirmation(input, confirmed);
        }).catch(() => { /* 撤权、漂移、进程错误保留单次 pending，最终到期；绝不重弹或自动提交。 */ });
      }
    } catch (error) { sendError(res, error); }
  });
  router.get("/route/local/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const query = z.object({ requestId: z.string().uuid() }).strict().parse(req.query);
      res.json(localRouteStatus(localInput(req, query.requestId)));
    } catch (error) { sendError(res, error); }
  });
  router.post("/route/local/commit", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = localRouteBody.parse(req.body);
      res.json(commitLocalRoute({ ...localInput(req, body.requestId), routeCanonical: body.routeCanonical }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/pair", (req, res) => {
    try {
      const body = pairBodySchema.parse(req.body);
      const result = connection(() => exchangePairingIntent({
        workspaceId: opts.workspaceId,
        intentId: body.intentId,
        secret: body.secret,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      }));
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/rebind/init", (req, res) => {
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少旧 companion credential");
      }
      const body = routeBodySchema.parse(req.body);
      res.json(connection(() => initiateCompanionRebind({
        workspaceId: opts.workspaceId,
        credential,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      })));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/rebind/complete", (req, res) => {
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少旧 companion credential");
      }
      const body = rebindCompleteBodySchema.parse(req.body);
      res.json(connection(() => completeCompanionRebind({
        workspaceId: opts.workspaceId,
        credential,
        challengeId: body.challengeId,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      })));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/rebind/status", (req, res) => {
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少旧 companion credential");
      }
      const query = rebindStatusQuerySchema.parse(req.query);
      res.json(companionRebindStatus({
        workspaceId: opts.workspaceId,
        credential,
        routeCanonical: query.routeCanonical,
        challengeId: query.challengeId,
        stateDir: opts.stateDir,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/operations", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
      res.json(await readCompanionOperations({ workspaceId: opts.workspaceId, workspaceRoot: opts.workspaceRoot,
        credential, stateDir: opts.stateDir }));
    } catch (error) { sendError(res, error); }
  });

  router.post("/operations/reconcile", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
      const body = z.object({ requestId: z.string().uuid() }).strict().parse(req.body);
      res.json(reconcilePanelAction({ ...opts, workspaceRoot: opts.workspaceRoot, credential }, body.requestId));
    } catch (error) { sendError(res, error); }
  });

  router.get("/operations/result", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      const canonicalQuery = companionResultQuerySchema.safeParse(req.query);
      if (canonicalQuery.success) {
        if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
        res.json(resultBusCompanionResult({ ...opts, workspaceRoot: opts.workspaceRoot, credential,
          commandId: canonicalQuery.data.commandId, iteration: canonicalQuery.data.iteration }));
        return;
      }
      authenticateOperations({ ...opts, credential });
      const query = z.object({ requestId: z.string().uuid() }).strict().parse(req.query);
      const operation = readFeedbackState(opts.workspaceId, opts.stateDir).panelOperations?.find(item => item.requestId === query.requestId);
      res.json({ requestId: query.requestId, status: operation?.status ?? "unknown" });
    } catch (error) { sendError(res, error); }
  });

  router.post("/operations/terminal-gone", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = terminalGoneBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
      const response = resultBusCompanionTerminalGone({ ...opts, workspaceRoot: opts.workspaceRoot, credential, ...body });
      res.status(response.status === "still_present" ? 409 : 200).json(response);
    } catch (error) { sendError(res, error); }
  });

  for (const action of ["preview", "confirm"] as const) router.post(`/operations/${action}`, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
      const body = action === "preview" ? z.object({ request: z.unknown() }).strict().parse(req.body)
        : z.object({ request: z.unknown(), confirmationSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      const input = { ...opts, workspaceRoot: opts.workspaceRoot, credential };
      res.json(action === "preview" ? previewPanelAction(input, body.request)
        : confirmPanelAction(input, body.request, (body as { confirmationSha256: string }).confirmationSha256));
    } catch (error) { sendError(res, error); }
  });

  router.get("/state", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      // R5d3 review-fix：Bus canonical 路径只需 Web Sink Companion 认证，
      // 不要求 active Feedback receiver binding/principal。
      const webSink = (() => {
        try {
          return { ok: true as const, ctx: verifyCompanionCredentialForWebSink({ workspaceId: opts.workspaceId, credential, stateDir: opts.stateDir }) };
        } catch {
          return { ok: false as const };
        }
      })();
      if (webSink.ok && opts.workspaceRoot) {
        // Adapter isolates optional legacy enrichment from strict canonical authority.
        res.json(resultBusCompanionState({
          workspaceId: opts.workspaceId,
          workspaceRoot: opts.workspaceRoot,
          credential,
          stateDir: opts.stateDir,
        }));
        return;
      }
      // pairing/legacy-only 阶段：完整 legacy 视图（含 pending attestation）。
      const ctx = auth(req);
      res.json(companionPublicState({
        workspaceId: opts.workspaceId,
        ctx,
        stateDir: opts.stateDir,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/reserve", (req, res) => {
    try {
      const body = routeBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      if (opts.workspaceRoot) {
        // R5d3 final-fix：auth-first——adapter 先建立认证边界（无效 credential 401），
        // 之后才执行 projector/cutover reconcile 与 reserve/fallback；
        // 路由层不再 pre-auth reconcile。
        const result = resultBusCompanionReserve({
          workspaceId: opts.workspaceId,
          workspaceRoot: opts.workspaceRoot!,
          credential,
          routeCanonical: body.routeCanonical,
          stateDir: opts.stateDir,
        });
        res.json({ reservationId: result.reservationId, delivery: result.delivery });
        return;
      }
      // legacy 非 canonical/control 路径：Feedback receiver 认证 + attestation 门禁。
      const ctx = auth(req);
      reconcileFeedbackOutbox(opts.workspaceId, opts.stateDir, opts.workspaceRoot);
      const legacy = companionReserveNext({
        workspaceId: opts.workspaceId,
        ctx,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      });
      res.json({ reservationId: legacy.reservationId, delivery: legacy.delivery });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/release", (req, res) => {
    try {
      const body = releaseBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      if (!opts.workspaceRoot) {
        const ctx = auth(req);
        const event = companionRelease({
          workspaceId: opts.workspaceId,
          ctx,
          routeCanonical: body.routeCanonical,
          eventId: body.eventId,
          reservationId: body.reservationId,
          stateDir: opts.stateDir,
        });
        res.json({ eventId: event.eventId, status: event.status });
        return;
      }
      const result = resultBusCompanionRelease({
        workspaceId: opts.workspaceId,
        workspaceRoot: opts.workspaceRoot,
        credential,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        reservationId: body.reservationId,
        stateDir: opts.stateDir,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/begin-send", (req, res) => {
    try {
      const body = beginSendBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      if (!opts.workspaceRoot) {
        const ctx = auth(req);
        const legacy = companionBeginSend({
          workspaceId: opts.workspaceId,
          ctx,
          routeCanonical: body.routeCanonical,
          eventId: body.eventId,
          reservationId: body.reservationId,
          stateDir: opts.stateDir,
        });
        res.json({
          eventId: legacy.event.eventId,
          status: legacy.event.status,
          attemptId: legacy.attemptId,
          message: legacy.message,
          messageSha256: legacy.messageSha256,
        });
        return;
      }
      const result = resultBusCompanionBeginSend({
        workspaceId: opts.workspaceId,
        workspaceRoot: opts.workspaceRoot,
        credential,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        reservationId: body.reservationId,
        stateDir: opts.stateDir,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/ack", (req, res) => {
    try {
      const body = ackBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      if (!opts.workspaceRoot) {
        const ctx = auth(req);
        const event = companionAckObserved({
          workspaceId: opts.workspaceId,
          ctx,
          routeCanonical: body.routeCanonical,
          eventId: body.eventId,
          attemptId: body.attemptId,
          stateDir: opts.stateDir,
        });
        res.json({ eventId: event.eventId, status: event.status });
        return;
      }
      const result = resultBusCompanionAck({
        workspaceId: opts.workspaceId,
        workspaceRoot: opts.workspaceRoot,
        credential,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        attemptId: body.attemptId,
        terminalWitness: body.terminalWitness,
        stateDir: opts.stateDir,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/retire-unknown", (req, res) => {
    try {
      const body = retireUnknownBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) {
        throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      if (!opts.workspaceRoot) {
        const ctx = auth(req);
        const event = companionRetireOutcomeUnknown({
          workspaceId: opts.workspaceId,
          ctx,
          routeCanonical: body.routeCanonical,
          eventId: body.eventId,
          reservationId: body.reservationId,
          attemptId: body.attemptId,
          stateDir: opts.stateDir,
        });
        res.json({
          eventId: event.eventId,
          reservationId: event.reservationId,
          attemptId: event.attemptId,
          status: event.status,
        });
        return;
      }
      const result = resultBusCompanionRetire({
        workspaceId: opts.workspaceId,
        workspaceRoot: opts.workspaceRoot,
        credential,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        reservationId: body.reservationId,
        attemptId: body.attemptId,
        stateDir: opts.stateDir,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/isolate-attempt", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = isolateAttemptBodySchema.parse(req.body);
      const credential = bearerCredential(req);
      if (!credential) throw new CompanionError("COMPANION_UNAUTHORIZED", "缺少 companion credential");
      if (!opts.workspaceRoot) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace root 不可用");
      res.json(resultBusCompanionIsolate({ ...opts, workspaceRoot: opts.workspaceRoot, credential, ...body }));
    } catch (error) { sendError(res, error); }
  });

  router.get("/web-sink/status", (req, res) => {
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new WebSinkControlError("WEB_SINK_COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      verifyCompanionCredentialForWebSink({
        workspaceId: opts.workspaceId,
        credential,
        stateDir: opts.stateDir,
      });
      let companionRouteCanonical: string | null = null;
      let companionVerified = false;
      let companionAvailable = false;
      try {
        const feedback = readFeedbackState(opts.workspaceId, opts.stateDir);
        const companion = feedback?.companion ?? null;
        if (companion && !companion.supersededAt) {
          companionAvailable = true;
          companionRouteCanonical = companion.routeCanonical;
          companionVerified = isWebSinkRouteVerified(companion);
        }
      } catch {
        companionAvailable = false;
      }
      void webSinkStatus(opts.workspaceId, {
        companionRouteCanonical,
        companionVerified,
        companionAvailable,
      }).then((status) => {
        const b = status.activeBinding;
        res.json({
          workspaceId: opts.workspaceId,
          activeBinding: b
            ? {
                bindingId: b.bindingId,
                pluginId: b.pluginId,
                surfaceId: b.surfaceId,
                workspaceId: b.workspaceId,
                canonicalUrl: b.canonicalUrl,
                epoch: b.epoch,
                boundAt: b.boundAt,
              }
            : null,
          availability: status.availability,
        });
      }).catch((error) => sendError(res, error));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/web-sink/bind-current", (req, res) => {
    try {
      const credential = bearerCredential(req);
      if (!credential) {
        throw new WebSinkControlError("WEB_SINK_COMPANION_UNAUTHORIZED", "缺少 companion credential");
      }
      const body = webSinkBindCurrentBodySchema.parse(req.body);
      const result = bindCurrentWebSinkFromDurableCompanion({
        workspaceId: opts.workspaceId,
        credential,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      });
      const b = result.binding;
      res.json({
        workspaceId: opts.workspaceId,
        activeBinding: {
          bindingId: b.bindingId,
          pluginId: b.pluginId,
          surfaceId: b.surfaceId,
          workspaceId: b.workspaceId,
          canonicalUrl: b.canonicalUrl,
          epoch: b.epoch,
          boundAt: b.boundAt,
        },
        created: result.created,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
