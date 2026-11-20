import { listTenantMembers, membershipNowMs, type ProgramScope } from '../db';
import { readControlAssessments } from '../controlAssessments';
import { readObjectives } from '../controlObjectives';
import { readSspReviews } from '../sspReviews';
import { listPrograms, type Program } from '../programs';
import { listTeams } from './teamsStore';
import { readAssignments, type StoredAssignment } from './assignmentsStore';
import { assigneeState } from '../../src/data/assignments/assignmentsView';
import {
  MAX_RESPONSIBILITY_ITEMS,
  type Assignment,
  type ResponsibilitiesResponse,
  type ResponsibilityItem,
} from '../../src/types/assignments';
import { membershipExpired } from '../../src/utils/memberProfile';
import type { TenantRole } from '../../src/types/tenant';

/**
 * Reading assignments (#253): the state of each assignee, and the responsibilities of a person or a team across a tenant's programs. An assignment is a
 * label: nothing here (or anywhere) turns it into a permission. Everything returned is ids, kinds, duties, statuses and flags: no name, no note.
 */

/** The members and the teams of a tenant, as the assignee states and the team lookups need them. */
export interface AssigneeContext {
  members: Map<string, { accessExpiresOn: string | null }>;
  roles: Map<string, TenantRole>;
  teams: Map<string, string[]>;
}

export async function loadAssigneeContext(tenantId: string): Promise<AssigneeContext> {
  const [members, teams] = await Promise.all([listTenantMembers(tenantId), listTeams(tenantId)]);
  return {
    members: new Map(members.map((m) => [m.userId, { accessExpiresOn: m.profile.accessExpiresOn }] as const)),
    roles: new Map(members.map((m) => [m.userId, m.role] as const)),
    teams: new Map(teams.map((t) => [t.id, t.memberIds] as const)),
  };
}

/** Whether `userId` is a member of the tenant whose access has not ended (the only people an assignment may name when it is set). */
export function isCurrentMember(ctx: AssigneeContext, userId: string, nowMs: number = membershipNowMs()): boolean {
  const m = ctx.members.get(userId);
  return m !== undefined && !membershipExpired(m.accessExpiresOn, nowMs);
}

/** The stored rows as the API returns them, each with its assignee's state. */
export function toAssignments(rows: StoredAssignment[], ctx: AssigneeContext, nowMs: number = membershipNowMs()): Assignment[] {
  const view = { members: ctx.members, teamIds: new Set(ctx.teams.keys()) };
  return rows.map((r) => ({ ...r, assigneeState: assigneeState(r.assignee, view, nowMs) }));
}

/** Who the responsibilities are for: a person (with the teams they belong to) or one team. */
export type ResponsibilityFor = { kind: 'user'; userId: string; teamIds: ReadonlySet<string> } | { kind: 'team'; teamId: string };

/** The teams of the tenant a user belongs to. */
export function teamsOfUser(ctx: AssigneeContext, userId: string): Set<string> {
  return new Set([...ctx.teams].filter(([, members]) => members.includes(userId)).map(([id]) => id));
}

/** The program's assignments that name the person (directly or through a team) or the team, as responsibility items with their live status. */
export async function programResponsibilities(scope: ProgramScope, who: ResponsibilityFor): Promise<ResponsibilityItem[]> {
  const matched: { row: StoredAssignment; via: 'user' | 'team'; teamId: string | null }[] = [];
  for (const row of await readAssignments(scope)) {
    if (who.kind === 'team') {
      if (row.assignee.kind === 'team' && row.assignee.id === who.teamId) matched.push({ row, via: 'team', teamId: who.teamId });
    } else if (row.assignee.kind === 'user' && row.assignee.id === who.userId) matched.push({ row, via: 'user', teamId: null });
    else if (row.assignee.kind === 'team' && who.teamIds.has(row.assignee.id)) matched.push({ row, via: 'team', teamId: row.assignee.id });
  }
  if (matched.length === 0) return [];
  const needs = (kind: string): boolean => matched.some((m) => m.row.targetKind === kind);
  const assessments = needs('control') ? await readControlAssessments(scope) : null;
  const objectives = needs('objective') ? new Map((await readObjectives(scope)).map((o) => [o.objectiveId, o.status] as const)) : null;
  const reviewed = matched.some((m) => m.row.targetKind === 'ssp_section' && m.row.duty === 'reviewer')
    ? new Map((await readSspReviews(scope)).sections.map((s) => [s.sectionId, s.reviewed] as const))
    : null;
  return matched.map(({ row, via, teamId }) => ({
    targetKind: row.targetKind,
    targetId: row.targetId,
    duty: row.duty,
    via,
    teamId,
    status: row.targetKind === 'control' ? assessments?.get(row.targetId)?.status ?? 'NOT_STARTED' : row.targetKind === 'objective' ? objectives?.get(row.targetId) ?? 'NOT_STARTED' : null,
    reviewed: row.targetKind === 'ssp_section' && row.duty === 'reviewer' ? reviewed?.get(row.targetId) === true : null,
  }));
}

/**
 * The responsibilities of a person or a team across the tenant's programs (the active ones; archived too with `includeArchived`), only programs that have
 * some. At most MAX_RESPONSIBILITY_ITEMS items in all (`truncated` says when the rest was cut).
 */
export async function tenantResponsibilities(tenantId: string, who: ResponsibilityFor, includeArchived: boolean): Promise<ResponsibilitiesResponse> {
  const programs: Program[] = await listPrograms(tenantId, { includeArchived });
  const out: ResponsibilitiesResponse = { programs: [], truncated: false };
  let total = 0;
  for (const p of programs) {
    const items = await programResponsibilities({ tenantId, programId: p.id }, who);
    if (items.length === 0) continue;
    const room = MAX_RESPONSIBILITY_ITEMS - total;
    if (items.length > room) out.truncated = true;
    const kept = items.slice(0, Math.max(0, room));
    total += kept.length;
    if (kept.length > 0) out.programs.push({ programId: p.id, name: p.name, frameworkId: p.frameworkId, archived: p.archivedAt !== null, items: kept });
  }
  return out;
}
