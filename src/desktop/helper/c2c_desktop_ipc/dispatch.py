"""stdin operation dispatch for the Desktop IPC helper."""

from __future__ import annotations

import json
import sys
from typing import Any

from .common import (
    DesktopIpcError,
    MAX_CONTROL_LINE_BYTES,
    MIN_PYTHON_VERSION,
    _error,
    _message,
    _require,
    _target,
    _uuid,
)
from .identity import _decode_runtime_fence
from .operations import (
    _Prepared,
    _current_confirm,
    _current_identity,
    _diagnose,
    _prepare,
    _reconcile_unknown,
)
from .result import (
    _current_execution,
    _inspect_active_execution,
    _inspect_result_activity_marker,
    _inspect_result_context,
    _inspect_result_ownership,
    _inspect_result_terminal_fence,
    _current_result_classification,
    _current_result_context,
    _current_result_ownership,
)

def _require_runtime_fence(request: dict[str, Any]) -> None:
    if "runtimeFence" not in request:
        raise _error("DESKTOP_RUNTIME_FENCE_MISSING")

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
            if not isinstance(request, dict) or set(request) - {"id", "op", "target", "expectation", "message", "workspaceRoot", "marker", "runtimeFence"}:
                raise _error("DESKTOP_INVALID_REQUEST")
            request_id = request.get("id")
            op = request.get("op")
            _require(_uuid(request_id) is not None, "DESKTOP_INVALID_REQUEST")
            if "runtimeFence" in request:
                _decode_runtime_fence(request["runtimeFence"])
            if sys.version_info < MIN_PYTHON_VERSION:
                raise _error("DESKTOP_PYTHON_UNSUPPORTED")
            if op == "inspect_for_binding":
                if set(request) != {"id", "op", "target"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                session, info = _prepare(target, purpose="observe", include_runtime_fence=True)
                try:
                    _reply({"id": request_id, "ok": True, "value": info})
                finally:
                    session.close()
            elif op == "inspect":
                if set(request) not in ({"id", "op", "target"}, {"id", "op", "target", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                session, info = _prepare(target, purpose="observe", runtime_fence=request["runtimeFence"])
                session.close()
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "reconcile_unknown":
                if set(request) not in ({"id", "op", "target", "expectation"}, {"id", "op", "target", "expectation", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                _reply({"id": request_id, "ok": True,
                        "value": _reconcile_unknown(request.get("target"), request.get("expectation"),
                                                     runtime_fence=request["runtimeFence"])})
            elif op == "diagnose":
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _diagnose(request.get("workspaceRoot"))})
            elif op == "inspect_active_execution":
                if set(request) not in ({"id", "op", "target"}, {"id", "op", "target", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_active_execution(
                    target, runtime_fence=request["runtimeFence"])})
            elif op == "inspect_result_context":
                if set(request) not in ({"id", "op", "target"}, {"id", "op", "target", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_result_context(
                    target, runtime_fence=request["runtimeFence"])})
            elif op == "inspect_result_activity_marker":
                if set(request) not in ({"id", "op", "target"}, {"id", "op", "target", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True, "value": _inspect_result_activity_marker(
                    target, runtime_fence=request["runtimeFence"])})
            elif op == "inspect_result_terminal_fence":
                if set(request) not in ({"id", "op", "target", "marker"}, {"id", "op", "target", "marker", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True,
                        "value": _inspect_result_terminal_fence(target, request.get("marker"),
                                                                 runtime_fence=request["runtimeFence"])})
            elif op == "current_result_ownership":
                if set(request) != {"id", "op", "workspaceRoot", "expectation"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True,
                        "value": _current_result_ownership(request.get("workspaceRoot"), request.get("expectation"))})
            elif op == "inspect_pending_receipt":
                if set(request) != {"id", "op", "target", "expectation", "marker", "runtimeFence"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require(isinstance(request["marker"], dict), "DESKTOP_INVALID_REQUEST")
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True,
                        "value": _inspect_result_ownership(target, request.get("expectation"),
                                                            marker_value=request["marker"],
                                                            runtime_fence=request["runtimeFence"])})
            elif op == "inspect_result_ownership":
                if set(request) not in ({"id", "op", "target", "expectation"}, {"id", "op", "target", "expectation", "runtimeFence"}) or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _require_runtime_fence(request)
                target = _target(request.get("target"))
                _reply({"id": request_id, "ok": True,
                        "value": _inspect_result_ownership(target, request.get("expectation"),
                                                            runtime_fence=request["runtimeFence"])})
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
                if set(request) not in ({"id", "op", "target"}, {"id", "op", "target", "runtimeFence"}):
                    raise _error("DESKTOP_INVALID_REQUEST")
                if prepared is not None:
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                target = _target(request.get("target"))
                _require_runtime_fence(request)
                prepared, info = _prepare(target, purpose="send", runtime_fence=request["runtimeFence"])
                _reply({"id": request_id, "ok": True, "value": info})
            elif op == "send":
                if set(request) != {"id", "op", "message"}:
                    raise _error("DESKTOP_INVALID_REQUEST")
                if prepared is None:
                    raise _error("DESKTOP_IPC_UNAVAILABLE")
                value = _message(request.get("message"))
                if send_attempted:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                # 单个 helper 生命周期最多进入一次真实 start；预检查失败也不重试。
                send_attempted = True
                _reply({"id": request_id, "ok": True, "value": prepared.send(value)})
            elif op == "close":
                if set(request) != {"id", "op"}:
                    raise _error("DESKTOP_INVALID_REQUEST")
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


# Public package entry.
main = _main


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except Exception:
        # 不把底层路径、正文或 traceback 输出到 helper 协议之外。
        raise SystemExit(1)
