"""Test-only exact process teardown. Never terminate by a re-opened/raw PID."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys


def validate(identity, runner_pid):
    if not isinstance(identity, dict) or set(identity) != {"pid", "creationTime", "executable"}:
        raise ValueError("invalid fixture identity")
    pid = identity["pid"]
    if type(pid) is not int or not 0 < pid <= 0xffffffff or pid in (os.getpid(), runner_pid):
        raise ValueError("invalid fixture PID")
    if not isinstance(identity["creationTime"], str) or not identity["creationTime"]:
        raise ValueError("missing creation identity")
    if not isinstance(identity["executable"], str) or not identity["executable"]:
        raise ValueError("missing executable identity")


def stop_windows(identity, runner_pid, kernel=None, last_error=None, timeout_ms=10_000):
    validate(identity, runner_pid)
    if not identity["creationTime"].isdigit() or not 0 < timeout_ms <= 10_000:
        raise ValueError("invalid Windows identity/wait budget")
    kernel = kernel if kernel is not None else ctypes.WinDLL("kernel32", use_last_error=True)
    last_error = last_error or ctypes.get_last_error
    signatures = {
        "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
        "QueryFullProcessImageNameW": ([wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = args, result
    # One non-inheritable handle grants query + synchronize + terminate. It pins the object,
    # so even PID reuse between verification and termination cannot hit the replacement.
    handle = kernel.OpenProcess(0x1000 | 0x100000 | 0x0001, False, identity["pid"])
    if not handle:
        code = last_error()
        if code == 87:  # ERROR_INVALID_PARAMETER: PID no longer exists.
            return "missing"
        raise RuntimeError(f"open_unknown:WIN32_{code}")
    try:
        state = kernel.WaitForSingleObject(handle, 0)
        if state == 0:
            return "missing"
        if state != 258:
            raise RuntimeError("wait_unknown")
        creation, exited, system, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(x) for x in (creation, exited, system, user))):
            code = last_error()
            if kernel.WaitForSingleObject(handle, timeout_ms) == 0:
                return "missing"
            raise RuntimeError(f"creation_unknown:WIN32_{code}")
        actual_creation = str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
        if actual_creation != identity["creationTime"]:
            raise RuntimeError("fixture_identity_mismatch")
        executable = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(executable))
        if not kernel.QueryFullProcessImageNameW(handle, 0, executable, ctypes.byref(size)):
            code = last_error()
            if kernel.WaitForSingleObject(handle, timeout_ms) == 0:
                return "missing"
            raise RuntimeError(f"executable_unknown:WIN32_{code}")
        # Exact values from the same WinAPI used by the spawn probe; no fuzzy path matching.
        if executable.value != identity["executable"]:
            raise RuntimeError("fixture_identity_mismatch")
        if not kernel.TerminateProcess(handle, 1):
            code = last_error()
            # Windows can deny query/terminate during natural exit before the handle
            # signals. Wait on that same object; never retry a signal or reinterpret EPERM.
            if kernel.WaitForSingleObject(handle, timeout_ms) == 0:
                return "missing"  # The identified original exited during termination.
            raise RuntimeError(f"terminate_unknown:WIN32_{code}")
        if kernel.WaitForSingleObject(handle, timeout_ms) != 0:
            raise RuntimeError("fixture_exit_not_proven")
        return "exited"
    finally:
        if not kernel.CloseHandle(handle):
            raise RuntimeError("close_handle_failed")


def stop_linux(identity, runner_pid):
    """Linux pidfd is the analogous retained process object; no signal-by-PID fallback."""
    import importlib.util
    import select
    import signal
    validate(identity, runner_pid)
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("exact_teardown_unsupported")
    try:
        fd = os.pidfd_open(identity["pid"])
    except ProcessLookupError:
        return "missing"
    try:
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        if poll.poll(0):
            return "missing"
        spec = importlib.util.spec_from_file_location("daemon_probe", Path(__file__).resolve().parents[1] / "src/process/helper/daemon_spawn.py")
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        current = probe._probe_process(identity["pid"], identity["creationTime"])
        if current["status"] != "identified" or any(current[key] != identity[key] for key in identity):
            raise RuntimeError("fixture_identity_unknown_or_mismatch")
        try:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        except ProcessLookupError:
            return "missing"
        if not poll.poll(10_000):
            raise RuntimeError("fixture_exit_not_proven")
        return "exited"
    finally:
        os.close(fd)


if __name__ == "__main__":
    identity, runner = json.loads(sys.argv[1]), int(sys.argv[2])
    if sys.platform == "win32":
        status = stop_windows(identity, runner)
    elif sys.platform == "linux":
        status = stop_linux(identity, runner)
    else:
        raise RuntimeError("exact_teardown_unsupported")
    print(json.dumps({"status": status}))
