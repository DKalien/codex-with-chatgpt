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
        self.closed = False
        self.server_pid = 100
        self.server_exe = str(Path(target["workspaceRoot"]) / "ChatGPT.exe")

    def verify_server(self):
        pass

    def write(self, raw):
        value = h._Decoder().feed(raw)[0]
        self.frames.append(value)
        method = value.get("method")
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


class RuntimeTests(unittest.TestCase):
    def test_verified_large_asar_header_and_mixed_or_corrupt_combinations(self):
        # 不 mock ASAR 读取：复现真实 2.44 MB 头部，旧 1 MiB guard 会失败。
        with tempfile.TemporaryDirectory(prefix="c2c-asar-offline-") as directory:
            desktop = Path(directory) / "OpenAI.Codex_26.903.9818.0_x64" / "app" / "ChatGPT.exe"
            asar = desktop.parent / "resources" / "app.asar"
            asar.parent.mkdir(parents=True)
            server = desktop.parent / "codex.exe"
            server.write_bytes(b"verified offline app-server")
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
            with patch.object(h, "VERIFIED_RUNTIME", profile):
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
                server.write_bytes(b"other app-server same version label")
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop), str(server))
                self.assertEqual(caught.exception.mismatch, "app_server_sha256")
                with self.assertRaises(h.DesktopIpcError) as caught:
                    h._runtime_version(str(desktop).replace("26.903.9818.0", "26.903.9999.0"), str(server))
                self.assertEqual(caught.exception.mismatch, "desktop_package_version")

    def test_internal_mismatch_does_not_leak_through_helper_reply(self):
        request = {"id": CLIENT, "op": "inspect", "target": {"threadId": THREAD}}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_target", return_value={}), patch.object(h, "_prepare", side_effect=h._version_error("asar_header_layout")), \
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": False, "code": "DESKTOP_VERSION_UNSUPPORTED", "notSent": True})

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
            with patch.dict(h.VERIFIED_RUNTIME, {"appServerSha256": digest}), patch.object(h, "_asar_module_hashes", return_value={}):
                h._runtime_version(desktop, str(server))
                server.write_bytes(b"changed")
                with self.assertRaises(h.DesktopIpcError):
                    h._runtime_version(desktop, str(server))


if __name__ == "__main__":
    unittest.main()
