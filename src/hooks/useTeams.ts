import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import { invalidateAssignments } from './useAssignments';
import type { Team } from '../types/assignments';

/** 'unsupported': an organization stored only in this browser (teams live on the server). */
export type TeamsStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseTeams {
  supported: boolean;
  status: TeamsStatus;
  /** The organization's teams, shared by every mounted instance; `[]` until loaded and for a browser-only organization. */
  teams: Team[];
  reload: () => Promise<void>;
  /**
   * Every action rejects with the ApiError unchanged and, after a 404 or a 409 (`stale_write`, `not_found`), has reloaded the list first. The server
   * enforces the write role. `reason` values: 'invalid' (`field`), 'duplicate_name', 'limit' (429), 'not_a_member', 'invalid_member_ids', 'not_found',
   * 'stale_write', 'team_in_use' (`teamUse` holds the counts).
   */
  create: (input: { name: string; description?: string }) => Promise<Team>;
  /** Renames or re-describes a team; the stamp of the copy this screen holds is sent, so a change made by someone else is refused (409 stale_write). */
  update: (teamId: string, changes: { name?: string; description?: string }) => Promise<Team>;
  /** Adds and removes members (people with current access only). */
  setMembers: (teamId: string, change: { add?: string[]; remove?: string[] }) => Promise<Team>;
  /** The programs whose assignments name the team (archived ones included), for the "in use" message. */
  usage: (teamId: string) => Promise<{ programId: string; assignments: number }[]>;
  /** Deletes the team. 409 team_in_use (counts on `teamUse`) unless `force`, which removes the team's assignments in every program first. */
  remove: (teamId: string, force?: boolean) => Promise<void>;
}

interface Entry {
  readonly status: 'loading' | 'ready' | 'error';
  readonly teams: Team[];
}

const BLANK: Entry = { status: 'loading', teams: [] };
const NO_TEAMS: Team[] = [];

// One entry per organization in memory, shared by every mounted instance (the Teams section, the assign menus): never written to browser storage.
// A team name can be sensitive: it is never logged.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const watchers = new Map<string, number>();
const loadSeq = new Map<string, number>();
/** Counts the writes of an organization: a list fetched before a write finished is older than the write's answer and is dropped. */
const writeSeq = new Map<string, number>();

const entryOf = (tenantId: string): Entry => entries.get(tenantId) ?? BLANK;
function setEntry(tenantId: string, entry: Entry): void {
  entries.set(tenantId, entry);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function load(tenantId: string): Promise<void> {
  const request = (loadSeq.get(tenantId) ?? 0) + 1;
  loadSeq.set(tenantId, request);
  const writes = writeSeq.get(tenantId) ?? 0;
  try {
    const teams = await ApiClient.listTeams(tenantId);
    if (loadSeq.get(tenantId) !== request || (writeSeq.get(tenantId) ?? 0) !== writes) return;
    setEntry(tenantId, { status: 'ready', teams });
  } catch {
    if (loadSeq.get(tenantId) !== request) return;
    setEntry(tenantId, { status: 'error', teams: entryOf(tenantId).teams });
  }
}

const needsReload = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || status === 409;
};

/** Teams of the organization (#253): a named group of members that can be assigned a control, an objective or an SSP section. Server-backed organizations only. */
export function useTeams(): UseTeams {
  const { currentTenant, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';

  const getSnapshot = useCallback((): Entry => (supported ? entryOf(tenantId) : BLANK), [supported, tenantId]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The first screen to show the teams (re)loads them; the others share the answer
  useEffect(() => {
    if (!supported) return undefined;
    const first = (watchers.get(tenantId) ?? 0) === 0;
    watchers.set(tenantId, (watchers.get(tenantId) ?? 0) + 1);
    if (first || entryOf(tenantId).status === 'error') void load(tenantId);
    return () => {
      const n = (watchers.get(tenantId) ?? 1) - 1;
      if (n <= 0) watchers.delete(tenantId);
      else watchers.set(tenantId, n);
    };
  }, [supported, tenantId]);

  const reload = useCallback(async (): Promise<void> => {
    if (supported) await load(tenantId);
  }, [supported, tenantId]);

  const guarded = useCallback(
    async <T>(run: () => Promise<T>): Promise<T> => {
      if (!supported) throw new ApiError(400, 'Teams need a server-backed organization.');
      try {
        const result = await run();
        writeSeq.set(tenantId, (writeSeq.get(tenantId) ?? 0) + 1);
        return result;
      } catch (err: unknown) {
        if (needsReload(err)) await load(tenantId);
        throw err;
      }
    },
    [supported, tenantId]
  );
  const replace = (team: Team): void => {
    const current = entryOf(tenantId).teams;
    const has = current.some((t) => t.id === team.id);
    setEntry(tenantId, { status: 'ready', teams: has ? current.map((t) => (t.id === team.id ? team : t)) : [...current, team] });
  };
  const stampOf = (teamId: string): string => entryOf(tenantId).teams.find((t) => t.id === teamId)?.updatedAt ?? '';

  const create = useCallback(async (input: { name: string; description?: string }): Promise<Team> => {
    const team = await guarded(() => ApiClient.createTeam(tenantId, input));
    replace(team);
    return team;
  }, [guarded, tenantId]);
  const update = useCallback(async (teamId: string, changes: { name?: string; description?: string }): Promise<Team> => {
    const res = await guarded(() => ApiClient.updateTeam(tenantId, teamId, { ...changes, expectedUpdatedAt: stampOf(teamId) }));
    replace(res.team);
    return res.team;
  }, [guarded, tenantId]);
  const setMembers = useCallback(async (teamId: string, change: { add?: string[]; remove?: string[] }): Promise<Team> => {
    const res = await guarded(() => ApiClient.patchTeamMembers(tenantId, teamId, change));
    replace(res.team);
    return res.team;
  }, [guarded, tenantId]);
  const usage = useCallback((teamId: string) => guarded(() => ApiClient.getTeamUsage(tenantId, teamId)), [guarded, tenantId]);
  const remove = useCallback(async (teamId: string, force?: boolean): Promise<void> => {
    const res = await guarded(() => ApiClient.deleteTeam(tenantId, teamId, force));
    setEntry(tenantId, { status: 'ready', teams: entryOf(tenantId).teams.filter((t) => t.id !== teamId) });
    // The team's assignments went with it: every program's assignment list is out of date
    if (res.assignmentsRemoved > 0) invalidateAssignments(tenantId);
  }, [guarded, tenantId]);

  const status: TeamsStatus = !supported ? 'unsupported' : entry.status;
  return useMemo<UseTeams>(
    () => ({ supported, status, teams: supported ? entry.teams : NO_TEAMS, reload, create, update, setMembers, usage, remove }),
    [supported, status, entry.teams, reload, create, update, setMembers, usage, remove]
  );
}
