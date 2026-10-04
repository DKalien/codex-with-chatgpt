import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTOR_CONTROL_SCOPE,
  EXECUTOR_READ_SCOPE,
} from "../src/auth/store.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE } from "../src/auth/store.js";

describe("R5b MCP tool contract surface", () => {
  it("executor tools use auth/store scopes and enforce requireAuth on list", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/executor-tools.ts"), "utf8");
    expect(source).toMatch(/from ["']\.\.\/auth\/store\.js["']/);
    expect(source).toMatch(/requireAuth\(extra\.authInfo, EXECUTOR_READ_SCOPE\)/);
    expect(source).toMatch(/requireAuth\(extra\.authInfo, EXECUTOR_CONTROL_SCOPE\)/);
    expect(source).toMatch(/executorAuthorize/);
    expect(source).not.toMatch(/export const EXECUTOR_READ_SCOPE =/);
    expect(source).not.toMatch(/registerTool\(\s*"executor_bind"/);
  });

  it("R5E_AUTH_BEFORE_PIN: executor_send performs live executorAuthorize BEFORE durable pin, retains send-time revalidation, userConfirmed intact", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/executor-tools.ts"), "utf8");
    // pre-pin 顺序：requireAuth → authorizeNow → executorAuthorize → workspace 校验 → pin。
    expect(source).toMatch(
      /authorizeNow\(auth\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*executorAuthorize\?\.\(auth\);\s*\n\s*if \(input\.workspaceId/,
    );
    // send-time authorize 回调保留为第二道重验证。
    expect(source).toMatch(
      /authorize:\s*\(\)\s*=>\s*\{\s*authorizeNow\(auth\);\s*executorAuthorize\?\.\(auth\);/,
    );
    // pin 前不得有任何 beginExecutorDispatch 调用先于 executorAuthorize。
    const prePinIndex = source.indexOf("executorAuthorize?.(auth);");
    const pinIndex = source.indexOf("beginExecutorDispatch({");
    expect(prePinIndex).toBeGreaterThanOrEqual(0);
    expect(pinIndex).toBeGreaterThan(prePinIndex);
    // userConfirmed:true 不得削弱。
    expect(source).toMatch(/userConfirmed:\s*z\.literal\(true\)/);
  });

  it("scope matrix is distinct: desktop scopes cannot substitute executor scopes", () => {
    expect(EXECUTOR_READ_SCOPE).toBe("codex.executor.read");
    expect(EXECUTOR_CONTROL_SCOPE).toBe("codex.executor.control");
    expect(EXECUTOR_READ_SCOPE).not.toBe(DESKTOP_READ_SCOPE);
    expect(EXECUTOR_CONTROL_SCOPE).not.toBe(DESKTOP_CONTROL_SCOPE);
    const auth = fs.readFileSync(path.join(process.cwd(), "src/auth/store.ts"), "utf8");
    expect(auth).toMatch(/codex\.executor\.read/);
    expect(auth).toMatch(/codex\.executor\.control/);
    expect(auth).toMatch(/codex\.desktop\.read/);
    expect(auth).toMatch(/codex\.desktop\.control/);
  });

  it("bridge implements executorAuthorize with EXECUTOR_CONTROL_SCOPE only", () => {
    const bridge = fs.readFileSync(path.join(process.cwd(), "src/bridge/server.ts"), "utf8");
    expect(bridge).toMatch(/executorAuthorize/);
    expect(bridge).toMatch(/EXECUTOR_CONTROL_SCOPE/);
    expect(bridge).toMatch(/scopes\.includes\(EXECUTOR_CONTROL_SCOPE\)/);
  });

  it("consent page handles executor control as destructive and not read-only", () => {
    const oauth = fs.readFileSync(path.join(process.cwd(), "src/auth/oauth.ts"), "utf8");
    expect(oauth).toMatch(/EXECUTOR_CONTROL_SCOPE/);
    expect(oauth).toMatch(/Executor \/ 本地编程工具/);
    expect(oauth).toMatch(/不能自行绑定或切换/);
  });
});
