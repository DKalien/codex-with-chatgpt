# -*- coding: utf-8 -*-
"""R2 测试修复批次 3：post-start state unavailable 改为吞帧超时机制。"""
import ast
from pathlib import Path

PROTO = Path(r"D:\python\codex-with-chatgpt\tests\desktop_protocol_test.py")

text = PROTO.read_text(encoding="utf-8")
edits = [
    # 1. FakePipe 字段：post_start_state_error → suppress_after_start
    ("        self.post_start_state_error = None\n",
     "        self.suppress_after_start = set()\n", 1),
    # 2. write 分支：start 之后被列入 suppress 的方法直接吞掉（server 不回状态）
    ('            if self.post_start_state_error is not None and self.start_seen and "requestId" in value:\n'
     '                self.pending.append(h._frame({"type": "response", "requestId": value["requestId"],\n'
     '                    "resultType": "error", "error": self.post_start_state_error}))\n'
     '                return\n',
     '            if self.start_seen and method in self.suppress_after_start:\n'
     '                return\n', 1),
    # 3. 测试：start-turn 之后吞掉 following-changed，post-start snapshot 超时 → STATE_UNAVAILABLE
    ('        self.pipe.post_start_state_error = "server-error"\n',
     '        self.pipe.suppress_after_start.add("thread-stream-following-changed")\n', 1),
]
for i, (find, replace, expected) in enumerate(edits, 1):
    count = text.count(find)
    if count != expected:
        raise SystemExit(f"edit {i}: expected {expected} got {count}: {find[:90]!r}")
    text = text.replace(find, replace)
ast.parse(text)
PROTO.write_text(text, encoding="utf-8")
print("batch3 done")
