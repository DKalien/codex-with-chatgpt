"""Report whether a PID is inside any Job Object (Windows-only probe).

Usage:
  python daemon_job_membership_probe.py <pid>

Prints a single JSON line: {"ok": true, "inJob": bool} on success, or
{"ok": false, "error": <last-error>} on failure.  Exit code 0 = probe ran
and the process is not in any job; 1 = probe failed or process is in a job
(the test asserts on the JSON, not on the exit code).
"""

from __future__ import annotations

import json
import sys

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        sys.stderr.write("usage: <pid>\n")
        return 2
    pid = int(argv[0])
    if sys.platform != "win32":
        print(json.dumps({"ok": False, "error": "not-windows"}))
        return 1
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.IsProcessInJob.restype = wintypes.BOOL
    kernel32.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        print(json.dumps({"ok": False, "error": ctypes.get_last_error()}))
        return 1
    in_job = wintypes.BOOL(0)
    ok = kernel32.IsProcessInJob(handle, None, ctypes.byref(in_job))
    error = ctypes.get_last_error()
    kernel32.CloseHandle(handle)
    if not ok:
        print(json.dumps({"ok": False, "error": error}))
        return 1
    print(json.dumps({"ok": True, "inJob": bool(in_job.value)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
