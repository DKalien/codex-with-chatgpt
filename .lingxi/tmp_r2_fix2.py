# -*- coding: utf-8 -*-
"""R2 测试修复批次 2：FakePipe 吞帧机制、final fence 期望、approval 新语义、allow_active 清理。"""
import ast
from pathlib import Path

ROOT = Path(r"D:\python\codex-with-chatgpt")
PROTO = ROOT / "tests" / "desktop_protocol_test.py"
HELPER = ROOT / "tests" / "desktop_ipc_helper_test.py"


def apply(path: Path, edits, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    for i, (find, replace, expected) in enumerate(edits, 1):
        count = text.count(find)
        if count != expected:
            raise SystemExit(f"[{label}] edit {i}: expected {expected} got {count}: {find[:90]!r}")
        text = text.replace(find, replace)
    ast.parse(text)
    path.write_text(text, encoding="utf-8")
    print(f"[{label}] {len(edits)} edits applied")


proto_edits = [
    # 1. FakePipe 增加 suppressed 集合（吞帧：server 收到但不回任何东西）
    ("        self.response_errors = {}\n",
     "        self.response_errors = {}\n        self.suppressed = set()\n", 1),
    # 2. write 开头：被 suppress 的方法只记录不响应
    ('        method = value.get("method")\n        if method in self.response_errors and "requestId" in value:\n',
     '        method = value.get("method")\n        if method in self.suppressed:\n            return\n'
     '        if method in self.response_errors and "requestId" in value:\n', 1),
    # 3. post_start_state_error 分支同样只对带 requestId 的帧回错误响应
    ('            if self.post_start_state_error is not None and self.start_seen:\n'
     '                self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],\n',
     '            if self.post_start_state_error is not None and self.start_seen and "requestId" in value:\n'
     '                self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],\n', 1),
    # 4. pre-start 硬验收：吞掉 following-changed broadcast，客户端等不到新 snapshot 超时
    ('        self.pipe.response_errors["thread-stream-following-changed"] = "server-error"\n',
     '        self.pipe.suppressed.add("thread-stream-following-changed")\n', 1),
    # 5. real_protocol_flow：final process/owner fence 带来末尾的 thread-owner-discovery
    ('                         ["initialize", "thread-owner-discovery", "thread-owner-discovery", "thread-follower-start-turn"])\n',
     '                         ["initialize", "thread-owner-discovery", "thread-owner-discovery",\n'
     '                          "thread-follower-start-turn", "thread-owner-discovery"])\n', 1),
    # 6. approval 分支新语义：requests 存在不再阻断 result context 读取
    ("""                    if state_change == "approval":
                        with self.assertRaises(h.DesktopIpcError) as caught:
                            h._current_result_context(self.temp.name)
                        self.assertEqual(caught.exception.code, "DESKTOP_APPROVAL_PENDING")
                    else:
                        result = h._current_result_context(self.temp.name)
                        self.assertEqual(result["resultTurnId"], NEW_TURN)
""",
     """                    result = h._current_result_context(self.temp.name)
                    expected_turn = OLD_TURN if state_change == "approval" else NEW_TURN
                    self.assertEqual(result["resultTurnId"], expected_turn)
""", 1),
]

helper_edits = [
    # allow_active kwarg 已不存在：三处全部删除（新函数总是允许 active）
    (", TARGET, OWNER, allow_active=True)", ", TARGET, OWNER)", 3),
]

apply(PROTO, proto_edits, "protocol")
apply(HELPER, helper_edits, "helper")
print("batch2 done")
