// Validators for assignments and teams (#253), shared by the server and the client. An assignment is a label: nothing here decides a permission. Every
// error names a field (and the index of the item) and never echoes a value, so a team name or an id never reaches a log or a message.

import {
  ASSIGNEE_KINDS,
  ASSIGNMENT_DUTIES,
  ASSIGNMENT_TARGET_KINDS,
  MAX_ASSIGNMENT_BATCH,
  TEAM_DESCRIPTION_MAX,
  TEAM_NAME_MAX,
  type AssigneeRef,
  type AssignmentChange,
} from '../../types/assignments';
import { controlIdOfObjective } from '../../types/controlObjectives';

/** The control, section and objective id shapes the table accepts (an objective id carries its `[letter]`). */
const TARGET_ID_PATTERN = /^[A-Za-z0-9.()_-]{1,64}(\[[a-z0-9]{1,16}\])?$/;
/** The member id pattern of the SSP profile. A team id is a UUID, which it also matches. */
const ASSIGNEE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const inList = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v);

/** The ref, or the name of the part that is wrong ('kind' or 'id'). */
function parseRef(v: unknown): AssigneeRef | 'kind' | 'id' | 'shape' {
  if (!isRecord(v)) return 'shape';
  if (Object.keys(v).some((k) => k !== 'kind' && k !== 'id')) return 'shape';
  if (!inList(ASSIGNEE_KINDS, v.kind)) return 'kind';
  if (typeof v.id !== 'string' || !ASSIGNEE_ID_PATTERN.test(v.id)) return 'id';
  return { kind: v.kind as AssigneeRef['kind'], id: v.id };
}

export type AssignmentBatchValidation = { ok: true; items: AssignmentChange[] } | { ok: false; index: number | null; field: string };

const KEYS = new Set(['targetKind', 'targetId', 'duty', 'assignee', 'expectedAssignee']);

/**
 * A body `{items: AssignmentChange[]}` of 1 to MAX_ASSIGNMENT_BATCH changes. `assignee: null` unassigns; `expectedAssignee` is required (null: nobody was
 * assigned). The same target and duty twice in one batch is refused (field 'targetId'). Failure: the item index (null for the body) and the field.
 */
export function validateAssignmentBatch(body: unknown): AssignmentBatchValidation {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ASSIGNMENT_BATCH) return { ok: false, index: null, field: 'items' };
  const items: AssignmentChange[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.items.length; index++) {
    const it: unknown = body.items[index];
    const bad = (field: string): AssignmentBatchValidation => ({ ok: false, index, field });
    if (!isRecord(it)) return bad('items');
    const stray = Object.keys(it).find((k) => !KEYS.has(k));
    if (stray !== undefined) return bad('items');
    if (!inList(ASSIGNMENT_TARGET_KINDS, it.targetKind)) return bad('targetKind');
    if (typeof it.targetId !== 'string' || !TARGET_ID_PATTERN.test(it.targetId)) return bad('targetId');
    const isObjective = controlIdOfObjective(it.targetId) !== null;
    if ((it.targetKind === 'objective') !== isObjective) return bad('targetId');
    if (!inList(ASSIGNMENT_DUTIES, it.duty)) return bad('duty');
    let assignee: AssigneeRef | null = null;
    if (it.assignee !== null) {
      const r = parseRef(it.assignee);
      if (typeof r === 'string') return bad('assignee');
      assignee = r;
    }
    if (it.expectedAssignee === undefined) return bad('expectedAssignee');
    let expected: AssigneeRef | null = null;
    if (it.expectedAssignee !== null) {
      const r = parseRef(it.expectedAssignee);
      if (typeof r === 'string') return bad('expectedAssignee');
      expected = r;
    }
    const key = `${it.targetKind}|${it.targetId}|${it.duty}`;
    if (seen.has(key)) return bad('targetId');
    seen.add(key);
    items.push({ targetKind: it.targetKind as AssignmentChange['targetKind'], targetId: it.targetId, duty: it.duty as AssignmentChange['duty'], assignee, expectedAssignee: expected });
  }
  return { ok: true, items };
}

export type AssignmentTargetProblem = null | 'target_not_in_program' | 'reviewer_only_for_sections';

/**
 * Whether the target exists in the program and the duty fits it. The reviewer duty is for the signable SSP sections only. `catalogIds` are the
 * program's control ids, `sectionIds` every SSP section id, `signableIds` the ones a person can sign off.
 */
export function targetProblem(
  c: Pick<AssignmentChange, 'targetKind' | 'targetId' | 'duty'>,
  ctx: { catalogIds: ReadonlySet<string>; sectionIds: readonly string[]; signableIds: readonly string[] }
): AssignmentTargetProblem {
  if (c.duty === 'reviewer' && !(c.targetKind === 'ssp_section' && ctx.signableIds.includes(c.targetId))) return 'reviewer_only_for_sections';
  if (c.targetKind === 'control') return ctx.catalogIds.has(c.targetId) ? null : 'target_not_in_program';
  if (c.targetKind === 'objective') {
    const controlId = controlIdOfObjective(c.targetId);
    return controlId !== null && ctx.catalogIds.has(controlId) ? null : 'target_not_in_program';
  }
  return ctx.sectionIds.includes(c.targetId) ? null : 'target_not_in_program';
}

export type TeamInputValidation = { ok: true; value: { name?: string; description?: string } } | { ok: false; field: string };

/**
 * A team's name (1 to TEAM_NAME_MAX characters after trimming, no control characters) and description (at most TEAM_DESCRIPTION_MAX; may be empty).
 * `partial` allows leaving either out (an update); a create needs a name. `expectedUpdatedAt` is the route's own and is ignored here. Failure names the field only.
 */
export function validateTeamInput(body: unknown, partial: boolean): TeamInputValidation {
  if (!isRecord(body)) return { ok: false, field: 'body' };
  const stray = Object.keys(body).find((k) => k !== 'name' && k !== 'description' && k !== 'expectedUpdatedAt');
  if (stray !== undefined) return { ok: false, field: 'body' };
  const value: { name?: string; description?: string } = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string') return { ok: false, field: 'name' };
    const name = body.name.trim();
    if (name.length < 1 || name.length > TEAM_NAME_MAX || CONTROL_CHARS.test(name)) return { ok: false, field: 'name' };
    value.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { ok: false, field: 'description' };
    const description = body.description.trim();
    if (description.length > TEAM_DESCRIPTION_MAX || CONTROL_CHARS.test(description.replace(/[\n\r\t]/g, ' '))) return { ok: false, field: 'description' };
    value.description = description;
  }
  return { ok: true, value };
}
