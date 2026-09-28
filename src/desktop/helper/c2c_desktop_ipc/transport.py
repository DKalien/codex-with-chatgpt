"""Named-pipe framing and app-server transport for Desktop IPC helper."""

from __future__ import annotations

import atexit
import copy
import ctypes
import json
import math
import os
import struct
import time
import uuid
from ctypes import wintypes
from typing import Any

from .common import (
    DesktopIpcError,
    DISCOVERY_TIMEOUT_SECONDS,
    INITIALIZE_TIMEOUT_SECONDS,
    MAX_INBOUND_FRAME_BYTES,
    MAX_OBSERVATION_AGE_SECONDS,
    MAX_OUTBOUND_FRAME_BYTES,
    MAX_PIPE_READ_BYTES,
    PIPE_NAME,
    REQUEST_VERSIONS,
    SNAPSHOT_TIMEOUT_SECONDS,
    WRITE_TIMEOUT_SECONDS,
    _error,
    _json_bytes,
    _normalize_path,
    _uuid,
)

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
            if not 0 < size <= MAX_INBOUND_FRAME_BYTES:
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
        if not isinstance(data, bytes) or len(data) > MAX_OUTBOUND_FRAME_BYTES + 4:
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
        if change_type == "snapshot":
            state = change.get("conversationState")
            revision = change.get("revision")
            if not isinstance(state, dict) or type(revision) is not int:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            if old and revision < old[1]:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            # 陈旧度以"接收处理完成"为基准：解析/深拷贝大 snapshot 的耗时
            # 是观察者自身开销，不应计入 freshness 窗口；否则大历史会因
            # 客户端处理慢被误判为状态不可用。
            state_copy = copy.deepcopy(state)
            received_done = time.monotonic()
            self.snapshot_serial += 1
            self.snapshot_meta[source] = (self.snapshot_serial, received_done)
            self.states[source] = (state_copy, revision, received_done)
            self.state_change_kind = "snapshot"
        elif change_type == "patches" and old:
            revision = change.get("revision")
            if change.get("baseRevision") != old[1] or type(revision) is not int or revision <= old[1] or not isinstance(change.get("patches"), list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            patched_state = _patch_state(old[0], change["patches"])
            self.states[source] = (patched_state, revision, time.monotonic())
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
