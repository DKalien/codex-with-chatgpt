import express from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { C2CError } from "../errors.js";
import type { Registry } from "../gateway/registry.js";
import { ackNotification, claimNotification, listNotifications, requeueNotification } from "../results/store.js";
import { companionToken, getConversations, setConversation } from "./store.js";

const workspaceId = z.string().regex(/^[a-f0-9]{12}$/);
const idBody = z.object({ workspaceId, id: z.string().uuid() });

const STATUS: Record<string, number> = {
  UNKNOWN_WORKSPACE: 404,
  NOTIFICATION_NOT_FOUND: 404,
  NOTIFICATION_NOT_PENDING: 409,
  NOTIFICATION_NOT_CLAIMED: 409,
};

function tokenMatches(header: string | undefined): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(companionToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCompanionRouter(deps: { registry: Pick<Registry, "list"> }): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (tokenMatches(req.get("authorization"))) return next();
    res.status(401).json({ error: "UNAUTHORIZED", message: "伴侣 token 无效" });
  });
  router.use(express.json({ limit: "64kb" }));

  const known = (id: string) => {
    if (!deps.registry.list().some((w) => w.workspaceId === id)) throw new C2CError("UNKNOWN_WORKSPACE", `未登记的项目：${id}`);
  };
  const handle = (fn: (body: unknown) => unknown): express.RequestHandler => (req, res) => {
    try {
      res.json(fn(req.body ?? {}));
    } catch (error) {
      if (error instanceof z.ZodError) return void res.status(400).json({ error: "INVALID_REQUEST", message: "请求参数无效" });
      if (error instanceof C2CError) return void res.status(STATUS[error.code] ?? 400).json({ error: error.code, message: error.message });
      throw error;
    }
  };

  router.get("/state", handle(() => {
    const conversations = getConversations();
    return {
      workspaces: deps.registry.list().map((w) => ({
        workspaceId: w.workspaceId,
        name: w.name,
        conversationUrl: conversations[w.workspaceId] ?? null,
        notifications: listNotifications(w.workspaceId).filter((n) => n.state !== "delivered"),
      })),
    };
  }));

  router.post("/connect", handle((body) => {
    const input = z.object({ workspaceId, conversationUrl: z.string().max(2048) }).parse(body);
    known(input.workspaceId);
    setConversation(input.workspaceId, input.conversationUrl);
    return { ok: true };
  }));

  router.post("/disconnect", handle((body) => {
    const input = z.object({ workspaceId }).parse(body);
    known(input.workspaceId);
    setConversation(input.workspaceId, null);
    return { ok: true };
  }));

  router.post("/claim", handle((body) => {
    const input = idBody.parse(body);
    known(input.workspaceId);
    return { notification: claimNotification(input.workspaceId, input.id) };
  }));

  router.post("/ack", handle((body) => {
    const input = idBody.parse(body);
    known(input.workspaceId);
    return { notification: ackNotification(input.workspaceId, input.id) };
  }));

  router.post("/requeue", handle((body) => {
    const input = idBody.parse(body);
    known(input.workspaceId);
    return { notification: requeueNotification(input.workspaceId, input.id) };
  }));

  // express.json 的解析错误（超限/非法 JSON）统一成 JSON 错误
  router.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status === 413 ? 413 : 400).json({ error: "INVALID_REQUEST", message: "请求体无效或过大" });
  });
  return router;
}
