"""不连接 named pipe 的 Desktop IPC helper 离线回归。"""

from __future__ import annotations

import sys
import copy
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


HELPER_DIR = Path(__file__).resolve().parents[1] / "src" / "desktop" / "helper"
sys.path.insert(0, str(HELPER_DIR))
import desktop_ipc as helper  # noqa: E402


THREAD = "01a00000-0000-7000-8000-000000000001"
OWNER = "01a00000-0000-7000-8000-000000000010"
TARGET = {
    "threadId": THREAD,
    "hostId": "local",
    "projectId": "project_test",
    "workspaceRoot": r"D:\python\codex-with-chatgpt",
}


class DesktopIpcHelperTests(unittest.TestCase):
    def assert_code(self, code: str, callback) -> None:
        with self.assertRaises(helper.DesktopIpcError) as context:
            callback()
        self.assertEqual(context.exception.code, code)

    def valid_state(self) -> dict[str, object]:
        return {
            "id": THREAD,
            "hostId": "local",
            "cwd": TARGET["workspaceRoot"],
            "workspaceKind": "project",
            "resumeState": "resumed",
            "threadRuntimeStatus": {"type": "idle"},
            "requests": [],
            "unconfirmedTurnSubmissions": [],
            "turns": [{"turnId": "01a00000-0000-7000-8000-000000000011", "status": "completed"}],
            "environments": [{"cwd": TARGET["workspaceRoot"]}],
        }

    def reconcile_fixture(self, *, message: str = "只读 Desktop 任务", turn_id: str = "01a00000-0000-7000-8000-000000000011",
                          **envelope_overrides: object) -> tuple[dict[str, object], dict[str, object]]:
        envelope = {
            "type": "C2C_DESKTOP_TASK", "version": 1, "workspaceId": "workspace_test",
            "commandId": "command_test", "intent": "development_plan", "message": message,
            **envelope_overrides,
        }
        text = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        state = self.valid_state()
        state["title"] = "synthetic Desktop result"
        state.pop("turns")
        state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}}],
            "entitiesByKey": {"turn-1": {"turnId": turn_id, "status": "completed",
                                           "params": {"input": [{"type": "text", "text": text, "text_elements": []}]},
                                           "items": [{"type": "userMessage",
                                                      "content": [{"type": "text", "text": text,
                                                                   "text_elements": []}]}]}},
        }}
        expected = {"workspaceId": "workspace_test", "commandId": "command_test", "intent": "development_plan",
                    "messageBytes": len(message.encode("utf-8")),
                    "messageSha256": hashlib.sha256(message.encode("utf-8")).hexdigest()}
        return state, expected

    def ownership_fixture(self, *, hops: int = 1, trigger: str = "capacity_retry_automatic",
                          user_input_on_successor: bool = False, exhausted: bool = True) -> tuple[dict[str, object], dict[str, object], list[str]]:
        message = "synthetic P0.6 origin"
        envelope = {
            "type": "C2C_DESKTOP_TASK", "version": 1, "workspaceId": "workspace_test",
            "commandId": "command_test", "intent": "development_plan", "message": message,
        }
        text = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        ids = [f"01a00000-0000-7000-8000-{index:012d}" for index in range(100, 100 + hops + 1)]
        turns: dict[str, object] = {}
        entries: list[dict[str, str]] = []
        for index, turn_id in enumerate(ids):
            key = f"turn-{index}"
            entries.append({"value": key})
            if index == 0:
                turns[key] = {
                    "turnId": turn_id, "status": "failed",
                    "params": {"threadId": THREAD, "input": [{"type": "text", "text": text, "text_elements": []}]},
                    "items": [{"type": "userMessage", "content": [{"type": "text", "text": text, "text_elements": []}]}],
                }
            else:
                params: dict[str, object] = {"threadId": THREAD, "turnTrigger": trigger}
                items: list[dict[str, object]] = [{"type": "agentMessage"}]
                if user_input_on_successor and index == 1:
                    params["input"] = [{"type": "text", "text": "ordinary user input", "text_elements": []}]
                    items = [{"type": "userMessage", "content": params["input"]}]
                turns[key] = {
                    "turnId": turn_id, "status": "completed" if index == hops else "failed",
                    "params": params, "items": items,
                }
        state = self.valid_state()
        state["title"] = "synthetic Desktop result"
        state["threadRuntimeStatus"] = {"type": "idle"}
        state.pop("turns")
        state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{"entries": entries, "newerBoundary": {"status": "exhausted" if exhausted else "loading"}}],
            "entitiesByKey": turns,
        }}
        expected = {
            "workspaceId": "workspace_test", "commandId": "command_test", "intent": "development_plan",
            "messageBytes": len(message.encode("utf-8")), "messageSha256": hashlib.sha256(message.encode("utf-8")).hexdigest(),
            "originTurnId": ids[0],
        }
        return state, expected, ids

    def ownership_session(self, state: dict[str, object]):
        class Client:
            owner = OWNER
            snapshot_serial = 1

            def drain(self, _seconds: float) -> None:
                pass

            def current_state(self) -> dict[str, object]:
                return state

            def snapshot_age(self) -> float:
                return 0.0

        class Session:
            pipe = Mock()
            process: dict[str, object] = {"desktopPid": 100, "appServerPid": 101}
            client = Client()

            def close(self) -> None:
                pass

        return Session()

    def test_reconcile_unknown_requires_one_exact_envelope_and_hash(self) -> None:
        state, expected = self.reconcile_fixture()
        self.assertEqual(helper._reconcile_turn_ids(state, expected), ["01a00000-0000-7000-8000-000000000011"])
        for name, overrides in {
            "wrong_command": {"commandId": "other_command"},
            "wrong_workspace": {"workspaceId": "other_workspace"},
            "wrong_intent": {"intent": "revision"},
        }.items():
            with self.subTest(name=name):
                changed, same_expected = self.reconcile_fixture(**overrides)
                self.assertEqual(helper._reconcile_turn_ids(changed, same_expected), [])

        wrong_hash = dict(expected, messageSha256="0" * 64)
        self.assertEqual(helper._reconcile_turn_ids(state, wrong_hash), [])
        wrong_body, _ = self.reconcile_fixture(message="不同正文")
        self.assertEqual(helper._reconcile_turn_ids(wrong_body, expected), [])

    def test_reconcile_unknown_rejects_truncated_duplicate_and_invalid_turn(self) -> None:
        state, expected = self.reconcile_fixture()
        entity = state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
        entity["params"]["input"][0]["text"] = '{"type":"C2C_DESKTOP_TASK"}'  # type: ignore[index]
        entity["items"][0]["content"] = entity["params"]["input"]  # type: ignore[index]
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(state, expected))

        state, expected = self.reconcile_fixture()
        entity = state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
        entity["params"]["input"][0]["text"] = '{"type":"C2C_DESKTOP_TASK","type":"C2C_DESKTOP_TASK"}'  # type: ignore[index]
        entity["items"][0]["content"] = entity["params"]["input"]  # type: ignore[index]
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(state, expected))

        state, expected = self.reconcile_fixture()
        history = state["turnHistory"]["history"]  # type: ignore[index]
        history["islands"].append({"entries": [{"value": "turn-2"}], "newerBoundary": {"status": "exhausted"}})  # type: ignore[index]
        history["entitiesByKey"]["turn-2"] = copy.deepcopy(history["entitiesByKey"]["turn-1"])  # type: ignore[index]
        history["entitiesByKey"]["turn-2"]["turnId"] = "01a00000-0000-7000-8000-000000000012"  # type: ignore[index]
        self.assertEqual(helper._reconcile_turn_ids(state, expected), [
            "01a00000-0000-7000-8000-000000000011",
            "01a00000-0000-7000-8000-000000000012",
        ])

        invalid, expected = self.reconcile_fixture(turn_id="not-a-uuid")
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(invalid, expected))

        mismatched, expected = self.reconcile_fixture()
        entity = mismatched["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
        entity["items"][0]["content"][0]["text"] = "different rendered input"  # type: ignore[index]
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(mismatched, expected))

    def test_reconcile_unknown_requires_canonical_complete_history_and_exact_thread_root(self) -> None:
        state, expected = self.reconcile_fixture()
        flat = self.valid_state()
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(flat, expected))
        incomplete = copy.deepcopy(state)
        incomplete["turnHistory"]["history"]["islands"][-1]["newerBoundary"]["status"] = "loading"  # type: ignore[index]
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._reconcile_turn_ids(incomplete, expected))

        wrong_thread = dict(state, id="01a00000-0000-7000-8000-000000000099")
        self.assert_code("DESKTOP_TARGET_NOT_FOUND", lambda: helper._validate_observed_state(wrong_thread, TARGET, OWNER))
        wrong_root = dict(state, cwd=r"D:\other-workspace")
        self.assert_code("DESKTOP_PROJECT_MISMATCH", lambda: helper._validate_observed_state(wrong_root, TARGET, OWNER))

    def test_current_result_ownership_accepts_native_capacity_retry_chain(self) -> None:
        state, expected, ids = self.ownership_fixture()
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})) as prepare, \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        prepare.assert_called_once_with(TARGET, purpose="observe", require_runner_ancestor=True)
        self.assertEqual(result["ownership"], "native_continuation")
        self.assertEqual(result["originTurnId"], ids[0])
        self.assertEqual(result["resultTurnId"], ids[-1])
        self.assertEqual(result["chainTurnIds"], ids)
        self.assertEqual(result["chainLength"], 1)
        self.assertEqual(result["signature"], "capacity_retry_automatic")
        self.assertNotIn("message", result)
        self.assertNotIn("history", result)

    def test_current_result_ownership_rejects_cross_island_chain(self) -> None:
        state, expected, _ = self.ownership_fixture()
        history = state["turnHistory"]["history"]  # type: ignore[index]
        history["islands"] = [  # type: ignore[index]
            {"entries": [{"value": "turn-0"}], "newerBoundary": {"status": "exhausted"}},
            {"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}},
        ]
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_result_ownership(TARGET["workspaceRoot"], expected))

    def test_current_result_ownership_allows_unrelated_island_before_same_island_chain(self) -> None:
        state, expected, ids = self.ownership_fixture()
        history = state["turnHistory"]["history"]  # type: ignore[index]
        history["entitiesByKey"]["unrelated"] = {  # type: ignore[index]
            "turnId": "01a00000-0000-7000-8000-000000000099", "status": "completed", "params": {}, "items": [],
        }
        history["islands"] = [  # type: ignore[index]
            {"entries": [{"value": "unrelated"}], "newerBoundary": {"status": "exhausted"}},
            {"entries": [{"value": "turn-0"}, {"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}},
        ]
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        self.assertEqual(result["chainTurnIds"], ids)

    def test_current_result_ownership_accepts_in_progress_native_tip(self) -> None:
        state, expected, ids = self.ownership_fixture()
        state["threadRuntimeStatus"] = {"type": "inProgress"}
        state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]["status"] = "inProgress"  # type: ignore[index]
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        self.assertEqual(result["resultTurnId"], ids[-1])
        self.assertEqual(result["resultTurnStatus"], "inProgress")

    def test_current_result_ownership_keeps_exact_origin_without_chain(self) -> None:
        state, expected, ids = self.ownership_fixture(hops=0)
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        self.assertEqual(result["ownership"], "origin")
        self.assertEqual(result["chainTurnIds"], ids)
        self.assertEqual(result["chainLength"], 0)
        self.assertIsNone(result["signature"])

    def test_current_result_ownership_rejects_non_native_or_user_successors(self) -> None:
        for name, kwargs in {
            "wrong_trigger": {"trigger": "manual_continue"},
            "user_input": {"user_input_on_successor": True},
            "incomplete_history": {"exhausted": False},
        }.items():
            with self.subTest(case=name):
                state, expected, _ = self.ownership_fixture(**kwargs)
                with patch.object(helper, "_current_target", return_value=TARGET), \
                        patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                        patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
                    self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_result_ownership(TARGET["workspaceRoot"], expected))

    def test_current_result_ownership_rejects_malformed_zero_input_proof(self) -> None:
        for malformed_input in (None, {"type": "text"}, [{"type": "text", "text": "unexpected"}]):
            state, expected, _ = self.ownership_fixture()
            successor = state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
            successor["params"]["input"] = malformed_input  # type: ignore[index]
            with self.subTest(malformed_input=malformed_input), \
                    patch.object(helper, "_current_target", return_value=TARGET), \
                    patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                    patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
                self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_result_ownership(TARGET["workspaceRoot"], expected))

        state, expected, _ = self.ownership_fixture()
        successor = state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
        successor["items"].append("malformed")  # type: ignore[index]
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_result_ownership(TARGET["workspaceRoot"], expected))

    def test_current_result_ownership_accepts_valid_agent_and_tool_items_without_input(self) -> None:
        state, expected, ids = self.ownership_fixture()
        successor = state["turnHistory"]["history"]["entitiesByKey"]["turn-1"]  # type: ignore[index]
        successor["items"] = [{"type": "agentMessage"}, {"type": "toolResult"}]  # type: ignore[index]
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        self.assertEqual(result["chainTurnIds"], ids)

    def test_current_result_ownership_supports_bounded_repeated_chain_and_rejects_overflow(self) -> None:
        state, expected, ids = self.ownership_fixture(hops=3)
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            result = helper._current_result_ownership(TARGET["workspaceRoot"], expected)
        self.assertEqual(result["chainTurnIds"], ids)
        self.assertEqual(result["chainLength"], 3)

        state, expected, _ = self.ownership_fixture(hops=9)
        with patch.object(helper, "_current_target", return_value=TARGET), \
                patch.object(helper, "_prepare", return_value=(self.ownership_session(state), {})), \
                patch.object(helper, "_verify_process_identity"), patch.object(helper, "_verify_current_runner_ancestor"):
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_result_ownership(TARGET["workspaceRoot"], expected))

    def test_target_accepts_uuidv7_and_rejects_extra_fields(self) -> None:
        self.assertEqual(helper._target(dict(TARGET)), TARGET)
        self.assert_code("DESKTOP_INVALID_REQUEST", lambda: helper._target({**TARGET, "model": "override"}))
        self.assert_code("DESKTOP_INVALID_REQUEST", lambda: helper._target({**TARGET, "hostId": "remote"}))

    def test_message_preserves_utf8_and_rejects_lone_surrogate_or_overflow(self) -> None:
        message = "中文计划\n\n```ts\nconst value = '保留完整正文';\n```"
        self.assertEqual(helper._message(message), message)
        self.assertEqual(len("中".encode("utf-8") * 21845 + b"x"), helper.MAX_MESSAGE_BYTES)
        self.assert_code("DESKTOP_MESSAGE_TOO_LARGE", lambda: helper._message("中" * 21846))
        self.assert_code("DESKTOP_INVALID_REQUEST", lambda: helper._message("\ud800"))

    def test_frame_decoder_is_strict_utf8_and_bounded(self) -> None:
        payload = {"type": "response", "resultType": "success", "text": "中文"}
        decoder = helper._Decoder()
        frame = helper._frame(payload)
        self.assertEqual(decoder.feed(frame[:3]), [])
        self.assertEqual(decoder.feed(frame[3:]), [payload])
        self.assert_code("DESKTOP_PROTOCOL_ERROR", lambda: decoder.feed(b"\x01\x00\x00\x00\xff"))

    def test_state_requires_project_idle_resumed_and_known_terminal_turns(self) -> None:
        state = self.valid_state()
        helper._validate_observed_state(state, TARGET, OWNER)

        missing_project = dict(state)
        missing_project.pop("workspaceKind")
        self.assert_code("DESKTOP_PROJECT_MISMATCH", lambda: helper._validate_observed_state(missing_project, TARGET, OWNER))

        unknown_status = dict(state)
        unknown_status["turns"] = [{"status": "futureStatus"}]
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._validate_observed_state(unknown_status, TARGET, OWNER))

        missing_requests = dict(state)
        missing_requests.pop("requests")
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._validate_observed_state(missing_requests, TARGET, OWNER))

        busy = dict(state)
        busy["threadRuntimeStatus"] = {"type": "inProgress"}
        self.assert_code("DESKTOP_BUSY", lambda: helper._assert_send_ready(busy))

    def test_unconfirmed_submissions_missing_null_and_empty_are_allowed_when_idle(self) -> None:
        for label, value in (("missing", None), ("null", None), ("empty", [])):
            with self.subTest(value=label):
                state = self.valid_state()
                if label == "missing":
                    state.pop("unconfirmedTurnSubmissions")
                else:
                    state["unconfirmedTurnSubmissions"] = value
                helper._validate_observed_state(state, TARGET, OWNER)
                helper._assert_send_ready(state)

    def test_unconfirmed_submissions_rejects_unknown_shapes_and_blocks_pending_send(self) -> None:
        for value in ({"unknown": True}, "unknown"):
            with self.subTest(value=value):
                state = self.valid_state()
                state["unconfirmedTurnSubmissions"] = value
                self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._validate_observed_state(state, TARGET, OWNER))
                self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._assert_send_ready(state))

        pending = self.valid_state()
        pending["unconfirmedTurnSubmissions"] = [{"id": "pending"}]
        helper._validate_observed_state(pending, TARGET, OWNER)
        self.assert_code("DESKTOP_APPROVAL_PENDING", lambda: helper._assert_send_ready(pending))

    def test_current_target_requires_inherited_ids_and_exact_local_root_mapping(self) -> None:
        with tempfile.TemporaryDirectory(prefix="c2c-current-context-") as directory:
            state_file = Path(directory) / "state.json"
            root = str(Path(directory) / "workspace")
            value = {
                "thread-project-assignments": {THREAD: {"projectKind": "local", "projectId": "project_test"}},
                "local-projects": {"project_test": {"rootPaths": [root]}},
            }
            state_file.write_text(json.dumps(value), encoding="utf-8")
            with patch.dict(os.environ, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": THREAD}, clear=False), \
                    patch.object(helper, "_global_state_path", return_value=state_file):
                self.assertEqual(helper._current_target(root), {
                    "threadId": THREAD, "hostId": "local", "projectId": "project_test", "workspaceRoot": root,
                })
                for env in ({"CODEX_THREAD_ID": "not-a-uuid"}, {"CODEX_THREAD_ID": THREAD, "CODEX_SESSION_ID": OWNER}):
                    with self.subTest(env=env), patch.dict(os.environ, env, clear=False):
                        self.assert_code("DESKTOP_CURRENT_CONTEXT_INVALID", lambda: helper._current_target(root))
                cases = {
                    "duplicate_roots": {**value, "local-projects": {"project_test": {"rootPaths": [root, root]}}},
                    "wrong_root": {**value, "local-projects": {"project_test": {"rootPaths": [str(Path(directory) / "other")]}}},
                    "missing_assignment": {**value, "thread-project-assignments": {}},
                    "remote_project": {**value, "thread-project-assignments": {
                        THREAD: {"projectKind": "remote", "projectId": "project_test"}}},
                }
                for name, broken in cases.items():
                    with self.subTest(mapping=name):
                        state_file.write_text(json.dumps(broken), encoding="utf-8")
                        self.assert_code("DESKTOP_CURRENT_CONTEXT_INVALID", lambda: helper._current_target(root))

    def test_current_identity_allows_active_and_send_validation_remains_idle_only(self) -> None:
        state = self.valid_state()
        state["threadRuntimeStatus"] = {"type": "active"}
        state["turns"] = [{"turnId": "01a00000-0000-0000-0000-000000000011", "status": "inProgress"}]
        helper._validate_observed_state(state, TARGET, OWNER)
        self.assert_code("DESKTOP_BUSY", lambda: helper._assert_send_ready(state))

    def test_inspect_active_execution_is_target_scoped_and_bounded(self) -> None:
        state = self.valid_state()
        state["title"] = "目标 active 会话"
        state["threadRuntimeStatus"] = {"type": "active"}
        state["turns"] = [{"turnId": "01a00000-0000-0000-0000-000000000011", "status": "inProgress"}]

        class Client:
            owner = OWNER

            def __init__(self, value: dict[str, object]) -> None:
                self.value = value

            def drain(self, _seconds: float) -> None:
                pass

            def current_state(self) -> dict[str, object]:
                return self.value

            def snapshot_age(self) -> float:
                return 0.0

        class Session:
            pipe = Mock()
            process: dict[str, object] = {"desktopPid": 100, "appServerPid": 101}

            def __init__(self, value: dict[str, object]) -> None:
                self.client = Client(value)

            def close(self) -> None:
                pass

        with patch.object(helper, "_prepare", return_value=(Session(state), {})) as prepare, \
                patch.object(helper, "_verify_process_identity"):
            result = helper._inspect_active_execution(TARGET)
        prepare.assert_called_once_with(TARGET, purpose="observe")
        self.assertEqual(result["activeTurnId"], "01a00000-0000-0000-0000-000000000011")
        self.assertEqual(set(result) - {"threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd",
                                        "workspaceKind", "resumeState", "runtimeStatus", "activeTurnId",
                                        "requestsCount", "ownerClientId"}, set())
        self.assertNotIn("message", result)
        self.assertNotIn("history", result)

        idle = copy.deepcopy(state)
        idle["threadRuntimeStatus"] = {"type": "idle"}
        idle["turns"] = [{"turnId": "01a00000-0000-0000-0000-000000000011", "status": "completed"}]
        with patch.object(helper, "_prepare", return_value=(Session(idle), {})), \
                patch.object(helper, "_verify_process_identity"):
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._inspect_active_execution(TARGET))

        cases = {
            "multiple_active": [{"turnId": "01a00000-0000-0000-0000-000000000011", "status": "inProgress"},
                                {"turnId": "01a00000-0000-0000-0000-000000000012", "status": "inProgress"}],
            "malformed_active": [{"turnId": "not-a-uuid", "status": "inProgress"}],
        }
        for name, turns in cases.items():
            broken = copy.deepcopy(state)
            broken["turns"] = turns
            with self.subTest(case=name), patch.object(helper, "_prepare", return_value=(Session(broken), {})), \
                    patch.object(helper, "_verify_process_identity"):
                self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._inspect_active_execution(TARGET))

        for name, changes, code in [
            ("wrong_thread", {"id": "01a00000-0000-0000-0000-000000000099"}, "DESKTOP_TARGET_NOT_FOUND"),
            ("wrong_host", {"hostId": "remote"}, "DESKTOP_TARGET_NOT_FOUND"),
            ("wrong_root", {"cwd": r"D:\\python\\other", "environments": [{"cwd": r"D:\\python\\other"}]}, "DESKTOP_PROJECT_MISMATCH"),
            ("wrong_project_kind", {"workspaceKind": "remote"}, "DESKTOP_PROJECT_MISMATCH"),
        ]:
            broken = copy.deepcopy(state)
            broken.update(changes)
            with self.subTest(case=name), patch.object(helper, "_prepare", return_value=(Session(broken), {})), \
                    patch.object(helper, "_verify_process_identity"):
                self.assert_code(code, lambda: helper._inspect_active_execution(TARGET))

    def test_current_runner_must_be_a_descendant_of_verified_app_server(self) -> None:
        with patch.object(helper, "_process_parent_ids", return_value={123: 101}), \
                patch.object(helper.os, "getpid", return_value=123):
            helper._verify_current_runner_ancestor({"appServerPid": 101})
        with patch.object(helper, "_process_parent_ids", return_value={123: 999}), \
                patch.object(helper.os, "getpid", return_value=123):
            self.assert_code("DESKTOP_CURRENT_CONTEXT_INVALID", lambda: helper._verify_current_runner_ancestor({"appServerPid": 101}))

    def test_current_confirm_cancel_and_identity_change_never_send(self) -> None:
        info = {**TARGET, "title": "当前会话", "cwd": TARGET["workspaceRoot"], "runtimeStatus": "active"}
        runtime = {"desktopPid": 100, "appServerPid": 101}
        with patch.object(helper, "_current_identity_checked", return_value=info) as checked, \
                patch.object(helper, "_show_confirmation", return_value=False) as confirm:
            self.assert_code("DESKTOP_CONFIRMATION_CANCELLED", lambda: helper._current_confirm(TARGET["workspaceRoot"]))
            checked.assert_called_once_with(TARGET["workspaceRoot"])
            confirm.assert_called_once_with(info)

        changed = {**info, "title": "另一个会话"}
        with patch.object(helper, "_current_identity_checked", side_effect=[info, changed]), \
                patch.object(helper, "_show_confirmation", return_value=True), \
                patch.object(helper, "_Prepared", autospec=True) as prepared:
            self.assert_code("DESKTOP_CURRENT_CONTEXT_INVALID", lambda: helper._current_confirm(TARGET["workspaceRoot"]))
            prepared.assert_not_called()

        with patch.object(helper, "_current_identity_checked", side_effect=[info, info]) as checked, \
                patch.object(helper, "_show_confirmation", return_value=True) as confirm:
            self.assertEqual(helper._current_confirm(TARGET["workspaceRoot"]), info)
            self.assertEqual(checked.call_count, 2)
            confirm.assert_called_once_with(info)

    def test_current_identity_failure_is_before_confirmation_and_main_rejects_remote_text(self) -> None:
        failure = helper._error("DESKTOP_STATE_UNAVAILABLE")
        with patch.object(helper, "_current_identity_checked", side_effect=failure), \
                patch.object(helper, "_show_confirmation") as confirm:
            self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._current_confirm(TARGET["workspaceRoot"]))
            confirm.assert_not_called()

        requests = [
            {"id": "01a00000-0000-0000-0000-000000000020", "op": "current_identity", "workspaceRoot": TARGET["workspaceRoot"]},
            {"id": "01a00000-0000-0000-0000-000000000021", "op": "current_confirm", "workspaceRoot": TARGET["workspaceRoot"], "message": "远程授权"},
        ]
        class Stream:
            def __init__(self, data: bytes = b"") -> None:
                self.buffer = io.BytesIO(data)

        stdin = Stream(("\n".join(json.dumps(value, ensure_ascii=False) for value in requests) + "\n").encode("utf-8"))
        stdout = Stream()
        info = {**TARGET, "title": "当前会话", "cwd": TARGET["workspaceRoot"], "runtimeStatus": "active"}
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), \
                patch.object(helper, "_current_identity", return_value=info) as identity, \
                patch.object(helper, "_current_confirm") as current_confirm:
            helper._main()
        replies = [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]
        self.assertTrue(replies[0]["ok"])
        self.assertEqual(replies[0]["value"]["runtimeStatus"], "active")
        self.assertFalse(replies[1]["ok"])
        self.assertEqual(replies[1]["code"], "DESKTOP_INVALID_REQUEST")
        identity.assert_called_once()
        current_confirm.assert_not_called()

    def test_confirmation_metadata_is_single_line_and_default_is_cancel(self) -> None:
        info = {"title": "会话\n\u202e伪文案", "workspaceRoot": TARGET["workspaceRoot"]}
        native = Mock()
        native.MessageBoxW.return_value = 2
        with patch.object(helper.ctypes, "WinDLL", return_value=native):
            self.assertFalse(helper._show_confirmation(info))
        text = native.MessageBoxW.call_args.args[1]
        self.assertIn("会话标题=会话 �伪文案；工作区=", text)
        self.assertEqual(native.MessageBoxW.call_args.args[2], helper.CONFIRMATION_CAPTION)
        self.assertTrue(native.MessageBoxW.call_args.args[3] & 0x100)  # MB_DEFBUTTON2

    def test_canonical_history_requires_newest_boundary_exhausted(self) -> None:
        # R2 后 observe 路径（_validate_observed_state/_active_turn_id）接受
        # non-exhausted canonical（真实 active 会话正常处于 loading）；
        # 严格路径 _turns（send gate / result reconciliation）仍要求 exhausted。
        state = self.valid_state()
        state.pop("turns")
        state["turnHistory"] = {
            "kind": "canonical",
            "history": {
                "islands": [{"entries": [{"value": "turn-1"}], "newerBoundary": {"status": "exhausted"}}],
                "entitiesByKey": {"turn-1": {"turnId": "01a00000-0000-7000-8000-000000000011", "status": "completed"}},
            },
        }
        helper._validate_observed_state(state, TARGET, OWNER)
        not_exhausted = dict(state)
        not_exhausted["turnHistory"] = {
            **state["turnHistory"],
            "history": {**state["turnHistory"]["history"], "islands": [{"entries": [], "newerBoundary": {"status": "loading"}}]},
        }
        helper._validate_observed_state(not_exhausted, TARGET, OWNER)
        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._turns(not_exhausted))

    def test_process_api_declarations_use_pointer_sized_handles(self) -> None:
        if helper._kernel32 is None:
            self.skipTest("非 Windows 环境没有 Win32 API")
        self.assertIs(helper._kernel32.GetCurrentProcess.restype, helper._HANDLE)
        self.assertIs(helper._kernel32.CreateToolhelp32Snapshot.restype, helper._HANDLE)
        self.assertEqual(helper._kernel32.CreateToolhelp32Snapshot.argtypes, [helper.wintypes.DWORD, helper.wintypes.DWORD])

    def test_start_request_pipe_error_is_always_outcome_unknown(self) -> None:
        class BrokenPipe:
            def write(self, _data: bytes) -> None:
                raise helper._error("DESKTOP_PROCESS_CHANGED")

        client = helper._IpcClient(BrokenPipe(), THREAD, "local")
        request = client._envelope("thread-follower-start-turn", {}, OWNER)
        with self.assertRaises(helper.DesktopIpcError) as context:
            client.request(request, 0.1, sent_code="DESKTOP_OUTCOME_UNKNOWN")
        self.assertEqual(context.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(context.exception.not_sent)

    def test_main_unexpected_send_error_returns_unknown_not_not_sent(self) -> None:
        class Prepared:
            def send(self, _message: str) -> dict[str, str]:
                raise ValueError("故意的 fake send 错误")

            def close(self) -> None:
                pass

        requests = [
            {"id": "01a00000-0000-7000-8000-000000000020", "op": "prepare", "target": TARGET},
            {"id": "01a00000-0000-7000-8000-000000000021", "op": "send", "message": "执行中文计划"},
        ]
        class Stream:
            def __init__(self, data: bytes = b"") -> None:
                self.buffer = io.BytesIO(data)

        stdin = Stream(("\n".join(json.dumps(value, ensure_ascii=False) for value in requests) + "\n").encode("utf-8"))
        stdout = Stream()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), patch.object(
            helper, "_prepare", return_value=(Prepared(), {**TARGET, "title": "fake", "cwd": TARGET["workspaceRoot"]})
        ):
            helper._main()
        replies = [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]
        self.assertEqual(replies[-1]["code"], "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(replies[-1]["notSent"])


if __name__ == "__main__":
    unittest.main()
