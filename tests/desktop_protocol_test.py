"""真实 helper 流程 + 假 pipe/WinAPI；不连接 Desktop、不读取用户配置。"""
import copy
import ctypes
import hashlib
import io
import json
import os
import struct
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
RUNTIME = {"desktopPid": 100, "appServerPid": 101, "desktopVersion": h.VERIFIED_RUNTIME["desktopVersion"],
           "appServerVersion": h.VERIFIED_RUNTIME["appServerVersion"]}


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
        self.closed = False
        self.server_pid = 100
        self.server_exe = str(Path(target["workspaceRoot"]) / "ChatGPT.exe")

    def verify_server(self):
        pass

    def write(self, raw):
        value = h._Decoder().feed(raw)[0]
        self.frames.append(value)
        method = value.get("method")
        if method in self.response_errors:
            self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],
                "resultType": "error", "error": self.response_errors[method]}))
            return
        if method == "thread-stream-following-changed":
            self.pending.append(h._frame({"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,
                "sourceClientId": OWNER, "params": {"conversationId": THREAD, "hostId": "local",
                "change": {"type": "snapshot", "conversationState": copy.deepcopy(self.state), "revision": 1}}}))
            return
        result = {}
        if method == "initialize":
            result = {"clientId": CLIENT}
        if method == "thread-follower-start-turn":
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
        for name, replacement in (("_Pipe", Mock(return_value=self.pipe)), ("_query_standard_token", Mock()),
                                  ("_verify_runtime", Mock(return_value=RUNTIME))):
            active = patch.object(h, name, replacement)
            active.start()
            self.addCleanup(active.stop)

    def test_real_protocol_flow_keeps_text_and_only_accepts_without_completion(self):
        session, info = h._prepare(self.target)
        text = "完整中文方案\n```python\nprint('你好')\n```"
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
                         ["initialize", "thread-owner-discovery", "thread-owner-discovery", "thread-follower-start-turn"])
        session.close()

    def test_handshake_audit_is_read_only_bounded_and_never_starts_turn(self):
        target = self.target
        identity = {"desktopPid": 100, "appServerPid": 101, "desktopCreation": 10, "appServerCreation": 11,
                    "desktopExe": "ChatGPT.exe", "appServerExe": "codex.exe",
                    "observedDesktopVersion": "26.915.4065.0", "observedAppServerVersion": "0.155.0-alpha.9.2",
                    "appServerSha256": "a" * 64}
        audit = {"classification": "protocol_drift_or_unknown", "asarHeader": [4, 8, 4, 0],
                 "modules": [{"role": "ipc-main", "path": ".vite/build/src-main.js", "sha256": "b" * 64},
                             {"role": "webview-bootstrap", "path": "webview/assets/app-initial-x.js", "sha256": "c" * 64}]}
        with patch.object(h, "_current_target", return_value=target), \
                patch.object(h, "_verify_runtime_identity", side_effect=[identity, identity]) as verify, \
                patch.object(h, "_compatibility_audit_for_paths", return_value=audit), \
                patch.object(h, "_runtime_version", side_effect=AssertionError("trusted runtime forbidden")), \
                patch.object(h, "_checked_runtime", side_effect=AssertionError("catalog trust forbidden")):
            result = h._handshake_audit(target["workspaceRoot"])
        self.assertEqual(result["stateChange"], "snapshot")
        self.assertEqual(result["protocolClassification"], "protocol_drift_or_unknown")
        self.assertEqual(verify.call_args_list[0].kwargs, {"require_catalog": False})
        self.assertNotIn("thread-follower-start-turn", [frame.get("method") for frame in self.pipe.frames])

    def test_handshake_audit_rejects_identity_or_audit_drift(self):
        target = self.target
        base = {"desktopPid": 100, "appServerPid": 101, "desktopCreation": 10, "appServerCreation": 11,
                "desktopExe": "ChatGPT.exe", "appServerExe": "codex.exe",
                "observedDesktopVersion": "26.915.4065.0", "observedAppServerVersion": "0.155.0-alpha.9.2",
                "appServerSha256": "a" * 64}
        audit = {"classification": "protocol_drift_or_unknown", "asarHeader": [4, 8, 4, 0],
                 "modules": [{"role": "ipc-main", "path": "a", "sha256": "b" * 64},
                             {"role": "webview-bootstrap", "path": "b", "sha256": "c" * 64}]}
        for key in ("desktopPid", "appServerCreation", "observedAppServerVersion", "appServerSha256"):
            with self.subTest(key=key):
                changed = {**base, key: (base[key] + 1 if isinstance(base[key], int) else "changed")}
                with patch.object(h, "_current_target", return_value=target), \
                        patch.object(h, "_verify_runtime_identity", side_effect=[base, changed]), \
                        patch.object(h, "_compatibility_audit_for_paths", return_value=audit):
                    with self.assertRaises(h.DesktopIpcError):
                        h._handshake_audit(target["workspaceRoot"])

    def test_last_check_busy_is_definitely_not_sent(self):
        session, _ = h._prepare(self.target)
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            session.send("已确认计划")
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])

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
        ancestor.assert_called_once_with(RUNTIME)
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
        ancestor.assert_called_once_with(RUNTIME)
        self.assertEqual(self.pipe.starts(), [])

    def test_current_execution_rechecks_snapshot_age_after_runtime_validation(self):
        state_file = Path(self.temp.name) / "global-state.json"
        state_file.write_text(json.dumps({
            "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
            "local-projects": {"project_test": {"rootPaths": [self.temp.name]}},
        }), encoding="utf-8")
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["turns"] = [{"turnId": NEW_TURN, "status": "inProgress"}]
        ages = iter([0.0, 0.0, 0.0, h.MAX_OBSERVATION_AGE_SECONDS + 1.0])
        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h._IpcClient, "snapshot_age", side_effect=lambda: next(ages)):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._current_execution(self.temp.name)
        self.assertEqual(caught.exception.code, "DESKTOP_STATE_UNAVAILABLE")
        self.assertEqual(self.pipe.starts(), [])

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

        def verify_runtime(*args):
            nonlocal expired, verify_calls
            verify_calls += 1
            if verify_calls == 3:
                expired = True
            return RUNTIME

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_current_runner_ancestor"), \
                patch.object(h, "_verify_runtime", side_effect=verify_runtime), \
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

                def verify_runtime(*args):
                    nonlocal calls
                    calls += 1
                    if calls == 4:
                        raise h._error(code)
                    return RUNTIME

                with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                        patch.object(h, "_global_state_path", return_value=state_file), \
                        patch.object(h, "_verify_runtime", side_effect=verify_runtime), \
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

        def verify_runtime(*args):
            nonlocal calls, expired
            calls += 1
            if calls == 4:
                expired = True
            return RUNTIME

        with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                patch.object(h, "_global_state_path", return_value=state_file), \
                patch.object(h, "_verify_runtime", side_effect=verify_runtime), \
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
                    if state_change == "approval":
                        with self.assertRaises(h.DesktopIpcError) as caught:
                            h._current_result_context(self.temp.name)
                        self.assertEqual(caught.exception.code, "DESKTOP_APPROVAL_PENDING")
                    else:
                        result = h._current_result_context(self.temp.name)
                        self.assertEqual(result["resultTurnId"], NEW_TURN)
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

    def test_prepare_no_owner_rechecks_initial_runtime_before_close(self):
        self.pipe.owner = None
        verify = Mock(side_effect=[RUNTIME, RUNTIME])
        with patch.object(h, "_verify_runtime", verify):
            with self.assertRaises(h.DesktopIpcError) as caught:
                h._prepare(self.target)
        self.assertEqual(caught.exception.code, "DESKTOP_NO_OWNER")
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args_list[1].args, (self.pipe, self.target, RUNTIME))
        self.assertTrue(self.pipe.closed)

    def test_prepare_no_owner_recheck_rejects_runtime_project_or_process_change(self):
        for code in ("DESKTOP_VERSION_UNSUPPORTED", "DESKTOP_PROJECT_MISMATCH", "DESKTOP_PROCESS_CHANGED"):
            with self.subTest(code=code):
                self.pipe.owner = None
                self.pipe.closed = False
                verify = Mock(side_effect=[RUNTIME, h._error(code)])
                with patch.object(h, "_verify_runtime", verify):
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
                        patch.object(h, "_verify_runtime", verify):
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

    def test_compatibility_operation_is_read_only_and_returns_only_safe_fields(self):
        request = {"id": CLIENT, "op": "compatibility"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        expected = {"observedDesktopVersion": "26.908.4834.0", "observedAppServerVersion": "0.154.0-alpha.6.2",
                    "status": "current", "profile": h.VERIFIED_PROFILE}
        rows = [{"pid": 100, "name": "ChatGPT.exe", "parentPid": 1, "exe": "ChatGPT.exe", "creation": 10},
                {"pid": 101, "name": "codex.exe", "parentPid": 100, "exe": "codex.exe", "creation": 11}]
        with patch.object(h, "_Pipe") as pipe, patch.object(h, "_processes", return_value=rows), \
                patch.object(h, "_compatibility_for_paths", return_value=expected), \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()), {"id": CLIENT, "ok": True, "value": expected})
        pipe.assert_not_called()


class RuntimeTests(unittest.TestCase):
    def test_production_verify_runtime_requires_catalog_identity_path(self):
        target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": str(Path.cwd())}
        pipe = FakePipe(target)
        with patch.object(h, "_verify_runtime_identity", return_value={"desktopExe": "x"}) as identity:
            result = h._verify_runtime(pipe, target)
        identity.assert_called_once_with(pipe, target, None, require_catalog=True)
        self.assertEqual(result["desktopExe"], "x")

    def test_missing_or_ambiguous_runtime_diagnosis_is_unverified_without_ipc(self):
        for rows in ([], [
            {"pid": 1, "name": "ChatGPT.exe", "creation": 1, "exe": "desktop"},
            {"pid": 2, "parentPid": 1, "name": "codex.exe", "creation": 2, "exe": "server1"},
            {"pid": 3, "parentPid": 1, "name": "codex.exe", "creation": 3, "exe": "server2"},
        ]):
            with patch.object(h, "_query_standard_token"), patch.object(h, "_processes", return_value=rows), \
                    patch.object(h, "_Pipe") as pipe:
                self.assertEqual(h._compatibility(), {"observedDesktopVersion": None,
                    "observedAppServerVersion": None, "status": "unverified", "profile": None})
                pipe.assert_not_called()

    def test_audited_runtime_pairs_share_one_profile_and_require_exact_hashes(self):
        for profile in (h.VERIFIED_RUNTIME, h.VERIFIED_RUNTIME_26_908,
                        h.VERIFIED_RUNTIME_26_908_9136, h.VERIFIED_RUNTIME_26_915):
            with self.subTest(pair=(profile["desktopVersion"], profile["appServerVersion"])), \
                    tempfile.TemporaryDirectory(prefix="c2c-profile-offline-") as directory:
                root = Path(directory) / f"OpenAI.Codex_{profile['desktopVersion']}_x64" / "app"
                root.mkdir(parents=True)
                desktop = root / "ChatGPT.exe"
                server = root / "codex.exe"
                if profile is h.VERIFIED_RUNTIME:
                    server.write_bytes(b"legacy app-server without a provenance marker")
                else:
                    server.write_bytes(b"standalone local buildversion: 0.154.0-alpha.6.2 platform: audited")
                module_hashes = {"fixture.js": hashlib.sha256(b"fixture module").hexdigest()}
                fixture = {**profile, "appServerSha256": hashlib.sha256(server.read_bytes()).hexdigest(),
                           "moduleHashes": module_hashes}
                with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (fixture,)}, clear=True), \
                        patch.object(h, "_asar_module_hashes", return_value=module_hashes) as asar:
                    runtime = h._runtime_version(str(desktop), str(server))
                    self.assertEqual(runtime["profile"], h.VERIFIED_PROFILE)
                    self.assertEqual(runtime["desktopVersion"], profile["desktopVersion"])
                    self.assertEqual(runtime["appServerVersion"], profile["appServerVersion"])
                    self.assertEqual(h._compatibility_for_paths(str(desktop), str(server)), {
                        "observedDesktopVersion": profile["desktopVersion"],
                        "observedAppServerVersion": profile["appServerVersion"],
                        "status": "current", "profile": h.VERIFIED_PROFILE,
                    })
                    self.assertEqual(asar.call_count, 2)

    def test_runtime_26_908_9136_exact_combination_is_current(self):
        profile = h.VERIFIED_RUNTIME_26_908_9136
        self.assertEqual(profile["desktopVersion"], "26.908.9136.0")
        self.assertEqual(profile["appServerVersion"], "0.154.0-alpha.6.2")
        self.assertEqual(profile["appServerSha256"],
                         "960c111d47afd61669954b9df9e56083e302edbfa3ef6962d81dcc14a30051dc")
        self.assertEqual(profile["asarHeader"], (4, 2489280, 2489276, 2489269))
        self.assertEqual(profile["moduleHashes"], {
            ".vite/build/src-CCXHtyvY.js":
                "a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40",
            "webview/assets/app-initial-bcc2ff475eb6.js":
                "3c15444f96a8d48844258618fe0d4278409e626f0ee563a77d2c669ec669c510",
        })
        self.assertIn(profile, h.VERIFIED_PROFILES[h.VERIFIED_PROFILE])
        # IPC 主模块与已验证 26.908.4834.0 byte-identical；webview bundle 单独固定。
        self.assertEqual(
            profile["moduleHashes"][".vite/build/src-CCXHtyvY.js"],
            h.VERIFIED_RUNTIME_26_908["moduleHashes"][".vite/build/src-CCXHtyvY.js"],
        )
        self.assertNotEqual(
            profile["moduleHashes"]["webview/assets/app-initial-bcc2ff475eb6.js"],
            h.VERIFIED_RUNTIME_26_908["moduleHashes"]["webview/assets/app-initial-d9bed9d614d8.js"],
        )

    def test_runtime_26_915_exact_catalog_row_is_current_and_any_drift_fails_closed(self):
        profile = h.VERIFIED_RUNTIME_26_915
        self.assertEqual(profile, {
            "desktopVersion": "26.915.4065.0",
            "appServerVersion": "0.155.0-alpha.9.2",
            "appServerSha256": "bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226",
            "asarHeader": (4, 4230936, 4230932, 4230928),
            "modules": [
                {"role": "ipc-main", "path": ".vite/build/src-C3YaUE83.js",
                 "sha256": "14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472"},
                {"role": "webview-bootstrap", "path": "webview/assets/app-initial-6c4523b43a11.js",
                 "sha256": "146b5204b30bd1766f19c0dd5b76f23515a77708ae80bb66ded6469e11431374"},
            ],
            "moduleHashes": {
                ".vite/build/src-C3YaUE83.js":
                    "14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472",
                "webview/assets/app-initial-6c4523b43a11.js":
                    "146b5204b30bd1766f19c0dd5b76f23515a77708ae80bb66ded6469e11431374",
            },
        })
        self.assertIn(profile, h.VERIFIED_PROFILES["desktop-ipc-v1"])
        observed = {"observedDesktopVersion": profile["desktopVersion"],
                    "observedAppServerVersion": profile["appServerVersion"],
                    "appServerSha256": profile["appServerSha256"]}
        with patch.object(h, "_observe_runtime_versions", return_value=observed), \
                patch.object(h, "_asar_module_hashes", return_value=profile["moduleHashes"]):
            self.assertEqual(h._checked_runtime("desktop", observed)["profile"], "desktop-ipc-v1")
            self.assertEqual(h._compatibility_for_paths("desktop", "server")["status"], "current")
            self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"], "current")

        for field, value in (("observedDesktopVersion", "26.915.4065.1"),
                             ("observedAppServerVersion", "0.155.0-alpha.9.3"),
                             ("appServerSha256", "0" * 64)):
            with self.subTest(field=field), self.assertRaises(h.DesktopIpcError):
                h._checked_runtime("desktop", {**observed, field: value})
        for mismatch in ("asar_header_layout", "asar_module_sha256"):
            with self.subTest(mismatch=mismatch), \
                    patch.object(h, "_asar_module_hashes", side_effect=h._version_error(mismatch)), \
                    self.assertRaises(h.DesktopIpcError):
                h._checked_runtime("desktop", observed)

    def test_production_asar_module_hashes_accepts_modern_framing_and_rejects_drift(self):
        ipc_path = ".vite/build/src-modern.js"
        webview_path = "webview/assets/app-initial-modern.js"
        ipc_bytes = b"exact ipc module"
        webview_bytes = b"exact webview module"

        tree = {"files": {}}
        offset = 0
        for module_path, module_bytes in ((ipc_path, ipc_bytes), (webview_path, webview_bytes)):
            files = tree["files"]
            parts = module_path.split("/")
            for part in parts[:-1]:
                files = files.setdefault(part, {"files": {}})["files"]
            files[parts[-1]] = {"size": len(module_bytes), "offset": str(offset)}
            offset += len(module_bytes)

        raw_tree = json.dumps(tree, separators=(",", ":")).encode("utf-8")
        layout = (4, len(raw_tree) + 8, len(raw_tree) + 4, len(raw_tree))
        profile = {
            "asarHeader": layout,
            "modules": [
                {"role": "ipc-main", "path": ipc_path,
                 "sha256": hashlib.sha256(ipc_bytes).hexdigest()},
                {"role": "webview-bootstrap", "path": webview_path,
                 "sha256": hashlib.sha256(webview_bytes).hexdigest()},
            ],
        }

        with tempfile.TemporaryDirectory(prefix="c2c-modern-asar-") as directory:
            desktop = Path(directory) / "app" / "ChatGPT.exe"
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True)

            def write_modules(current_ipc, current_webview):
                asar.write_bytes(
                    struct.pack("<4I", *layout) + raw_tree + current_ipc + current_webview
                )

            write_modules(ipc_bytes, webview_bytes)
            self.assertEqual(h._asar_module_hashes(str(desktop), profile), {
                ipc_path: hashlib.sha256(ipc_bytes).hexdigest(),
                webview_path: hashlib.sha256(webview_bytes).hexdigest(),
            })

            for current_ipc, current_webview in (
                    (b"X" + ipc_bytes[1:], webview_bytes),
                    (ipc_bytes, b"X" + webview_bytes[1:])):
                write_modules(current_ipc, current_webview)
                with self.assertRaises(h.DesktopIpcError) as raised:
                    h._asar_module_hashes(str(desktop), profile)
                self.assertEqual(raised.exception.mismatch, "asar_module_sha256")

    def test_runtime_26_908_9136_any_single_field_drift_fails_closed(self):
        base = h.VERIFIED_RUNTIME_26_908_9136
        with tempfile.TemporaryDirectory(prefix="c2c-9136-drift-") as directory:
            root = Path(directory) / f"OpenAI.Codex_{base['desktopVersion']}_x64" / "app"
            root.mkdir(parents=True)
            desktop = root / "ChatGPT.exe"
            server = root / "codex.exe"
            server.write_bytes(b"standalonelocal buildversion: 0.154.0-alpha.6.2\nplatform: audited")
            server_hash = hashlib.sha256(server.read_bytes()).hexdigest()
            fixture = {**base, "appServerSha256": server_hash}

            # exact pair + exact hashes → current
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (fixture,)}, clear=True), \
                    patch.object(h, "_asar_module_hashes", return_value=fixture["moduleHashes"]):
                self.assertEqual(
                    h._compatibility_for_paths(str(desktop), str(server))["status"], "current"
                )

            # wrong desktop version path → pair 不匹配 → unverified
            wrong_desktop = Path(directory) / "OpenAI.Codex_26.908.4834.0_x64" / "app" / "ChatGPT.exe"
            wrong_desktop.parent.mkdir(parents=True)
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (fixture,)}, clear=True):
                result = h._compatibility_for_paths(str(wrong_desktop), str(server))
            self.assertEqual(result["status"], "unverified")
            self.assertIsNone(result["profile"])

            # wrong app-server version（静态 marker 写出别的版本）→ pair 不匹配 → unverified
            server.write_bytes(b"standalonelocal buildversion: 0.153.4\nplatform: audited")
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (fixture,)}, clear=True):
                result = h._compatibility_for_paths(str(desktop), str(server))
            self.assertEqual(result["status"], "unverified")
            self.assertIsNone(result["profile"])
            server.write_bytes(b"standalonelocal buildversion: 0.154.0-alpha.6.2\nplatform: audited")

            # wrong app-server SHA → pair 版本匹配但 hash 不匹配 → incompatible
            bad_sha = {**fixture, "appServerSha256": "0" * 64}
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (bad_sha,)}, clear=True), \
                    patch.object(h, "_asar_module_hashes") as asar:
                result = h._compatibility_for_paths(str(desktop), str(server))
            self.assertEqual(result["status"], "incompatible")
            self.assertEqual(result["profile"], h.VERIFIED_PROFILE)
            asar.assert_not_called()

            # ASAR header 漂移：写入真实但错误布局的 asar 文件
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True, exist_ok=True)
            bad_header_bytes = struct.pack("<4I", 4, 64, 60, 16) + b"{}"
            asar.write_bytes(bad_header_bytes)
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (fixture,)}, clear=True):
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop), str(server))
            self.assertEqual(caught.exception.mismatch, "asar_header_layout")

            # IPC / webview module hash 漂移：按 exact module path 提供错误 hash
            for label, path, digest in (
                ("ipc", ".vite/build/src-CCXHtyvY.js", "b" * 64),
                ("webview", "webview/assets/app-initial-bcc2ff475eb6.js", "c" * 64),
            ):
                with self.subTest(module=label):
                    bad_modules = {**fixture["moduleHashes"], path: digest}
                    bad = {**fixture, "moduleHashes": bad_modules}
                    with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (bad,)}, clear=True), \
                            patch.object(h, "_asar_module_hashes", side_effect=h.DesktopIpcError(
                                "DESKTOP_VERSION_UNSUPPORTED", "asar_module_sha256"
                            ) if False else None):
                        # 直接让 _asar_module_hashes 抛出 module sha 错误语义：
                        with patch.object(
                            h, "_asar_module_hashes",
                            side_effect=h._version_error("asar_module_sha256"),
                        ):
                            with self.assertRaises(h.DesktopIpcError) as caught:
                                h._runtime_version(str(desktop), str(server))
                    self.assertEqual(caught.exception.mismatch, "asar_module_sha256")

    def test_runtime_26_908_9136_rejects_cross_runtime_mix(self):
        # 9136 Desktop + 4834 app-server hash：pair 版本可匹配 9136，但 hash 必须 exact。
        mix_hash = {
            **h.VERIFIED_RUNTIME_26_908_9136,
            "appServerSha256": h.VERIFIED_RUNTIME_26_908["appServerSha256"],
        }
        with tempfile.TemporaryDirectory(prefix="c2c-9136-mix-") as directory:
            root9136 = Path(directory) / "OpenAI.Codex_26.908.9136.0_x64" / "app"
            root9136.mkdir(parents=True)
            desktop9136 = root9136 / "ChatGPT.exe"
            server9136 = root9136 / "codex.exe"
            server9136.write_bytes(b"standalonelocal buildversion: 0.154.0-alpha.6.2\nplatform: audited")
            with patch.dict(
                h.VERIFIED_PROFILES,
                {h.VERIFIED_PROFILE: (mix_hash,)},
                clear=True,
            ), patch.object(h, "_asar_module_hashes") as asar:
                result = h._compatibility_for_paths(str(desktop9136), str(server9136))
            self.assertEqual(result["status"], "incompatible")
            self.assertEqual(result["profile"], h.VERIFIED_PROFILE)
            asar.assert_not_called()

            # 4834 Desktop + 声称 9136 webview hash：pair 版本匹配 4834 后 asar 必须 exact。
            mix_webview = {
                **h.VERIFIED_RUNTIME_26_908,
                "appServerSha256": hashlib.sha256(
                    b"standalone local buildversion: 0.154.0-alpha.6.2 platform: audited"
                ).hexdigest(),
                "moduleHashes": {
                    ".vite/build/src-CCXHtyvY.js":
                        h.VERIFIED_RUNTIME_26_908["moduleHashes"][".vite/build/src-CCXHtyvY.js"],
                    "webview/assets/app-initial-bcc2ff475eb6.js":
                        h.VERIFIED_RUNTIME_26_908_9136["moduleHashes"][
                            "webview/assets/app-initial-bcc2ff475eb6.js"
                        ],
                },
            }
            root4834 = Path(directory) / "OpenAI.Codex_26.908.4834.0_x64" / "app"
            root4834.mkdir(parents=True)
            desktop4834 = root4834 / "ChatGPT.exe"
            server4834 = root4834 / "codex.exe"
            server4834.write_bytes(b"standalone local buildversion: 0.154.0-alpha.6.2 platform: audited")
            with patch.dict(
                h.VERIFIED_PROFILES,
                {h.VERIFIED_PROFILE: (mix_webview,)},
                clear=True,
            ), patch.object(
                h,
                "_asar_module_hashes",
                side_effect=h._version_error("asar_module_sha256"),
            ):
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop4834), str(server4834))
            self.assertEqual(caught.exception.mismatch, "asar_module_sha256")

    def test_unknown_mixed_and_hash_mismatch_are_fail_closed_diagnostics(self):
        with tempfile.TemporaryDirectory(prefix="c2c-compatibility-offline-") as directory:
            root = Path(directory) / f"OpenAI.Codex_{h.VERIFIED_RUNTIME['desktopVersion']}_x64" / "app"
            root.mkdir(parents=True)
            desktop = root / "ChatGPT.exe"
            server = root / "codex.exe"

            server.write_bytes(b"standalone local buildversion: 9.9.9 platform: unknown")
            unknown = h._compatibility_for_paths(str(desktop), str(server))
            self.assertEqual(unknown, {"observedDesktopVersion": h.VERIFIED_RUNTIME["desktopVersion"],
                                       "observedAppServerVersion": "9.9.9", "status": "unverified", "profile": None})

            server.write_bytes(b"standalone local buildversion: 0.154.0-alpha.6.2 platform: mixed")
            mixed = h._compatibility_for_paths(str(desktop), str(server))
            self.assertEqual(mixed, {"observedDesktopVersion": h.VERIFIED_RUNTIME["desktopVersion"],
                                     "observedAppServerVersion": "0.154.0-alpha.6.2", "status": "unverified",
                                     "profile": None})

            server.write_bytes(b"standalone local buildversion: 0.153.4 platform: changed")
            with patch.object(h, "_asar_module_hashes") as asar:
                mismatched = h._compatibility_for_paths(str(desktop), str(server))
            self.assertEqual(mismatched, {"observedDesktopVersion": h.VERIFIED_RUNTIME["desktopVersion"],
                                          "observedAppServerVersion": h.VERIFIED_RUNTIME["appServerVersion"],
                                          "status": "incompatible", "profile": h.VERIFIED_PROFILE})
            asar.assert_not_called()

    def test_provenance_parser_accepts_prerelease_and_rejects_ambiguous_marker(self):
        with tempfile.TemporaryDirectory(prefix="c2c-provenance-offline-") as directory:
            binary = Path(directory) / "codex.exe"
            marker = b"standalone local buildversion: "
            binary.write_bytes(b"prefix\x00" + marker + b"0.154.0-alpha.6.2 platform: install method: commit:")
            self.assertEqual(h._static_file_version(str(binary)), "0.154.0-alpha.6.2")
            binary.write_bytes(marker + b"0.153.4 platform:x\x00" + marker + b"0.154.0-alpha.6.2 platform:y")
            self.assertIsNone(h._static_file_version(str(binary)))

    def test_provenance_parser_accepts_compact_marker_and_fails_closed_on_ambiguity(self):
        old = b"standalone local buildversion: "
        new = b"standalonelocal buildversion: "
        current = b"standalonenpmbunpnpmvite+brewlocal buildversion: "
        with tempfile.TemporaryDirectory(prefix="c2c-provenance-compact-") as directory:
            binary = Path(directory) / "codex.exe"
            # old marker + prerelease + space delimiter
            binary.write_bytes(b"prefix\x00" + old + b"0.154.0-alpha.6.2 platform: install method: commit:")
            self.assertEqual(h._static_file_version(str(binary)), "0.154.0-alpha.6.2")
            # new compact marker + prerelease + space delimiter
            binary.write_bytes(b"prefix\x00" + new + b"0.154.0-alpha.6.2 platform: install method: commit:")
            self.assertEqual(h._static_file_version(str(binary)), "0.154.0-alpha.6.2")
            # new compact marker + prerelease + newline delimiter (real 26.908.9136 shape)
            binary.write_bytes(b"prefix\x00" + new + b"0.154.0-alpha.6.2\nplatform: install method: commit:")
            self.assertEqual(h._static_file_version(str(binary)), "0.154.0-alpha.6.2")
            # current 26.915 marker + newline delimiter
            binary.write_bytes(b"prefix\x00" + current + b"0.155.0-alpha.9.2\nplatform: install method: commit:")
            self.assertEqual(h._static_file_version(str(binary)), "0.155.0-alpha.9.2")
            # old duplicated
            binary.write_bytes(old + b"0.153.4 platform:x\x00" + old + b"0.154.0-alpha.6.2 platform:y")
            self.assertIsNone(h._static_file_version(str(binary)))
            # new duplicated
            binary.write_bytes(new + b"0.153.4 platform:x\x00" + new + b"0.154.0-alpha.6.2 platform:y")
            self.assertIsNone(h._static_file_version(str(binary)))
            # old + new together
            binary.write_bytes(old + b"0.153.4 platform:x\x00" + new + b"0.154.0-alpha.6.2 platform:y")
            self.assertIsNone(h._static_file_version(str(binary)))
            # current duplicated
            binary.write_bytes(current + b"0.155.0-alpha.9.2\nplatform:x\x00" + current + b"0.155.0-alpha.9.2\nplatform:y")
            self.assertIsNone(h._static_file_version(str(binary)))
            # malformed version
            binary.write_bytes(new + b"not-a-version platform: x")
            self.assertIsNone(h._static_file_version(str(binary)))
            # missing platform delimiter
            binary.write_bytes(new + b"0.154.0-alpha.6.2 install method: commit:")
            self.assertIsNone(h._static_file_version(str(binary)))
            # no marker
            binary.write_bytes(b"no provenance marker here")
            self.assertIsNone(h._static_file_version(str(binary)))

    def test_unknown_compact_marker_pair_stays_unverified(self):
        # 未入册的 Desktop 版本 + compact marker 仍必须 unverified / profile=null。
        desktop = "OpenAI.Codex_26.908.9999.0_x64/app/ChatGPT.exe"
        with tempfile.TemporaryDirectory(prefix="c2c-provenance-unverified-") as directory:
            binary = Path(directory) / "codex.exe"
            binary.write_bytes(
                b"x\x00standalonelocal buildversion: 0.154.0-alpha.6.2\nplatform: install method: commit:"
            )
            with patch.object(h, "_sha256_file", return_value="960c111d47afd61669954b9df9e56083e302edbfa3ef6962d81dcc14a30051dc"):
                observed = h._observe_runtime_versions(desktop, str(binary))
            self.assertEqual(observed["observedDesktopVersion"], "26.908.9999.0")
            self.assertEqual(observed["observedAppServerVersion"], "0.154.0-alpha.6.2")
            diagnostic = h._compatibility_for_paths(desktop, str(binary))
            self.assertEqual(diagnostic, {
                "observedDesktopVersion": "26.908.9999.0",
                "observedAppServerVersion": "0.154.0-alpha.6.2",
                "status": "unverified",
                "profile": None,
            })

    def test_known_hash_skips_binary_scan_but_unknown_hash_uses_static_evidence(self):
        desktop = f"OpenAI.Codex_{h.VERIFIED_RUNTIME['desktopVersion']}_x64/app/ChatGPT.exe"
        with patch.object(h, "_sha256_file", return_value=h.VERIFIED_RUNTIME["appServerSha256"]), \
                patch.object(h, "_static_file_version") as static_version:
            observed = h._observe_runtime_versions(desktop, "codex.exe")
        self.assertEqual(observed["observedAppServerVersion"], h.VERIFIED_RUNTIME["appServerVersion"])
        static_version.assert_not_called()

        with patch.object(h, "_sha256_file", return_value="0" * 64), \
                patch.object(h, "_static_file_version", return_value="9.9.9") as static_version:
            observed = h._observe_runtime_versions(desktop, "codex.exe")
        self.assertEqual(observed["observedAppServerVersion"], "9.9.9")
        static_version.assert_called_once_with("codex.exe")

    def test_verified_large_asar_header_and_mixed_or_corrupt_combinations(self):
        # 不 mock ASAR 读取：复现真实 2.44 MB 头部，旧 1 MiB guard 会失败。
        with tempfile.TemporaryDirectory(prefix="c2c-asar-offline-") as directory:
            desktop = Path(directory) / "OpenAI.Codex_26.903.9818.0_x64" / "app" / "ChatGPT.exe"
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True)
            server = desktop.parent / "codex.exe"
            server_bytes = b"standalone local buildversion: 0.153.4 platform: offline"
            server.write_bytes(server_bytes)
            module = b"verified offline protocol"
            layout = h.VERIFIED_RUNTIME["asarHeader"]
            tree = {"files": {"protocol.js": {"offset": "0", "size": len(module)}}, "padding": ""}
            tree["padding"] = " " * (layout[3] - len(json.dumps(tree).encode()))
            raw_tree = json.dumps(tree).encode()
            self.assertEqual(len(raw_tree), layout[3])
            header = struct.pack("<4I", *layout)
            valid = header + raw_tree + bytes(8 + layout[1] - 16 - len(raw_tree)) + module
            profile = {**h.VERIFIED_RUNTIME, "appServerSha256": hashlib.sha256(server.read_bytes()).hexdigest(),
                       "moduleHashes": {"protocol.js": hashlib.sha256(module).hexdigest()}}
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (profile,)}, clear=True):
                asar.write_bytes(valid)
                self.assertEqual(h._runtime_version(str(desktop), str(server))["moduleHashes"], profile["moduleHashes"])
                cases = [
                    (header[:12], "asar_header_truncated"),
                    (struct.pack("<4I", 4, 0xffffffff, 0xfffffffb, 0xfffffff0), "asar_header_layout"),
                    (header + raw_tree[:100], "asar_header_truncated"),
                    (valid[:-1], "asar_module_truncated"),
                    (valid[:-1] + b"!", "asar_module_sha256"),
                ]
                for raw, mismatch in cases:
                    with self.subTest(mismatch=mismatch):
                        asar.write_bytes(raw)
                        with self.assertRaises(h.DesktopIpcError) as caught:
                            h._runtime_version(str(desktop), str(server))
                        self.assertEqual(caught.exception.mismatch, mismatch)
                        self.assertTrue(caught.exception.not_sent)
                asar.write_bytes(valid)
                # 只要整组中的一个成员变化，即便版本字符串相同也拒绝。
                server.write_bytes(b"standalone local buildversion: 0.153.4 platform: changed")
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop), str(server))
                self.assertEqual(caught.exception.mismatch, "app_server_sha256")
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop).replace("26.903.9818.0", "26.903.9999.0"), str(server))
                self.assertEqual(caught.exception.mismatch, "runtime_pair_unverified")

    def test_internal_mismatch_does_not_leak_through_helper_reply(self):
        request = {"id": CLIENT, "op": "inspect", "target": {"threadId": THREAD}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_target", return_value={}), patch.object(h, "_prepare", side_effect=h._version_error("asar_header_layout")), \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_VERSION_UNSUPPORTED", "notSent": True,
                         "compatibility": {"observedDesktopVersion": None, "observedAppServerVersion": None,
                                             "status": "unverified", "profile": None}})

    def test_handshake_operation_accepts_only_id_op_workspace_root(self):
        request = {"id": CLIENT, "op": "handshake_audit", "workspaceRoot": "workspace", "target": {}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_INVALID_REQUEST", "notSent": True})

    def test_new_connection_rediscovers_but_inflight_pid_reuse_is_rejected(self):
        target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": str(Path.cwd())}
        pipe = FakePipe(target)
        rows = [{"pid": 100, "name": "ChatGPT.exe", "parentPid": 1, "exe": pipe.server_exe, "creation": 10},
                {"pid": 101, "name": "codex.exe", "parentPid": 100, "exe": str(Path.cwd() / "codex.exe"), "creation": 11}]
        with patch.object(h, "_processes", return_value=rows), patch.object(h, "_runtime_version", return_value=RUNTIME), patch.object(h, "_verify_project"):
            old = h._verify_runtime(pipe, target)
            rows[1]["creation"] = 12
            with self.assertRaises(h.DesktopIpcError):
                h._verify_runtime(pipe, target, old)
            self.assertEqual(h._verify_runtime(pipe, target)["appServerCreation"], 12)
            rows[1]["parentPid"] = 999
            with self.assertRaises(h.DesktopIpcError):
                h._verify_runtime(pipe, target)

    def test_project_mapping_reads_only_isolated_fixture(self):
        with tempfile.TemporaryDirectory(prefix="c2c-project-offline-") as directory:
            file = Path(directory) / "state.json"
            target = {"threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": directory}
            value = {"thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
                     "local-projects": {"project_test": {"rootPaths": [directory]}}}
            file.write_text(json.dumps(value), encoding="utf-8")
            with patch.object(h, "_global_state_path", return_value=file):
                h._verify_project(target)
                value["thread-project-assignments"][THREAD]["projectId"] = "other"
                file.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(h.DesktopIpcError):
                    h._verify_project(target)

    def test_unknown_version_and_changed_server_binary_fail_closed(self):
        with self.assertRaises(h.DesktopIpcError):
            h._runtime_version("OpenAI.Codex_0.0.0.0_x64/app/ChatGPT.exe", "does-not-exist")
        with tempfile.TemporaryDirectory(prefix="c2c-version-offline-") as directory:
            server = Path(directory) / "codex.exe"
            server.write_bytes(b"verified fake binary")
            digest = hashlib.sha256(server.read_bytes()).hexdigest()
            desktop = "OpenAI.Codex_26.903.9818.0_x64/app/ChatGPT.exe"
            profile = {**h.VERIFIED_RUNTIME, "appServerSha256": digest}
            with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (profile,)}, clear=True), \
                    patch.object(h, "_asar_module_hashes", return_value={}):
                h._runtime_version(desktop, str(server))
                server.write_bytes(b"changed")
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(desktop, str(server))
                self.assertEqual(caught.exception.mismatch, "runtime_pair_unverified")


class CatalogAuditTests(unittest.TestCase):
    def test_catalog_asar_header_accepts_only_audited_legacy_and_modern_framing(self):
        self.assertEqual(h._catalog_asar_header([4, 100, 96, 89]), (4, 100, 96, 89))
        self.assertEqual(h._catalog_asar_header([4, 97, 93, 89]), (4, 97, 93, 89))
        with self.assertRaises(h._CatalogError):
            h._catalog_asar_header([4, 98, 94, 89])

    def test_catalog_loader_is_strict_and_bounded(self):
        catalog = json.loads(Path(h.PROFILE_CATALOG_PATH).read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="c2c-catalog-guard-") as directory:
            path = Path(directory) / "profiles.json"

            def load(value):
                path.write_text(json.dumps(value), encoding="utf-8")
                return h._load_catalog(path)

            self.assertEqual(set(h._load_catalog()), {h.VERIFIED_PROFILE})
            for name, broken in {
                "schema": {**catalog, "schemaVersion": 2},
                "root_extra": {**catalog, "extra": True},
                "profiles_missing": {"schemaVersion": 1},
                "profile_extra": {**catalog, "profiles": [{**catalog["profiles"][0], "extra": True}]},
                "profile_duplicate": {**catalog, "profiles": catalog["profiles"] * 2},
                "runtime_missing": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {key: value for key, value in catalog["profiles"][0]["runtimes"][0].items()
                     if key != "appServerVersion"}]}]},
                "bad_version": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {**catalog["profiles"][0]["runtimes"][0], "desktopVersion": "26.*"}]}]},
                "version_duplicate": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes":
                    catalog["profiles"][0]["runtimes"] + [catalog["profiles"][0]["runtimes"][0]]}]},
                "bad_hash": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {**catalog["profiles"][0]["runtimes"][0], "appServerSha256": "x" * 64}]}]},
                "bad_role": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {**catalog["profiles"][0]["runtimes"][0], "modules": [
                        {**catalog["profiles"][0]["runtimes"][0]["modules"][0], "role": "ipc"},
                        catalog["profiles"][0]["runtimes"][0]["modules"][1]]}]}]},
                "duplicate_role": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {**catalog["profiles"][0]["runtimes"][0], "modules": [
                        catalog["profiles"][0]["runtimes"][0]["modules"][0],
                        {**catalog["profiles"][0]["runtimes"][0]["modules"][0],
                         "path": ".vite/build/src-other.js"}]}]}]},
                "bad_path": {**catalog, "profiles": [{**catalog["profiles"][0], "runtimes": [
                    {**catalog["profiles"][0]["runtimes"][0], "modules": [
                        {**catalog["profiles"][0]["runtimes"][0]["modules"][0], "path": "../secret.js"},
                        catalog["profiles"][0]["runtimes"][0]["modules"][1]]}]}]},
            }.items():
                with self.subTest(name=name), self.assertRaises(h._CatalogError):
                    load(broken)
            path.write_text('{"schemaVersion":1,"schemaVersion":1,"profiles":[]}', encoding="utf-8")
            with self.assertRaises(h._CatalogError):
                h._load_catalog(path)
            with self.assertRaises(h._CatalogError):
                h._load_catalog(Path(directory) / "missing.json")
        with patch.dict(h.VERIFIED_PROFILES, {}, clear=True), \
                patch.object(h, "_observe_runtime_versions", return_value={
                    "observedDesktopVersion": "26.908.9136.0",
                    "observedAppServerVersion": "0.154.0-alpha.6.2",
                    "appServerSha256": "a" * 64,
                }):
            self.assertNotEqual(h._compatibility_for_paths("desktop", "server")["status"], "current")

    def test_audit_current_candidate_drift_ambiguity_and_malformed_asar(self):
        current = {"observedDesktopVersion": h.VERIFIED_RUNTIME_26_908_9136["desktopVersion"],
                   "observedAppServerVersion": h.VERIFIED_RUNTIME_26_908_9136["appServerVersion"],
                   "appServerSha256": h.VERIFIED_RUNTIME_26_908_9136["appServerSha256"]}
        with patch.object(h, "_observe_runtime_versions", return_value=current), \
                patch.object(h, "_checked_runtime"):
            result = h._compatibility_audit_for_paths("desktop", "server")
        self.assertEqual(result["classification"], "current")
        self.assertEqual(result["candidateProfile"], h.VERIFIED_PROFILE)
        self.assertNotIn("candidateRuntime", result)
        self.assertEqual({module["role"] for module in result["modules"]}, {"ipc-main", "webview-bootstrap"})

        ipc_hash = "a" * 64
        row = {"desktopVersion": "26.908.4834.0", "appServerVersion": "0.154.0-alpha.6.2",
               "appServerSha256": "0" * 64, "asarHeader": [4, 100, 96, 89], "modules": [
                   {"role": "ipc-main", "path": ".vite/build/src-trusted.js", "sha256": ipc_hash},
                   {"role": "webview-bootstrap", "path": "webview/assets/app-initial-old.js", "sha256": "c" * 64}]}
        observed = {"observedDesktopVersion": "99.1.1.1", "observedAppServerVersion": row["appServerVersion"],
                    "appServerSha256": "b" * 64}
        modules = {"ipc-main": [{"role": "ipc-main", "path": ".vite/build/src-new.js", "sha256": ipc_hash}],
                   "webview-bootstrap": [{"role": "webview-bootstrap", "path": "webview/assets/app-initial-new.js",
                                           "sha256": "d" * 64}]}
        with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: (row,)}, clear=True), \
                patch.object(h, "_observe_runtime_versions", return_value=observed), \
                patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], modules)):
            self.assertEqual(h._compatibility_for_paths("desktop", "server")["status"], "unverified")
            candidate = h._compatibility_audit_for_paths("desktop", "server")
            self.assertEqual(candidate["classification"], "same_protocol_candidate")
            self.assertEqual(candidate["candidateRuntime"]["desktopVersion"], "99.1.1.1")
            self.assertEqual(candidate["candidateRuntime"]["appServerSha256"], "b" * 64)
            with patch.object(h, "_observe_runtime_versions", return_value={
                    **observed, "observedDesktopVersion": "99.1.1"}):
                invalid_candidate = h._compatibility_audit_for_paths("desktop", "server")
            self.assertNotIn("candidateRuntime", invalid_candidate)
            bad = {**modules, "ipc-main": [{"role": "ipc-main", "path": ".vite/build/src-new.js", "sha256": "e" * 64}]}
            with patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], bad)):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "protocol_drift_or_unknown")
            many = {**modules, "ipc-main": [modules["ipc-main"][0],
                {**modules["ipc-main"][0], "path": ".vite/build/src-second.js"}]}
            with patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], many)):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "ambiguous")
            with patch.object(h, "_asar_audit_modules", side_effect=h._AsarAuditError("bad")):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "protocol_drift_or_unknown")
            no_webview = {**modules, "webview-bootstrap": []}
            with patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], no_webview)):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "protocol_drift_or_unknown")
            many_webview = {**modules, "webview-bootstrap": [modules["webview-bootstrap"][0],
                {**modules["webview-bootstrap"][0], "path": "webview/assets/app-initial-second.js"}]}
            with patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], many_webview)):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "ambiguous")
            with patch.object(h, "_observe_runtime_versions", return_value={**observed,
                    "observedAppServerVersion": "9.9.9"}):
                self.assertEqual(h._compatibility_audit_for_paths("desktop", "server")["classification"],
                                 "protocol_drift_or_unknown")
            with patch.object(h, "_observe_runtime_versions", return_value={**observed,
                    "appServerSha256": None}):
                unavailable = h._compatibility_audit_for_paths("desktop", "server")
                self.assertEqual(unavailable["classification"], "unavailable")
                self.assertNotIn("candidateRuntime", unavailable)

    def test_unknown_app_server_unique_fingerprint_stays_drift_and_sanitizes_modules(self):
        observed = {"observedDesktopVersion": "26.915.4065.0", "observedAppServerVersion": "0.155.0-alpha.9.3",
                    "appServerSha256": "a" * 64}
        modules = {"ipc-main": [{"role": "ipc-main", "path": ".vite/build/src-new.js", "sha256": "b" * 64,
                                  "_protocolFingerprint": True}],
                   "webview-bootstrap": [{"role": "webview-bootstrap", "path": "webview/assets/app-initial-new.js",
                                           "sha256": "c" * 64}]}
        with patch.object(h, "_observe_runtime_versions", return_value=observed), \
                patch.object(h, "_asar_audit_modules", return_value=([4, 100, 96, 89], modules)):
            result = h._compatibility_audit_for_paths("desktop", "server")
        self.assertEqual(result["classification"], "protocol_drift_or_unknown")
        self.assertEqual(result["modules"], [
            {"role": "ipc-main", "path": ".vite/build/src-new.js", "sha256": "b" * 64},
            {"role": "webview-bootstrap", "path": "webview/assets/app-initial-new.js", "sha256": "c" * 64},
        ])
        self.assertNotIn("candidateRuntime", result)

    def test_audit_asar_malformed_and_oversized_headers_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="c2c-audit-asar-") as directory:
            desktop = Path(directory) / "OpenAI.Codex_99.1.1.1_x64" / "app" / "ChatGPT.exe"
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True)
            for name, raw in {
                "truncated": b"short",
                "oversized_header": struct.pack("<4I", 4, h._MAX_ASAR_HEADER_BYTES + 1,
                                                  h._MAX_ASAR_HEADER_BYTES - 3,
                                                  h._MAX_ASAR_HEADER_BYTES - 10),
                "ambiguous_layout": struct.pack("<4I", 4, 100, 95, 89) + b"{}",
                "third_gap": struct.pack("<4I", 4, 98, 94, 89) + b"{}",
            }.items():
                with self.subTest(name=name):
                    asar.write_bytes(raw)
                    with self.assertRaises(h._AsarAuditError):
                        h._asar_audit_modules(str(desktop))

    def test_audit_asar_budget_overlap_and_normal_candidates(self):
        def write_asar(path, modules, *, framing="legacy"):
            tree = {"files": {}}
            for module_path, offset, data in modules:
                node = tree
                parts = module_path.split("/")
                for part in parts[:-1]:
                    node = node.setdefault("files", {}).setdefault(part, {})
                node.setdefault("files", {})[parts[-1]] = {"offset": str(offset), "size": len(data)}
            raw_tree = json.dumps(tree, separators=(",", ":")).encode()
            json_size = max(256, len(raw_tree))
            layout = ([4, json_size + 11, json_size + 7, json_size]
                      if framing == "legacy" else [4, json_size + 8, json_size + 4, json_size])
            raw_tree += b" " * (json_size - len(raw_tree))
            body = bytearray(max(offset + len(data) for _, offset, data in modules))
            for _, offset, data in modules:
                body[offset:offset + len(data)] = data
            gap = b"\0" * (8 + layout[1] - 16 - len(raw_tree))
            path.write_bytes(struct.pack("<4I", *layout) + raw_tree + gap + body)
            return layout

        with tempfile.TemporaryDirectory(prefix="c2c-audit-asar-budget-") as directory:
            desktop = Path(directory) / "OpenAI.Codex_99.1.1.1_x64" / "app" / "ChatGPT.exe"
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True)
            normal = [
                (".vite/build/src-a.js", 0, b"ipc"),
                ("webview/assets/app-initial-a.js", 3, b"web"),
            ]
            layout = write_asar(asar, normal)
            observed_layout, candidates = h._asar_audit_modules(str(desktop))
            self.assertEqual(observed_layout, layout)
            self.assertEqual({module["path"] for items in candidates.values() for module in items},
                             {module_path for module_path, _, _ in normal})
            modern_layout = write_asar(asar, normal, framing="modern")
            self.assertEqual(h._asar_audit_modules(str(desktop))[0], modern_layout)
            fingerprint = b"thread-owner-discovery thread-stream-following-changed thread-follower-start-turn handledByClientId sourceClientId targetClientIds conversationId"
            one = [(".vite/build/src-one.js", 0, fingerprint),
                   ("webview/assets/app-initial-a.js", len(fingerprint), b"web")]
            write_asar(asar, one, framing="modern")
            one_candidates = h._asar_audit_modules(str(desktop))[1]["ipc-main"]
            self.assertEqual([item.get("_protocolFingerprint") for item in one_candidates], [True])
            many = [(".vite/build/src-one.js", 0, fingerprint),
                    (".vite/build/src-two.js", len(fingerprint), fingerprint),
                    ("webview/assets/app-initial-a.js", len(fingerprint) * 2, b"web")]
            write_asar(asar, many, framing="modern")
            many_candidates = h._asar_audit_modules(str(desktop))[1]["ipc-main"]
            self.assertEqual(sum(item.get("_protocolFingerprint") is True for item in many_candidates), 2)

            too_many = [
                (".vite/build/src-a.js", 0, b"a"),
                ("webview/assets/app-initial-a.js", 1, b"b"),
            ]
            write_asar(asar, too_many)
            with patch.object(h, "_MAX_ASAR_AUDIT_CANDIDATES", 1), \
                    self.assertRaises(h._AsarAuditError):
                h._asar_audit_modules(str(desktop))

            too_many_per_role = [
                (".vite/build/src-a.js", 0, b"a"),
                (".vite/build/src-b.js", 1, b"b"),
            ]
            write_asar(asar, too_many_per_role)
            with patch.object(h, "_MAX_ASAR_AUDIT_CANDIDATES_PER_ROLE", 1), \
                    self.assertRaises(h._AsarAuditError):
                h._asar_audit_modules(str(desktop))

            cumulative = [
                (".vite/build/src-a.js", 0, b"ab"),
                ("webview/assets/app-initial-a.js", 2, b"cd"),
            ]
            write_asar(asar, cumulative)
            with patch.object(h, "_MAX_ASAR_AUDIT_MODULE_BYTES", 3), \
                    self.assertRaises(h._AsarAuditError):
                h._asar_audit_modules(str(desktop))

            overlap = [
                (".vite/build/src-a.js", 0, b"abc"),
                ("webview/assets/app-initial-a.js", 1, b"bc"),
            ]
            write_asar(asar, overlap)
            with self.assertRaises(h._AsarAuditError):
                h._asar_audit_modules(str(desktop))

    def test_legacy_runtime_lookup_and_asar_hashes_require_explicit_profile(self):
        runtimes = h.VERIFIED_PROFILES[h.VERIFIED_PROFILE]
        with patch.dict(h.VERIFIED_PROFILES, {h.VERIFIED_PROFILE: tuple(reversed(runtimes))}, clear=True):
            self.assertEqual(h._legacy_runtime_for_pair("26.903.9818.0", "0.153.4"), runtimes[0])
            self.assertEqual(h._legacy_runtime_for_pair("26.908.9136.0", "0.154.0-alpha.6.2"), runtimes[2])
        with self.assertRaises(TypeError):
            h._asar_module_hashes("desktop")

    def test_audit_process_pair_and_operation_are_read_only(self):
        with patch.object(h, "_query_standard_token") as token, patch.object(h, "_runtime_process_pairs", return_value=[]):
            self.assertEqual(h._compatibility_audit()["classification"], "unavailable")
            token.assert_called_once_with()
        with patch.object(h, "_query_standard_token"), patch.object(h, "_runtime_process_pairs", return_value=[("a", "b"), ("c", "d")]):
            self.assertEqual(h._compatibility_audit()["classification"], "ambiguous")
        request = {"id": CLIENT, "op": "compatibility_audit"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_compatibility_audit", return_value=h._audit_result()), \
                patch.object(h, "_Pipe") as pipe, patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue())["value"]["classification"], "unavailable")
        pipe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
