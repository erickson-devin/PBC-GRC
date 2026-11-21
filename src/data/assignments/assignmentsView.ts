// What the assignment screens show (#253): the state of an assignee, the advisory reviewer check of an SSP section and the "my responsibilities" grouping.
// An assignment is a label and never grants access: assigning a read-only member to review a section does not let them sign it, and a mismatch
// only flags (it never blocks a sign-off). Pure: types and the membership rule only; the time is injected.

import type { SspSectionReview } from '../../types/sspProfile';
import type { TenantRole } from '../../types/tenant';
import type { AssigneeRef, AssigneeState, Assignment, AssignmentTargetKind, ResponsibilitiesResponse, ResponsibilityItem } from '../../types/assignments';
import { membershipExpired } from '../../utils/memberProfile';
import { canRoleWrite } from '../../utils/roles';

/** active; a user who left is not_member, one whose access date has passed is membership_expired; a team that no longer exists is team_removed. */
export function assigneeState(
  a: AssigneeRef,
  ctx: { members: Map<string, { accessExpiresOn?: string | null }>; teamIds: ReadonlySet<string> },
  nowMs: number
): AssigneeState {
  if (a.kind === 'team') return ctx.teamIds.has(a.id) ? 'active' : 'team_removed';
  const m = ctx.members.get(a.id);
  if (!m) return 'not_member';
  return membershipExpired(m.accessExpiresOn, nowMs) ? 'membership_expired' : 'active';
}

/** The text of a state that is not active (the chip beside the name); '' for active. */
export function assigneeStateText(s: AssigneeState): string {
  switch (s) {
    case 'not_member': return 'No longer a member';
    case 'membership_expired': return 'Access expired';
    case 'team_removed': return 'Team removed';
    default: return '';
  }
}

export type ReviewerCheck =
  | { kind: 'none' }
  | { kind: 'match' }
  | { kind: 'signed_by_other' }
  | { kind: 'not_signed' }
  /** Every person the assignment names has a read-only role: they cannot sign off. */
  | { kind: 'reviewer_cannot_sign' };

/**
 * The advisory check of a section's assigned reviewer against its newest sign-off. `teams` maps a team id to its member ids; `roles` a member id to
 * their role. It never blocks a sign-off: the sign-off records whoever signs.
 */
export function reviewerCheck(assignment: Assignment | null, latest: SspSectionReview | null, ctx: { teams: Map<string, string[]>; roles: Map<string, TenantRole> }): ReviewerCheck {
  if (!assignment) return { kind: 'none' };
  const ids = assignment.assignee.kind === 'user' ? [assignment.assignee.id] : ctx.teams.get(assignment.assignee.id) ?? [];
  const known = ids.filter((id) => ctx.roles.has(id));
  if (known.length > 0 && known.length === ids.length && known.every((id) => !canRoleWrite(ctx.roles.get(id)))) return { kind: 'reviewer_cannot_sign' };
  if (!latest) return { kind: 'not_signed' };
  return ids.includes(latest.reviewerUserId) ? { kind: 'match' } : { kind: 'signed_by_other' };
}

export const RESPONSIBILITY_KIND_ORDER: readonly AssignmentTargetKind[] = ['control', 'objective', 'ssp_section'];

/** Still to do: a control or objective not decided (Met, Not met or not applicable), a section not reviewed (an owned section has no status and stays open). */
export function responsibilityIsOpen(i: ResponsibilityItem): boolean {
  if (i.targetKind === 'ssp_section') return i.reviewed !== true;
  return i.status !== 'MET' && i.status !== 'NOT_MET' && i.status !== 'NOT_APPLICABLE';
}

/** The response grouped by program, then by kind (the response's order is kept), with the number of open items; programs with no item are left out. */
export function groupResponsibilities(r: ResponsibilitiesResponse): { programId: string; name: string; byKind: Record<AssignmentTargetKind, ResponsibilityItem[]>; openCount: number }[] {
  return r.programs
    .filter((p) => p.items.length > 0)
    .map((p) => {
      const byKind: Record<AssignmentTargetKind, ResponsibilityItem[]> = { control: [], objective: [], ssp_section: [] };
      for (const item of p.items) byKind[item.targetKind].push(item);
      return { programId: p.programId, name: p.name, byKind, openCount: p.items.filter(responsibilityIsOpen).length };
    });
}
