import crypto from 'crypto';
import { nextStamp } from '../db';
import { matchesExpected, notesDigest, StaleWriteError } from '../controlAssessments';
import { inTenantTx, insertEventTx, isMemory, pushMemoryInventoryEvent, type EventFields, type InventoryActor } from '../inventory/events';
import { AssignmentError } from './assignmentsStore';
import { MAX_TEAMS_PER_TENANT, MAX_TEAM_MEMBERS, type Team } from '../../src/types/assignments';

/**
 * Teams (#253): named groups of members of one tenant, for assigning a control, an objective or an SSP section to a group instead of a person. Teams are
 * tenant-wide like tenant_users. A team's name and description may be sensitive: they are never logged, and the history (inventory_events, entity_kind
 * 'team') holds the SHA-256 and length of each text field only; member ids are recorded as values (they are ids, not names). Members are user ids with no
 * foreign key to tenant_users: a member who leaves stays listed until someone removes them (the readers show it), and an assignment stays too.
 *
 * PostgreSQL: both tables carry the tenant row policy, so every statement runs in a tenant transaction. The in-memory store never awaits between a check
 * and the write, so its writers are atomic on the event loop. The delete guard (team_in_use) lives in the route, which counts the assignments of every
 * program; this store only deletes the team and its members.
 */

interface MemoryTeam {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  members: Set<string>;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}
const memoryTeams = new Map<string, MemoryTeam>(); // key: team id

/** Test hook. */
export function __resetTeamsForTests(): void {
  memoryTeams.clear();
  limitOverride = null;
}

let limitOverride: number | null = null;
/** Test hook: lowers the teams allowed per tenant (null restores MAX_TEAMS_PER_TENANT). */
export function __setTeamLimitForTests(n: number | null): void {
  limitOverride = n;
}
const teamLimit = (): number => limitOverride ?? MAX_TEAMS_PER_TENANT;

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const sortIds = (ids: Iterable<string>): string[] => [...ids].sort();
const actorName = (who: InventoryActor): string => who.actor.slice(0, 255);
const lowerName = (s: string): string => s.toLowerCase();
/** Member ids kept per list in a history event (the counts are always exact). */
const MAX_EVENT_IDS = 50;

const duplicate = (): AssignmentError => new AssignmentError('duplicate_name', 'A team with this name already exists (names are compared ignoring case)');
const notFound = (): AssignmentError => new AssignmentError('not_found', 'Team not found');
const tooMany = (): AssignmentError => new AssignmentError('limit', 'This organization has reached the maximum number of teams');
const tooManyMembers = (): AssignmentError => new AssignmentError('limit', 'A team has at most the maximum number of members');

const viewOf = (t: MemoryTeam): Team => ({ id: t.id, name: t.name, description: t.description, memberIds: sortIds(t.members), createdAt: t.createdAt, updatedAt: t.updatedAt, updatedBy: t.updatedBy });
const memoryOf = (tenantId: string): MemoryTeam[] => [...memoryTeams.values()].filter((t) => t.tenantId === tenantId);

function teamFields(name: string | undefined, description: string | undefined): EventFields {
  const out: EventFields = {};
  if (name !== undefined) out.name = notesDigest(name);
  if (description !== undefined) out.description = notesDigest(description);
  return out;
}

// ------------------------------------------------------------------------------------------------ reads

async function loadTeams(tenantId: string, id?: string): Promise<Team[]> {
  return inTenantTx(tenantId, async (q) => {
    const teams = id === undefined
      ? await q('SELECT * FROM tenant_teams WHERE tenant_id = $1 ORDER BY lower(name), created_at LIMIT $2', [tenantId, MAX_TEAMS_PER_TENANT + 1])
      : await q('SELECT * FROM tenant_teams WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (teams.rows.length === 0) return [];
    const members = await q('SELECT team_id, user_id FROM tenant_team_members WHERE tenant_id = $1', [tenantId]);
    const byTeam = new Map<string, string[]>();
    for (const m of members.rows) byTeam.set(String(m.team_id), [...(byTeam.get(String(m.team_id)) ?? []), String(m.user_id)]);
    return teams.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: String(r.description ?? ''),
      memberIds: sortIds(byTeam.get(String(r.id)) ?? []),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      updatedBy: r.updated_by ?? null,
    }));
  });
}

/** The teams of the tenant, by name (at most MAX_TEAMS_PER_TENANT). */
export async function listTeams(tenantId: string): Promise<Team[]> {
  if (isMemory()) return memoryOf(tenantId).sort((a, b) => lowerName(a.name).localeCompare(lowerName(b.name)) || a.id.localeCompare(b.id)).map(viewOf);
  return loadTeams(tenantId);
}

/** One team of the tenant, or null (an id of another tenant is as unknown as a made-up one). */
export async function getTeam(tenantId: string, id: string): Promise<Team | null> {
  if (isMemory()) {
    const t = memoryTeams.get(id);
    return t && t.tenantId === tenantId ? viewOf(t) : null;
  }
  return (await loadTeams(tenantId, id))[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ writes

/** Adds a team with no members. Throws duplicate_name (names compared ignoring case) and limit. */
export async function createTeam(tenantId: string, input: { name: string; description?: string }, who: InventoryActor): Promise<Team> {
  const description = input.description ?? '';
  if (isMemory()) {
    const mine = memoryOf(tenantId);
    if (mine.some((t) => lowerName(t.name) === lowerName(input.name))) throw duplicate();
    if (mine.length >= teamLimit()) throw tooMany();
    const now = nextStamp(null);
    const team: MemoryTeam = { id: crypto.randomUUID(), tenantId, name: input.name, description, members: new Set(), createdAt: now, updatedAt: now, updatedBy: actorName(who) };
    memoryTeams.set(team.id, team);
    pushMemoryInventoryEvent(tenantId, 'team', team.id, 'created', who, teamFields(input.name, description));
    return viewOf(team);
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      await q('SELECT 1 FROM tenants WHERE id = $1 FOR NO KEY UPDATE', [tenantId]); // serializes the creators: the limit is counted under it
      const count = await q('SELECT COUNT(*)::int AS n FROM tenant_teams WHERE tenant_id = $1', [tenantId]);
      if (Number(count.rows[0].n) >= teamLimit()) throw tooMany();
      const res = await q('INSERT INTO tenant_teams (tenant_id, name, description, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING *', [tenantId, input.name, description, actorName(who)]);
      const r = res.rows[0];
      await insertEventTx(q, tenantId, 'team', String(r.id), 'created', who, teamFields(input.name, description));
      return { id: String(r.id), name: String(r.name), description: String(r.description ?? ''), memberIds: [], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: r.updated_by ?? null };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw duplicate();
    throw err;
  }
}

/**
 * Changes the name and/or the description of a team. `expectedUpdatedAt` is the stamp the client loaded: another stamp is a StaleWriteError (checked
 * first). A write that changes nothing writes no row and no event (changed false). Throws not_found and duplicate_name.
 */
export async function updateTeam(
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string },
  expectedUpdatedAt: string,
  who: InventoryActor
): Promise<{ team: Team; changed: boolean }> {
  if (isMemory()) {
    const t = memoryTeams.get(id);
    if (!t || t.tenantId !== tenantId) throw notFound();
    if (!matchesExpected(t.updatedAt, expectedUpdatedAt)) throw new StaleWriteError({ updatedAt: t.updatedAt, updatedBy: t.updatedBy });
    const name = patch.name ?? t.name;
    const description = patch.description ?? t.description;
    if (name === t.name && description === t.description) return { team: viewOf(t), changed: false };
    if (name !== t.name && memoryOf(tenantId).some((o) => o.id !== id && lowerName(o.name) === lowerName(name))) throw duplicate();
    pushMemoryInventoryEvent(tenantId, 'team', id, 'updated', who, teamFields(name !== t.name ? name : undefined, description !== t.description ? description : undefined));
    t.name = name;
    t.description = description;
    t.updatedAt = nextStamp(t.updatedAt);
    t.updatedBy = actorName(who);
    return { team: viewOf(t), changed: true };
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const locked = await q('SELECT * FROM tenant_teams WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
      const before = locked.rows[0];
      if (!before) throw notFound();
      if (!matchesExpected(iso(before.updated_at), expectedUpdatedAt)) throw new StaleWriteError({ updatedAt: iso(before.updated_at), updatedBy: before.updated_by ?? null });
      const name = patch.name ?? String(before.name);
      const description = patch.description ?? String(before.description ?? '');
      if (name === before.name && description === (before.description ?? '')) return { team: (await loadTeamsIn(q, tenantId, id)) as Team, changed: false };
      await q('UPDATE tenant_teams SET name = $3, description = $4, updated_by = $5, updated_at = GREATEST(NOW(), updated_at + interval \'1 millisecond\') WHERE tenant_id = $1 AND id = $2', [tenantId, id, name, description, actorName(who)]);
      await insertEventTx(q, tenantId, 'team', id, 'updated', who, teamFields(name !== before.name ? name : undefined, description !== (before.description ?? '') ? description : undefined));
      return { team: (await loadTeamsIn(q, tenantId, id)) as Team, changed: true };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw duplicate();
    throw err;
  }
}

type Tx = Parameters<Parameters<typeof inTenantTx>[1]>[0];

async function loadTeamsIn(q: Tx, tenantId: string, id: string): Promise<Team | null> {
  const t = await q('SELECT * FROM tenant_teams WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!t.rows[0]) return null;
  const m = await q('SELECT user_id FROM tenant_team_members WHERE tenant_id = $1 AND team_id = $2', [tenantId, id]);
  const r = t.rows[0];
  return { id: String(r.id), name: String(r.name), description: String(r.description ?? ''), memberIds: sortIds(m.rows.map((x) => String(x.user_id))), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: r.updated_by ?? null };
}

/**
 * Adds and removes members (deltas, so two editors do not overwrite each other). Adding a member or removing a non-member is not a change. The route has
 * checked that every added id is a current member of the tenant. At most MAX_TEAM_MEMBERS per team (limit). One `members_changed` event when something changed.
 */
export async function changeTeamMembers(tenantId: string, id: string, change: { add: string[]; remove: string[] }, who: InventoryActor): Promise<{ team: Team; added: number; removed: number }> {
  const eventFields = (added: string[], removed: string[]): EventFields => ({
    added: sortIds(added).slice(0, MAX_EVENT_IDS).join(','),
    addedCount: added.length,
    removed: sortIds(removed).slice(0, MAX_EVENT_IDS).join(','),
    removedCount: removed.length,
  });
  if (isMemory()) {
    const t = memoryTeams.get(id);
    if (!t || t.tenantId !== tenantId) throw notFound();
    const removing = change.remove.filter((u) => t.members.has(u));
    const adding = [...new Set(change.add)].filter((u) => !t.members.has(u) && !removing.includes(u));
    if (t.members.size - removing.length + adding.length > MAX_TEAM_MEMBERS) throw tooManyMembers();
    if (adding.length + removing.length > 0) {
      for (const u of removing) t.members.delete(u);
      for (const u of adding) t.members.add(u);
      t.updatedAt = nextStamp(t.updatedAt);
      t.updatedBy = actorName(who);
      pushMemoryInventoryEvent(tenantId, 'team', id, 'members_changed', who, eventFields(adding, removing));
    }
    return { team: viewOf(t), added: adding.length, removed: removing.length };
  }
  return inTenantTx(tenantId, async (q) => {
    const locked = await q('SELECT 1 FROM tenant_teams WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
    if (!locked.rows[0]) throw notFound();
    const current = new Set((await q('SELECT user_id FROM tenant_team_members WHERE tenant_id = $1 AND team_id = $2', [tenantId, id])).rows.map((r) => String(r.user_id)));
    const removing = change.remove.filter((u) => current.has(u));
    const adding = [...new Set(change.add)].filter((u) => !current.has(u) && !removing.includes(u));
    if (current.size - removing.length + adding.length > MAX_TEAM_MEMBERS) throw tooManyMembers();
    if (removing.length > 0) await q('DELETE FROM tenant_team_members WHERE tenant_id = $1 AND team_id = $2 AND user_id = ANY($3::text[])', [tenantId, id, removing]);
    if (adding.length > 0) {
      await q('INSERT INTO tenant_team_members (tenant_id, team_id, user_id, added_by) SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x ON CONFLICT DO NOTHING', [tenantId, id, adding, actorName(who)]);
    }
    if (adding.length + removing.length > 0) {
      await q('UPDATE tenant_teams SET updated_by = $3, updated_at = GREATEST(NOW(), updated_at + interval \'1 millisecond\') WHERE tenant_id = $1 AND id = $2', [tenantId, id, actorName(who)]);
      await insertEventTx(q, tenantId, 'team', id, 'members_changed', who, eventFields(adding, removing));
    }
    return { team: (await loadTeamsIn(q, tenantId, id)) as Team, added: adding.length, removed: removing.length };
  });
}

/** Deletes the team and its members (the assignments naming it are the caller's to check or delete first). False when there is no such team. */
export async function deleteTeam(tenantId: string, id: string, who: InventoryActor): Promise<boolean> {
  if (isMemory()) {
    const t = memoryTeams.get(id);
    if (!t || t.tenantId !== tenantId) return false;
    memoryTeams.delete(id);
    pushMemoryInventoryEvent(tenantId, 'team', id, 'deleted', who, { memberCount: t.members.size });
    return true;
  }
  return inTenantTx(tenantId, async (q) => {
    const members = await q('SELECT COUNT(*)::int AS n FROM tenant_team_members WHERE tenant_id = $1 AND team_id = $2', [tenantId, id]);
    const res = await q('DELETE FROM tenant_teams WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId, id]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, tenantId, 'team', id, 'deleted', who, { memberCount: Number(members.rows[0].n) });
    return true;
  });
}
