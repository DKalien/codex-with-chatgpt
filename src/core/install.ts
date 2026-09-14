import path from "node:path";
import { createRequire } from "node:module";
import { getStateDir } from "../config/paths.js";
import { getRuntimeBuildId } from "../build-id.js";

export const CORE_INSTALL_VERSION = 3 as const;
interface InstallFields {
  /** 仅用于明确授权的源码维护；运行入口不再依赖这个目录存在。 */
  checkoutRoot: string;
  releaseRoot: string;
  runtimeBuildId: string;
  artifactSha256: string;
  installedAt: string;
}
export type InstallMetadata = InstallFields & ({ version: 2 } | { version: typeof CORE_INSTALL_VERSION; manifestSha256: string });
export type CoreVerification = "fast" | "full";
export class CoreInstallError extends Error {
  constructor(public readonly code: "CORE_INSTALL_INVALID" | "CORE_INSTALL_CORRUPT" | "CORE_INSTALL_BUILD_ID_UNAVAILABLE", message: string) {
    super(message); this.name = "CoreInstallError";
  }
}
export type CurrentInstallState =
  | { status: "missing"; metadata: null }
  | { status: "installed"; metadata: InstallMetadata }
  | { status: "corrupt"; metadata: null; error: CoreInstallError };

// 安装器在 build 前也需冻结旧 pointer，因此格式实现放在无依赖的 Node helper 中。
const release = createRequire(import.meta.url)("../../scripts/core-release.cjs") as {
  readCurrent(stateDir: string, verification: CoreVerification): InstallMetadata | null;
  installCore(root: string, buildId: string, stateDir: string): InstallMetadata;
};
export function currentInstallPath(stateDir = getStateDir()): string { return path.join(path.resolve(stateDir), "current.json"); }
export function coreBinDir(stateDir = getStateDir()): string { return path.join(path.resolve(stateDir), "bin"); }
export function launcherPath(stateDir = getStateDir()): string { return path.join(coreBinDir(stateDir), "c2c.js"); }
export function readCurrentInstall(stateDir = getStateDir(), verification: CoreVerification = "full"): InstallMetadata | null {
  try { return release.readCurrent(stateDir, verification); }
  catch (error) { throw new CoreInstallError("CORE_INSTALL_CORRUPT", error instanceof Error ? error.message : "安装状态损坏"); }
}
export function getCurrentInstall(stateDir = getStateDir(), verification: CoreVerification = "full"): CurrentInstallState {
  try {
    const metadata = readCurrentInstall(stateDir, verification);
    return metadata ? { status: "installed", metadata } : { status: "missing", metadata: null };
  } catch (error) { return { status: "corrupt", metadata: null, error: error as CoreInstallError }; }
}
export function installCore(root: string, runtimeBuildId: string | null = getRuntimeBuildId()): InstallMetadata {
  if (runtimeBuildId === null) throw new CoreInstallError("CORE_INSTALL_BUILD_ID_UNAVAILABLE", "当前构建没有 runtime build ID");
  const captured = getRuntimeBuildId();
  if (captured !== null && captured !== runtimeBuildId) throw new CoreInstallError("CORE_INSTALL_INVALID", "传入 runtime build 与当前构建不一致");
  try { return release.installCore(root, runtimeBuildId, getStateDir()); }
  catch (error) { throw new CoreInstallError("CORE_INSTALL_INVALID", error instanceof Error ? error.message : "安装失败"); }
}
