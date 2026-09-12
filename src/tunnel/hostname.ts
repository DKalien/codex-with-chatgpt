import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";

/** DNS-safe label from a workspace name. Non-ASCII names fall back to the id. */
export function hostnameSlug(workspaceName: string, workspaceId: string): string {
  const ascii = workspaceName
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const label = ascii || `ws-${workspaceId.slice(0, 8)}`;
  return `c2c-${label}`;
}

export function suggestedNamedHostname(
  zone: string,
  workspaceName: string,
  workspaceId: string
): string {
  const zoneHost = normalizeNamedTunnelHostname(zone);
  return `${hostnameSlug(workspaceName, workspaceId)}.${zoneHost}`;
}

/** Return the workspace-unique hostname used by strict named migration. */
export function uniqueNamedHostname(zone: string, workspaceId: string): string {
  const normalizedId = workspaceId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,58}$/.test(normalizedId)) {
    throw new Error("Invalid workspace id for a named tunnel hostname");
  }
  const zoneHost = normalizeNamedTunnelHostname(zone);
  return `c2c-${normalizedId}.${zoneHost}`;
}

export function parseZoneInput(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed) return null;
  try {
    return normalizeNamedTunnelHostname(trimmed);
  } catch {
    return null;
  }
}
