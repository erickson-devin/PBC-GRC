// What every SSP output prints of the SSP profile (#241, #242, #246): the compiled and printable SSP, the Markdown export, the handover package
// and the on-screen document all take their rows from here, so they word the same data the same way. Pure: types and the section registry only.
// A value that was never recorded prints as "Not recorded"; a suggested categorization is never printed (only what was saved).

import type { SspProfile, SspRoleEntry } from '../../types/sspProfile';
import { NOT_RECORDED } from '../reports/documentDefaults';
import { computeSspCompleteness } from './sspCompleteness';
import { SSP_ROLE_LABELS, effectiveSspRoles, overallImpact } from './sspSections';

export interface SspOutputItem {
  label: string;
  value: string;
}

export interface SspOutputRoleRow {
  role: string;
  name: string;
  email: string;
}

/** What 2.3 states when the exceptions are blank. */
export const NO_MAINTENANCE_EXCEPTIONS_RECORDED = 'No maintenance or ownership exceptions are recorded.';

export const SSP_ROLE_TABLE_HEADERS = ['Role', 'Name', 'Email'];

/** "Information owner", or the custom title; an incident-reporting role also says whether its DIBNet certificate is on file (never certificate data). */
export function sspRoleTitle(r: Pick<SspRoleEntry, 'roleKey' | 'customTitle' | 'certificateOnFile'>): string {
  const base = r.roleKey === 'custom' ? (r.customTitle ?? '').trim() || SSP_ROLE_LABELS.custom : SSP_ROLE_LABELS[r.roleKey];
  if ((r.roleKey === 'ir_reporting_primary' || r.roleKey === 'ir_reporting_alternate') && typeof r.certificateOnFile === 'boolean') {
    return `${base} (DIBNet certificate ${r.certificateOnFile ? 'on file' : 'not on file'})`;
  }
  return base;
}

/** 1.1: the identifier and the categorization (what was saved, never a suggestion). */
export function sspIdentificationItems(profile: SspProfile | null | undefined): SspOutputItem[] {
  const p = profile ?? null;
  const id = (p?.systemIdentifier ?? '').trim();
  return [
    { label: 'System Unique Identifier', value: id || NOT_RECORDED },
    { label: 'Confidentiality Impact', value: p?.confidentialityImpact ?? NOT_RECORDED },
    { label: 'Integrity Impact', value: p?.integrityImpact ?? NOT_RECORDED },
    { label: 'Availability Impact', value: p?.availabilityImpact ?? NOT_RECORDED },
    { label: 'Overall Security Categorization', value: overallImpact(p) ?? NOT_RECORDED },
  ];
}

/**
 * 1.2: the roles as recorded (the legacy System Owner text stands in until a System Owner row is saved), then a "Not recorded" row for each
 * role this framework requires that has no row at all.
 */
export function sspRoleRows(a: { profile: SspProfile | null | undefined; legacySystemOwner?: string; framework: string }): SspOutputRoleRow[] {
  const profile = a.profile ?? null;
  const roles = effectiveSspRoles(profile, a.legacySystemOwner);
  const rows: SspOutputRoleRow[] = roles.map((r) => ({
    role: sspRoleTitle(r),
    name: r.name.trim() || NOT_RECORDED,
    email: r.email.trim(),
  }));
  const required = computeSspCompleteness({ framework: a.framework, metadata: { systemOwner: a.legacySystemOwner ?? '' }, profile })
    .sections.flatMap((s) => s.items)
    .filter((i) => i.sectionId === 'roles' && i.severity === 'required' && i.missing);
  for (const item of required) {
    const key = item.id.slice('role:'.length);
    if (roles.some((r) => r.roleKey === key)) continue; // a stored row without a name already prints as not recorded
    rows.push({ role: item.label, name: NOT_RECORDED, email: '' });
  }
  return rows;
}

/** The same rows as "Name (email)" lines, for the plain-text and Markdown outputs. */
export function sspRoleLines(a: { profile: SspProfile | null | undefined; legacySystemOwner?: string; framework: string }): SspOutputItem[] {
  return sspRoleRows(a).map((r) => ({ label: r.role, value: r.name === NOT_RECORDED ? NOT_RECORDED : r.email === '' ? r.name : `${r.name} (${r.email})` }));
}

const yesNo = (v: boolean | null | undefined): string => (v === true ? 'Yes' : v === false ? 'No' : NOT_RECORDED);

/** 2.3: the four answers (Yes, No or Not recorded). */
export function sspMaintenanceItems(profile: SspProfile | null | undefined): SspOutputItem[] {
  const m = profile?.maintenance;
  return [
    { label: 'Hardware maintained by the organization', value: yesNo(m?.hardwareMaintainedByOrg) },
    { label: 'Hardware owned by the organization', value: yesNo(m?.hardwareOwnedByOrg) },
    { label: 'Software maintained by the organization', value: yesNo(m?.softwareMaintainedByOrg) },
    { label: 'Software owned by the organization', value: yesNo(m?.softwareOwnedByOrg) },
  ];
}

/** 2.3: the exceptions as recorded, or the sentence saying there are none. */
export function sspMaintenanceExceptions(profile: SspProfile | null | undefined): string {
  const e = (profile?.maintenance?.exceptions ?? '').trim();
  return e === '' ? NO_MAINTENANCE_EXCEPTIONS_RECORDED : e;
}
