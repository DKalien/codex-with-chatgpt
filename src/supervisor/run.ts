import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeBuildId } from "../build-id.js";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { withSupervisorLaunch, readSupervisorConfig, readSupervisorLaunch, type SupervisorLaunch } from "./store.js";
import { productionLoopDependencies, runSupervisorLoop } from "./lifecycle.js";

export function validateSupervisorLaunch(workspace: Workspace, stateDir: string, pinPath: string | undefined,
  buildId: string | null, fileIdentity: unknown, moduleUrl = import.meta.url): SupervisorLaunch {
  if (!pinPath || !buildId || path.resolve(pinPath) !== pinPath) throw new Error("SUPERVISOR_STABLE_LAUNCH_REQUIRED");
  if (path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..") !== path.join(stateDir, "releases", buildId))
    throw new Error("SUPERVISOR_STABLE_LAUNCH_REQUIRED");
  return readSupervisorLaunch(workspace.root, pinPath, buildId, fileIdentity, { stateDir });
}

/** Foreground for Task Scheduler: do not detach, hot reload, or terminate a Bridge. */
export async function runInstalledSupervisor(root: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("SUPERVISOR_UNSUPPORTED_PLATFORM");
  const workspace = new Workspace(root), stateDir = getStateDir();
  const pinPath = process.env.C2C_SUPERVISOR_LAUNCH_PIN;
  const encodedIdentity = process.env.C2C_SUPERVISOR_LAUNCH_IDENTITY;
  delete process.env.C2C_SUPERVISOR_LAUNCH_PIN;
  delete process.env.C2C_SUPERVISOR_LAUNCH_IDENTITY;
  let identity: unknown;
  try {
    if (!encodedIdentity || encodedIdentity.length > 1024) throw new Error();
    identity = JSON.parse(encodedIdentity);
  } catch { throw new Error("SUPERVISOR_STABLE_LAUNCH_REQUIRED"); }
  const launch = validateSupervisorLaunch(workspace, stateDir, pinPath, getRuntimeBuildId(), identity);
  if (!readSupervisorConfig(workspace.root)) throw new Error("SUPERVISOR_CONFIG_MISSING");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    await withSupervisorLaunch(workspace.root, launch, lease =>
      runSupervisorLoop(productionLoopDependencies(workspace, () => lease.assertOwned()), controller.signal));
  }
  finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
