import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { parseChatgptConversationRoute } from "../chatgpt/route.js";
import { assertCleanupPath } from "./fence.js";
import { CommandCleanupError } from "./schema.js";

const keySchema = z.object({ version: z.literal(1), workspaceId: z.string().regex(/^[a-f0-9]{12}$/), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const witnessSchema = z.object({ version: z.literal(1), workspaceId: keySchema.shape.workspaceId, eventId: z.string().regex(/^[a-f0-9]{32}$/), attemptId: z.string().uuid(), routeCanonical: z.string().max(2048), companionId: z.string().uuid() }).strict();
type WitnessIdentity = Omit<z.infer<typeof witnessSchema>, "version">;

/** Workspace signing authority contains no command/attempt history. Only the Companion keeps the witness. */
function signingKey(workspaceId: string, create: boolean, stateDir: string): Buffer | null {
  keySchema.shape.workspaceId.parse(workspaceId);
  const file = path.join(path.resolve(stateDir), "command-cleanup-keys", `${workspaceId}.json`);
  assertCleanupPath(file, stateDir);
  if (!fs.existsSync(file)) {
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ version: 1, workspaceId, key: randomBytes(32).toString("hex") })); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    // Hard link is an atomic create-if-absent; concurrent issuers never replace the signing key.
    try { fs.linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { fs.unlinkSync(temporary); }
  }
  assertCleanupPath(file, stateDir);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("not regular");
    const value = keySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (value.workspaceId !== workspaceId) throw new Error("identity");
    return Buffer.from(value.key, "hex");
  } catch { throw new CommandCleanupError("COMMAND_CLEANUP_WITNESS_CORRUPT", "terminal witness signing authority 损坏；fail closed。"); }
}

function canonicalIdentity(input: WitnessIdentity): z.infer<typeof witnessSchema> {
  return witnessSchema.parse({ ...input, routeCanonical: parseChatgptConversationRoute(input.routeCanonical).canonical, version: 1 });
}

export function issueTerminalWitness(input: WitnessIdentity, stateDir = getStateDir(), create = true): string {
  const key = signingKey(input.workspaceId, create, stateDir);
  if (!key) throw new CommandCleanupError("COMMAND_CLEANUP_WITNESS_MISSING", "缺少既有 terminal witness authority；查询不能创建。");
  const body = Buffer.from(JSON.stringify(canonicalIdentity(input))).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("hex")}`;
}
export function ensureTerminalWitnessKey(workspaceId: string, stateDir = getStateDir()): void { signingKey(workspaceId, true, stateDir); }

/** Proves the exact previously issued attempt, never that an absent arbitrary event was observed. */
export function verifyTerminalWitness(token: string | undefined, input: WitnessIdentity, stateDir = getStateDir()): boolean {
  if (typeof token !== "string" || token.length > 4096) return false;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const key = signingKey(input.workspaceId, false, stateDir);
  if (!key) return false;
  if (!timingSafeEqual(Buffer.from(match[2]!, "hex"), createHmac("sha256", key).update(match[1]!).digest())) return false;
  try {
    const value = witnessSchema.parse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")));
    return JSON.stringify(value) === JSON.stringify(canonicalIdentity(input));
  } catch { return false; }
}
