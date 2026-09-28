"""Codex Desktop IPC helper 的分域实现。

``desktop_ipc.py`` 是兼容旧启动路径的薄入口；本包只依赖 Python 标准库，
并可在 Python isolated mode（``-I``）下由入口显式 bootstrap。
"""

from . import common, history, transport, identity, reconciliation, operations, result, dispatch

__all__ = [
    "common", "dispatch", "history", "identity", "operations", "reconciliation", "result", "transport",
]
