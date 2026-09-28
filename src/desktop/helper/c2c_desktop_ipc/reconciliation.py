"""Observed-state validation and send readiness gates."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .common import (
    MAX_MESSAGE_BYTES,
    _error,
    _normalize_path,
    _require,
    _uuid,
)
from .history import (
    _complete_result_turns,
    _native_continuation_edge,
    _observed_turns,
    _turn_text_for_reconciliation,
    _turns,
)

def _reconcile_expectation(value: Any) -> dict[str, Any]:
    base_keys = {"workspaceId", "commandId", "intent", "messageBytes", "messageSha256"}
    if (not isinstance(value, dict) or
            frozenset(value) not in {frozenset(base_keys), frozenset(base_keys | {"deliveryId"})}):
        raise _error("DESKTOP_INVALID_REQUEST")
    for key in ("workspaceId", "commandId"):
        item = value.get(key)
        if not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item):
            raise _error("DESKTOP_INVALID_REQUEST")
    if value.get("intent") not in {"development_plan", "revision"}:
        raise _error("DESKTOP_INVALID_REQUEST")
    if (type(value.get("messageBytes")) is not int or not 0 < value["messageBytes"] <= MAX_MESSAGE_BYTES or
            not isinstance(value.get("messageSha256"), str) or
            re.fullmatch(r"[a-f0-9]{64}", value["messageSha256"]) is None):
        raise _error("DESKTOP_INVALID_REQUEST")
    result = dict(value)
    if "deliveryId" in result:
        delivery_id = _uuid(result["deliveryId"])
        if delivery_id is None:
            raise _error("DESKTOP_INVALID_REQUEST")
        result["deliveryId"] = delivery_id
    return result






def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


_DESKTOP_TASK_V1_KEYS = frozenset({"type", "version", "workspaceId", "commandId", "intent", "message"})
_DESKTOP_TASK_V2_KEYS = _DESKTOP_TASK_V1_KEYS | {"deliveryId"}


def _parse_desktop_task(text: str) -> dict[str, Any] | None:
    """Parse the exact v1/v2 envelope without retaining or logging its message."""
    if not text.lstrip().startswith("{"):
        return None
    try:
        if len(text.encode("utf-8", "strict")) > MAX_MESSAGE_BYTES * 6 + 512:
            raise ValueError("envelope too large")
        envelope = json.loads(text, object_pairs_hook=_strict_json_object)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RecursionError):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if not isinstance(envelope, dict):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if envelope.get("type") != "C2C_DESKTOP_TASK":
        return None
    version = envelope.get("version")
    if type(version) is not int or version not in {1, 2}:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    expected_keys = _DESKTOP_TASK_V1_KEYS if version == 1 else _DESKTOP_TASK_V2_KEYS
    if set(envelope) != expected_keys:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    workspace_id = envelope.get("workspaceId")
    command_id = envelope.get("commandId")
    intent = envelope.get("intent")
    message = envelope.get("message")
    if (not isinstance(workspace_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", workspace_id) is None
            or not isinstance(command_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command_id) is None
            or not isinstance(intent, str) or intent not in {"development_plan", "revision"}
            or not isinstance(message, str) or not message):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    try:
        encoded = message.encode("utf-8", "strict")
    except UnicodeEncodeError:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if len(encoded) > MAX_MESSAGE_BYTES:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    result = {
        "version": version,
        "workspaceId": workspace_id,
        "commandId": command_id,
        "intent": intent,
        "messageBytes": len(encoded),
        "messageSha256": hashlib.sha256(encoded).hexdigest(),
    }
    if version == 2:
        delivery_id = _uuid(envelope.get("deliveryId"))
        if delivery_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        result["deliveryId"] = delivery_id
    return result


def _desktop_task_matches(expectation: dict[str, Any], envelope: dict[str, Any]) -> bool:
    version = 2 if "deliveryId" in expectation else 1
    return (envelope.get("version") == version and
            all(envelope.get(key) == expectation.get(key) for key in
                ("workspaceId", "commandId", "intent", "messageBytes", "messageSha256")) and
            (version == 1 or envelope.get("deliveryId") == expectation["deliveryId"]))

def _reconcile_turn_ids(state: dict[str, Any], expectation: dict[str, Any], target: dict[str, str]) -> list[str]:
    candidates: list[str] = []
    # reconciliation 只接受 canonical、已 exhaust 的完整历史；flat turns
    # 没有完整性边界，不能证明“零候选”是真实零候选。
    turns = _complete_result_turns(state)
    predecessors: dict[str, dict[str, Any]] = {}
    history = state["turnHistory"]["history"]
    entities = history["entitiesByKey"]
    for island in history["islands"]:
        previous: dict[str, Any] | None = None
        for entry in island["entries"]:
            turn = entities[entry["value"]]
            turn_id = _uuid(turn.get("turnId"))
            if turn_id is None:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            if previous is not None:
                predecessors[turn_id] = previous
            previous = turn
    for turn in turns:
        params = turn.get("params")
        raw_input = params.get("input") if isinstance(params, dict) else None
        native_trigger = params.get("turnTrigger") if isinstance(params, dict) else None
        is_native_candidate = (
            isinstance(native_trigger, str)
            and native_trigger in {"capacity_retry_automatic", "resume_interrupted_task"}
            and ("input" not in params or raw_input == [])
        ) if isinstance(params, dict) else False
        if is_native_candidate:
            turn_id = _uuid(turn.get("turnId"))
            predecessor = predecessors.get(turn_id) if turn_id is not None else None
            if predecessor is None:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _native_continuation_edge(predecessor, turn, target, strict_items=True)
            continue
        text = _turn_text_for_reconciliation(turn)
        if text is None:
            continue
        envelope = _parse_desktop_task(text)
        if envelope is None or not _desktop_task_matches(expectation, envelope):
            continue
        turn_id = _uuid(turn.get("turnId"))
        if turn_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        candidates.append(turn_id)
    return candidates


def _unconfirmed_submissions(state: dict[str, Any]) -> list[Any]:
    value = state.get("unconfirmedTurnSubmissions")
    if value is None:
        return []
    if isinstance(value, list):
        return value
    raise _error("DESKTOP_STATE_UNAVAILABLE")


def _validate_observed_state(state: dict[str, Any], target: dict[str, str], owner: str) -> None:
    """验证这是正确且结构可理解的会话；忙、请求或未确认提交允许存在。

    只读观察不跳过 shape validation：所有字段的类型仍必须合法，
    turn status 非法值仍然拒绝。
    """
    if state.get("id") != target["threadId"] or state.get("hostId") != target["hostId"]:
        raise _error("DESKTOP_TARGET_NOT_FOUND")
    cwd = state.get("cwd")
    if not isinstance(cwd, str) or _normalize_path(cwd) != _normalize_path(target["workspaceRoot"]):
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if state.get("workspaceKind") != "project":
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if state.get("resumeState") != "resumed":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type not in {"idle", "active", "inProgress"}:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if not isinstance(state.get("requests"), list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    _unconfirmed_submissions(state)
    terminal_statuses = {"completed", "failed", "interrupted", "cancelled"}
    for turn in _observed_turns(state, require_exhausted=False):
        status = turn.get("status")
        if status != "inProgress" and status not in terminal_statuses:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    for environment in state.get("environments") or []:
        if not isinstance(environment, dict) or _normalize_path(str(environment.get("cwd", ""))) != _normalize_path(target["workspaceRoot"]):
            raise _error("DESKTOP_PROJECT_MISMATCH")
    _require(bool(owner), "DESKTOP_NO_OWNER")

def _assert_send_ready(state: dict[str, Any]) -> None:
    """发送前 runtime gate：idle、无请求、无未确认提交、无 inProgress turn。

    不含 owner 一致性——owner 属于 _IpcClient session identity，
    由 prepare/send 前后的 owner fence 单独保证。
    """
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type != "idle":
        raise _error("DESKTOP_BUSY")
    if state.get("requests"):
        raise _error("DESKTOP_APPROVAL_PENDING")
    if _unconfirmed_submissions(state):
        raise _error("DESKTOP_APPROVAL_PENDING")
    for turn in _turns(state):
        if turn.get("status") == "inProgress":
            raise _error("DESKTOP_BUSY")
