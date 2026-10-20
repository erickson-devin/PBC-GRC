/**
 * Browser-storage hygiene for implementation notes (Phase 5.6).
 *
 * Implementation notes may contain CUI. For server-backed tenants the server is the only home of notes, so the
 * localStorage assessment cache must never hold them. Browser-only tenants have no other copy, so their cache is
 * left untouched until they are moved to the server.
 *
 * Pure module: no React, no storageService (storageService imports from here). Every function is defensive and
 * never throws on bad stored data.
 */

import type { AssessmentState } from '../types/cmmc';
import { redactLedgerNotesExcerpts } from '../data/audit/auditLogger';
import type { AuditLogEntry } from '../types/audit';

export const ASSESSMENT_KEY_PREFIX = 'pbc_cmmc_assessment_v3_';
export const LEGACY_ASSESSMENT_KEY_PREFIX = 'pbc_assessment_';
export const LEDGER_KEY_PREFIX = 'pbc_audit_ledger_';
export const TENANT_REGISTRY_KEYS = ['pbc_live_tenants_v4', 'pbc_tenants_registry_v3'];

/** The slice of the Storage interface the scrub needs (a Map-backed fake satisfies it in tests). */
export interface ScrubStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserStorageScrubResult {
  scrubbed: number;
  keptBrowserOnly: number;
  malformed: number;
  failed: number;
  registryUnreadable: boolean;
  ledgersRedacted: number;
  ledgerEntriesRedacted: number;
}

/** Returns a copy of the state with `implementationNotes` removed from every control. Never mutates the input. */
export function stripImplementationNotesForCache(state: AssessmentState): AssessmentState {
  const controls: Record<string, any> = {};
  for (const [id, control] of Object.entries(state.controls || {})) {
    const copy: Record<string, unknown> = { ...(control as unknown as Record<string, unknown>) };
    delete copy.implementationNotes;
    controls[id] = copy;
  }
  return { ...state, controls };
}

/** Strips notes from a stored assessment JSON string. Never throws; returns the same string when unchanged. */
export function scrubAssessmentJson(raw: string): {
  changed: boolean;
  json: string | null;
  strippedControls: number;
  malformed?: boolean;
} {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.controls || typeof parsed.controls !== 'object') {
      return { changed: false, json: null, strippedControls: 0, malformed: true };
    }
    let stripped = 0;
    for (const control of Object.values(parsed.controls as Record<string, unknown>)) {
      if (control && typeof control === 'object' && 'implementationNotes' in (control as object)) {
        delete (control as Record<string, unknown>).implementationNotes;
        stripped++;
      }
    }
    if (stripped === 0) return { changed: false, json: raw, strippedControls: 0 };
    return { changed: true, json: JSON.stringify(parsed), strippedControls: stripped };
  } catch {
    return { changed: false, json: null, strippedControls: 0, malformed: true };
  }
}

export type NotesStatus = 'browser' | 'loading' | 'loaded' | 'unavailable';

/** Where a tenant's implementation notes currently come from, for the editors and the status line. */
export function computeNotesStatus(p: {
  serverBacked: boolean;
  liveControlsTenantId: string | null | undefined;
  tenantId: string;
  syncError: string | boolean | null | undefined;
  hasToken: boolean;
}): NotesStatus {
  if (!p.serverBacked) return 'browser';
  if (p.liveControlsTenantId === p.tenantId) return 'loaded';
  if (p.syncError || !p.hasToken) return 'unavailable';
  return 'loading';
}

function listKeys(storage: ScrubStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k) keys.push(k);
  }
  return keys;
}

/** Ids of tenants that are not server-backed, or null when no registry key holds a readable array. */
function readBrowserOnlyIds(storage: ScrubStorage): Set<string> | null {
  for (const registryKey of TENANT_REGISTRY_KEYS) {
    try {
      const raw = storage.getItem(registryKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const ids = new Set<string>();
      for (const t of parsed) {
        if (t && typeof t === 'object' && typeof t.id === 'string' && t.serverBacked !== true) ids.add(t.id);
      }
      return ids;
    } catch {
      // try the next registry key
    }
  }
  return null;
}

function emptyResult(): BrowserStorageScrubResult {
  return {
    scrubbed: 0,
    keptBrowserOnly: 0,
    malformed: 0,
    failed: 0,
    registryUnreadable: false,
    ledgersRedacted: 0,
    ledgerEntriesRedacted: 0,
  };
}

function logCounts(r: BrowserStorageScrubResult, log: (message: string) => void): void {
  if (r.scrubbed + r.malformed + r.ledgersRedacted === 0) return;
  log(
    `[storage-scrub] assessments scrubbed ${r.scrubbed}, kept browser-only ${r.keptBrowserOnly}, malformed ${r.malformed}, ` +
      `ledgers redacted ${r.ledgersRedacted} (${r.ledgerEntriesRedacted} entries)`
  );
}

/**
 * SYNCHRONOUS part of the scrub: removes cached implementation notes of server-backed tenants (every key with either
 * assessment prefix). Pure JSON work on purpose, so it completes before any provider can save. Idempotent. Browser-only
 * tenants are kept untouched; when the tenant registry cannot be read, nothing is scrubbed.
 */
export function runAssessmentCacheScrub(
  storage: ScrubStorage,
  log?: (message: string) => void
): BrowserStorageScrubResult {
  const result = emptyResult();
  let keys: string[];
  try {
    keys = listKeys(storage);
  } catch {
    result.failed++;
    return result;
  }
  const browserOnly = readBrowserOnlyIds(storage);
  if (!browserOnly) {
    result.registryUnreadable = true;
    return result;
  }
  for (const key of keys) {
    const prefix = key.startsWith(ASSESSMENT_KEY_PREFIX)
      ? ASSESSMENT_KEY_PREFIX
      : key.startsWith(LEGACY_ASSESSMENT_KEY_PREFIX)
        ? LEGACY_ASSESSMENT_KEY_PREFIX
        : null;
    if (!prefix) continue;
    try {
      if (browserOnly.has(key.slice(prefix.length))) {
        result.keptBrowserOnly++;
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const scrub = scrubAssessmentJson(raw);
      if (scrub.malformed) {
        result.malformed++;
      } else if (scrub.changed && scrub.json !== null) {
        storage.setItem(key, scrub.json);
        result.scrubbed++;
      }
    } catch {
      result.failed++;
    }
  }
  if (log) logCounts(result, log);
  return result;
}

/** ASYNC part: redacts old notes excerpts in the browser audit ledgers (re-chaining needs hashing). */
async function runLedgerScrub(storage: ScrubStorage, result: BrowserStorageScrubResult): Promise<void> {
  let keys: string[];
  try {
    keys = listKeys(storage).filter((k) => k.startsWith(LEDGER_KEY_PREFIX));
  } catch {
    result.failed++;
    return;
  }
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        result.malformed++;
        continue;
      }
      if (!Array.isArray(parsed)) {
        result.malformed++;
        continue;
      }
      const out = await redactLedgerNotesExcerpts(parsed as AuditLogEntry[]);
      if (out.redacted > 0) {
        storage.setItem(key, JSON.stringify(out.entries));
        result.ledgersRedacted++;
        result.ledgerEntriesRedacted += out.redacted;
      }
    } catch {
      result.failed++;
    }
  }
}

/**
 * Full start-up scrub. The assessment-cache part runs SYNCHRONOUSLY, before the first await, so calling this without
 * awaiting still finishes it before React mounts and any provider saves; only the ledger re-chaining is awaited.
 * Logs one line with counts only (never tenant ids or text) and only when something changed. No done marker: it is
 * idempotent and runs on every start (it also cleans up after an old tab).
 */
export async function runBrowserStorageScrub(
  storage: ScrubStorage,
  log: (message: string) => void = console.info
): Promise<BrowserStorageScrubResult> {
  const result = runAssessmentCacheScrub(storage);
  await runLedgerScrub(storage, result);
  logCounts(result, log);
  return result;
}
