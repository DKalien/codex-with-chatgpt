"""Desktop IPC helper 的共享错误、边界和输入校验。"""

from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any


PIPE_NAME = r"\\.\pipe\codex-ipc"
MAX_MESSAGE_BYTES = 64 * 1024
MAX_OUTBOUND_FRAME_BYTES = 16 * 1024 * 1024
MAX_INBOUND_FRAME_BYTES = 32 * 1024 * 1024
MAX_FRAME_BYTES = MAX_OUTBOUND_FRAME_BYTES
MAX_PIPE_READ_BYTES = 1024 * 1024
MAX_CONTROL_LINE_BYTES = 512 * 1024
WRITE_TIMEOUT_SECONDS = 5.0
INITIALIZE_TIMEOUT_SECONDS = 5.0
DISCOVERY_TIMEOUT_SECONDS = 5.0
SNAPSHOT_TIMEOUT_SECONDS = 5.0
SEND_TIMEOUT_SECONDS = 30.0
MAX_OBSERVATION_AGE_SECONDS = 2.0
POST_START_STATE_DEADLINE_SECONDS = 30.0
MAX_RESULT_OWNERSHIP_CHAIN = 8
MAX_RESULT_ACTIVITY_ITEMS = 4096
MIN_PYTHON_VERSION = (3, 11)
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")

REQUEST_VERSIONS = {
    "initialize": 0,
    "thread-owner-discovery": 1,
    "thread-follower-start-turn": 2,
}


class DesktopIpcError(RuntimeError):
    """内部 helper 错误；``not_sent`` 供 Node 侧区分提交点前后。"""

    def __init__(self, code: str, message: str, *, not_sent: bool = True):
        super().__init__(message)
        self.code = code
        self.not_sent = not_sent


ERROR_MESSAGES = {
    "DESKTOP_UNSUPPORTED_PLATFORM": "当前平台不支持 Desktop Control。",
    "DESKTOP_TOKEN_UNVERIFIED": "当前进程权限无法安全确认；已拒绝 Desktop 投递。",
    "DESKTOP_ELEVATED": "当前进程为提升权限；为避免跨权限 IPC，已拒绝 Desktop 投递。",
    "DESKTOP_TOKEN_INTEGRITY": "当前进程完整性级别不符合 Desktop 投递要求。",
    "DESKTOP_IPC_UNAVAILABLE": "Codex Desktop 当前不可用；没有发送消息。",
    "DESKTOP_IPC_SERVER_MISMATCH": "Desktop IPC 服务端身份不匹配；没有发送消息。",
    "DESKTOP_PROCESS_CHANGED": "Desktop/app-server 进程已变化；没有发送消息。",
    "DESKTOP_PROJECT_MISMATCH": "Desktop 会话项目或实际目录与绑定不匹配；没有发送消息。",
    "DESKTOP_TARGET_NOT_FOUND": "找不到绑定的 Desktop 会话；没有发送消息。",
    "DESKTOP_NO_OWNER": "绑定会话没有可确认的 Desktop owner；没有发送消息。",
    "DESKTOP_OWNER_CHANGED": "Desktop 会话 owner 已变化；没有发送消息。",
    "DESKTOP_BUSY": "Desktop 会话当前忙；没有发送消息。",
    "DESKTOP_APPROVAL_PENDING": "Desktop 会话有待处理审批或用户输入；没有发送消息。",
    "DESKTOP_STATE_UNAVAILABLE": "Desktop 会话状态无法安全确认；没有发送消息。",
    "DESKTOP_IPC_TIMEOUT": "Desktop IPC 接受回执超时；没有发送消息。",
    "DESKTOP_IPC_REJECTED": "Desktop 拒绝了投递；结果无法作为成功确认。",
    "DESKTOP_OUTCOME_UNKNOWN": "Desktop 投递结果不明，消息可能已执行；不要重发。",
    "DESKTOP_PROTOCOL_ERROR": "Desktop 协议无法安全确认；没有发送消息。",
    "DESKTOP_INTERNAL_ERROR": "Desktop Control 暂时不可用；没有发送消息。",
    "DESKTOP_INVALID_REQUEST": "Desktop Control 请求格式无效；没有发送消息。",
    "DESKTOP_MESSAGE_TOO_LARGE": "消息超过 64 KiB UTF-8 上限；拒绝投递，不截断。",
    "DESKTOP_PYTHON_UNSUPPORTED": "运行 Desktop IPC helper 需要 Python 3.11 或更高版本；没有发送消息。",
    "DESKTOP_CURRENT_CONTEXT_INVALID": "当前 Codex 上下文或 Desktop 会话身份无法安全确认；没有发送消息。",
    "DESKTOP_CONFIRMATION_CANCELLED": "本机确认被取消或未完成；没有发送消息。",
    "DESKTOP_RECONCILIATION_CONFLICT": "Desktop 历史无法唯一核对；未恢复结果或修改投递状态。",
}

RESULT_ACTIVITY_ITEM_TYPES = frozenset({
    "userMessage", "reasoning", "agentMessage", "commandExecution", "subAgentActivity",
    "collabAgentToolCall", "error", "modelChanged", "contextCompaction", "fileChange",
    "hookPrompt", "functionCallOutput", "plan", "mcpToolCall", "dynamicToolCall",
    "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode",
})
RESULT_ACTIVITY_EPILOGUE_ITEM_TYPES = frozenset({"reasoning", "agentMessage"})
_RESULT_ACTIVITY_ITEM_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
CONFIRMATION_CAPTION = "确认绑定当前 Codex Desktop 会话"
CONFIRMATION_RISK_TEXT = (
    "确认后将把当前 Desktop 会话绑定到此工作区并启用任务投递。"
    "通过该会话执行的任务可能按其现有权限修改文件或执行命令。"
)


def _error(code: str, *, not_sent: bool = True) -> DesktopIpcError:
    return DesktopIpcError(code, ERROR_MESSAGES.get(code, ERROR_MESSAGES["DESKTOP_INTERNAL_ERROR"]), not_sent=not_sent)


def _require(condition: bool, code: str, *, not_sent: bool = True) -> None:
    if not condition:
        raise _error(code, not_sent=not_sent)


def _uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return None
    return value if str(parsed) == value else None


def _normalize_path(value: str | os.PathLike[str]) -> str:
    text = os.fspath(value)
    if isinstance(text, bytes):
        text = os.fsdecode(text)
    return os.path.normcase(os.path.normpath(os.path.realpath(os.path.abspath(text))))


def _target(value: Any) -> dict[str, str]:
    _require(isinstance(value, dict), "DESKTOP_INVALID_REQUEST")
    if set(value) != {"threadId", "hostId", "projectId", "workspaceRoot"}:
        raise _error("DESKTOP_INVALID_REQUEST")
    thread_id = _uuid(value.get("threadId"))
    _require(thread_id is not None, "DESKTOP_INVALID_REQUEST")
    _require(value.get("hostId") == "local", "DESKTOP_INVALID_REQUEST")
    project_id = value.get("projectId")
    workspace_root = value.get("workspaceRoot")
    _require(isinstance(project_id, str) and 0 < len(project_id) <= 128, "DESKTOP_INVALID_REQUEST")
    _require(isinstance(workspace_root, str) and bool(workspace_root.strip()), "DESKTOP_INVALID_REQUEST")
    return {"threadId": thread_id, "hostId": "local", "projectId": project_id, "workspaceRoot": workspace_root}


def _message(value: Any) -> str:
    _require(isinstance(value, str) and bool(value), "DESKTOP_INVALID_REQUEST", not_sent=True)
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        raise _error("DESKTOP_INVALID_REQUEST")
    if len(encoded) > MAX_MESSAGE_BYTES:
        raise _error("DESKTOP_MESSAGE_TOO_LARGE")
    return value


def _json_bytes(value: object) -> bytes:
    try:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "strict")
    except (TypeError, UnicodeEncodeError, ValueError):
        raise _error("DESKTOP_PROTOCOL_ERROR")
    if len(payload) > MAX_OUTBOUND_FRAME_BYTES:
        raise _error("DESKTOP_PROTOCOL_ERROR")
    return payload
