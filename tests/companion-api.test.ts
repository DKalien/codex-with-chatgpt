import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompanionRouter } from "../src/companion/api.js";
import { companionToken } from "../src/companion/store.js";
import { listNotifications, recordResult } from "../src/results/store.js";

const W = "aaaaaaaaaaaa";
const URL_OK = "https://chatgpt.com/c/abc-123";
let server: Server;
let base: string;

async function call(method: string, path: string, body?: unknown, auth: string | null = `Bearer ${companionToken()}`) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  const app = express();
  app.use("/companion/v1", createCompanionRouter({ registry: { list: () => [{ workspaceId: W, root: "/tmp/p", name: "proj" }] } }));
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/companion/v1`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("companion api", () => {
  it("requires the bearer token", async () => {
    expect((await call("GET", "/state", undefined, null)).status).toBe(401);
    expect((await call("GET", "/state", undefined, "Bearer wrong")).status).toBe(401);
    expect((await call("GET", "/state")).status).toBe(200);
  });

  it("connects and disconnects with url validation", async () => {
    for (const bad of ["https://evil.com/c/1", "http://chatgpt.com/c/1", "https://chatgpt.com/", "https://chatgpt.com.evil.com/c/1", "nope"]) {
      expect((await call("POST", "/connect", { workspaceId: W, conversationUrl: bad })).status).toBe(400);
    }
    expect((await call("POST", "/connect", { workspaceId: "dddddddddddd", conversationUrl: URL_OK })).status).toBe(404);
    expect((await call("POST", "/connect", { workspaceId: W, conversationUrl: URL_OK })).status).toBe(200);
    expect((await call("GET", "/state")).json.workspaces[0]).toMatchObject({ workspaceId: W, name: "proj", conversationUrl: URL_OK });
    const projectUrl = "https://chatgpt.com/g/g-p-abc123-proj/c/abc-123";
    expect((await call("POST", "/connect", { workspaceId: W, conversationUrl: projectUrl })).status).toBe(200);
    expect((await call("POST", "/disconnect", { workspaceId: W })).status).toBe(200);
    expect((await call("GET", "/state")).json.workspaces[0].conversationUrl).toBeNull();
  });

  it("walks a notification through claim/ack/requeue with error codes", async () => {
    const { id } = recordResult({ workspaceId: W, commandId: "k1", status: "ok", summary: "s" }).notification;
    const pending = (await call("GET", "/state")).json.workspaces[0].notifications;
    expect(pending.map((n: any) => n.id)).toContain(id);

    expect((await call("POST", "/ack", { workspaceId: W, id })).status).toBe(409);
    expect((await call("POST", "/claim", { workspaceId: W, id })).json.notification.state).toBe("claimed");
    const again = await call("POST", "/claim", { workspaceId: W, id });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("NOTIFICATION_NOT_PENDING");
    expect((await call("POST", "/requeue", { workspaceId: W, id })).json.notification.state).toBe("pending");
    await call("POST", "/claim", { workspaceId: W, id });
    expect((await call("POST", "/ack", { workspaceId: W, id })).json.notification.state).toBe("delivered");
    expect(listNotifications(W).find((n) => n.id === id)?.state).toBe("delivered");
    const state = (await call("GET", "/state")).json.workspaces[0].notifications;
    expect(state.map((n: any) => n.id)).not.toContain(id);
    expect((await call("POST", "/claim", { workspaceId: W, id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });

  it("rejects malformed and oversized bodies", async () => {
    expect((await call("POST", "/claim", { workspaceId: W, id: "not-a-uuid" })).status).toBe(400);
    expect((await call("POST", "/claim", "{bad json")).status).toBe(400);
    expect((await call("POST", "/connect", { workspaceId: W, conversationUrl: "x".repeat(70_000) })).status).toBe(413);
  });
});
