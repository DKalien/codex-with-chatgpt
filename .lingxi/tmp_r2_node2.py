# -*- coding: utf-8 -*-
"""R2 Node 测试手术：desktop-current.test.ts compatibility CLI 测试 → diagnose 语义。"""
from pathlib import Path

TESTS = Path(r"D:\python\codex-with-chatgpt\tests\desktop-current.test.ts")
text = TESTS.read_text(encoding="utf-8")


def cut_between(start_anchor: str, end_anchor: str, repl: str, label: str) -> None:
    global text
    start = text.index(start_anchor)
    end = text.index(end_anchor)
    if end <= start:
        raise SystemExit(f"[{label}] bad range")
    text = text[:start] + repl + text[end:]


# 1. compatibility JSON 测试 → diagnose JSON 测试 + alias 测试
cut_between(
    'it("CLI compatibility JSON 只读诊断，接受 workspace 参数但不初始化状态", async () => {',
    'it("CLI compatibility --audit 只读审计，选择独立方法且不初始化状态", async () => {',
    '''it("CLI diagnose JSON 只读诊断，接受 workspace 参数但不初始化状态", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const diagnosis = {
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: true,
    followingChangedSent: true,
    stateReceived: true,
    stateChange: "snapshot" as const,
  };
  vi.spyOn(desktopIpc, "diagnose").mockResolvedValue(diagnosis);
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "diagnose", "-w", workspace.root, "--json"]);
  expect(JSON.parse(String(out.mock.calls[0][0]))).toEqual({ ok: true, ...diagnosis });
  expect(desktopIpc.diagnose).toHaveBeenCalledOnce();
  expect(bytes()).toBeNull();
});

it("CLI compatibility 别名仍调用 diagnose，且不做信任分类", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const diagnose = vi.spyOn(desktopIpc, "diagnose").mockResolvedValue({
    processStable: true as const,
    initialize: true as const,
    ownerDiscovery: false,
    followingChangedSent: true,
    stateReceived: false,
    stateChange: null,
  });
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "compatibility", "--json"]);
  expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ ok: true, processStable: true, stateChange: null });
  expect(diagnose).toHaveBeenCalledOnce();
});

''',
    "diagnose-json",
)

# 2. --audit 与 --handshake-audit 测试删除
cut_between(
    'it("CLI compatibility --audit 只读审计，选择独立方法且不初始化状态", async () => {',
    'it("CLI compatibility 拒绝同时 --audit --handshake-audit 且不调用任何方法", async () => {',
    "",
    "cut-audit",
)

# 3. 拒绝同时 audit 测试删除
cut_between(
    'it("CLI compatibility 拒绝同时 --audit --handshake-audit 且不调用任何方法", async () => {',
    'it("CLI bind-current 错误只输出安全 compatibility 投影", async () => {',
    "",
    "cut-conflict",
)

# 4. bind-current compatibility 投影测试 → 错误净化测试（文件最后一个 it，含收尾）
start = text.index('it("CLI bind-current 错误只输出安全 compatibility 投影", async () => {')
text = text[:start] + '''it("CLI bind-current 错误只输出安全消息，不带回 helper 诊断对象", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const failure = new DesktopError("DESKTOP_STATE_UNAVAILABLE", "secret token pipe");
  (failure as DesktopError & { compatibility: unknown }).compatibility = {
    token: "secret-token",
    pipe: "\\\\\\\\.\\\\pipe\\\\secret",
  };
  vi.mocked(desktopIpc.currentIdentity).mockRejectedValue(failure);
  const program = new Command().exitOverride(); registerDesktopCommands(program);
  await program.parseAsync(["node", "c2c", "desktop", "bind-current", "--json"]);
  const payload = JSON.parse(String(out.mock.calls[0][0])) as Record<string, unknown>;
  expect(payload).toMatchObject({ ok: false, error: "DESKTOP_STATE_UNAVAILABLE" });
  expect(payload).not.toHaveProperty("compatibility");
  expect(payload).not.toHaveProperty("token");
  expect(payload).not.toHaveProperty("pipe");
  expect(String(payload.message)).not.toContain("secret");
  expect(bytes()).toBeNull();
});
});
''' + text[text.rindex("});") + 3:]
if text.count("});\n});\n") > 1:
    raise SystemExit("tail join suspicious")

TESTS.write_text(text, encoding="utf-8")
print("desktop-current.test.ts surgery done;", len(text), "chars")
