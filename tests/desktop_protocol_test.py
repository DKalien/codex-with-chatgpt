"""真实 helper 流程 + 假 pipe/WinAPI；不连接 Desktop、不读取用户配置。"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/desktop/helper"))
import desktop_ipc as h

THREAD = "01a00000-0000-7000-8000-000000000001"
OWNER = "01a00000-0000-7000-8000-000000000002"
CLIENT = "01a00000-0000-7000-8000-000000000003"
OLD_TURN = "01a00000-0000-7000-8000-000000000004"
NEW_TURN = "01a00000-0000-7000-8000-000000000005"
PROCESS = {"desktopPid": 100, "appServerPid": 101}

class FakePipe:
    def __init__(self, target):
        self.target = target
        self.state = {"id": THREAD, "hostId": "local", "cwd": target["workspaceRoot"], "title": "测试会话",
                      "workspaceKind": "project", "resumeState": "resumed", "threadRuntimeStatus": {"type": "idle"},
                      "requests": [], "unconfirmedTurnSubmissions": [], "environments": [],
                      "turns": [{"turnId": OLD_TURN, "status": "completed"}]}
        self.frames, self.pending = [], []
        self.owner = OWNER
        self.turn_id = NEW_TURN
        self.failure = None
        self.response_errors = {}
        self.suppressed = set()
        self.suppress_after_start = set()
        self.start_seen = False
        self.closed = False
        self.server_pid = 100
        self.server_exe = str(Path(target["workspaceRoot"]) / "ChatGPT.exe")

    def verify_server(self):
        pass

    def write(self, raw):
        value = h._Decoder().feed(raw)[0]
        self.frames.append(value)
        method = value.get("method")
        if method in self.suppressed:
            return
        if method in self.response_errors and "requestId" in value:
            self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],
                "resultType": "error", "error": self.response_errors[method]}))
            return
        if method == "thread-stream-following-changed":
            if self.start_seen and method in self.suppress_after_start:
                return
            self.pending.append(h._frame({"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,
                "sourceClientId": OWNER, "params": {"conversationId": THREAD, "hostId": "local",
                "change": {"type": "snapshot", "conversationState": copy.deepcopy(self.state), "revision": 1}}}))
            return
        result = {}
        if method == "initialize":
            result = {"clientId": CLIENT}
        if method == "thread-follower-start-turn":
            self.start_seen = True
            if self.failure == "partial_write":
                raise h.DesktopIpcError("DESKTOP_IPC_UNAVAILABLE", "敏感底层正文", not_sent=True)
            if self.failure == "lost_receipt":
                return
            result = {"result": {"turn": {"id": self.turn_id, "status": "inProgress"}}}
        self.pending.append(h._frame({"type": "response", "method": method, "version": value["version"],
            "requestId": value["requestId"], "resultType": "success", "handledByClientId": self.owner, "result": result}))

    def read(self, timeout):
        if self.pending:
            return self.pending.pop(0)
        raise TimeoutError()

    def close(self):
        self.closed = True

    def starts(self):
        return [frame for frame in self.frames if frame.get("method") == "thread-follower-start-turn"]


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="c2c-desktop-offline-")
        self.addCleanup(self.temp.cleanup)
        self.target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": self.temp.name}
        self.pipe = FakePipe(self.target)
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
                {"pid": 101, "parentPid": 100, "name": "codex.exe",
                 "exe": str(Path(self.temp.name) / "codex.exe"), "creation": 11}]
        self.state_file = Path(self.temp.name) / "global-state.json"
        self.state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        for name, replacement in (("_Pipe", Mock(return_value=self.pipe)), ("_query_standard_token", Mock()),
                                  ("_processes", Mock(return_value=rows)),
                                  ("_global_state_path", Mock(return_value=self.state_file))):
            active = patch.object(h, name, replacement)
            active.start()
            self.addCleanup(active.stop)

    def _send_fixture(self, *, turn_id=NEW_TURN, message="完整方案"):
        """send attestation 测试夹具：ACK turn 已进入 non-exhausted canonical 历史。"""
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": turn_id, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.state["turns"] = list(self.pipe.state.get("turns", [])) + [turn]
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
        self.pipe.turn_id = turn_id
        return message

    def _inject_on_start(self, injected):
        """让 pipe 在收到 start-turn 后把指定 turn 追加进状态与 canonical 历史。"""
        original_write = self.pipe.write

        def write_with_turns(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turns"].extend(copy.deepcopy(injected))
                entities = {"turn-old": {"turnId": OLD_TURN, "status": "completed"}}
                entries = [{"value": "turn-old"}]
                for index, item in enumerate(injected):
                    key = f"turn-new-{index}"
                    entries.append({"value": key})
                    entities[key] = copy.deepcopy(item)
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": entries,
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": entities,
                }}

        return patch.object(self.pipe, "write", write_with_turns)

    def test_observe_allows_active_and_pending_states_without_start(self):
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        session, info = h._prepare(self.target, purpose="observe")
        self.assertEqual(info["runtimeStatus"], "active")
        self.assertEqual(self.pipe.starts(), [])
        session.close()

        self.pipe.state["requests"] = [{"kind": "approval"}]
        session, info = h._prepare(self.target, purpose="observe")
        self.assertEqual(info["requestsCount"], 1)
        self.assertEqual(self.pipe.starts(), [])
        session.close()

    def test_prepare_rejects_invalid_turn_status_even_when_observing(self):
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "futureStatus"}]
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="observe")
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(self.pipe.starts(), [])

    def test_prepare_send_gate_rejects_active_and_pending_with_busy(self):
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertEqual(self.pipe.starts(), [])

    def test_inspect_observes_active_and_pending_without_start_turn(self):
        # inspect 是 observe purpose：active + pending approval 仍可观察，绝不 start-turn。
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["requests"] = [{"kind": "approval"}]
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        request = {"id": CLIENT, "op": "inspect", "target": self.target}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertTrue(response["ok"])
        self.assertEqual(response["value"]["runtimeStatus"], "active")
        self.assertEqual(response["value"]["requestsCount"], 1)
        self.assertEqual(self.pipe.starts(), [])

    def test_prepare_send_purpose_gates_active_and_pending(self):
        # 同一状态：send purpose 的 prepare 分别被 BUSY / APPROVAL_PENDING 拒绝。
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="send")
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertEqual(self.pipe.starts(), [])

        self.pipe.state["threadRuntimeStatus"] = {"type": "idle"}
        self.pipe.state["requests"] = [{"kind": "approval"}]
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="send")
        self.assertEqual(caught.exception.code, "DESKTOP_APPROVAL_PENDING")
        self.assertEqual(self.pipe.starts(), [])

    def test_inspect_observes_active_canonical_loading_history_and_send_gates_busy(self):
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
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
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

    def test_send_attestation_accepts_when_ack_turn_matches_envelope(self):
        session, _ = h._prepare(self.target)
        message = "完整中文方案\n```python\nprint('你好')\n```"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with self._inject_on_start([turn]):
            self.assertEqual(session.send(message), {"threadId": THREAD, "turnId": NEW_TURN})
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_waits_for_unique_inprogress_user_message_mirror(self):
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        partial = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                   "items": [{"type": "userMessage"}]}
        complete = {**partial, "items": [{"type": "userMessage", "content": [item]}]}
        observations = {"count": 0}
        with self._inject_on_start([partial]), patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 2.0):
            original_write = self.pipe.write

            def write_complete_on_second_snapshot(raw):
                value = h._Decoder().feed(raw)[0]
                if self.pipe.start_seen and value.get("method") == "thread-stream-following-changed":
                    observations["count"] += 1
                    if observations["count"] == 2:
                        self.pipe.state["turns"][-1] = copy.deepcopy(complete)
                        self.pipe.state["turnHistory"]["history"]["entitiesByKey"]["turn-new-0"] = copy.deepcopy(complete)
                original_write(raw)

            with patch.object(self.pipe, "write", write_complete_on_second_snapshot):
                self.assertEqual(session.send(message), {"threadId": THREAD, "turnId": NEW_TURN})
        self.assertEqual(observations["count"], 2)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_complete_wrong_params_input_is_immediately_unknown(self):
        session, _ = h._prepare(self.target)
        wrong = {"type": "text", "text": "错误正文", "text_elements": []}
        partial = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [wrong]}}
        with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 2.0), self._inject_on_start([partial]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_terminal_ack_with_incomplete_mirror_is_unknown(self):
        session, _ = h._prepare(self.target)
        item = {"type": "text", "text": "完整方案", "text_elements": []}
        terminal = {"turnId": NEW_TURN, "status": "completed", "params": {"input": [item]}}
        with self._inject_on_start([terminal]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_send_attestation_fails_closed_when_ack_turn_missing_or_ambiguous(self):
        item = {"type": "text", "text": "完整方案", "text_elements": []}
        matching = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                    "items": [{"type": "userMessage", "content": [item]}]}
        mismatched = {"turnId": NEW_TURN, "status": "inProgress",
                      "params": {"input": [{"type": "text", "text": "别的消息", "text_elements": []}]},
                      "items": [{"type": "userMessage", "content": [
                          {"type": "text", "text": "别的消息", "text_elements": []}]}]}
        cases = {"missing": [], "mismatched": [mismatched], "duplicated": [matching, matching]}
        for name, injected in cases.items():
            with self.subTest(case=name):
                self.pipe.closed = False
                self.pipe.frames.clear()
                self.pipe.pending.clear()
                self.pipe.start_seen = False
                self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "completed"}]
                self.pipe.state.pop("turnHistory", None)
                session, _ = h._prepare(self.target)
                with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 0.1), \
                        self._inject_on_start(injected):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        session.send("完整方案")
                self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
                self.assertFalse(caught.exception.not_sent)
                self.assertEqual(len(self.pipe.starts()), 1)
                session.close()

    def test_post_start_state_unavailable_becomes_outcome_unknown(self):
        # 硬验收：mutation boundary 之后收到的普通 DESKTOP_STATE_UNAVAILABLE
        # 必须对外收敛为 OUTCOME_UNKNOWN / notSent=false，且 start-turn 恰好一次。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.suppress_after_start.add("thread-stream-following-changed")
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05), self._inject_on_start([turn]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

    def test_pre_start_state_unavailable_keeps_not_sent_and_zero_starts(self):
        # 硬验收：同样的 DESKTOP_STATE_UNAVAILABLE 发生在 start-turn 之前时，
        # 必须保持 notSent=true 且 start-turn 计数为 0。
        session, _ = h._prepare(self.target)
        self.pipe.suppressed.add("thread-stream-following-changed")
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])

    def test_send_attestation_rejects_mixed_duplicate_turn_id(self):
        # 同一 turnId 出现两次：一个正文精确、一个正文错误。先按 turnId 判重
        # （必须恰好 1 个 occurrence），因此必须收敛 OUTCOME_UNKNOWN。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        exact = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                 "items": [{"type": "userMessage", "content": [item]}]}
        wrong_item = {"type": "text", "text": "别的消息", "text_elements": []}
        wrong = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [wrong_item]},
                 "items": [{"type": "userMessage", "content": [wrong_item]}]}
        original_write = self.pipe.write

        def write_with_mixed(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-a"}, {"value": "turn-b"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {"turn-a": exact, "turn-b": wrong},
                }}

        with patch.object(self.pipe, "write", write_with_mixed):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_bounded_wait_accepts_turn_on_second_observation(self):
        # ACK 后第一次 fresh canonical snapshot 还没有该 turn；有界等待内第二次
        # observation 出现唯一精确 turn → 成功，且 start-turn 仍恰好一次。
        # pre-start 即为 exhausted canonical（无 ACK turn），post-start 证明接受
        # boundary 变为 loading 的 non-exhausted canonical。
        self.pipe.state.pop("turns", None)
        self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{
                "olderBoundary": {"status": "exhausted"},
                "entries": [{"value": "turn-old"}],
                "newerBoundary": {"status": "exhausted"},
            }],
            "entitiesByKey": {"turn-old": {"turnId": OLD_TURN, "status": "completed"}},
        }}
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        original_write = self.pipe.write
        observations = {"count": 0}

        def write_with_late_turn(raw):
            original_write(raw)
            if self.pipe.start_seen and self.pipe.frames[-1].get("method") == "thread-stream-following-changed":
                observations["count"] += 1
                if observations["count"] >= 2:
                    self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                        "islands": [{
                            "olderBoundary": {"status": "exhausted"},
                            "entries": [{"value": "turn-old"}, {"value": "turn-new"}],
                            "newerBoundary": {"status": "loading"},
                        }],
                        "entitiesByKey": {
                            "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                            "turn-new": copy.deepcopy(turn),
                        },
                    }}

        with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 2.0), \
                patch.object(self.pipe, "write", write_with_late_turn):
            self.assertEqual(session.send(message), {"threadId": THREAD, "turnId": NEW_TURN})
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_bounded_wait_expires_as_outcome_unknown(self):
        # 有界等待内 canonical state 始终没有 ACK turn → OUTCOME_UNKNOWN，且不重发。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        original_write = self.pipe.write

        def write_without_turn(raw):
            original_write(raw)
            if self.pipe.start_seen and self.pipe.frames[-1].get("method") == "thread-stream-following-changed":
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-old"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {"turn-old": {"turnId": OLD_TURN, "status": "completed"}},
                }}

        with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 1.0), \
                patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05), \
                patch.object(self.pipe, "write", write_without_turn):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_process_drift_is_outcome_unknown(self):
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
                {"pid": 101, "parentPid": 100, "name": "codex.exe",
                 "exe": str(Path(self.temp.name) / "codex.exe"), "creation": 11}]

        def processes():
            return [] if self.pipe.start_seen else rows

        with patch.object(h, "_processes", side_effect=processes), self._inject_on_start([turn]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

    def test_post_start_owner_drift_is_outcome_unknown(self):
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with patch.object(h._IpcClient, "discover", side_effect=[None, None, h._error("DESKTOP_OWNER_CHANGED")]), \
                self._inject_on_start([turn]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

    def test_real_protocol_flow_keeps_text_and_only_accepts_without_completion(self):
        session, info = h._prepare(self.target)
        text = "完整中文方案\n```python\nprint('你好')\n```"
        item = {"type": "text", "text": text, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with self._inject_on_start([turn]):
            self.assertEqual(session.send(text), {"threadId": THREAD, "turnId": NEW_TURN})
        self.assertEqual(info["title"], "测试会话")
        start = self.pipe.starts()[0]
        self.assertEqual(start["version"], 2)
        self.assertNotIn("hostId", start)
        self.assertEqual(start["sourceClientId"], CLIENT)
        self.assertEqual(start["targetClientId"], OWNER)
        self.assertEqual(start["params"], {"conversationId": THREAD, "turnStart": {"request": {
            "threadId": THREAD, "input": [{"type": "text", "text": text, "text_elements": []}]}}})
        self.assertEqual([frame["method"] for frame in self.pipe.frames if frame["type"] == "request"],
                         ["initialize", "thread-owner-discovery", "thread-owner-discovery",
                          "thread-owner-discovery", "thread-follower-start-turn", "thread-owner-discovery"])
        newer = self.pipe.state["turnHistory"]["history"]["islands"][0]["newerBoundary"]
        self.assertNotEqual(newer.get("status"), "exhausted")
        session.close()

    def test_last_check_busy_is_definitely_not_sent(self):
        session, _ = h._prepare(self.target)
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            session.send("已确认计划")
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])

    def test_pre_start_discover_timeout_is_not_sent_with_zero_starts(self):
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

    def test_pre_start_owner_drift_after_final_state_check_is_not_sent(self):
        # 最后一次状态检查之后的 targeted owner fence 发现漂移 → 具体错误 + notSent=true，
        # start-turn 计数为 0；post-start final fence 不受影响。
        session, _ = h._prepare(self.target)
        with patch.object(h._IpcClient, "discover",
                          side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]), \
                self.assertRaises(h.DesktopIpcError) as caught:
            session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_OWNER_CHANGED")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])
        session.close()

    def test_current_identity_uses_current_env_mapping_and_allows_active_without_start(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor") as ancestor:
            info = h._current_identity(self.temp.name)
        self.assertEqual(info["threadId"], THREAD)
        self.assertEqual(info["projectId"], "project_test")
        self.assertEqual(info["runtimeStatus"], "active")
        process = {"desktopPid": 100, "desktopExe": str(Path(self.temp.name) / "ChatGPT.exe"),
                   "desktopCreation": 10, "appServerPid": 101,
                   "appServerExe": str(Path(self.temp.name) / "codex.exe"), "appServerCreation": 11}
        ancestor.assert_called_once_with(process)
        self.assertEqual(self.pipe.starts(), [])

    def test_current_execution_reads_single_active_turn_from_flat_and_canonical_state(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        cases = [
            ("flat", {"turns": [{"turnId": NEW_TURN, "status": "inProgress"}]}),
            ("canonical", {"turnHistory": {"kind": "canonical", "history": {
                "islands": [{"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}}],
                "entitiesByKey": {"turn-1": {"turnId": NEW_TURN, "status": "inProgress"}},
            }}}),
        ]
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"):
            for shape, turns in cases:
                with self.subTest(shape=shape):
                    self.pipe.state.pop("turns", None)
                    self.pipe.state.pop("turnHistory", None)
                    self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
                    self.pipe.state.update(copy.deepcopy(turns))
                    info = h._current_execution(self.temp.name)
                    self.assertEqual(info["activeTurnId"], NEW_TURN)
                    self.assertEqual(info["runtimeStatus"], "active")
        self.assertEqual(self.pipe.starts(), [])

    def test_current_execution_rejects_missing_multiple_unknown_or_invalid_active_turn(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        cases = [
            ("missing", {"turns": []}),
            ("multiple", {"turns": [
                {"turnId": NEW_TURN, "status": "inProgress"},
                {"turnId": "01a00000-0000-7000-8000-000000000006", "status": "inProgress"},
            ]}),
            ("unknown_status", {"turns": [{"turnId": NEW_TURN, "status": "futureStatus"}]}),
            ("invalid_uuid", {"turns": [{"turnId": "not-a-uuid", "status": "inProgress"}]}),
            ("idle_runtime", {"turns": [{"turnId": NEW_TURN, "status": "inProgress"}],
                              "threadRuntimeStatus": {"type": "idle"}}),
        ]
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"):
            for name, update in cases:
                with self.subTest(case=name):
                    self.pipe.state.pop("turnHistory", None)
                    self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
                    self.pipe.state.update(copy.deepcopy(update))
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_execution(self.temp.name)
                    self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(self.pipe.starts(), [])

    def test_current_execution_rejects_forged_context_without_runner_ancestor(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
        failure = h._error("DESKTOP_CURRENT_CONTEXT_INVALID")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor", side_effect=failure) as ancestor:
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_execution(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_CURRENT_CONTEXT_INVALID")
        process = {"desktopPid": 100, "desktopExe": str(Path(self.temp.name) / "ChatGPT.exe"),
                   "desktopCreation": 10, "appServerPid": 101,
                   "appServerExe": str(Path(self.temp.name) / "codex.exe"), "appServerCreation": 11}
        ancestor.assert_called_once_with(process)
        self.assertEqual(self.pipe.starts(), [])

    def test_inspect_result_context_uses_explicit_target_without_runner_ancestor(self):
        turn = {"turnId": OLD_TURN, "status": "completed"}
        self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}}],
            "entitiesByKey": {"turn-1": turn},
        }}
        with patch.object(h, "_verify_current_runner_ancestor", side_effect=AssertionError("detached worker must not use runner proof")):
            result = h._inspect_result_context(self.target)
        self.assertEqual(result["threadId"], THREAD)
        self.assertEqual(result["resultTurnId"], OLD_TURN)
        self.assertEqual(result["resultTurnStatus"], "completed")
        self.assertEqual(self.pipe.starts(), [])

    def test_current_execution_rechecks_snapshot_age_after_runtime_validation(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
        ages = iter([0.0, 0.0, 0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0,
                     h.MAX_OBSERVATION_AGE_SECONDS + 1.0])
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h._IpcClient, "snapshot_age", side_effect=lambda: next(ages)):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_execution(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(self.pipe.starts(), [])

    def _current_execution_fixture(self, *, new_turn=NEW_TURN, ages=(0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0, 0.0),
                                    advance_serial=True):
        target = self.target
        old = {"id": THREAD, "hostId": "local", "cwd": target["workspaceRoot"], "title": "测试会话",
               "workspaceKind": "project", "resumeState": "resumed", "threadRuntimeStatus": {"type": "active"},
               "requests": [], "unconfirmedTurnSubmissions": [], "environments": [],
               "turns": [{"turnId": OLD_TURN, "status": "inProgress"}]}
        new = copy.deepcopy(old)
        new["turns"] = [{"turnId": new_turn, "status": "inProgress"}]

        class Client:
            owner = OWNER

            def __init__(self):
                self.snapshot_serial = 7
                self.snapshot_calls = 0
                self._ages = iter(ages)

            def drain(self, _timeout):
                return None

            def current_state(self):
                return copy.deepcopy(old)

            def snapshot_age(self):
                return next(self._ages)

            def snapshot(self):
                self.snapshot_calls += 1
                if advance_serial:
                    self.snapshot_serial += 1
                return copy.deepcopy(new)

        client = Client()
        pipe = SimpleNamespace(verify_server=Mock(), starts=lambda: [])
        session = SimpleNamespace(client=client, pipe=pipe, process=PROCESS, close=Mock())
        return target, session, client, pipe

    def test_current_execution_freshness_refreshes_same_active_turn(self):
        target, session, client, pipe = self._current_execution_fixture()
        with patch.object(h, "_current_target", return_value=target), \
                patch.object(h, "_prepare", return_value=(session, {})), \
                patch.object(h, "_validate_observed_state") as validate, \
                patch.object(h, "_verify_process_identity", return_value=PROCESS) as verify_process, \
                patch.object(h, "_verify_current_runner_ancestor") as runner, \
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], NEW_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(pipe.verify_server.call_count, 1)
        self.assertEqual(verify_process.call_count, 2)
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(validate.call_count, 2)
        self.assertEqual(pipe.starts(), [])

    def test_current_execution_freshness_refresh_returns_new_active_turn(self):
        target, session, client, pipe = self._current_execution_fixture(new_turn="01a00000-0000-7000-8000-000000000006")
        with patch.object(h, "_current_target", return_value=target), \
                patch.object(h, "_prepare", return_value=(session, {})), \
                patch.object(h, "_validate_observed_state"), \
                patch.object(h, "_verify_process_identity", return_value=PROCESS) as verify_process, \
                patch.object(h, "_verify_current_runner_ancestor") as runner, \
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], "01a00000-0000-7000-8000-000000000006")
        self.assertNotEqual(result["activeTurnId"], OLD_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(verify_process.call_count, 2)
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(pipe.starts(), [])

    def test_current_execution_freshness_refresh_fail_closed(self):
        cases = {
            "timeout": (0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0, 0.0),
            "stale_after_refresh": (0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0,
                                     h.MAX_OBSERVATION_AGE_SECONDS + 1.0),
            "serial_not_advanced": (0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0),
        }
        for name, ages in cases.items():
            with self.subTest(case=name):
                target, session, client, pipe = self._current_execution_fixture(
                    ages=ages, advance_serial=name != "serial_not_advanced")
                if name == "timeout":
                    clock = iter([0.0, h.SNAPSHOT_TIMEOUT_SECONDS + 1.0])
                    monotonic = patch.object(h.time, "monotonic", side_effect=lambda: next(clock))
                else:
                    monotonic = patch.object(h.time, "monotonic", wraps=h.time.monotonic)
                with monotonic, \
                        patch.object(h, "_current_target", return_value=target), \
                        patch.object(h, "_prepare", return_value=(session, {})), \
                        patch.object(h, "_validate_observed_state"), \
                        patch.object(h, "_verify_process_identity", return_value=PROCESS), \
                        patch.object(h, "_verify_current_runner_ancestor"), \
                        patch.object(h, "_public_info", return_value={}):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_execution(target["workspaceRoot"])
                self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
                self.assertLessEqual(client.snapshot_calls, 1)
                self.assertEqual(pipe.starts(), [])

    def test_current_execution_freshness_refresh_rechecks_security_guards(self):
        cases = {
            "pipe": ("_pipe", h._error("DESKTOP_PROCESS_CHANGED")),
            "process": ("_process", h._error("DESKTOP_PROCESS_CHANGED")),
            "state": ("_state", h._error("DESKTOP_PROJECT_MISMATCH")),
            "owner": ("_state", h._error("DESKTOP_NO_OWNER")),
            "runner": ("_runner", h._error("DESKTOP_CURRENT_CONTEXT_INVALID")),
        }
        for name, (guard, failure) in cases.items():
            with self.subTest(guard=name):
                target, session, client, pipe = self._current_execution_fixture()
                if guard == "_pipe":
                    pipe.verify_server.side_effect = failure
                with patch.object(h, "_current_target", return_value=target), \
                        patch.object(h, "_prepare", return_value=(session, {})), \
                        patch.object(h, "_validate_observed_state") as default_validate, \
                        patch.object(h, "_verify_process_identity", return_value=PROCESS) as default_process, \
                        patch.object(h, "_verify_current_runner_ancestor") as default_runner, \
                        patch.object(h, "_public_info", return_value={}):
                    if guard == "_process":
                        default_process.side_effect = [PROCESS, failure]
                    elif guard == "_state":
                        default_validate.side_effect = [None, failure]
                    elif guard == "_runner":
                        default_runner.side_effect = [None, failure]
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_execution(target["workspaceRoot"])
                self.assertEqual(caught.exception.code, failure.code)
                self.assertLessEqual(client.snapshot_calls, 1)
                self.assertEqual(pipe.starts(), [])

    def test_current_result_context_accepts_active_or_complete_latest_terminal_history(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        canonical = {
            "turnHistory": {"kind": "canonical", "history": {
                "islands": [{
                    "olderBoundary": {"status": "exhausted"},
                    "entries": [{"value": "turn-1"}, {"value": "turn-2"}],
                    "newerBoundary": {"status": "exhausted"},
                }],
                "entitiesByKey": {
                    "turn-1": {"turnId": OLD_TURN, "status": "completed"},
                    "turn-2": {"turnId": NEW_TURN, "status": "failed"},
                },
            }},
        }
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"):
            self.pipe.state.pop("turns", None)
            self.pipe.state.update(copy.deepcopy(canonical))
            result = h._current_result_context(self.temp.name)
            self.assertEqual(result["runtimeStatus"], "idle")
            self.assertEqual(result["resultTurnId"], NEW_TURN)
            self.assertEqual(result["resultTurnStatus"], "failed")

            canonical["turnHistory"]["history"]["islands"][0]["olderBoundary"] = {"status": "loading"}
            self.pipe.state.update(copy.deepcopy(canonical))
            result = h._current_result_context(self.temp.name)
            self.assertEqual(result["resultTurnId"], NEW_TURN)

            canonical["turnHistory"]["history"]["islands"] = [
                {"olderBoundary": {"status": "loading"}, "entries": [{"value": "turn-1"}], "newerBoundary": {"status": "loading"}},
                {"olderBoundary": {"status": "exhausted"}, "entries": [{"value": "turn-2"}], "newerBoundary": {"status": "exhausted"}},
            ]
            self.pipe.state.update(copy.deepcopy(canonical))
            result = h._current_result_context(self.temp.name)
            self.assertEqual(result["resultTurnId"], NEW_TURN)

            self.pipe.state.pop("turnHistory", None)
            self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
            self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
            result = h._current_result_context(self.temp.name)
            self.assertEqual(result["runtimeStatus"], "active")
            self.assertEqual(result["resultTurnId"], NEW_TURN)
            self.assertEqual(result["resultTurnStatus"], "inProgress")

    def test_current_result_context_rejects_incomplete_or_ambiguous_idle_history(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        base_history = {
            "kind": "canonical", "history": {
                "islands": [{
                    "olderBoundary": {"status": "exhausted"},
                    "entries": [{"value": "turn-1"}, {"value": "turn-2"}],
                    "newerBoundary": {"status": "exhausted"},
                }],
                "entitiesByKey": {
                    "turn-1": {"turnId": OLD_TURN, "status": "completed"},
                    "turn-2": {"turnId": NEW_TURN, "status": "completed"},
                },
            },
        }
        cases = {
            "flat": {"turns": [{"turnId": NEW_TURN, "status": "completed"}]},
            "newer_not_exhausted": {"turnHistory": {**base_history, "history": {
                **base_history["history"], "islands": [{**base_history["history"]["islands"][0],
                    "newerBoundary": {"status": "loading"}}],
            }}},
            "multiple_islands": {"turnHistory": {**base_history, "history": {
                **base_history["history"], "islands": base_history["history"]["islands"] * 2,
            }}},
            "duplicate_turn_id": {"turnHistory": {**base_history, "history": {
                **base_history["history"], "entitiesByKey": {
                    **base_history["history"]["entitiesByKey"], "turn-2": {"turnId": OLD_TURN, "status": "completed"},
                },
            }}},
            "idle_in_progress": {"turnHistory": {**base_history, "history": {
                **base_history["history"], "entitiesByKey": {
                    **base_history["history"]["entitiesByKey"], "turn-2": {"turnId": NEW_TURN, "status": "inProgress"},
                },
            }}},
        }
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"):
            for name, update in cases.items():
                with self.subTest(case=name):
                    self.pipe.state["threadRuntimeStatus"] = {"type": "idle"}
                    self.pipe.state.pop("turns", None)
                    self.pipe.state.pop("turnHistory", None)
                    self.pipe.state.update(copy.deepcopy(update))
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_result_context(self.temp.name)
                    self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def test_current_result_context_refreshes_stale_snapshot_for_new_turn(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        ages = iter([0.1, 1.0, 1.1, 3.0, 0.1])

        def snapshot_age():
            age = next(ages)
            if age == 3.0:
                self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
            return age

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h._IpcClient, "snapshot_age", side_effect=snapshot_age):
            result = h._current_result_context(self.temp.name)
        self.assertEqual(result["resultTurnId"], NEW_TURN)
        self.assertEqual(sum(frame.get("method") == "thread-stream-following-changed" for frame in self.pipe.frames), 2)

    def test_current_result_context_refresh_timeout_or_stale_remains_unavailable(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        original_snapshot = h._IpcClient.snapshot

        for failure in ("timeout", "stale"):
            with self.subTest(failure=failure):
                self.pipe.closed = False
                self.pipe.frames.clear()
                calls = 0

                def snapshot(client):
                    nonlocal calls
                    calls += 1
                    if calls == 2 and failure == "timeout":
                        raise h._error("DESKTOP_STATE_UNAVAILABLE")
                    return original_snapshot(client)

                values = [0.1, 1.0, 1.1, 3.0]
                if failure == "stale":
                    values.append(3.0)
                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                        patch.object(h, "_global_state_path", return_value=state_file), \
                        patch.object(h, "_verify_current_runner_ancestor"), \
                        patch.object(h._IpcClient, "snapshot_age", side_effect=iter(values)), \
                        patch.object(h._IpcClient, "snapshot", new=snapshot):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_result_context(self.temp.name)
                self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
                self.assertEqual(calls, 2)
                self.assertTrue(self.pipe.closed)

    def test_current_result_context_refresh_rechecks_pipe_server_identity(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h._IpcClient, "snapshot_age", side_effect=iter([0.1, 1.0, 1.1, 3.0])), \
                patch.object(self.pipe, "verify_server", side_effect=h._error("DESKTOP_PROCESS_CHANGED")) as verify:
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_result_context(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_PROCESS_CHANGED")
        verify.assert_called_once_with()
        self.assertTrue(self.pipe.closed)

    def test_current_result_context_refresh_has_independent_runtime_freshness_bound(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        ages = iter([0.1, 1.0, 1.1, 3.0, 0.1])
        real_monotonic = h.time.monotonic
        expired = False
        verify_calls = 0

        def monotonic():
            return real_monotonic() + (h.SNAPSHOT_TIMEOUT_SECONDS + 1.0 if expired else 0.0)

        def verify_process(*args):
            nonlocal expired, verify_calls
            verify_calls += 1
            if verify_calls == 3:
                expired = True
            return PROCESS

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h, "_verify_process_identity", side_effect=verify_process), \
                patch.object(h._IpcClient, "snapshot_age", side_effect=iter(ages)), \
                patch.object(h.time, "monotonic", new=monotonic):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_result_context(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(verify_calls, 3)
        self.assertEqual(sum(frame.get("method") == "thread-stream-following-changed" for frame in self.pipe.frames), 1)

    def test_current_result_context_refresh_rejects_runtime_or_project_change(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")

        for code in ("DESKTOP_PROCESS_CHANGED", "DESKTOP_PROJECT_MISMATCH"):
            with self.subTest(code=code):
                self.pipe.closed = False
                self.pipe.frames.clear()
                self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
                self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
                calls = 0

                def verify_process(*args):
                    nonlocal calls
                    calls += 1
                    if calls == 4:
                        raise h._error(code)
                    return PROCESS

                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                        patch.object(h, "_global_state_path", return_value=state_file), \
                        patch.object(h, "_verify_process_identity", side_effect=verify_process), \
                        patch.object(h, "_verify_current_runner_ancestor") as runner, \
                        patch.object(h._IpcClient, "snapshot_age", side_effect=iter([0.1, 1.0, 1.1, 3.0, 0.1])):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_result_context(self.temp.name)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(calls, 4)
                self.assertEqual(runner.call_count, 2)
                self.assertEqual(sum(frame.get("method") == "thread-stream-following-changed" for frame in self.pipe.frames), 2)
                self.assertTrue(self.pipe.closed)

    def test_current_result_context_slow_refresh_runtime_recheck_fails_closed(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        real_monotonic = h.time.monotonic
        expired = False
        calls = 0

        def monotonic():
            return real_monotonic() + (h.SNAPSHOT_TIMEOUT_SECONDS + 1.0 if expired else 0.0)

        def verify_process(*args):
            nonlocal calls, expired
            calls += 1
            if calls == 4:
                expired = True
            return PROCESS

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_process_identity", side_effect=verify_process), \
                patch.object(h, "_verify_current_runner_ancestor") as runner, \
                patch.object(h._IpcClient, "snapshot_age", side_effect=iter([0.1, 1.0, 1.1, 3.0, 0.1])), \
                patch.object(h.time, "monotonic", new=monotonic):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_result_context(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(calls, 4)
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(sum(frame.get("method") == "thread-stream-following-changed" for frame in self.pipe.frames), 2)
        self.assertTrue(self.pipe.closed)

    def test_current_result_context_refresh_revalidates_approval_and_propagates_new_turn(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]

        for state_change in ("approval", "new_turn"):
            with self.subTest(state_change=state_change):
                self.pipe.closed = False
                self.pipe.frames.clear()
                self.pipe.state["requests"] = []
                self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
                ages = iter([0.1, 1.0, 1.1, 3.0, 0.1])

                def snapshot_age():
                    age = next(ages)
                    if age == 3.0:
                        if state_change == "approval":
                            self.pipe.state["requests"] = [{"kind": "approval"}]
                        else:
                            self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
                    return age

                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                        patch.object(h, "_global_state_path", return_value=state_file), \
                        patch.object(h, "_verify_current_runner_ancestor"), \
                        patch.object(h._IpcClient, "snapshot_age", side_effect=snapshot_age):
                    result = h._current_result_context(self.temp.name)
                    expected_turn = OLD_TURN if state_change == "approval" else NEW_TURN
                    self.assertEqual(result["resultTurnId"], expected_turn)
                self.assertEqual(sum(frame.get("method") == "thread-stream-following-changed" for frame in self.pipe.frames), 2)

    def test_current_confirm_cancelled_is_local_only_and_does_not_start(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h, "_show_confirmation", return_value=False) as confirm:
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_confirm(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_CONFIRMATION_CANCELLED")
        confirm.assert_called_once()
        self.assertEqual(self.pipe.starts(), [])

    def test_partial_write_and_lost_receipt_never_claim_not_sent(self):
        for failure in ("partial_write", "lost_receipt"):
            with self.subTest(failure=failure):
                self.pipe.failure = failure
                session, _ = h._prepare(self.target)
                with self.assertRaises(h.DesktopIpcError) as caught:
                    session.send("完整方案")
                self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
                self.assertFalse(caught.exception.not_sent)

    def test_owner_discovery_exact_no_client_found_classifies_by_target(self):
        for target_owner, expected in ((None, "DESKTOP_NO_OWNER"), (OWNER, "DESKTOP_OWNER_CHANGED")):
            with self.subTest(target_owner=target_owner):
                client = h._IpcClient(self.pipe, THREAD, "local")
                client.initialize()
                client.owner = target_owner
                self.pipe.response_errors["thread-owner-discovery"] = "no-client-found"
                with self.assertRaises(h.DesktopIpcError) as caught:
                    client.discover()
                self.assertEqual(caught.exception.code, expected)
                self.assertNotEqual(caught.exception.code, "DESKTOP_TARGET_NOT_FOUND")
                self.pipe.response_errors.clear()

    def test_owner_discovery_non_exact_or_other_method_errors_keep_timeout_gate(self):
        for method, error in (("thread-owner-discovery", "target-not-found"),
                              ("thread-owner-discovery", "server-error"),
                              ("initialize", "no-client-found")):
            with self.subTest(method=method, error=error):
                client = h._IpcClient(self.pipe, THREAD, "local")
                self.pipe.response_errors[method] = error
                with self.assertRaises(h.DesktopIpcError) as caught:
                    client.initialize() if method == "initialize" else client.discover()
                self.assertEqual(caught.exception.code, "DESKTOP_IPC_TIMEOUT")
                self.pipe.response_errors.clear()

    def test_prepare_no_owner_rechecks_initial_process_before_close(self):
        self.pipe.owner = None
        verify = Mock(side_effect=[PROCESS, PROCESS])
        with patch.object(h, "_verify_process_identity", verify):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_NO_OWNER")
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args_list[1].args, (self.pipe, self.target, PROCESS))
        self.assertTrue(self.pipe.closed)

    def test_prepare_no_owner_recheck_rejects_project_or_process_change(self):
        for code in ("DESKTOP_PROJECT_MISMATCH", "DESKTOP_PROCESS_CHANGED"):
            with self.subTest(code=code):
                self.pipe.owner = None
                self.pipe.closed = False
                verify = Mock(side_effect=[PROCESS, h._error(code)])
                with patch.object(h, "_verify_process_identity", verify):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._prepare(self.target)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(verify.call_count, 2)
                self.assertTrue(self.pipe.closed)

    def test_prepare_initial_token_errors_do_not_recheck_uninitialized_runtime(self):
        for code in ("DESKTOP_TOKEN_UNVERIFIED", "DESKTOP_ELEVATED"):
            with self.subTest(code=code):
                verify = Mock()
                with patch.object(h, "_query_standard_token", side_effect=h._error(code)), \
                        patch.object(h, "_verify_process_identity", verify):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._prepare(self.target)
                self.assertEqual(caught.exception.code, code)
                verify.assert_not_called()

    def test_send_error_remains_outcome_unknown(self):
        session, _ = h._prepare(self.target)
        self.pipe.response_errors["thread-follower-start-turn"] = "no-client-found"
        with self.assertRaises(h.DesktopIpcError) as caught:
            session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)

    def test_old_turn_id_is_not_an_acceptance(self):
        session, _ = h._prepare(self.target)
        self.pipe.turn_id = OLD_TURN
        with self.assertRaises(h.DesktopIpcError) as caught:
            session.send("计划")
        self.assertFalse(caught.exception.not_sent)

    def test_missing_owner_wrong_project_approval_and_elevation_zero_starts(self):
        checks = [("owner", None, "DESKTOP_NO_OWNER"), ("cwd", "wrong-root", "DESKTOP_PROJECT_MISMATCH"),
                  ("requests", [{"kind": "approval"}], "DESKTOP_APPROVAL_PENDING")]
        for field, value, expected in checks:
            original = self.pipe.owner if field == "owner" else self.pipe.state[field]
            if field == "owner":
                self.pipe.owner = value
            else:
                self.pipe.state[field] = value
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._prepare(self.target)
            self.assertEqual(caught.exception.code, expected)
            if field == "owner":
                self.pipe.owner = original
            else:
                self.pipe.state[field] = original
        h._query_standard_token.side_effect = h._error("DESKTOP_ELEVATED")
        with self.assertRaises(h.DesktopIpcError):
            h._prepare(self.target)
        self.assertEqual(self.pipe.starts(), [])

    def test_expired_snapshot_before_start_is_rejected(self):
        session, _ = h._prepare(self.target)
        with patch.object(session.client, "snapshot_age", return_value=3.0):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("计划")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])

    def test_revision_gap_fails_closed(self):
        session, _ = h._prepare(self.target)
        event = {"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,
                 "sourceClientId": OWNER, "params": {"conversationId": THREAD, "hostId": "local",
                 "change": {"type": "patches", "baseRevision": 0, "revision": 2, "patches": []}}}
        with self.assertRaises(h.DesktopIpcError):
            session.client._handle(event)
        self.assertEqual(self.pipe.starts(), [])

    def test_helper_process_is_single_attempt_even_with_new_control_ids(self):
        fake = SimpleNamespace(send=Mock(return_value={"threadId": THREAD, "turnId": NEW_TURN}), close=Mock())
        messages = [{"id": CLIENT, "op": "prepare", "target": self.target},
                    {"id": OLD_TURN, "op": "send", "message": "\x00" * 65536},
                    {"id": NEW_TURN, "op": "send", "message": "不能再发"}]
        source = SimpleNamespace(buffer=io.BytesIO(b"".join(h._json_bytes(m) + b"\n" for m in messages)))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_prepare", return_value=(fake, {})), patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            self.assertEqual(h._main(), 0)
        responses = [json.loads(line) for line in output.buffer.getvalue().splitlines()]
        self.assertTrue(responses[1]["ok"])
        self.assertFalse(responses[2]["ok"])
        self.assertEqual(fake.send.call_count, 1)
        self.assertEqual(fake.send.call_args.args[0], "\x00" * 65536)

    def test_diagnose_operation_accepts_only_id_op_workspace_root(self):
        request = {"id": CLIENT, "op": "diagnose", "workspaceRoot": "workspace", "target": {}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_INVALID_REQUEST", "notSent": True})

    def test_diagnose_reports_behavioral_mode(self):
        # diagnosis 输出必须带 mode: "behavioral"，明确告诉机器消费者这不是 compatibility 分类。
        request = {"id": CLIENT, "op": "diagnose", "workspaceRoot": "workspace"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_diagnose", return_value={"mode": "behavioral", "processStable": True}), \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": True, "value": {"mode": "behavioral", "processStable": True}})

    def test_inspect_result_context_main_requires_exact_target_request(self):
        value = {"threadId": THREAD, "hostId": "local", "projectId": "project_test",
                 "workspaceRoot": str(Path.cwd()), "resultTurnId": OLD_TURN, "resultTurnStatus": "completed"}
        request = {"id": CLIENT, "op": "inspect_result_context", "target": self.target}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_inspect_result_context", return_value=value) as inspect, \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()), {"id": CLIENT, "ok": True, "value": value})
        inspect.assert_called_once_with(self.target)

        invalid = {**request, "workspaceRoot": str(Path.cwd())}
        invalid["extra"] = True
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(invalid) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue())["code"], "DESKTOP_INVALID_REQUEST")

    def _activity_state(self, *, runtime: str = "idle", status: str = "completed", items=None):
        items = items or [
            {"id": "item-1", "type": "userMessage", "content": []},
            {"id": "item-2", "type": "commandExecution", "command": "<redacted>"},
        ]
        turn = {"turnId": NEW_TURN, "status": status, "items": items}
        self.pipe.state["threadRuntimeStatus"] = {"type": runtime}
        self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}}],
            "entitiesByKey": {"turn-1": turn},
        }}
        return turn

    def test_result_activity_marker_is_ordered_id_type_only_and_fence_is_prefix_strict(self):
        self._activity_state()
        marker_result = h._inspect_result_activity_marker(self.target)
        marker = marker_result["marker"]
        self.assertEqual(marker["resultTurnId"], NEW_TURN)
        self.assertEqual(marker["itemIds"], ["item-1", "item-2"])
        self.assertEqual(marker["itemTypes"], ["userMessage", "commandExecution"])
        self.assertEqual(marker["itemCount"], 2)
        self.assertEqual(marker["itemSha256"], h._result_activity_sha256(marker["itemIds"], marker["itemTypes"]))
        self.assertNotIn("content", marker)
        self.assertNotIn("command", marker)

        safe = h._inspect_result_terminal_fence(self.target, marker)
        self.assertEqual(safe["fence"], "safe_terminal")

        self._activity_state(items=[
            {"id": "item-1", "type": "userMessage"},
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-3", "type": "reasoning"},
            {"id": "item-4", "type": "agentMessage"},
        ])
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "safe_terminal")

        self._activity_state(items=[
            {"id": "item-1", "type": "userMessage"},
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-3", "type": "reasoning"},
            {"id": "item-4", "type": "agentMessage"},
        ], runtime="inProgress", status="inProgress")
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "inProgress")

        self._activity_state(items=[
            {"id": "item-1", "type": "userMessage"},
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-3", "type": "reasoning"},
            {"id": "item-4", "type": "commandExecution"},
        ])
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "post_record_activity")

        self._activity_state(items=[
            {"id": "item-1", "type": "userMessage"},
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-3", "type": "reasoning"},
            {"id": "item-4", "type": "mcpToolCall"},
        ])
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "post_record_activity")

        self._activity_state(items=[
            {"id": "item-1", "type": "userMessage"},
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-3", "type": "agentMessage"},
            {"id": "item-4", "type": "fileChange"},
        ])
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "post_record_activity")

        self._activity_state(items=[
            {"id": "item-2", "type": "commandExecution"},
            {"id": "item-1", "type": "userMessage"},
        ])
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "unprovable")

        self._activity_state(runtime="inProgress", status="inProgress")
        self.assertEqual(h._inspect_result_terminal_fence(self.target, marker)["fence"], "inProgress")

        bad_digest = {**marker, "itemSha256": "0" * 64}
        self.assertEqual(h._inspect_result_terminal_fence(self.target, bad_digest)["fence"], "unprovable")

    def test_result_activity_marker_unknown_or_malformed_item_fails_closed(self):
        for item in ({"type": "agentMessage"}, {"id": "item-1", "type": "futureItem"},
                     {"id": "item-1", "type": []},
                     [{"id": "item-1", "type": "userMessage"}, {"id": "item-1", "type": "agentMessage"}],
                     "malformed"):
            with self.subTest(item=item):
                self._activity_state(items=item if isinstance(item, list) else [item])
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._inspect_result_activity_marker(self.target)
                self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def test_result_activity_marker_operations_require_exact_target_shapes(self):
        marker = {"resultTurnId": NEW_TURN, "itemIds": [], "itemTypes": [], "itemCount": 0,
                  "itemSha256": h._result_activity_sha256([], [])}
        value = {"marker": marker}
        request = {"id": CLIENT, "op": "inspect_result_activity_marker", "target": self.target}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_inspect_result_activity_marker", return_value=value) as inspect, \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()), {"id": CLIENT, "ok": True, "value": value})
        inspect.assert_called_once_with(self.target)

        request = {"id": CLIENT, "op": "inspect_result_terminal_fence", "target": self.target, "marker": marker}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_inspect_result_terminal_fence", return_value={"fence": "unprovable"}) as fence, \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()), {"id": CLIENT, "ok": True, "value": {"fence": "unprovable"}})
        fence.assert_called_once_with(self.target, marker)

        invalid = {**request, "raw": "body"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(invalid) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue())["code"], "DESKTOP_INVALID_REQUEST")


class ClassificationTests(unittest.TestCase):

    def _classification_case(self, text, *, turn_id=NEW_TURN, continuation=False, trigger=None, predecessor_status="failed", hops=1, boundary="exhausted", ordinary_origin=False, machine_input=None, machine_items=None, thread_id=None):
        with tempfile.TemporaryDirectory(prefix="c2c-classification-") as directory:
            target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test",
                      "workspaceRoot": directory}
            pipe = FakePipe(target)
            if continuation:
                origin_text = "ordinary" if ordinary_origin else '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"cmd-classify","intent":"development_plan","message":"x"}'
                origin_item = {"type": "text", "text": origin_text, "text_elements": []}
                origin = {"turnId": OLD_TURN, "status": predecessor_status, "params": {"input": [origin_item]},
                          "items": [{"type": "userMessage", "content": [origin_item]}]}
                turns = [origin]
                for index in range(hops):
                    params = {"turnTrigger": trigger or h._NATIVE_CONTINUATION_TRIGGER,
                              "input": []}
                    hop_id = turn_id if index == hops - 1 else f"01a00000-0000-7000-8000-{index + 6:012d}"
                    turns.append({"turnId": hop_id,
                                  "status": "completed" if index == hops - 1 else "failed",
                                  "params": {**params, **({"input": machine_input} if machine_input is not None else {}), **({"threadId": thread_id} if thread_id is not None else {})},
                                  "items": machine_items if machine_items is not None else []})
            else:
                item = {"type": "text", "text": text, "text_elements": []}
                turn = {"turnId": turn_id, "status": "completed", "params": {"input": [item]},
                        "items": [{"type": "userMessage", "content": [item]}]}
                turns = [turn]
            pipe.state["turns"] = turns
            pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                "islands": [{"entries": [{"value": f"turn-{i}"} for i in range(len(turns))],
                              "newerBoundary": {"status": boundary}}],
                "entitiesByKey": {f"turn-{i}": item for i, item in enumerate(turns)}}}
            client = SimpleNamespace(drain=Mock(), current_state=lambda: pipe.state,
                                     snapshot_age=lambda: 0, owner=OWNER)
            session = SimpleNamespace(client=client, pipe=pipe, process=PROCESS, close=Mock())
            with patch.object(h, "_current_target", return_value=target), \
                 patch.object(h, "_prepare", return_value=(session, {})), \
                 patch.object(h, "_verify_process_identity", return_value=PROCESS), \
                 patch.object(h, "_public_info", return_value={}), \
                 patch.object(h, "_verify_current_runner_ancestor"):
                return h._current_result_classification(directory)

    def test_result_classification_ordinary_and_json_non_c2c_are_not_applicable(self):
        for text in ("普通后续消息", '{"type":"other"}'):
            with self.subTest(text=text):
                result = self._classification_case(text)
                self.assertEqual(result["classification"], "not_applicable")

    def test_result_classification_current_c2c_origin_has_exact_envelope_match(self):
        text = '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"cmd-origin","intent":"revision","message":"hello"}'
        result = self._classification_case(text)
        self.assertEqual(result["classification"], "applicable")
        self.assertEqual(result["ownership"], "origin")
        self.assertEqual(result["workspaceId"], "workspace")
        self.assertEqual(result["commandId"], "cmd-origin")
        self.assertEqual(result["intent"], "revision")
        self.assertEqual(result["messageBytes"], 5)
        self.assertEqual(result["messageSha256"], hashlib.sha256(b"hello").hexdigest())
        self.assertEqual(result["originTurnId"], result["resultTurnId"])
        self.assertEqual(result["chainTurnIds"], [result["resultTurnId"]])
        self.assertEqual(result["chainLength"], 0)
        self.assertIsNone(result["signature"])
        for key in ("text", "message", "envelope", "history", "params", "items"):
            self.assertNotIn(key, result)

    def test_result_classification_c2c_malformed_variants_fail_closed(self):
        variants = [
            '{"type":"C2C_DESKTOP_TASK","version":2,"workspaceId":"workspace","commandId":"x","intent":"revision","message":"x"}',
            '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"bad space","commandId":"x","intent":"revision","message":"x"}',
            '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"x","intent":"bad","message":"x"}',
            '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"x","intent":"revision","message":""}',
            '{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"x","intent":"revision","message":"\ud800"}',
        ]
        for text in variants:
            with self.subTest(text=text), self.assertRaises(h.DesktopIpcError) as caught:
                self._classification_case(text)
            self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def test_result_classification_malformed_or_c2c_shaped_is_fail_closed(self):
        cases = ["{malformed", '{"type":"C2C_DESKTOP_TASK"}']
        for text in cases:
            with self.subTest(text=text):
                with self.assertRaises(h.DesktopIpcError) as caught:
                    self._classification_case(text)
            self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def test_result_classification_native_continuation_is_applicable(self):
        result = self._classification_case("", continuation=True)
        self.assertEqual(result["classification"], "applicable")
        self.assertEqual(result["ownership"], "native_continuation")
        self.assertEqual(result["chainTurnIds"], [OLD_TURN, NEW_TURN])
        self.assertEqual(result["chainLength"], 1)
        self.assertEqual(result["signature"], h._NATIVE_CONTINUATION_TRIGGER)
        self.assertEqual(result["workspaceId"], "workspace")
        self.assertEqual(result["commandId"], "cmd-classify")
        self.assertEqual(result["intent"], "development_plan")
        self.assertEqual(result["messageBytes"], 1)
        self.assertEqual(result["messageSha256"], hashlib.sha256(b"x").hexdigest())

    def test_result_classification_max_unique_hops_and_ordinary_origin(self):
        result = self._classification_case("", continuation=True, hops=h.MAX_RESULT_OWNERSHIP_CHAIN)
        self.assertEqual(result["chainLength"], h.MAX_RESULT_OWNERSHIP_CHAIN)
        self.assertEqual(len(set(result["chainTurnIds"])), len(result["chainTurnIds"]))
        self.assertEqual(self._classification_case("", continuation=True, ordinary_origin=True)["classification"], "not_applicable")

    def test_result_classification_malformed_machine_and_loading_boundary(self):
        cases = [{"machine_input": [{"type": "bad"}]}, {"machine_items": [{"type": "userMessage"}]},
                 {"thread_id": "01a00000-0000-7000-8000-000000000099"}, {"boundary": "loading"}]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(h.DesktopIpcError):
                    self._classification_case("", continuation=True, **case)

    def test_result_classification_two_hop_and_chain_bound(self):
        result = self._classification_case("", continuation=True, hops=2)
        self.assertEqual(result["chainLength"], 2)
        self.assertEqual(result["chainTurnIds"], [OLD_TURN, "01a00000-0000-7000-8000-000000000006", NEW_TURN])
        for key in ("text", "message", "envelope", "history", "params", "items"):
            self.assertNotIn(key, result)
        with self.assertRaises(h.DesktopIpcError) as caught:
            self._classification_case("", continuation=True, hops=h.MAX_RESULT_OWNERSHIP_CHAIN + 1)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def test_result_classification_continuation_malformed_trigger_or_predecessor_fails_closed(self):
        for kwargs in ({"trigger": "wrong-trigger"}, {"predecessor_status": "completed"}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(h.DesktopIpcError) as caught:
                    self._classification_case("", continuation=True, **kwargs)
                self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")

    def _cross_island_case(self, origin_boundary):
        with tempfile.TemporaryDirectory(prefix="c2c-islands-") as directory:
            target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": directory}
            pipe = FakePipe(target)
            origin = {"turnId": OLD_TURN, "status": "failed", "params": {"input": [{"type": "text", "text": "x", "text_elements": []}]},
                      "items": [{"type": "userMessage", "content": [{"type": "text", "text": "x", "text_elements": []}]}]}
            item = {"type": "text", "text": "ordinary", "text_elements": []}
            current = {"turnId": NEW_TURN, "status": "completed", "params": {"input": [item]},
                       "items": [{"type": "userMessage", "content": [item]}]}
            pipe.state["turns"] = [origin, current]
            pipe.state["turnHistory"] = {"kind": "canonical", "history": {"islands": [
                {"entries": [{"value": "a"}], "newerBoundary": {"status": origin_boundary}},
                {"entries": [{"value": "b"}], "newerBoundary": {"status": "exhausted"}}],
                "entitiesByKey": {"a": origin, "b": current}}}
            client = SimpleNamespace(drain=Mock(), current_state=lambda: pipe.state, snapshot_age=lambda: 0, owner=OWNER)
            session = SimpleNamespace(client=client, pipe=pipe, process=PROCESS, close=Mock())
            with patch.object(h, "_current_target", return_value=target), patch.object(h, "_prepare", return_value=(session, {})), \
                 patch.object(h, "_verify_process_identity", return_value=PROCESS), patch.object(h, "_public_info", return_value={}), \
                 patch.object(h, "_verify_current_runner_ancestor"):
                return h._current_result_classification(directory), pipe

    def test_result_classification_cross_island_exhausted_is_not_applicable(self):
        result, pipe = self._cross_island_case("exhausted")
        self.assertEqual(result["classification"], "not_applicable")
        for key in ("text", "message", "envelope", "history", "params", "items"):
            self.assertNotIn(key, result)
        self.assertEqual(pipe.starts(), [])

    def test_result_classification_many_historical_turns_do_not_affect_current(self):
        with tempfile.TemporaryDirectory(prefix="c2c-history-") as directory:
            target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": directory}
            pipe = FakePipe(target); entities = {}; islands = []; turns = []
            for index in range(12):
                tid = f"01a00000-0000-7000-8000-{100 + index:012d}"
                text = json.dumps({"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":f"old-{index}","intent":"revision","message":"old"}, separators=(",", ":"))
                item = {"type":"text","text":text,"text_elements":[]}; turn = {"turnId":tid,"status":"completed","params":{"input":[item]},"items":[{"type":"userMessage","content":[item]}]}
                key=f"old-{index}"; entities[key]=turn; turns.append(turn); islands.append({"entries":[{"value":key}],"newerBoundary":{"status":"exhausted"}})
            current_text='{"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":"cmd-current","intent":"revision","message":"current"}'
            item={"type":"text","text":current_text,"text_elements":[]}; current={"turnId":NEW_TURN,"status":"completed","params":{"input":[item]},"items":[{"type":"userMessage","content":[item]}]}
            entities["current"]=current; turns.append(current); islands.append({"entries":[{"value":"current"}],"newerBoundary":{"status":"exhausted"}})
            pipe.state["turns"]=turns; pipe.state["turnHistory"]={"kind":"canonical","history":{"islands":islands,"entitiesByKey":entities}}
            client=SimpleNamespace(drain=Mock(),current_state=lambda:pipe.state,snapshot_age=lambda:0,owner=OWNER)
            session=SimpleNamespace(client=client,pipe=pipe,process=PROCESS,close=Mock())
            with patch.object(h,"_current_target",return_value=target), patch.object(h,"_prepare",return_value=(session,{})), patch.object(h,"_verify_process_identity",return_value=PROCESS), patch.object(h,"_verify_current_runner_ancestor"), patch.object(h,"_public_info",return_value={}):
                result=h._current_result_classification(directory)
            self.assertEqual(result["commandId"],"cmd-current"); self.assertEqual(result["originTurnId"],NEW_TURN); self.assertEqual(pipe.starts(),[])

    def _fresh_state(self, turn_id, command_id):
        text = json.dumps({"type":"C2C_DESKTOP_TASK","version":1,"workspaceId":"workspace","commandId":command_id,"intent":"revision","message":"fresh"}, separators=(",", ":"))
        item = {"type":"text","text":text,"text_elements":[]}; turn = {"turnId":turn_id,"status":"completed","params":{"input":[item]},"items":[{"type":"userMessage","content":[item]}]}
        return {"id": THREAD, "hostId":"local", "cwd":"", "title":"t", "workspaceKind":"project", "resumeState":"resumed", "threadRuntimeStatus":{"type":"idle"}, "requests":[], "unconfirmedTurnSubmissions":[], "environments":[], "turns":[turn], "turnHistory":{"kind":"canonical","history":{"islands":[{"entries":[{"value":"k"}],"newerBoundary":{"status":"exhausted"}}],"entitiesByKey":{"k":turn}}}}

    def test_result_classification_freshness_refresh_success(self):
        with tempfile.TemporaryDirectory(prefix="c2c-fresh-") as directory:
            target={"threadId":THREAD,"hostId":"local","projectId":"project_test","workspaceRoot":directory}; old=self._fresh_state(OLD_TURN,"cmd-old"); new=self._fresh_state(NEW_TURN,"cmd-fresh")
            class Client:
                owner=OWNER; snapshot_serial=1
                def __init__(self): self.ages=[0,h.MAX_OBSERVATION_AGE_SECONDS + 1,0]; self.snapshots=0
                def drain(self,_): pass
                def current_state(self): return old
                def snapshot_age(self): return self.ages.pop(0) if self.ages else 0
                def snapshot(self): self.snapshots+=1; self.snapshot_serial=2; return new
            client=Client(); pipe=SimpleNamespace(verify_server=Mock(), starts=lambda:[]); session=SimpleNamespace(client=client,pipe=pipe,process=PROCESS,close=Mock())
            with patch.object(h,"_current_target",return_value=target), patch.object(h,"_prepare",return_value=(session,{})), patch.object(h,"_validate_observed_state"), patch.object(h,"_verify_process_identity",return_value=PROCESS) as vr, patch.object(h,"_verify_current_runner_ancestor") as va, patch.object(h,"_public_info",return_value={}):
                result=h._current_result_classification(directory)
            self.assertEqual(result["commandId"],"cmd-fresh"); self.assertEqual(result["resultTurnId"],NEW_TURN); self.assertEqual(client.snapshots,1); self.assertEqual(vr.call_count,2); self.assertEqual(va.call_count,2); pipe.verify_server.assert_called_once()

    def test_result_classification_freshness_fail_closed_serial_or_age(self):
        for serial_advanced, fresh_after in ((False, True), (True, False)):
            with self.subTest(serial_advanced=serial_advanced, fresh_after=fresh_after), tempfile.TemporaryDirectory(prefix="c2c-stale-") as directory:
                target={"threadId":THREAD,"hostId":"local","projectId":"project_test","workspaceRoot":directory}; state=self._fresh_state(OLD_TURN,"cmd-old")
                class Client:
                    owner=OWNER; snapshot_serial=1
                    def drain(self,_): pass
                    def current_state(self): return state
                    def snapshot_age(self): return 0
                    def snapshot(self):
                        if serial_advanced: self.snapshot_serial=2
                        return state
                client=Client(); ages=iter([0,h.MAX_OBSERVATION_AGE_SECONDS + 1,h.MAX_OBSERVATION_AGE_SECONDS + 1] if not fresh_after else [0,h.MAX_OBSERVATION_AGE_SECONDS + 1,0]); client.snapshot_age=lambda: next(ages,h.MAX_OBSERVATION_AGE_SECONDS + 1)
                pipe=SimpleNamespace(verify_server=Mock(), starts=lambda:[]); session=SimpleNamespace(client=client,pipe=pipe,process=PROCESS,close=Mock())
                with patch.object(h,"_current_target",return_value=target), patch.object(h,"_prepare",return_value=(session,{})), patch.object(h,"_validate_observed_state"), patch.object(h,"_verify_process_identity",return_value=PROCESS), patch.object(h,"_verify_current_runner_ancestor"), patch.object(h,"_public_info",return_value={}):
                    with self.assertRaises(h.DesktopIpcError) as caught: h._current_result_classification(directory)
                self.assertEqual(caught.exception.code,"DESKTOP_STATE_UNAVAILABLE")

    def test_result_classification_main_rejects_extra_request_fields(self):
        request = {"id": CLIENT, "op": "current_result_classification", "workspaceRoot": str(Path.cwd()),
                   "expectations": [], "extra": True}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "DESKTOP_INVALID_REQUEST")

    def test_result_classification_main_exact_request_succeeds(self):
        request = {"id": CLIENT, "op": "current_result_classification", "workspaceRoot": str(Path.cwd())}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_current_result_classification", return_value={"classification": "not_applicable"}) as classify, \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertEqual(response, {"id": CLIENT, "ok": True, "value": {"classification": "not_applicable"}})
        classify.assert_called_once_with(str(Path.cwd()))

        request = {"id": CLIENT, "op": "current_result_classification", "workspaceRoot": str(Path.cwd()),
                   "expectations": []}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_current_result_classification", return_value={"classification": "not_applicable"}), \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "DESKTOP_INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main()
