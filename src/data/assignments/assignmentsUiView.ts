// What the assignment screens say and offer (#253): the assignee picker's options, the chip, the error texts, the bulk plan and the advisory reviewer
// lines. An assignment is a label: nothing here grants or refuses a permission. Pure: no react, services or context, the time is injected, and no
// message ever echoes a name, an id or a server value.

import type { TeamMember } from '../../types/tenant';
import { ASSIGNEE_KINDS, MAX_ASSIGNMENT_BATCH } from '../../types/assignments';
import type { AssigneeKind, AssigneeRef, Assignment, AssignmentChange, Team } from '../../types/assignments';
import type { ReviewerCheck } from './assignmentsView';
import { assigneeStateText } from './assignmentsView';
import { membershipExpired } from '../../utils/memberProfile';

export const ASSIGNMENT_TEXT = {
  labelOnly: 'An assignment is a label for follow-up. It does not give anyone access or permission to edit.',
  browserOnly: 'Assignments need a server-backed organization.',
  archived: 'This program is archived. Restore it to change assignments.',
  readOnly: 'Assigned by a Tenant Owner or Admin.',
  loading: 'Loading…',
  loadFailed: 'Assignments could not be loaded.',
  unassigned: 'Unassigned',
  owner: 'Owner',
  reviewer: 'Assigned reviewer',
  advisory: 'Advisory only: any Tenant Owner or Admin can sign off.',
} as const;

export interface AssigneeOption {
  value: string;
  label: string;
  disabled: boolean;
}

/** The value of the picker: '' (nobody), 'user:<id>' or 'team:<id>'. */
export function encodeAssignee(a: AssigneeRef | null): string {
  return a ? `${a.kind}:${a.id}` : '';
}

const ASSIGNEE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

/** The reverse of encodeAssignee; anything that is not a known kind with a well-formed id (a tampered value) gives null. */
export function decodeAssignee(v: string): AssigneeRef | null {
  if (typeof v !== 'string') return null;
  const at = v.indexOf(':');
  if (at < 1) return null;
  const kind = v.slice(0, at);
  const id = v.slice(at + 1);
  if (!(ASSIGNEE_KINDS as readonly string[]).includes(kind) || !ASSIGNEE_ID_PATTERN.test(id)) return null;
  return { kind: kind as AssigneeKind, id };
}

const byLabel = (a: AssigneeOption, b: AssigneeOption): number => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
const memberLabel = (m: Pick<TeamMember, 'name' | 'email'>): string => (m.name || '').trim() || m.email;

/**
 * The people and teams the picker offers. A person is a current member with a user id; one whose access has ended or whose account is disabled is shown
 * but cannot be chosen. `currentExtra` stands for the present assignee when it is in neither list (they left, or the team was removed).
 */
export function assigneeOptions(
  members: TeamMember[],
  teams: Team[],
  nowMs: number,
  current: AssigneeRef | null
): { people: AssigneeOption[]; teams: AssigneeOption[]; currentExtra: AssigneeOption | null } {
  const people: AssigneeOption[] = [];
  for (const m of members) {
    if (m.status !== 'ACTIVE' || !m.userId) continue;
    const label = memberLabel(m);
    const expired = m.membershipExpired === true || membershipExpired(m.accessExpiresOn, nowMs);
    if (expired) people.push({ value: encodeAssignee({ kind: 'user', id: m.userId }), label: `${label} (access expired)`, disabled: true });
    else if (m.accountDisabled) people.push({ value: encodeAssignee({ kind: 'user', id: m.userId }), label: `${label} (account disabled)`, disabled: true });
    else people.push({ value: encodeAssignee({ kind: 'user', id: m.userId }), label, disabled: false });
  }
  const teamOptions: AssigneeOption[] = teams.map((t) => ({ value: encodeAssignee({ kind: 'team', id: t.id }), label: t.name, disabled: false }));
  people.sort(byLabel);
  teamOptions.sort(byLabel);
  let currentExtra: AssigneeOption | null = null;
  if (current) {
    const value = encodeAssignee(current);
    if (!people.some((o) => o.value === value) && !teamOptions.some((o) => o.value === value)) {
      currentExtra = { value, label: current.kind === 'user' ? 'Former member (no longer a member)' : 'Removed team', disabled: true };
    }
  }
  return { people, teams: teamOptions, currentExtra };
}

/** The label of an assignee as the chip shows it. */
export function assigneeChip(a: Assignment | null, members: TeamMember[], teams: Team[]): { text: string; tag: string | null; tone: 'none' | 'ok' | 'warn' } {
  if (!a) return { text: ASSIGNMENT_TEXT.unassigned, tag: null, tone: 'none' };
  const tag = assigneeStateText(a.assigneeState) || null;
  if (a.assignee.kind === 'team') {
    const team = teams.find((t) => t.id === a.assignee.id);
    if (a.assigneeState === 'team_removed' || !team) return { text: 'Removed team', tag: assigneeStateText('team_removed'), tone: 'warn' };
    return { text: `${team.name} (team)`, tag: null, tone: 'ok' };
  }
  if (a.assigneeState === 'not_member') return { text: 'Former member', tag: assigneeStateText('not_member'), tone: 'warn' };
  const member = members.find((m) => m.userId === a.assignee.id);
  const name = member ? memberLabel(member) : 'A member';
  return { text: name, tag, tone: tag ? 'warn' : 'ok' };
}

interface ErrorLike {
  status?: unknown;
  reason?: unknown;
}

/** What to tell the person when a save or a team action failed. Chosen by the server's reason, never from its text: nothing a person typed is shown back. */
export function assignmentErrorMessage(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  switch (e.reason) {
    case 'stale_write': return 'Someone else changed this assignment. The current assignee is shown; choose again if needed.';
    case 'assignee_not_member': return 'That person is not a current member of this organization.';
    case 'target_not_in_program': return 'That item is not part of this program.';
    case 'reviewer_only_for_sections': return 'A reviewer can only be assigned to an SSP section that is signed off.';
    case 'team_not_found': return 'That team was removed.';
    case 'teams_not_available': return 'Teams are not available yet.';
    case 'limit': return 'This program has reached its assignment limit.';
    case 'program_archived': return ASSIGNMENT_TEXT.archived;
    case 'duplicate_name': return 'A team with that name already exists.';
    case 'team_in_use': return 'This team still has assignments.';
    default: break;
  }
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change assignments.';
  return 'The assignment was not saved. Try again.';
}

export interface BulkPlan {
  chunks: AssignmentChange[][];
  changing: number;
  replacing: number;
  skipped: number;
  unchanged: number;
}

/**
 * What a bulk "assign an owner" would do to these controls. The key is the control's owner duty. Controls that already have the same owner are left
 * alone; a different owner is kept unless `replace`; removing (assignee null) touches only the controls that have an owner. Each change carries the
 * owner this screen saw (`expectedAssignee`), so a change made by someone else in the meantime is refused, not overwritten.
 */
export function bulkAssignPlan(controlIds: string[], current: ReadonlyMap<string, Assignment>, assignee: AssigneeRef | null, replace: boolean): BulkPlan {
  const items: AssignmentChange[] = [];
  let replacing = 0;
  let skipped = 0;
  let unchanged = 0;
  for (const id of controlIds) {
    const existing = current.get(`control|${id}|owner`)?.assignee ?? null;
    if (assignee === null) {
      if (existing === null) unchanged += 1;
      else items.push({ targetKind: 'control', targetId: id, duty: 'owner', assignee: null, expectedAssignee: existing });
      continue;
    }
    if (existing && existing.kind === assignee.kind && existing.id === assignee.id) {
      unchanged += 1;
      continue;
    }
    if (existing && !replace) {
      skipped += 1;
      continue;
    }
    if (existing) replacing += 1;
    items.push({ targetKind: 'control', targetId: id, duty: 'owner', assignee, expectedAssignee: existing });
  }
  const chunks: AssignmentChange[][] = [];
  for (let i = 0; i < items.length; i += MAX_ASSIGNMENT_BATCH) chunks.push(items.slice(i, i + MAX_ASSIGNMENT_BATCH));
  return { chunks, changing: items.length, replacing, skipped, unchanged };
}

const ctl = (n: number): string => (n === 1 ? 'control' : 'controls');
const has = (n: number): string => (n === 1 ? 'has' : 'have');

/** The sentence the bulk dialog shows before it saves. `who` is the chosen person or team's label, null for "remove the owner". */
export function bulkConfirmText(p: BulkPlan, who: string | null): string {
  const n = p.changing;
  if (who === null) return `Remove the owner from ${n} ${ctl(n)}?`;
  return (
    `Assign ${who} as owner of ${n} ${ctl(n)}?` +
    (p.skipped ? ` ${p.skipped} ${ctl(p.skipped)} that already ${has(p.skipped)} a different owner will be skipped.` : '') +
    (p.replacing ? ` ${p.replacing} ${ctl(p.replacing)} will change owner.` : '')
  );
}

/** The advisory line under an SSP section's reviewer: it flags and never blocks a sign-off. */
export function reviewerCheckText(c: ReviewerCheck, name: string | null, roleLabel: string | null): { text: string; tone: 'none' | 'ok' | 'warn' } {
  switch (c.kind) {
    case 'none': return { text: 'No reviewer assigned.', tone: 'none' };
    case 'match': return { text: 'Last signed off by the assigned reviewer.', tone: 'ok' };
    case 'signed_by_other': return { text: 'Last signed off by someone other than the assigned reviewer.', tone: 'warn' };
    case 'not_signed': return { text: 'The assigned reviewer has not signed off yet.', tone: 'none' };
    case 'reviewer_cannot_sign':
      return { text: `${name ?? 'The assigned reviewer'}'s role (${roleLabel ?? 'read-only'}) cannot sign off. A Tenant Owner or Admin signs off instead.`, tone: 'warn' };
  }
}

/** What to tell the person when a team action failed (create, rename, members, delete). Chosen by the server's reason; never echoes a name or a server value. */
export function teamErrorMessage(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  switch (e.reason) {
    case 'duplicate_name': return 'A team with that name already exists.';
    case 'stale_write': return 'Someone else changed this team. The current version is shown; try again.';
    case 'not_found': return 'That team was removed.';
    case 'not_a_member':
    case 'invalid_member_ids': return 'Only current members whose access has not ended can be added to a team.';
    case 'team_in_use': return 'This team still has assignments.';
    case 'limit': return 'The limit for teams or team members has been reached.';
    case 'invalid': return 'Check the team name and description.';
    default: break;
  }
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change teams.';
  return 'The team was not saved. Try again.';
}
