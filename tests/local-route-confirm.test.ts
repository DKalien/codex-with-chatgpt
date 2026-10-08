import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmLocalRoute } from "../src/feedback/local-route-confirm.js";
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
const input = { workspaceId: "a".repeat(12), workspaceRoot: "D:\u005cproject", routeCanonical: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" };
function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null, killed: false, kill: vi.fn() });
  spawnMock.mockReturnValue(process); return process;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); spawnMock.mockReset(); });
describe("本机确认 helper 的失败关闭边界", () => {
  it("固定python argv、无shell、hidden window；stdin展示exact workspace和URL", async () => {
    if (process.platform !== "win32") return;
    const helper = child(); const result = confirmLocalRoute(input);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-I", "-B", "-X", "utf8", expect.stringMatching(/local-route-confirm\.py$/)]);
    expect(spawnMock.mock.calls[0]![2]).toEqual({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    expect(JSON.parse(helper.stdin.read().toString())).toEqual(input);
    helper.stdout.write('{"confirmed":true}'); helper.emit("close", 0);
    expect(await result).toBe(true);
  });
  it.each(["cancel", "invalid", "error", "timeout"])("%s 不授予本机确认", async mode => {
    if (process.platform !== "win32") return;
    vi.useFakeTimers(); const helper = child(); const result = confirmLocalRoute(input);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(110_001);
    else if (mode === "error") helper.emit("error", new Error("spawn failed"));
    else { helper.stdout.write(mode === "cancel" ? '{"confirmed":false}' : '{"confirmed":true,"extra":1}'); helper.emit("close", 0); }
    expect(await result).toBe(false);
    expect(helper.kill).toHaveBeenCalled();
  });
});
