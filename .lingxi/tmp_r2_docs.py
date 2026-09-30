# -*- coding: utf-8 -*-
"""R2.12 文档同步：版本门禁描述 → live 行为证明。"""
from pathlib import Path

ROOT = Path(r"D:\python\codex-with-chatgpt")


def apply(path: Path, edits, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    for i, (find, replace) in enumerate(edits, 1):
        count = text.count(find)
        if count != 1:
            raise SystemExit(f"[{label}] edit {i}: expected 1 got {count}: {find[:80]!r}")
        text = text.replace(find, replace)
    path.write_text(text, encoding="utf-8")
    print(f"[{label}] {len(edits)} edits applied")


# ---------- desktop-control.md ----------
dc = ROOT / "docs" / "desktop-control.md"
text = dc.read_text(encoding="utf-8")
start = text.index("## 本机 IPC 与版本门禁")
end = text.index("Windows 受控 helper 需要 Python 3.11 或更高版本")
new_section = """## 本机 IPC 与 live 行为证明

IPC 发送前会重新核验 Desktop 服务进程、端点、owner 和绑定目标的新鲜状态；Desktop
重启后重新发现，不能永久信任旧 PID。已知的 Desktop idle/start 内部协议在检查和实际
发送之间没有原子 CAS，目标可能在窗口内改变；因此回执不匹配或不明时必须按未知结果
处理，不能据此宣称 exactly-once。

2026-09-24（R2）起，Desktop 是否可用完全由当前 live 行为决定，不再由 Desktop 版本、
app-server hash、ASAR 布局、catalog 或 semantic fingerprint 决定。旧版本门禁体系
（`desktop_profiles.json` catalog、`VERIFIED_PROFILES`、app-server/ASAR/模块 SHA-256
预登记、semantic fingerprint 扫描、`compatibility`/`handshake_audit` 信任分类与
`DESKTOP_VERSION_UNSUPPORTED` 门禁）已整体删除；Desktop 自动升级后无需修改任何
catalog 即可继续工作。`c2c desktop diagnose`（别名 `compatibility`）只描述这一次
live handshake 实际发生了什么（进程稳定、initialize、owner 发现、following 请求、
状态接收与变更类型），不做 trusted/untrusted 分类，也不输出版本或 bundle 信息；
无法确定 conversation target 时明确返回"无法进行 live conversation diagnosis"。

发送信任来自行为证明链：fresh pre-start state → before turn IDs + snapshot serial →
send-ready（idle、无请求、无未确认提交、无 inProgress turn）+ process/owner fence →
恰好一次 start-turn → ACK 返回新 turnId → post-start 新鲜观测（serial 严格增大）→
ACK turnId 在当前会话 canonical 历史中恰好一个且正文与提交的 C2C envelope 严格相等 →
final process/owner fence → 返回回执。start-turn 写入尝试之后的一切不确定性
（超时、进程/owner 漂移、状态不可用、正文不匹配）统一收敛为
`DESKTOP_OUTCOME_UNKNOWN`、`notSent=false`，绝不自动重发；start-turn 之前的失败保持
具体错误码且 `notSent=true`。owner 一致性由 session identity 的前后 fence 单独保证，
不塞进 send-ready gate。

`DESKTOP_PROTOCOL_ERROR` 用于 wire 版本漂移（如 `thread-stream-state-changed`
version 不等于 11）等协议层不可理解响应。不要把这里的 live 诊断与 OAuth Connector 的
`desktopCompatibility` 混淆，也不能通过重新配对修复行为核验失败。
真实投递前先完成只读身份验证，再经原本的本机确认、OAuth、idle、审批、binding 和
replay 门禁进行最小 E2E。

"""
text = text[:start] + new_section + text[end:]
dc.write_text(text, encoding="utf-8")
print("[desktop-control.md] section replaced")

# ---------- protocol.md ----------
apply(ROOT / "docs" / "protocol.md", [
    (
        """IPC 只在本机受控使用，Windows helper 使用 `C2C_DESKTOP_PYTHON` 或 `python`，不要求
管理员权限、不启动第二个 app-server/router，也不通过 Tunnel 暴露原始 RPC。只放行已
验证 Desktop/app-server 版本，未知版本停止；Desktop 重启后重新发现进程和 owner。""",
        """IPC 只在本机受控使用，Windows helper 使用 `C2C_DESKTOP_PYTHON` 或 `python`，不要求
管理员权限、不启动第二个 app-server/router，也不通过 Tunnel 暴露原始 RPC。Desktop
是否可用由当前 live 行为证明决定（进程树、owner、project/workspace、新鲜状态与
发送后 canonical turn 证明），不再按 Desktop/app-server 版本或二进制 hash 预登记放行；
Desktop 重启后重新发现进程和 owner。""",
    ),
], "protocol.md")

# ---------- development-plan.md ----------
apply(ROOT / "docs" / "development-plan.md", [
    (
        """## V1 Desktop 版本适配流水线

V1a 将 Desktop exact runtime 信任数据迁入严格校验、随 helper 构建的版本化 catalog，并增加只读
`desktop compatibility --audit`：它只能生成有限的 `same_protocol_candidate`，不能自动修改 catalog、
放宽正常 compatibility 或取得生产 send 信任。定向门禁覆盖 catalog schema、ASAR candidate 分类、
helper/CLI 安全投影与构建产物，完整回归继续覆盖 Desktop control/result/reconcile。

下一阶段 V1b 只考虑自动生成 candidate promotion patch，并由 source checkout 执行只读 handshake；
review、exact catalog admission 和测试仍是必需步骤，绝不自动授予 production send trust。""",
        """## V1 Desktop 版本适配流水线（已由 R2 行为证明取代）

V1a/V1b 的 exact runtime catalog 与 candidate promotion 流水线已于 2026-09-24（R2）整体退休：
Desktop 可用性改由 live 行为证明决定，Desktop 自动升级不再需要 catalog 更新或 promotion patch。
`desktop compatibility --audit` 与 handshake audit 信任分类已删除；`c2c desktop diagnose`
（别名 `compatibility`）只做只读 live handshake 描述，不做信任分类。定向门禁相应改为
behavioral send boundary（mutation boundary 前后错误语义）、attestation 与 helper/CLI 安全投影，
完整回归继续覆盖 Desktop control/result/reconcile。""",
    ),
], "development-plan.md")

# ---------- architecture.md ----------
apply(ROOT / "docs" / "architecture.md", [
    (
        "| `desktop/` | Local Desktop binding, version-gated IPC delivery, replay-safe state and delivery status |",
        "| `desktop/` | Local Desktop binding, behaviorally attested IPC delivery, replay-safe state and delivery status |",
    ),
    (
        "- 当前生产 adapter 是 `codex-desktop`（Codex Desktop）；现有 helper 的版本、hash、owner、project、workspace、审批、busy、单次发送和回执门禁仍是唯一权威。",
        "- 当前生产 adapter 是 `codex-desktop`（Codex Desktop）；现有 helper 的 live 进程/owner/project/workspace 核验、发送行为证明（单次 start-turn + canonical turn 证明）、审批、busy 和回执门禁仍是唯一权威。",
    ),
    (
        "Desktop process/endpoint/owner/version check → controlled local IPC → bounded",
        "Desktop process/endpoint/owner check → controlled local IPC → bounded",
    ),
], "architecture.md")

# ---------- routing-architecture.md ----------
ra = ROOT / "docs" / "routing-architecture.md"
text = ra.read_text(encoding="utf-8")
marker = "## R1 边界（明确不做）"
addition = """## R2 状态（2026-09-24）

R2（Desktop Behavioral Adapter）已把 Desktop 生产信任路径切换为 live 行为证明：
Desktop 是否可用由当前进程/owner/project/workspace 核验与发送后 canonical turn 证明决定，
版本/app-server hash/ASAR/catalog/semantic fingerprint 预登记体系整体删除。
本文件描述的 Routing foundation 仍未接入生产发送；Desktop send 仍走原 behavioral 路径。

"""
idx = text.index(marker)
text = text[:idx] + addition + text[idx:]
ra.write_text(text, encoding="utf-8")
print("[routing-architecture.md] R2 status added")
