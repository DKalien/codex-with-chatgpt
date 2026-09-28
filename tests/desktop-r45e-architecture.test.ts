import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const exportsOf = (source: string) => {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
    for (const item of block[1].split(",")) if (item.trim()) names.add(item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
  }
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g)) names.add(match[1]);
  return [...names].sort();
};

describe("R4.5e Desktop decomposition boundaries", () => {
  it("keeps result and finalizer facades explicit", () => {
    expect(exportsOf(read("src/desktop/result.ts"))).toEqual([
      "CurrentDesktopDelivery", "DesktopResultError", "DesktopResultInput", "DesktopResultPendingError",
      "DesktopResultReceipt", "DesktopResultWorkspace", "desktopResultInput", "discoverCurrentDesktopDelivery",
      "finalizeReceiptFinalizationDraft", "recordDesktopResult",
    ]);
    expect(exportsOf(read("src/desktop/receipt-finalizer.ts"))).toEqual([
      "RECEIPT_FINALIZER_MAX_LIFETIME_MS", "RECEIPT_FINALIZER_POLL_MS", "ReceiptFinalizationAlert",
      "ReceiptFinalizationDraft", "ReceiptFinalizationFenceResult", "ReceiptFinalizationInput",
      "ReceiptFinalizationMarkedDraft", "ReceiptFinalizationMarker", "ReceiptFinalizationOwnershipSnapshot",
      "ReceiptFinalizationStateError", "canonicalReceiptFinalizationInput", "findReceiptFinalizationDraft",
      "listReceiptFinalizationAlerts", "readReceiptFinalizationAlert", "readReceiptFinalizationDraft",
      "receiptFinalizationAlertPath", "receiptFinalizationAlertSchema", "receiptFinalizationClaimPath",
      "receiptFinalizationDraftPath", "receiptFinalizationDraftSchema", "receiptFinalizationMarkerDigest",
      "runReceiptFinalizer", "sanitizeReceiptFinalizationInput", "spawnReceiptFinalizerWorker",
      "stageReceiptFinalization", "writeReceiptFinalizationAlert", "writeReceiptFinalizationWorkerFailureAlert",
    ]);
    expect(read("src/desktop/result.ts")).not.toMatch(/export (?:async )?function/);
    expect(read("src/desktop/receipt-finalizer.ts")).not.toMatch(/export (?:async )?function/);
    expect(read("src/desktop/result.ts")).toContain("result-evidence.js");
    expect(read("src/desktop/receipt-finalizer.ts")).toContain("receipt-finalizer-schema.js");
    expect(read("src/desktop/receipt-finalizer.ts")).toContain("receipt-finalizer-store.js");
    expect(read("src/desktop/receipt-finalizer.ts")).toContain("receipt-finalizer-worker.js");
  });

  it("keeps recovery coordination and forbidden dependencies separated", () => {
    const desktop = fs.readdirSync(path.join(root, "src/desktop")).filter(name => name.endsWith(".ts"));
    const recovery = desktop.filter(name => ["abandonment.ts", "outcome-resolution.ts", "unknown-reconciliation.ts", "service.ts"].includes(name));
    for (const name of recovery) {
      const imports = read(`src/desktop/${name}`).split(/\r?\n/).filter(line => /^\s*import\b/.test(line)).join("\n");
      expect(imports).not.toMatch(/withEvidenceLock[\s\S]*from ["']\.\/legacy-reconciliation\.js["']/);
    }
    const all = desktop.map(name => read(`src/desktop/${name}`)).join("\n");
    expect((all.match(/export function withEvidenceLock(?:<[^>]+>)?\s*\(/g) ?? []).length).toBe(1);
    expect(read("src/desktop/legacy-reconciliation.ts")).not.toMatch(/export function withEvidenceLock/);
    expect(read("src/desktop/result-commit.ts")).not.toMatch(/from ["']\.\/ipc\.js["']/);
    expect(read("src/desktop/result-commit.ts")).toMatch(/function appendTrustedReceiptLocked/);
    expect(read("src/desktop/result-commit.ts")).not.toContain('./receipt-finalizer.js');
    expect(read("src/desktop/result-schema.ts")).not.toContain('./receipt-finalizer.js');
    for (const file of ["result-record.ts", "result-evidence.ts", "result-finalization.ts"]) {
      expect(read(`src/desktop/${file}`)).not.toContain('./receipt-finalizer.js');
    }
    expect(read("src/desktop/result-finalization.ts")).not.toMatch(/createHash|canonicalReceiptFinalizationInput/);
    expect(read("src/desktop/result-finalization.ts")).toContain("receiptHash");
    expect(read("src/desktop/result-record.ts")).not.toMatch(/saveExecutionOutput|saveRestrictedExecutionOutput|appendExecutionRecordLocked/);
    expect(read("src/desktop/result-record.ts")).not.toMatch(/desktopIpc|DesktopResultActivityMarkerObservation|receiptFinalizationMarkerDigest|itemIds\.length|itemTypes\.length/);
    expect(read("src/desktop/result-evidence.ts")).toContain("assertResultActivityMarker");
    expect(read("src/desktop/result-finalization.ts")).not.toMatch(/saveExecutionOutput|saveRestrictedExecutionOutput|appendExecutionRecordLocked|\bdesktopIpc\b/);
    expect(read("src/desktop/receipt-finalizer-worker.ts")).not.toMatch(/from ["']\.\/(feedback|browser|cli|mcp)/);
    expect(read("src/desktop/receipt-finalizer-worker.ts")).not.toMatch(/from ["']\.\/ipc\.js["']|readDesktop/);
    expect(read("src/desktop/receipt-finalizer-worker.ts")).toMatch(/resolveReceiptFinalizationTarget|inspectReceiptFinalizationFence|inspectLegacyReceiptFinalizationContext/);
    expect(read("src/desktop/result-evidence.ts")).toMatch(/from ["']\.\/ipc\.js["']/);
    for (const file of ["result-record.ts", "result-commit.ts", "result-finalization.ts", "receipt-finalizer-worker.ts"]) {
      expect(read(`src/desktop/${file}`)).not.toMatch(/\bdesktopIpc\b/);
    }
    expect(read("src/desktop/receipt-finalizer-worker.ts")).not.toMatch(/node:fs|from ["']zod["']|function (?:acquireClaim|releaseClaim|removeDraft|removeAlert)/);
    expect(read("src/desktop/receipt-finalizer-store.ts")).not.toMatch(/function writeAtomic/);
    expect(all).not.toMatch(/from ["']\.\.\/feedback\//);
  });
});
