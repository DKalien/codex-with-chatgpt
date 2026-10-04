"""Sacrificial parent for the Windows parent-death E2E (R5f prework).

The parent spawns:

1. the runner child, which starts the daemon through the production spawn
   helper path (``node --import tsx <runner>``) and writes the spawn result;
2. a canary child that never escapes the parent tree.

The parent then records the canary pid and STAYS ALIVE until the test kills
the whole tree with ``taskkill /T /F``.  A self-managed kill-on-close Job
cannot be created inside sandboxed environments (SetInformationJobObject with
KILL_ON_JOB_CLOSE is rejected kernel-side with ERROR_INVALID_PARAMETER for
in-job, breakaway-relayed and WMI-relayed callers alike), so the job-escape
property is verified by the test through ``IsProcessInJob(daemon) == False``;
the canary death proves the tree kill actually fired.  The daemon - which
escaped via the helper's breakaway/WMI path - must survive.

Usage:
  python daemon_parent_death_parent.py <runner-cmd-json> <info-file> <timeout-seconds>

Exit codes:
  0 = runner exited cleanly and info was written (parent then waited to be killed)
  2 = usage error
  4 = runner wait error
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def _detect_in_job() -> "bool | None":
    """IsProcessInJob(GetCurrentProcess())；非 Windows 或探测失败返回 None。"""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.IsProcessInJob.restype = wintypes.BOOL
        kernel32.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        in_job = wintypes.BOOL(0)
        if not kernel32.IsProcessInJob(kernel32.GetCurrentProcess(), None, ctypes.byref(in_job)):
            return None
        return bool(in_job.value)
    except Exception:  # noqa: BLE001 - 探测失败按"无法判定"处理
        return None


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("usage: <runner-cmd-json> <info-file> <timeout-seconds>\n")
        return 2
    runner_cmd = json.loads(argv[0])
    info_file = Path(argv[1])
    timeout_seconds = float(argv[2])

    runner = subprocess.Popen(runner_cmd, cwd=Path(__file__).resolve().parents[2])
    canary = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdin=subprocess.DEVNULL,
    )
    try:
        runner_code = runner.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        runner.kill()
        return 4
    # The runner wrote the daemon result file itself; record the canary pid
    # and the parent's own job membership for the test, then stay alive so the
    # test can kill the tree with taskkill /T /F and observe who survives.
    info_file.write_text(
        json.dumps(
            {
                "parentPid": os.getpid(),
                "canaryPid": canary.pid,
                "runnerCode": runner_code,
                "parentInJob": _detect_in_job(),
            }
        ),
        encoding="utf-8",
    )
    if runner_code != 0:
        return 4
    # Bounded wait: normally the test kills us within seconds; this only keeps
    # a failed test from hanging forever.
    time.sleep(min(timeout_seconds, 60.0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
