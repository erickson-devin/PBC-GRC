import { VM_POAM_STATUSES } from '../types/vm';
import type { VmFindingStatus, VmPoamItemPatch, VmPoamStatus } from '../types/vm';

/**
 * Editing a vulnerability POA&M item (#297): the request body of PATCH .../vm/poam/:itemId and the status rules, pure so the server, the
 * screen and the tests share one definition. An error names the field, never the value (an owner or a mitigation can hold CUI).
 */

export const VM_POAM_OWNER_MAX = 255;
export const VM_POAM_MITIGATION_MAX = 4000;
/** Fixed bounds (not clock-dependent) for a scheduled completion date. */
export const VM_POAM_DATE_MIN = '2000-01-01';
export const VM_POAM_DATE_MAX = '2099-12-31';

const PATCH_KEYS = ['owner', 'mitigation', 'scheduledCompletion', 'status'] as const;
const OWNER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Every C0 control character and DEL except line feed and tab. */
const MITIGATION_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type VmPoamPatchResult = { ok: true; patch: VmPoamItemPatch; expectedUpdatedAt: string } | { ok: false; field: string };

/** True for a real calendar date in YYYY-MM-DD form between VM_POAM_DATE_MIN and VM_POAM_DATE_MAX. */
export function isValidPoamDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return false;
  return value >= VM_POAM_DATE_MIN && value <= VM_POAM_DATE_MAX;
}

/**
 * Reads the body of the edit request: `expectedUpdatedAt` (required, the item's updatedAt the editor loaded) and at least one of `owner`,
 * `mitigation`, `scheduledCompletion` (a date or null to clear) and `status`. Strings are trimmed; an empty owner or mitigation clears it.
 * On failure returns the name of the first offending field ('body' when the body is not an object or carries nothing to change).
 */
export function parseVmPoamPatch(body: unknown): VmPoamPatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, field: 'body' };
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'expectedUpdatedAt' && !(PATCH_KEYS as readonly string[]).includes(key)) return { ok: false, field: key.length <= 64 ? key.replace(/[^\w-]/g, '_') : 'body' };
  }
  const expected = input.expectedUpdatedAt;
  if (typeof expected !== 'string' || expected.length > 64 || !Number.isFinite(Date.parse(expected))) return { ok: false, field: 'expectedUpdatedAt' };
  const patch: VmPoamItemPatch = {};
  if ('owner' in input) {
    if (typeof input.owner !== 'string') return { ok: false, field: 'owner' };
    const owner = input.owner.trim();
    if (owner.length > VM_POAM_OWNER_MAX || OWNER_CONTROL_CHARS.test(owner)) return { ok: false, field: 'owner' };
    patch.owner = owner;
  }
  if ('mitigation' in input) {
    if (typeof input.mitigation !== 'string') return { ok: false, field: 'mitigation' };
    const mitigation = input.mitigation.trim();
    if (mitigation.length > VM_POAM_MITIGATION_MAX || MITIGATION_CONTROL_CHARS.test(mitigation)) return { ok: false, field: 'mitigation' };
    patch.mitigation = mitigation;
  }
  if ('scheduledCompletion' in input) {
    if (input.scheduledCompletion !== null && !isValidPoamDate(input.scheduledCompletion)) return { ok: false, field: 'scheduledCompletion' };
    patch.scheduledCompletion = input.scheduledCompletion as string | null;
  }
  if ('status' in input) {
    if (typeof input.status !== 'string' || !(VM_POAM_STATUSES as readonly string[]).includes(input.status)) return { ok: false, field: 'status' };
    patch.status = input.status as VmPoamStatus;
  }
  if (Object.keys(patch).length === 0) return { ok: false, field: 'body' };
  return { ok: true, patch, expectedUpdatedAt: expected };
}

export type VmPoamStatusPlan = { ok: true; reopen: boolean } | { ok: false; code: 'finding_still_open' | 'mitigation_required' };

/**
 * Whether the item may end in `next`, given its current status, whether its finding is still OPEN in the item's episode, and the mitigation
 * text it will hold after the edit. A person cannot complete an item while the scanner still reports the vulnerability (the item would
 * block a new one for that episode: use RISK_ACCEPTED); risk acceptance needs a written mitigation. `reopen` is true when a completed or
 * risk-accepted item goes back to OPEN / IN_PROGRESS: the worker then no longer completes it automatically.
 */
export function planVmPoamStatus(before: { status: VmPoamStatus; findingOpenInEpisode: boolean }, next: VmPoamStatus, mitigationAfter: string): VmPoamStatusPlan {
  if (next === 'RISK_ACCEPTED' && mitigationAfter.trim() === '') return { ok: false, code: 'mitigation_required' };
  if (next === before.status) return { ok: true, reopen: false };
  if (next === 'COMPLETED' && before.findingOpenInEpisode) return { ok: false, code: 'finding_still_open' };
  const reopen = (before.status === 'COMPLETED' || before.status === 'RISK_ACCEPTED') && (next === 'OPEN' || next === 'IN_PROGRESS');
  return { ok: true, reopen };
}

/**
 * True when the item's finding is still OPEN in the item's own episode: the same rule as the planner (the recorded episode equals the finding's
 * first_seen_at; an item without one counts when created at or after it). False for a deleted finding, a finding of another status, or an item
 * of an earlier episode (the finding was resolved and came back). The server refuses COMPLETED then (finding_still_open); the screen shows it unavailable.
 */
export function vmPoamFindingOpenInEpisode(item: { findingFirstSeenAt?: string | null; createdAt: string }, finding: { status: VmFindingStatus; firstSeenAt: string } | null): boolean {
  if (!finding || finding.status !== 'OPEN') return false;
  const episode = Date.parse(finding.firstSeenAt);
  return item.findingFirstSeenAt ? Date.parse(item.findingFirstSeenAt) === episode : Date.parse(item.createdAt) >= episode;
}
