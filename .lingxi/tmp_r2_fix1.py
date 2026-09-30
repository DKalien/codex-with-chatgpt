# -*- coding: utf-8 -*-
"""R2 测试修复批次 1：FakePipe broadcast 帧、boundary 测试注入方式、helper 符号迁移。"""
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
    # 1. hashlib import（classification 测试使用）
    ("import copy\nimport io\nimport json\nimport os\n",
     "import copy\nimport hashlib\nimport io\nimport json\nimport os\n", 1),
    # 2. FakePipe：response_errors 只对带 requestId 的请求帧生效；
    #    following-changed 是 broadcast（无 requestId），server 不回状态才对应 STATE_UNAVAILABLE。
    ('        method = value.get("method")\n        if method in self.response_errors:\n',
     '        method = value.get("method")\n        if method in self.response_errors and "requestId" in value:\n', 1),
    # 3. post-start STATE_UNAVAILABLE 硬验收：ACK turn 必须在 start-turn 之后注入
    ("""        session, _ = h._prepare(self.target)
        message = self._send_fixture()
        self.pipe.post_start_state_error = "server-error"
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
""",
     """        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.post_start_state_error = "server-error"
        with patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05), self._inject_on_start([turn]):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
""", 1),
    # 4. post-start process drift：同样改为 start-turn 后注入
    ("""        session, _ = h._prepare(self.target)
        message = self._send_fixture()
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
""",
     """        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        rows = [{"pid": 100, "parentPid": 1, "name": "ChatGPT.exe", "exe": self.pipe.server_exe, "creation": 10},
""", 1),
    ('        with patch.object(h, "_processes", side_effect=processes):\n',
     '        with patch.object(h, "_processes", side_effect=processes), self._inject_on_start([turn]):\n', 1),
    # 5. post-start owner drift：同样改为 start-turn 后注入
    ("""        session, _ = h._prepare(self.target)
        message = self._send_fixture()
        with patch.object(h._IpcClient, "discover", side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]):
""",
     """        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with patch.object(h._IpcClient, "discover", side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]), \\
                self._inject_on_start([turn]):
""", 1),
    # 6. real_protocol_flow：send 走 attestation，ACK turn 需在 start-turn 后进入 canonical 状态
    ("""        session, info = h._prepare(self.target)
        text = "完整中文方案\\n```python\\nprint('你好')\\n```"
        self.assertEqual(session.send(text), {"threadId": THREAD, "turnId": NEW_TURN})
""",
     """        session, info = h._prepare(self.target)
        text = "完整中文方案\\n```python\\nprint('你好')\\n```"
        item = {"type": "text", "text": text, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        with self._inject_on_start([turn]):
            self.assertEqual(session.send(text), {"threadId": THREAD, "turnId": NEW_TURN})
""", 1),
]

helper_edits = [
    # 1. _validate_state → _validate_observed_state（11 处调用）
    ("helper._validate_state(", "helper._validate_observed_state(", 11),
    # 2. missing requests 在新语义下属于结构校验失败（STATE_UNAVAILABLE），不再 APPROVAL_PENDING
    ('        self.assert_code("DESKTOP_APPROVAL_PENDING", lambda: helper._validate_observed_state(missing_requests, TARGET, OWNER))',
     '        self.assert_code("DESKTOP_STATE_UNAVAILABLE", lambda: helper._validate_observed_state(missing_requests, TARGET, OWNER))', 1),
    # 3. busy 断言按新职责拆分走 _assert_send_ready
    ('        self.assert_code("DESKTOP_BUSY", lambda: helper._validate_observed_state(busy, TARGET, OWNER))',
     '        self.assert_code("DESKTOP_BUSY", lambda: helper._assert_send_ready(busy))', 1),
    ('        self.assert_code("DESKTOP_BUSY", lambda: helper._validate_observed_state(state, TARGET, OWNER))',
     '        self.assert_code("DESKTOP_BUSY", lambda: helper._assert_send_ready(state))', 1),
    # 4. _current_identity_checked 现在返回单个 identity dict（不再带 process tuple）
    ("return_value=(info, runtime)", "return_value=info", 1),
    ("side_effect=[(info, runtime), (changed, runtime)]", "side_effect=[info, changed]", 1),
    ("side_effect=[(info, runtime), (info, runtime)]", "side_effect=[info, info]", 1),
]

apply(PROTO, proto_edits, "protocol")
apply(HELPER, helper_edits, "helper")
print("batch1 done")
