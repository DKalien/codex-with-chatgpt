# -*- coding: utf-8 -*-
"""给 desktop-ipc.test.ts 的指定用例加 C2C_DESKTOP_PYTHON 环境隔离（保持 CRLF 行尾）。"""
path = r"D:\python\codex-with-chatgpt\tests\desktop-ipc.test.ts"
with open(path, "rb") as f:
    data = f.read()

marker = '  it("使用隔离、无 shell 的 helper，并保留中文多行正文直到接受回执", async () => {'.encode("utf-8")
start = data.index(marker)
end_marker = b"\r\n  });\r\n"
end = data.index(end_marker, start) + len(end_marker)
old_block = data[start:end]

lines = old_block.split(b"\r\n")
# 结构: lines[0]=it 头, lines[1:-2]=body, lines[-2]='  });', lines[-1]=''(块尾 CR 被截断)
assert lines[-2] == b"  });", lines[-2]
assert lines[-1] == b"", lines[-1]
head = lines[0]
body = lines[1:-2]

new_body = []
for line in body:
    if line.strip() == b"":
        new_body.append(b"")
    else:
        new_body.append(b"  " + line)

env_setup = [
    "    const previousPython = process.env.C2C_DESKTOP_PYTHON;".encode("utf-8"),
    "    delete process.env.C2C_DESKTOP_PYTHON;".encode("utf-8"),
    b"",
    b"    try {",
]
tail = [
    b"    } finally {",
    "      if (previousPython === undefined) {".encode("utf-8"),
    "        delete process.env.C2C_DESKTOP_PYTHON;".encode("utf-8"),
    b"      } else {",
    "        process.env.C2C_DESKTOP_PYTHON = previousPython;".encode("utf-8"),
    b"      }",
    b"    }",
    b"  });",
    b"",
]
new_block = b"\r\n".join([head] + env_setup + new_body + tail)

assert data.count(old_block) == 1, "old block not unique"
with open(path, "wb") as f:
    f.write(data.replace(old_block, new_block))
print("patched OK; old", len(old_block), "bytes -> new", len(new_block), "bytes")
