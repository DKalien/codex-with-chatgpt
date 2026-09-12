import fs from "node:fs";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
const activation = skill.split('## Workflow: Activation（"启用 ChatGPT 工作流"）')[1]?.split("## Workflow: first-time setup")[0] ?? "";

describe("Activation Skill 文本契约", () => {
  it("机器 launcher 是唯一安装路径，内部 build 更新不迁移 Connector", () => {
    expect(skill.match(/<C2C_LAUNCHER_PATH>/g)).toHaveLength(1);
    expect(skill).not.toContain("<ACTUAL_CHECKOUT_PATH>");
    expect(skill).not.toMatch(/node [^\n]*<checkout>[\/\\]bin/);
    const upgrade = activation.split("### Runtime build upgrade")[1]?.split("### Runtime contract refresh")[0] ?? "";
    for (const text of ["runtimeUpgrade", "runtimeBuildId", "installed/current", "c2c rollout --json",
      "-w <workspace>", "quick/busy/unknown", "不能用普通 restart 绕过门禁", "不能谎报 Ready",
      "不为升级打断当前执行 turn", "没有常驻 Supervisor/polling", "build mismatch 绝不触发 Connector migration",
      "不改 Project/session/checkpoint/task/binding", "原 named URL 和 workspace 身份未变"])
      expect(upgrade).toContain(text);
  });
  it("正式触发语包含统一入口并兼容旧话术", () => {
    const description = skill.split("---")[1];
    for (const trigger of ["启用 ChatGPT 工作流", "开启 ChatGPT 工作流", "Enable the ChatGPT workflow",
      "Activate the ChatGPT workflow", "使用 Codex with ChatGPT", "Set up Codex with ChatGPT",
      "把这个会话绑定并启用给 ChatGPT"]) expect(description).toContain(trigger);
    expect(skill).toContain('## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）');
    expect(skill).toContain('## Workflow: coding task（Normal："使用 Codex with ChatGPT 完成 XXX"）');
  });

  it("先识别状态，新工作区复用 setup 和机器偏好，停止不等于新工作区", () => {
    expect(activation.indexOf("c2c session -w <workspace> --json")).toBeLessThan(activation.indexOf("**New workspace**"));
    for (const text of ["c2c status -w <workspace> --json", "c2c prefs --json", "running: false",
      "chatgptRepair.previousMcpUrl", "Workflow: first-time setup", "已保存的 setupMode 不重问",
      "缺失的授权状态不是零", "跳过 setup step 7 的成功报告", "直接进入 step 4"])
      expect(activation).toContain(text);
  });

  it("恢复连接严格经过 doctor gate 和现有 repair", () => {
    for (const text of ["Connection choice", "c2c doctor -w <workspace> --json", "Doctor gate",
      "Workflow: repair", "chatgptRepair.needed", "Workflow: reconnect after address reclaim",
      "namedRepair.needed", "gate 未通过不打开聊天", "session.connectorName",
      "不把 doctor 合成的默认名称当作已绑定 connector"]) expect(activation).toContain(text);
  });

  it.each([
    ["New workspace", "session === null", "chatgptRepair.previousMcpUrl === null", "复用完整 **Workflow: first-time setup**"],
    ["Interrupted first-time setup", "session === null", "chatgptRepair.previousMcpUrl != null", "**Authorization resume**"],
    ["Revoked authorization", "session != null", "tokenCount === 0", "**Authorization resume**"],
  ])("%s 按 session、endpoint 和授权状态分流", (branch, session, endpoint, target) => {
    const paragraph = activation.split(`- **${branch}**：`)[1]?.split("\n   - ")[0] ?? "";
    for (const text of [session, endpoint, "tokenCount === 0", target]) expect(paragraph).toContain(text);
  });

  it("授权恢复复用精确连接与偏好，复查成功前不得进入聊天或绑定", () => {
    const resume = activation.split("- **Authorization resume**：")[1]?.split("\n   - ")[0] ?? "";
    for (const text of ["chatgptRepair.mcpUrl", "chatgptRepair.connectorName", "不运行 setup、不重建健康 endpoint",
      "c2c pair -w <workspace> --json", "setupMode", "auto", "manual", "Guided manual ChatGPT setup",
      "不操作其他 workspace", "不在授权缺失时打开 Project/chat 或发送消息"])
      expect(resume).toContain(text);
    const gate = activation.split("- **Authorized connection**：")[1]?.split("3. **恢复与 Project 分流。")[0] ?? "";
    for (const text of ["重新运行", "c2c doctor -w <workspace> --json", "c2c status -w <workspace> --json",
      "再次要求 doctor gate 通过且 `tokenCount > 0`", "否则停止并报告", "desktop bind-current"])
      expect(gate).toContain(text);
    expect(activation).toContain("`tokenCount` 缺失或 unknown 时停止并诊断，不能强制转换为零");
    expect(activation).toContain("本地 endpoint 健康不等于 ChatGPT 已授权");
  });

  it("Project 未就绪只绑定，就绪复用，legacy 不迁移", () => {
    expect(activation).toContain('conversation.projectReady === false`：\n     只补现有 **Bind Project**');
    expect(activation).toContain('conversation.projectReady === true`：\n     复用保存的 `conversation.projectUrl`');
    expect(activation).toContain('conversation.mode === "long-chat"`：继续 **long-chat**');
    for (const text of ["不自动迁移", "不能借用其他 thread 的 session.url", "workspace_info",
      "未通过不保存/覆盖 URL"]) expect(activation).toContain(text);
  });

  it("保留 checkpoint/task，不借入口创建或重复执行任务", () => {
    for (const text of ["session.checkpoint", "session.taskId", "Resume", "不发送新 INIT",
      "不重跑执行", "不重复发送 EXECUTED", "不因 Activation 清除 checkpoint"])
      expect(activation).toContain(text);
  });

  it("验证后最终 bind-current，身份确认失败不能 Ready", () => {
    const bind = activation.indexOf("c2c desktop bind-current -w <workspace> --json");
    expect(bind).toBeGreaterThan(activation.indexOf("调用 `workspace_info`"));
    expect(bind).toBeLessThan(activation.indexOf("5. **Ready。**"));
    for (const text of ["alreadyEnabled", "本机用户确认", "不代点", "上下文 unknown",
      "不回退到显式 bind/enable", "ok: true", "enabled: true", "一次只提示一个动作",
      "不能提前宣称 Ready", "✓ 当前项目已识别", "✓ ChatGPT 已连接", "✓ 当前 Desktop 会话已绑定"])
      expect(activation).toContain(text);
    expect(activation).toContain("不新增 CLI、持久化状态或隐式授权");
    expect(activation).toContain("不启用 Web Control、MCP Remote Control 或 write_probe");
  });

  it("中英文 README 的安装后首选操作使用统一入口", () => {
    for (const [file, prompt] of [["README.zh-CN.md", "启用 ChatGPT 工作流"],
      ["README.md", "Enable the ChatGPT workflow"]]) {
      const readme = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(readme.split("\n").some(line => line.startsWith("2. ") && line.includes(prompt))).toBe(true);
      expect(readme).toContain("desktop bind-current");
    }
  });

  it("旧 runtime 先刷新契约，不把未知版本直接当成 Connector 迁移", () => {
    for (const text of ["connectorContractVersion === 1", "Runtime contract refresh",
      "不能据此判定 Connector 必须迁移", "刷新一次仍缺字段或未知版本则停止",
      "Bridge 状态 unknown 时停止诊断，不能当作未运行",
      "地址变化先返回 Activation 的 Repair 迁移预检",
      "服务本次 MCP Review 的 workspace Bridge", "`unknown` / `corrupt` 停止诊断"])
      expect(activation).toContain(text);
    expect(activation.indexOf("即使 tokenCount 为零也不能走首次配置覆盖坏状态"))
      .toBeLessThan(activation.indexOf("**New workspace**"));
  });

  it("网页 schema 旧时迁移，current 时不迁移，不能以发送测试代替发现", () => {
    const schema = activation.split("### Connector schema check")[1]?.split("### Connector migration")[0] ?? "";
    for (const text of ["实际工具定义", "不要调用 `codex_desktop_send`", "codex_desktop_status",
      "`workspaceId`、`bindingId`、`commandId`、`intent`、`userConfirmed`、`message`",
      "development_plan", "revision", "const: true", "不能只是 boolean",
      "current，不迁移、不 Delete/create", "migration required", "unknown，停止"])
      expect(schema).toContain(text);
  });

  it("迁移只触碰精确 workspace，保留 Project/session/checkpoint 并复验", () => {
    const migration = activation.split("### Connector migration")[1] ?? "";
    for (const text of ["current + current 不迁移", "unknown/corrupt/workspace mismatch",
      "conversation.projectUrl", "session.url", "checkpoint", "taskId", "iteration",
      "不执行 session clear/set", "不重写 Project instructions", "不创建新 Project 或第二个 Connector",
      "不使用其他 workspace 的连接", "不触碰其他 workspace", "c2c pair -w <workspace> --json",
      "prefs.setupMode", "Delete 当前同名 Connector", "不要 Reconnect/Edit",
      "codex.desktop.read", "codex.desktop.control", "本地 compatibility 为 current",
      "workspaceId/名称匹配", "再次 **Connector schema check**", "重读 session", "outcome_unknown"])
      expect(migration).toContain(text);
    expect(activation).toContain('desktopCompatibility.status === "current"');
    expect(activation).toContain("不能借用其他客户端的完整 token 通过");
    expect(migration).toContain("不能用本地其他 token 的");
  });

  it("迁移后旧聊天失效优先 Conversation Rebind，不重复重建 Connector", () => {
    const rebind = activation.split("### Conversation Rebind")[1]?.split("### Legacy named upgrade")[0] ?? "";
    for (const text of ["tool has been disabled", "仍显示旧工具 schema", "本地 desktopCompatibility current",
      "原 `conversation.projectUrl`", "on-page composer 新建 Chat", "switch-chat + HANDOFF",
      "两种模式均先 boot", "精确 `connectorName`", "workspaceId/名称必须匹配", "实际请求 desktopCompatibility.status",
      "再次 **Connector schema check**", "不重复 Connector migration/Delete/create/pair", "不改 Project instructions"])
      expect(rebind).toContain(text);
    expect(activation).toContain("此明确错误在一般 unknown 分流前处理");
  });

  it("新聊天先验证再只更新 URL，失败保留原状态且不能 Ready", () => {
    const rebind = activation.split("### Conversation Rebind")[1]?.split("### Legacy named upgrade")[0] ?? "";
    expect(rebind.indexOf("再次 **Connector schema check**")).toBeLessThan(rebind.indexOf("c2c session set"));
    for (const text of ["--url <verified-new-chat-url>", "不带其他状态修改参数", "基准未被其他操作改变",
      "新聊天任何校验失败均停止", "不继续新开聊天", "不保存新 URL，不 bind-current，不报告 Ready",
      "checkpoint、taskId、iteration、lastState、conversationMode 和 Project instructions 保持原值",
      "checkpoint 内原 chatUrl 也不重写", "不得新 INIT、重跑执行、重复 EXECUTED", "不调用 codex_desktop_send"])
      expect(rebind).toContain(text);
  });

  it("legacy quick 先升级 named，最终固定 URL 就绪后才重建 Connector", () => {
    const migration = activation.split("### Connector migration")[1]?.split("### Legacy named upgrade")[0] ?? "";
    expect(migration.indexOf("先执行 Legacy named upgrade")).toBeLessThan(migration.indexOf("c2c pair"));
    expect(migration).toContain("该最终 `chatgptRepair.mcpUrl`");
    expect(migration).toContain("要求 named 地址健康");
    const named = activation.split("### Legacy named upgrade")[1] ?? "";
    for (const text of ["健康 named workspace 直接复用", "不再 choose/provision", "migrationZone",
      "zoneResolution", "`machine-unique`", "`corrupt` 停止诊断", "`ambiguous` 或 `missing`", "只问一次", "不能复制别的 workspace 的 hostname、tunnelId",
      "--require-named --json", "不传其他 workspace 的 --hostname", "含 workspaceId 的独立 hostname",
      "不得调用 choose quick", "不提前 Delete/create，不报告 Ready", "cloudflare-named",
      "保留 Project/projectUrl、chat URL、session、checkpoint、taskId/iteration、connectorName"])
      expect(named).toContain(text);
  });
});
