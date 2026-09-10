import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, writeSecureJson } from "../config/paths.js";

export const WRITE_PROBE_SCOPE = "probe.write";
export const WRITE_PROBE_LOCATION = "c2c-state/write-probe.json";
export const probeNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "nonce 必须为 1–128 个英文字母、数字、下划线或短横线");

const probeRecordSchema = z.object({
  nonce: probeNonceSchema,
  timestamp: z.string().datetime(),
  workspaceId: z.string(),
  tool: z.literal("write_probe"),
});

export function isWriteProbeEnabled(): boolean {
  return process.env.C2C_ENABLE_WRITE_PROBE === "1";
}

export function writeProbe(workspaceId: string, nonce: string) {
  const record = { nonce: probeNonceSchema.parse(nonce), timestamp: new Date().toISOString(), workspaceId, tool: "write_probe" };
  writeSecureJson(path.join(getStateDir(), "write-probe.json"), record);
  return { ok: true, nonce: record.nonce, written: true, timestamp: record.timestamp, location: WRITE_PROBE_LOCATION };
}

/** 只读取固定状态文件；不存在时不创建目录或文件。 */
export function readWriteProbeStatus() {
  const file = path.join(getStateDir(), "write-probe.json");
  try {
    const record = probeRecordSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return { exists: true, ...record, location: WRITE_PROBE_LOCATION };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, nonce: null, timestamp: null, workspaceId: null, location: WRITE_PROBE_LOCATION };
    }
    throw new Error(`无法读取 ${WRITE_PROBE_LOCATION}：文件损坏或不可访问。`);
  }
}
