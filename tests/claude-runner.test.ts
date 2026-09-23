import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_CANDIDATE_DESCRIPTOR,
  CLAUDE_CODE_EXECUTOR_ID,
  CLAUDE_MAX_STDOUT_BYTES,
  ClaudeRunner,
  buildClaudeCommand,
  parseClaudeJson,
  type ClaudeCommandInput,
} from "../src/executor/claude/index.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const executable = {
  path: path.join(process.cwd(), "claude.exe"),
  version: "1.0.0",
  sha256: "a".repeat(64),
};
const input: ClaudeCommandInput = {
  commandId: "claude-command-1",
  sessionId,
  workspaceRoot: process.cwd(),
  executable,
  permissionMode: "manual",
  outputMode: "json",
  prompt: "只返回 JSON",
};

const resultJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  is_error: false,
  duration_ms: 12,
  num_turns: 1,
  total_cost_usd: 0.01,
  result: "完成",
  usage: { input_tokens: 3, output_tokens: 4, ignored: "raw" },
  ...overrides,
});

describe("Claude runner contract", () => {
  it("纯 builder 校验 UUID、identity、workspace containment 并生成无 shell argv", () => {
    const command = buildClaudeCommand(input);
    expect(command).toMatchObject({
      executorId: "claude-code",
      commandId: input.commandId,
      sessionId,
      workspaceRoot: input.workspaceRoot,
      cwd: input.workspaceRoot,
      executable,
      shell: false,
      outputMode: "json",
      permissionMode: "manual",
    });
    expect(command.argv).toEqual([
      "--print", "--session-id", sessionId,
      "--permission-mode", "manual",
      "--output-format", "json",
      "--",
      input.prompt,
    ]);
    expect(command).not.toHaveProperty("prompt");
    expect(buildClaudeCommand({ ...input, workspaceRoot: path.join(input.workspaceRoot, ".") }).workspaceRoot)
      .toBe(path.resolve(input.workspaceRoot));
    expect(() => buildClaudeCommand({ ...input, sessionId: "not-a-uuid" })).toThrow(/sessionId/);
    expect(() => buildClaudeCommand({ ...input, executable: { ...executable, path: "claude" } })).toThrow(/绝对路径/);
    expect(buildClaudeCommand({ ...input, executable: { ...executable, version: "2.1.220 (Claude Code)" } }).executable.version)
      .toBe("2.1.220 (Claude Code)");
    expect(() => buildClaudeCommand({ ...input, executable: { ...executable, version: "" } })).toThrow(/version/);
    expect(() => buildClaudeCommand({ ...input, executable: { ...executable, sha256: "bad" } })).toThrow(/sha256/);
    expect(() => buildClaudeCommand({ ...input, cwd: path.dirname(process.cwd()) })).toThrow(/workspaceRoot/);
    for (const permissionMode of ["default", "dontAsk", "auto", "bypass", "delegate"]) {
      expect(() => buildClaudeCommand({ ...input, permissionMode })).toThrow(/permissionMode/);
    }
    expect(() => buildClaudeCommand({ ...input, outputMode: "stream-json" })).toThrow(/outputMode/);
  });

  it("缺省 sessionId 生成规范 UUID，仍保留 commandId correlation", () => {
    const command = buildClaudeCommand({ ...input, sessionId: undefined });
    expect(command.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(command.commandId).toBe(input.commandId);
  });

  it("JSON parser 要求 session correlation，且只输出 bounded metadata summary", () => {
    const parsed = parseClaudeJson(resultJson(), { sessionId, commandId: input.commandId });
    expect(parsed).toMatchObject({ ok: true, value: { hasResult: true } });
    if (parsed.ok) {
      expect(parsed.value.metadata).toMatchObject({
        sessionId,
        eventCount: 1,
        result: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        usage: { input_tokens: 3, output_tokens: 4 },
      });
      expect(parsed.value.metadata).not.toHaveProperty("prompt");
      expect(parsed.value.metadata).not.toHaveProperty("model");
      expect(JSON.stringify(parsed.value)).not.toContain(input.prompt);
    }
    expect(parseClaudeJson(resultJson({ session_id: "22222222-2222-4222-8222-222222222222" }), sessionId))
      .toEqual({ ok: false, reason: "session_mismatch" });
    expect(parseClaudeJson(resultJson({ command_id: "other-command" }), { sessionId, commandId: input.commandId }))
      .toEqual({ ok: false, reason: "command_mismatch" });
    expect(parseClaudeJson(JSON.stringify({ type: "result" }), sessionId)).toEqual({ ok: false, reason: "session_missing" });
    expect(parseClaudeJson("not-json", sessionId)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("注入 fake process runner，结果仅保留 executor/correlation 与 output summary", async () => {
    const processRunner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: resultJson(), stderr: "" });
    const result = await new ClaudeRunner({ processRunner }).run(input);
    expect(result).toMatchObject({
      status: "completed",
      executorId: CLAUDE_CODE_EXECUTOR_ID,
      correlation: { commandId: input.commandId, sessionId },
      stdout: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), truncated: false },
      stderr: { bytes: 0, truncated: false, restricted: false },
    });
    expect(typeof result.stdout).toBe("object");
    expect(JSON.stringify(result)).not.toContain(input.prompt);
    expect(processRunner).toHaveBeenCalledWith(expect.objectContaining({
      executorId: CLAUDE_CODE_EXECUTOR_ID,
      executablePath: executable.path,
      executable,
      cwd: input.workspaceRoot,
      shell: false,
      windowsHide: true,
      stdoutLimitBytes: expect.any(Number),
      stderrLimitBytes: expect.any(Number),
      signal: expect.any(AbortSignal),
    }));
  });

  it("JSON terminal result 标记 is_error 时即使退出码为零也不能报告 completed", async () => {
    const result = await new ClaudeRunner({
      processRunner: vi.fn().mockResolvedValue({ exitCode: 0, stdout: resultJson({ is_error: true }), stderr: "" }),
    }).run(input);
    expect(result).toMatchObject({ status: "failed", reason: "executor_error", exitCode: 0, metadata: { isError: true } });
    expect(JSON.stringify(result)).not.toContain("完成");
    expect(JSON.stringify(result)).not.toContain(input.prompt);
  });

  it("malformed/session mismatch/nonzero/timeout/cancel 均不返回 completed", async () => {
    await expect(new ClaudeRunner({
      processRunner: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "not-json", stderr: "" }),
    }).run(input)).resolves.toMatchObject({ status: "ambiguous", reason: "protocol_invalid" });
    await expect(new ClaudeRunner({
      processRunner: vi.fn().mockResolvedValue({ exitCode: 0, stdout: resultJson({ session_id: "22222222-2222-4222-8222-222222222222" }), stderr: "" }),
    }).run(input)).resolves.toMatchObject({ status: "ambiguous", reason: "session_mismatch" });
    await expect(new ClaudeRunner({
      processRunner: vi.fn().mockResolvedValue({ exitCode: 1, stdout: resultJson(), stderr: "failed" }),
    }).run(input)).resolves.toMatchObject({ status: "failed", reason: "process_exit" });

    const waitForAbort = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(new ClaudeRunner({ processRunner: waitForAbort, timeoutMs: 5 }).run(input)).resolves.toMatchObject({
      status: "timeout", reason: "timeout",
    });
    await expect(new ClaudeRunner({ processRunner: vi.fn(() => new Promise<never>(() => {})), timeoutMs: 5 }).run(input))
      .resolves.toMatchObject({ status: "timeout", reason: "timeout" });
    const controller = new AbortController();
    const cancelPromise = new ClaudeRunner({ processRunner: waitForAbort, timeoutMs: 1000 }).run(input, controller.signal);
    controller.abort();
    await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled", reason: "cancelled" });
  });

  it("timeout 后不重试或把迟到的 runner 结果提升为 completed", async () => {
    let resolveProcess!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const processRunner = vi.fn(() => new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
      resolveProcess = resolve;
    }));
    const run = new ClaudeRunner({ processRunner, timeoutMs: 5 }).run(input);
    await expect(run).resolves.toMatchObject({ status: "timeout", reason: "timeout" });
    resolveProcess({ exitCode: 0, stdout: resultJson(), stderr: "" });
    await Promise.resolve();
    expect(processRunner).toHaveBeenCalledOnce();
  });

  it("stdout/stderr 超限返回 bounded summary 并 fail closed", async () => {
    const result = await new ClaudeRunner({
      processRunner: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "x".repeat(CLAUDE_MAX_STDOUT_BYTES + 1),
        stderr: "",
      }),
    }).run(input);
    expect(result).toMatchObject({ status: "ambiguous", reason: "output_limit", stdout: { truncated: true } });
    expect(result.stdout.bytes).toBe(CLAUDE_MAX_STDOUT_BYTES);
    expect(result).not.toHaveProperty("stdoutText");
    expect(result).not.toHaveProperty("stderrText");
  });

  it("Claude candidate descriptor 明确 production disabled，且没有触碰 production registry", () => {
    expect(CLAUDE_CODE_CANDIDATE_DESCRIPTOR).toMatchObject({
      id: "claude-code",
      productionEnabled: false,
      capabilities: {
        existingSessionBinding: "observed-experimental",
        createSession: "observed-experimental",
        delivery: "contract-only",
        busyActiveInspection: "unknown",
        approvalVisibility: "unknown",
        trustedTerminalReceipt: "unsupported",
        cancellationInterrupt: "process-only",
      },
    });
  });
});
