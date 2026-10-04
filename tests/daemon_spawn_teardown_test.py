"""Deterministic WinAPI and teardown boundary checks.

Usage: python tests/daemon_spawn_teardown_test.py
"""

from __future__ import annotations

import ctypes
import subprocess
import sys
import tempfile
import unittest
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import daemon_spawn_protocol_test as protocol


WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
WAIT_FAILED = 0xFFFFFFFF


def fake_kernel32(
    *,
    open_result=0x12345678ABCDEF01,
    open_error=0,
    wait_result=WAIT_OBJECT_0,
    wait_error=0,
    exit_code=0,
    exit_ok=True,
):
    last_error = [open_error]

    def open_process(*_args):
        last_error[0] = open_error
        return open_result

    def wait_for_single_object(*_args):
        last_error[0] = wait_error
        return wait_result

    def get_exit_code(_handle, output):
        if not exit_ok:
            last_error[0] = 5
            return 0
        ctypes.cast(output, ctypes.POINTER(wintypes.DWORD)).contents.value = exit_code
        return 1

    return SimpleNamespace(
        OpenProcess=Mock(side_effect=open_process),
        WaitForSingleObject=Mock(side_effect=wait_for_single_object),
        GetExitCodeProcess=Mock(side_effect=get_exit_code),
        CloseHandle=Mock(return_value=1),
        GetLastError=Mock(side_effect=lambda: last_error[0]),
    )


class DaemonPidExitTest(unittest.TestCase):
    def test_only_invalid_parameter_proves_positive_pid_absent(self):
        kernel32 = fake_kernel32(open_result=None, open_error=87)
        self.assertTrue(protocol.wait_pid_exit(42, kernel32=kernel32))
        kernel32.CloseHandle.assert_not_called()

    def test_open_process_access_denied_fails_closed(self):
        for error in (0, 5):
            with self.subTest(winerror=error):
                kernel32 = fake_kernel32(open_result=None, open_error=error)
                with self.assertRaisesRegex(
                    OSError, rf"PID 42 stage=OpenProcess WinError={error}"
                ):
                    protocol.wait_pid_exit(42, kernel32=kernel32)
                kernel32.CloseHandle.assert_not_called()

    def test_wait_timeout_preserves_high_bit_handle_and_closes_it(self):
        handle = 0x12345678ABCDEF01
        kernel32 = fake_kernel32(wait_result=WAIT_TIMEOUT, exit_code=259)
        with self.assertRaisesRegex(TimeoutError, r"PID 42 stage=WaitForSingleObject.*exit_code=259"):
            protocol.wait_pid_exit(42, 0.25, kernel32=kernel32)

        self.assertEqual(kernel32.WaitForSingleObject.call_args.args, (handle, 250))
        kernel32.CloseHandle.assert_called_once_with(handle)
        self.assertEqual(
            kernel32.OpenProcess.argtypes,
            [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD],
        )
        self.assertIs(kernel32.OpenProcess.restype, wintypes.HANDLE)
        self.assertEqual(
            kernel32.GetExitCodeProcess.argtypes,
            [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)],
        )
        self.assertIs(kernel32.GetExitCodeProcess.restype, wintypes.BOOL)
        self.assertEqual(kernel32.CloseHandle.argtypes, [wintypes.HANDLE])
        self.assertIs(kernel32.CloseHandle.restype, wintypes.BOOL)
        self.assertEqual(
            kernel32.WaitForSingleObject.argtypes,
            [wintypes.HANDLE, wintypes.DWORD],
        )
        self.assertIs(kernel32.WaitForSingleObject.restype, wintypes.DWORD)

    def test_wait_api_failure_fails_closed_and_closes_handle(self):
        handle = 0x12345678ABCDEF01
        kernel32 = fake_kernel32(wait_result=WAIT_FAILED, wait_error=6)
        with self.assertRaisesRegex(OSError, r"PID 42 stage=WaitForSingleObject failed WinError=6"):
            protocol.wait_pid_exit(42, kernel32=kernel32)
        kernel32.CloseHandle.assert_called_once_with(handle)

    def test_failed_exit_code_query_is_diagnostic_on_timeout(self):
        kernel32 = fake_kernel32(wait_result=WAIT_TIMEOUT, exit_ok=False)
        with self.assertRaisesRegex(
            TimeoutError, r"PID 42 stage=WaitForSingleObject.*GetExitCodeProcess WinError=5"
        ):
            protocol.wait_pid_exit(42, kernel32=kernel32)
        kernel32.CloseHandle.assert_called_once_with(0x12345678ABCDEF01)

    def test_unknown_wait_status_fails_closed_and_closes_handle(self):
        kernel32 = fake_kernel32(wait_result=1234, wait_error=87)
        with self.assertRaisesRegex(
            OSError, r"PID 42 stage=WaitForSingleObject returned 0x000004D2 WinError=87"
        ):
            protocol.wait_pid_exit(42, kernel32=kernel32)
        kernel32.CloseHandle.assert_called_once_with(0x12345678ABCDEF01)

    def test_signaled_wait_proves_exit_and_closes_handle(self):
        handle = 0x12345678ABCDEF01
        kernel32 = fake_kernel32(wait_result=WAIT_OBJECT_0, exit_code=0)
        self.assertTrue(protocol.wait_pid_exit(42, kernel32=kernel32))
        kernel32.CloseHandle.assert_called_once_with(handle)


def sharing_error(path: str, winerror: int) -> OSError:
    return FakeCleanupError(path, winerror)


class FakeCleanupError(PermissionError):
    def __init__(self, path: str, winerror: int):
        super().__init__(f"file is held: {path}")
        self._fake_winerror = winerror

    @property
    def winerror(self):
        return self._fake_winerror


class FakeTemporaryDirectory:
    name = r"C:\temp\daemon-protocol"

    def __init__(self, failures=0, winerror: int = 32):
        self.failures = failures
        self.winerror = winerror
        self.cleanup_calls = 0

    def cleanup(self):
        self.cleanup_calls += 1
        if self.failures is None or self.cleanup_calls <= self.failures:
            raise sharing_error(self.name, self.winerror)


class DaemonCleanupTest(unittest.TestCase):
    def test_pid_is_reproved_then_sharing_retry_reaches_deleteability(self):
        events = []
        holder = FakeTemporaryDirectory(failures=1)

        def prove_exit(pid):
            events.append(("wait", pid))

        with patch.object(protocol, "wait_pid_exit", side_effect=prove_exit):
            protocol._cleanup_tempdir(holder, pid=42, timeout=0.2)

        self.assertEqual(events, [("wait", 42)])
        self.assertEqual(holder.cleanup_calls, 2)

    def test_persistent_sharing_holder_fails_with_bounded_diagnostics(self):
        holder = FakeTemporaryDirectory(failures=None)
        with patch.object(protocol, "wait_pid_exit") as wait:
            with self.assertRaisesRegex(
                TimeoutError,
                r"TemporaryDirectory cleanup blocked: path=.*attempts=\d+, WinError=32",
            ):
                protocol._cleanup_tempdir(holder, pid=42, timeout=0.01)
        wait.assert_called_once_with(42)
        self.assertGreaterEqual(holder.cleanup_calls, 1)

    def test_nonsharing_cleanup_error_is_not_retried(self):
        holder = FakeTemporaryDirectory(failures=None, winerror=5)
        with patch.object(protocol, "wait_pid_exit") as wait:
            with self.assertRaisesRegex(PermissionError, "file is held") as raised:
                protocol._cleanup_tempdir(holder)
        wait.assert_not_called()
        self.assertEqual(raised.exception.winerror, 5)
        self.assertEqual(holder.cleanup_calls, 1)

    def test_sharing_error_without_pid_is_not_retried_or_waited(self):
        holder = FakeTemporaryDirectory(failures=None)
        with patch.object(protocol, "wait_pid_exit") as wait:
            with self.assertRaises(FakeCleanupError) as raised:
                protocol._cleanup_tempdir(holder)
        wait.assert_not_called()
        self.assertEqual(raised.exception.winerror, 32)
        self.assertEqual(holder.cleanup_calls, 1)

    def test_failed_pid_proof_prevents_directory_cleanup(self):
        holder = FakeTemporaryDirectory()
        with patch.object(protocol, "wait_pid_exit", side_effect=OSError("PID wait failed")):
            with self.assertRaisesRegex(OSError, "PID wait failed"):
                protocol._cleanup_tempdir(holder, pid=42)
        self.assertEqual(holder.cleanup_calls, 0)

    @unittest.skipUnless(protocol.IS_WINDOWS, "Windows sharing violation")
    def test_real_held_log_blocks_cleanup_until_python_holder_exits(self):
        holder = tempfile.TemporaryDirectory()
        root = Path(holder.name)
        log = root / "daemon.log"
        ready = root / "holder-ready"
        holder_process = None
        exited_fixture = None
        source = (
            "import sys\n"
            "with open(sys.argv[1], 'ab', buffering=0):\n"
            "    open(sys.argv[2], 'w').close()\n"
            "    sys.stdin.buffer.read()\n"
        )
        try:
            holder_process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", source, str(log), str(ready)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            self.assertTrue(
                protocol.wait_until(ready.exists, timeout=5.0),
                "separate Python log holder did not become ready",
            )
            exited_fixture = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", "pass"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.assertEqual(exited_fixture.wait(timeout=15.0), 0)
            self.assertTrue(protocol.wait_pid_exit(exited_fixture.pid))

            with self.assertRaisesRegex(TimeoutError, r"WinError=32"):
                protocol._cleanup_tempdir(holder, exited_fixture.pid, timeout=0.05)
            self.assertTrue(log.exists())
            self.assertTrue(root.exists())

            holder_process.stdin.close()
            self.assertEqual(holder_process.wait(timeout=15.0), 0, holder_process.stderr.read())
            self.assertTrue(protocol.wait_pid_exit(holder_process.pid))
            holder.cleanup()
            self.assertFalse(root.exists())
        finally:
            if holder_process is not None:
                if holder_process.stdin is not None and not holder_process.stdin.closed:
                    holder_process.stdin.close()
                holder_process.wait(timeout=15.0)
                if holder_process.stderr is not None:
                    holder_process.stderr.close()
            if exited_fixture is not None:
                exited_fixture.wait(timeout=15.0)
            if root.exists():
                holder.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
