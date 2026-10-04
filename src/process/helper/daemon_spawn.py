"""Detached daemon spawn helper (Windows Job escape).

``ensureBridge`` spawns the bridge daemon that must outlive its parent CLI
process.  On Windows a spawner inside a Job Object (kill-on-close) also kills
detached children via inherited Job membership, which is how closing Codex
could take the daemon down.  This helper escapes in two layers:

1. ``CREATE_BREAKAWAY_FROM_JOB``: cheap and keeps full env/stdio semantics;
   ignored when the caller is not in a Job, denied when the Job forbids it.
2. WMI ``Win32_Process.Create`` relay: the process is created by the WMI
   service host (documented as NOT joining the caller's Job), which also breaks
   the ``taskkill /T`` parent-chain.  The relay re-spawns the daemon detached
   with real file-handle redirection, reports the pid via a result file and
   exits, leaving the daemon with no live parent link.

Protocol (single JSON line on stdout):
  {"ok": true,  "pid": N, "mode": "breakaway" | "wmi" | "posix", "in_job": true|false|null}
  {"ok": false, "code": "...", "message": "...", "in_job": true|false|null}

``in_job`` reports IsProcessInJob(GetCurrentProcess()) for the helper itself
(a direct child of the Node caller, so it shares the caller's Job membership).
``null`` means membership could not be safely determined.  The Node caller
must fail closed when a spawn attempt failed and ``in_job`` is not ``false``:
a silent "helper failed -> direct detached -> success" would claim lifetime
independence the daemon does not actually have inside a kill-on-close Job.

The full daemon environment is handed over through ``--env-file`` (JSON map,
mode 0600).  Ownership of the file: main/posix modes delete it right after the
daemon is created; relay mode deletes it right after reading; if the helper
crashes before any spawn, the Node caller deletes it in a finally block.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000

WMI_RESULT_TIMEOUT_SECONDS = 20.0
WMI_POLL_INTERVAL_SECONDS = 0.25

IS_WINDOWS = sys.platform == "win32"


def _probe_process_impl(pid: int, expected_creation: str | None = None) -> dict:
    """Read-only observation. All Windows fields come from one non-inheritable HANDLE."""
    result = {"pid": pid, "status": "unknown", "executable": None,
              "creationTime": None, "inAnyJob": None,
              "errors": {key: None for key in ("process", "executable", "creationTime", "inAnyJob")},
              "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        result["errors"]["process"] = "INVALID_PID"
        return result
    if not IS_WINDOWS:
        result["errors"]["inAnyJob"] = "UNSUPPORTED"
        try:
            os.kill(pid, 0)
            if sys.platform.startswith("linux"):
                # Start ticks plus boot ID distinguish PID reuse without wall-clock rounding.
                def creation():
                    stat = Path(f"/proc/{pid}/stat").read_text()
                    return Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + stat.rsplit(")", 1)[1].split()[19]
                before = creation()
                result["executable"] = os.readlink(f"/proc/{pid}/exe")
                after = creation()
                if before != after or (expected_creation is not None and after != expected_creation):
                    raise ValueError("changed")
                result["creationTime"] = after
                result["status"] = "identified"
            else:
                result["errors"].update(executable="UNSUPPORTED", creationTime="UNSUPPORTED")
        except (ProcessLookupError, FileNotFoundError):
            result.update(status="missing", executable=None, creationTime=None)
            result["errors"]["process"] = "PID_MISSING"
        except Exception:
            result.update(executable=None, creationTime=None)
            result["errors"]["process"] = "PROBE_UNAVAILABLE"
        return result
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel32.IsProcessInJob.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000 | 0x100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    if not handle:
        code = ctypes.get_last_error()
        result["status"] = "missing" if code == 87 else "unknown"
        result["errors"] = {key: f"WIN32_{code}" for key in result["errors"]}
        return result
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if kernel32.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            result["creationTime"] = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
        else:
            result["errors"]["creationTime"] = f"WIN32_{ctypes.get_last_error()}"
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            result["executable"] = buffer.value
        else:
            result["errors"]["executable"] = f"WIN32_{ctypes.get_last_error()}"
        in_job = wintypes.BOOL()
        if kernel32.IsProcessInJob(handle, None, ctypes.byref(in_job)):
            result["inAnyJob"] = bool(in_job.value)
        else:
            result["errors"]["inAnyJob"] = f"WIN32_{ctypes.get_last_error()}"
        exit_code = wintypes.DWORD()
        wait = kernel32.WaitForSingleObject(handle, 0)
        if expected_creation is not None and result["creationTime"] != expected_creation:
            result["errors"]["process"] = "IDENTITY_CHANGED"
        elif wait == 0:
            result["status"] = "missing"
            result["errors"]["process"] = "PID_EXITED"
        elif wait != 258:  # WAIT_TIMEOUT is the only live observation; exit code 259 alone is ambiguous.
            result["errors"]["process"] = "PROBE_UNAVAILABLE"
        elif not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            result["errors"]["process"] = f"WIN32_{ctypes.get_last_error()}"
        elif exit_code.value != 259:
            # Termination is asynchronous. Exit code alone is NOT completion:
            # the same HANDLE must be signaled before this PID can be called missing.
            result["errors"]["process"] = "PROBE_UNAVAILABLE"
        elif result["creationTime"] and result["executable"]:
            result["status"] = "identified"
        if result["errors"]["process"]:
            result.update(executable=None, creationTime=None, inAnyJob=None)
        return result
    finally:
        kernel32.CloseHandle(handle)


def _probe_process(pid: int, expected_creation: str | None = None) -> dict:
    try:
        return _probe_process_impl(pid, expected_creation)
    except Exception:
        # A diagnostic failure after spawn must NEVER trigger another spawn.
        return {"pid": pid, "status": "unknown", "executable": None, "creationTime": None,
                "inAnyJob": None, "errors": {key: "PROBE_UNAVAILABLE" for key in
                                             ("process", "executable", "creationTime", "inAnyJob")},
                "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}


def _spawn_evidence(pid: int) -> dict:
    return {"final_probe": _probe_process(pid), "spawner_probe": _probe_process(os.getppid()),
            "helper_probe": _probe_process(os.getpid())}


def _detect_in_job() -> "bool | None":
    """IsProcessInJob(GetCurrentProcess(), None, &in_job)；无法安全判定时返回 None。"""
    if not IS_WINDOWS:
        return None  # 非 Windows 无 Job Object 概念
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # GetCurrentProcess 伪句柄（-1）必须以完整 64 位句柄传递；ctypes 默认
        # int restype 会截断成无效句柄，令 IsProcessInJob 静默失败并误报 null，
        # 进而让调用方 fail-closed 策略永远拿不到确定性的 in_job。
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.IsProcessInJob.restype = wintypes.BOOL
        kernel32.IsProcessInJob.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
        ]
        in_job = wintypes.BOOL(0)
        if kernel32.IsProcessInJob(
            kernel32.GetCurrentProcess(), None, ctypes.byref(in_job)
        ) == 0:
            return None
        return bool(in_job.value)
    except Exception:  # noqa: BLE001 - 探测失败按"无法判定"处理
        return None


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _read_env_file(path: str) -> dict:
    env = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(env, dict):
        raise ValueError("env file 不是 JSON 对象")
    return {str(key): str(value) for key, value in env.items()}


def _delete_env_file(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _parse_options(argv: list[str]) -> tuple[dict, list[str]]:
    options: dict = {"relay": False}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--":
            command = argv[index + 1 :]
            if "env_file" not in options or "log" not in options:
                raise ValueError("--env-file 与 --log 必须提供")
            options.setdefault("cwd", os.getcwd())
            options.setdefault("result_file", f"{options['env_file']}.result")
            return options, command
        if arg == "--relay":
            options["relay"] = True
            index += 1
        elif arg == "--log":
            options["log"] = argv[index + 1]
            index += 2
        elif arg == "--env-file":
            options["env_file"] = argv[index + 1]
            index += 2
        elif arg == "--cwd":
            options["cwd"] = argv[index + 1]
            index += 2
        elif arg == "--result-file":
            options["result_file"] = argv[index + 1]
            index += 2
        else:
            raise ValueError(f"未知参数：{arg}")
    raise ValueError("缺少 -- 命令分隔符")


def _open_log(path: str):
    handle = open(path, "ab")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # 文件系统不支持 chmod 语义时保持原样
    return handle


def _spawn_detached(command: list[str], log_path: str, env: dict,
                    cwd: str, creationflags: int) -> int:
    with _open_log(log_path) as log:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env=env,
            creationflags=creationflags,
            close_fds=True,
        )
        return process.pid


def _write_result(path: str, payload: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload))


def _windows_argv_quote(argument: str) -> str:
    # MSVCRT/CommandLineToArgvW 规则：只有紧邻双引号的反斜杠串需要翻倍——
    # 内嵌引号前为 2n+1（n 个字面反斜杠 + 转义引号），结尾引号前为 2n；
    # 其余反斜杠必须原样保留，否则 argv 中的路径会被改成双倍分隔符。
    if argument and not any(ch in argument for ch in ' \t"'):
        return argument
    parts = ['"']
    backslashes = 0
    for ch in argument:
        if ch == "\\":
            backslashes += 1
        elif ch == '"':
            parts.append("\\" * (backslashes * 2 + 1) + '"')
            backslashes = 0
        else:
            if backslashes:
                parts.append("\\" * backslashes)
                backslashes = 0
            parts.append(ch)
    parts.append("\\" * (backslashes * 2))
    parts.append('"')
    return "".join(parts)


def _ps_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _wmi_create(command_line: str, cwd: str) -> int:
    # Invoke-CimMethod 对嵌入式 Win32_ProcessStartup 参数报类型不匹配；
    # [wmiclass] 加速器（Windows PowerShell 5.1）是可靠路径。
    script = (
        "$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); "
        "$startup.ShowWindow = 0; "
        "$wmi = [wmiclass]'Win32_Process'; "
        f"$r = $wmi.Create({_ps_quote(command_line)}, {_ps_quote(cwd)}, $startup); "
        'Write-Output ("{0} {1}" -f $r.ReturnValue, $r.ProcessId)'
    )
    result = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
         "-ExecutionPolicy", "Bypass", "-Command", script],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", timeout=60,
        creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0, close_fds=True,
    )
    lines = f"{result.stdout}\n{result.stderr}".strip().splitlines()
    for line in reversed(lines):
        parts = line.strip().split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            return_value, process_id = int(parts[0]), int(parts[1])
            if return_value != 0:
                raise OSError(f"WMI Win32_Process.Create 返回 {return_value}")
            return process_id
    raise OSError(f"WMI 输出无法解析：{''.join(result.stderr.split())[:200]}")


def _spawn_via_wmi_relay(options: dict, command: list[str]) -> int:
    script = str(Path(__file__).resolve())
    result_file = options["result_file"]
    try:
        os.remove(result_file)
    except OSError:
        pass
    relay_argv = [sys.executable, "-I", "-B", "-X", "utf8", script, "--relay",
                  "--log", options["log"], "--env-file", options["env_file"],
                  "--cwd", options["cwd"], "--result-file", result_file,
                  "--"] + list(command)
    command_line = " ".join(_windows_argv_quote(part) for part in relay_argv)
    _wmi_create(command_line, options["cwd"])
    deadline = time.monotonic() + WMI_RESULT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            payload = json.loads(Path(result_file).read_text(encoding="utf-8"))
            _delete_env_file(result_file)
            if payload.get("ok") is True:
                return int(payload["pid"])
            raise OSError(str(payload.get("message") or "relay spawn 失败"))
        except FileNotFoundError:
            time.sleep(WMI_POLL_INTERVAL_SECONDS)
        except (ValueError, KeyError, TypeError) as error:
            raise OSError(f"relay result 无效：{error}") from error
    raise TimeoutError("relay result 超时")


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--probe-pid":
        if len(argv) not in (2, 3) or not argv[1].isdigit() or not 0 < int(argv[1]) <= 0xFFFFFFFF:
            _emit({"ok": False, "code": "bad_usage"})
            return 2
        _emit(_probe_process(int(argv[1]), argv[2] if len(argv) == 3 else None))
        return 0
    try:
        options, command = _parse_options(argv)
    except (ValueError, IndexError) as error:
        _emit({"ok": False, "code": "bad_usage", "message": str(error)})
        return 2
    if not command:
        _emit({"ok": False, "code": "bad_usage", "message": "缺少 daemon 命令"})
        return 2

    if options["relay"]:
        # relay 是独立进程：读取后立即删除 env 文件，不留给任何后续进程。
        try:
            env = _read_env_file(options["env_file"])
            _delete_env_file(options["env_file"])
            pid = _spawn_detached(command, options["log"], env, options["cwd"],
                                  DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                                  if IS_WINDOWS else 0)
        except Exception as error:  # noqa: BLE001 - 通过 result file 上报
            _write_result(options["result_file"],
                          {"ok": False, "message": str(error)})
            return 1
        _write_result(options["result_file"], {"ok": True, "pid": pid})
        return 0

    try:
        env = _read_env_file(options["env_file"])
    except Exception as error:  # noqa: BLE001
        _emit({"ok": False, "code": "bad_env_file", "message": str(error),
               "in_job": _detect_in_job()})
        return 2

    if IS_WINDOWS:
        in_job = _detect_in_job()
        try:
            pid = _spawn_detached(command, options["log"], env, options["cwd"],
                                  DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                                  | CREATE_BREAKAWAY_FROM_JOB)
            _delete_env_file(options["env_file"])
            _emit({"ok": True, "pid": pid, "mode": "breakaway", "in_job": in_job, **_spawn_evidence(pid)})
            return 0
        except OSError as breakaway_error:
            first_error = str(breakaway_error)
        try:
            pid = _spawn_via_wmi_relay(options, command)
            # env 文件由 relay 删除；此处兜底（relay 已删时为 no-op）。
            _delete_env_file(options["env_file"])
            _emit({"ok": True, "pid": pid, "mode": "wmi", "in_job": in_job, **_spawn_evidence(pid)})
            return 0
        except Exception as wmi_error:  # noqa: BLE001 - 协议层统一报告
            _emit({"ok": False, "code": "spawn_failed",
                   "message": f"breakaway: {first_error}; wmi: {wmi_error}",
                   "in_job": in_job})
            return 1

    try:
        pid = _spawn_detached(command, options["log"], env, options["cwd"], 0)
    except OSError as error:
        _emit({"ok": False, "code": "spawn_failed", "message": str(error)})
        return 1
    _delete_env_file(options["env_file"])
    _emit({"ok": True, "pid": pid, "mode": "posix", **_spawn_evidence(pid)})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:  # noqa: BLE001 - helper 协议之外不输出 traceback
        _emit({"ok": False, "code": "helper_crash", "message": str(error)})
        raise SystemExit(1)
