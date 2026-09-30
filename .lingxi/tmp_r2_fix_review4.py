# -*- coding: utf-8 -*-
"""第四轮：_inject_on_start 的 canonical 构造保留每个 injected turn 独立 key。"""
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


rel = "tests/desktop_protocol_test.py"
raw, work = load(rel)

old = '''        def write_with_turns(raw):
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
                }}'''
new = '''        def write_with_turns(raw):
            original_write(raw)
            if self.pipe.frames[-1].get("method") == "thread-follower-start-turn":
                self.pipe.state["turns"].extend(copy.deepcopy(injected))
                entities = {"turn-old": {"turnId": OLD_TURN, "status": "completed"}}
                entries = [{"value": "turn-old"}]
                for index, item in enumerate(injected):
                    key = f"turn-new-{index}"
                    entries.append({"value": key})
                    entities[key] = copy.deepcopy(item)
                self.pipe.state["turnHistory"] = {"kind": "canonical", "history": {
                    "islands": [{
                        "olderBoundary": {"status": "exhausted"},
                        "entries": entries,
                        "newerBoundary": {"status": "loading"},
                    }],
                    "entitiesByKey": entities,
                }}'''
work = rep(work, old, new, 1, "inject-canonical-keys")

ast.parse(work)
save(rel, raw, work)
print("OK")
