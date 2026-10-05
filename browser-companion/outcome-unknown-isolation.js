import { parseChatgptConversationRoute } from "./route-esm.js";
import { validateSendJournalShape } from "./reservation-journal.js";

export const OUTCOME_UNKNOWN_ARCHIVE_VERSION = 1;
export const OUTCOME_UNKNOWN_ARCHIVE_MAX_ENTRIES = 32;
export const OUTCOME_UNKNOWN_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARCHIVE_JOURNAL_KEYS = new Set([
  "state", "eventId", "reservationId", "attemptId", "routeCanonical", "bindingId", "epoch",
  "message", "messageSha256", "createdAt", "updatedAt", "terminalWitness",
]);
const TARGET_KEYS = ["routeCanonical", "eventId", "reservationId", "attemptId", "messageSha256"];

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonicalRoute(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    return parseChatgptConversationRoute(value, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    }).canonical === value;
  } catch {
    return false;
  }
}

function isoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validUnknownJournal(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)
    || Object.keys(journal).some(key => !ARCHIVE_JOURNAL_KEYS.has(key))
    || journal.state !== "OUTCOME_UNKNOWN"
    || validateSendJournalShape(journal).ok !== true
    || !canonicalRoute(journal.routeCanonical)
    || !HEX32.test(journal.eventId ?? "")
    || !UUID.test(journal.reservationId ?? "")
    || !UUID.test(journal.attemptId ?? "")
    || typeof journal.message !== "string" || journal.message.length === 0 || journal.message.length > 65_536
    || !HEX64.test(journal.messageSha256 ?? "")) return false;
  if (journal.createdAt != null && !isoTimestamp(journal.createdAt)) return false;
  if (journal.updatedAt != null && !isoTimestamp(journal.updatedAt)) return false;
  if (journal.terminalWitness !== undefined
    && (typeof journal.terminalWitness !== "string" || journal.terminalWitness.length === 0 || journal.terminalWitness.length > 4096)) return false;
  return true;
}

function targetOf(journal) {
  return Object.fromEntries(TARGET_KEYS.map(key => [key, journal[key]]));
}

export function sameIsolationTarget(a, b) {
  return Boolean(a && b && TARGET_KEYS.every(key => a[key] === b[key]));
}

export function emptyOutcomeUnknownArchive() {
  return { version: OUTCOME_UNKNOWN_ARCHIVE_VERSION, entries: [] };
}

/** Missing storage means empty; malformed, oversized or unknown data fails closed. */
export function parseOutcomeUnknownArchive(value) {
  if (value == null) return { ok: true, archive: emptyOutcomeUnknownArchive() };
  if (!hasExactKeys(value, ["version", "entries"]) || value.version !== OUTCOME_UNKNOWN_ARCHIVE_VERSION
    || !Array.isArray(value.entries) || value.entries.length > OUTCOME_UNKNOWN_ARCHIVE_MAX_ENTRIES) {
    return { ok: false, reason: "isolation_archive_invalid" };
  }
  const seen = new Set();
  for (const entry of value.entries) {
    if (!hasExactKeys(entry, ["journal", "status", "archivedAt", "isolatedAt", "terminalGoneAt"])
      || !validUnknownJournal(entry.journal)
      || !["pending", "isolated", "terminal_gone"].includes(entry.status)
      || !isoTimestamp(entry.archivedAt)
      || (entry.status === "pending" && (entry.isolatedAt !== null || entry.terminalGoneAt !== null))
      || (entry.status === "isolated" && (!isoTimestamp(entry.isolatedAt) || entry.terminalGoneAt !== null))
      || (entry.status === "terminal_gone" && (entry.isolatedAt !== null || !isoTimestamp(entry.terminalGoneAt)))) {
      return { ok: false, reason: "isolation_archive_invalid" };
    }
    const key = `${entry.journal.eventId}:${entry.journal.attemptId}`;
    if (seen.has(key)) return { ok: false, reason: "isolation_archive_duplicate" };
    seen.add(key);
  }
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return { ok: false, reason: "isolation_archive_invalid" }; }
  if (bytes > OUTCOME_UNKNOWN_ARCHIVE_MAX_BYTES) return { ok: false, reason: "isolation_archive_too_large" };
  return { ok: true, archive: value };
}

export function findOutcomeUnknownArchiveEntry(archive, journal) {
  if (!Array.isArray(archive?.entries) || !journal?.eventId || !journal?.attemptId) return null;
  const entry = archive.entries.find(item => item?.journal?.eventId === journal.eventId
    && item?.journal?.attemptId === journal.attemptId);
  if (!entry || !validUnknownJournal(journal) || !sameIsolationTarget(targetOf(entry.journal), targetOf(journal))) return null;
  const archivedKeys = Object.keys(entry.journal);
  const journalKeys = Object.keys(journal);
  return archivedKeys.length === journalKeys.length
    && archivedKeys.every(key => Object.hasOwn(journal, key) && entry.journal[key] === journal[key])
    ? entry : null;
}

export function appendOutcomeUnknownArchive(archive, journal, archivedAt = new Date().toISOString()) {
  const parsed = parseOutcomeUnknownArchive(archive);
  if (!parsed.ok || !validUnknownJournal(journal) || !isoTimestamp(archivedAt)) {
    return { ok: false, reason: parsed.reason || "isolation_journal_invalid" };
  }
  const existing = parsed.archive.entries.find(item => item.journal.eventId === journal.eventId
    && item.journal.attemptId === journal.attemptId);
  if (existing) {
    if (!findOutcomeUnknownArchiveEntry(parsed.archive, journal)) {
      return { ok: false, reason: "isolation_archive_identity_conflict" };
    }
    return { ok: true, archive: parsed.archive, entry: existing, alreadyArchived: true };
  }
  if (parsed.archive.entries.length >= OUTCOME_UNKNOWN_ARCHIVE_MAX_ENTRIES) {
    return { ok: false, reason: "isolation_archive_full" };
  }
  const entry = {
    journal: { ...journal },
    status: "pending",
    archivedAt,
    isolatedAt: null,
    terminalGoneAt: null,
  };
  const next = { version: OUTCOME_UNKNOWN_ARCHIVE_VERSION, entries: [...parsed.archive.entries, entry] };
  if (parseOutcomeUnknownArchive(next).ok !== true) return { ok: false, reason: "isolation_archive_too_large" };
  return { ok: true, archive: next, entry, alreadyArchived: false };
}

export function markOutcomeUnknownArchiveIsolated(archive, journal, isolatedAt = new Date().toISOString()) {
  const parsed = parseOutcomeUnknownArchive(archive);
  if (!parsed.ok || !isoTimestamp(isolatedAt)) return { ok: false, reason: parsed.reason || "isolation_timestamp_invalid" };
  const entry = findOutcomeUnknownArchiveEntry(parsed.archive, journal);
  if (!entry) return { ok: false, reason: "isolation_archive_entry_missing" };
  if (entry.status === "terminal_gone") return { ok: false, reason: "isolation_archive_terminal_gone" };
  if (entry.status === "isolated") return { ok: true, archive: parsed.archive };
  const next = {
    version: OUTCOME_UNKNOWN_ARCHIVE_VERSION,
    entries: parsed.archive.entries.map(item => item === entry
      ? { ...item, status: "isolated", isolatedAt }
      : item),
  };
  const checked = parseOutcomeUnknownArchive(next);
  return checked.ok ? { ok: true, archive: checked.archive } : checked;
}

export function markOutcomeUnknownArchiveTerminalGone(archive, journal, terminalGoneAt = new Date().toISOString()) {
  const parsed = parseOutcomeUnknownArchive(archive);
  if (!parsed.ok || !isoTimestamp(terminalGoneAt)) return { ok: false, reason: parsed.reason || "terminal_gone_timestamp_invalid" };
  const entry = findOutcomeUnknownArchiveEntry(parsed.archive, journal);
  if (!entry) return { ok: false, reason: "isolation_archive_entry_missing" };
  if (entry.status === "isolated") return { ok: false, reason: "terminal_gone_archive_isolated" };
  if (entry.status === "terminal_gone") return { ok: true, archive: parsed.archive };
  const next = {
    version: OUTCOME_UNKNOWN_ARCHIVE_VERSION,
    entries: parsed.archive.entries.map(item => item === entry
      ? { ...item, status: "terminal_gone", terminalGoneAt }
      : item),
  };
  const checked = parseOutcomeUnknownArchive(next);
  return checked.ok ? { ok: true, archive: checked.archive } : checked;
}

/** /state has no message text in this bounded, exact isolated-attempt projection. */
export function parseServerIsolatedAttempts(value) {
  if (value === undefined) return { ok: true, attempts: [] };
  if (!Array.isArray(value) || value.length > 20) return { ok: false, reason: "isolated_attempts_invalid" };
  const attempts = [];
  for (const item of value) {
    if (!hasExactKeys(item, [...TARGET_KEYS, "isolated", "status"])
      || item.isolated !== true || !canonicalRoute(item.routeCanonical)
      || !HEX32.test(item.eventId ?? "")
      || !UUID.test(item.reservationId ?? "")
      || !UUID.test(item.attemptId ?? "")
      || !["outcome_unknown", "retired_unknown"].includes(item.status)
      || !HEX64.test(item.messageSha256 ?? "")) {
      return { ok: false, reason: "isolated_attempts_invalid" };
    }
    attempts.push(Object.freeze({ ...item }));
  }
  return { ok: true, attempts };
}

export function findServerIsolatedAttempt(attempts, journal) {
  return Array.isArray(attempts) ? attempts.find(item => item.isolated === true && sameIsolationTarget(item, journal)) ?? null : null;
}

/** Exact zero-mutation proof from the exact fresh owner; no network event is inferred here. */
export function hasSafeUnknownRecoveryProof(input) {
  const { journal, probe, owner, ownerExact, concurrentNativeProduction } = input || {};
  if (!validUnknownJournal(journal)
    || probe?.reason !== "outcome_unknown" || probe?.journalState !== "OUTCOME_UNKNOWN"
    || probe?.zeroWrite !== true || probe?.zeroClick !== true
    || probe?.ownerFresh !== true || probe?.composerEmpty !== true || probe?.generationIdle !== true
    || probe?.nativeProductionInFlight !== false || probe.routeCanonical !== journal.routeCanonical
    || !Number.isSafeInteger(probe.generation) || probe.generation !== owner?.generation
    || ownerExact !== true || concurrentNativeProduction !== false
    || !owner || !Number.isSafeInteger(owner.tabId) || typeof owner.documentId !== "string" || !owner.documentId
    || owner.canonicalRoute !== journal.routeCanonical) return false;
  return true;
}

/** Only a server-confirmed exact inFlight unknown may use the park transition. */
export function canParkOutcomeUnknown(input) {
  const { journal, inFlight } = input || {};
  return !!inFlight && inFlight.status === "outcome_unknown"
    && sameIsolationTarget(inFlight, journal) && hasSafeUnknownRecoveryProof(input);
}

export function validateIsolationResponse(body, journal) {
  const keys = [...TARGET_KEYS, "status", "isolated", "observed"];
  if (!hasExactKeys(body, keys) || !sameIsolationTarget(body, journal)
    || body.status !== "outcome_unknown" || body.isolated !== true || body.observed !== false) {
    return { ok: false, reason: "isolation_response_invalid" };
  }
  return { ok: true };
}

export function validateTerminalGoneResponse(body, journal) {
  const keys = ["routeCanonical", "eventId", "attemptId", "status"];
  if (!hasExactKeys(body, keys)
    || body.routeCanonical !== journal?.routeCanonical
    || body.eventId !== journal?.eventId
    || body.attemptId !== journal?.attemptId
    || !["terminal_gone", "still_present"].includes(body.status)) {
    return { ok: false, reason: "terminal_gone_response_invalid" };
  }
  return { ok: true, status: body.status };
}

/** Display-safe metadata only; message bodies stay in trusted local storage. */
export function summarizeOutcomeUnknownArchive(archive) {
  if (!Array.isArray(archive?.entries)) return { available: false, entries: [] };
  return {
    available: true,
    entries: archive.entries.map(({ journal, status, archivedAt, isolatedAt, terminalGoneAt }) => ({
      routeCanonical: journal.routeCanonical,
      eventId: journal.eventId,
      reservationId: journal.reservationId,
      attemptId: journal.attemptId,
      messageSha256: journal.messageSha256,
      status,
      archivedAt,
      isolatedAt,
      terminalGoneAt,
    })),
  };
}
