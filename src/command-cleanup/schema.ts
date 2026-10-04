import { createHash } from "node:crypto";
import { z } from "zod";

export class CommandCleanupError extends Error {
  /** Bounded operational identity only; never lock paths/nonces or raw contents. */
  commandId?: string;
  constructor(readonly code: string, message: string) { super(message); this.name = "CommandCleanupError"; }
}

export const cleanupArtifactSchema = z.object({
  kind: z.string().regex(/^[a-z_]{1,48}$/),
  id: z.string().min(1).max(256),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CleanupArtifact = z.infer<typeof cleanupArtifactSchema>;
export interface CommandCleanupTarget {
  workspaceId: string;
  workspaceRoot: string;
  commandId: string;
  iteration: number;
  stateDir?: string;
}
export function cleanupArtifact(kind: string, id: string, value: unknown): CleanupArtifact {
  return cleanupArtifactSchema.parse({ kind, id, sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
}
export function assertCleanupArtifacts(current: readonly CleanupArtifact[], expected: readonly CleanupArtifact[]): void {
  for (const item of current) {
    const original = expected.find(value => value.kind === item.kind && value.id === item.id);
    if (!original || original.sha256 !== item.sha256) {
      throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "command cleanup artifact identity 已变化；保留 cleanup_pending。");
    }
  }
}
export const cleanupJournalSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  workspaceRoot: z.string().min(1),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  iteration: z.literal(1),
  cleanupId: z.string().uuid(),
  mode: z.enum(["auto_observed", "manual_force"]),
  phase: z.enum(["snapshot_pending", "fenced", "projections_deleted", "producers_deleted", "bus_deleted"]),
  createdAt: z.string().datetime(),
  artifacts: z.array(cleanupArtifactSchema).max(512),
}).strict().superRefine((value, ctx) => {
  const keys = value.artifacts.map(item => `${item.kind}\0${item.id}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate cleanup artifact" });
});
export type CleanupJournal = z.infer<typeof cleanupJournalSchema>;
