# -*- coding: utf-8 -*-
"""R2.10/11 Python 测试重构：删 compatibility 专项测试，迁移到 behavioral 语义。"""
import ast

P = 'tests/desktop_protocol_test.py'
PH = 'tests/desktop_ipc_helper_test.py'


def replace_once(text, old, new, label):
    got = text.count(old)
    if got != 1:
        raise SystemExit(f'{label}: expected 1, got {got}')
    return text.replace(old, new)


text = open(P, encoding='utf-8').read()
orig_len = len(text)

# ---------- S1: 头部重写（去 SEMANTIC/RUNTIME/REAL_VERIFY_RUNTIME，FakePipe 加 post-start 注入） ----------
marker = 'class FakePipe:'
idx = text.index(marker)
old_head = text[:idx]
assert 'SEMANTIC_PROTOCOL_SOURCE' in old_head and 'REAL_VERIFY_RUNTIME' in old_head
new_head = '''"""真实 helper 流程 + 假 pipe/WinAPI；不连接 Desktop、不读取用户配置。"""
import copy
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

'''
text = new_head + text[idx:]

# ---------- S1b: FakePipe 注入点 ----------
text = replace_once(text, '''        self.failure = None
        self.response_errors = {}''', '''        self.failure = None
        self.response_errors = {}
        self.post_start_state_error = None
        self.start_seen = False''', 'fakepipe-init')

text = replace_once(text, '''        if method == "thread-stream-following-changed":
            self.pending.append(h._frame({"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,''',
'''        if method == "thread-stream-following-changed":
            if self.post_start_state_error is not None and self.start_seen:
                self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],
                    "resultType": "error", "error": self.post_start_state_error}))
                return
            self.pending.append(h._frame({"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,''',
    'fakepipe-following')

text = replace_once(text, '''        if method == "thread-follower-start-turn":
            if self.failure == "partial_write":''', '''        if method == "thread-follower-start-turn":
            self.start_seen = True
            if self.failure == "partial_write":''', 'fakepipe-start')

# ---------- S2: setUp 去 _verify_runtime patch，改 _processes ----------
text = replace_once(text, '''        self.pipe = FakePipe(self.target)
        for name, replacement in (("_Pipe", Mock(return_value=self.pipe)), ("_query_standard_token", Mock()),
                                  ("_verify_runtime", Mock(return_value=RUNTIME))):
            active = patch.object(h, name, replacement)''', '''        self.pipe = FakePipe(self.target)
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
                {"pid": 101, "parentPid": 100, "name": "codex.exe",
                 "exe": str(Path(self.temp.name) / "codex.exe"), "creation": 11}]
        for name, replacement in (("_Pipe", Mock(return_value=self.pipe)), ("_query_standard_token", Mock()),
                                  ("_processes", Mock(return_value=rows))):
            active = patch.object(h, name, replacement)''', 'setup')

# ---------- S3: _candidate_fixture -> _send_fixture + 新测试（含两条 mutation boundary 硬验收） ----------
old_fixture_start = text.index('    def _candidate_fixture')
old_fixture_end = text.index('    def test_real_protocol_flow_keeps_text_and_only_accepts_without_completion(self):')
compat_start = text.index('    def test_protocol_v2_fingerprint_ignores_non_protocol_bundle_changes(self):')
compat_end = text.index('    def test_last_check_busy_is_definitely_not_sent(self):')
new_block = '''    def _send_fixture(self, *, turn_id=NEW_TURN, message="完整方案"):
        """send attestation 测试夹具：ACK turn 已进入 canonical 历史。"""
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": turn_id, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.state["turns"] = list(self.pipe.state.get("turns", [])) + [turn]
        self.pipe.turn_id = turn_id
        return message

    def _inject_on_start(self, injected):
        """让 pipe 在收到 start-turn 后把指定 turn 追加进 canonical 状态。"""
        original_write = self.pipe.write

        def write_with_turns(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turns"].extend(copy.deepcopy(injected))

        return patch.object(self.pipe, "write", write_with_turns)

    def test_observe_allows_active_and_pending_states_without_start(self):
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        session, info = h._prepare(self.target, allow_active=True)
        self.assertEqual(info["runtimeStatus"], "active")
        self.assertEqual(self.pipe.starts(), [])
        session.close()

        self.pipe.state["requests"] = [{"kind": "approval"}]
        session, info = h._prepare(self.target, allow_active=True)
        self.assertEqual(info["requestsCount"], 1)
        self.assertEqual(self.pipe.starts(), [])
        session.close()

    def test_prepare_rejects_invalid_turn_status_even_when_observing(self):
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "futureStatus"}]
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, allow_active=True)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(self.pipe.starts(), [])

    def test_prepare_send_gate_rejects_active_and_pending_with_busy(self):
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertEqual(self.pipe.starts(), [])

    def test_send_attestation_accepts_when_ack_turn_matches_envelope(self):
        session, _ = h._prepare(self.target)
        message = "完整中文方案\\n```python\\nprint('你好')\\n```"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with self._inject_on_start([turn]):
            self.assertEqual(session.send(message), {"threadId": THREAD, "turnId": NEW_TURN})
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
                session, _ = h._prepare(self.target)
                with self._inject_on_start(injected):
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
        message = self._send_fixture()
        self.pipe.post_start_state_error = "server-error"
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

    def test_pre_start_state_unavailable_keeps_not_sent_and_zero_starts(self):
        # 硬验收：同样的 DESKTOP_STATE_UNAVAILABLE 发生在 start-turn 之前时，
        # 必须保持 notSent=true 且 start-turn 计数为 0。
        session, _ = h._prepare(self.target)
        self.pipe.response_errors["thread-stream-following-changed"] = "server-error"
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])

    def test_post_start_process_drift_is_outcome_unknown(self):
        session, _ = h._prepare(self.target)
        message = self._send_fixture()
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
                {"pid": 101, "parentPid": 100, "name": "codex.exe",
                 "exe": str(Path(self.temp.name) / "codex.exe"), "creation": 11}]

        def processes():
            return [] if self.pipe.start_seen else rows

        with patch.object(h, "_processes", side_effect=processes):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

    def test_post_start_owner_drift_is_outcome_unknown(self):
        session, _ = h._prepare(self.target)
        message = self._send_fixture()
        with patch.object(h._IpcClient, "discover", side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)

'''
text = text[:old_fixture_start] + new_block + text[old_fixture_end:compat_start] + text[compat_end:]

# ---------- S4: current_identity runner 断言参数 ----------
text = replace_once(text, '''        info = h._current_identity(self.temp.name)
        self.assertEqual(info["threadId"], THREAD)
        self.assertEqual(info["projectId"], "project_test")
        self.assertEqual(info["runtimeStatus"], "active")
        ancestor.assert_called_once_with(RUNTIME)''', '''        info = h._current_identity(self.temp.name)
        self.assertEqual(info["threadId"], THREAD)
        self.assertEqual(info["projectId"], "project_test")
        self.assertEqual(info["runtimeStatus"], "active")
        process = {"desktopPid": 100, "desktopExe": str(Path(self.temp.name) / "ChatGPT.exe"),
                   "desktopCreation": 10, "appServerPid": 101,
                   "appServerExe": str(Path(self.temp.name) / "codex.exe"), "appServerCreation": 11}
        ancestor.assert_called_once_with(process)''', 'current-identity-assert')

# ---------- S5: forged context runner 断言参数 ----------
text = replace_once(text, '''        failure = h._error("DESKTOP_CURRENT_CONTEXT_INVALID")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                patch.object(h, "_global_state_path", return_value=state_file), \\
                patch.object(h, "_verify_current_runner_ancestor", side_effect=failure) as ancestor:
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_execution(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_CURRENT_CONTEXT_INVALID")
        ancestor.assert_called_once_with(RUNTIME)''', '''        failure = h._error("DESKTOP_CURRENT_CONTEXT_INVALID")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                patch.object(h, "_global_state_path", return_value=state_file), \\
                patch.object(h, "_verify_current_runner_ancestor", side_effect=failure) as ancestor:
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_execution(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_CURRENT_CONTEXT_INVALID")
        process = {"desktopPid": 100, "desktopExe": str(Path(self.temp.name) / "ChatGPT.exe"),
                   "desktopCreation": 10, "appServerPid": 101,
                   "appServerExe": str(Path(self.temp.name) / "codex.exe"), "appServerCreation": 11}
        ancestor.assert_called_once_with(process)''', 'forged-context-assert')

# ---------- S7-S10: freshness 系列 patch 符号迁移 ----------
text = replace_once(text, '''                patch.object(h, "_verify_runtime", return_value=RUNTIME) as verify_runtime, \\
                patch.object(h, "_verify_current_runner_ancestor") as runner, \\
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], NEW_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(pipe.verify_server.call_count, 1)
        self.assertEqual(verify_runtime.call_count, 2)''', '''                patch.object(h, "_verify_process_identity", return_value=PROCESS) as verify_process, \\
                patch.object(h, "_verify_current_runner_ancestor") as runner, \\
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], NEW_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(pipe.verify_server.call_count, 1)
        self.assertEqual(verify_process.call_count, 2)''', 'freshness-same')

text = replace_once(text, '''                patch.object(h, "_verify_runtime", return_value=RUNTIME) as verify_runtime, \\
                patch.object(h, "_verify_current_runner_ancestor") as runner, \\
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], "01a00000-0000-7000-8000-000000000006")
        self.assertNotEqual(result["activeTurnId"], OLD_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(verify_runtime.call_count, 2)''', '''                patch.object(h, "_verify_process_identity", return_value=PROCESS) as verify_process, \\
                patch.object(h, "_verify_current_runner_ancestor") as runner, \\
                patch.object(h, "_public_info", return_value={}):
            result = h._current_execution(target["workspaceRoot"])
        self.assertEqual(result["activeTurnId"], "01a00000-0000-7000-8000-000000000006")
        self.assertNotEqual(result["activeTurnId"], OLD_TURN)
        self.assertEqual(client.snapshot_calls, 1)
        self.assertEqual(verify_process.call_count, 2)''', 'freshness-new-turn')

text = replace_once(text, '''                        patch.object(h, "_verify_runtime", return_value=RUNTIME), \\
                        patch.object(h, "_verify_current_runner_ancestor"), \\
                        patch.object(h, "_public_info", return_value={}):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_execution(target["workspaceRoot"])''', '''                        patch.object(h, "_verify_process_identity", return_value=PROCESS), \\
                        patch.object(h, "_verify_current_runner_ancestor"), \\
                        patch.object(h, "_public_info", return_value={}):
                    with self.assertRaises(h.DesktopIpcError) as caught:
                        h._current_execution(target["workspaceRoot"])''', 'freshness-fail-closed')

text = replace_once(text, '''        cases = {
            "pipe": ("_pipe", h._error("DESKTOP_PROCESS_CHANGED")),
            "runtime": ("_runtime", h._error("DESKTOP_PROCESS_CHANGED")),
            "state": ("_state", h._error("DESKTOP_PROJECT_MISMATCH")),
            "owner": ("_state", h._error("DESKTOP_NO_OWNER")),
            "runner": ("_runner", h._error("DESKTOP_CURRENT_CONTEXT_INVALID")),
        }''', '''        cases = {
            "pipe": ("_pipe", h._error("DESKTOP_PROCESS_CHANGED")),
            "process": ("_process", h._error("DESKTOP_PROCESS_CHANGED")),
            "state": ("_state", h._error("DESKTOP_PROJECT_MISMATCH")),
            "owner": ("_state", h._error("DESKTOP_NO_OWNER")),
            "runner": ("_runner", h._error("DESKTOP_CURRENT_CONTEXT_INVALID")),
        }''', 'guards-cases')

text = replace_once(text, '''                        patch.object(h, "_validate_state") as default_validate, \\
                        patch.object(h, "_verify_runtime", return_value=RUNTIME) as default_runtime, \\
                        patch.object(h, "_verify_current_runner_ancestor") as default_runner, \\
                        patch.object(h, "_public_info", return_value={}):
                    if guard == "_runtime":
                        default_runtime.side_effect = [RUNTIME, failure]''', '''                        patch.object(h, "_validate_observed_state") as default_validate, \\
                        patch.object(h, "_verify_process_identity", return_value=PROCESS) as default_process, \\
                        patch.object(h, "_verify_current_runner_ancestor") as default_runner, \\
                        patch.object(h, "_public_info", return_value={}):
                    if guard == "_process":
                        default_process.side_effect = [PROCESS, failure]''', 'guards-patch')

# ---------- S12-S14: result context freshness 系列 ----------
text = replace_once(text, '''        def verify_runtime(*args):
            nonlocal expired, verify_calls
            verify_calls += 1
            if verify_calls == 3:
                expired = True
            return RUNTIME''', '''        def verify_process(*args):
            nonlocal expired, verify_calls
            verify_calls += 1
            if verify_calls == 3:
                expired = True
            return PROCESS''', 'independent-bound-fn')

text = replace_once(text, '''                patch.object(h, "_verify_runtime", side_effect=verify_runtime), \\
                patch.object(h._IpcClient, "snapshot_age", side_effect=iter(ages)), \\
                patch.object(h.time, "monotonic", new=monotonic):''', '''                patch.object(h, "_verify_process_identity", side_effect=verify_process), \\
                patch.object(h._IpcClient, "snapshot_age", side_effect=iter(ages)), \\
                patch.object(h.time, "monotonic", new=monotonic):''', 'independent-bound-patch')

text = replace_once(text, '''                def verify_runtime(*args):
                    nonlocal calls
                    calls += 1
                    if calls == 4:
                        raise h._error(code)
                    return RUNTIME

                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                        patch.object(h, "_global_state_path", return_value=state_file), \\
                        patch.object(h, "_verify_runtime", side_effect=verify_runtime), \\''', '''                def verify_process(*args):
                    nonlocal calls
                    calls += 1
                    if calls == 4:
                        raise h._error(code)
                    return PROCESS

                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                        patch.object(h, "_global_state_path", return_value=state_file), \\
                        patch.object(h, "_verify_process_identity", side_effect=verify_process), \\''', 'reject-change-fn')

text = replace_once(text, '''        def verify_runtime(*args):
            nonlocal calls, expired
            calls += 1
            if calls == 4:
                expired = True
            return RUNTIME

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                patch.object(h, "_global_state_path", return_value=state_file), \\
                patch.object(h, "_verify_runtime", side_effect=verify_runtime), \\''', '''        def verify_process(*args):
            nonlocal calls, expired
            calls += 1
            if calls == 4:
                expired = True
            return PROCESS

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \\
                patch.object(h, "_global_state_path", return_value=state_file), \\
                patch.object(h, "_verify_process_identity", side_effect=verify_process), \\''', 'slow-refresh-fn')

# ---------- S15-S17: prepare no-owner 系列 ----------
text = replace_once(text, '''    def test_prepare_no_owner_rechecks_initial_runtime_before_close(self):
        self.pipe.owner = None
        verify = Mock(side_effect=[RUNTIME, RUNTIME])
        with patch.object(h, "_verify_runtime", verify):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_NO_OWNER")
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args_list[1].args, (self.pipe, self.target, RUNTIME))
        self.assertTrue(self.pipe.closed)''', '''    def test_prepare_no_owner_rechecks_initial_process_before_close(self):
        self.pipe.owner = None
        verify = Mock(side_effect=[PROCESS, PROCESS])
        with patch.object(h, "_verify_process_identity", verify):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_NO_OWNER")
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args_list[1].args, (self.pipe, self.target, PROCESS))
        self.assertTrue(self.pipe.closed)''', 'no-owner-recheck')

text = replace_once(text, '''    def test_prepare_no_owner_recheck_rejects_runtime_project_or_process_change(self):
        for code in ("DESKTOP_VERSION_UNSUPPORTED", "DESKTOP_PROJECT_MISMATCH", "DESKTOP_PROCESS_CHANGED"):
            with self.subTest(code=code):
                self.pipe.owner = None
                self.pipe.closed = False
                verify = Mock(side_effect=[RUNTIME, h._error(code)])
                with patch.object(h, "_verify_runtime", verify):''', '''    def test_prepare_no_owner_recheck_rejects_project_or_process_change(self):
        for code in ("DESKTOP_PROJECT_MISMATCH", "DESKTOP_PROCESS_CHANGED"):
            with self.subTest(code=code):
                self.pipe.owner = None
                self.pipe.closed = False
                verify = Mock(side_effect=[PROCESS, h._error(code)])
                with patch.object(h, "_verify_process_identity", verify):''', 'no-owner-reject')

text = replace_once(text, '''                verify = Mock()
                with patch.object(h, "_query_standard_token", side_effect=h._error(code)), \\
                        patch.object(h, "_verify_runtime", verify):''', '''                verify = Mock()
                with patch.object(h, "_query_standard_token", side_effect=h._error(code)), \\
                        patch.object(h, "_verify_process_identity", verify):''', 'token-errors')

# ---------- S19: compatibility op 测试 -> diagnose op 形状测试 ----------
text = replace_once(text, '''    def test_compatibility_operation_is_read_only_and_returns_only_safe_fields(self):
        request = {"id": CLIENT, "op": "compatibility"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        expected = {"observedDesktopVersion": "26.908.4834.0", "observedAppServerVersion": "0.154.0-alpha.6.2",
                    "status": "current", "profile": h.VERIFIED_PROFILE}
        rows = [{"pid": 100, "name": "ChatGPT.exe", "parentPid": 1, "exe": "ChatGPT.exe", "creation": 10},
                {"pid": 101, "name": "codex.exe", "parentPid": 100, "exe": "codex.exe", "creation": 11}]
        with patch.object(h, "_Pipe") as pipe, patch.object(h, "_processes", return_value=rows), \\
                patch.object(h, "_compatibility_for_paths", return_value=expected), \\
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()), {"id": CLIENT, "ok": True, "value": expected})
        pipe.assert_not_called()''', '''    def test_diagnose_operation_accepts_only_id_op_workspace_root(self):
        request = {"id": CLIENT, "op": "diagnose", "workspaceRoot": "workspace", "target": {}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_INVALID_REQUEST", "notSent": True})''', 'diagnose-op')

# ---------- S20: 内部错误不泄漏 -> 错误 reply 无 compatibility 附加 ----------
text = replace_once(text, '''    def test_internal_mismatch_does_not_leak_through_helper_reply(self):
        request = {"id": CLIENT, "op": "inspect", "target": {"threadId": THREAD}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_target", return_value={}), patch.object(h, "_prepare", side_effect=h._version_error("asar_header_layout")), \\
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_VERSION_UNSUPPORTED", "notSent": True,
                         "compatibility": {"observedDesktopVersion": None, "observedAppServerVersion": None,
                                             "status": "unverified", "profile": None}})''', '''    def test_helper_error_reply_has_no_compatibility_attachment(self):
        request = {"id": CLIENT, "op": "inspect", "target": {"threadId": THREAD}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_target", return_value={}), \\
                patch.object(h, "_prepare", side_effect=h._error("DESKTOP_STATE_UNAVAILABLE")), \\
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_STATE_UNAVAILABLE", "notSent": True})''', 'error-reply')

# ---------- S21: pid reuse 测试迁移到 _verify_process_identity ----------
text = replace_once(text, '''        with patch.object(h, "_processes", return_value=rows), patch.object(h, "_runtime_version", return_value=RUNTIME), patch.object(h, "_verify_project"):
            old = h._verify_runtime(pipe, target)
            rows[1]["creation"] = 12
            with self.assertRaises(h.DesktopIpcError):
                h._verify_runtime(pipe, target, old)
            self.assertEqual(h._verify_runtime(pipe, target)["appServerCreation"], 12)
            rows[1]["parentPid"] = 999
            with self.assertRaises(h.DesktopIpcError):
                h._verify_runtime(pipe, target)''', '''        with patch.object(h, "_processes", return_value=rows), patch.object(h, "_verify_project"):
            old = h._verify_process_identity(pipe, target)
            rows[1]["creation"] = 12
            with self.assertRaises(h.DesktopIpcError):
                h._verify_process_identity(pipe, target, old)
            self.assertEqual(h._verify_process_identity(pipe, target)["appServerCreation"], 12)
            rows[1]["parentPid"] = 999
            with self.assertRaises(h.DesktopIpcError):
                h._verify_process_identity(pipe, target)''', 'pid-reuse')

# ---------- S23+S25: 删除 RuntimeTests 与 audit 方法，保留 classification 类 ----------
start = text.index('class RuntimeTests(unittest.TestCase):')
end = text.index('    def _classification_case(self,')
text = text[:start] + 'class ClassificationTests(unittest.TestCase):\n\n' + text[end:]

# ---------- S24: classification fixture 迁移 ----------
text = replace_once(text, '''                 patch.object(h, "_verify_runtime", return_value=RUNTIME), \\''',
    '''                 patch.object(h, "_verify_process_identity", return_value=PROCESS), \\''', 'classification-patch')
text = replace_once(text, '''patch.object(h, "_verify_runtime", return_value=RUNTIME), patch.object(h, "_public_info", return_value={}), \\''',
    '''patch.object(h, "_verify_process_identity", return_value=PROCESS), patch.object(h, "_public_info", return_value={}), \\''', 'classification-combined')
text = replace_once(text, 'def test_result_classification_current_c2c_origin_has_exact_fingerprint(self):',
    'def test_result_classification_current_c2c_origin_has_exact_envelope_match(self):', 'rename-fingerprint')

# ---------- S26: 残留机械替换 ----------
text = text.replace('runtime=RUNTIME', 'process=PROCESS')
text = text.replace('patch.object(h,"_verify_runtime",return_value=RUNTIME)',
                    'patch.object(h,"_verify_process_identity",return_value=PROCESS)')
text = text.replace('patch.object(h, "_verify_runtime", return_value=RUNTIME)',
                    'patch.object(h, "_verify_process_identity", return_value=PROCESS)')
text = text.replace('patch.object(h,"_validate_state")', 'patch.object(h,"_validate_observed_state")')
text = text.replace('patch.object(h, "_validate_state")', 'patch.object(h, "_validate_observed_state")')

# ---------- 终检 ----------
for bad in ('_verify_runtime', 'RUNTIME', 'VERIFIED_', 'candidate', 'SEMANTIC', 'semantic', 'asar', 'Asar',
            'ASAR', 'catalog', 'Catalog', 'VERSION_UNSUPPORTED', 'handshake_audit', 'compatibility',
            '_validate_state', 'fingerprint', '_sha256_file', 'desktopVersion', 'appServerVersion'):
    if bad in text:
        for no, line in enumerate(text.splitlines(), 1):
            if bad in line:
                print(f'residual {bad!r} at line {no}: {line.strip()[:160]}')
        raise SystemExit(f'residual {bad!r} remains')
ast.parse(text)
open(P, 'w', encoding='utf-8', newline='\n').write(text)
print(f'{P}: {orig_len} -> {len(text)} chars, {text.count(chr(10)) + 1} lines')

# ---------- helper 测试 ----------
th = open(PH, encoding='utf-8').read()
orig_h = len(th)
got = th.count('patch.object(helper, "_verify_runtime")')
if got != 15:
    raise SystemExit(f'helper-patch: expected 15, got {got}')
th = th.replace('patch.object(helper, "_verify_runtime")', 'patch.object(helper, "_verify_process_identity")')
th = replace_once(th, '''                                        "requestsCount", "desktopVersion", "appServerVersion", "profile",
                                        "ownerClientId"}, set())''', '''                                        "requestsCount", "ownerClientId"}, set())''', 'helper-keys')
th = replace_once(th, '''    def test_unknown_version_is_before_confirmation_and_main_rejects_remote_text(self) -> None:
        failure = helper._version_error("desktop_package_version")
        with patch.object(helper, "_current_identity_checked", side_effect=failure), \\
                patch.object(helper, "_show_confirmation") as confirm:
            self.assert_code("DESKTOP_VERSION_UNSUPPORTED", lambda: helper._current_confirm(TARGET["workspaceRoot"]))
            confirm.assert_not_called()''', '''    def test_current_identity_failure_is_before_confirmation_and_main_rejects_remote_text(self) -> None:
        failure = helper._error("DESKTOP_STATE_UNAVAILABLE")
        with patch.object(helper, "_current_identity_checked", side_effect=failure), \\
                patch.object(helper, "_show_confirmation") as confirm:
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_confirm(TARGET["workspaceRoot"]))
            confirm.assert_not_called()''', 'helper-version-test')
for bad in ('_verify_runtime', '_version_error', 'VERSION_UNSUPPORTED', 'desktopVersion', 'appServerVersion'):
    if bad in th:
        raise SystemExit(f'helper residual {bad!r} remains')
ast.parse(th)
open(PH, 'w', encoding='utf-8', newline='\n').write(th)
print(f'{PH}: {orig_h} -> {len(th)} chars')
