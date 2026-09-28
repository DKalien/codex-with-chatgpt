"""Result ownership, activity fences and continuation classification."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

from .common import (
    DesktopIpcError,
    MAX_OBSERVATION_AGE_SECONDS,
    MAX_RESULT_ACTIVITY_ITEMS,
    MAX_RESULT_OWNERSHIP_CHAIN,
    RESULT_ACTIVITY_EPILOGUE_ITEM_TYPES,
    RESULT_ACTIVITY_ITEM_TYPES,
    _SHA256_PATTERN,
    SNAPSHOT_TIMEOUT_SECONDS,
    _RESULT_ACTIVITY_ITEM_ID_PATTERN,
    _error,
    _uuid,
)
from .history import (
    _complete_result_turns,
    _native_continuation_edge,
    _native_successor,
    _observed_turns,
    _turn_text_for_reconciliation,
)
from .identity import _verify_current_runner_ancestor, _verify_process_identity
from .operations import (
    _IpcClient,
    _prepare,
    _public_info,
    _current_target,
)
from .reconciliation import (
    _desktop_task_matches,
    _parse_desktop_task,
    _reconcile_expectation,
    _validate_observed_state,
)

def _active_turn_id(state: dict[str, Any]) -> str:
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type not in {"active", "inProgress"}:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    active: list[str] = []
    for turn in _observed_turns(state, require_exhausted=False):
        if turn.get("status") != "inProgress":
            continue
        turn_id = _uuid(turn.get("turnId"))
        if turn_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        active.append(turn_id)
    if len(active) != 1:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return active[0]


_RESULT_TERMINAL_STATUSES = {"completed", "failed", "interrupted", "cancelled"}


def _ownership_island_turns(state: dict[str, Any], origin_id: str, result_id: str) -> list[dict[str, Any]]:
    """Return one canonical island for an ownership proof; never bridge islands."""
    # Reuse the existing strict parser for global canonical completeness,
    # unique keys/turn IDs, and known statuses before preserving island edges.
    _complete_result_turns(state)
    history = state.get("turnHistory")
    body = history.get("history") if isinstance(history, dict) else None
    islands = body.get("islands") if isinstance(body, dict) else None
    entities = body.get("entitiesByKey") if isinstance(body, dict) else None
    if not isinstance(islands, list) or not isinstance(entities, dict):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    matches: list[list[dict[str, Any]]] = []
    for island in islands:
        entries = island.get("entries") if isinstance(island, dict) else None
        boundary = island.get("newerBoundary") if isinstance(island, dict) else None
        if not isinstance(entries, list) or not isinstance(boundary, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        island_turns: list[dict[str, Any]] = []
        for entry in entries:
            key = entry.get("value") if isinstance(entry, dict) else None
            item = entities.get(key) if isinstance(key, str) else None
            if not isinstance(item, dict):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            island_turns.append(item)
        ids = {turn.get("turnId") for turn in island_turns}
        if origin_id in ids or result_id in ids:
            if origin_id not in ids or result_id not in ids or boundary.get("status") != "exhausted":
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            matches.append(island_turns)
    if len(matches) != 1:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return matches[0]


def _result_turn_context(state: dict[str, Any]) -> tuple[str, str]:
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type in {"active", "inProgress"}:
        return _active_turn_id(state), "inProgress"
    if runtime_type != "idle":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    turns = _complete_result_turns(state)
    if any(turn.get("status") == "inProgress" for turn in turns):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    latest = turns[-1]
    latest_id = _uuid(latest.get("turnId"))
    latest_status = latest.get("status")
    if latest_id is None or latest_status not in _RESULT_TERMINAL_STATUSES:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return latest_id, latest_status


def _result_activity_sequence(turn: dict[str, Any]) -> tuple[list[str], list[str]]:
    """投影 canonical turn.items 的完整、有序、无正文 activity 序列。"""
    items = turn.get("items")
    if not isinstance(items, list) or not items or len(items) > MAX_RESULT_ACTIVITY_ITEMS:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    item_ids: list[str] = []
    item_types: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        item_id = item.get("id")
        item_type = item.get("type")
        if (not isinstance(item_id, str) or _RESULT_ACTIVITY_ITEM_ID_PATTERN.fullmatch(item_id) is None
                or not isinstance(item_type, str) or item_type not in RESULT_ACTIVITY_ITEM_TYPES or item_id in seen):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        seen.add(item_id)
        item_ids.append(item_id)
        item_types.append(item_type)
    return item_ids, item_types


def _result_activity_sha256(item_ids: list[str], item_types: list[str]) -> str:
    payload = [{"id": item_id, "type": item_type} for item_id, item_type in zip(item_ids, item_types)]
    canonical = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8", "strict")
    return hashlib.sha256(canonical).hexdigest()


def _result_activity_marker(item_ids: list[str], item_types: list[str], result_turn_id: str) -> dict[str, Any]:
    return {
        "resultTurnId": result_turn_id,
        "itemIds": list(item_ids),
        "itemTypes": list(item_types),
        "itemCount": len(item_ids),
        "itemSha256": _result_activity_sha256(item_ids, item_types),
    }


def _result_activity_marker_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "resultTurnId", "itemIds", "itemTypes", "itemCount", "itemSha256"
    }:
        raise _error("DESKTOP_INVALID_REQUEST")
    result_turn_id = _uuid(value.get("resultTurnId"))
    item_ids = value.get("itemIds")
    item_types = value.get("itemTypes")
    item_count = value.get("itemCount")
    item_sha256 = value.get("itemSha256")
    if (result_turn_id is None or not isinstance(item_ids, list) or not isinstance(item_types, list)
            or len(item_ids) != len(item_types) or len(item_ids) > MAX_RESULT_ACTIVITY_ITEMS
            or type(item_count) is not int or item_count != len(item_ids)
            or not isinstance(item_sha256, str) or _SHA256_PATTERN.fullmatch(item_sha256) is None):
        raise _error("DESKTOP_INVALID_REQUEST")
    seen: set[str] = set()
    for item_id, item_type in zip(item_ids, item_types):
        if (not isinstance(item_id, str) or _RESULT_ACTIVITY_ITEM_ID_PATTERN.fullmatch(item_id) is None
                or item_id in seen or not isinstance(item_type, str) or item_type not in RESULT_ACTIVITY_ITEM_TYPES):
            raise _error("DESKTOP_INVALID_REQUEST")
        seen.add(item_id)
    return {
        "resultTurnId": result_turn_id,
        "itemIds": list(item_ids),
        "itemTypes": list(item_types),
        "itemCount": item_count,
        "itemSha256": item_sha256,
        "digestValid": _result_activity_sha256(item_ids, item_types) == item_sha256,
    }


def _result_activity_fence(result_turn_id: str, result_turn_status: str,
                           item_ids: list[str], item_types: list[str], marker: dict[str, Any]) -> str:
    if (not marker["digestValid"] or marker["resultTurnId"] != result_turn_id):
        return "unprovable"
    marker_ids = marker["itemIds"]
    marker_types = marker["itemTypes"]
    if item_ids == marker_ids and item_types == marker_types:
        return "inProgress" if result_turn_status == "inProgress" else "safe_terminal"
    prefix_length = len(marker_ids)
    if (len(item_ids) > prefix_length and item_ids[:prefix_length] == marker_ids
            and item_types[:prefix_length] == marker_types):
        suffix_types = item_types[prefix_length:]
        if suffix_types and all(item_type in RESULT_ACTIVITY_EPILOGUE_ITEM_TYPES for item_type in suffix_types):
            return "inProgress" if result_turn_status == "inProgress" else "safe_terminal"
        return "post_record_activity"
    return "unprovable"


def _current_execution(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, _ = _prepare(target, purpose="observe", require_runner_ancestor=True)
    try:
        # 取 prepare 阶段之后仍在窗口内的新鲜状态；不接受环境变量提供的 turnId。
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        # 使用 prepare 时捕获的 process identity 做同一进程复核，避免把新进程或伪造环境当作当前执行。
        _verify_process_identity(session.pipe, target, session.process)
        _verify_current_runner_ancestor(session.process)
        # process/runner 核验可能消耗时间；回传前再次确认仍在观测窗口内。
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            _verify_current_runner_ancestor(session.process)
            if (time.monotonic() >= freshness_deadline
                    or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        active_turn_id = _active_turn_id(state)
        return {
            **_public_info(state, target, session.client),
            "activeTurnId": active_turn_id,
        }
    finally:
        session.close()


def _inspect_active_execution(target: dict[str, str]) -> dict[str, Any]:
    session, _ = _prepare(target, purpose="observe")
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        _verify_process_identity(session.pipe, target, session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        active_turn_id = _active_turn_id(state)
        return {
            **_public_info(state, target, session.client),
            "activeTurnId": active_turn_id,
        }
    finally:
        session.close()


def _inspect_result_context(target: dict[str, str]) -> dict[str, Any]:
    """Detached finalizer 的显式 target 观察；不依赖 runner ancestor。"""
    session, _ = _prepare(target, purpose="observe")
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_process_identity(session.pipe, target, session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            if (time.monotonic() >= freshness_deadline
                    or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        result_turn_id, result_turn_status = _result_turn_context(state)
        return {
            **_public_info(state, target, session.client),
            "resultTurnId": result_turn_id,
            "resultTurnStatus": result_turn_status,
        }
    finally:
        session.close()


def _inspect_result_activity(target: dict[str, str], marker_value: Any = None, *, verify: bool = False) -> dict[str, Any]:
    """读取一次 live canonical turn，并只投影有序 item id/type。"""
    marker = _result_activity_marker_input(marker_value) if verify else None
    session, _ = _prepare(target, purpose="observe")
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_process_identity(session.pipe, target, session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            if (time.monotonic() >= freshness_deadline
                    or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        result_turn_id, result_turn_status = _result_turn_context(state)
        turns = _complete_result_turns(state)
        matches = [turn for turn in turns if turn.get("turnId") == result_turn_id]
        if len(matches) != 1:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        item_ids, item_types = _result_activity_sequence(matches[0])
        base = {
            **_public_info(state, target, session.client),
            "resultTurnId": result_turn_id,
            "resultTurnStatus": result_turn_status,
        }
        if not verify:
            return {**base, "marker": _result_activity_marker(item_ids, item_types, result_turn_id)}
        return {**base, "fence": _result_activity_fence(result_turn_id, result_turn_status,
                                                           item_ids, item_types, marker)}
    finally:
        session.close()


def _inspect_result_activity_marker(target: dict[str, str]) -> dict[str, Any]:
    return _inspect_result_activity(target)


def _inspect_result_terminal_fence(target: dict[str, str], marker: Any) -> dict[str, Any]:
    return _inspect_result_activity(target, marker, verify=True)


def _current_result_context(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, _ = _prepare(target, purpose="observe", require_runner_ancestor=True)
    try:
        # 与 current_execution 一样，在 process/runner 核验前后都只使用新鲜快照。
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_process_identity(session.pipe, target, session.process)
        _verify_current_runner_ancestor(session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            if (time.monotonic() >= freshness_deadline
                    or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        result_turn_id, result_turn_status = _result_turn_context(state)
        return {
            **_public_info(state, target, session.client),
            "resultTurnId": result_turn_id,
            "resultTurnStatus": result_turn_status,
        }
    finally:
        session.close()


def _continuation_expectation(value: Any) -> dict[str, Any]:
    base_keys = {"workspaceId", "commandId", "intent", "messageBytes", "messageSha256", "originTurnId"}
    if (not isinstance(value, dict) or
            frozenset(value) not in {frozenset(base_keys), frozenset(base_keys | {"deliveryId"})}):
        raise _error("DESKTOP_INVALID_REQUEST")
    base = {key: value[key] for key in ("workspaceId", "commandId", "intent", "messageBytes", "messageSha256")}
    if "deliveryId" in value:
        base["deliveryId"] = value["deliveryId"]
    result = _reconcile_expectation(base)
    origin_turn_id = _uuid(value.get("originTurnId"))
    if origin_turn_id is None:
        raise _error("DESKTOP_INVALID_REQUEST")
    result["originTurnId"] = origin_turn_id
    return result


def _origin_matches_expectation(turn: dict[str, Any], expectation: dict[str, Any], target: dict[str, str]) -> None:
    text = _turn_text_for_reconciliation(turn)
    if text is None:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    envelope = _parse_desktop_task(text)
    if envelope is None or not _desktop_task_matches(expectation, envelope):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    params = turn.get("params")
    if isinstance(params, dict) and params.get("threadId") not in {None, target["threadId"]}:
        raise _error("DESKTOP_TARGET_NOT_FOUND")


def _observed_desktop_origin(turn: dict[str, Any], target: dict[str, str]) -> dict[str, Any] | None:
    text = _turn_text_for_reconciliation(turn)
    if text is None or not text.lstrip().startswith("{"):
        return None
    envelope = _parse_desktop_task(text)
    if envelope is None:
        return None
    params = turn.get("params")
    if isinstance(params, dict) and params.get("threadId") not in {None, target["threadId"]}:
        raise _error("DESKTOP_TARGET_NOT_FOUND")
    return {key: value for key, value in envelope.items() if key != "version"}


_EDIT_DELIVERY_ORIGIN_TRIGGER = "edit_user_message"
_EDIT_DELIVERY_ORIGIN_ALIAS = "edit_user_message_v2_delivery"


def _delivery_id_origins(turns: list[dict[str, Any]], target: dict[str, str], delivery_id: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for turn in turns:
        params = turn.get("params")
        raw_input = params.get("input") if isinstance(params, dict) else None
        if not isinstance(raw_input, list):
            continue
        possible_envelope = any(
            isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].lstrip().startswith("{")
            for item in raw_input
        )
        if not possible_envelope:
            continue
        observed = _observed_desktop_origin(turn, target)
        if observed is not None and observed.get("deliveryId") == delivery_id:
            matches.append(turn)
    return matches


def _delivery_alias_edge(origin: dict[str, Any], successor: dict[str, Any], target: dict[str, str]) -> str:
    observed = _observed_desktop_origin(origin, target)
    params = origin.get("params")
    if (observed is None or "deliveryId" not in observed or origin.get("status") != "interrupted"
            or not isinstance(params, dict) or params.get("turnTrigger") != _EDIT_DELIVERY_ORIGIN_TRIGGER):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if _native_continuation_edge(origin, successor, target) != "resume_interrupted_task":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return "resume_interrupted_task"


def _classification_origin_alias(state: dict[str, Any], origin: dict[str, Any], successor: dict[str, Any],
                                 observed: dict[str, Any], target: dict[str, str]) -> str | None:
    params = origin.get("params")
    if ("deliveryId" not in observed or origin.get("status") != "interrupted"
            or not isinstance(params, dict) or params.get("turnTrigger") != _EDIT_DELIVERY_ORIGIN_TRIGGER):
        return None
    if _native_continuation_edge(origin, successor, target) != "resume_interrupted_task":
        return None
    all_turns = _complete_result_turns(state)
    matches = _delivery_id_origins(all_turns, target, observed["deliveryId"])
    if len(matches) != 1 or matches[0].get("turnId") != origin.get("turnId"):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return _EDIT_DELIVERY_ORIGIN_ALIAS


def _evaluate_result_ownership(state: dict[str, Any], target: dict[str, str],
                               expectation: dict[str, Any], client: _IpcClient) -> dict[str, Any]:
    all_turns = _complete_result_turns(state)
    ids = [turn.get("turnId") for turn in all_turns]
    origin_id = expectation["originTurnId"]
    origin_indices = [index for index, turn_id in enumerate(ids) if turn_id == origin_id]
    origin_alias: str | None = None
    if len(origin_indices) == 1:
        # The accepted turn ID remains authoritative whenever present.
        _origin_matches_expectation(all_turns[origin_indices[0]], expectation, target)
    elif not origin_indices and "deliveryId" in expectation:
        aliases = _delivery_id_origins(all_turns, target, expectation["deliveryId"])
        if len(aliases) != 1:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _origin_matches_expectation(aliases[0], expectation, target)
        origin_id = _uuid(aliases[0].get("turnId"))
        if origin_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        origin_indices = [index for index, turn in enumerate(all_turns) if turn is aliases[0]]
        if len(origin_indices) != 1:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        origin_alias = _EDIT_DELIVERY_ORIGIN_ALIAS
    else:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    result_id, result_status = _result_turn_context(state)
    turns = _ownership_island_turns(state, origin_id, result_id)
    ids = [turn.get("turnId") for turn in turns]
    origin_indices = [index for index, turn_id in enumerate(ids) if turn_id == origin_id]
    result_indices = [index for index, turn_id in enumerate(ids) if turn_id == result_id]
    if len(origin_indices) != 1 or len(result_indices) != 1:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    origin_index = origin_indices[0]
    result_index = result_indices[0]
    if result_index < origin_index:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if result_index == origin_index:
        if origin_alias is not None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        return {
            **_public_info(state, target, client),
            "resultTurnId": result_id,
            "resultTurnStatus": result_status,
            "ownership": "origin",
            "originTurnId": origin_id,
            "originAlias": None,
            **({"deliveryId": expectation["deliveryId"]} if "deliveryId" in expectation else {}),
            "chainTurnIds": [origin_id],
            "chainLength": 0,
            "chainSignatures": [],
            "signature": None,
        }
    chain_length = result_index - origin_index
    if chain_length > MAX_RESULT_OWNERSHIP_CHAIN:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    chain = [origin_id]
    chain_signatures = []
    for index in range(origin_index, result_index):
        predecessor = turns[index]
        successor = turns[index + 1]
        successor_id = _uuid(successor.get("turnId"))
        if successor_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        if origin_alias is not None and index == origin_index:
            chain_signatures.append(_delivery_alias_edge(predecessor, successor, target))
        else:
            chain_signatures.append(_native_continuation_edge(predecessor, successor, target))
        chain.append(successor_id)
    if chain[-1] != result_id:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return {
        **_public_info(state, target, client),
        "resultTurnId": result_id,
        "resultTurnStatus": result_status,
        "ownership": "native_continuation",
        "originTurnId": origin_id,
        "originAlias": origin_alias,
        **({"deliveryId": expectation["deliveryId"]} if "deliveryId" in expectation else {}),
        "chainTurnIds": chain,
        "chainLength": chain_length,
        "chainSignatures": chain_signatures,
        "signature": chain_signatures[-1],
    }


def _current_result_ownership(workspace_root: Any, expectation_value: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    expectation = _continuation_expectation(expectation_value)
    session, _ = _prepare(target, purpose="observe", require_runner_ancestor=True)
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_process_identity(session.pipe, target, session.process)
        _verify_current_runner_ancestor(session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            _verify_current_runner_ancestor(session.process)
            if time.monotonic() >= freshness_deadline or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        return _evaluate_result_ownership(state, target, expectation, session.client)
    finally:
        session.close()


def _inspect_result_ownership(target: dict[str, str], expectation_value: Any) -> dict[str, Any]:
    expectation = _continuation_expectation(expectation_value)
    session, _ = _prepare(target, purpose="observe")
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_process_identity(session.pipe, target, session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            if time.monotonic() >= freshness_deadline or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        return _evaluate_result_ownership(state, target, expectation, session.client)
    finally:
        session.close()


def _current_result_island(state: dict[str, Any], result_id: str) -> list[dict[str, Any]]:
    _complete_result_turns(state)
    history = state.get("turnHistory", {}).get("history", {})
    islands = history.get("islands") if isinstance(history, dict) else None
    entities = history.get("entitiesByKey") if isinstance(history, dict) else None
    matches = []
    if not isinstance(islands, list) or not isinstance(entities, dict):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    for island in islands:
        entries = island.get("entries") if isinstance(island, dict) else None
        boundary = island.get("newerBoundary") if isinstance(island, dict) else None
        if not isinstance(entries, list) or not entries or not isinstance(boundary, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        turns = []
        for entry in entries:
            key = entry.get("value") if isinstance(entry, dict) else None
            turn = entities.get(key) if isinstance(key, str) else None
            if not isinstance(turn, dict):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            turns.append(turn)
        if any(turn.get("turnId") == result_id for turn in turns):
            if boundary.get("status") != "exhausted":
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            matches.append(turns)
    if len(matches) != 1:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return matches[0]


def _current_result_classification(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, _ = _prepare(target, purpose="observe", require_runner_ancestor=True)
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, target, session.client.owner or "")
        _verify_process_identity(session.pipe, target, session.process)
        _verify_current_runner_ancestor(session.process)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_process_identity(session.pipe, target, session.process)
            _verify_current_runner_ancestor(session.process)
            if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, session.client.owner or "")
        result_id, result_status = _result_turn_context(state)
        island = _current_result_island(state, result_id)
        indexes = [i for i, turn in enumerate(island) if turn.get("turnId") == result_id]
        if len(indexes) != 1:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        base = {**_public_info(state, target, session.client),
                "resultTurnId": result_id, "resultTurnStatus": result_status}
        current = island[indexes[0]]
        try:
            _turn_text_for_reconciliation(current)
        except DesktopIpcError:
            _native_successor(current, target)
        else:
            observed = _observed_desktop_origin(current, target)
            if observed is None:
                return {**base, "classification": "not_applicable"}
            return {**base, **observed, "classification": "applicable", "ownership": "origin",
                    "originTurnId": result_id, "originAlias": None,
                    "chainTurnIds": [result_id], "chainLength": 0,
                    "chainSignatures": [], "signature": None}
        chain = [result_id]
        cursor = indexes[0]
        reverse_chain_signatures = []
        while cursor > 0:
            if len(chain) - 1 >= MAX_RESULT_OWNERSHIP_CHAIN:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            successor = island[cursor]
            predecessor = island[cursor - 1]
            trigger = _native_continuation_edge(predecessor, successor, target)
            reverse_chain_signatures.append(trigger)
            predecessor_id = _uuid(predecessor.get("turnId"))
            if predecessor_id is None:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            chain.insert(0, predecessor_id)
            try:
                _turn_text_for_reconciliation(predecessor)
            except DesktopIpcError:
                _native_successor(predecessor, target)
                cursor -= 1
                continue
            observed = _observed_desktop_origin(predecessor, target)
            if observed is None:
                return {**base, "classification": "not_applicable"}
            origin_alias = _classification_origin_alias(state, predecessor, successor, observed, target)
            return {**base, **observed, "classification": "applicable", "ownership": "native_continuation",
                    "originTurnId": predecessor_id, "originAlias": origin_alias, "chainTurnIds": chain,
                    "chainLength": len(chain) - 1, "chainSignatures": list(reversed(reverse_chain_signatures)),
                    "signature": reverse_chain_signatures[0]}
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    finally:
        session.close()
