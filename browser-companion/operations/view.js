/* Shared presentation only. Never performs network, storage, lifecycle or DOM-send operations. */
(() => {
  const FRESH_MS = 45_000;
  const fresh = (value, now) => {
    const at = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(at) && at <= now + 1000 && now - at <= FRESH_MS;
  };
  const deliveryLabels = { cancelled: "下发已取消", pending: "等待送达", accepted: "Codex 已接受", rejected: "明确未送出", outcome_unknown: "送达待核实" };
  const resultLabels = { ok: "已完成", failed: "执行失败", blocked: "执行受阻" };
  const feedbackLabels = { cancelled: "网页回流已取消", queued: "已排队 · 等待网页可接收", ready: "已准备 · 等待网页接收", reserved: "已预约网页回流", claimed: "网页发送中 · 待确认",
    observed: "回流已确认", outcome_unknown: "发送结果待核实", retired_unknown: "已行政结束等待" };
  const activityLabels = { idle: "空闲", busy: "忙碌", approval_required: "等待本机处理", unknown: "无法确认" };
  const issueLabels = { cleanup_pending: "清理事务待收敛", empty_lifecycle_lock: "空生命周期锁，需人工核验", lifecycle_lock_present: "存在生命周期锁，所有者待核验",
    repair_fence_present: "存在修复隔离标记", lifecycle_state_unreadable: "生命周期证据不可读", delivery_identity_conflict: "投递身份冲突" };
  const administrativeLabels = { abandoned: "已行政结束等待", retired: "已行政退役", resolved_unknown: "已接受结果不明并结束等待" };
  const turnLabels = { queued: "已排队", starting: "正在派发", running: "执行中", completed: "turn 已结束 · 待 Review",
    failed: "turn 失败", cancelled: "已取消或中断", awaiting_approval: "等待本机审批", needs_reconciliation: "官方会话待核验" };
  function row(command, journal) {
    const feedback = (command.feedback ?? []).map(event => ({ ...event,
      label: event.isolated === true ? "本条已隔离 · 未确认送达 · 后续继续"
        : event.status !== "observed" && journal?.state === "OBSERVED_PENDING_ACK"
          && journal.eventId === event.eventId && journal.attemptId && journal.attemptId === event.attemptId
          ? "网页已观察 · 待确认" : feedbackLabels[event.status] ?? "回流状态未知" }));
    const executions = command.executions ?? [];
    const needsAttention = ["rejected", "outcome_unknown"].includes(command.delivery?.status)
      || ["failed", "awaiting_approval", "needs_reconciliation"].includes(command.appServerTurn?.status)
      || executions.some(result => result.status !== "ok")
      || feedback.some(event => event.isolated === true || ["outcome_unknown", "retired_unknown"].includes(event.status))
      || command.delivery?.queueStatus === "blocked"
      || (command.issues ?? []).length > 0
      || command.scope === "historical" && command.delivery?.status === "accepted" && !executions.length && !command.administrative;
    return { ...command, feedback, executions, needsAttention,
      active: !command.administrative && command.delivery?.status !== "cancelled" && !needsAttention
        && (feedback.length ? feedback.some(event => !["observed", "cancelled", "retired_unknown"].includes(event.status)) : command.appServerTurn?.status !== "cancelled"),
      scopeLabel: command.scope === "current" ? "当前对话" : command.scope === "current_target" ? "当前 Codex 目标" : "历史遗留",
      issueLabels: (command.issues ?? []).map(issue => issueLabels[issue] ?? issue),
      administrativeLabel: administrativeLabels[command.administrative] ?? null,
      deliveryLabel: command.appServerTurn ? `官方 App Server · ${turnLabels[command.appServerTurn.status] ?? "待核验"}`
        : command.delivery?.queueStatus === "queued" ? "已排队 · 等待 Codex 处理"
        : command.delivery?.queueStatus === "dispatching" ? "正在派发"
          : command.delivery?.queueStatus === "blocked" ? `派发受阻 · ${command.delivery.queueReason ?? "需核验"}`
            : deliveryLabels[command.delivery?.status] ?? "送达未确认",
      executionLabel: command.appServerTurn ? `${turnLabels[command.appServerTurn.status] ?? "待核验"}；测试结果未判定`
        : executions.length ? executions.map(result => `第 ${result.iteration} 次 · ${resultLabels[result.status] ?? "未知"}`).join("；") : "执行未确认",
      feedbackLabel: feedback.length ? [...new Set(feedback.map(event => event.label))].join("；") : "尚无回流证据" };
  }
  function canHide(command) {
    if (command.issues?.length || command.pendingPanelOperation) return false;
    if (command.appServerTurn) return ["completed", "failed", "cancelled"].includes(command.appServerTurn.status);
    if (command.delivery?.status === "pending" || command.delivery?.queueStatus) return false;
    return ["abandoned", "retired", "resolved_unknown"].includes(command.administrative)
      || command.delivery?.status === "cancelled"
      || command.delivery?.status === "accepted" && command.executions?.length > 0
        && command.executions.every(result => ["ok", "failed", "blocked"].includes(result.status));
  }
  function derive(response, now = Date.now(), hiddenIds = []) {
    const snapshot = response?.snapshot;
    const serviceFresh = response?.ok === true && fresh(snapshot?.observedAt, now);
    const executorFresh = serviceFresh && fresh(snapshot?.executor?.observedAt, now);
    const web = response?.web;
    let webLabel = "无法确认";
    if (serviceFresh && fresh(web?.observedAt, now)) {
      webLabel = !web.ownerAvailable ? "当前页面无 owner"
        : !web.routeMatches ? "页面与绑定不一致"
          : !web.verified ? "对话待验证"
            : web.generation === "streaming" || web.generation === "generating" ? "正在生成"
              : web.composer === "nonempty" ? "输入框有未发送内容"
                : web.composer === "empty" && web.generation === "idle" && web.safe === true
                  ? web.connectionReadiness?.ready !== true ? "当前对话需要完成连接"
                    : response?.journal?.state === "OUTCOME_UNKNOWN" ? "回流待核验" : "可接收结果" : "暂不可接收";
    }
    const allRows = response?.ok === true ? (snapshot?.commands ?? []).map(command => ({ ...row(command, response.journal),
      pendingPanelOperation: (snapshot?.panelAuthorization?.pending ?? []).some(operation => operation.commandId === command.commandId),
    })) : [];
    const hidden = new Set(hiddenIds);
    return {
      serviceFresh, bridge: serviceFresh ? "连接正常" : response?.ok ? "状态已过期" : "无法连接",
      codex: executorFresh ? activityLabels[snapshot?.executor?.state] ?? "无法确认" : "无法确认",
      web: webLabel, autonomy: response?.autonomy === "armed" ? "已开启" : "已暂停",
      observedAt: snapshot?.observedAt ?? null, reason: response?.reason ?? snapshot?.executor?.reason ?? null,
      workspaceId: snapshot?.workspaceId ?? null, route: snapshot?.routeCanonical ?? null,
      rows: allRows.filter(command => !hidden.has(command.commandId) || !canHide(command)),
      hiddenCount: allRows.filter(command => hidden.has(command.commandId) && canHide(command)).length,
      pendingFeedback: allRows.flatMap(command => command.feedback
        .filter(event => event.isolated === true || !["observed", "cancelled"].includes(event.status))
        .map(event => ({ ...event, commandId: command.commandId }))),
      truncated: snapshot?.truncated === true,
    };
  }
  globalThis.C2COperations = Object.freeze({ derive, canHide, fresh, FRESH_MS, resultLabels });
})();
