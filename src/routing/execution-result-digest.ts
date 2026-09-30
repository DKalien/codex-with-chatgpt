import { createHash } from "node:crypto";
import { resultSchema, type RoutingResult } from "./schema.js";

/** Canonical digest shared by R4 Result Outbox and the planner-independent Result Bus. */
export function canonicalRoutingResultDigest(result: RoutingResult): string {
  const parsed = resultSchema.parse(result);
  if (!("rawSummary" in parsed) || !("machineEvidence" in parsed)) {
    throw new Error("legacy RoutingResult 缺少 summary/evidence");
  }
  return createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex");
}
