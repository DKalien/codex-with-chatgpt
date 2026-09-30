# -*- coding: utf-8 -*-
"""R2 review 修复：B1 purpose 枚举 / B2 canonical-only / B3 occurrence 判重 /
B4 bounded wait / B5 targeted owner fence / C7 mode behavioral。"""
import ast
from pathlib import Path

ROOT = Path(r"D:\python\codex-with-chatgpt")


def load(rel):
    raw = (ROOT / rel).read_bytes().decode("utf-8")
    return raw, raw.replace("\r\n", "\n")


def save(rel, raw, work):
    if "\r\n" in raw:
        work = work.replace("\n", "\r\n")
    (ROOT / rel).write_bytes(work.encode("utf-8"))


def rep(work, old, new, count, label):
    got = work.count(old)
    assert got == count, f"{label}: expected {count} got {got}"
    return work.replace(old, new)


# ============ src/desktop/helper/desktop_ipc.py ============
rel = "src/desktop/helper/desktop_ipc.py"
raw, work = load(rel)

# ---- B4 常量 ----
work = rep(work,
    "MAX_OBSERVATION_AGE_SECONDS = 2.0\n",
    "MAX_OBSERVATION_AGE_SECONDS = 2.0\n"
    "# ACK 后等待 canonical state 出现 ACK turn 的有界 deadline；只轮询 state，绝不重发 start-turn。\n"
    "POST_START_STATE_DEADLINE_SECONDS = 10.0\n",
    1, "deadline-const")

# ---- B1 _prepare 签名与函数体 ----
old = '''def _prepare(target: dict[str, str], *, allow_active: bool = False,
             require_runner_ancestor: bool = False) -> tuple[_Prepared, dict[str, Any]]:
    _query_standard_token()
    process: dict[str, Any] | None = None
    pipe = _Pipe()
    try:
        process = _verify_process_identity(pipe, target)
        client = _IpcClient(pipe, target["threadId"], target["hostId"])
        client.initialize()
        client.discover()
        state = client.snapshot()
        _validate_observed_state(state, target, client.owner or "")
        if not allow_active:
            _assert_send_ready(state)
        info = _public_info(state, target, client)
        if allow_active:
            client.drain(0.1)
            state = client.current_state()
            if state is None or client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, client.owner or "")
            info = _public_info(state, target, client)
'''
new = '''def _prepare(target: dict[str, str], *, purpose: str = "send",
             require_runner_ancestor: bool = False) -> tuple[_Prepared, dict[str, Any]]:
    """purpose="observe" 只观察（忙/请求/未确认提交都允许）；purpose="send" 才做 send-ready gate。"""
    if purpose not in {"observe", "send"}:
        raise _error("DESKTOP_INVALID_REQUEST")
    _query_standard_token()
    process: dict[str, Any] | None = None
    pipe = _Pipe()
    try:
        process = _verify_process_identity(pipe, target)
        client = _IpcClient(pipe, target["threadId"], target["hostId"])
        client.initialize()
        client.discover()
        state = client.snapshot()
        _validate_observed_state(state, target, client.owner or "")
        if purpose == "send":
            _assert_send_ready(state)
        info = _public_info(state, target, client)
        if purpose == "observe":
            client.drain(0.1)
            state = client.current_state()
            if state is None or client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            _validate_observed_state(state, target, client.owner or "")
            info = _public_info(state, target, client)
'''
work = rep(work, old, new, 1, "prepare-body")

# ---- B1 调用点（先长后短，避免子串误替换）----
work = rep(work, "session, info = _prepare(target, allow_active=True, require_runner_ancestor=True)",
           'session, info = _prepare(target, purpose="observe", require_runner_ancestor=True)', 1, "current-observe")
work = rep(work, "session, _ = _prepare(target, allow_active=True, require_runner_ancestor=True)",
           'session, _ = _prepare(target, purpose="observe", require_runner_ancestor=True)', 4, "inspect-observe")
work = rep(work, "session, _ = _prepare(target, allow_active=True)",
           'session, _ = _prepare(target, purpose="observe")', 4, "reconcile-call")

# ---- B1 _main inspect / prepare ----
old = '''            if op == "inspect":
                target = _target(request.get("target"))
                session, info = _prepare(target)
                session.close()'''
new = '''            if op == "inspect":
                target = _target(request.get("target"))
                session, info = _prepare(target, purpose="observe")
                session.close()'''
work = rep(work, old, new, 1, "main-inspect")
old = '''                target = _target(request.get("target"))
                prepared, info = _prepare(target)
                _reply({"id": request_id, "ok": True, "value": info})'''
new = '''                target = _target(request.get("target"))
                prepared, info = _prepare(target, purpose="send")
                _reply({"id": request_id, "ok": True, "value": info})'''
work = rep(work, old, new, 1, "main-prepare")

# ---- B2 _find_live_turn_by_id ----
old = '''def _find_live_turn_by_id(state: dict[str, Any], turn_id: str, message: str) -> list[str]:
    """在当前 canonical representation 中查找指定 turn；不要求历史 exhaust。

    找到 0 个或多于 1 个都视为失败；候选必须通过严格 userMessage 结构检查，
    且正文与提交的 C2C envelope 完全一致。不解析业务字段。
    """
    history = state.get("turnHistory")
    if isinstance(history, dict) and history.get("kind") == "canonical":
        body = history.get("history")
        if (not isinstance(body, dict) or not isinstance(body.get("islands"), list)
                or not isinstance(body.get("entitiesByKey"), dict)):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        turns: list[Any] = []
        for island in body["islands"]:
            entries = island.get("entries") if isinstance(island, dict) else None
            if not isinstance(entries, list):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            for entry in entries:
                key = entry.get("value") if isinstance(entry, dict) else None
                item = body["entitiesByKey"].get(key) if isinstance(key, str) else None
                if not isinstance(item, dict):
                    raise _error("DESKTOP_STATE_UNAVAILABLE")
                turns.append(item)
    else:
        turns = state.get("turns")
        if not isinstance(turns, list):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    matches: list[str] = []
    for turn in turns:
        if not isinstance(turn, dict) or turn.get("turnId") != turn_id:
            continue
        if _turn_text_for_reconciliation(turn) == message:
            matches.append(turn_id)
    return matches'''
new = '''def _find_live_turn_by_id(state: dict[str, Any], turn_id: str, message: str) -> list[str]:
    """在 canonical 历史中按 turnId 找出所有 occurrence，必须恰好一个。

    先按 turnId 收集全部 occurrence（不看正文）；不是恰好 1 个即失败，
    避免同 turnId 一对一错时被错误接受。然后对唯一 occurrence 做严格
    userMessage 结构检查，并要求正文与提交的 C2C envelope 完全一致。
    不解析业务字段；不 fallback 到 flat turns——post-start 证明只接受
    turnHistory.kind == "canonical" 的 state（不要求 newerBoundary exhaust）。
    """
    history = state.get("turnHistory")
    if not isinstance(history, dict) or history.get("kind") != "canonical":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    body = history.get("history")
    if (not isinstance(body, dict) or not isinstance(body.get("islands"), list)
            or not isinstance(body.get("entitiesByKey"), dict)):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    occurrences: list[dict[str, Any]] = []
    for island in body["islands"]:
        entries = island.get("entries") if isinstance(island, dict) else None
        if not isinstance(entries, list):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        for entry in entries:
            key = entry.get("value") if isinstance(entry, dict) else None
            item = body["entitiesByKey"].get(key) if isinstance(key, str) else None
            if not isinstance(item, dict):
                raise _error("DESKTOP_STATE_UNAVAILABLE")
            if item.get("turnId") == turn_id:
                occurrences.append(item)
    if len(occurrences) != 1:
        return []
    if _turn_text_for_reconciliation(occurrences[0]) != message:
        return []
    return [turn_id]'''
work = rep(work, old, new, 1, "find-live-turn")

# ---- B5 + B4 send() post-start ----
old = '''        # 以最后一次状态观测建立 ACK 防重放集合与 observation 高水位。
        before_turn_ids = {'''
new = '''        # mutation boundary 前最后一次 targeted owner fence；协议没有原子
        # idle/start CAS，故把 owner 漂移窗口压到这次 discover 之后。
        self.client.discover()
        # 以最后一次状态观测建立 ACK 防重放集合与 observation 高水位。
        before_turn_ids = {'''
work = rep(work, old, new, 1, "targeted-fence")

old = '''            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            state = self.client.snapshot()
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            if state.get("id") != self.target["threadId"] or state.get("hostId") != self.target["hostId"]:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- canonical state 中的精确结果证明 ----
            if len(_find_live_turn_by_id(state, turn_id, message)) != 1:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)'''
new = '''            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            state = self.client.snapshot()
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- bounded wait：只轮询 state，绝不重发 start-turn ----
            # turnId 尚未出现可以继续等；duplicate / malformed / wrong text 立即 unknown；
            # deadline 内出现唯一精确 canonical turn 才成功。
            deadline = time.monotonic() + POST_START_STATE_DEADLINE_SECONDS
            while len(_find_live_turn_by_id(state, turn_id, message)) != 1:
                if time.monotonic() >= deadline:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                state = self.client.snapshot()
                if self.client.snapshot_serial <= before_serial:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                if state.get("id") != self.target["threadId"] or state.get("hostId") != self.target["hostId"]:
                    raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
                _validate_observed_state(state, self.target, self.client.owner or "")'''
work = rep(work, old, new, 1, "bounded-wait")

# ---- C7 helper diagnose mode ----
old = '''        return {
            "processStable": True,
            "initialize": True,'''
new = '''        return {
            "mode": "behavioral",
            "processStable": True,
            "initialize": True,'''
work = rep(work, old, new, 1, "helper-diagnose-mode")

ast.parse(work)
save(rel, raw, work)
print("desktop_ipc.py OK")

# ============ tests/desktop_protocol_test.py ============
rel = "tests/desktop_protocol_test.py"
raw, work = load(rel)

# B1: 既有 observe 调用点
work = rep(work, "h._prepare(self.target, allow_active=True)",
           'h._prepare(self.target, purpose="observe")', 3, "protocol-observe-calls")

# _send_fixture → canonical
old = '''    def _send_fixture(self, *, turn_id=NEW_TURN, message="完整方案"):
        """send attestation 测试夹具：ACK turn 已进入 canonical 历史。"""
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": turn_id, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.state["turns"] = list(self.pipe.state.get("turns", [])) + [turn]
        self.pipe.turn_id = turn_id
        return message'''
new = '''    def _send_fixture(self, *, turn_id=NEW_TURN, message="完整方案"):
        """send attestation 测试夹具：ACK turn 已进入 non-exhausted canonical 历史。"""
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": turn_id, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        self.pipe.state["turns"] = list(self.pipe.state.get("turns", [])) + [turn]
        self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
            "islands": [{
                "olderBoundary": {"status": "exhausted"},
                "entries": [{"value": "turn-old"}, {"value": "turn-new"}],
                "newerBoundary": {"status": "loading"},
            }],
            "entitiesByKey": {
                "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                "turn-new": turn,
            },
        }}
        self.pipe.turn_id = turn_id
        return message'''
work = rep(work, old, new, 1, "send-fixture")

# _inject_on_start → 同步 canonical
old = '''    def _inject_on_start(self, injected):
        """让 pipe 在收到 start-turn 后把指定 turn 追加进 canonical 状态。"""
        original_write = self.pipe.write

        def write_with_turns(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turns"].extend(copy.deepcopy(injected))

        return patch.object(self.pipe, "write", write_with_turns)'''
new = '''    def _inject_on_start(self, injected):
        """让 pipe 在收到 start-turn 后把指定 turn 追加进状态与 canonical 历史。"""
        original_write = self.pipe.write

        def write_with_turns(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turns"].extend(copy.deepcopy(injected))
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-old"}, {"value": "turn-new"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {
                        "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                        "turn-new": copy.deepcopy(injected[-1]) if injected
                                    else {"turnId": OLD_TURN, "status": "completed"},
                    },
                }}

        return patch.object(self.pipe, "write", write_with_turns)'''
work = rep(work, old, new, 1, "inject-on-start")

# B1 新测试：插在 send attestation 测试之前
anchor = "    def test_send_attestation_accepts_when_ack_turn_matches_envelope(self):"
b1_tests = '''    def test_inspect_observes_active_and_pending_without_start_turn(self):
        # inspect 是 observe purpose：active + pending approval 仍可观察，绝不 start-turn。
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        self.pipe.state["requests"] = [{"kind": "approval"}]
        self.pipe.state["turns"] = [{"turnId": OLD_TURN, "status": "inProgress"}]
        request = {"id": CLIENT, "op": "inspect", "target": self.target}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        response = json.loads(output.buffer.getvalue())
        self.assertTrue(response["ok"])
        self.assertEqual(response["value"]["runtimeStatus"], "active")
        self.assertEqual(response["value"]["requestsCount"], 1)
        self.assertEqual(self.pipe.starts(), [])

    def test_prepare_send_purpose_gates_active_and_pending(self):
        # 同一状态：send purpose 的 prepare 分别被 BUSY / APPROVAL_PENDING 拒绝。
        self.pipe.state["threadRuntimeStatus"] = {"type": "active"}
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="send")
        self.assertEqual(caught.exception.code, "DESKTOP_BUSY")
        self.assertEqual(self.pipe.starts(), [])

        self.pipe.state["threadRuntimeStatus"] = {"type": "idle"}
        self.pipe.state["requests"] = [{"kind": "approval"}]
        with self.assertRaises(h.DesktopIpcError) as caught:
            h._prepare(self.target, purpose="send")
        self.assertEqual(caught.exception.code, "DESKTOP_APPROVAL_PENDING")
        self.assertEqual(self.pipe.starts(), [])

'''
work = rep(work, anchor, b1_tests + anchor, 1, "b1-tests")

# B3 mixed-duplicate + B4 两测试：插在 process drift 测试之前
anchor = "    def test_post_start_process_drift_is_outcome_unknown(self):"
b34_tests = '''    def test_send_attestation_rejects_mixed_duplicate_turn_id(self):
        # 同一 turnId 出现两次：一个正文精确、一个正文错误。先按 turnId 判重
        # （必须恰好 1 个 occurrence），因此必须收敛 OUTCOME_UNKNOWN。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        exact = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                 "items": [{"type": "userMessage", "content": [item]}]}
        wrong_item = {"type": "text", "text": "别的消息", "text_elements": []}
        wrong = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [wrong_item]},
                 "items": [{"type": "userMessage", "content": [wrong_item]}]}
        original_write = self.pipe.write

        def write_with_mixed(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-a"}, {"value": "turn-b"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {"turn-a": exact, "turn-b": wrong},
                }}

        with patch.object(self.pipe, "write", write_with_mixed):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_bounded_wait_accepts_turn_on_second_observation(self):
        # ACK 后第一次 fresh canonical snapshot 还没有该 turn；有界等待内第二次
        # observation 出现唯一精确 turn → 成功，且 start-turn 仍恰好一次。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        item = {"type": "text", "text": message, "text_elements": []}
        turn = {"turnId": NEW_TURN, "status": "inProgress", "params": {"input": [item]},
                "items": [{"type": "userMessage", "content": [item]}]}
        original_write = self.pipe.write
        observations = {"count": 0}

        def write_with_late_turn(raw):
            original_write(raw)
            if self.pipe.start_seen and self.pipe.frames[-1].get("method") == "thread-stream-following-changed":
                observations["count"] += 1
                if observations["count"] >= 2:
                    self.pipe.state["turns"].append(copy.deepcopy(turn))
                    self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                        "islands": [{
                            "olderBoundary": {"status": "exhausted"},
                            "entries": [{"value": "turn-old"}, {"value": "turn-new"}],
                            "newerBoundary": {"status": "loading"},
                        }],
                        "entitiesByKey": {
                            "turn-old": {"turnId": OLD_TURN, "status": "completed"},
                            "turn-new": copy.deepcopy(turn),
                        },
                    }}

        with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 2.0), \\
                patch.object(self.pipe, "write", write_with_late_turn):
            self.assertEqual(session.send(message), {"threadId": THREAD, "turnId": NEW_TURN})
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

    def test_post_start_bounded_wait_expires_as_outcome_unknown(self):
        # 有界等待内 canonical state 始终没有 ACK turn → OUTCOME_UNKNOWN，且不重发。
        session, _ = h._prepare(self.target)
        message = "完整方案"
        original_write = self.pipe.write

        def write_without_turn(raw):
            original_write(raw)
            if self.pipe.start_seen and self.pipe.frames[-1].get("method") == "thread-stream-following-changed":
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": [{"value": "turn-old"}],
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": {"turn-old": {"turnId": OLD_TURN, "status": "completed"}},
                }}

        with patch.object(h, "POST_START_STATE_DEADLINE_SECONDS", 0.2), \\
                patch.object(h, "SNAPSHOT_TIMEOUT_SECONDS", 0.05), \\
                patch.object(self.pipe, "write", write_without_turn):
            with self.assertRaises(h.DesktopIpcError) as caught:
                session.send(message)
        self.assertEqual(caught.exception.code, "DESKTOP_OUTCOME_UNKNOWN")
        self.assertFalse(caught.exception.not_sent)
        self.assertEqual(len(self.pipe.starts()), 1)
        session.close()

'''
work = rep(work, anchor, b34_tests + anchor, 1, "b34-tests")

# post-start owner drift 测试：discover 序列加一位（preflight, targeted, final）
old = '''        with patch.object(h._IpcClient, "discover", side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]), \\
                self._inject_on_start([turn]):'''
new = '''        with patch.object(h._IpcClient, "discover", side_effect=[None, None, h._error("DESKTOP_OWNER_CHANGED")]), \\
                self._inject_on_start([turn]):'''
work = rep(work, old, new, 1, "owner-drift-sequence")

# B5 测试：插在 current_identity 测试之前
anchor = "    def test_current_identity_uses_current_env_mapping_and_allows_active_without_start(self):"
b5_test = '''    def test_pre_start_owner_drift_after_final_state_check_is_not_sent(self):
        # 最后一次状态检查之后的 targeted owner fence 发现漂移 → 具体错误 + notSent=true，
        # start-turn 计数为 0；post-start final fence 不受影响。
        session, _ = h._prepare(self.target)
        with patch.object(h._IpcClient, "discover",
                          side_effect=[None, h._error("DESKTOP_OWNER_CHANGED")]), \\
                self.assertRaises(h.DesktopIpcError) as caught:
            session.send("完整方案")
        self.assertEqual(caught.exception.code, "DESKTOP_OWNER_CHANGED")
        self.assertTrue(caught.exception.not_sent)
        self.assertEqual(self.pipe.starts(), [])
        session.close()

'''
work = rep(work, anchor, b5_test + anchor, 1, "b5-test")

# real_protocol_flow：6 请求帧 + canonical non-exhausted 断言
old = '''        self.assertEqual([frame["method"] for frame in self.pipe.frames if frame["type"] == "request"],
                         ["initialize", "thread-owner-discovery", "thread-owner-discovery",
                          "thread-follower-start-turn", "thread-owner-discovery"])
        session.close()'''
new = '''        self.assertEqual([frame["method"] for frame in self.pipe.frames if frame["type"] == "request"],
                         ["initialize", "thread-owner-discovery", "thread-owner-discovery",
                          "thread-owner-discovery", "thread-follower-start-turn", "thread-owner-discovery"])
        newer = self.pipe.state["turnHistory"]["history"]["islands"][0]["newerBoundary"]
        self.assertNotEqual(newer.get("status"), "exhausted")
        session.close()'''
work = rep(work, old, new, 1, "real-flow")

# C7 Python diagnose mode 测试
anchor = "    def test_inspect_result_context_main_requires_exact_target_request(self):"
c7_test = '''    def test_diagnose_reports_behavioral_mode(self):
        # diagnosis 输出必须带 mode: "behavioral"，明确告诉机器消费者这不是 compatibility 分类。
        request = {"id": CLIENT, "op": "diagnose", "workspaceRoot": "workspace"}
        source = SimpleNamespace(buffer=io.BytesIO(h._json_bytes(request) + b"\\n"))
        output = SimpleNamespace(buffer=io.BytesIO())
        with patch.object(h, "_diagnose", return_value={"mode": "behavioral", "processStable": True}), \\
                patch.object(sys, "stdin", source), patch.object(sys, "stdout", output):
            h._main()
        self.assertEqual(json.loads(output.buffer.getvalue()),
                         {"id": CLIENT, "ok": True, "value": {"mode": "behavioral", "processStable": True}})

'''
work = rep(work, anchor, c7_test + anchor, 1, "c7-test")

ast.parse(work)
save(rel, raw, work)
print("desktop_protocol_test.py OK")

# ============ tests/desktop_ipc_helper_test.py ============
rel = "tests/desktop_ipc_helper_test.py"
raw, work = load(rel)
work = rep(work, "prepare.assert_called_once_with(TARGET, allow_active=True, require_runner_ancestor=True)",
           'prepare.assert_called_once_with(TARGET, purpose="observe", require_runner_ancestor=True)', 1, "helper-212")
work = rep(work, "prepare.assert_called_once_with(TARGET, allow_active=True)",
           'prepare.assert_called_once_with(TARGET, purpose="observe")', 1, "helper-439")
ast.parse(work)
save(rel, raw, work)
print("desktop_ipc_helper_test.py OK")

# ============ src/desktop/ipc.ts ============
rel = "src/desktop/ipc.ts"
raw, work = load(rel)
old = '''export interface DesktopDiagnosis {
  processStable: true;
  initialize: true;
  ownerDiscovery: boolean;'''
new = '''export interface DesktopDiagnosis {
  mode: "behavioral";
  processStable: true;
  initialize: true;
  ownerDiscovery: boolean;'''
work = rep(work, old, new, 1, "ipc-interface")
old = '''  if (Object.keys(input).sort().join(",") !==
      "followingChangedSent,initialize,ownerDiscovery,processStable,stateChange,stateReceived") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (input.processStable !== true || input.initialize !== true ||'''
new = '''  if (Object.keys(input).sort().join(",") !==
      "followingChangedSent,initialize,mode,ownerDiscovery,processStable,stateChange,stateReceived") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (input.processStable !== true || input.initialize !== true || input.mode !== "behavioral" ||'''
work = rep(work, old, new, 1, "ipc-validator-keys")
old = '''  return {
    processStable: true,
    initialize: true,
    ownerDiscovery: input.ownerDiscovery as boolean,'''
new = '''  return {
    mode: "behavioral",
    processStable: true,
    initialize: true,
    ownerDiscovery: input.ownerDiscovery as boolean,'''
work = rep(work, old, new, 1, "ipc-validator-return")
save(rel, raw, work)
print("ipc.ts OK")

# ============ tests/desktop-ipc.test.ts ============
rel = "tests/desktop-ipc.test.ts"
raw, work = load(rel)
old = '''    const expected = {
      processStable: true,
      initialize: true,
      ownerDiscovery: true,'''
new = '''    const expected = {
      mode: "behavioral" as const,
      processStable: true,
      initialize: true,
      ownerDiscovery: true,'''
work = rep(work, old, new, 1, "ipc-test-expected")
old = '''    const base = {
      processStable: true,
      initialize: true,
      ownerDiscovery: true,'''
new = '''    const base = {
      mode: "behavioral" as const,
      processStable: true,
      initialize: true,
      ownerDiscovery: true,'''
work = rep(work, old, new, 1, "ipc-test-base")
old = '''    expect(() => validateDesktopDiagnosis({ ...base, initialize: false })).toThrowError(/无法确认/);'''
new = '''    expect(() => validateDesktopDiagnosis({ ...base, initialize: false })).toThrowError(/无法确认/);
    expect(() => validateDesktopDiagnosis({ ...base, mode: "compatibility" })).toThrowError(/无法确认/);'''
work = rep(work, old, new, 1, "ipc-test-mode-assert")
save(rel, raw, work)
print("desktop-ipc.test.ts OK")

# ============ tests/desktop-current.test.ts ============
rel = "tests/desktop-current.test.ts"
raw, work = load(rel)
old = '''  const diagnosis = {
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: true,'''
new = '''  const diagnosis = {
    mode: "behavioral" as const,
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: true,'''
work = rep(work, old, new, 1, "current-diagnosis-mock")
old = '''  const diagnose = vi.spyOn(desktopIpc, "diagnose").mockResolvedValue({
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: false,'''
new = '''  const diagnose = vi.spyOn(desktopIpc, "diagnose").mockResolvedValue({
    mode: "behavioral" as const,
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: false,'''
work = rep(work, old, new, 1, "current-alias-mock")
old = '''it.each(["DESKTOP_CURRENT_CONTEXT_INVALID", "DESKTOP_PROJECT_MISMATCH", "DESKTOP_NO_OWNER",
  "DESKTOP_VERSION_UNSUPPORTED", "DESKTOP_ELEVATED"])("%s 零绑定、零确认、零启用", async code => {'''
new = '''it.each(["DESKTOP_CURRENT_CONTEXT_INVALID", "DESKTOP_PROJECT_MISMATCH", "DESKTOP_NO_OWNER",
  "DESKTOP_ELEVATED"])("%s 零绑定、零确认、零启用", async code => {'''
work = rep(work, old, new, 1, "current-it-each")
save(rel, raw, work)
print("desktop-current.test.ts OK")

# ============ tests/desktop-control.test.ts ============
rel = "tests/desktop-control.test.ts"
raw, work = load(rel)
old = '''  it.each(["DESKTOP_BUSY", "DESKTOP_AWAITING_APPROVAL", "DESKTOP_NO_OWNER", "DESKTOP_WRONG_PROJECT", "DESKTOP_VERSION_UNSUPPORTED", "DESKTOP_ELEVATED"])("%s 预检失败零发送", async code => {'''
new = '''  it.each(["DESKTOP_BUSY", "DESKTOP_AWAITING_APPROVAL", "DESKTOP_NO_OWNER", "DESKTOP_WRONG_PROJECT", "DESKTOP_ELEVATED"])("%s 预检失败零发送", async code => {'''
work = rep(work, old, new, 1, "control-it-each")
save(rel, raw, work)
print("desktop-control.test.ts OK")

# ============ src/cli/desktop.ts ============
rel = "src/cli/desktop.ts"
raw, work = load(rel)
old = '''          `Desktop live 诊断：processStable=${result.processStable}；initialize=${result.initialize}；owner=${result.ownerDiscovery}；following=${result.followingChangedSent}；state=${result.stateChange ?? "none"}。`);'''
new = '''          `Desktop live 诊断（mode=${result.mode}）：processStable=${result.processStable}；initialize=${result.initialize}；owner=${result.ownerDiscovery}；following=${result.followingChangedSent}；state=${result.stateChange ?? "none"}。`);'''
work = rep(work, old, new, 1, "cli-print")
save(rel, raw, work)
print("desktop.ts OK")

# ============ skill/SKILL.md ============
rel = "skill/SKILL.md"
raw, work = load(rel)
old = '''     遇到 `DESKTOP_VERSION_UNSUPPORTED`，报告 `observedDesktopVersion`、
     `observedAppServerVersion`、`status`、`profile`；必要时 `c2c desktop compatibility --json`。
     这是本机 Desktop 协议诊断，不是 OAuth `desktopCompatibility`；不能以其中一个替代另一个。
     未验证版本保持未就绪，不自动添加 profile、放宽版本/hash 或重新授权来绕过。'''
new = '''     Desktop 可用性由 live 行为决定，不存在版本/profile 门禁；`DESKTOP_VERSION_UNSUPPORTED`
     已随旧版本白名单体系删除，不再出现。诊断用 `c2c desktop diagnose --json`
     （别名 `compatibility`，输出 `mode: "behavioral"`）：它只描述这一次 live IPC
     handshake 实际发生了什么，不是 OAuth `desktopCompatibility`；不能以其中一个替代另一个。
     诊断失败保持未就绪，不猜测版本、不恢复任何 profile/hash 白名单、不重新授权来绕过。'''
work = rep(work, old, new, 1, "skill-paragraph")
save(rel, raw, work)
print("SKILL.md OK")

# ============ tests/activation-skill.test.ts ============
rel = "tests/activation-skill.test.ts"
raw, work = load(rel)
old = '''  it("Desktop 版本 / launcher / 触发语安全契约", () => {
    for (const text of ["DESKTOP_VERSION_UNSUPPORTED", "observedDesktopVersion", "不是 OAuth `desktopCompatibility`",
      "启用 ChatGPT 工作流", "Enable the ChatGPT workflow"])
      expect(skill).toContain(text);
    expect(skill.match(/<C2C_LAUNCHER_PATH>/g)).toHaveLength(1);
  });'''
new = '''  it("Desktop 行为模型 / launcher / 触发语安全契约", () => {
    for (const text of ["c2c desktop diagnose", 'mode: "behavioral"', "不是 OAuth `desktopCompatibility`",
      "启用 ChatGPT 工作流", "Enable the ChatGPT workflow"])
      expect(skill).toContain(text);
    for (const legacy of ["DESKTOP_VERSION_UNSUPPORTED", "observedDesktopVersion", "observedAppServerVersion"])
      expect(skill).not.toContain(legacy);
    expect(skill.match(/<C2C_LAUNCHER_PATH>/g)).toHaveLength(1);
  });'''
work = rep(work, old, new, 1, "activation-test")
save(rel, raw, work)
print("activation-skill.test.ts OK")

# ============ docs/desktop-control.md ============
rel = "docs/desktop-control.md"
raw, work = load(rel)
old = '''状态接收与变更类型），不做 trusted/untrusted 分类，也不输出版本或 bundle 信息；'''
new = '''状态接收与变更类型，附带 `mode: "behavioral"` 标记），不做 trusted/untrusted 分类，
也不输出版本或 bundle 信息；'''
work = rep(work, old, new, 1, "docs-mode")
save(rel, raw, work)
print("desktop-control.md OK")

print("ALL DONE")
