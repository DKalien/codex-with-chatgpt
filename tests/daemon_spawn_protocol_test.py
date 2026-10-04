"""Protocol tests for the daemon spawn helper (src/process/helper/daemon_spawn.py).

Usage: python tests/daemon_spawn_protocol_test.py

Argv quoting rules are universal; the Windows spawn escape paths (breakaway /
WMI relay) only run on win32.  Every spawn here uses a short-lived daemon so
no process outlives the test.
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HELPER_DIR = PROJECT_ROOT / "src" / "process" / "helper"
HELPER_SCRIPT = HELPER_DIR / "daemon_spawn.py"

IS_WINDOWS = sys.platform == "win32"

# daemon 脚本：从 env 读取 marker 写入 argv[1]，并输出到 stdout/stderr，
# 用于验证 env 交接与日志重定向。
MARKER_DAEMON_SOURCE = (
    "import os, sys\n"
    "with open(sys.argv[1], 'w', encoding='utf-8') as handle:\n"
    "    handle.write(os.environ.get('C2C_PROTOCOL_TEST_MARKER', 'missing'))\n"
    "print('daemon-ready')\n"
    "sys.stderr.write('daemon-err')\n"
)

sys.path.insert(0, str(HELPER_DIR))
import daemon_spawn as helper  # noqa: E402


def run_helper(args: list[str], timeout: float = 90.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", str(HELPER_SCRIPT), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def last_json_line(text: str) -> dict:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return json.loads(lines[-1])


def wait_until(predicate, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def wait_pid_exit(pid: int, timeout: float = 15.0, *, kernel32=None) -> bool:
    """Wait for a Windows process handle to become signaled; failures are not proof of exit."""
    from ctypes import wintypes

    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        raise ValueError(f"daemon PID must be a positive DWORD: {pid!r}")
    if kernel32 is None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetLastError.argtypes = []
    kernel32.GetLastError.restype = wintypes.DWORD

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    SYNCHRONIZE = 0x00100000
    ERROR_INVALID_PARAMETER = 87
    WAIT_OBJECT_0 = 0
    WAIT_TIMEOUT = 258
    WAIT_FAILED = 0xFFFFFFFF
    timeout = min(max(timeout, 0.0), 15.0)
    timeout_ms = int(timeout * 1000)

    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
    )
    if not handle:
        error = kernel32.GetLastError()
        if error == ERROR_INVALID_PARAMETER:
            return True  # a positive PID no longer exists
        raise OSError(f"daemon PID {pid} stage=OpenProcess WinError={error}")

    def exit_code_detail() -> str:
        code = wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return str(code.value)
        return f"unavailable (GetExitCodeProcess WinError={kernel32.GetLastError()})"

    try:
        result = kernel32.WaitForSingleObject(handle, timeout_ms)
        if result == WAIT_OBJECT_0:
            return True
        if result == WAIT_TIMEOUT:
            raise TimeoutError(
                f"daemon PID {pid} stage=WaitForSingleObject timed out after "
                f"{timeout:g}s (wait=WAIT_TIMEOUT, exit_code={exit_code_detail()})"
            )
        error = kernel32.GetLastError()
        if result == WAIT_FAILED:
            raise OSError(
                f"daemon PID {pid} stage=WaitForSingleObject failed "
                f"WinError={error} (exit_code={exit_code_detail()})"
            )
        raise OSError(
            f"daemon PID {pid} stage=WaitForSingleObject returned "
            f"0x{result:08X} WinError={error}"
        )
    finally:
        if not kernel32.CloseHandle(handle):
            error = kernel32.GetLastError()
            raise OSError(f"daemon PID {pid} stage=CloseHandle WinError={error}")


def _cleanup_tempdir(holder, pid=None, timeout: float = 2.5) -> None:
    """Re-prove daemon exit, then retry actual deletion only for WinError 32."""
    if pid is not None:
        wait_pid_exit(pid)

    deadline = time.monotonic() + min(max(timeout, 0.0), 2.5)
    attempts = 0
    while True:
        attempts += 1
        try:
            holder.cleanup()
            return
        except OSError as error:
            if getattr(error, "winerror", None) != 32:
                raise
            if pid is None:
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"TemporaryDirectory cleanup blocked: path={holder.name!r}, "
                    f"attempts={attempts}, WinError=32, last_error={error!r}"
                ) from error
            time.sleep(min(0.05, remaining))


class DaemonSpawnArgvQuotingTest(unittest.TestCase):
    """_windows_argv_quote 必须精确遵循 MSVCRT/CommandLineToArgvW 规则。"""

    def test_plain_path_stays_unquoted(self):
        self.assertEqual(
            helper._windows_argv_quote(r"C:\Users\me\node.exe"),
            r"C:\Users\me\node.exe",
        )

    def test_space_argument_is_quoted(self):
        self.assertEqual(helper._windows_argv_quote("a b"), '"a b"')

    def test_empty_argument_becomes_empty_quotes(self):
        self.assertEqual(helper._windows_argv_quote(""), '""')

    def test_embedded_quotes_are_escaped(self):
        self.assertEqual(helper._windows_argv_quote('say "hi"'), r'"say \"hi\""')

    def test_trailing_backslash_is_doubled(self):
        # 引用场景下结尾反斜杠翻倍，防止闭合引号被转义。
        self.assertEqual(helper._windows_argv_quote("D:\\my dir\\"), r'"D:\my dir\\"')

    def test_backslashes_outside_quotes_stay_literal(self):
        # 引用后非引号前的反斜杠必须保持单倍，不得全量翻倍（路径忠实性）。
        self.assertEqual(
            helper._windows_argv_quote(r"C:\Program Files\node.exe"),
            r'"C:\Program Files\node.exe"',
        )

    def test_backslash_run_before_embedded_quote(self):
        # a\"b：引号前 1 个反斜杠 → 输出 2n+1=3 个反斜杠 + 转义引号。
        self.assertEqual(helper._windows_argv_quote('a\\"b'), r'"a\\\"b"')


class DaemonSpawnBadUsageTest(unittest.TestCase):
    """协议层 usage 错误统一为 rc=2 + {"ok":false,"code":"bad_usage"}。"""

    def test_unknown_argument_exits_2(self):
        result = run_helper(["--bogus"])
        self.assertEqual(result.returncode, 2)
        payload = last_json_line(result.stdout)
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["code"], "bad_usage")

    def test_missing_command_separator_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_helper([
                "--log", os.path.join(tmp, "daemon.log"),
                "--env-file", os.path.join(tmp, "env.json"),
            ])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(last_json_line(result.stdout)["code"], "bad_usage")

    def test_empty_command_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_helper([
                "--log", os.path.join(tmp, "daemon.log"),
                "--env-file", os.path.join(tmp, "env.json"),
                "--",
            ])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(last_json_line(result.stdout)["code"], "bad_usage")

    def test_missing_env_file_reports_bad_env_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_helper([
                "--log", os.path.join(tmp, "daemon.log"),
                "--env-file", os.path.join(tmp, "absent.json"),
                "--cwd", tmp,
                "--", sys.executable, "-c", "pass",
            ])
        self.assertEqual(result.returncode, 2)
        payload = last_json_line(result.stdout)
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["code"], "bad_env_file")


@unittest.skipUnless(IS_WINDOWS, "Windows spawn 逃生路径")
class DaemonSpawnWindowsProtocolTest(unittest.TestCase):
    """main/relay 模式的真实 spawn：env 交接、env 文件删除、日志重定向。"""

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.daemon_pid = None
        self.addCleanup(lambda: _cleanup_tempdir(holder, self.daemon_pid))
        self.tmp = holder.name
        self.log = os.path.join(self.tmp, "daemon.log")
        self.env_file = os.path.join(self.tmp, "daemon-env.json")
        self.marker = os.path.join(self.tmp, "marker.txt")
        self.result_file = os.path.join(self.tmp, "relay-result.json")
        self.daemon_script = os.path.join(self.tmp, "marker_daemon.py")
        with open(self.daemon_script, "w", encoding="utf-8") as handle:
            handle.write(MARKER_DAEMON_SOURCE)
        env = dict(os.environ)
        env["C2C_PROTOCOL_TEST_MARKER"] = "env-ok"
        with open(self.env_file, "w", encoding="utf-8") as handle:
            json.dump(env, handle)

    def _read_log(self) -> str:
        try:
            with open(self.log, encoding="utf-8", errors="replace") as handle:
                return handle.read()
        except OSError:
            return ""

    def test_main_mode_reports_mode_hands_over_env_and_deletes_env_file(self):
        result = run_helper([
            "--log", self.log, "--env-file", self.env_file,
            "--cwd", self.tmp, "--", sys.executable, self.daemon_script, self.marker,
        ])
        payload = last_json_line(result.stdout)
        pid = payload.get("pid")
        self.daemon_pid = pid if type(pid) is int and pid > 0 else None
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(payload["ok"], True)
        self.assertIn(payload["mode"], ("breakaway", "wmi"))
        self.assertIs(type(payload["pid"]), int)
        self.assertGreater(payload["pid"], 0)
        self.assertTrue(wait_until(lambda: os.path.exists(self.marker)),
                        f"marker 未生成：stdout={result.stdout!r} stderr={result.stderr!r}")
        with open(self.marker, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "env-ok")
        self.assertFalse(os.path.exists(self.env_file), "env 文件应在 daemon 创建后删除")
        self.assertTrue(
            wait_until(lambda: "daemon-ready" in self._read_log()
                       and "daemon-err" in self._read_log()),
            f"daemon 输出未重定向到日志：{self._read_log()!r}",
        )
        wait_pid_exit(payload["pid"])

    def test_relay_mode_writes_result_and_removes_env_file(self):
        result = run_helper([
            "--relay", "--log", self.log, "--env-file", self.env_file,
            "--cwd", self.tmp, "--result-file", self.result_file,
            "--", sys.executable, self.daemon_script, self.marker,
        ])
        self.assertTrue(wait_until(lambda: os.path.exists(self.result_file)))
        with open(self.result_file, encoding="utf-8") as handle:
            payload = json.load(handle)
        pid = payload.get("pid")
        self.daemon_pid = pid if type(pid) is int and pid > 0 else None
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "", "relay 不应向 stdout 写协议")
        self.assertIs(payload["ok"], True)
        self.assertIs(type(payload["pid"]), int)
        self.assertGreater(payload["pid"], 0)
        self.assertTrue(wait_until(lambda: os.path.exists(self.marker)))
        with open(self.marker, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "env-ok")
        self.assertFalse(os.path.exists(self.env_file), "relay 必须读后立即删除 env 文件")
        wait_pid_exit(payload["pid"])

    def test_relay_missing_env_file_reports_failure_in_result_file(self):
        os.remove(self.env_file)
        result = run_helper([
            "--relay", "--log", self.log, "--env-file", self.env_file,
            "--cwd", self.tmp, "--result-file", self.result_file,
            "--", sys.executable, self.daemon_script, self.marker,
        ])
        self.assertEqual(result.returncode, 1)
        self.assertTrue(wait_until(lambda: os.path.exists(self.result_file)))
        with open(self.result_file, encoding="utf-8") as handle:
            payload = json.load(handle)
        self.assertIs(payload["ok"], False)
        self.assertTrue(payload.get("message"))


@unittest.skipUnless(IS_WINDOWS, "Windows typed HANDLE probe")
class ProcessProbeTest(unittest.TestCase):
    def test_live_probe_and_creation_fence(self):
        value = helper._probe_process(os.getpid())
        self.assertEqual(value["status"], "identified")
        self.assertEqual(value["pid"], os.getpid())
        self.assertEqual(value["executable"].lower(), sys.executable.lower())
        self.assertTrue(value["creationTime"].isdigit())
        self.assertIs(type(value["inAnyJob"]), bool)
        changed = helper._probe_process(os.getpid(), "1")
        self.assertEqual(changed["status"], "unknown")
        self.assertEqual(changed["errors"]["process"], "IDENTITY_CHANGED")
        self.assertIsNone(changed["inAnyJob"])
        wire = run_helper(["--probe-pid", str(os.getpid()), value["creationTime"]])
        self.assertEqual(last_json_line(wire.stdout)["creationTime"], value["creationTime"])

    def test_missing_pid_and_denied_probe_are_not_no_job(self):
        for code, status in [(87, "missing"), (5, "unknown")]:
            kernel = mock.Mock()
            kernel.OpenProcess.return_value = 0
            with mock.patch.object(ctypes, "WinDLL", return_value=kernel), mock.patch.object(ctypes, "get_last_error", return_value=code):
                value = helper._probe_process(123)
            self.assertEqual(value["status"], status)
            self.assertIsNone(value["inAnyJob"])
            self.assertEqual(value["errors"]["process"], f"WIN32_{code}")
            kernel.CloseHandle.assert_not_called()

    def test_typed_handles_preserve_64_bits_and_partial_field_errors(self):
        from ctypes import wintypes
        kernel = mock.Mock()
        handle = 0x123456789ABC
        kernel.OpenProcess.return_value = handle
        kernel.GetProcessTimes.return_value = 0
        kernel.QueryFullProcessImageNameW.return_value = 0
        kernel.IsProcessInJob.return_value = 0
        kernel.WaitForSingleObject.return_value = 258
        def alive(_handle, out):
            out._obj.value = 259
            return 1
        kernel.GetExitCodeProcess.side_effect = alive
        with mock.patch.object(ctypes, "WinDLL", return_value=kernel), mock.patch.object(ctypes, "get_last_error", return_value=5):
            value = helper._probe_process(123)
        self.assertIs(kernel.OpenProcess.restype, wintypes.HANDLE)
        self.assertEqual(kernel.OpenProcess.argtypes, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
        for name in ["GetProcessTimes", "QueryFullProcessImageNameW", "IsProcessInJob", "GetExitCodeProcess", "CloseHandle"]:
            fn = getattr(kernel, name)
            self.assertIs(fn.argtypes[0], wintypes.HANDLE)
            self.assertIs(fn.restype, wintypes.BOOL)
            self.assertEqual(fn.call_args.args[0], handle)
        kernel.CloseHandle.assert_called_once_with(handle)
        self.assertEqual(kernel.WaitForSingleObject.argtypes, [wintypes.HANDLE, wintypes.DWORD])
        self.assertIs(kernel.WaitForSingleObject.restype, wintypes.DWORD)
        kernel.WaitForSingleObject.assert_called_once_with(handle, 0)
        self.assertEqual(value["status"], "unknown")
        self.assertIsNone(value["inAnyJob"])
        self.assertEqual(value["errors"]["inAnyJob"], "WIN32_5")

    def test_exited_handle_is_missing_even_if_exit_code_would_be_still_active(self):
        kernel = mock.Mock()
        kernel.OpenProcess.return_value = 0x123456789ABC
        kernel.GetProcessTimes.return_value = 0
        kernel.QueryFullProcessImageNameW.return_value = 0
        kernel.IsProcessInJob.return_value = 0
        kernel.WaitForSingleObject.return_value = 0
        with mock.patch.object(ctypes, "WinDLL", return_value=kernel):
            value = helper._probe_process(123)
        self.assertEqual(value["status"], "missing")
        self.assertEqual(value["errors"]["process"], "PID_EXITED")
        self.assertIsNone(value["inAnyJob"])
        kernel.GetExitCodeProcess.assert_not_called()

    def test_unsignaled_exit_code_never_proves_exit_and_identity_drift_is_unknown(self):
        # Reproduce the B1 contradiction on ONE exact HANDLE, without touching a real process.
        for wait, code, expected, status, reason in [
            (258, 0, "123", "unknown", "PROBE_UNAVAILABLE"),
            (258, 1, "123", "unknown", "PROBE_UNAVAILABLE"),
            (258, 259, "123", "identified", None),
            (0, 259, "123", "missing", "PID_EXITED"),
            (0xffffffff, 1, "123", "unknown", "PROBE_UNAVAILABLE"),
            (258, 259, "456", "unknown", "IDENTITY_CHANGED"),
            (0, 1, "456", "unknown", "IDENTITY_CHANGED"),
        ]:
            with self.subTest(wait=wait, code=code, expected=expected):
                kernel = mock.Mock()
                handle = 0x123456789ABC
                kernel.OpenProcess.return_value = handle
                def times(_handle, creation, *_rest):
                    self.assertEqual(_handle, handle)
                    creation._obj.dwLowDateTime = 123
                    return 1
                def executable(_handle, _flags, buffer, _size):
                    self.assertEqual(_handle, handle)
                    buffer.value = sys.executable
                    return 1
                def exit_code(_handle, out):
                    self.assertEqual(_handle, handle)
                    out._obj.value = code
                    return 1
                kernel.GetProcessTimes.side_effect = times
                kernel.QueryFullProcessImageNameW.side_effect = executable
                kernel.IsProcessInJob.return_value = 1
                kernel.WaitForSingleObject.return_value = wait
                kernel.GetExitCodeProcess.side_effect = exit_code
                with mock.patch.object(ctypes, "WinDLL", return_value=kernel):
                    value = helper._probe_process(123, expected)
                self.assertEqual(value["status"], status)
                self.assertEqual(value["errors"]["process"], reason)
                kernel.WaitForSingleObject.assert_called_once_with(handle, 0)
                kernel.CloseHandle.assert_called_once_with(handle)
                if status != "identified":
                    self.assertIsNone(value["executable"])
                    self.assertIsNone(value["creationTime"])
                    self.assertIsNone(value["inAnyJob"])

    def test_spawn_evidence_probes_final_pid_and_diagnostic_failure_never_respawns(self):
        with mock.patch.object(helper, "_probe_process_impl", side_effect=RuntimeError("private raw details")):
            evidence = helper._spawn_evidence(321)
        self.assertEqual(evidence["final_probe"]["pid"], 321)
        self.assertEqual(evidence["final_probe"]["status"], "unknown")
        self.assertNotIn("private", json.dumps(evidence))
        for wmi in [False, True]:
            options = {"relay": False, "log": "unused", "env_file": "unused", "cwd": "unused"}
            with mock.patch.object(helper, "_parse_options", return_value=(options, ["daemon"])), \
                    mock.patch.object(helper, "_read_env_file", return_value={}), \
                    mock.patch.object(helper, "_delete_env_file"), \
                    mock.patch.object(helper, "_detect_in_job", return_value=True), \
                    mock.patch.object(helper, "_spawn_detached", side_effect=OSError() if wmi else None, return_value=321) as spawn, \
                    mock.patch.object(helper, "_spawn_via_wmi_relay", return_value=321) as relay, \
                    mock.patch.object(helper, "_probe_process_impl", side_effect=RuntimeError("probe failure")), \
                    mock.patch.object(helper, "_emit") as emit:
                self.assertEqual(helper.main([]), 0)
            spawn.assert_called_once()
            self.assertEqual(relay.call_count, 1 if wmi else 0)
            value = emit.call_args.args[0]
            self.assertEqual(value["mode"], "wmi" if wmi else "breakaway")
            self.assertEqual(value["final_probe"]["pid"], 321)


if __name__ == "__main__":
    unittest.main(verbosity=2)
