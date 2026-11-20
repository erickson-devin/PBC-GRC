// ---------------------------------------------------------------------------------------------- program summary store
// The counts the journey bar and the dashboard share (GET /program-summary: people, inventory and document inputs, sign-offs, POA&M dates). One entry per
// organization and program, held in memory only and shared by every mounted hook, so the bar and the dashboard cost one request. Nothing is written to
// browser storage and nothing is logged: the summary holds counts and ids, never notes or file names.
//
// What it summarises changes elsewhere, so the entry is marked stale (and fetched again when a screen is showing it) when:
//   - the Tools and Services register, a program's boundary or its data inventory changes (inventoryService);
//   - the document register or a program's documents change (documentService);
//   - anything calls invalidateProgramSummary (the member list, team changes, SSP sign-offs and POA&M saves have no notification of their own: the
//     hook refetches on a member-list change and on a tab change, and a screen that saves one of them may call the invalidate directly).

import { ApiClient } from './apiClient';
import { subscribeInventory } from './inventoryService';
import { subscribeDocuments } from './documentService';
import type { ProgramSummary } from '../types/programSummary';

export type ProgramSummaryStatus = 'loading' | 'ready' | 'error';

/** An entry is replaced, never edited, so it can be used as a snapshot. After a failed refresh the last good summary stays. */
export interface ProgramSummaryEntry {
  readonly status: ProgramSummaryStatus;
  readonly summary: ProgramSummary | null;
}

export const BLANK_PROGRAM_SUMMARY: ProgramSummaryEntry = { status: 'loading', summary: null };

const entries = new Map<string, ProgramSummaryEntry>();
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();
/** Counts the invalidations of a scope: a response that arrives after one is shown, then fetched again. */
const epochs = new Map<string, number>();
const stale = new Set<string>();
const watchers = new Map<string, number>();

export const programSummaryScope = (tenantId: string, programId: string): string => `${tenantId}::${programId}`;

export function getProgramSummaryEntry(tenantId: string, programId: string): ProgramSummaryEntry {
  return entries.get(programSummaryScope(tenantId, programId)) ?? BLANK_PROGRAM_SUMMARY;
}

export function subscribeProgramSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setEntry(scope: string, entry: ProgramSummaryEntry): void {
  entries.set(scope, entry);
  listeners.forEach((l) => l());
}

const splitScope = (scope: string): { tenantId: string; programId: string } => {
  const at = scope.indexOf('::');
  return { tenantId: scope.slice(0, at), programId: scope.slice(at + 2) };
};

/** Fetches the summary of a program (one request at a time per program). Never rejects: a failure shows as status 'error'. */
export function loadProgramSummary(tenantId: string, programId: string): Promise<void> {
  const scope = programSummaryScope(tenantId, programId);
  const running = loading.get(scope);
  if (running) return running;
  const epoch = epochs.get(scope) ?? 0;
  const run = ApiClient.getProgramSummary(tenantId, programId)
    .then((summary) => {
      if (summary.programId !== programId) throw new Error('mismatch');
      if ((epochs.get(scope) ?? 0) === epoch) stale.delete(scope);
      setEntry(scope, { status: 'ready', summary });
    })
    .catch(() => {
      setEntry(scope, { status: 'error', summary: entries.get(scope)?.summary ?? null });
    })
    .then(() => {
      loading.delete(scope);
      // Something it summarises changed while the request was on its way: ask again while a screen shows it
      if ((epochs.get(scope) ?? 0) !== epoch && (watchers.get(scope) ?? 0) > 0) void loadProgramSummary(tenantId, programId);
    });
  loading.set(scope, run);
  return run;
}

/**
 * Marks the summary of one program (or of every program of the organization when `programId` is null) out of date; programs a screen is showing are
 * fetched again at once, the others the next time a screen shows them.
 */
export function invalidateProgramSummary(tenantId: string, programId: string | null = null): void {
  for (const scope of new Set([...entries.keys(), ...watchers.keys()])) {
    const s = splitScope(scope);
    if (s.tenantId !== tenantId || (programId !== null && s.programId !== programId)) continue;
    epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
    stale.add(scope);
    if ((watchers.get(scope) ?? 0) > 0) void loadProgramSummary(s.tenantId, s.programId);
  }
}

/** Fetches again now, whatever the state (the hook's `reload`). */
export function reloadProgramSummary(tenantId: string, programId: string): Promise<void> {
  const scope = programSummaryScope(tenantId, programId);
  epochs.set(scope, (epochs.get(scope) ?? 0) + 1);
  stale.add(scope);
  return loadProgramSummary(tenantId, programId);
}

/** A screen starts showing the program's summary: loads it when there is none or it is out of date. Returns the stop function. */
export function watchProgramSummary(tenantId: string, programId: string): () => void {
  const scope = programSummaryScope(tenantId, programId);
  watchers.set(scope, (watchers.get(scope) ?? 0) + 1);
  const entry = entries.get(scope);
  if (!entry || entry.status === 'error' || stale.has(scope)) void loadProgramSummary(tenantId, programId);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const n = (watchers.get(scope) ?? 1) - 1;
    if (n <= 0) watchers.delete(scope);
    else watchers.set(scope, n);
  };
}

/** Forgets every summary (sign-out, organization switch). */
export function clearProgramSummaries(): void {
  entries.clear();
  stale.clear();
  listeners.forEach((l) => l());
}

// The things it summarises that already announce their changes (programId is null for an organization-wide change: every program of it)
subscribeInventory((change) => invalidateProgramSummary(change.tenantId, change.programId));
subscribeDocuments((change) => invalidateProgramSummary(change.tenantId, change.programId));
