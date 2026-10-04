import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { parseProcessProbe } from "../src/process/process-probe.js";
import { resolveDaemonSpawnPython } from "../src/process/daemon-spawn.js";

const tempRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.tooling/test-tmp");

/** Test-only: callers close servers/children first. Persistent Windows holders fail. */
export async function cleanupStrict(...directories: string[]): Promise<void> {
  for (const directory of directories) {
    const relative = path.relative(tempRoot, path.resolve(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("fixture cleanup outside test-tmp");
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("fixture cleanup root is a link");
    // Node retries only EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM; 8 * 100ms linear backoff <= 3.6s.
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    if (fs.existsSync(directory)) throw new Error(`fixture cleanup incomplete: ${path.basename(directory)}`);
  }
}

export type FixtureProcessIdentity = { pid: number; creationTime: string; executable: string };

/** Capture ONLY the spawn protocol's probe, never discover teardown ownership from a saved PID. */
export function fixtureProcessIdentity(evidence: unknown): FixtureProcessIdentity | null {
  const pid = (evidence as { pid?: number } | null)?.pid;
  if (!Number.isSafeInteger(pid) || pid! <= 0 || pid === process.pid) throw new Error("invalid fixture PID");
  const probe = parseProcessProbe(evidence, pid!);
  if (probe.status === "missing" && ["PID_MISSING", "PID_EXITED", "WIN32_87"].includes(probe.errors.process ?? "")) return null;
  if (probe.status !== "identified" || probe.errors.executable || probe.errors.creationTime) throw new Error("fixture identity unknown");
  return { pid: probe.pid, creationTime: probe.creationTime!, executable: probe.executable! };
}

/** Windows opens one HANDLE: compare creation/exe, terminate and wait on that SAME kernel object. */
export async function stopFixtureProcess(identity: FixtureProcessIdentity | null): Promise<void> {
  if (identity === null) return;
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.pid === process.pid) throw new Error("invalid fixture PID");
  const helper = fileURLToPath(new URL("./fixture_process_teardown.py", import.meta.url));
  const { stdout } = await promisify(execFile)(resolveDaemonSpawnPython(),
    ["-I", "-B", "-X", "utf8", helper, JSON.stringify(identity), String(process.pid)],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024, encoding: "utf8" });
  if (!["exited", "missing"].includes(JSON.parse(stdout).status)) throw new Error("fixture exit not proven");
}

/** A short-lived ChildProcess can finish naturally; no PID lookup or termination is needed. */
export function waitForFixtureChildExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("exit", exited); child.off("error", failed); };
    const exited = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error("fixture child exit timed out")), timeoutMs);
    child.once("exit", exited);
    child.once("error", failed);
  });
}
