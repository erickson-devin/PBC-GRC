// What the vendor register screens say and decide (#248): fixed copy, labels, the vendor form (validation, three-way merge after a stale write),
// error and confirmation texts, and the document helpers. Pure: types plus inventoryUiView; nothing here touches storage, the network, the clock or
// the log. Vendor names, services and notes may be CUI: no text here ever echoes a server message or a value, and the confirmation texts never
// carry a vendor name or a file name.

import type { EvidenceItem } from '../../types/cmmc';
import type { FedrampStatus, InventoryTool, InventoryVendor, VendorDocumentKind, VendorDocumentLink, VendorKind } from '../../types/inventory';
import type { VendorInput } from './inventorySchema';
import { isRealDate } from './inventoryUiView';

export const VENDOR_UI_TEXT = {
  title: 'Vendors and External Service Providers',
  intro: 'Vendors, cloud service providers and managed service providers: contracts, renewal, FedRAMP status or equivalency, the CRM / SRM on file and when you last reviewed them. Shared by every program; documents are linked per program.',
  unsupported: 'The vendor register is kept on the server, so it needs a server-backed organization.',
  readOnly: 'Read-only: only a Tenant Owner or Admin can change the vendor register.',
  loading: 'Loading the vendor register…',
  loadFailed: 'The vendor register could not be loaded.',
  emptyEditor: 'No vendors recorded yet. Add the vendors and service providers behind your tools.',
  emptyReader: 'No vendors recorded yet. A Tenant Owner or Admin can add them.',
  emptyFiltered: 'No vendors match your search and filter.',
  docsNoProgram: 'Open a program to link documents: evidence belongs to a program.',
  docsIntro: 'Documents for this vendor in this program. Each is an Evidence Vault file; unlinking keeps the file.',
  docsEmpty: 'No documents linked in this program yet.',
  docsRemoved: 'File removed from the Evidence Vault',
  uploadHint: 'Evidence is always filed under a control. The suggestion is the control about external service providers; choose another if it fits better.',
  unlinkConfirm: 'Unlink this document from the vendor? The file stays in the Evidence Vault.',
  staleVendor: 'Someone else changed this vendor while you were editing. Nothing was saved. Your entries are kept; fields only they changed now show their values. Check the highlighted fields, then save again.',
  vendorGone: 'This vendor was removed meanwhile. Nothing was saved.',
  conflictField: 'Changed by someone else too: check this value.',
  reviewHint: "The last time you reviewed this provider's security posture and documents.",
} as const;

export const VENDOR_KIND_LABELS: Record<VendorKind, string> = {
  VENDOR: 'Vendor',
  CSP: 'Cloud service provider',
  MSP: 'Managed service provider',
  MSSP: 'Managed security service provider',
  OTHER_ESP: 'Other external service provider',
};

export const DOC_KIND_LABELS: Record<VendorDocumentKind, string> = {
  CRM: 'Customer responsibility matrix (CRM)',
  SRM: 'Shared responsibility matrix (SRM)',
  CONTRACT: 'Contract',
  FEDRAMP_PACKAGE: 'FedRAMP package',
  ATTESTATION: 'Attestation',
  OTHER: 'Other',
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// ---- The vendor form ----

export interface VendorForm {
  name: string;
  kind: VendorKind;
  services: string;
  contractStart: string;
  contractEnd: string;
  renewalDate: string;
  fedrampStatus: FedrampStatus;
  fedrampReference: string;
  fedrampVerifiedOn: string;
  crmOnFile: 'yes' | 'no' | 'unset';
  lastReviewDate: string;
  notes: string;
}

export type VendorFormField = keyof VendorForm;

const triToForm = (b: boolean | null | undefined): 'yes' | 'no' | 'unset' => (b === true ? 'yes' : b === false ? 'no' : 'unset');

/** The form for an existing vendor, or an empty one for a new vendor. */
export function vendorFormFrom(v: InventoryVendor | null): VendorForm {
  return {
    name: v?.name ?? '',
    kind: v?.kind ?? 'VENDOR',
    services: v?.services ?? '',
    contractStart: v?.contractStart ?? '',
    contractEnd: v?.contractEnd ?? '',
    renewalDate: v?.renewalDate ?? '',
    fedrampStatus: v?.fedrampStatus ?? 'UNKNOWN',
    fedrampReference: v?.fedrampReference ?? '',
    fedrampVerifiedOn: v?.fedrampVerifiedOn ?? '',
    crmOnFile: triToForm(v?.crmOnFile),
    lastReviewDate: v?.lastReviewDate ?? '',
    notes: v?.notes ?? '',
  };
}

const DATE_ERROR = 'Enter a real date (YYYY-MM-DD), or leave it blank.';

/** Why the form cannot be saved, per field, and otherwise the input to send. */
export function validateVendorForm(f: VendorForm, today: string): { input: VendorInput | null; errors: Partial<Record<VendorFormField, string>> } {
  const errors: Partial<Record<VendorFormField, string>> = {};
  if (f.name.trim() === '') errors.name = 'Enter the vendor name.';
  const start = f.contractStart.trim();
  const end = f.contractEnd.trim();
  const renewal = f.renewalDate.trim();
  const verified = f.fedrampVerifiedOn.trim();
  const review = f.lastReviewDate.trim();
  if (start !== '' && !isRealDate(start)) errors.contractStart = DATE_ERROR;
  if (end !== '' && !isRealDate(end)) errors.contractEnd = DATE_ERROR;
  if (renewal !== '' && !isRealDate(renewal)) errors.renewalDate = DATE_ERROR;
  if (verified !== '') {
    if (!isRealDate(verified)) errors.fedrampVerifiedOn = DATE_ERROR;
    else if (verified > today) errors.fedrampVerifiedOn = 'The date you checked cannot be in the future.';
  }
  if (review !== '') {
    if (!isRealDate(review)) errors.lastReviewDate = DATE_ERROR;
    else if (review > today) errors.lastReviewDate = 'The review date cannot be in the future.';
  }
  if (!errors.contractStart && !errors.contractEnd && start !== '' && end !== '' && end < start) {
    errors.contractEnd = 'The contract end date must be on or after the start date.';
  }
  if (Object.keys(errors).length > 0) return { input: null, errors };
  const input: VendorInput = {
    name: f.name.trim(),
    kind: f.kind,
    services: f.services.trim(),
    contractStart: start === '' ? null : start,
    contractEnd: end === '' ? null : end,
    renewalDate: renewal === '' ? null : renewal,
    fedrampStatus: f.fedrampStatus,
    fedrampReference: f.fedrampReference.trim(),
    fedrampVerifiedOn: verified === '' ? null : verified,
    crmOnFile: f.crmOnFile === 'yes' ? true : f.crmOnFile === 'no' ? false : null,
    lastReviewDate: review === '' ? null : review,
    notes: f.notes.trim(),
  };
  return { input, errors };
}

const FORM_FIELDS: VendorFormField[] = [
  'name', 'kind', 'services', 'contractStart', 'contractEnd', 'renewalDate', 'fedrampStatus', 'fedrampReference', 'fedrampVerifiedOn',
  'crmOnFile', 'lastReviewDate', 'notes',
];

const norm = (f: VendorForm, k: VendorFormField): string => f[k].trim();

/** Three-way merge after a stale write: fields the person did not touch take the new server value; conflicts = touched by both, to different values. */
export function rebaseVendorForm(oldBase: InventoryVendor, newBase: InventoryVendor, form: VendorForm): { form: VendorForm; conflicts: VendorFormField[] } {
  const was = vendorFormFrom(oldBase);
  const now = vendorFormFrom(newBase);
  const next: VendorForm = { ...now };
  const conflicts: VendorFormField[] = [];
  for (const k of FORM_FIELDS) {
    if (norm(form, k) === norm(was, k)) continue;
    (next as unknown as Record<string, string>)[k] = form[k];
    if (norm(now, k) !== norm(was, k) && norm(now, k) !== norm(form, k)) conflicts.push(k);
  }
  return { form: next, conflicts };
}

// ---- Errors ----

export type VendorAction = 'save' | 'delete' | 'link' | 'unlink' | 'upload';

const DEFAULT_ERROR: Record<VendorAction, string> = {
  save: 'The vendor could not be saved. Try again.',
  delete: 'The vendor could not be removed. Try again.',
  link: 'The document could not be linked. Try again.',
  unlink: 'The document could not be unlinked. Try again.',
  upload: 'The file could not be uploaded. Try again.',
};

/** Fixed text for a refused request: never the server's message and never a value. */
export function vendorErrorMessage(err: unknown, action: VendorAction): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  switch (e.reason) {
    case 'duplicate_name': return 'A vendor with this name is already in the register (names are compared without regard to case). Nothing was saved.';
    case 'stale_write': return VENDOR_UI_TEXT.staleVendor;
    case 'not_found': return action === 'unlink' ? 'This document link was already removed. The list has been refreshed.' : 'This vendor was removed meanwhile. The list has been refreshed.';
    case 'vendor_not_found': return 'This vendor was removed meanwhile. The list has been refreshed. Nothing was linked.';
    case 'evidence_not_found': return "That file is no longer in this program's Evidence Vault. Nothing was linked.";
    case 'invalid': return 'The server did not accept these values. Check the fields and that none is too long. Nothing was saved.';
    case 'limit':
      return action === 'link' || action === 'upload'
        ? 'This vendor already has the most documents it can hold in this program (50). Unlink one you no longer need, then try again.'
        : 'The register already holds 500 vendors, the most it can hold. Remove vendors you no longer need, then try again.';
    case 'program_archived': return 'This program is archived, so its document links are read-only. Nothing was saved.';
    case 'invalid_expected_updated_at': return 'This page is out of date. Reload it and try again. Nothing was saved.';
    default: break;
  }
  if (e.status === 400) return 'The server did not accept these values. Check the fields and that none is too long. Nothing was saved.';
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change the vendor register. Nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved; try again.';
  return DEFAULT_ERROR[action];
}

// ---- The register table ----

const YEAR_DAYS = 365;

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || !isRealDate(iso)) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** "Never reviewed" (slate) or "over a year ago" (amber); null when the review is recent or the date is unreadable. */
export function reviewAge(last: string | null, today: string): { tone: 'amber' | 'slate'; text: string } | null {
  if (!last) return { tone: 'slate', text: 'Never reviewed' };
  const a = dayNumber(last);
  const b = dayNumber(today);
  if (a === null || b === null) return null;
  return b - a > YEAR_DAYS ? { tone: 'amber', text: 'Last review over a year ago' } : null;
}

/** The names of the tools linked to each vendor id, sorted without regard to case. */
export function toolsByVendor(tools: Pick<InventoryTool, 'id' | 'name' | 'vendorId'>[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tools) {
    if (!t.vendorId) continue;
    (out[t.vendorId] ??= []).push(t.name);
  }
  for (const k of Object.keys(out)) out[k].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()) || x.localeCompare(y));
  return out;
}

/** Vendors matching the search (name, services) and kind, sorted by name. */
export function filterVendors(vendors: InventoryVendor[], query: string, kind: VendorKind | 'ALL'): InventoryVendor[] {
  const q = query.trim().toLowerCase();
  return vendors
    .filter((v) => (kind === 'ALL' || v.kind === kind) && (q === '' || v.name.toLowerCase().includes(q) || v.services.toLowerCase().includes(q)))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

export function vendorCountCaption(shown: number, total: number): string {
  const word = (n: number): string => `${n} ${plural(n, 'vendor', 'vendors')}`;
  return shown === total ? word(total) : `${shown} of ${word(total)}`;
}

export function vendorEmptyMessage(a: { total: number; canEdit: boolean }): string {
  if (a.total > 0) return VENDOR_UI_TEXT.emptyFiltered;
  return a.canEdit ? VENDOR_UI_TEXT.emptyEditor : VENDOR_UI_TEXT.emptyReader;
}

/** Never carries a vendor name. */
export function removeVendorConfirmText(toolCount: number, docCount: number): string {
  void docCount; // the links of every program go; the count shown covers the open program only, so the sentence stays general
  return `Remove this vendor from the register? ${toolCount} ${plural(toolCount, 'tool is', 'tools are')} unlinked from it (they stay in the register), and its document links in every program are removed. The evidence files stay in the Evidence Vault.`;
}

// ---- Documents ----

type EvidenceLike = Pick<EvidenceItem, 'id' | 'name' | 'controlId'>;

/** The files of the open program that can be linked: inherited copies (`__inh_`) are left out; sorted by name. */
export function evidenceChoices(ev: EvidenceLike[]): { id: string; name: string; controlId: string }[] {
  return ev
    .filter((e) => !e.id.includes('__inh_'))
    .map((e) => ({ id: e.id, name: e.name, controlId: e.controlId }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

/** The control a vendor document is filed under by default (always editable): the external-service-provider control of the framework, when the catalog has it. */
export function suggestedVendorDocControl(framework: string, catalogIds: ReadonlySet<string>): string | null {
  const id = framework === 'CMMC_L2' ? 'CA.L2-3.12.4' : framework === 'NIST_800_53_REV5' ? 'SA-9' : framework === 'NIST_800_171_R3' ? '03.16.03' : null;
  return id !== null && catalogIds.has(id) ? id : null;
}

/** The links of one vendor with the file each points at; a file that is no longer in the program is `missing` (name and control null). */
export function docRows(
  links: VendorDocumentLink[],
  vendorId: string,
  ev: EvidenceLike[]
): { evidenceId: string; docKind: VendorDocumentKind; name: string | null; controlId: string | null; missing: boolean }[] {
  const byId = new Map(ev.map((e) => [e.id, e]));
  return links
    .filter((l) => l.vendorId === vendorId)
    .map((l) => {
      const e = byId.get(l.evidenceId);
      return { evidenceId: l.evidenceId, docKind: l.docKind, name: e ? e.name : null, controlId: e ? e.controlId : null, missing: !e };
    })
    .sort((a, b) => Number(a.missing) - Number(b.missing) || (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase()) || a.evidenceId.localeCompare(b.evidenceId));
}

/** Never carries the file name. */
export function uploadLinkFailedText(displayId: string): string {
  return `The file was uploaded to the Evidence Vault under ${displayId}, but it could not be linked to this vendor. Choose it under "A file already in the Evidence Vault" to try again.`;
}
