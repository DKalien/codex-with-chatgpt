import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Build artifact first, source fallback for tsx/Vitest; shared by observation and spawn. */
export function resolveDaemonSpawnHelperPath(moduleUrl = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [path.join(here, "helper", "daemon_spawn.py"),
    path.resolve(here, "..", "..", "src", "process", "helper", "daemon_spawn.py")];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

export function resolveDaemonSpawnPython(): string {
  return process.env.C2C_DAEMON_PYTHON?.trim() || process.env.C2C_DESKTOP_PYTHON?.trim() || "python";
}

const errorCode = z.string().regex(/^(WIN32_[0-9]{1,10}|INVALID_PID|PID_MISSING|PID_EXITED|IDENTITY_CHANGED|PROBE_UNAVAILABLE|UNSUPPORTED)$/).nullable();
export const processProbeSchema = z.object({
  pid: z.number().int().positive().max(0xffffffff),
  status: z.enum(["identified", "missing", "unknown"]),
  executable: z.string().min(1).max(32768).nullable(),
  creationTime: z.string().regex(/^[a-zA-Z0-9:-]{1,128}$/).nullable(),
  inAnyJob: z.boolean().nullable(),
  errors: z.object({ process: errorCode, executable: errorCode, creationTime: errorCode, inAnyJob: errorCode }).strict(),
  observedAt: z.string().datetime(),
}).strict().refine(value => value.status !== "identified" ||
  (value.executable !== null && value.creationTime !== null && value.errors.process === null));
export type ProcessProbe = z.infer<typeof processProbeSchema>;

export function unknownProcessProbe(pid: number): ProcessProbe {
  return { pid, status: "unknown", executable: null, creationTime: null, inAnyJob: null,
    errors: { process: "PROBE_UNAVAILABLE", executable: "PROBE_UNAVAILABLE", creationTime: "PROBE_UNAVAILABLE", inAnyJob: "PROBE_UNAVAILABLE" },
    observedAt: new Date().toISOString() };
}

/** Strict projection: malformed/extra fields cannot enter diagnostics or local status. */
export function parseProcessProbe(value: unknown, pid: number): ProcessProbe {
  const parsed = processProbeSchema.safeParse(value);
  return parsed.success && parsed.data.pid === pid ? parsed.data : unknownProcessProbe(pid);
}

export function probeProcess(pid: number, python = resolveDaemonSpawnPython(), helper = resolveDaemonSpawnHelperPath(), expectedCreation?: string): Promise<ProcessProbe> {
  return new Promise(resolve => {
    execFile(python, ["-I", "-B", "-X", "utf8", helper, "--probe-pid", String(pid), ...(expectedCreation ? [expectedCreation] : [])],
      { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, stdout) => {
        try { resolve(error ? unknownProcessProbe(pid) : parseProcessProbe(JSON.parse(stdout), pid)); }
        catch { resolve(unknownProcessProbe(pid)); }
      });
  });
}

/** Missing is a positive native observation, never a failed/denied probe. */
export function isProcessProvenMissing(value: ProcessProbe): boolean {
  return value.status === "missing" && ["PID_MISSING", "PID_EXITED", "WIN32_87"].includes(value.errors.process ?? "");
}

/** Node's Windows ESRCH can precede HANDLE signaling. Confirm that negative via the native probe. */
export async function observeProcessPresence(pid: number, platform = process.platform,
  nativeProbe: (pid: number) => Promise<ProcessProbe> = probeProcess): Promise<"present" | "missing" | "unknown"> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown";
    if (platform !== "win32") return "missing";
  }
  try {
    const observed = parseProcessProbe(await nativeProbe(pid), pid);
    return isProcessProvenMissing(observed) ? "missing" : observed.status === "identified" ? "present" : "unknown";
  } catch { return "unknown"; }
}
