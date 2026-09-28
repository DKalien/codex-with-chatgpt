/** Human-facing workflow readiness projection. */

import type { WorkflowReadinessResult } from "./readiness-model.js";

/** Human-facing readiness summary. Never prints UUIDs or raw commands. */
export function formatWorkflowReadinessHuman(result: WorkflowReadinessResult): string {
  const lines: string[] = ["Codex with ChatGPT", ""];

  if (result.overall === "ready_local") {
    lines.push("✓ 当前项目已识别");
    lines.push("✓ ChatGPT 工作流状态可复用");
    lines.push("✓ 当前 Desktop 会话已就绪（identity + inspect 确认）");
    lines.push("");
    lines.push("Ready.（本机执行路径已确认；ChatGPT Connector 请求级校验仍需 Activation/G2）");
    return lines.join("\n");
  }

  if (result.overall === "blocked") {
    lines.push("当前工作流状态无法安全复用。");
    const first = result.blockers[0]?.code;
    if (first === "desktop_unresolved_delivery") {
      lines.push("存在结果不明的 Desktop 投递，需先人工核对。");
    } else if (first === "desktop_delivery_unknown") {
      lines.push("Desktop 投递状态无法确认，不能视为 Ready。");
    } else if (first === "desktop_delivery_unavailable") {
      lines.push("Desktop 投递当前不可用，不能视为 Ready。");
    } else if (first === "authorization_unknown") {
      lines.push("授权状态无法确认，不能当作缺授权或已授权。");
    } else if (first === "connector_contract_unknown") {
      lines.push("Connector/runtime contract 未知，需先诊断，不要仅恢复 OAuth。");
    } else {
      lines.push("请先处理未知或损坏状态，不要强行继续。");
    }
    return lines.join("\n");
  }

  if (result.overall === "ready_remote") {
    lines.push("✓ 当前项目已识别");
    lines.push("✓ Remote Control 在线");
    if (result.desktop.currentTarget !== "exact" || !result.desktop.enabled) {
      lines.push("· 当前 Desktop 会话未绑定");
    } else {
      lines.push("· 当前 Desktop 会话暂不可直接复用");
    }
    lines.push("");
    lines.push("可从 ChatGPT 跨设备继续任务。");
    return lines.join("\n");
  }

  if (result.overall === "resume_checkpoint") {
    lines.push("✓ 当前项目已识别");
    lines.push("存在未完成的会话 checkpoint。");
    lines.push("请继续原任务，不要创建新的 INIT。");
    return lines.join("\n");
  }

  if (result.overall === "busy") {
    lines.push("✓ 当前项目已识别");
    lines.push("当前已有进行中的执行或等待。");
    lines.push("请等待当前任务结束，不要启动第二条。");
    return lines.join("\n");
  }

  if (result.overall === "needs_connection") {
    lines.push("当前连接尚未就绪。");
    lines.push("请先恢复 Bridge / 连接状态，再继续日常工作流。");
    return lines.join("\n");
  }

  if (result.overall === "needs_authorization") {
    lines.push("连接端点已存在，但 ChatGPT 授权需要恢复。");
    lines.push("请先恢复授权，再继续工作流。");
    return lines.join("\n");
  }

  if (result.overall === "needs_project") {
    lines.push("✓ 连接已就绪");
    lines.push("Project 尚未完成绑定。");
    return lines.join("\n");
  }

  if (result.overall === "needs_conversation") {
    lines.push("✓ Project 已就绪");
    lines.push("当前 thread 尚无可复用 Chat（需本线程自己的对话）。");
    lines.push("请先打开或绑定目标对话。");
    return lines.join("\n");
  }

  // needs_desktop_bind
  lines.push("当前连接和 Project 已就绪。");
  lines.push("下一步只需绑定当前 Desktop 会话。");
  return lines.join("\n");
}
