import { request } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { cleanup, isolateStateDir } from "./helpers.js";
let stateDir: string;
let prior: string | undefined;
let server: GatewayServer | undefined;
beforeEach(() => { prior = process.env.C2C_STATE_DIR; stateDir = isolateStateDir(); });
afterEach(async () => {
  await server?.close(); server = undefined; cleanup(stateDir);
  if (prior === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = prior;
});
it("Gateway 健康仅本机 Host 可读且无 owner secret 或配对码", async () => {
  const healthIdentity = { pid: process.pid, creationTime: "fixture:1", buildId: "a".repeat(64) };
  server = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test", healthIdentity });
  const url = `${server.localBaseUrl()}/internal/gateway/health`;
  const response = await fetch(url);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ service: "machine-gateway", ...healthIdentity, port: server.port, publicUrl: server.publicUrl });
  for (const headers of [{ host: "gateway.example.test" }, { "x-forwarded-for": "127.0.0.1" },
    { "x-forwarded-host": "gateway.example.test" }, { "x-forwarded-proto": "https" }, { forwarded: "for=127.0.0.1" },
    { "cf-connecting-ip": "127.0.0.1" }, { "cf-ray": "fixture" }]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers }, response => { response.resume(); resolve(response.statusCode); });
      req.once("error", reject); req.end();
    });
    expect(status).toBe(404);
  }
});
it("没有 supervisor health identity 的 serve 不暴露健康合同", async () => {
  server = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
  expect((await fetch(`${server.localBaseUrl()}/internal/gateway/health`)).status).toBe(404);
});

it.each([{ pid: 0 }, { pid: process.pid + 1 }, { creationTime: "bad value" }, { buildId: "bad" }, { secret: "should-never-leak" }])(
  "非法 Gateway health identity %j 在创建锁前拒绝", async wrong => {
    await expect(startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test", healthIdentity: {
      pid: process.pid, creationTime: "fixture:1", buildId: "a".repeat(64), ...wrong,
    } })).rejects.toThrow();
  });
