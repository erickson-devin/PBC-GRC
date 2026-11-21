import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import { validateAssignmentBatch } from '../data/assignments/assignmentSchema';
import type { Assignment, AssignmentChange } from '../types/assignments';

/** 'unsupported': an organization stored only in this browser (assignments live on the server); 'no_program': the organization has no open program. */
export type AssignmentsStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error';

export interface UseAssignments {
  supported: boolean;
  status: AssignmentsStatus;
  /** Every assignment of the program, keyed by `assignmentKey` (`${targetKind}|${targetId}|${duty}`). One map per program, shared by every mounted instance. */
  byKey: ReadonlyMap<string, Assignment>;
  /**
   * Sends the changes as one all-or-nothing batch (at most 500; the server enforces the write role and archived programs). Resolves when the server has
   * applied every item; rejects with the ApiError unchanged and applies nothing locally: `reason` 'stale_write' (someone else changed an item: `index`
   * names it; the store has been reloaded first), 'target_not_in_program', 'reviewer_only_for_sections', 'assignee_not_member', 'team_not_found',
   * 'program_archived', 'invalid', or 429 'limit'.
   */
  save: (items: AssignmentChange[]) => Promise<void>;
  reload: () => Promise<void>;
}

export const assignmentKey = (a: { targetKind: string; targetId: string; duty: string }): string => `${a.targetKind}|${a.targetId}|${a.duty}`;

interface Entry {
  readonly status: 'loading' | 'ready' | 'error';
  readonly byKey: ReadonlyMap<string, Assignment>;
}

const BLANK: Entry = { status: 'loading', byKey: new Map<string, Assignment>() };
const NO_MAP: ReadonlyMap<string, Assignment> = new Map<string, Assignment>();

// One entry per organization and program in memory, shared by every mounted instance (the assign menus, the checklist, the SSP builder): one fetch and
// one answer to a save. Never written to browser storage.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const watchers = new Map<string, number>();
const loadSeq = new Map<string, number>();
/** Counts the saves of a scope: a list fetched before a save finished is older than the save's answer and is dropped. */
const writeSeq = new Map<string, number>();
const chains = new Map<string, Promise<unknown>>();

const scopeOf = (tenantId: string, programId: string): string => `${tenantId}::${programId}`;
const entryOf = (scope: string): Entry => entries.get(scope) ?? BLANK;
function setEntry(scope: string, entry: Entry): void {
  entries.set(scope, entry);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function load(tenantId: string, programId: string): Promise<void> {
  const scope = scopeOf(tenantId, programId);
  const request = (loadSeq.get(scope) ?? 0) + 1;
  loadSeq.set(scope, request);
  const writes = writeSeq.get(scope) ?? 0;
  try {
    const rows = await ApiClient.listAssignments(tenantId, programId);
    if (loadSeq.get(scope) !== request || (writeSeq.get(scope) ?? 0) !== writes) return;
    setEntry(scope, { status: 'ready', byKey: new Map(rows.map((a) => [assignmentKey(a), a])) });
  } catch {
    if (loadSeq.get(scope) !== request) return;
    setEntry(scope, { status: 'error', byKey: entryOf(scope).byKey });
  }
}

/** Marks every loaded program of the organization out of date (a team was deleted with its assignments): shown programs reload now, the others when next shown. */
export function invalidateAssignments(tenantId: string): void {
  for (const scope of new Set([...entries.keys(), ...watchers.keys()])) {
    const at = scope.indexOf('::');
    if (scope.slice(0, at) !== tenantId) continue;
    if ((watchers.get(scope) ?? 0) > 0) void load(tenantId, scope.slice(at + 2));
    else entries.delete(scope);
  }
  listeners.forEach((l) => l());
}

const isRefresh = (err: unknown): boolean => {
  const e = err as { status?: unknown; reason?: unknown } | null;
  return (e?.status === 409 && e.reason === 'stale_write') || (e?.status === 404 && e.reason === 'team_not_found');
};

/**
 * The active program's assignments (#253): who owns each control, objective and SSP section, and who is the reviewer of a signable section. A label only:
 * it grants nothing. Server-backed organizations only; React state only (memory), shared by every mounted instance. A write is one all-or-nothing batch
 * with the value the caller saw for each item (`expectedAssignee`), so a change made by someone else is refused, not overwritten.
 */
export function useAssignments(): UseAssignments {
  const { currentTenant, activeProgram, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const programId = activeProgram?.id ?? null;
  const live = supported && programId !== null;

  const getSnapshot = useCallback((): Entry => (live && programId ? entryOf(scopeOf(tenantId, programId)) : BLANK), [live, tenantId, programId]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The first screen to show a program's assignments (re)loads them; the others share the answer
  useEffect(() => {
    if (!live || !programId) return undefined;
    const scope = scopeOf(tenantId, programId);
    const first = (watchers.get(scope) ?? 0) === 0;
    watchers.set(scope, (watchers.get(scope) ?? 0) + 1);
    if (first || entryOf(scope).status === 'error') void load(tenantId, programId);
    return () => {
      const n = (watchers.get(scope) ?? 1) - 1;
      if (n <= 0) watchers.delete(scope);
      else watchers.set(scope, n);
    };
  }, [live, tenantId, programId]);

  const reload = useCallback(async (): Promise<void> => {
    if (live && programId) await load(tenantId, programId);
  }, [live, tenantId, programId]);

  const save = useCallback(async (items: AssignmentChange[]): Promise<void> => {
    if (!live || !programId) throw new ApiError(400, 'Assignments need a server-backed organization with an open program.');
    const checked = validateAssignmentBatch({ items });
    if (!checked.ok) {
      const err = new ApiError(400, 'The assignments are invalid.');
      err.reason = 'invalid';
      err.field = checked.field;
      if (checked.index !== null) err.index = checked.index;
      throw err;
    }
    const scope = scopeOf(tenantId, programId);
    // Saves of a program go one after another, so each one's expectation is the previous one's result
    const run = async (): Promise<void> => {
      try {
        const result = await ApiClient.putAssignments(tenantId, checked.items, programId);
        writeSeq.set(scope, (writeSeq.get(scope) ?? 0) + 1);
        const next = new Map(entryOf(scope).byKey);
        for (const item of checked.items) if (item.assignee === null) next.delete(assignmentKey(item));
        for (const row of result.assignments) next.set(assignmentKey(row), row);
        setEntry(scope, { status: 'ready', byKey: next });
      } catch (err: unknown) {
        if (isRefresh(err)) await load(tenantId, programId);
        throw err;
      }
    };
    const previous = chains.get(scope) ?? Promise.resolve();
    const mine = previous.then(run, run);
    chains.set(scope, mine.catch(() => undefined));
    await mine;
  }, [live, tenantId, programId]);

  const status: AssignmentsStatus = !supported ? 'unsupported' : programId === null ? 'no_program' : entry.status;
  return useMemo<UseAssignments>(() => ({ supported, status, byKey: live ? entry.byKey : NO_MAP, save, reload }), [supported, status, live, entry.byKey, save, reload]);
}
