/**
 * The calendar date rule shared by every POA&M edit (a vulnerability item, a control entry and their milestones): a real date in
 * YYYY-MM-DD form between two fixed bounds (not clock-dependent). vmPoamEdit.ts re-exports these for the existing callers.
 */

export const VM_POAM_DATE_MIN = '2000-01-01';
export const VM_POAM_DATE_MAX = '2099-12-31';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form between VM_POAM_DATE_MIN and VM_POAM_DATE_MAX. */
export function isValidPoamDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return false;
  return value >= VM_POAM_DATE_MIN && value <= VM_POAM_DATE_MAX;
}
