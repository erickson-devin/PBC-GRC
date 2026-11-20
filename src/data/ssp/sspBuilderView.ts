// What the SSP builder's section screens say and decide (#238, #241, #242, #246): every label, status line and edit of the profile that a
// component shows lives here so a test can pin it. Pure: types and the shared SSP modules only. Nothing here prints a profile value in an
// error text (values can be CUI) and no digest is ever formatted for display.

import type { SspProfileSaveError } from '../../hooks/useSspProfile';
import type { ProgramBaseline } from '../../types/program';
import type { TeamMember } from '../../types/tenant';
import {
  SSP_ROLE_KEYS,
  validateSspProfile,
  type ImpactLevel,
  type SspMaintenance,
  type SspProfile,
  type SspRoleEntry,
  type SspRoleKey,
  type SspSectionReview,
  type SspSectionReviewState,
} from '../../types/sspProfile';
import { ROLE_LABELS } from '../../utils/roles';
import { sectionReviewStatus, type SspCompleteness, type SspReviewStatus, type SspSectionStatus } from './sspCompleteness';
import {
  MAINTENANCE_DOMAIN,
  SSP_ROLE_LABELS,
  SSP_SECTIONS,
  overallImpact,
  suggestedCategorization,
  type SspSectionId,
} from './sspSections';
import { inventoryNavText } from './sspInventoryView';

export const SSP_BUILDER_TEXT = {
  readOnly: "You have read-only access. Editing and sign-off are disabled; each section's sign-offs and their history are shown with it.",
  browserOnly: 'These details are kept in this browser only. Section sign-off needs a server-backed organization.',
  reviewCovers: "A review records who checked this section's saved SSP fields, and when. It does not cover the program boundary summary, asset counts, FIPS modules, control statements or evidence. Any later change to these fields shows the section as changed since review.",
  reviewUnsupported: 'Sign-off needs a server-backed organization. The completeness counts still apply.',
  reviewReadOnly: 'Only a Tenant Owner or Admin can mark a section reviewed.',
  reviewLoading: 'Loading sign-offs…',
  reviewLoadFailed: 'The sign-offs could not be loaded.',
  notReviewed: 'Not reviewed yet.',
  markReviewed: 'Mark section reviewed',
  marking: 'Recording…',
  marked: 'Marked reviewed.',
  alreadyMarked: 'You had already marked this version reviewed. Nothing new was recorded.',
  sectionChanged: 'This section changed since it loaded; check it and mark it again.',
  waitForSave: 'Wait until the changes are saved.',
  profileLoadFailed: 'The categorization, roles and maintenance answers could not be loaded. Those fields stay read-only until they load.',
  profileStale: 'Someone else changed the categorization, roles or maintenance answers on the server, so your last change there was not saved. Reload to see the current version, then make your change again.',
  suggestionNotSaved: 'Nothing is saved until you apply it, and it does not count as recorded.',
  legacyOwner: 'From the previous System owner field. It is stored as this role the first time you change this section.',
  memberGone: 'No longer an active team member. The SSP still prints the name and email recorded here; choose someone else if the role has moved.',
  memberCopied: 'Name and email are copied from the team list. Choose "Not a team member" to type them.',
  teamFailed: 'The team list could not be loaded, so names and emails must be typed.',
  teamLoading: 'Loading the team list…',
  rolesNotSaved: 'Not saved: fix the highlighted fields first.',
  rolesLimit: 'An SSP holds at most 40 roles.',
  removeRoleConfirm: 'Remove this custom role, with its name and email, from the SSP? The change is saved at once.',
  certificate: 'DIBNet medium-assurance certificate on file',
  certificateHint: 'Only whether one is on file is recorded, no certificate details.',
  exceptionsRequired: 'Required because at least one answer is No: name the hardware or software and who maintains or owns it.',
  exceptionsOptional: 'Optional while every answer is Yes or not answered.',
  boundaryFallback: "Blank here: the SSP prints the program's boundary summary instead.",
} as const;

export function missingLabel(n: number): string {
  return `${n} required ${n === 1 ? 'item' : 'items'} missing`;
}

export function advisoryLabel(n: number): string | null {
  return n <= 0 ? null : `${n} optional ${n === 1 ? 'item' : 'items'} missing`;
}

/** UTC, to the minute: "2026-11-19 14:05 UTC". The browser's locale is deliberately not used so the text is the same everywhere. */
export function formatReviewTime(at: string): string {
  const d = new Date(at);
  if (typeof at !== 'string' || Number.isNaN(d.getTime())) return 'an unknown time';
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface ReviewChipView {
  tone: 'slate' | 'emerald' | 'amber';
  text: string;
}

export function reviewChipView(s: SspReviewStatus, latest: SspSectionReview | null, loading: boolean): ReviewChipView | null {
  if (loading || s === 'unavailable') return null;
  if (s === 'not_reviewed') return { tone: 'slate', text: 'Not reviewed' };
  if (s === 'reviewed') return { tone: 'emerald', text: `Reviewed ${latest ? formatReviewTime(latest.createdAt).slice(0, 10) : ''}`.trim() };
  return { tone: 'amber', text: 'Changed since review' };
}

export interface NavEntryView {
  id: SspSectionId;
  number: string;
  title: string;
  requiredMissing: number;
  missingText: string | null;
  complete: boolean;
  advisoryText: string | null;
  review: ReviewChipView | null;
  /** False for 1.3 and 1.4 while the register is not available: the nav then shows `unavailableText` instead of a count or a green check. */
  available: boolean;
  unavailableText: string | null;
}

/** What the nav says of 1.3.2 while the document register is not available (its own wording: the register is not the tools register). */
export function documentsNavText(status: 'unsupported' | 'loading' | 'ready' | 'error'): string | null {
  switch (status) {
    case 'unsupported':
      return 'Not available';
    case 'loading':
      return 'Loading…';
    case 'error':
      return 'Could not load';
    default:
      return null;
  }
}

export function navEntriesView(
  c: SspCompleteness,
  r: { supported: boolean; status: 'loading' | 'ready' | 'error'; sections: Partial<Record<SspSectionId, SspSectionReviewState>> },
  opts?: { inventoryStatus?: 'unsupported' | 'loading' | 'ready' | 'error'; documentsStatus?: 'unsupported' | 'loading' | 'ready' | 'error' }
): NavEntryView[] {
  return c.sections.map((s) => {
    const state = r.sections[s.sectionId] ?? null;
    const signable = SSP_SECTIONS.find((d) => d.id === s.sectionId)?.signable ?? false;
    const available = s.available;
    return {
      id: s.sectionId,
      number: s.number,
      title: s.title,
      requiredMissing: available ? s.requiredMissing : 0,
      missingText: available && s.requiredMissing > 0 ? missingLabel(s.requiredMissing) : null,
      complete: available && s.complete,
      advisoryText: available ? advisoryLabel(s.advisoryMissing) : null,
      // 1.3 and 1.4 are derived from the register and the data inventory: they are not signed off
      review: signable ? reviewChipView(sectionReviewStatus(state, r.supported), state?.latest ?? null, r.status === 'loading') : null,
      available,
      unavailableText: available ? null : s.sectionId === 'documents' ? documentsNavText(opts?.documentsStatus ?? 'unsupported') : inventoryNavText(opts?.inventoryStatus ?? 'unsupported'),
    };
  });
}

export function completenessSummary(c: SspCompleteness): string {
  return c.requiredMissing === 0 ? 'Every required item is recorded.' : `${missingLabel(c.requiredMissing)} across the SSP.`;
}

export function missingItemsLine(s: SspSectionStatus | undefined): string | null {
  const labels = (s?.items ?? []).filter((i) => i.severity === 'required' && i.missing).map((i) => i.label);
  return labels.length === 0 ? null : `Required and not recorded: ${labels.join(', ')}`;
}

export function fieldFlags(s: SspSectionStatus | undefined, itemId: string): { required: boolean; missing: boolean } {
  const item = s?.items.find((i) => i.id === itemId);
  if (!item) return { required: false, missing: false };
  const required = item.severity === 'required';
  return { required, missing: required && item.missing };
}

export function reviewLatestLine(s: SspReviewStatus, latest: SspSectionReview | null): string | null {
  if (s === 'unavailable') return null;
  if (s === 'not_reviewed' || !latest) return SSP_BUILDER_TEXT.notReviewed;
  const time = formatReviewTime(latest.createdAt);
  if (s === 'reviewed') {
    const role = (ROLE_LABELS as Record<string, string>)[latest.reviewerRole] ?? latest.reviewerRole;
    return `Reviewed by ${latest.reviewerName} (${role}) on ${time}.`;
  }
  return `Changed since ${latest.reviewerName} reviewed it on ${time}. Check the section and mark it reviewed again.`;
}

export function reviewHistoryRows(
  h: SspSectionReview[],
  sectionId: SspSectionId,
  currentDigest: string | null
): Array<{ id: string; when: string; who: string; version: 'this version' | 'an earlier version' }> {
  return h
    .filter((r) => r.sectionId === sectionId)
    .map((r) => ({
      id: r.id,
      when: formatReviewTime(r.createdAt),
      who: r.reviewerName,
      version: currentDigest !== null && r.contentSha256 === currentDigest ? ('this version' as const) : ('an earlier version' as const),
    }));
}

export function signOffDisabledReason(a: {
  savePending: boolean;
  reviewsStatus: 'loading' | 'ready' | 'error';
  profileStatus: string;
  metadataEditable: boolean;
  canSignOff: boolean;
  signing: boolean;
}): string | null {
  if (a.savePending) return SSP_BUILDER_TEXT.waitForSave;
  if (a.profileStatus === 'stale') return 'Reload the server copy first.';
  if (!a.metadataEditable || a.profileStatus === 'loading') return 'Wait until the section has loaded.';
  if (a.reviewsStatus !== 'ready') return 'Wait until the sign-offs have loaded.';
  if (a.signing) return null;
  if (!a.canSignOff) return SSP_BUILDER_TEXT.waitForSave;
  return null;
}

/** Fixed text by status and reason only: the server's message is never shown. */
export function reviewErrorText(err: unknown): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  if (e.reason === 'section_changed') return SSP_BUILDER_TEXT.sectionChanged;
  if (e.reason === 'program_archived') return 'This program is archived, so it is read-only. No sign-off was recorded.';
  if (e.reason === 'reviewer_unknown') return 'Your sign-in could not be matched to a user, so no sign-off was recorded. Sign out and in again.';
  if (e.status === 403) return SSP_BUILDER_TEXT.reviewReadOnly;
  if (e.reason === 'invalid_section' || e.reason === 'invalid_expected_digest') return 'The sign-off could not be recorded. Reload the page and try again.';
  return 'The sign-off could not be recorded. Check the connection and try again.';
}

export function profileSaveErrorText(e: SspProfileSaveError): string {
  switch (e) {
    case 'archived':
      return 'This program is archived, so it is read-only. Nothing was saved.';
    case 'invalid':
      return 'A value was refused by the server and was not saved. Check the email addresses and role titles.';
    case 'forbidden':
      return 'Only a Tenant Owner or Admin can change the SSP. Nothing was saved.';
    default:
      return 'The last change to the categorization, roles or maintenance answers was not saved. Try again.';
  }
}

export type BuilderSaveState = 'browser' | 'saving' | 'loading' | 'saved' | 'idle';

export function builderSaveState(a: {
  serverBacked: boolean;
  metadataStatus: 'browser' | 'loading' | 'ready' | 'saving' | 'saved';
  needsOwner: boolean;
  conflict: boolean;
  profileStatus: string;
  profileSaving: boolean;
}): BuilderSaveState {
  if (!a.serverBacked) return 'browser';
  if (a.metadataStatus === 'saving' || a.profileSaving) return 'saving';
  if ((a.metadataStatus === 'loading' && !a.needsOwner && !a.conflict) || a.profileStatus === 'loading') return 'loading';
  if (a.metadataStatus === 'saved') return 'saved';
  return 'idle';
}

// ---------------------------------------------------------------- 1.1 identification and categorization

const IMPACT_TEXT: Record<ImpactLevel, string> = { LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High' };

export function impactLabel(v: ImpactLevel | null | undefined): string {
  return v ? IMPACT_TEXT[v] ?? 'Not set' : 'Not set';
}

export function parseImpact(v: string): ImpactLevel | null {
  return v === 'LOW' || v === 'MODERATE' || v === 'HIGH' ? v : null;
}

export function overallLine(p: SspProfile | null): string {
  const overall = overallImpact(p);
  return overall
    ? `Overall security categorization: ${impactLabel(overall)} (the highest of the three).`
    : 'Overall security categorization: not set until all three are chosen.';
}

export interface CategorizationSuggestion {
  text: string;
  values: { confidentiality: ImpactLevel; integrity: ImpactLevel; availability: ImpactLevel };
}

export function categorizationSuggestionView(a: { framework: string; baseline: ProgramBaseline | null; profile: SspProfile | null }): CategorizationSuggestion | null {
  const s = suggestedCategorization({ framework: a.framework, baseline: a.baseline });
  if (!s) return null;
  if (a.profile?.confidentialityImpact || a.profile?.integrityImpact || a.profile?.availabilityImpact) return null;
  const triple = `${impactLabel(s.confidentiality)} / ${impactLabel(s.integrity)} / ${impactLabel(s.availability)}`;
  const text = a.framework === 'CMMC_L2' || a.framework === 'NIST_800_171_R3'
    ? `Suggested for a ${a.framework === 'CMMC_L2' ? 'CMMC Level 2' : 'NIST SP 800-171 Rev. 3'} program, which handles CUI: ${triple}.`
    : `Suggested from this program's ${impactLabel(a.baseline)} baseline: ${triple}.`;
  return { text, values: s };
}

/** Sets the three impacts and nothing else. */
export function applySuggestion(p: SspProfile | null, s: CategorizationSuggestion): SspProfile {
  return {
    ...(p ?? {}),
    confidentialityImpact: s.values.confidentiality,
    integrityImpact: s.values.integrity,
    availabilityImpact: s.values.availability,
  };
}

export function setProfileField<K extends 'systemIdentifier' | 'confidentialityImpact' | 'integrityImpact' | 'availabilityImpact'>(
  p: SspProfile | null,
  k: K,
  v: SspProfile[K]
): SspProfile {
  return { ...(p ?? {}), [k]: v };
}

// ---------------------------------------------------------------- 1.2 roles

export function pickableMembers(m: readonly TeamMember[]): Array<{ userId: string; name: string; email: string }> {
  return m
    .filter((x) => x.status === 'ACTIVE' && !x.accountDisabled && Boolean(x.userId))
    .map((x) => ({ userId: x.userId as string, name: x.name, email: x.email }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

export interface RoleRowView {
  row: SspRoleEntry;
  label: string;
  required: boolean;
  missing: boolean;
  legacy: boolean;
  memberGone: boolean;
  showCertificate: boolean;
  placeholder: boolean;
}

const FIXED_ROLE_KEYS = SSP_ROLE_KEYS.filter((k): k is Exclude<SspRoleKey, 'custom'> => k !== 'custom');
const CERTIFICATE_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'NIST_800_171_R3'];

export function roleRowsView(a: {
  rows: SspRoleEntry[];
  rolesStatus: SspSectionStatus | undefined;
  teamLoaded: boolean;
  members: readonly TeamMember[];
  legacy: boolean;
  framework: string;
}): RoleRowView[] {
  const pickable = pickableMembers(a.members);
  const gone = (r: SspRoleEntry) => a.teamLoaded && Boolean(r.memberUserId) && !pickable.some((m) => m.userId === r.memberUserId);
  const views: RoleRowView[] = [];
  for (const key of FIXED_ROLE_KEYS) {
    const stored = a.rows.filter((r) => r.roleKey === key);
    const flags = fieldFlags(a.rolesStatus, `role:${key}`);
    const certificate = (key === 'ir_reporting_primary' || key === 'ir_reporting_alternate') && CERTIFICATE_FRAMEWORKS.includes(a.framework);
    const list = stored.length > 0 ? stored : [{ id: key, roleKey: key, name: '', email: '', memberUserId: null } as SspRoleEntry];
    list.forEach((row, i) => {
      views.push({
        row,
        label: SSP_ROLE_LABELS[key],
        required: i === 0 && flags.required,
        missing: i === 0 && flags.missing,
        legacy: a.legacy && key === 'system_owner' && i === 0,
        memberGone: gone(row),
        showCertificate: certificate,
        placeholder: stored.length === 0,
      });
    });
  }
  for (const row of a.rows.filter((r) => r.roleKey === 'custom')) {
    views.push({
      row,
      label: (row.customTitle ?? '').trim() || SSP_ROLE_LABELS.custom,
      required: false,
      missing: false,
      legacy: false,
      memberGone: gone(row),
      showCertificate: false,
      placeholder: false,
    });
  }
  return views;
}

/** Edits a row in place; a row that is not stored yet (an empty fixed role) is appended. */
export function editRoleRow(
  rows: SspRoleEntry[],
  t: { rowId: string; roleKey: SspRoleKey },
  patch: Partial<Omit<SspRoleEntry, 'id' | 'roleKey'>>
): SspRoleEntry[] {
  if (rows.some((r) => r.id === t.rowId)) return rows.map((r) => (r.id === t.rowId ? { ...r, ...patch } : r));
  let id: string = t.roleKey;
  for (let n = 2; rows.some((r) => r.id === id); n++) id = `${t.roleKey}-${n}`;
  return [...rows, { id, roleKey: t.roleKey, name: '', email: '', memberUserId: null, ...patch }];
}

/** '' means "not a team member": the link goes, the name and email stay. A member's name and email are copied (a snapshot). */
export function selectMember(
  rows: SspRoleEntry[],
  row: SspRoleEntry,
  userId: string,
  pickable: ReturnType<typeof pickableMembers>
): SspRoleEntry[] {
  const target = { rowId: row.id, roleKey: row.roleKey };
  if (userId === '') return editRoleRow(rows, target, { memberUserId: null });
  const member = pickable.find((m) => m.userId === userId);
  if (!member) return rows;
  return editRoleRow(rows, target, { memberUserId: member.userId, name: member.name, email: member.email });
}

export function addCustomRole(rows: SspRoleEntry[]): { rows: SspRoleEntry[]; id: string } {
  let highest = 0;
  for (const r of rows) {
    const m = /^custom-(\d+)$/.exec(r.id);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  const id = `custom-${highest + 1}`;
  return { rows: [...rows, { id, roleKey: 'custom', customTitle: '', name: '', email: '', memberUserId: null }], id };
}

export function removeRoleRow(rows: SspRoleEntry[], id: string): SspRoleEntry[] {
  return rows.filter((r) => r.id !== id);
}

export function isBlankRole(r: SspRoleEntry): boolean {
  return r.name.trim() === '' && r.email.trim() === '' && (r.customTitle ?? '').trim() === '' && !r.memberUserId && r.certificateOnFile !== true;
}

/** What is sent to the server: the rows that hold something. */
export function rolesForSave(rows: SspRoleEntry[]): SspRoleEntry[] {
  return rows.filter((r) => !isBlankRole(r));
}

/** Which field of a row the server would refuse, with fixed text (never the value). */
export function roleRowError(r: SspRoleEntry): { field: 'customTitle' | 'name' | 'email'; text: string } | null {
  const res = validateSspProfile({ roles: [r] });
  if (res.ok) return null;
  const field = /^roles\[0\]\.(\w+)/.exec(res.error)?.[1];
  if (field === 'email') return { field: 'email', text: 'Enter a valid email address, or leave it blank.' };
  if (field === 'customTitle') return { field: 'customTitle', text: 'Enter a role title (128 characters or fewer).' };
  return { field: 'name', text: 'Use 128 characters or fewer.' };
}

export function isLegacyOwnerShown(p: SspProfile | null, legacySystemOwner: string): boolean {
  return !(p?.roles ?? []).some((r) => r.roleKey === 'system_owner') && legacySystemOwner.trim() !== '';
}

// ---------------------------------------------------------------- 2.3 maintenance

export const MAINTENANCE_QUESTIONS: ReadonlyArray<{
  key: 'hardwareMaintainedByOrg' | 'hardwareOwnedByOrg' | 'softwareMaintainedByOrg' | 'softwareOwnedByOrg';
  label: string;
}> = [
  { key: 'hardwareMaintainedByOrg', label: "Is the system's hardware maintained by your organization?" },
  { key: 'hardwareOwnedByOrg', label: "Is the system's hardware owned by your organization?" },
  { key: 'softwareMaintainedByOrg', label: "Is the system's software maintained by your organization?" },
  { key: 'softwareOwnedByOrg', label: "Is the system's software owned or licensed by your organization?" },
];

export function emptyMaintenance(): SspMaintenance {
  return {
    hardwareMaintainedByOrg: null,
    hardwareOwnedByOrg: null,
    softwareMaintainedByOrg: null,
    softwareOwnedByOrg: null,
    exceptions: '',
  };
}

export function radioValue(b: boolean | null | undefined): 'yes' | 'no' | 'unset' {
  return b === true ? 'yes' : b === false ? 'no' : 'unset';
}

export function setMaintenanceAnswer(p: SspProfile | null, k: (typeof MAINTENANCE_QUESTIONS)[number]['key'], v: 'yes' | 'no' | 'unset'): SspProfile {
  return { ...(p ?? {}), maintenance: { ...(p?.maintenance ?? emptyMaintenance()), [k]: v === 'yes' ? true : v === 'no' ? false : null } };
}

export function setMaintenanceExceptions(p: SspProfile | null, text: string): SspProfile {
  return { ...(p ?? {}), maintenance: { ...(p?.maintenance ?? emptyMaintenance()), exceptions: text } };
}

export function exceptionsRequired(m: SspMaintenance | undefined): boolean {
  return Boolean(m) && (m!.hardwareMaintainedByOrg === false || m!.hardwareOwnedByOrg === false || m!.softwareMaintainedByOrg === false || m!.softwareOwnedByOrg === false);
}

/** The maintenance (MA) controls of the active framework, for the links under 2.3. Domain compared as text: the type lists only six codes. */
export function maintenanceControlLinks(
  c: ReadonlyArray<{ id: string; title: string; domain: string }>,
  displayId: (id: string) => string
): Array<{ id: string; displayId: string; title: string }> {
  return c.filter((x) => String(x.domain) === MAINTENANCE_DOMAIN).map((x) => ({ id: x.id, displayId: displayId(x.id), title: x.title }));
}

// ---------------------------------------------------------------- export modal

export function exportGapTarget(g: { field: string; sspSection?: SspSectionId }): { kind: 'ssp'; section: SspSectionId } | { kind: 'field'; field: string } {
  if (g.sspSection) return { kind: 'ssp', section: g.sspSection };
  if (g.field === 'systemOwner') return { kind: 'ssp', section: 'roles' };
  return { kind: 'field', field: g.field };
}
