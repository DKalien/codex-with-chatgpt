"""Codex Desktop Control 的受控 Windows IPC helper。

这个程序只接受 stdin 上的固定操作：``inspect``、``prepare``、``send``、
``reconcile_unknown``、``diagnose``、``current_identity``、``current_confirm``、``current_execution``、
``inspect_result_context``、``inspect_result_activity_marker``、``inspect_result_terminal_fence``、
``current_result_context``、``current_result_classification`` 和 ``current_result_ownership``。
其中 ``current_*`` 只接受
顶层 ``workspaceRoot``，从继承的当前 Agent 环境解析 thread/project/host；
它不会接受 stdin 提供的目标身份，也不会执行 stdin 提供的命令或启动
Desktop、router、app-server。named pipe 帧与请求版本来自
NathanZane/codex-mobile 的 CodexDesktopIpcClient（固定 commit 见
``third_party/codex-mobile``）。
"""

from __future__ import annotations

import atexit
import copy
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import time
import unicodedata
import uuid
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any, Literal


PIPE_NAME = r"\\.\pipe\codex-ipc"
MAX_MESSAGE_BYTES = 64 * 1024
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_PIPE_READ_BYTES = 1024 * 1024
MAX_CONTROL_LINE_BYTES = 512 * 1024
WRITE_TIMEOUT_SECONDS = 5.0
INITIALIZE_TIMEOUT_SECONDS = 5.0
DISCOVERY_TIMEOUT_SECONDS = 5.0
SNAPSHOT_TIMEOUT_SECONDS = 5.0
SEND_TIMEOUT_SECONDS = 30.0
MAX_OBSERVATION_AGE_SECONDS = 2.0
# ACK 后等待 canonical state 出现 ACK turn 的有界 deadline；只轮询 state，绝不重发 start-turn。
POST_START_STATE_DEADLINE_SECONDS = 30.0
MAX_RESULT_OWNERSHIP_CHAIN = 8
MAX_RESULT_ACTIVITY_ITEMS = 4096
MIN_PYTHON_VERSION = (3, 11)
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")

# R2 起 compatibility trust 体系已移除：Desktop 是否可用由 live 行为决定，
# 不再由 Desktop 版本、app-server hash、ASAR、catalog 或 semantic fingerprint 决定。



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

# live canonical state 与生成协议中已确认的完整 item type 集合。未知 type
# 无法安全投影为有序 activity fence，必须 fail closed。
RESULT_ACTIVITY_ITEM_TYPES = frozenset({
    "userMessage", "reasoning", "agentMessage", "commandExecution", "subAgentActivity",
    "collabAgentToolCall", "error", "modelChanged", "contextCompaction", "fileChange",
    "hookPrompt", "functionCallOutput", "plan", "mcpToolCall", "dynamicToolCall",
    "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode",
})
# Only the observed terminal epilogue is harmless after the record marker.
# Keep this deliberately narrower than the complete canonical item set.
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
    return {
        "threadId": thread_id,
        "hostId": "local",
        "projectId": project_id,
        "workspaceRoot": workspace_root,
    }


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
    if len(payload) > MAX_FRAME_BYTES:
        raise _error("DESKTOP_PROTOCOL_ERROR")
    return payload


def _frame(value: object) -> bytes:
    payload = _json_bytes(value)
    return struct.pack("<I", len(payload)) + payload


class _Decoder:
    def __init__(self) -> None:
        self.data = bytearray()

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        self.data.extend(data)
        result: list[dict[str, Any]] = []
        while len(self.data) >= 4:
            size = struct.unpack_from("<I", self.data)[0]
            if not 0 < size <= MAX_FRAME_BYTES:
                raise _error("DESKTOP_PROTOCOL_ERROR")
            if len(self.data) < size + 4:
                break
            raw = bytes(self.data[4 : 4 + size])
            del self.data[: 4 + size]
            try:
                value = json.loads(raw.decode("utf-8", "strict"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise _error("DESKTOP_PROTOCOL_ERROR")
            if not isinstance(value, dict):
                raise _error("DESKTOP_PROTOCOL_ERROR")
            result.append(value)
        return result


# ---- Windows named pipe transport ----------------------------------------

_HANDLE = ctypes.c_void_p
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
ERROR_BROKEN_PIPE = 109
ERROR_MORE_DATA = 234
ERROR_IO_PENDING = 997
ERROR_OPERATION_ABORTED = 995
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_NO_DATA = 232
ERROR_INSUFFICIENT_BUFFER = 122
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x102
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
READ_CONTROL = 0x00020000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_void_p),
        ("InternalHigh", ctypes.c_void_p),
        ("Offset", wintypes.DWORD),
        ("OffsetHigh", wintypes.DWORD),
        ("hEvent", _HANDLE),
    ]


_PENDING_IO: list[tuple[_HANDLE, _Overlapped, ctypes.Array[ctypes.c_char]]] = []

if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.GetCurrentProcess.argtypes = []
    _kernel32.GetCurrentProcess.restype = _HANDLE
    _kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                      wintypes.DWORD, wintypes.DWORD, _HANDLE]
    _kernel32.CreateFileW.restype = _HANDLE
    _kernel32.CloseHandle.argtypes = [_HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _kernel32.CreateToolhelp32Snapshot.restype = _HANDLE
    _kernel32.Process32FirstW.argtypes = [_HANDLE, ctypes.c_void_p]
    _kernel32.Process32FirstW.restype = wintypes.BOOL
    _kernel32.Process32NextW.argtypes = [_HANDLE, ctypes.c_void_p]
    _kernel32.Process32NextW.restype = wintypes.BOOL
    _kernel32.GetProcessTimes.argtypes = [_HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    _kernel32.GetProcessTimes.restype = wintypes.BOOL
    _kernel32.GetNamedPipeServerProcessId.argtypes = [_HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _kernel32.GetNamedPipeServerProcessId.restype = wintypes.BOOL
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.OpenProcess.restype = _HANDLE
    _kernel32.QueryFullProcessImageNameW.argtypes = [_HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                     ctypes.POINTER(wintypes.DWORD)]
    _kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    _kernel32.CreateEventW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    _kernel32.CreateEventW.restype = _HANDLE
    _kernel32.WaitForSingleObject.argtypes = [_HANDLE, wintypes.DWORD]
    _kernel32.WaitForSingleObject.restype = wintypes.DWORD
    _kernel32.WriteFile.argtypes = [_HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                    ctypes.POINTER(_Overlapped)]
    _kernel32.WriteFile.restype = wintypes.BOOL
    _kernel32.ReadFile.argtypes = [_HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                   ctypes.POINTER(_Overlapped)]
    _kernel32.ReadFile.restype = wintypes.BOOL
    _kernel32.GetOverlappedResult.argtypes = [_HANDLE, ctypes.POINTER(_Overlapped), ctypes.POINTER(wintypes.DWORD),
                                              wintypes.BOOL]
    _kernel32.GetOverlappedResult.restype = wintypes.BOOL
    _kernel32.CancelIoEx.argtypes = [_HANDLE, ctypes.POINTER(_Overlapped)]
    _kernel32.CancelIoEx.restype = wintypes.BOOL
    _kernel32.PeekNamedPipe.argtypes = [_HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
    _kernel32.PeekNamedPipe.restype = wintypes.BOOL
else:
    _kernel32 = None


def _win_error(code: int | None = None) -> OSError:
    value = ctypes.get_last_error() if code is None else code
    try:
        detail = ctypes.FormatError(value)
    except (AttributeError, OSError):
        detail = "未知 Win32 错误"
    return OSError(value, detail)


def _handle_value(handle: object) -> int:
    value = getattr(handle, "value", handle)
    return int(value or 0)


def _valid_handle(handle: object) -> bool:
    return _handle_value(handle) not in (0, -1, _INVALID_HANDLE_VALUE)


def _query_image_path(process: _HANDLE) -> str:
    size = 32 * 1024
    while size <= 1024 * 1024:
        buffer = ctypes.create_unicode_buffer(size)
        length = wintypes.DWORD(size)
        if _kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
            return buffer.value
        if ctypes.get_last_error() != ERROR_INSUFFICIENT_BUFFER:
            raise _win_error()
        size *= 2
    raise OSError("process image path is too long")


class _Pipe:
    """打开既有 pipe；每次写入前重新核对同一 handle 的 server 身份。"""

    def __init__(self) -> None:
        if os.name != "nt" or _kernel32 is None:
            raise _error("DESKTOP_UNSUPPORTED_PLATFORM")
        self.handle: _HANDLE | None = None
        self.server_pid = 0
        self.server_exe = ""
        try:
            handle = _kernel32.CreateFileW(
                PIPE_NAME,
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                0,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            )
            if not _valid_handle(handle):
                raise _win_error()
            self.handle = handle
            self.server_pid, self.server_exe = self._server_identity()
        except DesktopIpcError:
            self.close()
            raise
        except (OSError, ctypes.ArgumentError, ValueError):
            self.close()
            raise _error("DESKTOP_IPC_UNAVAILABLE")

    def _require_handle(self) -> _HANDLE:
        if self.handle is None or not _valid_handle(self.handle):
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        return self.handle

    def _server_identity(self) -> tuple[int, str]:
        handle = self._require_handle()
        pid = wintypes.DWORD()
        if not _kernel32.GetNamedPipeServerProcessId(handle, ctypes.byref(pid)) or pid.value <= 0:
            raise _error("DESKTOP_IPC_SERVER_MISMATCH")
        process = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not _valid_handle(process):
            raise _error("DESKTOP_IPC_SERVER_MISMATCH")
        try:
            exe = _query_image_path(process)
        except (OSError, ctypes.ArgumentError, ValueError):
            raise _error("DESKTOP_IPC_SERVER_MISMATCH")
        finally:
            _kernel32.CloseHandle(process)
        return int(pid.value), exe

    def verify_server(self) -> None:
        pid, exe = self._server_identity()
        if pid != self.server_pid or _normalize_path(exe) != _normalize_path(self.server_exe):
            raise _error("DESKTOP_PROCESS_CHANGED")

    @staticmethod
    def _wait_ms(seconds: float) -> int:
        return max(0, min(0xFFFFFFFF, int(math.ceil(seconds * 1000))))

    def _cancel(self, overlapped: _Overlapped, event: _HANDLE, buffer: ctypes.Array[ctypes.c_char]) -> None:
        handle = self.handle
        if handle is not None and _valid_handle(handle):
            _kernel32.CancelIoEx(handle, ctypes.byref(overlapped))
        result = _kernel32.WaitForSingleObject(event, 1000)
        if result != WAIT_OBJECT_0:
            _PENDING_IO.append((event, overlapped, buffer))
            self.close()

    def write(self, data: bytes) -> None:
        self.verify_server()
        if not isinstance(data, bytes) or len(data) > MAX_FRAME_BYTES + 4:
            raise _error("DESKTOP_PROTOCOL_ERROR")
        handle = self._require_handle()
        event = _kernel32.CreateEventW(None, True, False, None)
        if not _valid_handle(event):
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        overlapped = _Overlapped()
        overlapped.hEvent = event
        written = wintypes.DWORD()
        buffer: ctypes.Array[ctypes.c_char] | None = None
        in_flight = False
        try:
            buffer = ctypes.create_string_buffer(data, len(data))
            in_flight = True
            if _kernel32.WriteFile(handle, buffer, len(data), ctypes.byref(written), ctypes.byref(overlapped)):
                in_flight = False
            else:
                code = ctypes.get_last_error()
                if code != ERROR_IO_PENDING:
                    in_flight = False
                    raise _win_error(code)
                result = _kernel32.WaitForSingleObject(event, self._wait_ms(WRITE_TIMEOUT_SECONDS))
                if result == WAIT_TIMEOUT:
                    self._cancel(overlapped, event, buffer)
                    raise _error("DESKTOP_IPC_TIMEOUT")
                if result != WAIT_OBJECT_0:
                    self._cancel(overlapped, event, buffer)
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                if not _kernel32.GetOverlappedResult(handle, ctypes.byref(overlapped), ctypes.byref(written), False):
                    code = ctypes.get_last_error()
                    self._cancel(overlapped, event, buffer) if code == ERROR_OPERATION_ABORTED else None
                    raise _win_error(code)
                in_flight = False
            if written.value != len(data):
                raise _error("DESKTOP_IPC_UNAVAILABLE")
        except DesktopIpcError:
            raise
        except (OSError, ctypes.ArgumentError, ValueError):
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        finally:
            if in_flight and buffer is not None and not any(item[0] is event for item in _PENDING_IO):
                self._cancel(overlapped, event, buffer)
            if not any(item[0] is event for item in _PENDING_IO):
                _kernel32.CloseHandle(event)

    def read(self, timeout: float) -> bytes:
        if timeout < 0 or not math.isfinite(timeout):
            raise _error("DESKTOP_PROTOCOL_ERROR")
        handle = self._require_handle()
        deadline = time.monotonic() + timeout
        while True:
            available = wintypes.DWORD()
            if not _kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                code = ctypes.get_last_error()
                if code in (ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA):
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                raise _win_error(code)
            if available.value:
                # available 是当前 backlog 字节数，不是下一帧长度；由 Decoder 检查单帧上限。
                return self._read_available(min(int(available.value), MAX_PIPE_READ_BYTES), deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            time.sleep(min(0.01, remaining))

    def _read_available(self, size: int, deadline: float) -> bytes:
        handle = self._require_handle()
        event = _kernel32.CreateEventW(None, True, False, None)
        if not _valid_handle(event):
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        overlapped = _Overlapped()
        overlapped.hEvent = event
        read = wintypes.DWORD()
        buffer: ctypes.Array[ctypes.c_char] | None = None
        in_flight = False
        try:
            buffer = ctypes.create_string_buffer(size)
            in_flight = True
            if _kernel32.ReadFile(handle, buffer, size, ctypes.byref(read), ctypes.byref(overlapped)):
                in_flight = False
                return buffer.raw[: read.value]
            code = ctypes.get_last_error()
            if code != ERROR_IO_PENDING:
                in_flight = False
                if code == ERROR_BROKEN_PIPE:
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                if code == ERROR_MORE_DATA:
                    return buffer.raw[: read.value]
                raise _win_error(code)
            remaining = deadline - time.monotonic()
            result = _kernel32.WaitForSingleObject(event, self._wait_ms(max(0.0, remaining)))
            if result == WAIT_TIMEOUT:
                self._cancel(overlapped, event, buffer)
                raise TimeoutError
            if result != WAIT_OBJECT_0:
                self._cancel(overlapped, event, buffer)
                raise _error("DESKTOP_IPC_UNAVAILABLE")
            if not _kernel32.GetOverlappedResult(handle, ctypes.byref(overlapped), ctypes.byref(read), False):
                code = ctypes.get_last_error()
                if code in (ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA):
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                if code != ERROR_MORE_DATA:
                    raise _win_error(code)
            in_flight = False
            return buffer.raw[: read.value]
        except DesktopIpcError:
            raise
        except TimeoutError:
            raise
        except (OSError, ctypes.ArgumentError, ValueError):
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        finally:
            if in_flight and buffer is not None and not any(item[0] is event for item in _PENDING_IO):
                self._cancel(overlapped, event, buffer)
            if not any(item[0] is event for item in _PENDING_IO):
                _kernel32.CloseHandle(event)

    def close(self) -> None:
        handle = self.handle
        self.handle = None
        if handle is not None and _valid_handle(handle) and _kernel32 is not None:
            _kernel32.CloseHandle(handle)


@atexit.register
def _protect_pending_io() -> None:
    if os.name == "nt" and _kernel32 is not None:
        if any(_kernel32.WaitForSingleObject(item[0], 0) != WAIT_OBJECT_0 for item in _PENDING_IO):
            os._exit(3)


# ---- current-token and process identity checks ---------------------------

TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20
TOKEN_ELEVATION_TYPE = 18
TOKEN_INTEGRITY_LEVEL = 25
ELEVATION_TYPE_DEFAULT = 1
ELEVATION_TYPE_FULL = 2
ELEVATION_TYPE_LIMITED = 3
SECURITY_MANDATORY_MEDIUM_RID = 0x2000
SECURITY_MANDATORY_LABEL_AUTHORITY = 16


class _TokenElevation(ctypes.Structure):
    _fields_ = [("TokenIsElevated", wintypes.DWORD)]


class _SidAndAttributes(ctypes.Structure):
    _fields_ = [("Sid", _HANDLE), ("Attributes", wintypes.DWORD)]


class _TokenMandatoryLabel(ctypes.Structure):
    _fields_ = [("Label", _SidAndAttributes)]


def _token_information(token: _HANDLE, info_class: int) -> ctypes.Array[ctypes.c_char]:
    if _kernel32 is None:
        raise RuntimeError
    # advapi32 is loaded lazily so importing this file stays safe off Windows.
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.GetTokenInformation.argtypes = [
        _HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    required = wintypes.DWORD()
    advapi32.GetTokenInformation(token, info_class, None, 0, ctypes.byref(required))
    if not 0 < required.value <= 1024 * 1024:
        raise RuntimeError
    buffer = ctypes.create_string_buffer(required.value)
    returned = wintypes.DWORD()
    if not advapi32.GetTokenInformation(token, info_class, buffer, required.value, ctypes.byref(returned)):
        raise RuntimeError
    if returned.value > required.value:
        raise RuntimeError
    return buffer


def _query_standard_token() -> str:
    if os.name != "nt" or _kernel32 is None:
        raise _error("DESKTOP_TOKEN_UNVERIFIED")
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.OpenProcessToken.argtypes = [_HANDLE, wintypes.DWORD, ctypes.POINTER(_HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    token = _HANDLE()
    process = _kernel32.GetCurrentProcess()
    if not advapi32.OpenProcessToken(process, TOKEN_QUERY, ctypes.byref(token)) or not _valid_handle(token):
        raise _error("DESKTOP_TOKEN_UNVERIFIED")
    try:
        elevated = bool(_TokenElevation.from_buffer_copy(_token_information(token, TOKEN_ELEVATION)).TokenIsElevated)
        if elevated:
            raise _error("DESKTOP_ELEVATED")
        integrity = _token_information(token, TOKEN_INTEGRITY_LEVEL)
        if len(integrity) < ctypes.sizeof(_TokenMandatoryLabel):
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        label = _TokenMandatoryLabel.from_buffer_copy(integrity)
        sid_address = _handle_value(label.Label.Sid)
        start = ctypes.addressof(integrity)
        end = start + ctypes.sizeof(integrity)
        if not start <= sid_address <= end - 8:
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        header = ctypes.string_at(sid_address, 8)
        revision, count = header[0], header[1]
        sid_size = 8 + 4 * count
        if revision != 1 or not 1 <= count <= 15 or sid_address + sid_size > end:
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        if int.from_bytes(header[2:8], "big") != SECURITY_MANDATORY_LABEL_AUTHORITY:
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        rid = int.from_bytes(ctypes.string_at(sid_address + sid_size - 4, 4), "little")
        if rid != SECURITY_MANDATORY_MEDIUM_RID:
            raise _error("DESKTOP_TOKEN_INTEGRITY")
        try:
            elevation_type = int(wintypes.DWORD.from_buffer_copy(_token_information(token, TOKEN_ELEVATION_TYPE)).value)
        except RuntimeError:
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        if elevation_type not in {ELEVATION_TYPE_DEFAULT, ELEVATION_TYPE_FULL, ELEVATION_TYPE_LIMITED}:
            raise _error("DESKTOP_TOKEN_UNVERIFIED")
        if elevation_type == ELEVATION_TYPE_FULL:
            raise _error("DESKTOP_ELEVATED")
    except DesktopIpcError:
        raise
    except (RuntimeError, OSError, ValueError, ctypes.ArgumentError):
        raise _error("DESKTOP_TOKEN_UNVERIFIED")
    finally:
        _kernel32.CloseHandle(token)


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class _FileTime(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


def _creation_time(process: _HANDLE) -> int:
    created, exited, kernel, user = (_FileTime(), _FileTime(), _FileTime(), _FileTime())
    if _kernel32 is None or not _kernel32.GetProcessTimes(
        process, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)
    ):
        return 0
    return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)


def _processes() -> list[dict[str, Any]]:
    if os.name != "nt" or _kernel32 is None:
        raise _error("DESKTOP_UNSUPPORTED_PLATFORM")
    snapshot = _kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if not _valid_handle(snapshot):
        raise _error("DESKTOP_IPC_UNAVAILABLE")
    _kernel32.Process32FirstW.argtypes = [_HANDLE, ctypes.POINTER(_ProcessEntry)]
    _kernel32.Process32FirstW.restype = wintypes.BOOL
    _kernel32.Process32NextW.argtypes = [_HANDLE, ctypes.POINTER(_ProcessEntry)]
    _kernel32.Process32NextW.restype = wintypes.BOOL
    result: list[dict[str, Any]] = []
    try:
        entry = _ProcessEntry()
        entry.dwSize = ctypes.sizeof(_ProcessEntry)
        first = _kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while first:
            name = str(entry.szExeFile)
            if name.casefold() in {"chatgpt.exe", "codex.exe"}:
                pid = int(entry.th32ProcessID)
                parent = int(entry.th32ParentProcessID)
                process = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
                exe = ""
                creation = 0
                if _valid_handle(process):
                    try:
                        exe = _query_image_path(process)
                        creation = _creation_time(process)
                    except (OSError, ValueError, ctypes.ArgumentError):
                        exe = ""
                    finally:
                        _kernel32.CloseHandle(process)
                result.append({"pid": pid, "parentPid": parent, "name": name, "exe": exe, "creation": creation})
            first = _kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _kernel32.CloseHandle(snapshot)
    return result


def _process_parent_ids() -> dict[int, int]:
    """读取当前 Windows 进程树的 parent PID，不读取命令行或进程内存。"""
    if os.name != "nt" or _kernel32 is None:
        raise _error("DESKTOP_UNSUPPORTED_PLATFORM")
    snapshot = _kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if not _valid_handle(snapshot):
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    result: dict[int, int] = {}
    try:
        entry = _ProcessEntry()
        entry.dwSize = ctypes.sizeof(_ProcessEntry)
        first = _kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while first:
            pid = int(entry.th32ProcessID)
            parent = int(entry.th32ParentProcessID)
            if pid > 0 and parent > 0:
                result[pid] = parent
            first = _kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _kernel32.CloseHandle(snapshot)
    return result


def _verify_current_runner_ancestor(process: dict[str, Any]) -> None:
    expected = process.get("appServerPid")
    if type(expected) is not int or expected <= 0:
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    parents = _process_parent_ids()
    current = os.getpid()
    seen: set[int] = set()
    for _ in range(64):
        if current == expected:
            return
        if current in seen:
            break
        seen.add(current)
        parent = parents.get(current)
        if parent is None or parent == current:
            break
        current = parent
    raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")


def _global_state_path() -> Path:
    configured = os.environ.get("CODEX_HOME", "").strip()
    return Path(configured).expanduser() / ".codex-global-state.json" if configured else Path.home() / ".codex" / ".codex-global-state.json"


def _current_target(value: Any) -> dict[str, str]:
    """从 helper 自己继承的环境和 global state 解析当前 task 目标。

    stdin 只提供 workspaceRoot；thread/project/host 不接受外部覆盖。环境变量
    能防止普通请求把任意 thread 传入 helper，但不能对同权限本机代码伪造环境
    提供加密证明，调用方仍须把这里的检查视为 fail-closed 的最佳可验证边界。
    """
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    thread_id = _uuid(os.environ.get("CODEX_THREAD_ID"))
    if thread_id is None:
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    session_id = os.environ.get("CODEX_SESSION_ID")
    if session_id is not None and session_id != thread_id:
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    workspace_root = value
    try:
        state = json.loads(_global_state_path().read_text(encoding="utf-8"))
        assignments = state.get("thread-project-assignments") if isinstance(state, dict) else None
        assignment = assignments.get(thread_id) if isinstance(assignments, dict) else None
        if (not isinstance(assignment, dict) or set(assignment) != {"projectKind", "projectId"}
                or assignment.get("projectKind") != "local"):
            raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
        project_id = assignment.get("projectId")
        projects = state.get("local-projects") if isinstance(state, dict) else None
        project = projects.get(project_id) if isinstance(projects, dict) else None
        roots = project.get("rootPaths") if isinstance(project, dict) else None
        if (not isinstance(project_id, str) or not 0 < len(project_id) <= 128
                or not isinstance(roots, list) or len(roots) != 1 or not isinstance(roots[0], str)
                or not roots[0].strip() or _normalize_path(roots[0]) != _normalize_path(workspace_root)):
            raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    except DesktopIpcError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, AttributeError, TypeError, ValueError):
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    return {"threadId": thread_id, "hostId": "local", "projectId": project_id, "workspaceRoot": workspace_root}


def _verify_project(target: dict[str, str]) -> None:
    try:
        state = json.loads(_global_state_path().read_text(encoding="utf-8"))
        assignment = state.get("thread-project-assignments", {}).get(target["threadId"])
        project = state.get("local-projects", {}).get(target["projectId"])
        roots = project.get("rootPaths", []) if isinstance(project, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if assignment != {"projectKind": "local", "projectId": target["projectId"]}:
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if not isinstance(roots, list) or len(roots) != 1 or not isinstance(roots[0], str):
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if _normalize_path(roots[0]) != _normalize_path(target["workspaceRoot"]):
        raise _error("DESKTOP_PROJECT_MISMATCH")


def _verify_process_identity(pipe: _Pipe, target: dict[str, str], expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """核对当前 pipe 对端是唯一 ChatGPT Desktop 进程树；不读取版本或 bundle。"""
    pipe.verify_server()
    rows = _processes()
    server = next((row for row in rows if row["pid"] == pipe.server_pid), None)
    if not server or server["name"].casefold() != "chatgpt.exe" or not server["exe"] or server["creation"] <= 0:
        raise _error("DESKTOP_IPC_SERVER_MISMATCH")
    if _normalize_path(server["exe"]) != _normalize_path(pipe.server_exe):
        raise _error("DESKTOP_IPC_SERVER_MISMATCH")
    children = [row for row in rows if row["name"].casefold() == "codex.exe" and row["parentPid"] == pipe.server_pid]
    if len(children) != 1 or not children[0]["exe"] or children[0]["creation"] <= 0:
        raise _error("DESKTOP_PROCESS_CHANGED")
    app_server = children[0]
    if expected and (
        expected["desktopPid"] != pipe.server_pid
        or expected["appServerPid"] != app_server["pid"]
        or expected["desktopCreation"] != server["creation"]
        or expected["appServerCreation"] != app_server["creation"]
        or _normalize_path(expected["desktopExe"]) != _normalize_path(server["exe"])
        or _normalize_path(expected["appServerExe"]) != _normalize_path(app_server["exe"])
    ):
        raise _error("DESKTOP_PROCESS_CHANGED")
    _verify_project(target)
    return {
        "desktopPid": pipe.server_pid,
        "desktopExe": server["exe"],
        "desktopCreation": server["creation"],
        "appServerPid": app_server["pid"],
        "appServerExe": app_server["exe"],
        "appServerCreation": app_server["creation"],
    }


def _patch_state(state: dict[str, Any], patches: list[Any]) -> dict[str, Any]:
    result = copy.deepcopy(state)
    for patch in patches:
        if not isinstance(patch, dict) or patch.get("op") not in {"add", "remove", "replace"} or not isinstance(patch.get("path"), list):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        path = patch["path"]
        if not path:
            if patch["op"] != "replace" or not isinstance(patch.get("value"), dict):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            result = copy.deepcopy(patch["value"])
            continue
        parent: Any = result
        try:
            for segment in path[:-1]:
                if isinstance(parent, list):
                    if type(segment) is not int or not 0 <= segment < len(parent):
                        raise ValueError
                    parent = parent[segment]
                elif isinstance(parent, dict) and isinstance(segment, str):
                    parent = parent[segment]
                else:
                    raise ValueError
            key = path[-1]
            if isinstance(parent, list):
                if type(key) is not int or not 0 <= key <= len(parent):
                    raise ValueError
                if patch["op"] == "add":
                    parent.insert(key, copy.deepcopy(patch.get("value")))
                elif patch["op"] == "remove":
                    parent.pop(key)
                else:
                    parent[key] = copy.deepcopy(patch.get("value"))
            elif isinstance(parent, dict) and isinstance(key, str):
                if patch["op"] == "remove":
                    del parent[key]
                else:
                    parent[key] = copy.deepcopy(patch.get("value"))
            else:
                raise ValueError
        except (KeyError, IndexError, TypeError, ValueError):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    return result


class _IpcClient:
    def __init__(self, pipe: _Pipe, thread_id: str, host_id: str) -> None:
        self.pipe = pipe
        self.thread_id = thread_id
        self.host_id = host_id
        self.client_id = "initializing-client"
        self.owner: str | None = None
        self.decoder = _Decoder()
        self.responses: dict[str, dict[str, Any]] = {}
        self.states: dict[str, tuple[dict[str, Any], int, float]] = {}
        self.snapshot_serial = 0
        self.snapshot_meta: dict[str, tuple[int, float]] = {}
        self.following_changed_sent = False
        self.state_change_kind: str | None = None

    def _envelope(self, method: str, params: dict[str, Any], target: str | None = None) -> dict[str, Any]:
        if method not in REQUEST_VERSIONS:
            raise _error("DESKTOP_PROTOCOL_ERROR")
        value: dict[str, Any] = {
            "type": "request",
            "requestId": str(uuid.uuid4()),
            "sourceClientId": self.client_id,
            "version": REQUEST_VERSIONS[method],
            "method": method,
            "params": params,
        }
        if target:
            value["targetClientId"] = target
        return value

    def _handle(self, value: dict[str, Any]) -> None:
        if value.get("type") == "response":
            request_id = value.get("requestId")
            if isinstance(request_id, str):
                self.responses[request_id] = value
            return
        if value.get("type") == "client-discovery-request":
            request_id = value.get("requestId")
            if isinstance(request_id, str):
                self.pipe.write(_frame({
                    "type": "client-discovery-response",
                    "requestId": request_id,
                    "response": {"canHandle": False},
                }))
            return
        if value.get("type") != "broadcast":
            return
        method = value.get("method")
        if method == "ipc-connection-reset":
            raise _error("DESKTOP_IPC_UNAVAILABLE")
        if method == "client-status-changed":
            params = value.get("params")
            if isinstance(params, dict) and self.owner and params.get("clientId") == self.owner and params.get("status") == "disconnected":
                raise _error("DESKTOP_OWNER_CHANGED")
            return
        if method != "thread-stream-state-changed":
            return
        if value.get("version") != 11:
            raise _error("DESKTOP_PROTOCOL_ERROR")
        params = value.get("params")
        if not isinstance(params, dict) or params.get("conversationId") != self.thread_id or params.get("hostId") != self.host_id:
            return
        source = value.get("sourceClientId")
        change = params.get("change")
        if not isinstance(source, str) or not source or not isinstance(change, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        old = self.states.get(source)
        change_type = change.get("type")
        now = time.monotonic()
        if change_type == "snapshot":
            state = change.get("conversationState")
            revision = change.get("revision")
            if not isinstance(state, dict) or type(revision) is not int:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            if old and revision < old[1]:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            self.snapshot_serial += 1
            self.snapshot_meta[source] = (self.snapshot_serial, now)
            self.states[source] = (copy.deepcopy(state), revision, now)
            self.state_change_kind = "snapshot"
        elif change_type == "patches" and old:
            revision = change.get("revision")
            if change.get("baseRevision") != old[1] or type(revision) is not int or revision <= old[1] or not isinstance(change.get("patches"), list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            self.states[source] = (_patch_state(old[0], change["patches"]), revision, now)
            self.state_change_kind = "patches"

    def _pump(self, timeout: float) -> None:
        try:
            data = self.pipe.read(timeout)
        except TimeoutError:
            raise
        for value in self.decoder.feed(data):
            self._handle(value)

    def request(self, value: dict[str, Any], timeout: float, *, sent_code: str = "DESKTOP_OUTCOME_UNKNOWN") -> dict[str, Any]:
        request_id = value.get("requestId")
        if not isinstance(request_id, str):
            raise _error("DESKTOP_PROTOCOL_ERROR")
        try:
            self.pipe.write(_frame(value))
        except DesktopIpcError:
            # 对 start-turn 而言，进入 request 后已无法从 pipe 层异常证明
            # 服务端没有收到字节；即使是写前核验失败也只能报告 unknown。
            if sent_code == "DESKTOP_OUTCOME_UNKNOWN":
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            raise
        except Exception:
            raise _error(sent_code, not_sent=False)
        deadline = time.monotonic() + timeout
        while request_id not in self.responses:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _error(sent_code, not_sent=False)
            try:
                self._pump(remaining)
            except TimeoutError:
                raise _error(sent_code, not_sent=False)
            except DesktopIpcError:
                if sent_code == "DESKTOP_OUTCOME_UNKNOWN":
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                raise
            except Exception:
                raise _error(sent_code, not_sent=False)
        response = self.responses.pop(request_id)
        if response.get("resultType") != "success":
            if (value.get("method") == "thread-owner-discovery"
                    and response.get("error") == "no-client-found"):
                raise _error("DESKTOP_OWNER_CHANGED" if value.get("targetClientId") else "DESKTOP_NO_OWNER")
            raise _error(sent_code, not_sent=False)
        if response.get("method") != value.get("method"):
            raise _error("DESKTOP_PROTOCOL_ERROR", not_sent=False)
        target = value.get("targetClientId")
        if target and response.get("handledByClientId") != target:
            raise _error("DESKTOP_OWNER_CHANGED", not_sent=False)
        return response

    def initialize(self) -> None:
        response = self.request(self._envelope("initialize", {"clientType": "c2c-desktop-control"}), INITIALIZE_TIMEOUT_SECONDS,
                                sent_code="DESKTOP_IPC_TIMEOUT")
        result = response.get("result")
        client_id = result.get("clientId") if isinstance(result, dict) else None
        if _uuid(client_id) is None:
            raise _error("DESKTOP_PROTOCOL_ERROR")
        self.client_id = client_id

    def discover(self) -> str:
        response = self.request(self._envelope("thread-owner-discovery", {
            "hostId": self.host_id,
            "conversationId": self.thread_id,
        }, self.owner), DISCOVERY_TIMEOUT_SECONDS, sent_code="DESKTOP_IPC_TIMEOUT")
        owner = response.get("handledByClientId")
        if _uuid(owner) is None or owner == self.client_id:
            raise _error("DESKTOP_NO_OWNER")
        if self.owner is not None and owner != self.owner:
            raise _error("DESKTOP_OWNER_CHANGED")
        self.owner = owner
        return owner

    def snapshot(self) -> dict[str, Any]:
        if not self.owner:
            raise _error("DESKTOP_NO_OWNER")
        # 丢弃 following 请求之前已经排队的帧，再建立本次快照的高水位。
        # 否则旧 snapshot 恰好在本次请求后到达时会被误认为新鲜状态。
        self.drain(0.25)
        # 保留 revision 高水位；本次 following 必须带来新 snapshot，不能用缓存满足检查。
        previous = self.snapshot_serial
        requested_at = time.monotonic()
        self.pipe.write(_frame({
            "type": "broadcast",
            "method": "thread-stream-following-changed",
            "version": 1,
            "sourceClientId": self.client_id,
            "targetClientIds": [self.owner],
            "params": {"conversationId": self.thread_id, "hostId": self.host_id, "following": True},
        }))
        self.following_changed_sent = True
        deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        while self.snapshot_meta.get(self.owner, (0, 0.0))[0] <= previous:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            try:
                self._pump(remaining)
            except TimeoutError:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
        meta = self.snapshot_meta[self.owner]
        if meta[1] < requested_at or time.monotonic() - self.states[self.owner][2] > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        return copy.deepcopy(self.states[self.owner][0])

    def drain(self, timeout: float) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            try:
                self._pump(min(0.05, deadline - time.monotonic()))
            except TimeoutError:
                return

    def current_state(self) -> dict[str, Any] | None:
        if not self.owner or self.owner not in self.states:
            return None
        return copy.deepcopy(self.states[self.owner][0])

    def snapshot_age(self) -> float:
        if not self.owner or self.owner not in self.states:
            return float("inf")
        return time.monotonic() - self.states[self.owner][2]


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


def _turn_text_for_reconciliation(turn: dict[str, Any]) -> str | None:
    params = turn.get("params")
    raw_input = params.get("input") if isinstance(params, dict) else None
    items = turn.get("items")
    if not isinstance(raw_input, list) or len(raw_input) != 1 or not isinstance(items, list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    user_messages = [item for item in items if isinstance(item, dict) and item.get("type") == "userMessage"]
    if len(user_messages) != 1 or user_messages[0].get("content") != raw_input:
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


def _reconcile_turn_ids(state: dict[str, Any], expectation: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    # reconciliation 只接受 canonical、已 exhaust 的完整历史；flat turns
    # 没有完整性边界，不能证明“零候选”是真实零候选。
    for turn in _complete_result_turns(state):
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


def _reconcile_unknown(target: dict[str, str], expectation_value: Any) -> dict[str, Any]:
    target = _target(target)
    expectation = _reconcile_expectation(expectation_value)
    session, _ = _prepare(target, purpose="observe")
    try:
        before = session.client.current_state()
        if before is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(before, target, session.client.owner or "")
        before_candidates = _reconcile_turn_ids(before, expectation)
        _verify_process_identity(session.pipe, target, session.process)
        after = session.client.snapshot()
        _validate_observed_state(after, target, session.client.owner or "")
        after_candidates = _reconcile_turn_ids(after, expectation)
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
            state = client.current_state()
            if state is None or client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
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
_RESULT_KNOWN_STATUSES = _RESULT_TERMINAL_STATUSES | {"inProgress"}


def _complete_result_turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    history = state.get("turnHistory")
    if not isinstance(history, dict) or history.get("kind") != "canonical": raise _error("DESKTOP_STATE_UNAVAILABLE")
    body = history.get("history")
    islands = body.get("islands") if isinstance(body, dict) else None
    entities = body.get("entitiesByKey") if isinstance(body, dict) else None
    if not isinstance(islands, list) or not islands or not isinstance(entities, dict): raise _error("DESKTOP_STATE_UNAVAILABLE")
    newest = islands[-1]
    if not isinstance(newest, dict) or not isinstance(newest.get("newerBoundary"), dict) or newest["newerBoundary"].get("status") != "exhausted": raise _error("DESKTOP_STATE_UNAVAILABLE")
    turns=[]; seen_keys=set(); seen_ids=set()
    for island in islands:
        entries = island.get("entries") if isinstance(island, dict) else None
        if not isinstance(entries, list) or not entries: raise _error("DESKTOP_STATE_UNAVAILABLE")
        for entry in entries:
            key = entry.get("value") if isinstance(entry, dict) else None
            item = entities.get(key) if isinstance(key, str) else None
            turn_id = _uuid(item.get("turnId")) if isinstance(item, dict) else None
            if key in seen_keys or turn_id is None or turn_id in seen_ids or item.get("status") not in _RESULT_KNOWN_STATUSES: raise _error("DESKTOP_STATE_UNAVAILABLE")
            seen_keys.add(key); seen_ids.add(turn_id); turns.append(item)
    return turns


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


_NATIVE_CONTINUATION_TRIGGER = "capacity_retry_automatic"
_NATIVE_CONTINUATION_PREDECESSOR_STATUSES = {
    "capacity_retry_automatic": {"failed", "interrupted"},
    "resume_interrupted_task": {"interrupted"},
}


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


def _native_successor(turn: dict[str, Any], target: dict[str, str]) -> str:
    params = turn.get("params")
    items = turn.get("items")
    if not isinstance(params, dict) or not isinstance(items, list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    raw_input = params.get("input")
    trigger = params.get("turnTrigger")
    if not isinstance(trigger, str) or trigger not in _NATIVE_CONTINUATION_PREDECESSOR_STATUSES or (
            "input" in params and (not isinstance(raw_input, list) or raw_input)):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if params.get("threadId") not in {None, target["threadId"]}:
        raise _error("DESKTOP_TARGET_NOT_FOUND")
    if any(not isinstance(item, dict) for item in items):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if any(item.get("type") == "userMessage" for item in items):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return trigger


def _native_continuation_edge(predecessor: dict[str, Any], successor: dict[str, Any], target: dict[str, str]) -> str:
    trigger = _native_successor(successor, target)
    if predecessor.get("status") not in _NATIVE_CONTINUATION_PREDECESSOR_STATUSES[trigger]:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return trigger


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


def _reply(value: dict[str, Any]) -> None:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "strict") + b"\n"
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def _main() -> int:
    prepared: _Prepared | None = None
    send_attempted = False
    while True:
        raw = sys.stdin.buffer.readline(MAX_CONTROL_LINE_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_CONTROL_LINE_BYTES:
            _reply({"id": None, "ok": False, "code": "DESKTOP_INVALID_REQUEST", "notSent": True})
            break
        request: Any = None
        try:
            request = json.loads(raw.decode("utf-8", "strict"))
            if not isinstance(request, dict) or set(request) - {"id", "op", "target", "expectation", "message", "workspaceRoot", "marker"}:
                raise _error("DESKTOP_INVALID_REQUEST")
            request_id = request.get("id")
            op = request.get("op")
            _require(_uuid(request_id) is not None, "DESKTOP_INVALID_REQUEST")
            if sys.version_info < MIN_PYTHON_VERSION:
                raise _error("DESKTOP_PYTHON_UNSUPPORTED")
            if op == "inspect":
                target = _target(request.get("target"))
                session, info = _prepare(target, purpose="observe")
                session.close()
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "reconcile_unknown":
                if set(request) != {"id", "op", "target", "expectation"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True,
                        "value": _reconcile_unknown(request.get("target"), request.get("expectation"))})
            elif op == "diagnose":
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _diagnose(request.get("workspaceRoot"))})
            elif op == "inspect_active_execution":
                if set(request) != {"id", "op", "target"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_active_execution(target)})
            elif op == "inspect_result_context":
                if set(request) != {"id", "op", "target"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_result_context(target)})
            elif op == "inspect_result_activity_marker":
                if set(request) != {"id", "op", "target"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_result_activity_marker(target)})
            elif op == "inspect_result_terminal_fence":
                if set(request) != {"id", "op", "target", "marker"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True,
                        "value": _inspect_result_terminal_fence(target, request.get("marker"))})
            elif op == "current_result_ownership":
                if set(request) != {"id", "op", "workspaceRoot", "expectation"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True,
                        "value": _current_result_ownership(request.get("workspaceRoot"), request.get("expectation"))})
            elif op == "inspect_result_ownership":
                if set(request) != {"id", "op", "target", "expectation"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True,
                        "value": _inspect_result_ownership(target, request.get("expectation"))})
            elif op == "current_result_classification":
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True,
                        "value": _current_result_classification(request.get("workspaceRoot"))})
            elif op in {"current_identity", "current_confirm", "current_execution", "current_result_context"}:
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                if op == "current_identity":
                    info = _current_identity(request["workspaceRoot"])
                elif op == "current_confirm":
                    info = _current_confirm(request["workspaceRoot"])
                elif op == "current_result_context":
                    info = _current_result_context(request["workspaceRoot"])
                else:
                    info = _current_execution(request["workspaceRoot"])
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "prepare":
                if prepared is not None:
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                target = _target(request.get("target"))
                prepared, info = _prepare(target, purpose="send")
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "send":
                if prepared is None:
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                value = _message(request.get("message"))
                if send_attempted:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                # 单个 helper 生命周期最多进入一次真实 start；预检查失败也不重试。
                send_attempted = True
                _reply({"id": request_id, "ok": True, "value": prepared.send(value)})
            elif op == "close":
                if prepared is not None:
                    prepared.close()
                    prepared = None
                _reply({"id": request_id, "ok": True, "value": {"closed": True}})
            else:
                raise _error("DESKTOP_INVALID_REQUEST")
        except DesktopIpcError as error:
            _reply({"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                    "code": error.code, "notSent": error.not_sent})
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OSError):
            is_send = isinstance(request, dict) and request.get("op") == "send"
            _reply({"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                    "code": "DESKTOP_OUTCOME_UNKNOWN" if is_send else "DESKTOP_INVALID_REQUEST",
                    "notSent": not is_send})
        except Exception:
            # send_attempted 已在调用 send 前消耗；任何意外都不能让上层误以为
            # 确认未发送，或触发自动重试。
            is_send = isinstance(request, dict) and request.get("op") == "send"
            _reply({"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                    "code": "DESKTOP_OUTCOME_UNKNOWN" if is_send else "DESKTOP_INTERNAL_ERROR",
                    "notSent": not is_send})
    if prepared is not None:
        prepared.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except Exception:
        # 不把底层路径、正文或 traceback 输出到 helper 协议之外。
        raise SystemExit(1)
