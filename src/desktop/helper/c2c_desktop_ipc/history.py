"""Canonical turn history normalization primitives."""

from __future__ import annotations

from typing import Any, Literal

from .common import (
    DesktopIpcError,
    RESULT_ACTIVITY_ITEM_TYPES,
    _error,
    _uuid,
)


def _observed_turns(state: dict[str, Any], *, require_exhausted: bool = True) -> list[dict[str, Any]]:
    """观察用 turn 集合：canonical 结构严格校验，exhausted 要求可配置。

    require_exhausted=True（默认）保持基线语义：canonical 最新 island 的
    newerBoundary 必须 exhausted。require_exhausted=False 供只读观察路径
    （validate/active）使用：真实 active 会话的 canonical history 正常处于
    loading，不能因此拒绝观察；islands/entities/entry 结构仍逐项严格校验。
    """
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
    """send-safe / result 语义的严格 turn 集合：canonical 必须 exhausted。"""
    return _observed_turns(state, require_exhausted=True)


_RESULT_TERMINAL_STATUSES = {"completed", "failed", "interrupted", "cancelled"}
_RESULT_KNOWN_STATUSES = _RESULT_TERMINAL_STATUSES | {"inProgress"}


def _complete_result_turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    history = state.get("turnHistory")
    if not isinstance(history, dict) or history.get("kind") != "canonical":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    body = history.get("history")
    islands = body.get("islands") if isinstance(body, dict) else None
    entities = body.get("entitiesByKey") if isinstance(body, dict) else None
    if not isinstance(islands, list) or not islands or not isinstance(entities, dict):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    newest = islands[-1]
    if (not isinstance(newest, dict) or not isinstance(newest.get("newerBoundary"), dict)
            or newest["newerBoundary"].get("status") != "exhausted"):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    turns: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    seen_ids: set[str] = set()
    for island in islands:
        entries = island.get("entries") if isinstance(island, dict) else None
        if not isinstance(entries, list) or not entries:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        for entry in entries:
            key = entry.get("value") if isinstance(entry, dict) else None
            item = entities.get(key) if isinstance(key, str) else None
            turn_id = _uuid(item.get("turnId")) if isinstance(item, dict) else None
            if (key in seen_keys or turn_id is None or turn_id in seen_ids
                    or item.get("status") not in _RESULT_KNOWN_STATUSES):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            seen_keys.add(key)
            seen_ids.add(turn_id)
            turns.append(item)
    return turns


_NATIVE_CONTINUATION_TRIGGER = "capacity_retry_automatic"
_NATIVE_CONTINUATION_PREDECESSOR_STATUSES = {
    "capacity_retry_automatic": {"failed", "interrupted"},
    "resume_interrupted_task": {"interrupted"},
}


def _native_successor(turn: dict[str, Any], target: dict[str, str]) -> str:
    params = turn.get("params")
    items = turn.get("items")
    if not isinstance(params, dict) or not isinstance(items, list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    raw_input = params.get("input")
    trigger = params.get("turnTrigger")
    if (not isinstance(trigger, str) or trigger not in _NATIVE_CONTINUATION_PREDECESSOR_STATUSES
            or ("input" in params and (not isinstance(raw_input, list) or raw_input))):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if params.get("threadId") not in {None, target["threadId"]}:
        raise _error("DESKTOP_TARGET_NOT_FOUND")
    if any(not isinstance(item, dict) for item in items):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if any(item.get("type") == "userMessage" for item in items):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return trigger


def _native_continuation_edge(
    predecessor: dict[str, Any], successor: dict[str, Any], target: dict[str, str], *, strict_items: bool = False,
) -> str:
    if strict_items:
        items = successor.get("items")
        if (not isinstance(items, list) or any(
                not isinstance(item, dict)
                or item.get("type") not in RESULT_ACTIVITY_ITEM_TYPES | {"toolResult"}
                for item in items)):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    trigger = _native_successor(successor, target)
    if predecessor.get("status") not in _NATIVE_CONTINUATION_PREDECESSOR_STATUSES[trigger]:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return trigger


def _turn_text_for_reconciliation(turn: dict[str, Any]) -> str | None:
    params = turn.get("params")
    raw_input = params.get("input") if isinstance(params, dict) else None
    items = turn.get("items")
    if not isinstance(params, dict) or not isinstance(raw_input, list) or not isinstance(items, list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    # C2C wire sends exactly one input. A multi-input composer turn is
    # therefore known non-C2C history, not malformed state：Desktop 物化
    # 一次 composer 提交时，items 里的 userMessage 可能不再镜像 params.input
    # （实测 inputLen=2 而 userMessage=1），因此 skip 必须先于镜像检查。
    if len(raw_input) > 1:
        if (any(not isinstance(item, dict) for item in raw_input)
                or any(not isinstance(item, dict) for item in items)):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        return None
    user_messages = [item for item in items if isinstance(item, dict) and item.get("type") == "userMessage"]
    if len(user_messages) != 1 or user_messages[0].get("content") != raw_input:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if len(raw_input) == 0:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    item = raw_input[0]
    if (not isinstance(item, dict) or set(item) != {"type", "text", "text_elements"}
            or item.get("type") != "text" or item.get("text_elements") != []):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    text = item.get("text")
    if not isinstance(text, str):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    try:
        text.encode("utf-8", "strict")
    except UnicodeEncodeError:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return text


def _assert_post_start_target(state: dict[str, Any], target: dict[str, str]) -> None:
    """post-start 每份 observation（含第一份）都必须仍指向绑定 target。"""
    if state.get("id") != target["threadId"] or state.get("hostId") != target["hostId"]:
        raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)


def _verify_live_ack_turn(state: dict[str, Any], turn_id: str, message: str) -> Literal["pending", "verified", "invalid"]:
    """独立于 terminal reconciliation 的 post-start tri-state verifier。"""
    history = state.get("turnHistory")
    if not isinstance(history, dict) or history.get("kind") != "canonical":
        return "invalid"
    try:
        turns = _observed_turns(state, require_exhausted=False)
    except (DesktopIpcError, TypeError):
        return "invalid"
    occurrences = [turn for turn in turns if turn.get("turnId") == turn_id]
    if len(occurrences) > 1:
        return "invalid"
    if not occurrences:
        return "pending"

    turn = occurrences[0]
    status = turn.get("status")
    if not isinstance(status, str) or status not in {"inProgress", "completed", "failed", "interrupted", "cancelled"}:
        return "invalid"
    in_progress = status == "inProgress"

    params = turn.get("params")
    raw_input = params.get("input") if isinstance(params, dict) else None
    if not isinstance(raw_input, list) or len(raw_input) != 1:
        return "invalid"
    input_item = raw_input[0]
    if (not isinstance(input_item, dict) or set(input_item) != {"type", "text", "text_elements"}
            or input_item.get("type") != "text" or input_item.get("text_elements") != []
            or not isinstance(input_item.get("text"), str)):
        return "invalid"
    input_text = input_item["text"]
    try:
        input_text.encode("utf-8", "strict")
    except UnicodeEncodeError:
        return "invalid"
    # params.input 已完整可读；任何正文差异都是矛盾，不能等待镜像补齐。
    if input_text != message:
        return "invalid"

    def pending_or_invalid() -> Literal["pending", "invalid"]:
        return "pending" if in_progress else "invalid"

    if "items" not in turn:
        return pending_or_invalid()
    items = turn["items"]
    if not isinstance(items, list):
        return "invalid"
    user_messages: list[dict[str, Any]] = []
    for item in items:
        item_type = item.get("type") if isinstance(item, dict) else None
        if not isinstance(item_type, str) or item_type not in RESULT_ACTIVITY_ITEM_TYPES:
            return "invalid"
        if item_type == "userMessage":
            user_messages.append(item)
    if len(user_messages) > 1:
        return "invalid"
    if not user_messages:
        return pending_or_invalid()

    user_message = user_messages[0]
    if "content" not in user_message:
        return pending_or_invalid()
    content = user_message["content"]
    if not isinstance(content, list):
        return "invalid"
    if not content:
        return pending_or_invalid()
    if len(content) != 1:
        return "invalid"
    content_item = content[0]
    if not isinstance(content_item, dict):
        return "invalid"
    expected_keys = {"type", "text", "text_elements"}
    if (set(content_item) - expected_keys or content_item.get("type") != "text"
            or ("text" in content_item and not isinstance(content_item["text"], str))
            or ("text_elements" in content_item and content_item["text_elements"] != [])):
        return "invalid"
    if "text" in content_item:
        try:
            content_item["text"].encode("utf-8", "strict")
        except UnicodeEncodeError:
            return "invalid"
        if content_item["text"] != input_text:
            return "invalid"
    if set(content_item) != expected_keys:
        return pending_or_invalid()
    return "verified" if content_item == input_item else "invalid"
