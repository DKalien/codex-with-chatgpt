import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { sanitizeExecutionOutput } from "../../execution/sanitize.js";

export const CLAUDE_CODE_EXECUTOR_ID = "claude-code" as const;
export const CLAUDE_OUTPUT_MODE = "json" as const;
export const CLAUDE_MAX_PROMPT_BYTES = 64 * 1024;
export const CLAUDE_MAX_STDOUT_BYTES = 64 * 1024;
export const CLAUDE_MAX_STDERR_BYTES = 64 * 1024;
export const CLAUDE_MAX_METADATA_STRING = 512;
export const CLAUDE_MAX_METADATA_KEYS = 16;

/** 仅保留不会绕过审批的 Claude permission mode。 */
export const CLAUDE_PERMISSION_MODES = ["manual", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export type ClaudeOutputMode = typeof CLAUDE_OUTPUT_MODE;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[^\0\r\n]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export type ClaudeContractErrorCode =
  | "COMMAND_ID_INVALID"
  | "SESSION_ID_INVALID"
  | "WORKSPACE_ROOT_INVALID"
  | "CWD_INVALID"
  | "WORKSPACE_CONTAINMENT"
  | "EXECUTABLE_IDENTITY_INVALID"
  | "PERMISSION_MODE_INVALID"
  | "OUTPUT_MODE_INVALID"
  | "PROMPT_INVALID"
  | "TIMEOUT_INVALID";

export class ClaudeContractError extends Error {
  readonly code: ClaudeContractErrorCode;

  constructor(code: ClaudeContractErrorCode, message: string) {
    super(message);
    this.name = "ClaudeContractError";
    this.code = code;
  }
}

export interface ClaudeExecutableIdentity {
  /** Resolved absolute executable path; this is never looked up through PATH. */
  readonly path: string;
  readonly version: string;
  readonly sha256?: string;
}

export interface ClaudeCommandInput {
  readonly commandId: string;
  /** Missing session IDs are generated once by the pure builder. */
  readonly sessionId?: string;
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly executable: ClaudeExecutableIdentity;
  readonly permissionMode: ClaudePermissionMode | string;
  readonly outputMode?: ClaudeOutputMode | string;
  readonly prompt: string;
}

export interface ClaudeCommand {
  readonly executorId: typeof CLAUDE_CODE_EXECUTOR_ID;
  readonly commandId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly executable: ClaudeExecutableIdentity;
  readonly permissionMode: ClaudePermissionMode;
  readonly outputMode: ClaudeOutputMode;
  readonly argv: readonly string[];
  readonly shell: false;
}

/** Candidate projection only. This descriptor is deliberately not registered in executor/index.ts. */
export type ClaudeCandidateCapability = "observed-experimental" | "contract-only" | "unknown" | "unsupported" | "process-only";

export interface ClaudeCandidateCapabilities {
  readonly existingSessionBinding: "observed-experimental";
  readonly createSession: "observed-experimental";
  readonly delivery: "contract-only";
  readonly busyActiveInspection: "unknown";
  readonly approvalVisibility: "unknown";
  readonly trustedTerminalReceipt: "unsupported";
  readonly cancellationInterrupt: "process-only";
}

export interface ClaudeCandidateDescriptor {
  readonly id: typeof CLAUDE_CODE_EXECUTOR_ID;
  readonly kind: "local-cli";
  readonly name: "Claude Code";
  readonly productionEnabled: false;
  readonly capabilities: ClaudeCandidateCapabilities;
}

const CLAUDE_CANDIDATE_CAPABILITIES: ClaudeCandidateCapabilities = Object.freeze({
  existingSessionBinding: "observed-experimental",
  createSession: "observed-experimental",
  delivery: "contract-only",
  busyActiveInspection: "unknown",
  approvalVisibility: "unknown",
  trustedTerminalReceipt: "unsupported",
  cancellationInterrupt: "process-only",
});

export const CLAUDE_CODE_CANDIDATE_DESCRIPTOR: ClaudeCandidateDescriptor = Object.freeze({
  id: CLAUDE_CODE_EXECUTOR_ID,
  kind: "local-cli",
  name: "Claude Code",
  productionEnabled: false,
  capabilities: CLAUDE_CANDIDATE_CAPABILITIES,
});

export const claudeCodeCandidateDescriptor = CLAUDE_CODE_CANDIDATE_DESCRIPTOR;

function requireIdentifier(value: string, field: "commandId"): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new ClaudeContractError("COMMAND_ID_INVALID", `${field} 必须是 1-128 位安全标识符。`);
  }
  return value;
}

function requireUuid(value: string | undefined): string {
  const sessionId = value ?? randomUUID();
  if (!UUID.test(sessionId)) {
    throw new ClaudeContractError("SESSION_ID_INVALID", "sessionId 必须是规范 UUID。");
  }
  return sessionId;
}

function normalizeAbsolute(value: string, code: "WORKSPACE_ROOT_INVALID" | "CWD_INVALID" | "EXECUTABLE_IDENTITY_INVALID", field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      value.includes("\0") || !path.isAbsolute(value)) {
    throw new ClaudeContractError(code, `${field} 必须是绝对路径且长度有界。`);
  }
  return path.resolve(value);
}

function isContained(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireExecutable(value: ClaudeExecutableIdentity): ClaudeExecutableIdentity {
  if (!value || typeof value !== "object") {
    throw new ClaudeContractError("EXECUTABLE_IDENTITY_INVALID", "必须提供 Claude executable identity。");
  }
  const executablePath = normalizeAbsolute(value.path, "EXECUTABLE_IDENTITY_INVALID", "executable.path");
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new ClaudeContractError("EXECUTABLE_IDENTITY_INVALID", "executable.version 必须是有界版本字符串。");
  }
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !SHA256.test(value.sha256))) {
    throw new ClaudeContractError("EXECUTABLE_IDENTITY_INVALID", "executable.sha256 必须是 64 位十六进制摘要。");
  }
  return Object.freeze({
    path: executablePath,
    version: value.version,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256.toLowerCase() }),
  });
}

function requireMode(value: string, allowed: readonly string[], code: "PERMISSION_MODE_INVALID" | "OUTPUT_MODE_INVALID", field: string): string {
  if (!allowed.includes(value)) throw new ClaudeContractError(code, `${field} 不在允许的安全枚举范围内。`);
  return value;
}

function requirePrompt(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > CLAUDE_MAX_PROMPT_BYTES) {
    throw new ClaudeContractError("PROMPT_INVALID", "prompt 必须非空、无 NUL 且长度有界。");
  }
  return value;
}

/** Pure builder: validation plus argv only; no PATH lookup, filesystem read, or process start. */
export function buildClaudeCommand(input: ClaudeCommandInput): ClaudeCommand {
  const commandId = requireIdentifier(input.commandId, "commandId");
  const sessionId = requireUuid(input.sessionId);
  const workspaceRoot = normalizeAbsolute(input.workspaceRoot, "WORKSPACE_ROOT_INVALID", "workspaceRoot");
  const cwd = normalizeAbsolute(input.cwd ?? workspaceRoot, "CWD_INVALID", "cwd");
  if (!isContained(workspaceRoot, cwd)) {
    throw new ClaudeContractError("WORKSPACE_CONTAINMENT", "cwd 必须位于 workspaceRoot 内。");
  }
  const executable = requireExecutable(input.executable);
  const permissionMode = requireMode(input.permissionMode, CLAUDE_PERMISSION_MODES, "PERMISSION_MODE_INVALID", "permissionMode") as ClaudePermissionMode;
  const outputMode = requireMode(input.outputMode ?? CLAUDE_OUTPUT_MODE, [CLAUDE_OUTPUT_MODE], "OUTPUT_MODE_INVALID", "outputMode") as ClaudeOutputMode;
  const prompt = requirePrompt(input.prompt);
  const argv = [
    "--print",
    "--session-id", sessionId,
    "--permission-mode", permissionMode,
    "--output-format", outputMode,
    "--",
    prompt,
  ];
  return Object.freeze({
    executorId: CLAUDE_CODE_EXECUTOR_ID,
    commandId,
    sessionId,
    workspaceRoot,
    cwd,
    executable,
    permissionMode,
    outputMode,
    argv: Object.freeze(argv),
    shell: false,
  });
}

export interface ClaudeProcessInvocation {
  readonly executorId: typeof CLAUDE_CODE_EXECUTOR_ID;
  readonly commandId: string;
  readonly sessionId: string;
  readonly executablePath: string;
  readonly executable: ClaudeExecutableIdentity;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly windowsHide: true;
  readonly signal: AbortSignal;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
}

export interface ClaudeProcessResult {
  /** false means the process was never started; null means its terminal state is unknown. */
  readonly started?: boolean;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout: string | Uint8Array;
  readonly stderr: string | Uint8Array;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export type ClaudeProcessRunner = (invocation: ClaudeProcessInvocation) => Promise<ClaudeProcessResult>;

interface CapturedOutput {
  readonly text: string;
  readonly sanitizedText: string;
  readonly summary: ClaudeOutputSummary;
}

export interface ClaudeOutputSummary {
  /** Bytes and digest describe only the bounded captured prefix. */
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly restricted: boolean;
}

function stringPrefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function captureOutput(raw: string | Uint8Array, maxBytes: number, forcedTruncated = false): CapturedOutput {
  const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  const bounded = typeof raw === "string"
    ? Buffer.from(stringPrefix(raw, maxBytes), "utf8")
    : Buffer.from(raw.subarray(0, maxBytes));
  const digest = createHash("sha256").update(bounded).digest("hex");
  const sanitized = sanitizeExecutionOutput(bounded.toString("utf8"));
  const restricted = !sanitized.allowed;
  const text = bounded.toString("utf8");
  const sanitizedText = restricted ? "" : sanitized.text;
  return {
    text,
    sanitizedText,
    summary: Object.freeze({
      bytes: bounded.byteLength,
      sha256: digest,
      truncated: forcedTruncated || rawBytes > maxBytes || (!restricted && sanitized.truncated),
      restricted,
    }),
  };
}

function emptySummary(): ClaudeOutputSummary {
  return captureOutput("", 1).summary;
}

function boundedMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const captured = captureOutput(value, CLAUDE_MAX_METADATA_STRING);
  return captured.summary.restricted ? undefined : captured.sanitizedText;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : undefined;
}

function boundedUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = new Set(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]);
  const entries = Object.entries(value).filter(([key, raw]) => allowed.has(key) && boundedNumber(raw) !== undefined);
  if (!entries.length) return undefined;
  return Object.freeze(Object.fromEntries(entries.slice(0, 4).map(([key, raw]) => [key, boundedNumber(raw)!])));
}

function eventMetadata(event: Record<string, unknown>, sessionId: string, eventCount: number): ClaudeMetadata {
  const result = typeof event.result === "string" ? captureOutput(event.result, CLAUDE_MAX_METADATA_STRING).summary : undefined;
  const metadata: ClaudeMetadata = {
    sessionId,
    eventCount,
    eventType: boundedMetadataString(event.type),
    subtype: boundedMetadataString(event.subtype),
    isError: typeof event.is_error === "boolean" ? event.is_error : undefined,
    durationMs: boundedNumber(event.duration_ms),
    durationApiMs: boundedNumber(event.duration_api_ms),
    numTurns: boundedNumber(event.num_turns),
    totalCostUsd: boundedNumber(event.total_cost_usd),
    result,
    usage: boundedUsage(event.usage),
  };
  return Object.freeze(Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined).slice(0, CLAUDE_MAX_METADATA_KEYS),
  ) as ClaudeMetadata);
}

export interface ClaudeMetadata {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly eventType?: string;
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly durationApiMs?: number;
  readonly numTurns?: number;
  readonly totalCostUsd?: number;
  readonly result?: ClaudeOutputSummary;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface ClaudeParsedJson {
  readonly metadata: ClaudeMetadata;
  readonly hasResult: boolean;
}

export type ClaudeJsonParseFailure =
  | "too_large"
  | "empty"
  | "invalid_json"
  | "not_object"
  | "session_invalid"
  | "session_missing"
  | "session_mismatch"
  | "command_mismatch";

export type ClaudeJsonParseResult =
  | { readonly ok: true; readonly value: ClaudeParsedJson }
  | { readonly ok: false; readonly reason: ClaudeJsonParseFailure };

export interface ClaudeJsonCorrelation {
  readonly sessionId: string;
  readonly commandId?: string;
}

function parseJsonValue(raw: string): unknown | undefined {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Parse one bounded JSON result and require session (and optional command) correlation. */
export function parseClaudeJson(raw: string | Uint8Array, expected: string | ClaudeJsonCorrelation): ClaudeJsonParseResult {
  const correlation = typeof expected === "string" ? { sessionId: expected } : expected;
  if (!UUID.test(correlation.sessionId)) return { ok: false, reason: "session_invalid" };
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > CLAUDE_MAX_STDOUT_BYTES) return { ok: false, reason: "too_large" };
  const value = parseJsonValue(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  if (value === undefined) return { ok: false, reason: "invalid_json" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_object" };
  const event = value as Record<string, unknown>;
  if (typeof event.session_id !== "string") return { ok: false, reason: "session_missing" };
  if (!UUID.test(event.session_id)) return { ok: false, reason: "session_invalid" };
  if (event.session_id !== correlation.sessionId) return { ok: false, reason: "session_mismatch" };
  if (correlation.commandId !== undefined && event.command_id !== undefined && event.command_id !== correlation.commandId) {
    return { ok: false, reason: "command_mismatch" };
  }
  return {
    ok: true,
    value: {
      metadata: eventMetadata(event, correlation.sessionId, 1),
      hasResult: event.type === "result",
    },
  };
}

function appendBounded(chunks: Buffer[], data: Buffer, limit: number, current: number): { bytes: number; truncated: boolean } {
  const remaining = Math.max(0, limit - current);
  if (remaining > 0) chunks.push(data.subarray(0, remaining));
  return { bytes: current + Math.min(data.length, remaining), truncated: data.length > remaining };
}

/** Production-capable seam; tests inject a fake ClaudeProcessRunner and never call this. */
export const spawnClaudeProcess: ClaudeProcessRunner = (invocation) => new Promise(resolve => {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(invocation.executablePath, [...invocation.argv], {
      cwd: invocation.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: invocation.signal,
    });
  } catch {
    resolve({ started: false, exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  let killedForLimit = false;
  const killForLimit = () => {
    if (killedForLimit) return;
    killedForLimit = true;
    try { child.kill(); } catch { /* close/error still determines the terminal evidence */ }
  };
  child.stdout.on("data", chunk => {
    const outcome = appendBounded(stdout, Buffer.from(chunk), invocation.stdoutLimitBytes, stdoutBytes);
    stdoutBytes = outcome.bytes;
    stdoutTruncated ||= outcome.truncated;
    if (outcome.truncated) killForLimit();
  });
  child.stderr.on("data", chunk => {
    const outcome = appendBounded(stderr, Buffer.from(chunk), invocation.stderrLimitBytes, stderrBytes);
    stderrBytes = outcome.bytes;
    stderrTruncated ||= outcome.truncated;
    if (outcome.truncated) killForLimit();
  });
  child.once("error", () => {
    if (settled) return;
    settled = true;
    resolve({ started: false, exitCode: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutTruncated, stderrTruncated });
  });
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    resolve({ started: true, exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutTruncated, stderrTruncated });
  });
});

export type ClaudeRunStatus = "completed" | "failed" | "timeout" | "cancelled" | "ambiguous";
export type ClaudeAmbiguousReason =
  | "output_limit"
  | "process_terminal_unknown"
  | "process_error"
  | "missing_output"
  | "protocol_invalid"
  | "session_invalid"
  | "session_missing"
  | "session_mismatch"
  | "command_mismatch"
  | "result_missing";

export interface ClaudeRunResult {
  readonly executorId: typeof CLAUDE_CODE_EXECUTOR_ID;
  readonly status: ClaudeRunStatus;
  readonly commandId: string;
  readonly sessionId: string;
  readonly correlation: Readonly<{ commandId: string; sessionId: string }>;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: ClaudeOutputSummary;
  readonly stderr: ClaudeOutputSummary;
  readonly outputRestricted: boolean;
  readonly reason?: string;
  readonly metadata?: ClaudeMetadata;
}

function baseResult(command: ClaudeCommand, stdout: ClaudeOutputSummary, stderr: ClaudeOutputSummary,
  status: ClaudeRunStatus, exitCode: number | null, reason?: string, metadata?: ClaudeMetadata): ClaudeRunResult {
  return {
    executorId: CLAUDE_CODE_EXECUTOR_ID,
    status,
    commandId: command.commandId,
    sessionId: command.sessionId,
    correlation: Object.freeze({ commandId: command.commandId, sessionId: command.sessionId }),
    workspaceRoot: command.workspaceRoot,
    cwd: command.cwd,
    exitCode,
    stdout,
    stderr,
    outputRestricted: stdout.restricted || stderr.restricted,
    ...(reason ? { reason } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export interface ClaudeRunnerOptions {
  readonly processRunner?: ClaudeProcessRunner;
  readonly timeoutMs?: number;
}

export class ClaudeRunner {
  private readonly processRunner: ClaudeProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: ClaudeRunnerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new ClaudeContractError("TIMEOUT_INVALID", "timeoutMs 必须为正数且有界。");
    }
    this.processRunner = options.processRunner ?? spawnClaudeProcess;
    this.timeoutMs = timeoutMs;
  }

  async run(input: ClaudeCommandInput, signal?: AbortSignal): Promise<ClaudeRunResult> {
    const command = buildClaudeCommand(input);
    const empty = emptySummary();
    if (signal?.aborted) return baseResult(command, empty, empty, "cancelled", null, "cancelled");

    const controller = new AbortController();
    let interruption: "timeout" | "cancelled" | undefined;
    let resolveInterruption!: (result: ClaudeProcessResult) => void;
    const interruptionPromise = new Promise<ClaudeProcessResult>(resolve => { resolveInterruption = resolve; });
    const onCancel = () => {
      interruption = "cancelled";
      controller.abort();
      resolveInterruption({ exitCode: null, stdout: "", stderr: "" });
    };
    signal?.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => {
      if (!interruption) interruption = "timeout";
      controller.abort();
      resolveInterruption({ exitCode: null, stdout: "", stderr: "" });
    }, this.timeoutMs);
    if (signal?.aborted) onCancel();
    if (interruption) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
      return baseResult(command, empty, empty, interruption, null, interruption);
    }

    let processResult: ClaudeProcessResult;
    try {
      const processPromise = this.processRunner({
        executorId: CLAUDE_CODE_EXECUTOR_ID,
        commandId: command.commandId,
        sessionId: command.sessionId,
        executablePath: command.executable.path,
        executable: command.executable,
        argv: [...command.argv],
        cwd: command.cwd,
        shell: false,
        windowsHide: true,
        signal: controller.signal,
        stdoutLimitBytes: CLAUDE_MAX_STDOUT_BYTES,
        stderrLimitBytes: CLAUDE_MAX_STDERR_BYTES,
      });
      processPromise.catch(() => undefined);
      processResult = await Promise.race([processPromise, interruptionPromise]);
    } catch {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
      return baseResult(command, empty, empty, interruption ?? "ambiguous", null, interruption ?? "process_error");
    }
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);

    let stdout: CapturedOutput;
    let stderr: CapturedOutput;
    try {
      stdout = captureOutput(processResult.stdout, CLAUDE_MAX_STDOUT_BYTES, processResult.stdoutTruncated === true);
      stderr = captureOutput(processResult.stderr, CLAUDE_MAX_STDERR_BYTES, processResult.stderrTruncated === true);
    } catch {
      return baseResult(command, empty, empty, "ambiguous", null, "process_error");
    }
    if (interruption) return baseResult(command, stdout.summary, stderr.summary, interruption, processResult.exitCode, interruption);
    if (stdout.summary.truncated || stderr.summary.truncated || stdout.summary.restricted || stderr.summary.restricted) {
      return baseResult(command, stdout.summary, stderr.summary, "ambiguous", processResult.exitCode, "output_limit");
    }
    if (processResult.started === false) return baseResult(command, stdout.summary, stderr.summary, "failed", processResult.exitCode, "process_not_started");
    if (processResult.exitCode !== null && !Number.isInteger(processResult.exitCode)) {
      return baseResult(command, stdout.summary, stderr.summary, "ambiguous", null, "process_terminal_unknown");
    }
    if (processResult.exitCode === null) {
      return baseResult(command, stdout.summary, stderr.summary, "ambiguous", null, "process_terminal_unknown");
    }
    if (!stdout.text.trim()) {
      return baseResult(command, stdout.summary, stderr.summary, processResult.exitCode === 0 ? "ambiguous" : "failed",
        processResult.exitCode, processResult.exitCode === 0 ? "missing_output" : "process_exit");
    }

    const parsed = parseClaudeJson(stdout.text, { sessionId: command.sessionId, commandId: command.commandId });
    if (!parsed.ok) {
      const reason: ClaudeAmbiguousReason = parsed.reason === "session_invalid" ? "session_invalid" :
        parsed.reason === "session_missing" ? "session_missing" :
          parsed.reason === "session_mismatch" ? "session_mismatch" :
            parsed.reason === "command_mismatch" ? "command_mismatch" : "protocol_invalid";
      return baseResult(command, stdout.summary, stderr.summary, "ambiguous", processResult.exitCode, reason);
    }
    if (!parsed.value.hasResult) {
      return baseResult(command, stdout.summary, stderr.summary, "ambiguous", processResult.exitCode, "result_missing", parsed.value.metadata);
    }
    if (processResult.exitCode !== 0) {
      return baseResult(command, stdout.summary, stderr.summary, "failed", processResult.exitCode, "process_exit", parsed.value.metadata);
    }
    if (parsed.value.metadata.isError) {
      return baseResult(command, stdout.summary, stderr.summary, "failed", processResult.exitCode, "executor_error", parsed.value.metadata);
    }
    return baseResult(command, stdout.summary, stderr.summary, "completed", processResult.exitCode, undefined, parsed.value.metadata);
  }
}

export function createClaudeRunner(options: ClaudeRunnerOptions = {}): ClaudeRunner {
  return new ClaudeRunner(options);
}
