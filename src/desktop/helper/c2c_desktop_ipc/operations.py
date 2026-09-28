"""Desktop IPC operation preparation and current-session operations."""

from __future__ import annotations

import ctypes
import os
import time
import unicodedata
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any

from .common import (
    CONFIRMATION_CAPTION,
    CONFIRMATION_RISK_TEXT,
    DesktopIpcError,
    MAX_OBSERVATION_AGE_SECONDS,
    POST_START_STATE_DEADLINE_SECONDS,
    SEND_TIMEOUT_SECONDS,
    _error,
    _normalize_path,
    _target,
    _uuid,
)
from .identity import (
    _current_target,
    _query_standard_token,
    _verify_current_runner_ancestor,
    _verify_process_identity,
)
from .history import (
    _assert_post_start_target,
    _turns,
    _verify_live_ack_turn,
)
from .reconciliation import (
    _assert_send_ready,
    _reconcile_expectation,
    _reconcile_turn_ids,
    _validate_observed_state,
)
from .transport import _IpcClient, _Pipe

def _public_info(state: dict[str, Any], target: dict[str, str], client: _IpcClient) -> dict[str, Any]:
    title = state.get("title")
    cwd = state.get("cwd")
    runtime_state = state.get("threadRuntimeStatus")
    runtime_status = runtime_state.get("type") if isinstance(runtime_state, dict) else None
    if (not isinstance(title, str) or not title.strip() or len(title) > 300 or not isinstance(cwd, str)
            or not isinstance(runtime_status, str)):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return {
        "threadId": target["threadId"],
        "hostId": target["hostId"],
        "projectId": target["projectId"],
        "workspaceRoot": target["workspaceRoot"],
        "title": title,
        "cwd": cwd,
        "workspaceKind": state.get("workspaceKind"),
        "resumeState": state.get("resumeState"),
        "runtimeStatus": runtime_status,
        "requestsCount": len(state.get("requests", [])),
        "ownerClientId": client.owner,
    }


@dataclass
class _Prepared:
    target: dict[str, str]
    pipe: _Pipe
    client: _IpcClient
    process: dict[str, Any]

    def _process_fence(self) -> None:
        _verify_process_identity(self.pipe, self.target, self.process)

    def send(self, message: str) -> dict[str, str]:
        """Behavioral send attestation：单次 start-turn + 事后 canonical 证明。"""
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
        # 以最后一次状态观测建立 ACK 防重放集合与 observation 高水位。
        before_turn_ids = {
            turn.get("turnId")
            for turn in _turns(state)
            if isinstance(turn.get("turnId"), str)
        }
        before_serial = self.client.snapshot_serial
        # ---- mutation boundary：唯一一次 start-turn 写入尝试前翻转 ----
        self.start_attempted = True
        try:
            request = self.client._envelope("thread-follower-start-turn", {
                "conversationId": self.target["threadId"],
                "turnStart": {
                    "request": {
                        "threadId": self.target["threadId"],
                        "input": [{"type": "text", "text": message, "text_elements": []}],
                    }
                },
            }, self.client.owner)
            response = self.client.request(request, SEND_TIMEOUT_SECONDS, sent_code="DESKTOP_OUTCOME_UNKNOWN")
            result = response.get("result")
            nested = result.get("result") if isinstance(result, dict) else None
            turn = nested.get("turn") if isinstance(nested, dict) else None
            turn_id = turn.get("id") if isinstance(turn, dict) else None
            if _uuid(turn_id) is None or turn_id in before_turn_ids:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            deadline = time.monotonic() + POST_START_STATE_DEADLINE_SECONDS
            state = self.client.snapshot()
            if time.monotonic() >= deadline:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            _assert_post_start_target(state, self.target)
            # ---- bounded wait：只轮询 state，绝不重发 start-turn ----
            # 只有 turn 尚未出现，或唯一 inProgress turn 的 userMessage 镜像尚未完成，
            # 才能等待；重复、未知结构或任一可读正文不匹配都立即 unknown。
            verification = _verify_live_ack_turn(state, turn_id, message)
            while verification == "pending":
                if time.monotonic() >= deadline:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                state = self.client.snapshot()
                if time.monotonic() >= deadline:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                if self.client.snapshot_serial <= before_serial:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                _assert_post_start_target(state, self.target)
                verification = _verify_live_ack_turn(state, turn_id, message)
            if verification != "verified":
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- final process/owner fence ----
            self._process_fence()
            self.client.discover()
            return {"threadId": self.target["threadId"], "turnId": turn_id}
        except DesktopIpcError:
            # boundary 之后的一切不确定性统一收敛为 outcome unknown；
            # 不依赖下层 helper 的默认 not_sent，绝不第二次 start-turn。
            if self.start_attempted:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            raise
        except TimeoutError:
            if self.start_attempted:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            raise

    def close(self) -> None:
        self.pipe.close()


def _prepare(target: dict[str, str], *, purpose: str = "send",
             require_runner_ancestor: bool = False) -> tuple[_Prepared, dict[str, Any]]:
    """purpose="observe" 只观察（忙/请求/未确认提交都允许）；purpose="send" 才做 send-ready gate。"""
    if purpose not in {"observe", "send"}:
        raise _error("DESKTOP_INVALID_REQUEST")
    _query_standard_token()
    process: dict[str, Any] | None = None
    pipe = _Pipe()
    try:
        process = _verify_process_identity(pipe, target)
        client = _IpcClient(pipe, target["threadId"], target["hostId"])
        client.initialize()
        client.discover()
        state = client.snapshot()
        _validate_observed_state(state, target, client.owner or "")
        if purpose == "send":
            _assert_send_ready(state)
        info = _public_info(state, target, client)
        if purpose == "observe":
            client.drain(0.1)
            # freshness 判定先于整份深拷贝：current_state 的拷贝开销属于
            # 观察者自身，不应计入被观察状态的陈旧度。
            if client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            state = client.current_state()
            if state is None:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, client.owner or "")
            info = _public_info(state, target, client)
        process = _verify_process_identity(pipe, target, process)
        if require_runner_ancestor:
            _verify_current_runner_ancestor(process)
        if client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        prepared = _Prepared(target, pipe, client, process)
        return prepared, info
    except DesktopIpcError as error:
        try:
            if error.code == "DESKTOP_NO_OWNER" and process is not None:
                _verify_process_identity(pipe, target, process)
        finally:
            pipe.close()
        raise
    except TimeoutError:
        pipe.close()
        raise _error("DESKTOP_IPC_TIMEOUT")
    except (OSError, ValueError, TypeError, KeyError):
        pipe.close()
        raise _error("DESKTOP_INTERNAL_ERROR")


def _reconcile_unknown(target: dict[str, str], expectation_value: Any) -> dict[str, Any]:
    """Re-attest a possibly delivered command against two stable observations."""
    target = _target(target)
    expectation = _reconcile_expectation(expectation_value)
    session, _ = _prepare(target, purpose="observe")
    try:
        before = session.client.current_state()
        if before is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(before, target, session.client.owner or "")
        before_candidates = _reconcile_turn_ids(before, expectation, target)
        _verify_process_identity(session.pipe, target, session.process)
        after = session.client.snapshot()
        _validate_observed_state(after, target, session.client.owner or "")
        after_candidates = _reconcile_turn_ids(after, expectation, target)
        _verify_process_identity(session.pipe, target, session.process)
        if before_candidates != after_candidates:
            raise _error("DESKTOP_RECONCILIATION_CONFLICT")
        return {
            "threadId": target["threadId"],
            "hostId": target["hostId"],
            "projectId": target["projectId"],
            "workspaceRoot": target["workspaceRoot"],
            "candidates": after_candidates,
        }
    finally:
        session.close()


def _diagnose(workspace_root: Any) -> dict[str, Any]:
    """只读 live handshake 诊断；不发送 start-turn，不做信任分类。"""
    target = _current_target(workspace_root)
    _query_standard_token()
    pipe = _Pipe()
    session: _IpcClient | None = None
    try:
        before = _verify_process_identity(pipe, target)
        session = _IpcClient(pipe, target["threadId"], target["hostId"])
        session.initialize()
        owner = session.discover()
        state = session.snapshot()
        if not isinstance(state, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _verify_process_identity(pipe, target, before)
        return {
            "mode": "behavioral",
            "processStable": True,
            "initialize": True,
            "ownerDiscovery": bool(owner),
            "followingChangedSent": session.following_changed_sent,
            "stateReceived": session.state_change_kind in {"snapshot", "patches"},
            "stateChange": session.state_change_kind,
        }
    finally:
        if session is not None:
            session.pipe.close()
        else:
            pipe.close()


def _current_identity_checked(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, info = _prepare(target, purpose="observe", require_runner_ancestor=True)
    try:
        return info
    finally:
        session.close()


def _same_current_identity(left: dict[str, Any], right: dict[str, Any]) -> bool:
    for key in ("threadId", "hostId", "projectId", "workspaceRoot", "title", "workspaceKind", "resumeState",
                "ownerClientId"):
        if left.get(key) != right.get(key):
            return False
    return _normalize_path(str(left.get("cwd", ""))) == _normalize_path(str(right.get("cwd", "")))


def _display_metadata(value: str) -> str:
    """把远端可控字段压成单行；控制符和 bidi 标记不能伪装固定风险文案。"""
    result: list[str] = []
    for char in value:
        category = unicodedata.category(char)
        if char in "\r\n\t" or category in {"Zl", "Zp"}:
            result.append(" ")
        elif category.startswith("C") or char in {"\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c",
                                                  "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"}:
            result.append("�")
        else:
            result.append(char)
    return "".join(result).strip() or "(未命名)"


def _show_confirmation(info: dict[str, Any]) -> bool:
    """显示固定风险确认框；任何非 OK 结果（含关闭窗口）都视为取消。"""
    if os.name != "nt":
        raise _error("DESKTOP_UNSUPPORTED_PLATFORM")
    title = _display_metadata(str(info.get("title", "")))
    workspace = _display_metadata(str(info.get("workspaceRoot", "")))
    text = f"{CONFIRMATION_RISK_TEXT}\n\n会话标题={title}；工作区={workspace}\n\n点击“确定”绑定并启用，点击“取消”放弃。"
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
        user32.MessageBoxW.restype = ctypes.c_int
        result = user32.MessageBoxW(
            None,
            text,
            CONFIRMATION_CAPTION,
            0x00000001 | 0x00000020 | 0x00000100 | 0x00002000 | 0x00010000,
        )
    except (OSError, ValueError, ctypes.ArgumentError):
        return False
    return int(result) == 1


def _current_identity(workspace_root: Any) -> dict[str, Any]:
    return _current_identity_checked(workspace_root)



def _current_confirm(workspace_root: Any) -> dict[str, Any]:
    before = _current_identity_checked(workspace_root)
    try:
        confirmed = _show_confirmation(before)
    except DesktopIpcError:
        raise
    except Exception:
        confirmed = False
    if confirmed is not True:
        raise _error("DESKTOP_CONFIRMATION_CANCELLED")
    after = _current_identity_checked(workspace_root)
    if not _same_current_identity(before, after):
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    return after
