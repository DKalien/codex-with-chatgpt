/* Shared presentation only. Never performs network, storage, lifecycle or DOM-send operations. */
(() => {
  const FRESH_MS = 45_000;
  const fresh = (value, now) => {
    const at = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(at) && at <= now + 1000 && now - at <= FRESH_MS;
  };
  const deliveryLabels = { cancelled: "下发已取消", pending: "等待送达", accepted: "Codex 已接受", rejected: "明确未送出", outcome_unknown: "送达待核实" };
  const resultLabels = { ok: "已完成", failed: "执行失败", blocked: "执行受阻" };
  const feedbackLabels = { cancelled: "回流已取消", queued: "等待回流", ready: "等待回流", reserved: "已预约回流", claimed: "发送中 · 待确认",
    observed: "回流已确认", outcome_unknown: "发送结果待核实", retired_unknown: "已行政结束等待" };
  const activityLabels = { idle: "空闲", busy: "忙碌", approval_required: "等待本机处理", unknown: "无法确认" };
  const issueLabels = { cleanup_pending: "清理事务待收敛", empty_lifecycle_lock: "空生命周期锁，需人工核验", lifecycle_lock_present: "存在生命周期锁，所有者待核验",
    repair_fence_present: "存在修复隔离标记", lifecycle_state_unreadable: "生命周期证据不可读", delivery_identity_conflict: "投递身份冲突" };
  const administrativeLabels = { abandoned: "已行政结束等待", retired: "已行政退役", resolved_unknown: "已接受结果不明并结束等待" };
  function row(command, journal) {
    const feedback = (command.feedback ?? []).map(event => ({ ...event,
      label: event.status !== "observed" && journal?.state === "OBSERVED_PENDING_ACK"
        && journal.eventId === event.eventId && journal.attemptId && journal.attemptId === event.attemptId
        ? "网页已观察 · 待确认" : feedbackLabels[event.status] ?? "回流状态未知" }));
    const executions = command.executions ?? [];
    const needsAttention = ["rejected", "outcome_unknown"].includes(command.delivery?.status)
      || executions.some(result => result.status !== "ok")
      || feedback.some(event => ["outcome_unknown", "retired_unknown"].includes(event.status))
      || (command.issues ?? []).length > 0
      || command.scope === "historical" && command.delivery?.status === "accepted" && !executions.length && !command.administrative;
    return { ...command, feedback, executions, needsAttention,
      active: !command.administrative && command.delivery?.status !== "cancelled" && !needsAttention && (!feedback.length || feedback.some(event => !["observed", "cancelled", "retired_unknown"].includes(event.status))),
      scopeLabel: command.scope === "current" ? "当前对话" : command.scope === "current_target" ? "当前 Codex 目标" : "历史遗留",
      issueLabels: (command.issues ?? []).map(issue => issueLabels[issue] ?? issue),
      administrativeLabel: administrativeLabels[command.administrative] ?? null,
      deliveryLabel: deliveryLabels[command.delivery?.status] ?? "送达未确认",
      executionLabel: executions.length ? executions.map(result => `第 ${result.iteration} 次 · ${resultLabels[result.status] ?? "未知"}`).join("；") : "执行未确认",
      feedbackLabel: feedback.length ? [...new Set(feedback.map(event => event.label))].join("；") : "尚无回流证据" };
  }
  function derive(response, now = Date.now()) {
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
                : web.composer === "empty" && web.generation === "idle" && web.safe === true ? "可接收结果" : "暂不可接收";
    }
    return {
      serviceFresh, bridge: serviceFresh ? "连接正常" : response?.ok ? "状态已过期" : "无法连接",
      codex: executorFresh ? activityLabels[snapshot?.executor?.state] ?? "无法确认" : "无法确认",
      web: webLabel, autonomy: response?.autonomy === "armed" ? "已开启" : "已暂停",
      observedAt: snapshot?.observedAt ?? null, reason: response?.reason ?? snapshot?.executor?.reason ?? null,
      workspaceId: snapshot?.workspaceId ?? null, route: snapshot?.routeCanonical ?? null,
      rows: response?.ok === true ? (snapshot?.commands ?? []).map(command => row(command, response.journal)) : [],
      truncated: snapshot?.truncated === true,
    };
  }
  globalThis.C2COperations = Object.freeze({ derive, fresh, FRESH_MS, resultLabels });
})();
