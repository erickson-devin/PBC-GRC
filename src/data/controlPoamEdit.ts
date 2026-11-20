import { CONTROL_POAM_OWNER_MAX, CONTROL_POAM_PLAN_MAX, CONTROL_POAM_RESOURCES_MAX } from '../types/controlPoam';
import type { ControlPoamPatch } from '../types/controlPoam';
import { isValidPoamDate } from './poamDates';
import { parseMilestonesInput } from './poamMilestones';

/**
 * Editing a control's POA&M entry (#304): the request body of PATCH /api/v1/control-poam/:controlId, pure so the server, the screen and the tests
 * share one definition (the vulnerability item counterpart is vmPoamEdit.ts). An error names the field, never the value (every text can hold CUI).
 */

export { CONTROL_POAM_OWNER_MAX, CONTROL_POAM_PLAN_MAX, CONTROL_POAM_RESOURCES_MAX };

/** The control ids the route accepts (the NIST 800-53 ids carry parentheses: AC-2(1)). */
export const CONTROL_POAM_CONTROL_ID_PATTERN = /^[A-Za-z0-9._()-]{1,64}$/;

const PATCH_KEYS = ['owner', 'scheduledCompletion', 'requiredResources', 'plan', 'milestones'] as const;
const OWNER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Every C0 control character and DEL except line feed and tab. */
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type ControlPoamPatchResult = { ok: true; patch: ControlPoamPatch; expectedUpdatedAt: string | null } | { ok: false; field: string };

/**
 * Reads the body of the edit request: `expectedUpdatedAt` (required: the entry's updatedAt the editor loaded, or null when it has no entry yet)
 * and at least one of `owner`, `scheduledCompletion` (a date or null to clear), `requiredResources`, `plan` and `milestones` (the whole list).
 * Strings are trimmed; an empty one clears it. On failure returns the name of the first offending field ('body' when the body is not an object or
 * carries nothing to change).
 */
export function parseControlPoamPatch(body: unknown): ControlPoamPatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, field: 'body' };
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length === 0) return { ok: false, field: 'body' };
  for (const key of Object.keys(input)) {
    if (key !== 'expectedUpdatedAt' && !(PATCH_KEYS as readonly string[]).includes(key)) return { ok: false, field: key.length <= 64 ? key.replace(/[^\w-]/g, '_') : 'body' };
  }
  if (!('expectedUpdatedAt' in input)) return { ok: false, field: 'expectedUpdatedAt' };
  const expected = input.expectedUpdatedAt;
  if (expected !== null && (typeof expected !== 'string' || expected.length > 64 || !Number.isFinite(Date.parse(expected)))) return { ok: false, field: 'expectedUpdatedAt' };
  const patch: ControlPoamPatch = {};
  if ('owner' in input) {
    if (typeof input.owner !== 'string') return { ok: false, field: 'owner' };
    const owner = input.owner.trim();
    if (owner.length > CONTROL_POAM_OWNER_MAX || OWNER_CONTROL_CHARS.test(owner)) return { ok: false, field: 'owner' };
    patch.owner = owner;
  }
  if ('scheduledCompletion' in input) {
    if (input.scheduledCompletion !== null && !isValidPoamDate(input.scheduledCompletion)) return { ok: false, field: 'scheduledCompletion' };
    patch.scheduledCompletion = input.scheduledCompletion as string | null;
  }
  if ('requiredResources' in input) {
    if (typeof input.requiredResources !== 'string') return { ok: false, field: 'requiredResources' };
    const resources = input.requiredResources.trim();
    if (resources.length > CONTROL_POAM_RESOURCES_MAX || TEXT_CONTROL_CHARS.test(resources)) return { ok: false, field: 'requiredResources' };
    patch.requiredResources = resources;
  }
  if ('plan' in input) {
    if (typeof input.plan !== 'string') return { ok: false, field: 'plan' };
    const plan = input.plan.trim();
    if (plan.length > CONTROL_POAM_PLAN_MAX || TEXT_CONTROL_CHARS.test(plan)) return { ok: false, field: 'plan' };
    patch.plan = plan;
  }
  if ('milestones' in input) {
    const parsed = parseMilestonesInput(input.milestones);
    if (!parsed.ok) return { ok: false, field: 'milestones' };
    patch.milestones = parsed.milestones;
  }
  if (Object.keys(patch).length === 0) return { ok: false, field: 'body' };
  return { ok: true, patch, expectedUpdatedAt: expected as string | null };
}
