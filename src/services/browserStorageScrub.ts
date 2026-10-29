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
import type { EnclaveAsset } from '../types/telemetry';
import { isDemoSeedAsset } from '../data/telemetry/assetRegistry';

export const ASSESSMENT_KEY_PREFIX = 'pbc_cmmc_assessment_v3_';
export const ENCLAVE_ASSETS_KEY_PREFIX = 'pbc_enclave_assets_v1_';
export const ACCRETION_CONFIG_KEY_PREFIX = 'pbc_accretion_cfg_v1_';
export const LEGACY_ASSESSMENT_KEY_PREFIX = 'pbc_assessment_';
export const LEDGER_KEY_PREFIX = 'pbc_audit_ledger_';
export const FLEET_KEY_PREFIX = 'pbc_enclave_fleet_v1_';
export const TENANT_REGISTRY_KEYS = ['pbc_live_tenants_v4', 'pbc_tenants_registry_v3'];

/** The slice of the Storage interface the scrub needs (a Map-backed fake satisfies it in tests). */
export interface ScrubStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserStorageScrubResult {
  scrubbed: number;
  narrativesRemoved: number;
  evidenceItemsCleared: number;
  keptBrowserOnly: number;
  malformed: number;
  failed: number;
  registryUnreadable: boolean;
  ledgersRedacted: number;
  ledgerEntriesRedacted: number;
  accretionKeysRemoved: number;
  assetListsRemoved: number;
  assetListsKept: number;
  registryEntriesStripped: number;
  fleetCachesRemoved: number;
  failingAssetListsCleared: number;
}

/** Tenant registry text a server tenant keeps on the server only (the browser copy holds it for browser-only tenants). */
export const SERVER_TENANT_TEXT_FIELDS = ['systemName', 'systemOwner', 'industry'] as const;

/**
 * Returns a copy of the tenant list where every server-backed entry has its server-held text fields blanked ('' because
 * the Tenant type requires strings). Browser-only entries are untouched. Never mutates the input; idempotent.
 */
export function stripTenantRegistryForCache<T extends { serverBacked?: boolean }>(list: ReadonlyArray<T>): T[] {
  return list.map((tenant) => {
    if (!tenant || typeof tenant !== 'object' || tenant.serverBacked !== true) return tenant;
    const record = tenant as unknown as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const field of SERVER_TENANT_TEXT_FIELDS) {
      if (field in record && record[field] !== '' && record[field] != null) {
        if (!copy) copy = { ...record };
        copy[field] = '';
      }
    }
    return copy ? (copy as unknown as T) : tenant;
  });
}

/** Returns a copy of the state with an empty evidence list: a server tenant's live list replaces it. Never mutates the input. */
export function stripEvidenceIndexForCache(state: AssessmentState): AssessmentState {
  return { ...state, evidenceIndex: [] };
}

function isDemoOnlyAssetList(list: unknown[], tenantId: string): boolean {
  return list.every(
    (item) => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && isDemoSeedAsset(item as { id: string }, tenantId)
  );
}

const normalizeHost = (h: unknown): string => (typeof h === 'string' ? h.trim().toLowerCase() : '');

/** Same rule as server/vm/assetMatch.ts normalizeMac: separator- and case-insensitive; empty for a missing or all-zero MAC. */
function normalizeMac(mac: unknown): string {
  const m = (typeof mac === 'string' ? mac : '').replace(/[:.\-\s]/g, '').toLowerCase();
  return m === '' || /^0+$/.test(m) ? '' : m;
}

/**
 * Decides whether a browser-local asset list of a server tenant can be dropped: only when every real (non demo-seed)
 * local asset has a match on the server (equal host name, or equal MAC). `unmatched` counts those without a match.
 */
export function planLocalAssetCleanup(
  local: ReadonlyArray<EnclaveAsset>,
  server: ReadonlyArray<EnclaveAsset>,
  tenantId: string
): { removable: boolean; unmatched: number } {
  const unmatched = unmatchedLocalAssets(local, server, tenantId).length;
  return { removable: unmatched === 0, unmatched };
}

/** The real (non demo-seed) local assets with no match on the server (equal host name, or equal MAC). */
export function unmatchedLocalAssets(
  local: ReadonlyArray<EnclaveAsset>,
  server: ReadonlyArray<EnclaveAsset>,
  tenantId: string
): EnclaveAsset[] {
  const hosts = new Set<string>();
  const macs = new Set<string>();
  for (const s of server) {
    const h = normalizeHost(s?.hostName);
    if (h) hosts.add(h);
    const m = normalizeMac(s?.macAddress);
    if (m) macs.add(m);
  }
  const unmatched: EnclaveAsset[] = [];
  for (const asset of local) {
    if (asset && typeof asset.id === 'string' && isDemoSeedAsset(asset, tenantId)) continue;
    const h = normalizeHost(asset?.hostName);
    const m = normalizeMac(asset?.macAddress);
    if ((h && hosts.has(h)) || (m && macs.has(m))) continue;
    unmatched.push(asset);
  }
  return unmatched;
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

/** Returns a copy of the state with `failingAssets` (host names, IPs, scan output) removed from every control. Never mutates the input. */
export function stripFailingAssetsForCache(state: AssessmentState): AssessmentState {
  const controls: Record<string, any> = {};
  for (const [id, control] of Object.entries(state.controls || {})) {
    const copy: Record<string, unknown> = { ...(control as unknown as Record<string, unknown>) };
    delete copy.failingAssets;
    controls[id] = copy;
  }
  return { ...state, controls };
}

/**
 * Returns a copy of the state without objective `implementationNarrative` (possible CUI), except for ids in
 * `objectivesPendingReview`. A no-op (same object) until `objectivesMigratedAt` is set: before the server holds the
 * narratives, the cache is their only copy. Never mutates the input.
 */
export function stripObjectiveNarrativesForCache(state: AssessmentState): AssessmentState {
  if (!state.objectivesMigratedAt || !state.objectives) return state;
  const pending = new Set(Array.isArray(state.objectivesPendingReview) ? state.objectivesPendingReview : []);
  const objectives: Record<string, any> = {};
  for (const [id, objective] of Object.entries(state.objectives)) {
    if (pending.has(id) || !objective || typeof objective !== 'object') {
      objectives[id] = objective;
      continue;
    }
    const copy: Record<string, unknown> = { ...(objective as unknown as Record<string, unknown>) };
    delete copy.implementationNarrative;
    objectives[id] = copy;
  }
  return { ...state, objectives };
}

/** Strips notes (and, once migrated, objective narratives) from a stored assessment JSON string. Never throws; returns the same string when unchanged. */
export function scrubAssessmentJson(raw: string, options: { clearEvidence?: boolean } = {}): {
  changed: boolean;
  json: string | null;
  strippedControls: number;
  strippedObjectives: number;
  clearedEvidence: number;
  clearedFailingAssets: number;
  malformed?: boolean;
} {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.controls || typeof parsed.controls !== 'object') {
      return { changed: false, json: null, strippedControls: 0, strippedObjectives: 0, clearedEvidence: 0, clearedFailingAssets: 0, malformed: true };
    }
    let stripped = 0;
    for (const control of Object.values(parsed.controls as Record<string, unknown>)) {
      if (control && typeof control === 'object' && 'implementationNotes' in (control as object)) {
        delete (control as Record<string, unknown>).implementationNotes;
        stripped++;
      }
    }
    // Objective narratives go only once the client has marked them as uploaded; ids under review keep theirs.
    let strippedObjectives = 0;
    if (parsed.objectivesMigratedAt && parsed.objectives && typeof parsed.objectives === 'object') {
      const pending = new Set<unknown>(Array.isArray(parsed.objectivesPendingReview) ? parsed.objectivesPendingReview : []);
      for (const [id, objective] of Object.entries(parsed.objectives as Record<string, unknown>)) {
        if (pending.has(id)) continue;
        if (objective && typeof objective === 'object' && 'implementationNarrative' in (objective as object)) {
          delete (objective as Record<string, unknown>).implementationNarrative;
          strippedObjectives++;
        }
      }
    }
    // The evidence list (file names, descriptions) is server-only for a live tenant. Cleared only for a registered server
    // tenant: an unregistered id may be a failed move's leftover whose files never reached the server (#83).
    let clearedEvidence = 0;
    if (options.clearEvidence !== false && Array.isArray(parsed.evidenceIndex) && parsed.evidenceIndex.length > 0) {
      clearedEvidence = parsed.evidenceIndex.length;
      parsed.evidenceIndex = [];
    }
    // Failing-asset lists (host names, IPs, scan output) are session-only for a live tenant: same condition as the evidence.
    let clearedFailingAssets = 0;
    if (options.clearEvidence !== false) {
      for (const control of Object.values(parsed.controls as Record<string, unknown>)) {
        if (control && typeof control === 'object' && 'failingAssets' in (control as object)) {
          delete (control as Record<string, unknown>).failingAssets;
          clearedFailingAssets++;
        }
      }
    }
    if (stripped === 0 && strippedObjectives === 0 && clearedEvidence === 0 && clearedFailingAssets === 0) {
      return { changed: false, json: raw, strippedControls: 0, strippedObjectives: 0, clearedEvidence: 0, clearedFailingAssets: 0 };
    }
    return { changed: true, json: JSON.stringify(parsed), strippedControls: stripped, strippedObjectives, clearedEvidence, clearedFailingAssets };
  } catch {
    return { changed: false, json: null, strippedControls: 0, strippedObjectives: 0, clearedEvidence: 0, clearedFailingAssets: 0, malformed: true };
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

/** Ids of browser-only and of server-backed tenants (plus the registry key and list), or null when no registry key holds a readable array. */
function readRegistryIds(
  storage: ScrubStorage
): { browserOnly: Set<string>; serverBacked: Set<string>; key: string; list: unknown[] } | null {
  for (const registryKey of TENANT_REGISTRY_KEYS) {
    try {
      const raw = storage.getItem(registryKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const browserOnly = new Set<string>();
      const serverBacked = new Set<string>();
      for (const t of parsed) {
        if (t && typeof t === 'object' && typeof t.id === 'string') (t.serverBacked !== true ? browserOnly : serverBacked).add(t.id);
      }
      return { browserOnly, serverBacked, key: registryKey, list: parsed };
    } catch {
      // try the next registry key
    }
  }
  return null;
}

function emptyResult(): BrowserStorageScrubResult {
  return {
    scrubbed: 0,
    narrativesRemoved: 0,
    evidenceItemsCleared: 0,
    keptBrowserOnly: 0,
    malformed: 0,
    failed: 0,
    registryUnreadable: false,
    ledgersRedacted: 0,
    ledgerEntriesRedacted: 0,
    accretionKeysRemoved: 0,
    assetListsRemoved: 0,
    assetListsKept: 0,
    registryEntriesStripped: 0,
    fleetCachesRemoved: 0,
    failingAssetListsCleared: 0,
  };
}

function logCounts(r: BrowserStorageScrubResult, log: (message: string) => void): void {
  if (r.scrubbed + r.malformed + r.ledgersRedacted + r.accretionKeysRemoved + r.assetListsRemoved + r.registryEntriesStripped + r.fleetCachesRemoved + r.failingAssetListsCleared === 0) return;
  log(
    `[storage-scrub] assessments scrubbed ${r.scrubbed} (${r.narrativesRemoved} objective narratives, ${r.evidenceItemsCleared} evidence items), kept browser-only ${r.keptBrowserOnly}, malformed ${r.malformed}, ` +
      `ledgers redacted ${r.ledgersRedacted} (${r.ledgerEntriesRedacted} entries), ` +
      `accretion keys removed ${r.accretionKeysRemoved}, asset lists removed ${r.assetListsRemoved} (kept ${r.assetListsKept}), registry entries stripped ${r.registryEntriesStripped}, ` +
      `fleet caches removed ${r.fleetCachesRemoved}, failing-asset lists cleared ${r.failingAssetListsCleared}`
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
  // Discovery-tool settings hold a secret and live on the server now: removed even when the registry cannot be read.
  for (const key of keys) {
    if (!key.startsWith(ACCRETION_CONFIG_KEY_PREFIX)) continue;
    try {
      storage.removeItem(key);
      result.accretionKeysRemoved++;
    } catch {
      result.failed++;
    }
  }
  const registry = readRegistryIds(storage);
  if (!registry) {
    result.registryUnreadable = true;
    if (log) logCounts(result, log);
    return result;
  }
  const { browserOnly, serverBacked } = registry;
  // Server tenants keep their descriptive text on the server; rewrite the registry only when something changes.
  try {
    const stripped = stripTenantRegistryForCache(registry.list as Array<{ serverBacked?: boolean }>);
    const changedCount = stripped.filter((entry, i) => entry !== registry.list[i]).length;
    if (changedCount > 0) {
      storage.setItem(registry.key, JSON.stringify(stripped));
      result.registryEntriesStripped = changedCount;
    }
  } catch {
    result.failed++;
  }
  // A server tenant's browser-local asset list goes when it is empty or only the old demo fleet; real assets stay
  // until the asset hook has confirmed the server holds them.
  for (const key of keys) {
    if (!key.startsWith(ENCLAVE_ASSETS_KEY_PREFIX)) continue;
    const id = key.slice(ENCLAVE_ASSETS_KEY_PREFIX.length);
    if (!serverBacked.has(id)) continue;
    try {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) continue;
      if (isDemoOnlyAssetList(list, id)) {
        storage.removeItem(key);
        result.assetListsRemoved++;
      } else {
        result.assetListsKept++;
      }
    } catch {
      // unreadable value: left alone
    }
  }
  // A server tenant's fleet scan data (host names, IPs, scan output) is session-only: any browser copy goes.
  for (const key of keys) {
    if (!key.startsWith(FLEET_KEY_PREFIX)) continue;
    if (!serverBacked.has(key.slice(FLEET_KEY_PREFIX.length))) continue;
    try {
      storage.removeItem(key);
      result.fleetCachesRemoved++;
    } catch {
      result.failed++;
    }
  }
  for (const key of keys) {
    const prefix = key.startsWith(ASSESSMENT_KEY_PREFIX)
      ? ASSESSMENT_KEY_PREFIX
      : key.startsWith(LEGACY_ASSESSMENT_KEY_PREFIX)
        ? LEGACY_ASSESSMENT_KEY_PREFIX
        : null;
    if (!prefix) continue;
    try {
      const id = key.slice(prefix.length);
      if (browserOnly.has(id)) {
        result.keptBrowserOnly++;
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      // A program's cache key is `<tenant>::<program>` (server tenants only)
      const scrub = scrubAssessmentJson(raw, { clearEvidence: serverBacked.has(id.split('::')[0]) });
      if (scrub.malformed) {
        result.malformed++;
      } else if (scrub.changed && scrub.json !== null) {
        storage.setItem(key, scrub.json);
        result.scrubbed++;
        result.narrativesRemoved += scrub.strippedObjectives;
        result.evidenceItemsCleared += scrub.clearedEvidence;
        result.failingAssetListsCleared += scrub.clearedFailingAssets;
      }
    } catch {
      result.failed++;
    }
  }
  if (log) logCounts(result, log);
  return result;
}

/** ASYNC part: redacts notes excerpts and identifiers in the browser audit ledgers (re-chaining needs hashing). */
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
      let out = await redactLedgerNotesExcerpts(parsed as AuditLogEntry[]);
      if (out.redacted > 0) {
        // Compare-and-set: redacting awaits hashing, so another tab may have appended meanwhile. Re-read before
        // writing and redact the fresh ledger again (up to 3 attempts) instead of overwriting the new entries.
        let current = raw;
        let written = false;
        for (let attempt = 0; attempt < 3 && !written; attempt++) {
          const latest = storage.getItem(key);
          if (latest === current) {
            storage.setItem(key, JSON.stringify(out.entries));
            written = true;
            break;
          }
          let reparsed: unknown;
          try {
            reparsed = latest === null ? null : JSON.parse(latest);
          } catch {
            reparsed = null;
          }
          if (!Array.isArray(reparsed)) break;
          current = latest as string;
          out = await redactLedgerNotesExcerpts(reparsed as AuditLogEntry[]);
          if (out.redacted === 0) {
            written = true; // the fresh ledger needs nothing
            break;
          }
        }
        if (!written) {
          result.failed++;
          continue;
        }
        if (out.redacted > 0) {
          result.ledgersRedacted++;
          result.ledgerEntriesRedacted += out.redacted;
        }
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
