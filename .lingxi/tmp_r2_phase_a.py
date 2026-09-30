# -*- coding: utf-8 -*-
"""R2 Phase A 手术脚本：desktop_ipc.py 收敛为 behavioral adapter。

S1  _verify_runtime_identity -> _verify_process_identity（去 version 观测）
S2  _IpcClient._handle wire version != 11 -> DESKTOP_PROTOCOL_ERROR
S3  _validate_state -> _validate_observed_state / _assert_send_ready 拆分
S4  _public_info 去 version/profile 字段
S5  _Prepared.send -> behavioral send attestation（显式 mutation boundary）
S6  _prepare 收敛（删 candidate handshake / VERSION_UNSUPPORTED fallback）
S7  _handshake_audit -> _diagnose（只读 live handshake，不做信任分类）
S8  identity 辅助函数收敛（去 runtime 比较；_current_identity_checked 返回 info）
S9  新增 _find_live_turn_by_id（不要求 canonical history exhausted）
S10 _main 分发收敛（diagnose op；错误 reply 去 compatibility 附加）
S11 全文调用点切换 + 残留检查
"""
import ast

P = 'src/desktop/helper/desktop_ipc.py'


def load():
    return open(P, encoding='utf-8').read().split('\n')


def save(lines):
    out = '\n'.join(lines)
    ast.parse(out)
    open(P, 'w', encoding='utf-8', newline='\n').write(out)
    print('  saved, lines =', len(lines))


def find_def(lines, name):
    start = None
    for i, line in enumerate(lines):
        if line.startswith('def ' + name + '(') or line.startswith('class ' + name):
            start = i
            break
    if start is None:
        raise SystemExit('not found: ' + name)
    end = start
    for j in range(start + 1, len(lines)):
        if lines[j].strip() == '':
            continue
        if lines[j][0] not in (' ', '\t'):
            end = j - 1
            break
    else:
        end = len(lines) - 1
    while end > start and lines[end].strip() == '':
        end -= 1
    return start, end


def replace_block(lines, name, new_text):
    start, end = find_def(lines, name)
    lines[start:end + 1] = new_text.split('\n')
    return lines


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, got {count}')
    return text.replace(old, new)


lines = load()

# ---------------------------------------------------------------- S1
print('S1: _verify_process_identity')
NEW_VERIFY = '''def _verify_process_identity(pipe: _Pipe, target: dict[str, str], expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """核对当前 pipe 对端是唯一 ChatGPT Desktop 进程树；不读取版本或 bundle。"""
    pipe.verify_server()
    rows = _processes()
    server = next((row for row in rows if row["pid"] == pipe.server_pid), None)
    if not server or server["name"].casefold() != "chatgpt.exe" or not server["exe"] or server["creation"] <= 0:
        raise _error("DESKTOP_IPC_SERVER_MISMATCH")
    if _normalize_path(server["exe"]) != _normalize_path(pipe.server_exe):
        raise _error("DESKTOP_IPC_SERVER_MISMATCH")
    children = [row for row in rows if row["name"].casefold() == "codex.exe" and row["parentPid"] == pipe.server_pid]
    if len(children) != 1 or not children[0]["exe"] or children[0]["creation"] <= 0:
        raise _error("DESKTOP_PROCESS_CHANGED")
    app_server = children[0]
    if expected and (
        expected["desktopPid"] != pipe.server_pid
        or expected["appServerPid"] != app_server["pid"]
        or expected["desktopCreation"] != server["creation"]
        or expected["appServerCreation"] != app_server["creation"]
        or _normalize_path(expected["desktopExe"]) != _normalize_path(server["exe"])
        or _normalize_path(expected["appServerExe"]) != _normalize_path(app_server["exe"])
    ):
        raise _error("DESKTOP_PROCESS_CHANGED")
    _verify_project(target)
    return {
        "desktopPid": pipe.server_pid,
        "desktopExe": server["exe"],
        "desktopCreation": server["creation"],
        "appServerPid": app_server["pid"],
        "appServerExe": app_server["exe"],
        "appServerCreation": app_server["creation"],
    }'''
lines = replace_block(lines, '_verify_runtime_identity', NEW_VERIFY)

# ---------------------------------------------------------------- S2
print('S2: wire version drift -> DESKTOP_PROTOCOL_ERROR')
text = '\n'.join(lines)
text = replace_once(
    text,
    '        if value.get("version") != 11:\n            raise _error("DESKTOP_VERSION_UNSUPPORTED")',
    '        if value.get("version") != 11:\n            raise _error("DESKTOP_PROTOCOL_ERROR")',
    'S2 wire version')
lines = text.split('\n')

# ---------------------------------------------------------------- S3
print('S3: _validate_observed_state / _assert_send_ready')
NEW_VALIDATE = '''def _validate_observed_state(state: dict[str, Any], target: dict[str, str], owner: str) -> None:
    """验证这是正确且结构可理解的会话；忙、请求或未确认提交允许存在。

    只读观察不跳过 shape validation：所有字段的类型仍必须合法，
    turn status 非法值仍然拒绝。
    """
    if state.get("id") != target["threadId"] or state.get("hostId") != target["hostId"]:
        raise _error("DESKTOP_TARGET_NOT_FOUND")
    cwd = state.get("cwd")
    if not isinstance(cwd, str) or _normalize_path(cwd) != _normalize_path(target["workspaceRoot"]):
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if state.get("workspaceKind") != "project":
        raise _error("DESKTOP_PROJECT_MISMATCH")
    if state.get("resumeState") != "resumed":
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type not in {"idle", "active", "inProgress"}:
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if not isinstance(state.get("requests"), list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    if not isinstance(state.get("unconfirmedTurnSubmissions"), list):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    terminal_statuses = {"completed", "failed", "interrupted", "cancelled"}
    for turn in _turns(state):
        status = turn.get("status")
        if status != "inProgress" and status not in terminal_statuses:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
    for environment in state.get("environments") or []:
        if not isinstance(environment, dict) or _normalize_path(str(environment.get("cwd", ""))) != _normalize_path(target["workspaceRoot"]):
            raise _error("DESKTOP_PROJECT_MISMATCH")
    _require(bool(owner), "DESKTOP_NO_OWNER")

def _assert_send_ready(state: dict[str, Any]) -> None:
    """发送前 runtime gate：idle、无请求、无未确认提交、无 inProgress turn。

    不含 owner 一致性——owner 属于 _IpcClient session identity，
    由 prepare/send 前后的 owner fence 单独保证。
    """
    runtime = state.get("threadRuntimeStatus")
    runtime_type = runtime.get("type") if isinstance(runtime, dict) else None
    if runtime_type != "idle":
        raise _error("DESKTOP_BUSY")
    if state.get("requests"):
        raise _error("DESKTOP_APPROVAL_PENDING")
    if state.get("unconfirmedTurnSubmissions"):
        raise _error("DESKTOP_APPROVAL_PENDING")
    for turn in _turns(state):
        if turn.get("status") == "inProgress":
            raise _error("DESKTOP_BUSY")'''
lines = replace_block(lines, '_validate_state', NEW_VALIDATE)

# ---------------------------------------------------------------- S4
print('S4: _public_info')
NEW_PUBLIC_INFO = '''def _public_info(state: dict[str, Any], target: dict[str, str], client: _IpcClient) -> dict[str, Any]:
    title = state.get("title")
    cwd = state.get("cwd")
    runtime_state = state.get("threadRuntimeStatus")
    runtime_status = runtime_state.get("type") if isinstance(runtime_state, dict) else None
    if (not isinstance(title, str) or not title.strip() or len(title) > 300 or not isinstance(cwd, str)
            or not isinstance(runtime_status, str)):
        raise _error("DESKTOP_STATE_UNAVAILABLE")
    return {
        "threadId": target["threadId"],
        "hostId": target["hostId"],
        "projectId": target["projectId"],
        "workspaceRoot": target["workspaceRoot"],
        "title": title,
        "cwd": cwd,
        "workspaceKind": state.get("workspaceKind"),
        "resumeState": state.get("resumeState"),
        "runtimeStatus": runtime_status,
        "requestsCount": len(state.get("requests", [])),
        "ownerClientId": client.owner,
    }'''
lines = replace_block(lines, '_public_info', NEW_PUBLIC_INFO)

# ---------------------------------------------------------------- S5
print('S5: _Prepared.send behavioral attestation')
NEW_PREPARED = '''class _Prepared:
    target: dict[str, str]
    pipe: _Pipe
    client: _IpcClient
    process: dict[str, Any]

    def _process_fence(self) -> None:
        _verify_process_identity(self.pipe, self.target, self.process)

    def send(self, message: str) -> dict[str, str]:
        """Behavioral send attestation：单次 start-turn + 事后 canonical 证明。"""
        self.start_attempted = False
        _message(message)
        _query_standard_token()
        # ---- preflight：start-turn 之前，失败可返回具体错误且 notSent=true ----
        self._process_fence()
        self.client.discover()
        state = self.client.snapshot()
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        _query_standard_token()
        # 提交前最后核对进程与 owner；协议没有原子 idle/start CAS，故保持窗口有界。
        self._process_fence()
        self.client.drain(0.1)
        state = self.client.current_state()
        if state is None or self.client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _validate_observed_state(state, self.target, self.client.owner or "")
        _assert_send_ready(state)
        # 以最后一次状态观测建立 ACK 防重放集合与 observation 高水位。
        before_turn_ids = {
            turn.get("turnId")
            for turn in _turns(state)
            if isinstance(turn.get("turnId"), str)
        }
        before_serial = self.client.snapshot_serial
        # ---- mutation boundary：唯一一次 start-turn 写入尝试前翻转 ----
        self.start_attempted = True
        try:
            request = self.client._envelope("thread-follower-start-turn", {
                "conversationId": self.target["threadId"],
                "turnStart": {
                    "request": {
                        "threadId": self.target["threadId"],
                        "input": [{"type": "text", "text": message, "text_elements": []}],
                    }
                },
            }, self.client.owner)
            response = self.client.request(request, SEND_TIMEOUT_SECONDS, sent_code="DESKTOP_OUTCOME_UNKNOWN")
            result = response.get("result")
            nested = result.get("result") if isinstance(result, dict) else None
            turn = nested.get("turn") if isinstance(nested, dict) else None
            turn_id = turn.get("id") if isinstance(turn, dict) else None
            if _uuid(turn_id) is None or turn_id in before_turn_ids:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- post-start observation fence：必须拿到 serial 严格增大的新 snapshot ----
            state = self.client.snapshot()
            if self.client.snapshot_serial <= before_serial:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            if state.get("id") != self.target["threadId"] or state.get("hostId") != self.target["hostId"]:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- canonical state 中的精确结果证明 ----
            if len(_find_live_turn_by_id(state, turn_id, message)) != 1:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            # ---- final process/owner fence ----
            self._process_fence()
            self.client.discover()
            return {"threadId": self.target["threadId"], "turnId": turn_id}
        except DesktopIpcError:
            # boundary 之后的一切不确定性统一收敛为 outcome unknown；
            # 不依赖下层 helper 的默认 not_sent，绝不第二次 start-turn。
            if self.start_attempted:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            raise
        except TimeoutError:
            if self.start_attempted:
                raise _error("DESKTOP_OUTCOME_UNKNOWN", not_sent=False)
            raise

    def close(self) -> None:
        self.pipe.close()'''
lines = replace_block(lines, '_Prepared', NEW_PREPARED)

# ---------------------------------------------------------------- S6
print('S6: _prepare 收敛')
NEW_PREPARE = '''def _prepare(target: dict[str, str], *, allow_active: bool = False,
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
        process = _verify_process_identity(pipe, target, process)
        if require_runner_ancestor:
            _verify_current_runner_ancestor(process)
        if client.snapshot_age() > MAX_OBSERVATION_AGE_SECONDS:
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        prepared = _Prepared(target, pipe, client, process)
        return prepared, info
    except DesktopIpcError as error:
        try:
            if error.code == "DESKTOP_NO_OWNER" and process is not None:
                _verify_process_identity(pipe, target, process)
        finally:
            pipe.close()
        raise
    except TimeoutError:
        pipe.close()
        raise _error("DESKTOP_IPC_TIMEOUT")
    except (OSError, ValueError, TypeError, KeyError):
        pipe.close()
        raise _error("DESKTOP_INTERNAL_ERROR")'''
lines = replace_block(lines, '_prepare', NEW_PREPARE)

# ---------------------------------------------------------------- S7
print('S7: _handshake_audit -> _diagnose')
NEW_DIAGNOSE = '''def _diagnose(workspace_root: Any) -> dict[str, Any]:
    """只读 live handshake 诊断；不发送 start-turn，不做信任分类。"""
    target = _current_target(workspace_root)
    _query_standard_token()
    pipe = _Pipe()
    session: _IpcClient | None = None
    try:
        before = _verify_process_identity(pipe, target)
        session = _IpcClient(pipe, target["threadId"], target["hostId"])
        session.initialize()
        owner = session.discover()
        state = session.snapshot()
        if not isinstance(state, dict):
            raise _error("DESKTOP_STATE_UNAVAILABLE")
        _verify_process_identity(pipe, target, before)
        return {
            "processStable": True,
            "initialize": True,
            "ownerDiscovery": bool(owner),
            "followingChangedSent": session.following_changed_sent,
            "stateReceived": session.state_change_kind in {"snapshot", "patches"},
            "stateChange": session.state_change_kind,
        }
    finally:
        if session is not None:
            session.pipe.close()
        else:
            pipe.close()'''
lines = replace_block(lines, '_handshake_audit', NEW_DIAGNOSE)

# ---------------------------------------------------------------- S8
print('S8: identity 辅助函数收敛')
NEW_CHECKED = '''def _current_identity_checked(workspace_root: Any) -> dict[str, Any]:
    target = _current_target(workspace_root)
    session, info = _prepare(target, allow_active=True, require_runner_ancestor=True)
    try:
        return info
    finally:
        session.close()'''
lines = replace_block(lines, '_current_identity_checked', NEW_CHECKED)

NEW_SAME = '''def _same_current_identity(left: dict[str, Any], right: dict[str, Any]) -> bool:
    for key in ("threadId", "hostId", "projectId", "workspaceRoot", "title", "workspaceKind", "resumeState",
                "ownerClientId"):
        if left.get(key) != right.get(key):
            return False
    return _normalize_path(str(left.get("cwd", ""))) == _normalize_path(str(right.get("cwd", "")))'''
lines = replace_block(lines, '_same_current_identity', NEW_SAME)

NEW_CONFIRM = '''def _current_confirm(workspace_root: Any) -> dict[str, Any]:
    before = _current_identity_checked(workspace_root)
    try:
        confirmed = _show_confirmation(before)
    except DesktopIpcError:
        raise
    except Exception:
        confirmed = False
    if confirmed is not True:
        raise _error("DESKTOP_CONFIRMATION_CANCELLED")
    after = _current_identity_checked(workspace_root)
    if not _same_current_identity(before, after):
        raise _error("DESKTOP_CURRENT_CONTEXT_INVALID")
    return after'''
lines = replace_block(lines, '_current_confirm', NEW_CONFIRM)

NEW_IDENTITY = '''def _current_identity(workspace_root: Any) -> dict[str, Any]:
    return _current_identity_checked(workspace_root)'''
lines = replace_block(lines, '_current_identity', NEW_IDENTITY)

# ---------------------------------------------------------------- S9
print('S9: _find_live_turn_by_id')
NEW_FIND = '''def _find_live_turn_by_id(state: dict[str, Any], turn_id: str, message: str) -> list[str]:
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
start, end = find_def(lines, '_turn_text_for_reconciliation')
lines[end + 1:end + 1] = NEW_FIND.split('\n') + ['']

# ---------------------------------------------------------------- S10
print('S10: _main 分发收敛')
text = '\n'.join(lines)
text = replace_once(
    text,
    '''            elif op == "compatibility":
                if set(request) != {"id", "op"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _compatibility()})
            elif op == "compatibility_audit":
                if set(request) != {"id", "op"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _compatibility_audit()})
            elif op == "handshake_audit":
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _handshake_audit(request.get("workspaceRoot"))})''',
    '''            elif op == "diagnose":
                if set(request) != {"id", "op", "workspaceRoot"} or prepared is not None:
                    raise _error("DESKTOP_INVALID_REQUEST")
                _reply({"id": request_id, "ok": True, "value": _diagnose(request.get("workspaceRoot"))})''',
    'S10 dispatch')
text = replace_once(
    text,
    '''        except DesktopIpcError as error:
            reply = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                     "code": error.code, "notSent": error.not_sent}
            if hasattr(error, "compatibility"):
                reply["compatibility"] = _safe_compatibility(getattr(error, "compatibility"))
            _reply(reply)''',
    '''        except DesktopIpcError as error:
            _reply({"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                    "code": error.code, "notSent": error.not_sent})''',
    'S10 error reply')

# ---------------------------------------------------------------- S11
print('S11: 调用点切换')
n = text.count('_public_info(state, target, session.runtime, session.client)')
text = text.replace('_public_info(state, target, session.runtime, session.client)',
                    '_public_info(state, target, session.client)')
print(f'  _public_info call sites: {n}')
n = text.count('_verify_runtime(')
text = text.replace('_verify_runtime(', '_verify_process_identity(')
print(f'  _verify_runtime call sites: {n}')
n = text.count('_validate_state(')
text = text.replace('_validate_state(', '_validate_observed_state(')
print(f'  _validate_state call sites: {n}')
n = text.count('session.runtime')
text = text.replace('session.runtime', 'session.process')
print(f'  session.runtime refs: {n}')
n = text.count('self.runtime')
text = text.replace('self.runtime', 'self.process')
print(f'  self.runtime refs: {n}')
lines = text.split('\n')
save(lines)

# ---------------------------------------------------------------- 残留检查
print('residue checks:')
text = '\n'.join(lines)
for bad in ['_verify_runtime(', '_validate_state(', 'DESKTOP_VERSION_UNSUPPORTED', 'candidate',
            'handshake', '_safe_', 'session.runtime', 'before_runtime', 'require_catalog',
            'VERIFIED_PROFILES', 'semanticFingerprint', '_compatibility', 'compatibility_audit',
            '_AsarAuditError', '_asar', 'desktopVersion', 'appServerVersion', '"profile"']:
    hits = [i + 1 for i, l in enumerate(lines) if bad in l]
    if hits:
        print(f'  RESIDUE {bad!r}: {hits[:10]}')
    else:
        print(f'  clean: {bad!r}')
