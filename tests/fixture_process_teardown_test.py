"""Deterministic HANDLE tests: all destructive calls use a fake kernel."""
import ctypes
from ctypes import wintypes
import importlib.util
import os
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("teardown", Path(__file__).with_name("fixture_process_teardown.py"))
teardown = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teardown)
IDENTITY = {"pid": 1234, "creationTime": "4294967298", "executable": r"C:\fixture\node.exe"}


class Function:
    def __init__(self, operation):
        self.operation = operation
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        return self.operation(*args)


class Kernel:
    handle = 0x100000001  # A truncated 32-bit HANDLE cannot pass these assertions.

    def __init__(self):
        self.creation = IDENTITY["creationTime"]
        self.executable = IDENTITY["executable"]
        self.waits = [258, 0]
        self.error = 5
        self.OpenProcess = Function(lambda *_: self.handle)
        self.GetProcessTimes = Function(self.times)
        self.QueryFullProcessImageNameW = Function(self.image)
        self.TerminateProcess = Function(lambda *_: 1)
        self.WaitForSingleObject = Function(lambda *_: self.waits.pop(0))
        self.CloseHandle = Function(lambda *_: 1)

    def times(self, handle, creation, *_):
        creation._obj.dwHighDateTime = int(self.creation) >> 32
        creation._obj.dwLowDateTime = int(self.creation) & 0xffffffff
        return 1

    def image(self, handle, flags, buffer, size):
        buffer.value = self.executable
        return 1

    def stop(self, identity=None, **kwargs):
        return teardown.stop_windows(identity or IDENTITY, 5678, self, lambda: self.error, **kwargs)


class ExactFixtureTeardown(unittest.TestCase):
    def test_exact_handle_terminated_waited_and_closed_with_64bit_signatures(self):
        kernel = Kernel()
        self.assertEqual(kernel.stop(), "exited")
        self.assertEqual(kernel.OpenProcess.calls, [(0x101001, False, 1234)])
        self.assertIs(kernel.OpenProcess.restype, wintypes.HANDLE)
        self.assertEqual(kernel.OpenProcess.argtypes, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
        for name in ("GetProcessTimes", "QueryFullProcessImageNameW", "TerminateProcess", "WaitForSingleObject", "CloseHandle"):
            fn = getattr(kernel, name)
            self.assertIs(fn.argtypes[0], wintypes.HANDLE)
            self.assertTrue(all(call[0] == kernel.handle for call in fn.calls), name)
        self.assertEqual(kernel.TerminateProcess.calls, [(kernel.handle, 1)])
        self.assertEqual(kernel.WaitForSingleObject.calls, [(kernel.handle, 0), (kernel.handle, 10_000)])
        self.assertEqual(kernel.CloseHandle.calls, [(kernel.handle,)])

    def test_missing_pid_is_noop(self):
        kernel = Kernel()
        kernel.OpenProcess.operation = lambda *_: 0
        kernel.error = 87
        self.assertEqual(kernel.stop(), "missing")
        self.assertEqual(kernel.TerminateProcess.calls, [])
        self.assertEqual(kernel.CloseHandle.calls, [])

    def test_already_exited_handle_is_noop(self):
        kernel = Kernel()
        kernel.waits = [0]
        self.assertEqual(kernel.stop(), "missing")
        self.assertEqual(kernel.GetProcessTimes.calls, [])
        self.assertEqual(kernel.TerminateProcess.calls, [])
        self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_pid_reuse_creation_or_executable_drift_refuses_termination(self):
        for field, value in (("creation", "4294967299"), ("executable", r"C:\other\node.exe")):
            with self.subTest(field=field):
                kernel = Kernel()
                setattr(kernel, field, value)
                with self.assertRaisesRegex(RuntimeError, "identity_mismatch"):
                    kernel.stop()
                self.assertEqual(kernel.TerminateProcess.calls, [])
                self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_access_denied_and_unknown_open_error_never_kill(self):
        for error in (5, 6, 0):
            kernel = Kernel()
            kernel.OpenProcess.operation = lambda *_: 0
            kernel.error = error
            with self.assertRaisesRegex(RuntimeError, "open_unknown"):
                kernel.stop()
            self.assertEqual(kernel.TerminateProcess.calls, [])

    def test_creation_or_executable_probe_failure_never_kills(self):
        for name in ("GetProcessTimes", "QueryFullProcessImageNameW"):
            kernel = Kernel()
            kernel.waits = [258, 258]  # Permission failure without exit proof stays unknown.
            getattr(kernel, name).operation = lambda *_: 0
            with self.assertRaisesRegex(RuntimeError, "unknown"):
                kernel.stop()
            self.assertEqual(kernel.TerminateProcess.calls, [])
            self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_exit_during_identity_query_is_proven_on_same_handle_without_kill(self):
        for name in ("GetProcessTimes", "QueryFullProcessImageNameW"):
            kernel = Kernel()
            getattr(kernel, name).operation = lambda *_: 0
            self.assertEqual(kernel.stop(), "missing")
            self.assertEqual(kernel.TerminateProcess.calls, [])
            self.assertEqual(kernel.WaitForSingleObject.calls[-1], (kernel.handle, 10_000))
            self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_unknown_initial_wait_never_kills(self):
        kernel = Kernel()
        kernel.waits = [0xffffffff]
        with self.assertRaisesRegex(RuntimeError, "wait_unknown"):
            kernel.stop()
        self.assertEqual(kernel.TerminateProcess.calls, [])
        self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_pid_reuse_after_termination_only_waits_original_handle(self):
        kernel = Kernel()
        def terminate(handle, code):
            kernel.creation = "9999999999"  # The numerical PID now belongs to a replacement.
            kernel.handle = 0x200000002
            return 1
        kernel.TerminateProcess.operation = terminate
        original = kernel.handle
        self.assertEqual(kernel.stop(), "exited")
        self.assertEqual(len(kernel.OpenProcess.calls), 1)
        self.assertEqual(kernel.TerminateProcess.calls, [(original, 1)])
        self.assertEqual(kernel.WaitForSingleObject.calls[-1], (original, 10_000))
        self.assertEqual(kernel.CloseHandle.calls, [(original,)])

    def test_exit_between_identity_check_and_termination_is_safe(self):
        kernel = Kernel()
        kernel.TerminateProcess.operation = lambda *_: 0
        self.assertEqual(kernel.stop(), "missing")
        self.assertEqual(len(kernel.OpenProcess.calls), 1)
        self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_termination_failure_is_not_exit_proof(self):
        kernel = Kernel()
        kernel.waits = [258, 258]
        kernel.TerminateProcess.operation = lambda *_: 0
        with self.assertRaisesRegex(RuntimeError, "terminate_unknown"):
            kernel.stop()
        self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_wait_timeout_or_failure_is_bounded_and_closes_handle(self):
        for state in (258, 0xffffffff):
            kernel = Kernel()
            kernel.waits = [258, state]
            with self.assertRaisesRegex(RuntimeError, "exit_not_proven"):
                kernel.stop()
            self.assertEqual(kernel.WaitForSingleObject.calls[-1][1], 10_000)
            self.assertEqual(len(kernel.TerminateProcess.calls), 1)
            self.assertEqual(len(kernel.CloseHandle.calls), 1)

    def test_current_helper_runner_and_invalid_identity_rejected_before_open(self):
        for identity in ({**IDENTITY, "pid": os.getpid()}, {**IDENTITY, "pid": 5678},
                         {**IDENTITY, "pid": 0}, {**IDENTITY, "creationTime": ""},
                         {**IDENTITY, "executable": ""}, {**IDENTITY, "extra": True}):
            kernel = Kernel()
            with self.assertRaises(ValueError):
                kernel.stop(identity)
            self.assertEqual(kernel.OpenProcess.calls, [])

    def test_close_failure_is_surfaced(self):
        kernel = Kernel()
        kernel.CloseHandle.operation = lambda *_: 0
        with self.assertRaisesRegex(RuntimeError, "close_handle_failed"):
            kernel.stop()


if __name__ == "__main__":
    unittest.main()
