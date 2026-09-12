import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_ID_PATTERN = /^[a-f0-9]{64}$/;

export function isRuntimeBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

function readBuildId(moduleUrl: string): string | null {
  try {
    const value = fs.readFileSync(path.join(path.dirname(fileURLToPath(moduleUrl)), "build-id.txt"), "utf8").trim();
    return isRuntimeBuildId(value) ? value : null;
  } catch {
    return null;
  }
}

// Capture once from this process's own compiled artifact directory. Never follow a machine-current pointer.
const capturedRuntimeBuildId = readBuildId(import.meta.url);

export function getRuntimeBuildId(): string | null {
  return capturedRuntimeBuildId;
}
