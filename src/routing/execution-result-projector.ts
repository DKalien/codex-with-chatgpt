import { readDesktop } from "../desktop/store.js";
import { readExecutionOutputMetadataStrict } from "../execution/output.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";
import { RoutingError, resultInputSchema, routingCommandIdSchema, type ResultInput } from "./schema.js";
import { readRouting, resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "./store.js";

const SHA256 = /^[a-f0-9]{64}$/;

function conflict(reason: string): never {
  throw new RoutingError("ROUTING_RESULT_EVIDENCE_CONFLICT", `${reason}；拒绝投影 ExecutionResult。`);
}

/**
 * R4a 只读接缝：由本机唯一 trusted Desktop receipt 产生候选 ResultInput。
 * 不写 Routing/feedback/outbox，也不向 Desktop 发送任何消息。
 */
export function projectTrustedDesktopExecutionResult(
  identity: RoutingWorkspaceIdentity,
  receipt: { commandId: string; desktopReceiptSha256: string },
): ResultInput {
  const workspace = resolveWorkspaceIdentity(identity);
  routingCommandIdSchema.parse(receipt.commandId);
  if (!SHA256.test(receipt.desktopReceiptSha256)) conflict("receipt 摘要格式无效");

  const routing = readRouting(workspace);
  const command = routing?.commands.find(item => item.commandId === receipt.commandId);
  if (!command || command.deliveryStatus !== "accepted") conflict("缺少已接受的 Routing Command");
  const executor = routing!.routes.find(item => item.routeId === command.executorRouteId);
  if (!executor || executor.role !== "executor" || executor.platform !== "codex_desktop" ||
      executor.locator.hostId !== "local") conflict("Command executor route 不是精确本机 Desktop target");

  const desktop = readDesktop(workspace.id);
  if (!desktop || desktop.workspaceRoot !== workspace.root) conflict("Desktop workspace 身份不匹配");
  const deliveries = desktop.deliveries.filter(item => item.commandId === command.commandId);
  if (deliveries.length !== 1) conflict("缺少唯一 Desktop delivery");
  const delivery = deliveries[0]!;
  if (delivery.deliveryStatus !== "accepted" || !delivery.turnId ||
      delivery.intent !== command.intent || delivery.messageBytes !== command.payloadBytes ||
      delivery.messageSha256 !== command.payloadSha256 ||
      delivery.threadId !== executor.conversationId) {
    conflict("accepted delivery 与 Command/executor 不一致");
  }

  const taskId = `desktop_${command.commandId}`;
  const records = readExecutionRecordsStrict(workspace.id).filter(item =>
    item.commandId === command.commandId || item.taskId === taskId);
  if (records.length !== 1) conflict("缺少唯一 Desktop execution record");
  const record = records[0]!;
  if (!isTrustedDesktopReceipt(record, command.commandId) ||
      record.desktopReceiptSha256 !== receipt.desktopReceiptSha256 ||
      record.rawSummary === undefined ||
      record.desktopThreadId !== delivery.threadId ||
      record.desktopOriginTurnId !== delivery.turnId ||
      record.desktopBindingId !== delivery.bindingId ||
      typeof record.desktopResultTurnId !== "string") {
    conflict("execution record 缺少可信摘要或 thread/turn/binding provenance");
  }

  if ((record.outputId === undefined) !== (record.outputAvailable === undefined)) {
    conflict("execution record 的 output 元数据不完整");
  }
  const outputs = readExecutionOutputMetadataStrict(workspace.id).filter(item =>
    item.taskId === taskId && item.iteration === record.iteration);
  if (record.outputId === undefined ? outputs.length !== 0 :
      outputs.length !== 1 || outputs[0]!.id !== record.outputId ||
      outputs[0]!.allowed !== record.outputAvailable ||
      (!outputs[0]!.allowed && (!outputs[0]!.restrictedReason || outputs[0]!.sizeBytes !== 0))) {
    conflict("receipt 与 output index 不一致或 output 已不可验证");
  }

  const candidate = resultInputSchema.safeParse({
    commandId: command.commandId,
    executorRouteId: command.executorRouteId,
    iteration: record.iteration,
    status: record.exitStatus,
    rawSummary: record.rawSummary,
    machineEvidence: {
      version: 1,
      source: "codex_desktop_receipt",
      desktopReceiptSha256: record.desktopReceiptSha256,
      taskId: record.taskId,
      iteration: record.iteration,
      status: record.exitStatus,
      threadId: record.desktopThreadId,
      originTurnId: record.desktopOriginTurnId,
      resultTurnId: record.desktopResultTurnId,
      bindingId: record.desktopBindingId,
      changedFiles: record.changedFiles,
      testsSummary: record.tests,
      ...(record.outputId === undefined ? {} : {
        output: { outputId: record.outputId, outputAvailable: record.outputAvailable },
      }),
    },
  });
  if (!candidate.success) conflict("execution record 无法满足 canonical result schema");
  return candidate.data;
}
