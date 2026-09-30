# -*- coding: utf-8 -*-
"""R2 review-fix round 2: boundary authority + first-snapshot identity + Node timeout + cleanup."""
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
# 修复 1：send() 成为 boundary authority。
# 修复 2：_assert_post_start_target helper，第一份与之后每份 post-start observation 都核对。
patch("src/desktop/helper/desktop_ipc.py", [
    (
        """    def send(self, message: str) -> dict[str, str]:
        \"\"\"Behavioral send attestation：单次 start-turn + 事后 canonical 证明。\"\"\"
        self.start_attempted = False
        _message(message)
        _query_standard_token()
        # ---- preflight：start-turn 之前，失败可返回具体错误且 notSent=true ----
        self._process_fence()
        self.client.discover()
        state = self.client.snapshot()
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        _query_standard_token()
        # 提交前最后核对进程与 owner；协议没有原子 idle/start CAS，故保持窗口有界。
        self._process_fence()
        self.client.drain(0.1)
        state = self.client.current_state()
        if state is None or self.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        # mutation boundary 前最后一次 targeted owner fence；协议没有原子
        # idle/start CAS，故把 owner 漂移窗口压到这次 discover 之后。
        self.client.discover()
""",
        """    def send(self, message: str) -> dict[str, str]:
        \"\"\"Behavioral send attestation：单次 start-turn + 事后 canonical 证明。\"\"\"
        self.start_attempted = False
        try:
            return self._send_inner(message)
        except DesktopIpcError as error:
            # boundary authority：start-turn 尝试之前，任何 DesktopIpcError 都没有
            # 送达字节，统一强制重投影为相同 code + notSent=true；boundary 之后
            # 统一收敛 unknown/false（见下方 except 分支）。
            if self.start_attempted:
                raise
            raise _error(error.code, not_sent=True) from error
        except Exception as error:
            if self.start_attempted:
                raise
            raise _error("DESKTOP_INTERNAL_ERROR", not_sent=True) from error

    def _send_inner(self, message: str) -> dict[str, str]:
        # ---- preflight：start-turn 之前，失败可返回具体错误且 notSent=true ----
        self._process_fence()
        self.client.discover()
        state = self.client.snapshot()
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        _query_standard_token()
        # 提交前最后核对进程与 owner；协议没有原子 idle/start CAS，故保持窗口有界。
        self._process_fence()
        self.client.drain(0.1)
        state = self.client.current_state()
        if state is None or self.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        # mutation boundary 前最后一次 targeted owner fence；协议没有原子
        # idle/start CAS，故把 owner 漂移窗口压到这次 discover 之后。
        self.client.discover()
""",
    ),
    (
        """            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            state = self.client.snapshot()
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- bounded wait：只轮询 state，绝不重发 start-turn ----
            # turnId 尚未出现可以继续等；duplicate / malformed / wrong text 立即 unknown；
            # deadline 内出现唯一精确 canonical turn 才成功。
            deadline = time.monotonic() + POST_START_STATE_DEADLINE_SECONDS
            while len(_find_live_turn_by_id(state, turn_id, message)) != 1:
                if time.monotonic() >= deadline:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                state = self.client.snapshot()
                if self.client.snapshot_serial <= before_serial:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                if state.get("id") != self.target["threadId"] or state.get("hostId") != self.target["hostId"]:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
""",
        """            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            state = self.client.snapshot()
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            _assert_post_start_target(state, self.target)
            # ---- bounded wait：只轮询 state，绝不重发 start-turn ----
            # turnId 尚未出现可以继续等；duplicate / malformed / wrong text 立即 unknown；
            # deadline 内出现唯一精确 canonical turn 才成功。
            deadline = time.monotonic() + POST_START_STATE_DEADLINE_SECONDS
            while len(_find_live_turn_by_id(state, turn_id, message)) != 1:
                if time.monotonic() >= deadline:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                state = self.client.snapshot()
                if self.client.snapshot_serial <= before_serial:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                _assert_post_start_target(state, self.target)
""",
    ),
    (
        """def _find_live_turn_by_id(""",
        """def _assert_post_start_target(state: dict[str, Any], target: dict[str, str]) -> None:
    \"\"\"post-start 每份 observation（含第一份）都必须仍指向绑定 target。\"\"\"
    if state.get("id") != target["threadId"] or state.get("hostId") != target["hostId"]:
        raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)


def _find_live_turn_by_id(""",
    ),
])

# ---------- desktop_protocol_test.py ----------
# 新测试 1：pre-start targeted discover timeout → notSent=true + start=0。
# 新测试 2：第一份 post-start state target 错误且包含 exact turn → OUTCOME_UNKNOWN。
patch("tests/desktop_protocol_test.py", [
    (
        """    def test_pre_start_owner_drift_after_final_state_check_is_not_sent(self):""",
        """    def test_pre_start_discover_timeout_is_not_sent_with_zero_starts(self):
        # boundary authority：pre-start targeted discover 超时（request 层默认
        # not_sent=False）必须在 send() 边界被强制重投影为 notSent=true，且
        # start-turn 计数为 0。
        session, _ = h._prepare(self.target)
        self.pipe.suppressed.add("thread-owner-discovery")
        with patch.object(h, "DISCOVERY_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_IPC_TIMEOUT")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])
        session.close()

    def test_post_start_wrong_target_on_first_observation_is_outcome_unknown(self):
        # 第一份 post-start snapshot 的 conversationState 本体指向错误 target
        # （广播帧参数匹配、body id/hostId 错误）且恰好包含 exact turn →
        # OUTCOME_UNKNOWN，start-turn 恰好一次。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        original_write = self.pipe.write

        def write_with_wrong_target(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["id"] = "01a00000-0000-7000-8000-000000000009"
                self.pipe.state["hostId"] = "remote"
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-old"}, {"value": "turn-new"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {
                        "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                        "turn-new": turn,
                    },
                }}

        with patch.object(self.pipe, "write", write_with_wrong_target):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_pre_start_owner_drift_after_final_state_check_is_not_sent(self):""",
    ),
])

# ---------- ipc.ts ----------
# 修复 3：Node outer send timeout 必须大于 helper 整条 send 上界并留余量。
# 洁癖项：删除 HelperResponse.compatibility 残留。
patch("src/desktop/ipc.ts", [
    (
        """type HelperResponse = {
  id?: unknown;
  ok?: unknown;
  value?: unknown;
  code?: unknown;
  notSent?: unknown;
  compatibility?: unknown;
};""",
        """type HelperResponse = {
  id?: unknown;
  ok?: unknown;
  value?: unknown;
  code?: unknown;
  notSent?: unknown;
};""",
    ),
    (
        """const DEFAULT_SEND_TIMEOUT_MS = 40_000;
const MAX_TIMEOUT_MS = 60_000;""",
        """// helper 单次 send 最坏路径上界（preflight 双份 5s discovery/snapshot +
// drain/current_state + 30s start-turn ACK + 10s post-start bounded wait +
// final discovery ≈ 76s）；外层超时必须大于该上界并留余量，否则 Node 会在
// helper 仍处于合法 bounded proof window 时先杀掉它，制造不必要的
// durable outcome_unknown。
const DEFAULT_SEND_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 120_000;""",
    ),
])

# ---------- executor/index.ts ----------
# 洁癖项：注释与 R2 后的职责划分一致（版本已退出 identity）。
patch("src/executor/index.ts", [
    (
        """/** 只包装现有 IPC；身份、版本、owner、审批和 busy 校验仍由 desktopIpc/helper 负责。 */""",
        """/** 只包装现有 IPC；身份、owner、审批和 busy 校验仍由 desktopIpc/helper 负责。 */""",
    ),
])

print("ALL DONE")
