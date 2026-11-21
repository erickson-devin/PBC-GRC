/**
 * Teams and responsibilities (#253). An assignment is a LABEL: it names who is responsible for a control, an objective or an SSP section and never
 * grants a permission (nothing reads it to allow an action). Names of teams may be sensitive: they are never logged and history events hold digests.
 */

export const ASSIGNMENT_TARGET_KINDS = ['control', 'objective', 'ssp_section'] as const;
export type AssignmentTargetKind = (typeof ASSIGNMENT_TARGET_KINDS)[number];

/** `reviewer` applies to a signable SSP section only (and is advisory: the sign-off records whoever signs). */
export const ASSIGNMENT_DUTIES = ['owner', 'reviewer'] as const;
export type AssignmentDuty = (typeof ASSIGNMENT_DUTIES)[number];

export const ASSIGNEE_KINDS = ['user', 'team'] as const;
export type AssigneeKind = (typeof ASSIGNEE_KINDS)[number];

export const MAX_ASSIGNMENTS_PER_PROGRAM = 25000;
export const MAX_ASSIGNMENT_BATCH = 500;
export const MAX_TEAMS_PER_TENANT = 100;
export const MAX_TEAM_MEMBERS = 200;
export const TEAM_NAME_MAX = 120;
export const TEAM_DESCRIPTION_MAX = 1000;
export const MAX_RESPONSIBILITY_ITEMS = 2000;

export interface AssigneeRef {
  kind: AssigneeKind;
  id: string;
}

/** active; not_member (left the organization); membership_expired (access ended by date); team_removed (the team no longer exists). */
export type AssigneeState = 'active' | 'not_member' | 'membership_expired' | 'team_removed';

export interface Assignment {
  targetKind: AssignmentTargetKind;
  targetId: string;
  duty: AssignmentDuty;
  assignee: AssigneeRef;
  assigneeState: AssigneeState;
  assignedAt: string;
  assignedBy: string | null;
}

/** One requested change. `assignee: null` unassigns; `expectedAssignee` is what the caller saw (null: nobody), so a stale write is refused. */
export interface AssignmentChange {
  targetKind: AssignmentTargetKind;
  targetId: string;
  duty: AssignmentDuty;
  assignee: AssigneeRef | null;
  expectedAssignee: AssigneeRef | null;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ResponsibilityItem {
  targetKind: AssignmentTargetKind;
  targetId: string;
  duty: AssignmentDuty;
  via: 'user' | 'team';
  teamId: string | null;
  /** The control or objective status; null for an SSP section. */
  status: string | null;
  /** The reviewer duty on an SSP section: the newest sign-off is current. null otherwise. */
  reviewed: boolean | null;
}

export interface ResponsibilitiesResponse {
  programs: { programId: string; name: string; frameworkId: string; archived: boolean; items: ResponsibilityItem[] }[];
  truncated: boolean;
}
