# -*- coding: utf-8 -*-
"""R2 Node 测试手术：desktop-ipc.test.ts 删 compatibility 系，改 diagnose 系。"""
from pathlib import Path

TESTS = Path(r"D:\python\codex-with-chatgpt\tests\desktop-ipc.test.ts")
text = TESTS.read_text(encoding="utf-8")


def replace_once(find: str, repl: str, label: str) -> None:
    global text
    count = text.count(find)
    if count != 1:
        raise SystemExit(f"[{label}] expected 1 got {count}: {find[:80]!r}")
    text = text.replace(find, repl)


def cut_between(start_anchor: str, end_anchor: str, repl: str, label: str) -> None:
    global text
    start = text.index(start_anchor)
    end = text.index(end_anchor)
    if end <= start:
        raise SystemExit(f"[{label}] bad range")
    text = text[:start] + repl + text[end:]


# 1. imports：删三个 compatibility validator，加 validateDesktopDiagnosis
replace_once(
    """import {
  DesktopIpcClient,
  resolveDesktopHelperPath,
  validateDesktopCompatibilityAudit,
  validateDesktopHandshakeAudit,
  validateDesktopCompatibility,
  validateDesktopMessage,
  validateDesktopTarget,
  validateDesktopResultActivityMarker,
  validateDesktopResultActivityMarkerObservation,
  validateDesktopResultTerminalFence,
  type DesktopResultActivityMarker,
} from "../src/desktop/ipc.js";
""",
    """import {
  DesktopIpcClient,
  resolveDesktopHelperPath,
  validateDesktopDiagnosis,
  validateDesktopMessage,
  validateDesktopTarget,
  validateDesktopResultActivityMarker,
  validateDesktopResultActivityMarkerObservation,
  validateDesktopResultTerminalFence,
  type DesktopResultActivityMarker,
} from "../src/desktop/ipc.js";
""",
    "imports",
)

# 2. 删 SEMANTIC_REASONS 常量
replace_once(
    """const SEMANTIC_REASONS = [
  "matched",
  "source_too_large",
  "lexical_unsupported",
  "start_turn_missing",
  "start_turn_ambiguous",
  "version_unprovable",
  "payload_unprovable",
  "ack_unprovable",
  "not_scanned",
] as const;

""",
    "",
    "semantic-reasons",
)

# 3. FakeReply 类型去掉 compatibility
replace_once(
    'type FakeReply = { ok: true; value: unknown } | { ok: false; code: string; notSent?: boolean; compatibility?: unknown };',
    "type FakeReply = { ok: true; value: unknown } | { ok: false; code: string; notSent?: boolean };",
    "fake-reply",
)

# 4. 四处 fake value 删除版本/profile 三字段（E1/E2/E3/E4 共用同一文本）
_find4 = """      requestsCount: 0,
      desktopVersion: "26.915.4065.0",
      appServerVersion: "0.155.0-alpha.9.2",
      profile: "desktop-ipc-v1",
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
"""
_repl4 = """      requestsCount: 0,
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
"""
if text.count(_find4) != 4:
    raise SystemExit(f"[value-three-fields] expected 4 got {text.count(_find4)}")
text = text.replace(_find4, _repl4)

# 5. E1 期望加 ownerClientId
replace_once(
    """    await expect(makeClient(fake.spawnImpl).inspectResultContext(target)).resolves.toMatchObject({
      ...target, resultTurnId, resultTurnStatus: "completed",
    });
""",
    """    await expect(makeClient(fake.spawnImpl).inspectResultContext(target)).resolves.toMatchObject({
      ...target, ownerClientId: "01a00000-0000-7000-8000-000000000004", resultTurnId, resultTurnStatus: "completed",
    });
""",
    "e1-expected",
)

# 6. E1 末尾加 public schema 断言
replace_once(
    """    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_context", target });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "target"]);
""",
    """    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_context", target });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "target"]);
    expect(Object.keys(value).sort()).toEqual([
      "cwd", "hostId", "ownerClientId", "projectId", "requestsCount", "resumeState",
      "resultTurnId", "resultTurnStatus", "runtimeStatus", "threadId", "title",
      "workspaceKind", "workspaceRoot",
    ]);
""",
    "e1-schema",
)

# 7. 块 A：compatibility 投影/错误两测试 → diagnose 投影/错误两测试
cut_between(
    '  it("compatibility 只发送 id/op，并严格投影安全诊断字段", async () => {',
    '  it("currentResultOwnership',
    """  it("diagnose 只发送 workspaceRoot，并严格投影 live handshake 诊断字段", async () => {
    const expected = {
      processStable: true,
      initialize: true,
      ownerDiscovery: true,
      followingChangedSent: true,
      stateReceived: true,
      stateChange: "snapshot" as const,
    };
    const fake = fakeSpawner(request => request.op === "diagnose" ? {
      ok: true,
      value: { ...expected, token: "secret-token", desktopVersion: "26.9.0" },
    } : { ok: true, value: {} });
    await expect(makeClient(fake.spawnImpl).diagnose(target.workspaceRoot)).resolves.toEqual(expected);
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "workspaceRoot"]);
    expect(fake.requests[0].op).toBe("diagnose");
  });

  it("diagnose 错误不带回任意字段", async () => {
    const fake = fakeSpawner(request => request.op === "diagnose" ? {
      ok: false,
      code: "DESKTOP_STATE_UNAVAILABLE",
      notSent: true,
      compatibility: { token: "secret-token", rawError: "secret-error" },
    } : { ok: true, value: {} });
    try {
      await makeClient(fake.spawnImpl).diagnose(target.workspaceRoot);
      throw new Error("diagnose 错误未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE", notSent: true });
      expect(error).not.toHaveProperty("compatibility");
      expect(error).not.toHaveProperty("token");
      expect(String((error as Error).message)).not.toContain("secret");
    }
  });

""",
    "block-a",
)

# 8. 块 B：compatibility_audit 独立测试删除
cut_between(
    '  it("compatibility_audit 独立只发送 id/op，并严格投影 allowlist 字段", async () => {',
    '  it("handshake_audit 使用 workspaceRoot request shape',
    "",
    "block-b",
)

# 9. 块 C：handshake_audit + compatibility_audit validator 两测试删除
cut_between(
    '  it("handshake_audit 使用 workspaceRoot request shape',
    '  it("拒绝非法版本、profile 和 current 缺失诊断", () => {',
    "",
    "block-c",
)

# 10. 块 D：版本/profile validator 测试 → diagnose validator 测试
cut_between(
    '  it("拒绝非法版本、profile 和 current 缺失诊断", () => {',
    '  it("使用隔离、无 shell 的 helper，并保留中文多行正文直到接受回执", async () => {',
    """  it("diagnose validator 拒绝未知字段、缺字段和坏诊断值", () => {
    const base = {
      processStable: true,
      initialize: true,
      ownerDiscovery: true,
      followingChangedSent: true,
      stateReceived: true,
      stateChange: "snapshot" as const,
    };
    expect(validateDesktopDiagnosis(base)).toEqual(base);
    expect(() => validateDesktopDiagnosis({ ...base, extra: true })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, stateChange: "bad" })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, processStable: false })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, initialize: false })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, ownerDiscovery: "yes" })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, followingChangedSent: null })).toThrowError(/无法确认/);
  });

""",
    "block-d",
)

# 11. 块 E：helper 错误缺少 notSent 测试去掉 compatibility
cut_between(
    '  it("helper 错误缺少 notSent 时，send 仍按结果不明处理", async () => {',
    '  it("stdout 非法 UTF-8 作为协议错误处理，且不会把原始内容带回错误", async () => {',
    """  it("helper 错误缺少 notSent 时，send 仍按结果不明处理", async () => {
    const fake = fakeSpawner(request => {
      if (request.op === "send") return { ok: false, code: "DESKTOP_BUSY" };
      return {
        ok: true,
        value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot },
      };
    });
    const connection = await makeClient(fake.spawnImpl).prepare(target);
    try {
      await connection.send("执行修订");
      throw new Error("send 错误未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_BUSY", notSent: false });
    }
    connection.close();
  });

""",
    "block-e",
)

TESTS.write_text(text, encoding="utf-8")
print("desktop-ipc.test.ts surgery done;", len(text), "chars")
