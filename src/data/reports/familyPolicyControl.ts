import { cmmcNumberOf } from '../cmmcGuide/guide';

/** The first requirement of each of the 14 NIST SP 800-171 families: it carries the family's policy document. */
export const FAMILY_POLICY_REQUIREMENTS: readonly string[] = [
  '3.1.1', '3.2.1', '3.3.1', '3.4.1', '3.5.1', '3.6.1', '3.7.1',
  '3.8.1', '3.9.1', '3.10.1', '3.11.1', '3.12.1', '3.13.1', '3.14.1',
];

const FIRST = new Set(FAMILY_POLICY_REQUIREMENTS);

/**
 * Whether the control dialog offers the "Living Policy" tab for this control (issue #289).
 * A CMMC id (either level prefix, e.g. AC.L1-3.1.1 or AC.L2-3.1.1) matches on its exact requirement number, so
 * AC.L2-3.1.10 is not mistaken for 3.1.1. Bare 800-171 ids match the same list, and every other framework keeps
 * its "-1" rule (AC-1, PM-1, ...).
 */
export function isFamilyPolicyControl(controlId: string | null | undefined): boolean {
  const id = controlId ?? '';
  if (!id) return false;
  const number = cmmcNumberOf(id);
  if (number) return FIRST.has(number);
  return FIRST.has(id) || id.endsWith('-1');
}
