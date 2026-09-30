# -*- coding: utf-8 -*-
"""R3o: g4-rebind-browser.test.ts 全部消息构造补 canonicalRoute witness。"""
p = "tests/g4-rebind-browser.test.ts"
s = open(p, encoding="utf-8").read()

def rep(old, new, expect):
    global s
    n = s.count(old)
    assert n == expect, f"expect {expect} got {n} for: {old[:70]!r}"
    s = s.replace(old, new)

# 单行 connect/heartbeat（无尾逗号与有尾逗号两种）
rep('{ type: "c2c.connect.page", generation: 1, safety }',
    '{ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }', 6)
rep('{ type: "c2c.heartbeat", generation: 1, safety }',
    '{ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }', 12)
rep('type: "c2c.connect.page", generation: 1, safety,\n',
    'type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE,\n', 1)
rep('type: "c2c.heartbeat", generation: 1, safety, feedbackBootstrapToolMissing: true,\n',
    'type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE, feedbackBootstrapToolMissing: true,\n', 1)

# owner-proof / status 单行
rep('{ type: "c2c.owner-proof.request", href: ROUTE, generation: 1 }',
    '{ type: "c2c.owner-proof.request", href: ROUTE, canonicalRoute: ROUTE, generation: 1 }', 1)
rep('type: "c2c.status.page", href: ROUTE, generation: 1, safety,\n',
    'type: "c2c.status.page", href: ROUTE, canonicalRoute: ROUTE, generation: 1, safety,\n', 1)
rep('{ type: "c2c.status.page", href: ROUTE, generation: 1 }',
    '{ type: "c2c.status.page", href: ROUTE, canonicalRoute: ROUTE, generation: 1 }', 1)

# bare alias：witness = bare（content-script 视角的 location.href）；先于普通多行替换，
# 因为它是普通多行文本的前缀超集
rep('''      type: "c2c.connect.page",
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: bare });''',
    '''      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: bare,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: bare });''', 1)
# 多行 connect（6 空格缩进，safety empty）
rep('''      type: "c2c.connect.page",
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''',
    '''      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''', 8)
# 多行 connect 变体（generation 与 type 同行）
rep('''      type: "c2c.connect.page", generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''',
    '''      type: "c2c.connect.page", generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''', 1)
# 多行 connect（safety filled）
rep('''      type: "c2c.connect.page",
      generation: 1,
      safety: { composer: "filled", generation: "idle", safe: false },
    }''',
    '''      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "filled", generation: "idle", safe: false },
    }''', 1)
# 多行 heartbeat（两种缩进）
rep('''        type: "c2c.heartbeat",
        generation: 1,
        safety: { composer: "empty", generation: "idle", safe: true },
      }''',
    '''        type: "c2c.heartbeat",
        generation: 1,
        canonicalRoute: ROUTE,
        safety: { composer: "empty", generation: "idle", safe: true },
      }''', 1)
rep('''      type: "c2c.heartbeat",
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''',
    '''      type: "c2c.heartbeat",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }''', 1)
# caller-injection 测试：canonicalRoute 现在是 witness，注入 OLD_ROUTE 会 fail-closed；
# 改为合法 witness ROUTE（tabId/documentId 等注入字段仍被忽略，测试意图保留）
rep('''      canonicalRoute: OLD_ROUTE,
      href: OLD_ROUTE,''',
    '''      canonicalRoute: ROUTE,
      href: OLD_ROUTE,''', 2)

open(p, "w", encoding="utf-8", newline="").write(s)
print("all replacements applied")
