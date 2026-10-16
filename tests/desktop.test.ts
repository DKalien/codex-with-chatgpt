import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { C2CError } from "../src/errors.js";
import { DesktopClient, encodeFrame, FrameDecoder } from "../src/desktop/ipc.js";
import { readDesktop, updateDesktop } from "../src/desktop/store.js";
import { bindCurrentDesktop, desktopStatus, formatDesktopTask, sendToDesktop, unbindDesktop } from "../src/desktop/service.js";
import { FakeDesktop, type FakeDesktopOptions } from "./fake-desktop.js";

const THREAD = randomUUID();
const WS = "abcdef012345";
let fake: FakeDesktop | undefined;

const missingPipe = () => `\\\\.\\pipe\\c2c-test-missing-${randomUUID()}`;

async function setup(options: FakeDesktopOptions = {}, bind = true) {
  fake = await new FakeDesktop(options).start();
  const pipe = fake.pipe;
  const deps = { connect: () => DesktopClient.connect({ pipe }), busyWaitMs: 300, pollMs: 10 };
  if (bind) updateDesktop(WS, (s) => { s.binding = { threadId: THREAD, boundAt: "2026-01-01T00:00:00.000Z" }; });
  return { deps, fake };
}

beforeEach(() => {
  updateDesktop(WS, (s) => { s.binding = null; s.deliveries = []; });
});
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: C2CError) => e.code);

describe("frame codec", () => {
  it("round-trips and handles split and coalesced chunks", () => {
    const all = Buffer.concat([encodeFrame({ n: 1, text: "你好" }), encodeFrame({ n: 2 })]);
    const decoder = new FrameDecoder();
    const out = [];
    for (let i = 0; i < all.length; i += 3) out.push(...decoder.feed(all.subarray(i, i + 3)));
    expect(out).toEqual([{ n: 1, text: "你好" }, { n: 2 }]);
    expect(new FrameDecoder().feed(all)).toHaveLength(2);
  });

  it("rejects oversized or non-object frames", () => {
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(0xffffffff);
    expect(() => new FrameDecoder().feed(bad)).toThrow();
    expect(() => new FrameDecoder().feed(encodeFrame([1]))).toThrow();
  });
});

describe("DesktopClient", () => {
  it("answers client-discovery-request and snapshots the thread", async () => {
    const { fake } = await setup({ probeDiscovery: true, title: "我的会话" });
    const client = await DesktopClient.connect({ pipe: fake.pipe });
    const state = await client.snapshot(THREAD);
    client.close();
    expect(state).toMatchObject({ busy: false, runtimeStatus: "idle", title: "我的会话" });
    expect(fake.discoveryResponses).toHaveLength(1);
    expect(fake.discoveryResponses[0].response).toEqual({ canHandle: false });
  });

  it("maps a missing owner to DESKTOP_NO_OWNER", async () => {
    const { fake } = await setup({ ownerPresent: false });
    const client = await DesktopClient.connect({ pipe: fake.pipe });
    expect(await code(client.discoverOwner(THREAD))).toBe("DESKTOP_NO_OWNER");
    client.close();
  });

  it("reports DESKTOP_UNAVAILABLE when no pipe exists", async () => {
    expect(await code(DesktopClient.connect({ pipe: missingPipe() }))).toBe("DESKTOP_UNAVAILABLE");
  });
});

describe("sendToDesktop", () => {
  const input = { workspaceId: WS, commandId: "cmd-1", message: "做点事" };

  it("accepts and records turnId, with a formatted task body", async () => {
    const { deps, fake } = await setup();
    const delivery = await sendToDesktop(input, deps);
    expect(delivery.status).toBe("accepted");
    expect(delivery.turnId).toBeTruthy();
    const sent = fake.requests.find((r) => r.method === "thread-follower-start-turn")!;
    expect(sent.targetClientId).toBe(fake.ownerId);
    expect(sent.params.turnStart.request.input[0].text).toBe(formatDesktopTask(input));
    expect(readDesktop(WS).deliveries).toEqual([delivery]);
  });

  it("is idempotent for the same commandId and conflicts on a different message", async () => {
    const { deps, fake } = await setup();
    const first = await sendToDesktop(input, deps);
    expect(await sendToDesktop(input, deps)).toEqual(first);
    expect(fake.startTurnCount).toBe(1);
    expect(await code(sendToDesktop({ ...input, message: "别的" }, deps))).toBe("COMMAND_CONFLICT");
    expect(fake.startTurnCount).toBe(1);
  });

  it("waits while busy, then sends", async () => {
    const { deps, fake } = await setup({ busySnapshots: 3 });
    expect((await sendToDesktop(input, deps)).status).toBe("accepted");
    expect(fake.snapshots).toBe(4);
  });

  it("times out as DESKTOP_BUSY without recording anything", async () => {
    const { deps, fake } = await setup({ busySnapshots: Infinity });
    expect(await code(sendToDesktop(input, { ...deps, busyWaitMs: 60 }))).toBe("DESKTOP_BUSY");
    expect(fake.startTurnCount).toBe(0);
    expect(readDesktop(WS).deliveries).toEqual([]);
  });

  it.each(["reject", "foreign"] as const)("records unknown (never resends) when start-turn gets an unexpected response: %s", async (mode) => {
    const { deps, fake } = await setup({ startTurn: mode });
    expect((await sendToDesktop(input, deps)).status).toBe("unknown");
    fake.options.startTurn = "success";
    expect((await sendToDesktop(input, deps)).status).toBe("unknown");
    expect(fake.startTurnCount).toBe(1);
  });

  it("records unknown when the connection drops after start-turn is written, and never resends", async () => {
    const { deps, fake } = await setup({ startTurn: "hangup" });
    expect((await sendToDesktop(input, deps)).status).toBe("unknown");
    fake.options.startTurn = "success";
    expect((await sendToDesktop(input, deps)).status).toBe("unknown");
    expect(fake.startTurnCount).toBe(1);
  });

  it("fails before recording when there is no owner", async () => {
    const { deps } = await setup({ ownerPresent: false });
    expect(await code(sendToDesktop(input, deps))).toBe("DESKTOP_NO_OWNER");
    expect(readDesktop(WS).deliveries).toEqual([]);
  });

  it("requires a binding and valid input", async () => {
    const { deps, fake } = await setup({}, false);
    expect(await code(sendToDesktop(input, deps))).toBe("DESKTOP_NOT_BOUND");
    expect(await code(sendToDesktop({ ...input, commandId: "bad id" }, deps))).toBe("INVALID_COMMAND_ID");
    expect(await code(sendToDesktop({ ...input, message: "x".repeat(64 * 1024 + 1) }, deps))).toBe("MESSAGE_TOO_LARGE");
    expect(fake.requests).toEqual([]);
  });
});

describe("bind / status", () => {
  it("binds CODEX_THREAD_ID with the snapshot title, then unbinds", async () => {
    const { deps } = await setup({ title: "会话标题" }, false);
    const binding = await bindCurrentDesktop(WS, { ...deps, env: { CODEX_THREAD_ID: THREAD } });
    expect(binding).toMatchObject({ threadId: THREAD, title: "会话标题" });
    expect(readDesktop(WS).binding).toEqual(binding);
    expect(await desktopStatus(WS, deps)).toMatchObject({ available: true, busy: false });
    unbindDesktop(WS);
    expect(readDesktop(WS).binding).toBeNull();
  });

  it("rejects a missing or non-UUID thread id and a missing owner", async () => {
    const { deps, fake } = await setup({}, false);
    expect(await code(bindCurrentDesktop(WS, { ...deps, env: {} }))).toBe("DESKTOP_NO_THREAD");
    expect(await code(bindCurrentDesktop(WS, { ...deps, env: { CODEX_THREAD_ID: "nope" } }))).toBe("DESKTOP_NO_THREAD");
    fake.options.ownerPresent = false;
    expect(await code(bindCurrentDesktop(WS, { ...deps, env: { CODEX_THREAD_ID: THREAD } }))).toBe("DESKTOP_NO_OWNER");
    expect(readDesktop(WS).binding).toBeNull();
  });

  it("reports unavailable when Desktop is down", async () => {
    await setup();
    const status = await desktopStatus(WS, { connect: () => DesktopClient.connect({ pipe: missingPipe() }) });
    expect(status).toMatchObject({ available: false });
    expect(status.error).toBeTruthy();
  });
});
