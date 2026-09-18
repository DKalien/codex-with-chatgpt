import fs from "node:fs";
import { describe, expect, it } from "vitest";

const skillSource = fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");

function indentOf(line: string): number {
  return line.length - line.replace(/^ */, "").length;
}

describe.each(["LF", "CRLF"])("Activation Skill 文本契约（%s）", style => {
  const skill = skillSource.replace(/\r?\n/g, style === "CRLF" ? "\r\n" : "\n").replace(/\r\n/g, "\n");
  const activation = skill.split('## Workflow: Activation（"启用 ChatGPT 工作流"）')[1]?.split("## Workflow: first-time setup")[0] ?? "";
  const project = skill.split("### project (new workspaces)")[1]?.split("**Update it**")[0] ?? "";
  const rebind = skill.split("### Conversation Rebind")[1]?.split("### Legacy named upgrade")[0] ?? "";
  const migration = activation.split("### Connector migration")[1] ?? skill.split("### Connector migration")[1] ?? "";
  const schema = activation.split("### Connector schema check")[1]?.split("### Connector migration")[0]
    ?? skill.split("### Connector schema check")[1]?.split("### Connector migration")[0] ?? "";
  const named = skill.split("### Legacy named upgrade")[1] ?? "";
  const upgrade = activation.split("### Runtime build upgrade")[1]?.split("### Runtime contract refresh")[0]
    ?? skill.split("### Runtime build upgrade")[1]?.split("### Runtime contract refresh")[0] ?? "";

  it("Desktop 版本 / launcher / 触发语安全契约", () => {
    for (const text of ["DESKTOP_VERSION_UNSUPPORTED", "observedDesktopVersion", "不是 OAuth `desktopCompatibility`",
      "启用 ChatGPT 工作流", "Enable the ChatGPT workflow"])
      expect(skill).toContain(text);
    expect(skill.match(/<C2C_LAUNCHER_PATH>/g)).toHaveLength(1);
  });

  it("workflow status 第一事实源；延迟读取；无旧 step 跳转", () => {
    expect(activation).toContain("c2c workflow status -w <workspace> --json");
    expect(activation.indexOf("c2c workflow status -w <workspace> --json"))
      .toBeLessThan(activation.indexOf("**New workspace**"));
    for (const text of ["c2c status -w <workspace> --json", "c2c prefs --json", "running: false",
      "缺失的授权状态不是零", "不能强制转换为零", "禁止 generic while-loop",
      "必须重新 doctor gate + `c2c workflow status`"])
      expect(activation).toContain(text);
    expect(activation).not.toContain("直接进入 step 4");
  });

  it("11 个顶层 nextAction Markdown indent 完全一致，且深于 Authorized connection", () => {
    const actions = [
      "stop_unknown", "resolve_unconfirmed_delivery", "wait_current_task", "resume_checkpoint",
      "repair_connection", "resume_authorization", "bind_project", "open_project_chat",
      "bind_current", "reuse", "use_remote",
    ];
    const lines = activation.split("\n");
    const indents: number[] = [];
    for (const action of actions) {
      const line = lines.find(l => l.includes(`**\`${action}\`**`) && l.includes("："));
      expect(line, action).toBeTruthy();
      indents.push(indentOf(line!));
    }
    expect(new Set(indents).size).toBe(1);
    const auth = lines.find(l => l.includes("**Authorized connection**"));
    expect(auth).toBeTruthy();
    expect(indentOf(auth!)).toBeGreaterThan(indents[0]);
  });

  it("resume_authorization 子项与顶层 nextAction 分层正确", () => {
    for (const text of ["**New workspace**", "**Interrupted first-time setup**",
      "**Revoked authorization**", "**Authorized connection**"])
      expect(activation).toContain(text);
    expect(activation).toContain("不在授权缺失时打开 Project/chat 或发送消息");
    expect(activation).toContain("不能据此判定 Connector 必须迁移");
  });

  it("Project 导航 threadConversation；禁止 session.url navigation authority", () => {
    expect(project).toContain("threadConversation.reuseChat === true");
    expect(project).not.toMatch(/goto `session\.url`/);
    expect(activation).toMatch(/不能借用其他 thread 的 [`]?session\.url[`]?/);
    expect(skill).toContain("threadConversation projection 不暴露 projectChats");
  });

  it("reuse/use_remote 不 bind-current；bind_current 在 request-scoped verification 后", () => {
    const reuseBlock = activation.split("- **`reuse`**：")[1]?.split("- **`use_remote`**")[0] ?? "";
    const remoteBlock = activation.split("- **`use_remote`**：")[1]?.split("3. **Doctor gate")[0] ?? "";
    const bindBlock = activation.split("- **`bind_current`**：")[1]?.split("- **`reuse`**")[0] ?? "";
    expect(reuseBlock).toContain("**不要再次 bind-current**");
    expect(reuseBlock).not.toContain("c2c desktop bind-current");
    expect(remoteBlock).toContain("不要 Desktop bind-current");
    expect(remoteBlock).not.toContain("c2c desktop bind-current");
    expect(bindBlock).toContain("request-scoped verification");
    expect(bindBlock).toContain("c2c desktop bind-current -w <workspace> --json");
  });

  it("Connector schema：intent 两枚举 + userConfirmed true literal", () => {
    expect(schema).toContain("codex_desktop_status");
    expect(schema).toContain("codex_desktop_send");
    expect(schema).toContain("development_plan");
    expect(schema).toContain("revision");
    expect(schema).toMatch(/userConfirmed[\s\S]{0,80}true literal/);
    expect(schema).toContain("const: true");
  });

  it("OAuth scopes / migration：read+control，禁止自动确认与跨 workspace", () => {
    expect(skill).toContain("codex.desktop.read");
    expect(skill).toContain("codex.desktop.control");
    expect(skill).toContain("不能自动确认本机授权或代替用户登录/同意");
    expect(skill).toContain("不触碰其他 workspace");
  });

  it("Legacy named upgrade：zoneResolution safety + hostname isolation", () => {
    for (const text of ["zoneResolution", "`current`", "`machine-unique`", "`corrupt`",
      "`ambiguous`", "`missing`", "不传其他 workspace 的 --hostname", "含 workspaceId 的独立 hostname",
      "--require-named"])
      expect(named).toContain(text);
  });

  it("Request token isolation：不能用本地其他 token 补完整授权", () => {
    expect(skill).toContain("不能用本地其他 token");
  });

  it("Connector migration step 4 引用 thread-aware Rebind contract", () => {
    expect(migration).toContain("thread-aware mutation contract");
    expect(migration).not.toContain("Conversation Rebind 成功仅允许 session.url");
    expect(migration).toContain("Project 不以 session.url 作为导航 authority");
  });

  it("Conversation Rebind preservation：project/connector/checkpoint/task 字段与 other-thread mappings", () => {
    for (const text of ["threadConversation.chatUrl", "projectUrl", "connectorName",
      "checkpoint", "taskId", "iteration", "lastState", "conversationMode",
      "其他 thread 的 projectChats entries 必须保持"])
      expect(rebind).toContain(text);
  });

  it("request-scoped verification 仍强制；Ready 分路径", () => {
    for (const text of ["workspace_info", "connectorContractVersion === 1",
      'desktopCompatibility.status === "current"', "Connector schema check",
      "✓ 当前 Desktop 会话已就绪", "✓ Remote Control 已就绪"])
      expect(activation).toContain(text);
  });

  it("runtime upgrade/refresh 安全门禁仍在 Activation 内", () => {
    for (const text of ["c2c rollout --json", "build mismatch 绝不触发 Connector migration",
      "不能用普通 restart 绕过门禁", "connectorContractVersion === 1"])
      expect(upgrade + activation).toContain(text);
  });

  it("Connector migration 不得引用旧 Activation step number 或强制 bind-current", () => {
    expect(migration).not.toMatch(/Activation step [0-9]/);
    expect(migration).not.toContain("继续既有 desktop bind-current");
    expect(migration).toContain("重新运行 `c2c workflow status`");
    expect(migration).toContain("按新的 nextAction");
  });

  it("Conversation Rebind 成功后 reread workflow status，不固定 bind-current", () => {
    expect(rebind).toContain("c2c workflow status");
    expect(rebind).toContain("nextAction");
    expect(rebind).not.toContain("最终 desktop bind-current");
    expect(rebind).toContain("仅 nextAction=`bind_current` 时才执行 Desktop bind-current");
  });

  it("README 统一入口", () => {
    for (const [file, prompt] of [["README.zh-CN.md", "启用 ChatGPT 工作流"],
      ["README.md", "Enable the ChatGPT workflow"]]) {
      const readme = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(readme).toContain(prompt);
      expect(readme).toContain("desktop bind-current");
    }
  });
});
