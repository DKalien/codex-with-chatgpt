import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import {
  companionAckObserved,
  companionBeginSend,
  companionPublicState,
  companionRelease,
  companionReserveNext,
  companionRetireOutcomeUnknown,
  completeCompanionRebind,
  exchangePairingIntent,
  initiateCompanionRebind,
  verifyCompanionCredential,
  type CompanionAuthContext,
} from "../feedback/companion.js";
import { CompanionError } from "../feedback/companion.js";
import { FeedbackError } from "../feedback/store.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";

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
}).strict();

const retireUnknownBodySchema = z.object({
  routeCanonical: z.string().min(1).max(512),
  eventId: z.string().regex(/^[a-f0-9]{32}$/),
  reservationId: z.string().uuid(),
  attemptId: z.string().uuid(),
}).strict();

function sendError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "COMPANION_VALIDATION",
      message: "request body validation failed",
    });
    return;
  }
  if (error instanceof CompanionError || error instanceof FeedbackError) {
    const status = error.code === "COMPANION_REPAIR_BLOCKED"
      || error.code === "COMPANION_ROUTE_UNVERIFIED"
      || error.code === "COMPANION_REBIND_NOT_CONFIRMED"
      || error.code === "COMPANION_REBIND_NOT_SUCCESSOR"
      || error.code === "COMPANION_REBIND_ALREADY_INITIATED"
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

  router.post("/pair", (req, res) => {
    try {
      const body = pairBodySchema.parse(req.body);
      const result = exchangePairingIntent({
        workspaceId: opts.workspaceId,
        intentId: body.intentId,
        secret: body.secret,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      });
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
      res.json(initiateCompanionRebind({
        workspaceId: opts.workspaceId,
        credential,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      }));
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
      res.json(completeCompanionRebind({
        workspaceId: opts.workspaceId,
        credential,
        challengeId: body.challengeId,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/state", (req, res) => {
    try {
      // Auth first: unauthenticated must 401 without touching projector.
      const ctx = auth(req);
      // E1b2 autonomous reconcile: browser can pull outbox without MCP kick.
      reconcileFeedbackOutbox(opts.workspaceId, opts.stateDir);
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
      const ctx = auth(req);
      const body = routeBodySchema.parse(req.body);
      // Project newly landed trusted receipts before reserving.
      reconcileFeedbackOutbox(opts.workspaceId, opts.stateDir);
      const result = companionReserveNext({
        workspaceId: opts.workspaceId,
        ctx,
        routeCanonical: body.routeCanonical,
        stateDir: opts.stateDir,
      });
      res.json({
        reservationId: result.reservationId,
        delivery: result.delivery,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/release", (req, res) => {
    try {
      const ctx = auth(req);
      const body = releaseBodySchema.parse(req.body);
      const event = companionRelease({
        workspaceId: opts.workspaceId,
        ctx,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        reservationId: body.reservationId,
        stateDir: opts.stateDir,
      });
      res.json({ eventId: event.eventId, status: event.status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/begin-send", (req, res) => {
    try {
      const ctx = auth(req);
      const body = beginSendBodySchema.parse(req.body);
      const result = companionBeginSend({
        workspaceId: opts.workspaceId,
        ctx,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        reservationId: body.reservationId,
        stateDir: opts.stateDir,
      });
      res.json({
        eventId: result.event.eventId,
        status: result.event.status,
        attemptId: result.attemptId,
        message: result.message,
        messageSha256: result.messageSha256,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/ack", (req, res) => {
    try {
      const ctx = auth(req);
      const body = ackBodySchema.parse(req.body);
      const event = companionAckObserved({
        workspaceId: opts.workspaceId,
        ctx,
        routeCanonical: body.routeCanonical,
        eventId: body.eventId,
        attemptId: body.attemptId,
        stateDir: opts.stateDir,
      });
      res.json({ eventId: event.eventId, status: event.status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/retire-unknown", (req, res) => {
    try {
      const ctx = auth(req);
      const body = retireUnknownBodySchema.parse(req.body);
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
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
