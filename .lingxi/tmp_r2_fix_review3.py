# -*- coding: utf-8 -*-
"""R2 review-fix round 3: observed turns (non-exhausted canonical observe) + Node PROTOCOL_ERROR notSent."""
import ast
from pathlib import Path

ROOT = Path(r"D:\python\codex-with-chatgpt")


def patch(rel, replacements):
    p = ROOT / rel
    data = p.read_bytes().decode("utf-8")
    for item in replacements:
        old, new = item[0], item[1]
        expected = item[2] if len(item) > 2 else 1
        got = data.count(old)
        assert got == expected, f"{rel}: expected {expected} got {got} for: {old[:80]!r}"
        data = data.replace(old, new)
    if rel.endswith(".py"):
        ast.parse(data)
    p.write_bytes(data.encode("utf-8"))
    print(f"OK {rel}: {len(replacements)} replacement(s)")


# ---------- desktop_ipc.py ----------
# 修复 4：_observed_turns 允许 canonical non-exhausted（严格验结构）；
# _validate_observed_state / _active_turn_id 改用；_turns 保持严格供
# _assert_send_ready / result reconciliation / send before_turn_ids 使用。
patch("src/desktop/helper/desktop_ipc.py", [
    (
        """def _turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    history = state.get("turnHistory")
    if isinstance(history, dict) and history.get("kind") == "canonical":
        body = history.get("history")
        if not isinstance(body, dict) or not isinstance(body.get("islands"), list) or not body["islands"] or not isinstance(body.get("entitiesByKey"), dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        islands = body["islands"]
        if not isinstance(islands[-1], dict) or not isinstance(islands[-1].get("newerBoundary"), dict) or islands[-1]["newerBoundary"].get("status") != "exhausted":
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        turns: list[dict[str, Any]] = []
        for island in islands:
            if not isinstance(island, dict) or not isinstance(island.get("entries"), list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            for entry in island["entries"]:
                if not isinstance(entry, dict) or entry.get("value") not in body["entitiesByKey"]:
                    raise _error("DESKTOP_STATE_UNAVAILABLE")
                item = body["entitiesByKey"][entry["value"]]
                if not isinstance(item, dict):
                    raise _error("DESKTOP_STATE_UNAVAILABLE")
                turns.append(item)
        return turns
    turns = state.get("turns")
    if not isinstance(turns, list) or not all(isinstance(turn, dict) for turn in turns):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return turns""",
        """def _observed_turns(state: dict[str, Any], *, require_exhausted: bool = True) -> list[dict[str, Any]]:
    \"\"\"观察用 turn 集合：canonical 结构严格校验，exhausted 要求可配置。

    require_exhausted=True（默认）保持基线语义：canonical 最新 island 的
    newerBoundary 必须 exhausted。require_exhausted=False 供只读观察路径
    （validate/active）使用：真实 active 会话的 canonical history 正常处于
    loading，不能因此拒绝观察；islands/entities/entry 结构仍逐项严格校验。
    \"\"\"
    history = state.get("turnHistory")
    if isinstance(history, dict) and history.get("kind") == "canonical":
        body = history.get("history")
        if not isinstance(body, dict) or not isinstance(body.get("islands"), list) or not body["islands"] or not isinstance(body.get("entitiesByKey"), dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        islands = body["islands"]
        if require_exhausted and (not isinstance(islands[-1], dict) or not isinstance(islands[-1].get("newerBoundary"), dict) or islands[-1]["newerBoundary"].get("status") != "exhausted"):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        turns: list[dict[str, Any]] = []
        for island in islands:
            if not isinstance(island, dict) or not isinstance(island.get("entries"), list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            for entry in island["entries"]:
                if not isinstance(entry, dict) or entry.get("value") not in body["entitiesByKey"]:
                    raise _error("DESKTOP_STATE_UNAVAILABLE")
                item = body["entitiesByKey"][entry["value"]]
                if not isinstance(item, dict):
                    raise _error("DESKTOP_STATE_UNAVAILABLE")
                turns.append(item)
        return turns
    turns = state.get("turns")
    if not isinstance(turns, list) or not all(isinstance(turn, dict) for turn in turns):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return turns


def _turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    \"\"\"send-safe / result 语义的严格 turn 集合：canonical 必须 exhausted。\"\"\"
    return _observed_turns(state, require_exhausted=True)""",
    ),
    (
        """    terminal_statuses = {"completed", "failed", "interrupted", "cancelled"}
    for turn in _turns(state):""",
        """    terminal_statuses = {"completed", "failed", "interrupted", "cancelled"}
    for turn in _observed_turns(state):""",
    ),
    (
        """    active: list[str] = []
    for turn in _turns(state):""",
        """    active: list[str] = []
    for turn in _observed_turns(state):""",
    ),
    (
        """    "DESKTOP_PROTOCOL_ERROR": "Desktop IPC 返回无法确认的结果；不要重发。",""",
        """    "DESKTOP_PROTOCOL_ERROR": "Desktop 协议无法安全确认；没有发送消息。",""",
    ),
])

# ---------- desktop_protocol_test.py ----------
# 新测试：runtime=active + canonical newerBoundary=loading + one inProgress turn
# → inspect 成功、activeTurnId 可读、start-turn=0；同一状态 purpose="send" → BUSY。
patch("tests/desktop_protocol_test.py", [
    (
        """    def test_send_attestation_accepts_when_ack_turn_matches_envelope(self):""",
        """    def test_inspect_observes_active_canonical_loading_history_and_send_gates_busy(self):
        # 真实 active 会话的 canonical history 正常处于 loading（non-exhausted）：
        # observe 必须能完成 validate 并读出 activeTurnId；同一状态 send purpose
        # 仍被 BUSY 拒绝（_assert_send_ready 保持严格路径）。
        self.pipe.state.pop("turns", None)
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{
                "olderBoundary": {"status": "exhausted"},
                "entries": [{"value": "turn-old"}, {"value": "turn-active"}],
                "newerBoundary": {"status": "loading"},
            }],
            "entitiesByKey": {
                "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                "turn-active": {"turnId": NEW_TURN, "status": "inProgress"},
            },
        }}
        request = {"id": CLIENT, "op": "inspect", "target": self.target}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertTrue(response["ok"])
        self.assertEqual(response["value"]["runtimeStatus"], "active")
        self.assertEqual(self.pipe.starts(), [])

        self.assertEqual(h._active_turn_id(self.pipe.state), NEW_TURN)
        session, info = h._prepare(self.target, purpose="observe")
        self.assertEqual(info["runtimeStatus"], "active")
        session.close()
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="send")
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertEqual(self.pipe.starts(), [])

    def test_send_attestation_accepts_when_ack_turn_matches_envelope(self):""",
    ),
])

# ---------- ipc.ts ----------
# 修复 5（文案）：PROTOCOL_ERROR 以后主要表示 pre-start/read-only protocol failure。
patch("src/desktop/ipc.ts", [
    (
        """  DESKTOP_PROTOCOL_ERROR: "Desktop IPC 返回无法确认的结果；不要重发。",""",
        """  DESKTOP_PROTOCOL_ERROR: "Desktop 协议无法安全确认；没有发送消息。",""",
    ),
])

# ---------- service.ts ----------
# 修复 5（语义）：helper 在 mutation boundary 后已把 protocol error 统一转成
# OUTCOME_UNKNOWN/notSent=false，因此 PROTOCOL_ERROR+notSent=true 是 pre-start
# 证据，不再排除；OUTCOME_UNKNOWN 永远不能 rejected，IPC_REJECTED 保守保留。
patch("src/desktop/service.ts", [
    (
        """      // 只信受控适配器明确确认尚未进入 start 的白名单错误；任意 IPC 写入后异常均是 unknown。
        if (failure instanceof DesktopError && (failure as DesktopError & { notSent?: boolean }).notSent === true &&
        DESKTOP_IPC_ERROR_MESSAGES[failure.code] && !["DESKTOP_OUTCOME_UNKNOWN", "DESKTOP_PROTOCOL_ERROR", "DESKTOP_IPC_REJECTED"].includes(failure.code)) {""",
        """      // 只信受控适配器明确确认尚未进入 start 的白名单错误；任意 IPC 写入后异常均是 unknown。
      // R2 合同：helper 在 mutation boundary 后已把 protocol error 统一转成
      // OUTCOME_UNKNOWN/notSent=false，因此 PROTOCOL_ERROR+notSent=true 是 pre-start 证据。
      if (failure instanceof DesktopError && (failure as DesktopError & { notSent?: boolean }).notSent === true &&
        DESKTOP_IPC_ERROR_MESSAGES[failure.code] && !["DESKTOP_OUTCOME_UNKNOWN", "DESKTOP_IPC_REJECTED"].includes(failure.code)) {""",
    ),
])

# ---------- desktop-control.test.ts ----------
# 新测试：PROTOCOL_ERROR+notSent=true → rejected / unresolvedDelivery=false；
# 无 notSent 证据 → 仍 outcome_unknown。
patch("tests/desktop-control.test.ts", [
    (
        """  it("没有明确notSent证据不能将busy错误当成零发送", async () => {""",
        """  it("PROTOCOL_ERROR+notSent=true按pre-start证据保存rejected，无notSent仍unknown", async () => {
    enableDesktop(workspace, bindingId);
    send.mockRejectedValue(Object.assign(new DesktopError("DESKTOP_PROTOCOL_ERROR", "不能泄露的底层正文"), { notSent: true }));
    const rejected = await sendDesktop(workspace, input(), "client");
    expect(rejected).toMatchObject({ deliveryStatus: "rejected", error: "DESKTOP_PROTOCOL_ERROR" });
    expect(rejected.message).not.toContain("底层正文");
    expect((await desktopStatus(workspace)).unresolvedDelivery).toBe(false);
    send.mockRejectedValue(new DesktopError("DESKTOP_PROTOCOL_ERROR", "协议失败"));
    const unknown = await sendDesktop(workspace, input({ commandId: "explicit_new_request" }), "client");
    expect(unknown.deliveryStatus).toBe("outcome_unknown");
  });

  it("没有明确notSent证据不能将busy错误当成零发送", async () => {""",
    ),
])

print("ALL DONE")
