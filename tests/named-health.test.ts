import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeNamedHealth, type NamedHealthIdentity } from "../src/core/named-health.js";
import { SERVICE_NAME } from "../src/version.js";

const url = "https://named.example.com";
const current: NamedHealthIdentity = { workspaceId: "123456789abc", pid: 42,
  startedAt: "2026-10-02T00:00:00.000Z", runtimeBuildId: "a".repeat(64) };
const previous = { ...current, pid: 41, startedAt: "2026-10-01T00:00:00.000Z", runtimeBuildId: "b".repeat(64) };
const body = (identity = current) => ({ service: SERVICE_NAME, status: "ok", ...identity });
const response = (value: unknown = body()) => new Response(JSON.stringify(value));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded named health identity probe", () => {
  it("first exact response needs one request and leaves no timer", async () => {
    expect(await probeNamedHealth(url, current)).toEqual({ ok: true, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${url}/health`, expect.objectContaining({ redirect: "error" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["network", "invalid_json", "500", "503", "429"])("retries transient %s then accepts exact health", async kind => {
    const mock = vi.mocked(fetch);
    if (kind === "network") mock.mockRejectedValueOnce(new Error("private network exception"));
    else mock.mockResolvedValueOnce(kind === "invalid_json" ? new Response("not json") : new Response("private body", { status: Number(kind) }));
    const pending = probeNamedHealth(url, current);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true, attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 302])("HTTP %s never waits for a different response", async status => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("secret", { status }));
    expect(await probeNamedHealth(url, current)).toEqual({ ok: false, failure: "http", httpStatus: status, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["service", "other", "wrong_service"], ["status", "starting", "wrong_status"],
    ["workspaceId", "other", "workspace_mismatch"], ["pid", 99, "pid_mismatch"],
    ["pid", undefined, "pid_mismatch"], ["startedAt", previous.startedAt, "started_at_mismatch"],
    ["startedAt", undefined, "started_at_mismatch"], ["runtimeBuildId", previous.runtimeBuildId, "build_mismatch"],
    ["runtimeBuildId", undefined, "build_mismatch"],
  ])("semantic %s=%s immediately rejects without retry", async (field, value, failure) => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...body(), [field as string]: value }));
    expect(await probeNamedHealth(url, current)).toEqual({ ok: false, failure, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("legacy local authority without build still requires exact pid/start", async () => {
    const legacy = { ...current, runtimeBuildId: undefined };
    vi.mocked(fetch).mockResolvedValueOnce(response(body(legacy)));
    expect(await probeNamedHealth(url, legacy)).toEqual({ ok: true, attempts: 1 });
  });

  it.each(["network", "invalid_json", "500"])("all %s failures stop at exactly three attempts with bounded diagnostics", async kind => {
    if (kind === "network") vi.mocked(fetch).mockRejectedValue(new Error("secret host/credentials"));
    else vi.mocked(fetch).mockImplementation(async () => kind === "invalid_json" ? new Response("") : new Response("secret", { status: 500 }));
    const pending = probeNamedHealth(url, current);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toEqual({ ok: false, failure: kind === "500" ? "http" : kind,
      ...(kind === "500" ? { httpStatus: 500 } : {}), attempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(/secret|credentials|https/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("timeouts cover fetch and stalled body, consume 5/5/8s + 400ms, release every timer", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const signal = init!.signal!; signals.push(signal);
      const stalled = () => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return signals.length === 2 ? { json: stalled, ok: true } as Response : stalled();
    });
    const start = Date.now();
    const pending = probeNamedHealth(url, current);
    await vi.advanceTimersByTimeAsync(4999);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: false, failure: "timeout", attempts: 3 });
    expect(Date.now() - start).toBe(18400);
    expect(signals).toHaveLength(3);
    expect(signals.every(x => x.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("postcheck can retry only the exact known old runtime, never accept it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(body(previous)));
    const pending = probeNamedHealth(url, current, previous);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true, attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("postcheck old runtime that never converges fails after three attempts", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(body(previous)));
    const pending = probeNamedHealth(url, current, previous);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: false, failure: "stale_runtime", attempts: 3 });
  });

  it.each([{ service: "foreign" }, { workspaceId: "foreign" }, { runtimeBuildId: "c".repeat(64) }, { pid: 123 }])(
    "postcheck does not retry foreign or partly matching old identity %j", async changed => {
      vi.mocked(fetch).mockResolvedValueOnce(response({ ...body(previous), ...changed }));
      expect(await probeNamedHealth(url, current, previous)).toMatchObject({ ok: false, attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
});
