const CONTROL_MARKER = "[C2C_CONTROL]";
const MAX_MESSAGE_BYTES = 8192;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROTOCOL_FIELD_PATTERN = /^[ \t]*[A-Z][A-Z0-9_]*:(?:[ \t]|$)/;
const FORBIDDEN_FIELD_PATTERN = /^[ \t]*(?:ENABLE|PAUSE|SHELL_COMMAND|EXECUTABLE|SHELL(?:[_ ]?RPC)):[ \t]*(?:.*)$/i;

export const CONTROL_KINDS = ["TASK", "ANALYZE", "TEST", "REVIEW"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export type ControlCommand = {
  state: "COMMAND";
  controlSessionId: string;
  workspaceId: string;
  commandId: string;
  kind: ControlKind;
  goal: string;
  instructions: string;
  successCriteria: string;
};

export type ControlDone = {
  state: "DONE";
  controlSessionId: string;
  workspaceId: string;
  commandId: string;
};

function invalid(reason: string): never {
  throw new Error(`控制消息无效：${reason}`);
}

function normalizeLines(text: string): string[] {
  if (typeof text !== "string") invalid("消息必须是字符串");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) invalid("消息超过 8192 字节限制");
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) invalid("只接受 LF 或 CRLF 换行");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function unwrap(lines: string[]): string[] {
  const opening = lines[0];
  if (opening !== "```text" && opening !== "```") {
    if (lines.some((line) => line.startsWith("```"))) invalid("只接受一个外层 code fence");
    return lines;
  }
  if (lines.length < 3 || lines.at(-1) !== "```") invalid("code fence 必须完整包裹一条消息");
  const inner = lines.slice(1, -1);
  if (inner.some((line) => line.startsWith("```"))) invalid("只接受一个外层 code fence");
  return inner;
}

function readHeaderId(lines: string[], index: number, name: string): string {
  const prefix = `${name}: `;
  const value = lines[index]?.startsWith(prefix) ? lines[index].slice(prefix.length) : "";
  if (!ID_PATTERN.test(value)) invalid(`${name} 必须是 1 到 128 位 ASCII 字母、数字、下划线或短横线`);
  return value;
}

function rejectNestedProtocol(lines: string[]): void {
  if (lines.some((line) => line.includes(CONTROL_MARKER))) invalid("正文不能嵌套 [C2C_CONTROL]");
}

function readSection(lines: string[], index: number, name: string): { value: string; next: number } {
  if (lines[index] !== `${name}:`) invalid(`缺少 ${name} 段标题`);
  const contentStart = index + 1;
  let next = contentStart;
  while (next < lines.length && lines[next] !== "") {
    if (PROTOCOL_FIELD_PATTERN.test(lines[next]) || FORBIDDEN_FIELD_PATTERN.test(lines[next])) {
      invalid(`${name} 段不能包含协议字段或 Shell RPC 字段`);
    }
    next += 1;
  }
  const value = lines.slice(contentStart, next).join("\n");
  if (!value.trim()) invalid(`${name} 段不能为空`);
  return { value, next };
}

export function parseControlMessage(text: string): ControlCommand | ControlDone {
  let lines = unwrap(normalizeLines(text));
  if (lines[0] !== CONTROL_MARKER) invalid("必须以 [C2C_CONTROL] 开头");
  rejectNestedProtocol(lines.slice(1));

  const state = lines[1];
  if (state !== "STATE: COMMAND" && state !== "STATE: DONE") invalid("第二行必须是 STATE: COMMAND 或 STATE: DONE");
  const controlSessionId = readHeaderId(lines, 2, "CONTROL_SESSION_ID");
  const workspaceId = readHeaderId(lines, 3, "WORKSPACE_ID");
  const commandId = readHeaderId(lines, 4, "COMMAND_ID");

  if (state === "STATE: DONE") {
    if (lines.length !== 5) invalid("DONE 消息不能包含 KIND 或正文");
    return { state: "DONE", controlSessionId, workspaceId, commandId };
  }

  const kindLine = lines[5];
  const kind = kindLine?.startsWith("KIND: ") ? kindLine.slice("KIND: ".length) : "";
  if (!CONTROL_KINDS.includes(kind as ControlKind)) invalid("KIND 必须是 TASK、ANALYZE、TEST 或 REVIEW");
  if (lines[6] !== "") invalid("KIND 后必须有一个空行");

  lines = lines.slice(7);
  rejectNestedProtocol(lines);
  const goal = readSection(lines, 0, "GOAL");
  if (lines[goal.next] !== "") invalid("GOAL 段后必须有一个空行");
  const instructions = readSection(lines, goal.next + 1, "INSTRUCTIONS");
  if (lines[instructions.next] !== "") invalid("INSTRUCTIONS 段后必须有一个空行");
  const successCriteria = readSection(lines, instructions.next + 1, "SUCCESS_CRITERIA");
  if (successCriteria.next !== lines.length) invalid("SUCCESS_CRITERIA 段后不能有额外内容");

  return {
    state: "COMMAND",
    controlSessionId,
    workspaceId,
    commandId,
    kind: kind as ControlKind,
    goal: goal.value,
    instructions: instructions.value,
    successCriteria: successCriteria.value,
  };
}

/** 仅从可信来源的首个头区提取合法 ID；正文和普通引用一律不参与识别。 */
export function candidateCommandId(text: string): string | undefined {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return undefined;
  let lines: string[];
  try { lines = unwrap(normalizeLines(text)); } catch { return undefined; }
  if (lines[0] !== CONTROL_MARKER || lines[1] !== "STATE: COMMAND") return undefined;
  const blank = lines.indexOf("", 2);
  if (blank < 0) return undefined;
  const ids = lines.slice(0, blank).filter((line) => line.startsWith("COMMAND_ID: "));
  if (ids.length !== 1) return undefined;
  const value = ids[0].slice("COMMAND_ID: ".length);
  return ID_PATTERN.test(value) ? value : undefined;
}
