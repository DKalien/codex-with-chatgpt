"""Codex Desktop Control 的受控 Windows IPC helper。

这个程序只接受 stdin 上的固定操作：``inspect``、``prepare``、``send``、
``reconcile_unknown``、``compatibility``、``compatibility_audit``、``current_identity``、``current_confirm``、``current_execution`` 和
``current_result_context``。其中 ``current_*`` 只接受
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
import mmap
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
from typing import Any


PIPE_NAME = r"\\.\pipe\codex-ipc"
MAX_MESSAGE_BYTES = 64 * 1024
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_CONTROL_LINE_BYTES = 512 * 1024
WRITE_TIMEOUT_SECONDS = 5.0
INITIALIZE_TIMEOUT_SECONDS = 5.0
DISCOVERY_TIMEOUT_SECONDS = 5.0
SNAPSHOT_TIMEOUT_SECONDS = 5.0
SEND_TIMEOUT_SECONDS = 30.0
MAX_OBSERVATION_AGE_SECONDS = 2.0
MIN_PYTHON_VERSION = (3, 11)
COMPATIBILITY_STATUSES = {"current", "unverified", "incompatible"}
COMPATIBILITY_AUDIT_CLASSIFICATIONS = {
    "current", "same_protocol_candidate", "protocol_drift_or_unknown", "ambiguous", "unavailable"
}
_VERSION_PATTERN = re.compile(
    r"\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"
)
_DESKTOP_VERSION_PATTERN = re.compile(r"\d+\.\d+\.\d+\.\d+")
_PROFILE_NAME_PATTERN = re.compile(r"desktop-ipc-v[1-9][0-9]*")
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
_MODULE_PATH_PATTERNS = {
    "ipc-main": re.compile(r"^\.vite/build/src-[A-Za-z0-9_-]+\.js$"),
    "webview-bootstrap": re.compile(r"^webview/assets/app-initial-[A-Za-z0-9_-]+\.js$"),
}

PROFILE_CATALOG_PATH = Path(__file__).with_name("desktop_profiles.json")
_CATALOG_MAX_BYTES = 512 * 1024
_CATALOG_MAX_PROFILES = 32
_CATALOG_MAX_RUNTIMES = 128
_CATALOG_MAX_MODULES = 2
_CATALOG_MAX_STRING = 256
_MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024
_MAX_ASAR_FILE_BYTES = 2 * 1024 * 1024 * 1024
_MAX_ASAR_TREE_NODES = 100_000
_MAX_ASAR_DEPTH = 64
_MAX_ASAR_MODULE_BYTES = 64 * 1024 * 1024
_MAX_ASAR_AUDIT_CANDIDATES = 16
_MAX_ASAR_AUDIT_CANDIDATES_PER_ROLE = 8
_MAX_ASAR_AUDIT_MODULE_BYTES = 128 * 1024 * 1024


class _CatalogError(ValueError):
    pass


def _safe_version(value: Any) -> str | None:
    return value if isinstance(value, str) and len(value) <= 64 and _VERSION_PATTERN.fullmatch(value) else None


def _catalog_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _CatalogError("duplicate catalog key")
        result[key] = value
    return result


def _catalog_keys(value: Any, expected: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise _CatalogError("catalog object keys")
    return value


def _catalog_string(value: Any, *, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not 0 < len(value) <= _CATALOG_MAX_STRING or "\x00" in value:
        raise _CatalogError("catalog string")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise _CatalogError("catalog string format")
    return value


def _catalog_version(value: Any, *, desktop: bool = False) -> str:
    text = _catalog_string(value)
    if _VERSION_PATTERN.fullmatch(text) is None or (desktop and _DESKTOP_VERSION_PATTERN.fullmatch(text) is None):
        raise _CatalogError("catalog version")
    return text


def _catalog_hash(value: Any) -> str:
    return _catalog_string(value, pattern=_SHA256_PATTERN)


def _catalog_asar_header(value: Any) -> tuple[int, int, int, int]:
    if not isinstance(value, list) or len(value) != 4:
        raise _CatalogError("catalog asar header")
    if any(type(item) is not int or item < 0 or item > _MAX_ASAR_HEADER_BYTES for item in value):
        raise _CatalogError("catalog asar header bounds")
    version, header_size, json_offset, json_size = value
    if (version != 4 or header_size < 16 or json_size <= 0
            or header_size != json_offset + 4 or json_offset != json_size + 7):
        raise _CatalogError("catalog asar header layout")
    if json_offset > header_size or header_size - json_size > 64:
        raise _CatalogError("catalog asar header layout")
    return version, header_size, json_offset, json_size


def _catalog_module(value: Any) -> dict[str, str]:
    module = _catalog_keys(value, {"role", "path", "sha256"})
    role = _catalog_string(module["role"])
    pattern = _MODULE_PATH_PATTERNS.get(role)
    if pattern is None:
        raise _CatalogError("catalog module role")
    path = _catalog_string(module["path"])
    if ("\\" in path or path.startswith("/") or any(part in {"", ".", ".."} for part in path.split("/"))
            or pattern.fullmatch(path) is None):
        raise _CatalogError("catalog module path")
    return {"role": role, "path": path, "sha256": _catalog_hash(module["sha256"])}


def _load_catalog(path: str | os.PathLike[str] | None = None) -> dict[str, tuple[dict[str, Any], ...]]:
    """读取固定 schema 的信任 catalog；任一异常都由调用方按 fail-closed 处理。"""
    path = PROFILE_CATALOG_PATH if path is None else path
    try:
        with open(path, "rb") as stream:
            raw = stream.read(_CATALOG_MAX_BYTES + 1)
        if len(raw) > _CATALOG_MAX_BYTES:
            raise _CatalogError("catalog too large")
        document = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_catalog_object)
    except _CatalogError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecursionError) as error:
        raise _CatalogError("catalog unavailable") from error
    root = _catalog_keys(document, {"schemaVersion", "profiles"})
    if type(root["schemaVersion"]) is not int or root["schemaVersion"] != 1:
        raise _CatalogError("catalog schema")
    profiles = root["profiles"]
    if not isinstance(profiles, list) or not 0 < len(profiles) <= _CATALOG_MAX_PROFILES:
        raise _CatalogError("catalog profiles")
    result: dict[str, tuple[dict[str, Any], ...]] = {}
    version_pairs: set[tuple[str, str]] = set()
    for raw_profile in profiles:
        profile = _catalog_keys(raw_profile, {"name", "runtimes"})
        name = _catalog_string(profile["name"], pattern=_PROFILE_NAME_PATTERN)
        if name in result:
            raise _CatalogError("duplicate profile")
        runtimes = profile["runtimes"]
        if not isinstance(runtimes, list) or not 0 < len(runtimes) <= _CATALOG_MAX_RUNTIMES:
            raise _CatalogError("catalog runtimes")
        normalized: list[dict[str, Any]] = []
        for raw_runtime in runtimes:
            runtime = _catalog_keys(raw_runtime, {
                "desktopVersion", "appServerVersion", "appServerSha256", "asarHeader", "modules"
            })
            desktop_version = _catalog_version(runtime["desktopVersion"], desktop=True)
            app_server_version = _catalog_version(runtime["appServerVersion"])
            pair = (desktop_version, app_server_version)
            if pair in version_pairs:
                raise _CatalogError("duplicate runtime version pair")
            version_pairs.add(pair)
            modules = runtime["modules"]
            if not isinstance(modules, list) or len(modules) != _CATALOG_MAX_MODULES:
                raise _CatalogError("catalog modules")
            normalized_modules = [_catalog_module(module) for module in modules]
            roles = [module["role"] for module in normalized_modules]
            paths = [module["path"] for module in normalized_modules]
            if set(roles) != set(_MODULE_PATH_PATTERNS) or len(set(roles)) != len(roles) \
                    or len(set(paths)) != len(paths):
                raise _CatalogError("duplicate catalog module role/path")
            normalized.append({
                "desktopVersion": desktop_version,
                "appServerVersion": app_server_version,
                "appServerSha256": _catalog_hash(runtime["appServerSha256"]),
                "asarHeader": list(_catalog_asar_header(runtime["asarHeader"])),
                "modules": normalized_modules,
            })
        result[name] = tuple(normalized)
    return result


def _legacy_runtime(runtime: dict[str, Any]) -> dict[str, Any]:
    """保留旧 helper 测试和调用方需要的 moduleHashes 兼容投影。"""
    value = copy.deepcopy(runtime)
    modules = value.get("modules")
    if isinstance(modules, list):
        value["moduleHashes"] = {module["path"]: module["sha256"] for module in modules}
    value["asarHeader"] = tuple(value["asarHeader"])
    return value


try:
    _CATALOG_PROFILES = _load_catalog()
except _CatalogError:
    _CATALOG_PROFILES = {}

VERIFIED_PROFILES = {
    name: tuple(_legacy_runtime(runtime) for runtime in runtimes)
    for name, runtimes in _CATALOG_PROFILES.items()
}
VERIFIED_PROFILE = "desktop-ipc-v1" if "desktop-ipc-v1" in VERIFIED_PROFILES else None


def _legacy_runtime_for_pair(desktop_version: str, app_server_version: str) -> dict[str, Any]:
    for runtimes in VERIFIED_PROFILES.values():
        for runtime in runtimes:
            if (runtime.get("desktopVersion"), runtime.get("appServerVersion")) == (
                    desktop_version, app_server_version):
                return runtime
    return {}


VERIFIED_RUNTIME = _legacy_runtime_for_pair("26.903.9818.0", "0.153.4")
VERIFIED_RUNTIME_26_908 = _legacy_runtime_for_pair("26.908.4834.0", "0.154.0-alpha.6.2")
VERIFIED_RUNTIME_26_908_9136 = _legacy_runtime_for_pair("26.908.9136.0", "0.154.0-alpha.6.2")


def _safe_compatibility(value: Any = None) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    status = value.get("status")
    return {
        "observedDesktopVersion": _safe_version(value.get("observedDesktopVersion")),
        "observedAppServerVersion": _safe_version(value.get("observedAppServerVersion")),
        "status": status if status in COMPATIBILITY_STATUSES else "unverified",
        "profile": value.get("profile") if isinstance(value.get("profile"), str)
        and bool(re.fullmatch(r"desktop-ipc-v[1-9][0-9]*", value["profile"])) else None,
    }


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
    "DESKTOP_VERSION_UNSUPPORTED": "当前 Desktop/app-server 版本未经过适配验证；没有发送消息。",
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
    "DESKTOP_PROTOCOL_ERROR": "Desktop IPC 返回无法确认的结果；不要重发。",
    "DESKTOP_INTERNAL_ERROR": "Desktop Control 暂时不可用；没有发送消息。",
    "DESKTOP_INVALID_REQUEST": "Desktop Control 请求格式无效；没有发送消息。",
    "DESKTOP_MESSAGE_TOO_LARGE": "消息超过 64 KiB UTF-8 上限；拒绝投递，不截断。",
    "DESKTOP_PYTHON_UNSUPPORTED": "运行 Desktop IPC helper 需要 Python 3.11 或更高版本；没有发送消息。",
    "DESKTOP_CURRENT_CONTEXT_INVALID": "当前 Codex 上下文或 Desktop 会话身份无法安全确认；没有发送消息。",
    "DESKTOP_CONFIRMATION_CANCELLED": "本机确认被取消或未完成；没有发送消息。",
    "DESKTOP_RECONCILIATION_CONFLICT": "Desktop 历史无法唯一核对；未恢复结果或修改投递状态。",
}

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
                if available.value > MAX_FRAME_BYTES + 4:
                    raise _error("DESKTOP_PROTOCOL_ERROR")
                return self._read_available(int(available.value), deadline)
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


def _verify_current_runner_ancestor(runtime: dict[str, Any]) -> None:
    expected = runtime.get("appServerPid")
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


def _version_error(mismatch: str, compatibility: Any = None) -> DesktopIpcError:
    error = _error("DESKTOP_VERSION_UNSUPPORTED")
    # 仅内部诊断类别，不带路径/配置，也不透传到 MCP/CLI。
    error.mismatch = mismatch
    error.compatibility = _safe_compatibility(compatibility)
    return error


def _profile_for_pair(desktop_version: str | None, app_server_version: str | None) -> tuple[str, dict[str, Any]] | None:
    if not desktop_version or not app_server_version:
        return None
    matches = [(name, runtime) for name, runtimes in VERIFIED_PROFILES.items() for runtime in runtimes
               if (runtime["desktopVersion"], runtime["appServerVersion"]) == (desktop_version, app_server_version)]
    return matches[0] if len(matches) == 1 else None


def _runtime_module_rows(runtime: dict[str, Any]) -> list[dict[str, str]]:
    modules = runtime.get("modules")
    if isinstance(modules, list):
        return [module for module in modules if isinstance(module, dict)]
    hashes = runtime.get("moduleHashes")
    if not isinstance(hashes, dict):
        return []
    rows: list[dict[str, str]] = []
    for path, digest in hashes.items():
        if not isinstance(path, str) or not isinstance(digest, str):
            continue
        role = next((candidate for candidate, pattern in _MODULE_PATH_PATTERNS.items()
                     if pattern.fullmatch(path)), None)
        if role is not None:
            rows.append({"role": role, "path": path, "sha256": digest})
    return rows


def _runtime_module_hashes(runtime: dict[str, Any]) -> dict[str, str]:
    hashes = runtime.get("moduleHashes")
    if isinstance(hashes, dict):
        return hashes
    rows = _runtime_module_rows(runtime)
    return {module["path"]: module["sha256"] for module in rows
            if isinstance(module.get("path"), str) and isinstance(module.get("sha256"), str)}


def _catalog_runtime_projection(runtime: dict[str, Any]) -> dict[str, Any]:
    """仅返回 catalog runtime 行；不把旧兼容 moduleHashes 泄漏到审计结果。"""
    modules = _runtime_module_rows(runtime)
    return {
        "desktopVersion": runtime.get("desktopVersion"),
        "appServerVersion": runtime.get("appServerVersion"),
        "appServerSha256": runtime.get("appServerSha256"),
        "asarHeader": list(runtime.get("asarHeader", ())),
        "modules": [
            {"role": module.get("role"), "path": module.get("path"), "sha256": module.get("sha256")}
            for module in modules
        ],
    }


def _sha256_file(path: str) -> str | None:
    try:
        with open(path, "rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()
    except (OSError, ValueError):
        return None


def _static_file_version(path: str) -> str | None:
    """只读提取二进制 provenance 中的版本；不执行未知程序，歧义时不猜。

    仅接受 exact accepted markers；任一 marker 出现多次、新旧 marker 同时出现、
    缺少已观察到的 platform delimiter 或 version 非法时一律 fail closed。
    """
    markers = (
        b"standalone local buildversion: ",
        b"standalonelocal buildversion: ",
    )
    # Exact delimiters observed in audited binaries (space vs newline before platform).
    delimiters = (
        b" platform:",
        b"\nplatform:",
    )
    try:
        with open(path, "rb") as stream:
            if not 0 < os.fstat(stream.fileno()).st_size <= 512 * 1024 * 1024:
                return None
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                hits: list[tuple[bytes, int]] = []
                for marker in markers:
                    offset = data.find(marker)
                    if offset < 0:
                        continue
                    if data.find(marker, offset + len(marker)) >= 0:
                        return None
                    hits.append((marker, offset))
                if len(hits) != 1:
                    return None
                marker, offset = hits[0]
                tail = data[offset + len(marker):offset + len(marker) + 96]
                versions: list[bytes] = []
                for delimiter in delimiters:
                    raw, separator, _ = tail.partition(delimiter)
                    if separator:
                        versions.append(raw)
                if len(versions) != 1:
                    return None
                return _safe_version(versions[0].decode("ascii"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _static_desktop_version(desktop_exe: str) -> str | None:
    match = re.search(r"(?:^|[\\/])OpenAI\.Codex_(\d+(?:\.\d+){3})_", desktop_exe, re.IGNORECASE)
    return match.group(1) if match else None


def _observe_runtime_versions(desktop_exe: str, app_server_exe: str) -> dict[str, Any]:
    app_server_hash = _sha256_file(app_server_exe)
    # 已知文件的完整 hash 本身提供精确版本证据，避免每次状态复核再扫描大二进制。
    # 未知 hash 仍可只读诊断版本，但绝不因此放行。
    versions = {runtime["appServerVersion"] for runtimes in VERIFIED_PROFILES.values() for runtime in runtimes
                if app_server_hash is not None and app_server_hash == runtime["appServerSha256"]}
    app_server_version = versions.pop() if len(versions) == 1 else _static_file_version(app_server_exe)
    return {"observedDesktopVersion": _static_desktop_version(desktop_exe),
            "observedAppServerVersion": app_server_version, "appServerSha256": app_server_hash}


def _diagnostic_from_observation(observed: dict[str, Any], *, failed: bool = False) -> dict[str, Any]:
    pair = _profile_for_pair(observed.get("observedDesktopVersion"), observed.get("observedAppServerVersion"))
    return _safe_compatibility({
        **observed,
        "status": "incompatible" if pair and failed else "unverified",
        "profile": pair[0] if pair else None,
    })


def _asar_module_hashes(desktop_exe: str, profile: dict[str, Any]) -> dict[str, str]:
    asar = Path(desktop_exe).parent / "resources" / "app.asar"
    try:
        with asar.open("rb") as stream:
            header = stream.read(16)
            if len(header) != 16:
                raise _version_error("asar_header_truncated")
            layout = struct.unpack("<4I", header)
            # 原 1 MiB 上限会误拒绝已验证包的 2,441,036 字节头部。
            # 使用已验证组合的精确布局，仍在分配/解析前拒绝任意未知长度。
            if layout != profile["asarHeader"]:
                raise _version_error("asar_header_layout")
            _, header_size, _, json_size = layout
            raw_tree = stream.read(json_size)
            if len(raw_tree) != json_size:
                raise _version_error("asar_header_truncated")
            tree = json.loads(raw_tree.decode("utf-8", "strict"))
            hashes: dict[str, str] = {}
            for module, expected in _runtime_module_hashes(profile).items():
                node: Any = tree
                for part in module.split("/"):
                    files = node.get("files") if isinstance(node, dict) else None
                    node = files.get(part) if isinstance(files, dict) else None
                    if not isinstance(node, dict):
                        raise ValueError
                offset = int(node.get("offset", 0))
                size = int(node.get("size", 0))
                if offset < 0 or size <= 0 or size > MAX_FRAME_BYTES or node.get("unpacked"):
                    raise ValueError
                stream.seek(8 + header_size + offset)
                raw_module = stream.read(size)
                if len(raw_module) != size:
                    raise _version_error("asar_module_truncated")
                digest = hashlib.sha256(raw_module).hexdigest()
                if digest != expected:
                    raise _version_error("asar_module_sha256")
                hashes[module] = digest
            return hashes
    except DesktopIpcError:
        raise
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
        raise _version_error("asar_container_invalid")


def _checked_runtime(desktop_exe: str, observed: dict[str, Any]) -> dict[str, Any]:
    pair = _profile_for_pair(observed["observedDesktopVersion"], observed["observedAppServerVersion"])
    diagnostic = _diagnostic_from_observation(observed, failed=True)
    if pair is None:
        raise _version_error("runtime_pair_unverified", diagnostic)
    name, profile = pair
    if observed["appServerSha256"] != profile["appServerSha256"]:
        raise _version_error("app_server_sha256", diagnostic)
    try:
        module_hashes = _asar_module_hashes(desktop_exe, profile)
    except DesktopIpcError as error:
        error.compatibility = diagnostic
        raise
    return {"desktopVersion": profile["desktopVersion"], "appServerVersion": profile["appServerVersion"],
            "appServerSha256": profile.get("appServerSha256"), "asarHeader": profile.get("asarHeader"),
            "modules": _runtime_module_rows(profile), "moduleHashes": module_hashes, "profile": name}


def _runtime_version(desktop_exe: str, app_server_exe: str) -> dict[str, Any]:
    return _checked_runtime(desktop_exe, _observe_runtime_versions(desktop_exe, app_server_exe))


def _compatibility_for_paths(desktop_exe: str, app_server_exe: str) -> dict[str, Any]:
    observed = _observe_runtime_versions(desktop_exe, app_server_exe)
    try:
        runtime = _checked_runtime(desktop_exe, observed)
    except DesktopIpcError as error:
        return error.compatibility
    return _safe_compatibility({**observed, "status": "current", "profile": runtime["profile"]})


class _AsarAuditError(ValueError):
    pass


def _asar_number(value: Any) -> int:
    if type(value) is int:
        number = value
    elif isinstance(value, str) and value.isascii() and value.isdigit():
        number = int(value, 10)
    else:
        raise _AsarAuditError("asar number")
    if number < 0:
        raise _AsarAuditError("asar number bounds")
    return number


def _asar_audit_modules(desktop_exe: str) -> tuple[list[int], dict[str, list[dict[str, str]]]]:
    """有限读取 ASAR，只保留两个协议候选模块的 role/path/hash。"""
    asar = Path(desktop_exe).parent / "resources" / "app.asar"
    candidates: dict[str, list[dict[str, str]]] = {role: [] for role in _MODULE_PATH_PATTERNS}
    try:
        with asar.open("rb") as stream:
            file_size = os.fstat(stream.fileno()).st_size
            if file_size <= 16 or file_size > _MAX_ASAR_FILE_BYTES:
                raise _AsarAuditError("asar size")
            header = stream.read(16)
            if len(header) != 16:
                raise _AsarAuditError("asar header")
            layout = list(struct.unpack("<4I", header))
            version, header_size, json_offset, json_size = layout
            if (version != 4 or header_size < 16 or header_size > _MAX_ASAR_HEADER_BYTES
                    or json_size <= 0 or header_size != json_offset + 4
                    or json_offset != json_size + 7):
                raise _AsarAuditError("asar header layout")
            tree_start = 16
            tree_end = tree_start + json_size
            data_start = 8 + header_size
            if tree_end > file_size or data_start > file_size:
                raise _AsarAuditError("asar header bounds")
            stream.seek(tree_start)
            raw_tree = stream.read(json_size)
            if len(raw_tree) != json_size:
                raise _AsarAuditError("asar tree truncated")
            try:
                tree = json.loads(raw_tree.decode("utf-8", "strict"), object_pairs_hook=_catalog_object)
            except (_CatalogError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecursionError) as error:
                raise _AsarAuditError("asar tree invalid") from error
            nodes = 0
            candidate_count = 0
            candidate_bytes = 0
            candidate_offsets: list[tuple[int, int]] = []

            def walk(node: Any, prefix: str, depth: int) -> None:
                nonlocal nodes, candidate_count, candidate_bytes
                nodes += 1
                if nodes > _MAX_ASAR_TREE_NODES or depth > _MAX_ASAR_DEPTH or not isinstance(node, dict):
                    raise _AsarAuditError("asar tree bounds")
                files = node.get("files")
                if files is None:
                    if prefix == "":
                        raise _AsarAuditError("asar root")
                    role = next((candidate for candidate, pattern in _MODULE_PATH_PATTERNS.items()
                                 if pattern.fullmatch(prefix)), None)
                    if role is None:
                        return
                    if node.get("unpacked"):
                        raise _AsarAuditError("asar unpacked module")
                    offset = _asar_number(node.get("offset"))
                    size = _asar_number(node.get("size"))
                    if size <= 0 or size > _MAX_ASAR_MODULE_BYTES:
                        raise _AsarAuditError("asar module bounds")
                    start = data_start + offset
                    if start < data_start or start > file_size or size > file_size - start:
                        raise _AsarAuditError("asar module bounds")
                    if (candidate_count >= _MAX_ASAR_AUDIT_CANDIDATES
                            or len(candidates[role]) >= _MAX_ASAR_AUDIT_CANDIDATES_PER_ROLE
                            or candidate_bytes > _MAX_ASAR_AUDIT_MODULE_BYTES - size):
                        raise _AsarAuditError("asar audit budget")
                    end = start + size
                    if any(start < previous_end and previous_start < end
                           for previous_start, previous_end in candidate_offsets):
                        raise _AsarAuditError("asar module overlap")
                    candidate_offsets.append((start, end))
                    candidate_count += 1
                    candidate_bytes += size
                    stream.seek(start)
                    digest = hashlib.sha256()
                    remaining = size
                    while remaining:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise _AsarAuditError("asar module truncated")
                        digest.update(chunk)
                        remaining -= len(chunk)
                    candidates[role].append({"role": role, "path": prefix, "sha256": digest.hexdigest()})
                    return
                if not isinstance(files, dict) or len(files) > _MAX_ASAR_TREE_NODES:
                    raise _AsarAuditError("asar files")
                for name, child in files.items():
                    if (not isinstance(name, str) or not 0 < len(name) <= _CATALOG_MAX_STRING or "\x00" in name
                            or "/" in name or "\\" in name or name in {".", ".."}):
                        raise _AsarAuditError("asar file name")
                    child_path = f"{prefix}/{name}" if prefix else name
                    if len(child_path) > _CATALOG_MAX_STRING:
                        raise _AsarAuditError("asar path bounds")
                    walk(child, child_path, depth + 1)

            walk(tree, "", 0)
            return layout, candidates
    except _AsarAuditError:
        raise
    except (OSError, struct.error, ValueError, TypeError) as error:
        raise _AsarAuditError("asar unavailable") from error


def _safe_audit_hash(value: Any) -> str | None:
    return value if isinstance(value, str) and _SHA256_PATTERN.fullmatch(value) else None


def _safe_audit_modules(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    seen_roles: set[str] = set()
    seen_paths: set[str] = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"role", "path", "sha256"}:
            continue
        role, path, digest = item["role"], item["path"], item["sha256"]
        pattern = _MODULE_PATH_PATTERNS.get(role) if isinstance(role, str) else None
        if (pattern is None or not isinstance(path, str) or pattern.fullmatch(path) is None
                or path in seen_paths or role in seen_roles or _safe_audit_hash(digest) is None):
            continue
        seen_roles.add(role)
        seen_paths.add(path)
        result.append({"role": role, "path": path, "sha256": digest})
    return result


def _safe_audit(value: Any = None) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    status = value.get("status") if value.get("status") in COMPATIBILITY_STATUSES else "unverified"
    classification = value.get("classification")
    if classification not in COMPATIBILITY_AUDIT_CLASSIFICATIONS:
        classification = "unavailable"
    profile = value.get("profile") if isinstance(value.get("profile"), str) \
        and _PROFILE_NAME_PATTERN.fullmatch(value["profile"]) else None
    candidate_profile = value.get("candidateProfile") if isinstance(value.get("candidateProfile"), str) \
        and _PROFILE_NAME_PATTERN.fullmatch(value["candidateProfile"]) else None
    header = value.get("asarHeader")
    if (not isinstance(header, (list, tuple)) or len(header) != 4
            or any(type(item) is not int or item < 0 or item > _MAX_ASAR_HEADER_BYTES for item in header)):
        header = None
    else:
        header = list(header)
    result: dict[str, Any] = {
        **_safe_compatibility({**value, "status": status, "profile": profile}),
        "classification": classification,
        "appServerSha256": _safe_audit_hash(value.get("appServerSha256")),
        "asarHeader": header,
        "candidateProfile": candidate_profile,
        "modules": _safe_audit_modules(value.get("modules")),
    }
    candidate_runtime = value.get("candidateRuntime")
    if isinstance(candidate_runtime, dict) and set(candidate_runtime) == {
        "desktopVersion", "appServerVersion", "appServerSha256", "asarHeader", "modules"
    }:
        runtime = _catalog_runtime_projection(candidate_runtime)
        if (_safe_version(runtime["desktopVersion"]) is not None
                and _DESKTOP_VERSION_PATTERN.fullmatch(runtime["desktopVersion"]) is not None
                and _safe_version(runtime["appServerVersion"]) is not None
                and _safe_audit_hash(runtime["appServerSha256"]) is not None
                and isinstance(runtime["asarHeader"], list) and len(runtime["asarHeader"]) == 4
                and all(type(item) is int and 0 <= item <= _MAX_ASAR_HEADER_BYTES
                        for item in runtime["asarHeader"])
                and len(_safe_audit_modules(runtime["modules"])) == 2):
            runtime["modules"] = _safe_audit_modules(runtime["modules"])
            result["candidateRuntime"] = runtime
    return result


def _audit_result(observed: dict[str, Any] | None = None, *, status: str = "unverified",
                  classification: str = "unavailable", profile: str | None = None,
                  app_server_sha256: str | None = None, asar_header: Any = None,
                  candidate_profile: str | None = None, modules: Any = None,
                  candidate_runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    observed = observed if isinstance(observed, dict) else {}
    value: dict[str, Any] = {
        "observedDesktopVersion": observed.get("observedDesktopVersion"),
        "observedAppServerVersion": observed.get("observedAppServerVersion"),
        "status": status,
        "profile": profile,
        "classification": classification,
        "appServerSha256": app_server_sha256,
        "asarHeader": asar_header,
        "candidateProfile": candidate_profile,
        "modules": modules if modules is not None else [],
    }
    if candidate_runtime is not None:
        value["candidateRuntime"] = candidate_runtime
    return _safe_audit(value)


def _profiles_for_app_server_version(version: str | None) -> list[tuple[str, tuple[dict[str, Any], ...]]]:
    if not version:
        return []
    return [(name, runtimes) for name, runtimes in VERIFIED_PROFILES.items()
            if any(runtime.get("appServerVersion") == version for runtime in runtimes)]


def _compatibility_audit_for_paths(desktop_exe: str, app_server_exe: str) -> dict[str, Any]:
    observed = _observe_runtime_versions(desktop_exe, app_server_exe)
    app_server_sha256 = observed.get("appServerSha256")
    if (_safe_version(observed.get("observedDesktopVersion")) is None
            or _safe_version(observed.get("observedAppServerVersion")) is None
            or _safe_audit_hash(app_server_sha256) is None):
        return _audit_result(observed, classification="unavailable", app_server_sha256=app_server_sha256)
    exact = _profile_for_pair(observed.get("observedDesktopVersion"), observed.get("observedAppServerVersion"))
    if exact is not None:
        name, profile = exact
        try:
            _checked_runtime(desktop_exe, observed)
        except DesktopIpcError:
            return _audit_result(observed, status="incompatible", classification="protocol_drift_or_unknown",
                                 profile=name, candidate_profile=name, app_server_sha256=app_server_sha256)
        return _audit_result(
            observed,
            status="current",
            classification="current",
            profile=name,
            app_server_sha256=app_server_sha256,
            asar_header=profile.get("asarHeader"),
            candidate_profile=name,
            modules=_runtime_module_rows(profile),
        )

    matches = _profiles_for_app_server_version(observed.get("observedAppServerVersion"))
    if not matches:
        return _audit_result(observed, classification="protocol_drift_or_unknown", app_server_sha256=app_server_sha256)
    known_desktop_versions = {
        runtime.get("desktopVersion") for runtimes in VERIFIED_PROFILES.values() for runtime in runtimes
    }
    if observed.get("observedDesktopVersion") in known_desktop_versions:
        name = matches[0][0] if len(matches) == 1 else None
        return _audit_result(observed, classification="protocol_drift_or_unknown", profile=name,
                             candidate_profile=name, app_server_sha256=app_server_sha256)
    if len(matches) != 1:
        return _audit_result(observed, classification="ambiguous", app_server_sha256=app_server_sha256)
    name, runtimes = matches[0]
    try:
        asar_header, candidates = _asar_audit_modules(desktop_exe)
    except _AsarAuditError:
        return _audit_result(observed, classification="protocol_drift_or_unknown", candidate_profile=name,
                             app_server_sha256=app_server_sha256)
    ipc_candidates = candidates.get("ipc-main", [])
    webview_candidates = candidates.get("webview-bootstrap", [])
    if len(webview_candidates) != 1:
        classification = "ambiguous" if len(webview_candidates) > 1 else "protocol_drift_or_unknown"
        return _audit_result(observed, classification=classification, candidate_profile=name,
                             app_server_sha256=app_server_sha256, asar_header=asar_header,
                             modules=webview_candidates)
    trusted_hashes = {
        module.get("sha256")
        for runtime in runtimes
        for module in _runtime_module_rows(runtime)
        if module.get("role") == "ipc-main"
    }
    trusted_ipc = [module for module in ipc_candidates if module.get("sha256") in trusted_hashes]
    if len(trusted_ipc) != 1:
        classification = "ambiguous" if len(trusted_ipc) > 1 else "protocol_drift_or_unknown"
        return _audit_result(observed, classification=classification, candidate_profile=name,
                             app_server_sha256=app_server_sha256, asar_header=asar_header,
                             modules=[*trusted_ipc, *webview_candidates])
    modules = [*trusted_ipc, *webview_candidates]
    candidate_runtime = {
        "desktopVersion": observed.get("observedDesktopVersion"),
        "appServerVersion": observed.get("observedAppServerVersion"),
        "appServerSha256": app_server_sha256,
        "asarHeader": asar_header,
        "modules": modules,
    }
    return _audit_result(observed, classification="same_protocol_candidate", candidate_profile=name,
                         app_server_sha256=app_server_sha256, asar_header=asar_header, modules=modules,
                         candidate_runtime=candidate_runtime)


def _runtime_process_pairs() -> list[tuple[str, str]]:
    """只从现有进程树定位 Desktop/app-server，不启动或连接 app-server。"""
    rows = _processes()
    servers = [
        row for row in rows
        if row.get("name", "").casefold() == "chatgpt.exe"
        and type(row.get("pid")) is int and row["pid"] > 0
        and type(row.get("creation")) is int and row["creation"] > 0
        and isinstance(row.get("exe"), str) and bool(row["exe"])
    ]
    pairs: list[tuple[str, str]] = []
    for server in servers:
        children = [
            row for row in rows
            if row.get("name", "").casefold() == "codex.exe"
            and row.get("parentPid") == server["pid"]
            and type(row.get("pid")) is int and row["pid"] > 0
            and type(row.get("creation")) is int and row["creation"] > 0
            and isinstance(row.get("exe"), str) and bool(row["exe"])
        ]
        if len(children) == 1:
            pairs.append((server["exe"], children[0]["exe"]))
    return pairs


def _compatibility_audit() -> dict[str, Any]:
    _query_standard_token()
    pairs = _runtime_process_pairs()
    if len(pairs) == 0:
        return _audit_result(classification="unavailable")
    if len(pairs) != 1:
        return _audit_result(classification="ambiguous")
    return _compatibility_audit_for_paths(*pairs[0])


compatibility_audit = _compatibility_audit


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


def _verify_runtime(pipe: _Pipe, target: dict[str, str], expected: dict[str, Any] | None = None) -> dict[str, Any]:
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
    version = _runtime_version(server["exe"], app_server["exe"])
    if expected and (
        expected["desktopPid"] != pipe.server_pid
        or expected["appServerPid"] != app_server["pid"]
        or expected["desktopCreation"] != server["creation"]
        or expected["appServerCreation"] != app_server["creation"]
    ):
        raise _error("DESKTOP_PROCESS_CHANGED")
    _verify_project(target)
    return {
        **version,
        "desktopPid": pipe.server_pid,
        "desktopExe": server["exe"],
        "desktopCreation": server["creation"],
        "appServerPid": app_server["pid"],
        "appServerExe": app_server["exe"],
        "appServerCreation": app_server["creation"],
    }


def _runtime_process_pair() -> tuple[str, str] | None:
    """只从现有进程树定位唯一 Desktop/app-server，不启动或连接 app-server。"""
    pairs = _runtime_process_pairs()
    return pairs[0] if len(pairs) == 1 else None


def _compatibility() -> dict[str, Any]:
    _query_standard_token()
    pair = _runtime_process_pair()
    return _safe_compatibility() if pair is None else _compatibility_for_paths(*pair)


# ---- protocol client and fresh state -------------------------------------

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
            raise _error("DESKTOP_VERSION_UNSUPPORTED")
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
        elif change_type == "patches" and old:
            revision = change.get("revision")
            if change.get("baseRevision") != old[1] or type(revision) is not int or revision <= old[1] or not isinstance(change.get("patches"), list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            self.states[source] = (_patch_state(old[0], change["patches"]), revision, now)

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


def _turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    history = state.get("turnHistory")
    if isinstance(history, dict) and history.get("kind") == "canonical":
        body = history.get("history")
        if not isinstance(body, dict) or not isinstance(body.get("islands"), list) or not body["islands"] or not isinstance(body.get("entitiesByKey"), dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        islands = body["islands"]
        if not isinstance(islands[-1], dict) or not isinstance(islands[-1].get("newerBoundary"), dict) or islands[-1]["newerBoundary"].get("status") != "exhausted":
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


def _reconcile_expectation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"workspaceId", "commandId", "intent", "messageBytes", "messageSha256"}:
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
    return dict(value)


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


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reconcile_turn_ids(state: dict[str, Any], expectation: dict[str, Any]) -> list[str]:
    expected_keys = {"type", "version", "workspaceId", "commandId", "intent", "message"}
    candidates: list[str] = []
    # reconciliation 只接受 canonical、已 exhaust 的完整历史；flat turns
    # 没有完整性边界，不能证明“零候选”是真实零候选。
    for turn in _complete_result_turns(state):
        text = _turn_text_for_reconciliation(turn)
        if text is None:
            continue
        stripped = text.lstrip()
        try:
            envelope = json.loads(text, object_pairs_hook=_strict_json_object)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            # 普通 user text 不是候选；但一个以 JSON object 开头的截断 envelope
            # 不能被当成“没有找到”，必须保持 fail-closed。
            if stripped.startswith("{"):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            continue
        if not isinstance(envelope, dict) or envelope.get("type") != "C2C_DESKTOP_TASK":
            continue
        if set(envelope) != expected_keys or not isinstance(envelope.get("message"), str):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        if envelope.get("version") != 1:
            continue
        message = envelope["message"]
        try:
            message_bytes = len(message.encode("utf-8", "strict"))
            message_sha256 = hashlib.sha256(message.encode("utf-8", "strict")).hexdigest()
        except UnicodeEncodeError:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        if (envelope.get("workspaceId") != expectation["workspaceId"] or
                envelope.get("commandId") != expectation["commandId"] or
                envelope.get("intent") != expectation["intent"] or
                message_bytes != expectation["messageBytes"] or
                message_sha256 != expectation["messageSha256"]):
            continue
        turn_id = _uuid(turn.get("turnId"))
        if turn_id is None:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        candidates.append(turn_id)
    return candidates


def _reconcile_unknown(target: dict[str, str], expectation_value: Any) -> dict[str, Any]:
    target = _target(target)
    expectation = _reconcile_expectation(expectation_value)
    session, _ = _prepare(target, allow_active=True)
    try:
        before = session.client.current_state()
        if before is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_state(before, target, session.client.owner or "", allow_active=True)
        before_candidates = _reconcile_turn_ids(before, expectation)
        _verify_runtime(session.pipe, target, session.runtime)
        after = session.client.snapshot()
        _validate_state(after, target, session.client.owner or "", allow_active=True)
        after_candidates = _reconcile_turn_ids(after, expectation)
        _verify_runtime(session.pipe, target, session.runtime)
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


def _validate_state(state: dict[str, Any], target: dict[str, str], owner: str, *, allow_active: bool = False) -> None:
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
    if runtime_type != "idle" and not (allow_active and runtime_type in {"active", "inProgress"}):
        raise _error("DESKTOP_BUSY")
    requests = state.get("requests")
    if not isinstance(requests, list):
        raise _error("DESKTOP_APPROVAL_PENDING")
    if requests:
        raise _error("DESKTOP_APPROVAL_PENDING")
    if state.get("unconfirmedTurnSubmissions"):
        raise _error("DESKTOP_APPROVAL_PENDING")
    terminal_statuses = {"completed", "failed", "interrupted", "cancelled"}
    for turn in _turns(state):
        status = turn.get("status")
        if status == "inProgress":
            if not allow_active:
                raise _error("DESKTOP_BUSY")
            continue
        if status not in terminal_statuses:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    for environment in state.get("environments") or []:
        if not isinstance(environment, dict) or _normalize_path(str(environment.get("cwd", ""))) != _normalize_path(target["workspaceRoot"]):
            raise _error("DESKTOP_PROJECT_MISMATCH")
    _require(bool(owner), "DESKTOP_NO_OWNER")


def _public_info(state: dict[str, Any], target: dict[str, str], runtime: dict[str, Any], client: _IpcClient) -> dict[str, Any]:
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
        "desktopVersion": runtime["desktopVersion"],
        "appServerVersion": runtime["appServerVersion"],
        "profile": runtime.get("profile"),
        "ownerClientId": client.owner,
    }


@dataclass
class _Prepared:
    target: dict[str, str]
    pipe: _Pipe
    client: _IpcClient
    runtime: dict[str, Any]

    def send(self, message: str) -> dict[str, str]:
        _message(message)
        _query_standard_token()
        current = _verify_runtime(self.pipe, self.target, self.runtime)
        if current["desktopPid"] != self.runtime["desktopPid"] or current["appServerPid"] != self.runtime["appServerPid"]:
            raise _error("DESKTOP_PROCESS_CHANGED")
        self.client.discover()
        state = self.client.snapshot()
        _validate_state(state, self.target, self.client.owner or "")
        _query_standard_token()
        # 提交前最后核对进程、项目与 owner；协议没有原子 idle/start CAS，故保持窗口有界。
        _verify_runtime(self.pipe, self.target, self.runtime)
        self.client.drain(0.1)
        state = self.client.current_state()
        if state is None or self.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_state(state, self.target, self.client.owner or "")
        # 使用最后一次状态观测建立 ACK 防重放集合；初始 snapshot 期间
        # 若已有其他 turn 到达，旧集合不能作为真实新 turn 的依据。
        before_turn_ids = {
            turn.get("turnId")
            for turn in _turns(state)
            if isinstance(turn.get("turnId"), str)
        }
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
        return {"threadId": self.target["threadId"], "turnId": turn_id}

    def close(self) -> None:
        self.pipe.close()


def _prepare(target: dict[str, str], *, allow_active: bool = False,
             require_runner_ancestor: bool = False) -> tuple[_Prepared, dict[str, Any]]:
    _query_standard_token()
    runtime: dict[str, Any] | None = None
    pipe = _Pipe()
    try:
        runtime = _verify_runtime(pipe, target)
        client = _IpcClient(pipe, target["threadId"], target["hostId"])
        client.initialize()
        client.discover()
        state = client.snapshot()
        _validate_state(state, target, client.owner or "", allow_active=allow_active)
        info = _public_info(state, target, runtime, client)
        if allow_active:
            client.drain(0.1)
            state = client.current_state()
            if state is None or client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_state(state, target, client.owner or "", allow_active=True)
            info = _public_info(state, target, runtime, client)
        _verify_runtime(pipe, target, runtime)
        if require_runner_ancestor:
            _verify_current_runner_ancestor(runtime)
        if client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        prepared = _Prepared(target, pipe, client, runtime)
        return prepared, info
    except DesktopIpcError as error:
        try:
            if error.code == "DESKTOP_NO_OWNER" and runtime is not None:
                _verify_runtime(pipe, target, runtime)
        finally:
            pipe.close()
        raise
    except TimeoutError:
        pipe.close()
        raise _error("DESKTOP_IPC_TIMEOUT")
    except (OSError, ValueError, TypeError, KeyError):
        pipe.close()
        raise _error("DESKTOP_INTERNAL_ERROR")


def _current_identity_checked(workspace_root: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    target = _current_target(workspace_root)
    session, info = _prepare(target, allow_active=True, require_runner_ancestor=True)
    try:
        return info, copy.deepcopy(session.runtime)
    finally:
        session.close()


def _same_current_identity(left: dict[str, Any], right: dict[str, Any], left_runtime: dict[str, Any],
                           right_runtime: dict[str, Any]) -> bool:
    for key in ("threadId", "hostId", "projectId", "workspaceRoot", "title", "workspaceKind", "resumeState",
                "ownerClientId", "desktopVersion", "appServerVersion", "profile"):
        if left.get(key) != right.get(key):
            return False
    if _normalize_path(str(left.get("cwd", ""))) != _normalize_path(str(right.get("cwd", ""))):
        return False
    return left_runtime == right_runtime


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
    info, _ = _current_identity_checked(workspace_root)
    return info


def _active_turn_id(state: dict[str, Any]) -> str:
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type not in {"active", "inProgress"}:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    active: list[str] = []
    for turn in _turns(state):
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


def _current_execution(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, _ = _prepare(target, allow_active=True, require_runner_ancestor=True)
    try:
        # 取 prepare 阶段之后仍在窗口内的新鲜状态；不接受环境变量提供的 turnId。
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_state(state, target, session.client.owner or "", allow_active=True)
        # 使用 prepare 时捕获的 runtime 做同一进程/版本复核，避免把新进程或伪造环境当作当前执行。
        _verify_runtime(session.pipe, target, session.runtime)
        _verify_current_runner_ancestor(session.runtime)
        # runtime/runner 核验可能消耗时间；回传前再次确认仍在观测窗口内。
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        active_turn_id = _active_turn_id(state)
        return {
            **_public_info(state, target, session.runtime, session.client),
            "activeTurnId": active_turn_id,
        }
    finally:
        session.close()


def _inspect_active_execution(target: dict[str, str]) -> dict[str, Any]:
    session, _ = _prepare(target, allow_active=True)
    try:
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_state(state, target, session.client.owner or "", allow_active=True)
        _verify_runtime(session.pipe, target, session.runtime)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        active_turn_id = _active_turn_id(state)
        return {
            **_public_info(state, target, session.runtime, session.client),
            "activeTurnId": active_turn_id,
        }
    finally:
        session.close()


def _current_result_context(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, _ = _prepare(target, allow_active=True, require_runner_ancestor=True)
    try:
        # 与 current_execution 一样，在 runtime/runner 核验前后都只使用新鲜快照。
        session.client.drain(0.1)
        state = session.client.current_state()
        if state is None or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_state(state, target, session.client.owner or "", allow_active=True)
        freshness_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        _verify_runtime(session.pipe, target, session.runtime)
        _verify_current_runner_ancestor(session.runtime)
        if session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            if time.monotonic() >= freshness_deadline:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            session.pipe.verify_server()
            previous_serial = session.client.snapshot_serial
            state = session.client.snapshot()
            if session.client.snapshot_serial <= previous_serial:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _verify_runtime(session.pipe, target, session.runtime)
            if (time.monotonic() >= freshness_deadline
                    or session.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_state(state, target, session.client.owner or "", allow_active=True)
        result_turn_id, result_turn_status = _result_turn_context(state)
        return {
            **_public_info(state, target, session.runtime, session.client),
            "resultTurnId": result_turn_id,
            "resultTurnStatus": result_turn_status,
        }
    finally:
        session.close()


def _current_confirm(workspace_root: Any) -> dict[str, Any]:
    before, before_runtime = _current_identity_checked(workspace_root)
    try:
        confirmed = _show_confirmation(before)
    except DesktopIpcError:
        raise
    except Exception:
        confirmed = False
    if confirmed is not True:
        raise _error("DESKTOP_CONFIRMATION_CANCELLED")
    after, after_runtime = _current_identity_checked(workspace_root)
    if not _same_current_identity(before, after, before_runtime, after_runtime):
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
            if not isinstance(request, dict) or set(request) - {"id", "op", "target", "expectation", "message", "workspaceRoot"}:
                raise _error("DESKTOP_INVALID_REQUEST")
            request_id = request.get("id")
            op = request.get("op")
            _require(_uuid(request_id) is not None, "DESKTOP_INVALID_REQUEST")
            if sys.version_info < MIN_PYTHON_VERSION:
                raise _error("DESKTOP_PYTHON_UNSUPPORTED")
            if op == "inspect":
                target = _target(request.get("target"))
                session, info = _prepare(target)
                session.close()
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "reconcile_unknown":
                if set(request) != {"id", "op", "target", "expectation"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True,
                        "value": _reconcile_unknown(request.get("target"), request.get("expectation"))})
            elif op == "compatibility":
                if set(request) != {"id", "op"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _compatibility()})
            elif op == "compatibility_audit":
                if set(request) != {"id", "op"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _compatibility_audit()})
            elif op == "inspect_active_execution":
                if set(request) != {"id", "op", "target"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_active_execution(target)})
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
                prepared, info = _prepare(target)
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
            reply = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                     "code": error.code, "notSent": error.not_sent}
            if hasattr(error, "compatibility"):
                reply["compatibility"] = _safe_compatibility(getattr(error, "compatibility"))
            _reply(reply)
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
