import fs from "node:fs";
import { expect, it } from "vitest";

const skill = fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
const receipt = skill.split("### Desktop-delivered turn：最终回复前自动记录 execution receipt")[1]?.split("### 防重复")[0] ?? "";

it("Desktop envelope 触发专属收尾，不重复 Activation 或规划", () => {
  expect(skill.split("---")[1]).toContain("C2C_DESKTOP_TASK");
  for (const text of ["C2C_DESKTOP_TASK", "不再进入 Activation", "最终回复前必须完成 execution receipt",
    "--exit-status ok|failed|blocked", '--tests "not run"', "不能沿用旧测试", "execution_output"])
    expect(receipt).toContain(text);
});

it("本机 receipt 绑定原 accepted thread，按本轮文件记录并对失败关闭", () => {
  for (const text of ["desktop record-result", "CODEX_THREAD_ID", "delivery.threadId", "deliveryStatus=accepted",
    "disable/rebind", "outcome_unknown", "完全相同重试幂等", "内容冲突停止", "不能宣称验收闭环完成",
    "不能直接复制整个脏工作区文件列表", "不要 reset/stash", "不执行 command", "desktop_<commandId>"])
    expect(receipt).toContain(text);
});

it("receipt 校验 exact active 或 idle latest terminal，后续 turn 和未知状态均不落盘", () => {
  for (const text of ["受控 Desktop IPC", "唯一当前 `inProgress`", "delivery.turnId", "后续 turn 不能代记",
    "无/多个/未知 active turn", "状态读取失败", "不创建/修改 execution record 或 output",
    "不接受调用方传入 turnId", "不能单独授权写记录", "重试也必须通过相同 exact-turn 校验",
    "canonical history 最新侧完整", "存在更晚 turn", "写入前再次校验", "DESKTOP_STATE_UNAVAILABLE"])
    expect(receipt).toContain(text);
});

it("Desktop Review 精确查 commandId/outputId，缺记录不引用历史 test_status", () => {
  const review = skill.split("只有在用户主动回来要求“干完了，检查一下”时")[1]?.split("### Desktop-delivered")[0] ?? "";
  for (const text of ["exact `commandId`", "execution_summary", "outputId", "execution_output",
    "本轮验收记录缺失", "`test_status` 当本轮证据", "不能引用历史测试为本轮通过"])
    expect(review).toContain(text);
});

it("outcome_unknown 仅允许本机严格对账恢复 receipt identity", () => {
  for (const text of ["desktop reconcile-unknown", "canonical history", "`exhausted`", "UTF-8 bytes/SHA-256",
    "0 个候选保持 unknown", "多个候选", "outcome_unknown -> accepted + turnId",
    "不写 execution receipt", "后续 turn", "不能代记"])
    expect(skill).toContain(text);
});
