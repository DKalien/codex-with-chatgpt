import { describe, expect, it } from "vitest";
import {
  CONTROL_KINDS,
  candidateCommandId,
  parseControlMessage,
  type ControlCommand,
} from "../src/session/control-protocol.js";

function command(kind: string, fields = ""): string {
  const lines = [
    "[C2C_CONTROL]",
    "STATE: COMMAND",
    "CONTROL_SESSION_ID: session_1",
    "WORKSPACE_ID: workspace-1",
    "COMMAND_ID: command_1",
    `KIND: ${kind}`,
    "",
    "GOAL:",
    "完成协议解析测试",
    "",
    "INSTRUCTIONS:",
    "读取相关代码并运行测试",
    "",
    "SUCCESS_CRITERIA:",
    "所有针对性测试通过",
  ];
  if (fields) lines.push(fields);
  return lines.join("\n");
}

describe("parseControlMessage", () => {
  it.each(CONTROL_KINDS)("接受 COMMAND kind=%s", (kind) => {
    const parsed = parseControlMessage(command(kind));
    expect(parsed).toMatchObject({ state: "COMMAND", kind });
  });

  it("接受 DONE 及 CRLF、完整外层 code fence", () => {
    const done = [
      "[C2C_CONTROL]",
      "STATE: DONE",
      "CONTROL_SESSION_ID: session_1",
      "WORKSPACE_ID: workspace-1",
      "COMMAND_ID: command_1",
    ].join("\r\n");
    expect(parseControlMessage(done)).toEqual({
      state: "DONE",
      controlSessionId: "session_1",
      workspaceId: "workspace-1",
      commandId: "command_1",
    });
    const fenced = `\`\`\`text\n${command("TASK")}\n\`\`\``;
    expect((parseControlMessage(fenced) as ControlCommand).goal).toBe("完成协议解析测试");
  });

  it.each([
    "说明文字\n",
    `${command("TASK")}\n${command("TEST")}`,
    `${command("TASK")}\n\n普通尾随说明`,
    "```text\n[ C2C_CONTROL ]\n```",
    "```text\n```text\n[C2C_CONTROL]\n```\n```",
  ])("拒绝普通说明、混杂多消息或不完整包裹：%s", (text) => {
    expect(() => parseControlMessage(text)).toThrow(/控制消息无效/);
  });

  it.each([
    command("TASK").replace("CONTROL_SESSION_ID: session_1\n", ""),
    command("TASK").replace("WORKSPACE_ID: workspace-1\n", ""),
    command("TASK").replace("COMMAND_ID: command_1\n", ""),
    command("TASK").replace("KIND: TASK\n", ""),
    command("TASK").replace("\nGOAL:", "\n"),
    command("TASK").replace("\nINSTRUCTIONS:", "\n"),
    command("TASK").replace("\nSUCCESS_CRITERIA:", "\n"),
  ])("拒绝缺少固定字段或段标题", (text) => {
    expect(() => parseControlMessage(text)).toThrow();
  });

  it.each([
    command("TASK").replace("COMMAND_ID: command_1", "COMMAND_ID: command_1\nCOMMAND_ID: command_2"),
    command("TASK").replace("WORKSPACE_ID: workspace-1", "WORKSPACE_ID: workspace-1\nENABLE: true"),
    command("TASK").replace("WORKSPACE_ID: workspace-1", "WORKSPACE_ID: workspace-1\nPAUSE: false"),
    command("TASK").replace("WORKSPACE_ID: workspace-1", "WORKSPACE_ID: workspace-1\nSHELL_COMMAND: dir"),
    command("TASK").replace("WORKSPACE_ID: workspace-1", "WORKSPACE_ID: workspace-1\nEXECUTABLE: cmd.exe"),
    command("TASK").replace("完成协议解析测试", "ENABLE: true"),
    command("TASK").replace("完成协议解析测试", "正文 [C2C_CONTROL] 嵌套引用"),
  ])("拒绝重复、未知协议字段或嵌套控制标记", (text) => {
    expect(() => parseControlMessage(text)).toThrow();
  });

  it("拒绝 DONE 的 KIND、正文和重复 ID", () => {
    const done = [
      "[C2C_CONTROL]",
      "STATE: DONE",
      "CONTROL_SESSION_ID: s",
      "WORKSPACE_ID: w",
      "COMMAND_ID: c",
    ].join("\n");
    expect(() => parseControlMessage(done.replace("COMMAND_ID: c", "COMMAND_ID: c\nKIND: TASK"))).toThrow();
    expect(() => parseControlMessage(done.replace("COMMAND_ID: c", "COMMAND_ID: c\n\nGOAL:\nx"))).toThrow();
    expect(() => parseControlMessage(done.replace("COMMAND_ID: c", "COMMAND_ID: c\nCOMMAND_ID: d"))).toThrow();
  });

  it("拒绝超长消息、非法 ID 和空正文", () => {
    expect(() => parseControlMessage("x".repeat(8193))).toThrow(/8192/);
    expect(() => parseControlMessage(command("TASK").replace("session_1", "含中文"))).toThrow();
    expect(() => parseControlMessage(command("TASK").replace("session_1", "a".repeat(129)))).toThrow();
    expect(() => parseControlMessage(command("TASK").replace("完成协议解析测试", " \t"))).toThrow();
    expect(() => parseControlMessage(command("TASK").replace("KIND: TASK", "KIND: ENABLE"))).toThrow();
  });
});

describe("candidateCommandId", () => {
  it("只从首个头区返回唯一合法 COMMAND_ID", () => {
    expect(candidateCommandId(command("TASK"))).toBe("command_1");
    expect(candidateCommandId(command("TASK").replace(/\n/g, "\r\n"))).toBe("command_1");
    expect(candidateCommandId(`\`\`\`text\n${command("TASK")}\n\`\`\``)).toBe("command_1");
    expect(candidateCommandId(command("TASK").replace("CONTROL_SESSION_ID: session_1", "CONTROL_SESSION_ID: session_1\nUNKNOWN: x"))).toBe(
      "command_1"
    );
  });

  it.each([
    "引用：[C2C_CONTROL]\nSTATE: COMMAND\nCOMMAND_ID: quoted",
    command("TASK").replace("COMMAND_ID: command_1", "COMMAND_ID: command_1\nCOMMAND_ID: command_2"),
    command("TASK").replace("COMMAND_ID: command_1", "\n\n正文 COMMAND_ID: body"),
    command("TASK").replace("COMMAND_ID: command_1", "COMMAND_ID: 非法"),
    command("TASK").replace("COMMAND_ID: command_1", ""),
  ])("拒绝从普通文本、重复头或正文猜取 ID：%s", (text) => {
    expect(candidateCommandId(text)).toBeUndefined();
  });
});
