"""Exercise a real Windows console Ctrl+C against an isolated stable launcher."""

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path


def process_identity(pid: int) -> tuple[int, str]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created = wintypes.FILETIME()
        exited = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        image = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(image))
        if not kernel32.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        creation = (created.dwHighDateTime << 32) | created.dwLowDateTime
        return creation, os.path.normcase(os.path.abspath(image.value))
    finally:
        kernel32.CloseHandle(handle)


def send_console_ctrl_c(pid: int, expected: tuple[int, str]) -> None:
    if process_identity(pid) != expected:
        raise RuntimeError("launcher PID, creation time, or executable changed")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.AttachConsole.argtypes = [wintypes.DWORD]
    kernel32.AttachConsole.restype = wintypes.BOOL
    kernel32.SetConsoleCtrlHandler.argtypes = [ctypes.c_void_p, wintypes.BOOL]
    kernel32.SetConsoleCtrlHandler.restype = wintypes.BOOL
    kernel32.GenerateConsoleCtrlEvent.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.GenerateConsoleCtrlEvent.restype = wintypes.BOOL
    kernel32.FreeConsole.restype = wintypes.BOOL
    if not kernel32.AttachConsole(pid):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel32.SetConsoleCtrlHandler(None, True):
            raise ctypes.WinError(ctypes.get_last_error())
        if process_identity(pid) != expected:
            raise RuntimeError("launcher identity changed before Ctrl+C")
        if not kernel32.GenerateConsoleCtrlEvent(0, 0):  # CTRL_C_EVENT to this isolated console
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel32.FreeConsole()
        kernel32.SetConsoleCtrlHandler(None, False)


def wait_for_file(file: Path, timeout: float, launcher: subprocess.Popen | None = None) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if file.exists():
            return
        if launcher is not None and launcher.poll() is not None:
            raise AssertionError(f"launcher exited before {file.name} (code {launcher.returncode})")
        time.sleep(0.025)
    raise AssertionError(f"timed out waiting for {file.name}")


def run() -> None:
    if os.name != "nt":
        raise SystemExit("SKIP: Windows console signal test")
    repo = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found")
    node = os.path.abspath(node)
    with tempfile.TemporaryDirectory(prefix="c2c-launcher-sigint-") as temporary:
        root = Path(temporary)
        state = root / "state"
        build_id = "a" * 64
        release = state / "releases" / build_id
        launcher = state / "bin" / "c2c.js"
        child = release / "bin" / "c2c.js"
        for folder in (launcher.parent, child.parent):
            folder.mkdir(parents=True, exist_ok=True)
        (state / "package.json").write_text('{"type":"commonjs"}', encoding="utf-8")
        shutil.copyfile(repo / "scripts" / "core-launcher.cjs", launcher)
        (state / "bin" / "core-release.cjs").write_text(
            "const fs=require('node:fs'),path=require('node:path');module.exports={readCurrent(state){return JSON.parse(fs.readFileSync(path.join(state,'current.json'),'utf8'));}};",
            encoding="utf-8",
        )
        (state / "current.json").write_text(json.dumps({"releaseRoot": str(release), "runtimeBuildId": build_id}), encoding="utf-8")
        child_source = f"""
const fs=require('node:fs'),path=require('node:path'),root={json.dumps(str(root))};
const ready=path.join(root,'child-ready.json');
const watchdog=setTimeout(()=>{{fs.writeFileSync(path.join(root,'watchdog-fired'),'');process.exit(7);}},8000);
process.once('SIGINT',()=>{{
  fs.writeFileSync(path.join(root,'cleanup-started'),'');
  setTimeout(()=>{{fs.writeFileSync(path.join(root,'cleanup-finished'),'');clearTimeout(watchdog);process.exit(0);}},1200);
}});
fs.writeFileSync(ready,JSON.stringify({{pid:process.pid,parentPid:process.ppid,executable:process.execPath}}));
setInterval(()=>{{}},1000);
"""
        child.write_text(child_source, encoding="utf-8")
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        # Automated runners can pass an inherited ignore-Ctrl+C flag to the fixture.
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.SetConsoleCtrlHandler.argtypes = [ctypes.c_void_p, wintypes.BOOL]
        kernel32.SetConsoleCtrlHandler.restype = wintypes.BOOL
        if not kernel32.SetConsoleCtrlHandler(None, False):
            raise ctypes.WinError(ctypes.get_last_error())
        launcher_process = subprocess.Popen(
            [node, str(launcher), "hold"], cwd=repo, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, startupinfo=startup,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        ready = root / "child-ready.json"
        try:
            wait_for_file(ready, 10, launcher_process)
            child_identity = json.loads(ready.read_text(encoding="utf-8"))
            if child_identity["parentPid"] != launcher_process.pid or os.path.normcase(os.path.abspath(child_identity["executable"])) != os.path.normcase(node):
                raise AssertionError("fixture child identity does not match the isolated launcher")
            identity = process_identity(launcher_process.pid)
            helper = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--send-ctrl-c", str(launcher_process.pid), str(identity[0]), identity[1]],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                timeout=5, creationflags=subprocess.DETACHED_PROCESS,
            )
            if helper.returncode:
                raise RuntimeError(helper.stderr.strip() or "console Ctrl+C helper failed")
            wait_for_file(root / "cleanup-started", 5, launcher_process)
            if launcher_process.poll() is not None:
                raise AssertionError("launcher exited before child cleanup finished")
            time.sleep(0.2)
            if launcher_process.poll() is not None or (root / "cleanup-finished").exists():
                raise AssertionError("launcher did not wait during asynchronous child cleanup")
            wait_for_file(root / "cleanup-finished", 5)
            if launcher_process.wait(timeout=5) != 0:
                raise AssertionError(f"launcher returned {launcher_process.returncode}")
            print(f"Windows Ctrl+C cleanup OK: launcher={launcher_process.pid}, child={child_identity['pid']}")
        finally:
            if launcher_process.poll() is None:
                launcher_process.wait(timeout=10)
            if not (root / "cleanup-finished").exists() and not (root / "watchdog-fired").exists():
                wait_for_file(root / "cleanup-finished", 10)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--send-ctrl-c":
    send_console_ctrl_c(int(sys.argv[2]), (int(sys.argv[3]), sys.argv[4]))
elif __name__ == "__main__":
    run()
