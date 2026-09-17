/**
 * One-use owner proof for pairing (browser-safe).
 * Minted only from real MessageSender at SW; popup presents proof + secret;
 * secret never goes through content script.
 */

export const OWNER_PROOF_TTL_MS = 12_000;

/** @returns {{ id: string, tabId: number, documentId: string, routeCanonical: string, expiresAt: number, used: boolean }} */
export function mintOwnerProof(input) {
  const id = `op_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  return {
    id,
    tabId: input.tabId,
    documentId: input.documentId,
    routeCanonical: input.routeCanonical,
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? OWNER_PROOF_TTL_MS),
    used: false,
  };
}

/**
 * @param {object|null} proof
 * @param {{ tabId: number, documentId: string, routeCanonical: string, now?: number }} expect
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function consumeOwnerProof(proof, expect) {
  const now = expect.now ?? Date.now();
  if (!proof || typeof proof !== "object") return { ok: false, reason: "owner_proof_missing" };
  if (proof.used) return { ok: false, reason: "owner_proof_used" };
  if (!Number.isFinite(proof.expiresAt) || proof.expiresAt <= now) {
    return { ok: false, reason: "owner_proof_expired" };
  }
  if (proof.tabId !== expect.tabId || proof.documentId !== expect.documentId) {
    return { ok: false, reason: "owner_proof_document_mismatch" };
  }
  if (proof.routeCanonical !== expect.routeCanonical) {
    return { ok: false, reason: "owner_proof_route_mismatch" };
  }
  return { ok: true };
}

export function markProofUsed(proof) {
  return { ...proof, used: true };
}

/** Journal-active guards shared by pair / clear transport (includes E1b3 send-side states). */
export function journalBlocksTransportMutation(journal) {
  if (!journal || !journal.state || journal.state === "NONE") return false;
  return true;
}
