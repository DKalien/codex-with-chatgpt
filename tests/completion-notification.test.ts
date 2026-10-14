import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { renderCompletionNotification, type CompletionSignal } from "../src/browser/completion-notification.js";

import { renderCompletionNotification as shimRenderer } from "../browser-companion/completion-notification.js";

import { hasExactAttemptMarker } from "../browser-companion/turn-observer.js";

const signal: CompletionSignal = {
  type: "execution_ended", version: 1, workspaceId: "aaaaaaaaaaaa", commandId: "command_1",
  taskId: "desktop_command_1", attemptId: "22222222-2222-4222-8222-222222222222",
};

const message = renderCompletionNotification(signal);

const source = fs.readFileSync("browser-companion/bridge-client.js", "utf8");

describe("浏览器 execution_ended 通知模板", () => {
  it("固定三行正文、shim和exact ATTEMPT marker一致", () => {
    expect(shimRenderer(signal)).toBe(message);
    expect(message).toBe(`本轮执行已结束，请读取结果（自动通知，非新授权）。\nWORKSPACE_ID: aaaaaaaaaaaa | COMMAND_ID: command_1 | TASK_ID: desktop_command_1\nATTEMPT_ID: ${signal.attemptId}`);
    expect(hasExactAttemptMarker(message, signal.attemptId)).toEqual({ ok: true });
  });
  it("接受既有Desktop和official合法ID以及长度边界", () => {
    expect(renderCompletionNotification({ ...signal, taskId: signal.attemptId })).toContain(`TASK_ID: ${signal.attemptId}`);
    expect(() => renderCompletionNotification({ ...signal, commandId: "x".repeat(128), taskId: `desktop_${"x".repeat(128)}` })).not.toThrow();
  });
  it.each([
    null, [], {}, { ...signal, extra: true }, { ...signal, version: 2 }, { ...signal, type: "finished" },
    { ...signal, workspaceId: "invalid" }, { ...signal, commandId: "x".repeat(129) },
    { ...signal, commandId: "command\nID" }, { ...signal, taskId: "" }, { ...signal, taskId: "task_1" },
    { ...signal, taskId: `desktop_${"x".repeat(129)}` }, { ...signal, attemptId: "invalid" },
    ...["\r", "\n", "\t", "\u2028", "\u2029"].map(separator => ({ ...signal, taskId: `desktop_a${separator}ATTEMPT_ID: fake` })),
    ...["workspaceId", "commandId", "taskId", "attemptId"].map(key => ({ ...signal, [key]: `${signal[key as keyof CompletionSignal]}\n` })),
  ])("拒绝非法signal %#", value => {
    expect(() => renderCompletionNotification(value)).toThrow("completion signal invalid");
  });
});

describe("completion模板构建约束", () => {
  it("编译模板覆盖源码shim并进入轻量Bridge ESM链", () => {
    const build = fs.readFileSync("scripts/build-browser-companion.mjs", "utf8");
    expect(build).toContain('fs.copyFileSync(completionJs, path.join(distCompanion, "completion-notification.js"))');
    expect(build).toContain('missing compiled completion module');
    expect(source).toContain('import { renderCompletionNotification } from "./completion-notification.js"');
    const renderer = fs.readFileSync("src/browser/completion-notification.ts", "utf8");
    expect(renderer).not.toMatch(/\bimport\b|node:|\bzod\b/);
    const manifest = JSON.parse(fs.readFileSync("browser-companion/manifest.json", "utf8"));
    expect(manifest.content_scripts.flatMap((script: any) => script.js)).not.toContain("completion-notification.js");
  });
});
