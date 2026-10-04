"""Windows process, token and current workspace identity checks."""

from __future__ import annotations

import ctypes
import json
import os
import re
from pathlib import Path
from ctypes import wintypes
from typing import Any

from .common import (
    DesktopIpcError,
    _error,
    _normalize_path,
    _uuid,
)
from .transport import (
    PROCESS_QUERY_LIMITED_INFORMATION,
    _HANDLE,
    _Pipe,
    _handle_value,
    _kernel32,
    _query_image_path,
    _valid_handle,
)

TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20
TOKEN_ELEVATION_TYPE = 18
TOKEN_INTEGRITY_LEVEL = 25
ELEVATION_TYPE_DEFAULT = 1
ELEVATION_TYPE_FULL = 2
ELEVATION_TYPE_LIMITED = 3
SECURITY_MANDATORY_MEDIUM_RID = 0x2000
SECURITY_MANDATORY_LABEL_AUTHORITY = 16
_DECIMAL_UINT64 = re.compile(r"[1-9][0-9]*\Z")
_MAX_UINT64 = (1 << 64) - 1
_MAX_PID = (1 << 32) - 1
_RUNTIME_FENCE_KEYS = frozenset({
    "desktopPid", "desktopExe", "desktopCreation", "appServerPid", "appServerExe", "appServerCreation",
})


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
            # Keep every parent row so a codex process launched through an
            # intermediate executable can still be tied to its ChatGPT root.
            pid = int(entry.th32ProcessID)
            parent = int(entry.th32ParentProcessID)
            exe = ""
            creation = 0
            process = None
            if name.casefold() in {"chatgpt.exe", "codex.exe"}:
                process = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if process is not None and _valid_handle(process):
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


def _ancestor_chain(pid: int, parents: dict[int, int]) -> set[int]:
    chain: set[int] = set()
    current = pid
    for _ in range(64):
        if current in chain:
            break
        chain.add(current)
        parent = parents.get(current)
        if parent is None or parent == current:
            break
        current = parent
    return chain


def _verify_current_runner_ancestor(process: dict[str, Any]) -> None:
    expected = process.get("appServerPid")
    if type(expected) is not int or expected <= 0:
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    parents = _process_parent_ids()
    if expected in _ancestor_chain(os.getpid(), parents):
        return
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


def _decode_runtime_fence(value: Any) -> dict[str, Any]:
    """Decode the wire fence without allowing JSON numbers for FILETIME."""
    if not isinstance(value, dict) or frozenset(value) != _RUNTIME_FENCE_KEYS:
        raise _error("DESKTOP_INVALID_REQUEST")
    for key in ("desktopPid", "appServerPid"):
        pid = value.get(key)
        if type(pid) is not int or not 0 < pid <= _MAX_PID:
            raise _error("DESKTOP_INVALID_REQUEST")
    for key in ("desktopExe", "appServerExe"):
        exe = value.get(key)
        if not isinstance(exe, str) or not exe or "\x00" in exe:
            raise _error("DESKTOP_INVALID_REQUEST")
    result: dict[str, Any] = {
        "desktopPid": value["desktopPid"],
        "desktopExe": value["desktopExe"],
        "appServerPid": value["appServerPid"],
        "appServerExe": value["appServerExe"],
    }
    for key in ("desktopCreation", "appServerCreation"):
        creation = value.get(key)
        if (not isinstance(creation, str) or len(creation) > 20 or _DECIMAL_UINT64.fullmatch(creation) is None
                or int(creation) > _MAX_UINT64):
            raise _error("DESKTOP_INVALID_REQUEST")
        result[key] = int(creation)
    return result


def _encode_runtime_fence(value: dict[str, Any]) -> dict[str, Any]:
    """Encode a checked process fence with lossless decimal FILETIME strings."""
    try:
        decoded = _decode_runtime_fence({
            "desktopPid": value["desktopPid"],
            "desktopExe": value["desktopExe"],
            "desktopCreation": str(value["desktopCreation"]),
            "appServerPid": value["appServerPid"],
            "appServerExe": value["appServerExe"],
            "appServerCreation": str(value["appServerCreation"]),
        })
    except (DesktopIpcError, KeyError, TypeError, ValueError):
        raise _error("DESKTOP_PROCESS_CHANGED")
    return {
        "desktopPid": decoded["desktopPid"],
        "desktopExe": decoded["desktopExe"],
        "desktopCreation": str(decoded["desktopCreation"]),
        "appServerPid": decoded["appServerPid"],
        "appServerExe": decoded["appServerExe"],
        "appServerCreation": str(decoded["appServerCreation"]),
    }
def _verify_process_identity(
    pipe: _Pipe,
    target: dict[str, str],
    expected: dict[str, Any] | None = None,
    require_runner_ancestor: bool = False,
) -> dict[str, Any]:
    """核对 pipe 对端及其进程树；不读取版本或 bundle。"""
    pipe.verify_server()
    rows = _processes()
    server = next((row for row in rows if row["pid"] == pipe.server_pid), None)
    if not server or server["name"].casefold() != "chatgpt.exe" or not server["exe"] or server["creation"] <= 0:
        raise _error("DESKTOP_IPC_SERVER_MISMATCH")
    if _normalize_path(server["exe"]) != _normalize_path(pipe.server_exe):
        raise _error("DESKTOP_PROCESS_CHANGED" if expected is not None else "DESKTOP_IPC_SERVER_MISMATCH")
    parents = {int(row["pid"]): int(row["parentPid"]) for row in rows
               if isinstance(row.get("pid"), int) and isinstance(row.get("parentPid"), int)
               and row["pid"] > 0 and row["parentPid"] > 0}
    candidates = [row for row in rows
                  if row["name"].casefold() == "codex.exe"
                  and row.get("exe") and row.get("creation", 0) > 0
                  and pipe.server_pid in _ancestor_chain(int(row["pid"]), parents)]

    # An existing fence always wins candidate discovery.  A restarted
    # app-server must fail closed even when another codex is available.
    if expected is not None:
        app_server = next((row for row in candidates if row["pid"] == expected.get("appServerPid")), None)
        if app_server is None:
            raise _error("DESKTOP_PROCESS_CHANGED")
    elif require_runner_ancestor:
        runner_pid = os.getpid()
        runner_chain = _ancestor_chain(runner_pid, parents) if runner_pid in parents else set()
        owned = [row for row in candidates if row["pid"] in runner_chain]
        if len(owned) != 1:
            raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
        app_server = owned[0]
    elif len(candidates) == 1:
        app_server = candidates[0]
    else:
        raise _error("DESKTOP_PROCESS_CHANGED")

    if expected and (
        expected.get("desktopPid") != pipe.server_pid
        or expected.get("appServerPid") != app_server["pid"]
        or expected.get("desktopCreation") != server["creation"]
        or expected.get("appServerCreation") != app_server["creation"]
        or _normalize_path(str(expected.get("desktopExe", ""))) != _normalize_path(server["exe"])
        or _normalize_path(str(expected.get("appServerExe", ""))) != _normalize_path(app_server["exe"])
    ):
        raise _error("DESKTOP_PROCESS_CHANGED")
    if require_runner_ancestor:
        runner_pid = os.getpid()
        if runner_pid not in parents or app_server["pid"] not in _ancestor_chain(runner_pid, parents):
            raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    _verify_project(target)
    return {
        "desktopPid": pipe.server_pid,
        "desktopExe": server["exe"],
        "desktopCreation": server["creation"],
        "appServerPid": app_server["pid"],
        "appServerExe": app_server["exe"],
        "appServerCreation": app_server["creation"],
    }
