import type { ControlParameter } from '../types/framework';

/** The label of the button that fills a parameter with its suggested value, or null when there is none. */
export function odpDefaultButtonLabel(p: Pick<ControlParameter, 'defaultValue' | 'defaultSource'>): string | null {
  if (!p.defaultValue) return null;
  if (p.defaultSource === 'DOD_ODP') return `Use DoD value (${p.defaultValue.length > 60 ? `${p.defaultValue.slice(0, 60)}…` : p.defaultValue})`;
  return `Use baseline (${p.defaultValue})`;
}

/** Where a DoD value comes from, for the line under the parameter; null for any other parameter. */
export function odpDefaultProvenance(p: Pick<ControlParameter, 'defaultValue' | 'defaultSource'>, meta: { date: string } | null): string | null {
  if (p.defaultSource !== 'DOD_ODP' || !p.defaultValue) return null;
  return `DoD value from the DoD CIO memorandum "Organization-Defined Parameters for NIST SP 800-171 Revision 3"${meta?.date ? ` (${meta.date})` : ''}. Confirm it applies to your contract before using it.`;
}
