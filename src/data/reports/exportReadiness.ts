import type { ReportDocumentType, ReportMetadata } from '../../types/report';
import type { SspProfile } from '../../types/sspProfile';
import type { SspInventoryCompletenessInput } from '../inventory/sspInventory';
import type { SspDocumentsCompletenessInput } from '../documents/sspDocuments';
import { computeSspCompleteness, sspCompletenessFromReport } from '../ssp/sspCompleteness';
import type { SspSectionId } from '../ssp/sspSections';

export interface ExportGap {
  /** The ReportMetadata field that is empty; for an SSP profile item (no ReportMetadata field) the completeness item id, e.g. 'role:isso_ciso'. */
  field: string;
  label: string;
  /** Advisory gaps do not stop an export; they only say the document will print "not recorded". */
  advisory?: boolean;
  /** Set on an SSP profile gap: the builder section where it is filled in. */
  sspSection?: SspSectionId;
}

const LABELS: Partial<Record<keyof ReportMetadata, string>> = {
  systemName: 'System name',
  organizationName: 'Organization name',
  systemOwner: 'System owner',
  primaryAssessor: 'Assessor or author',
  boundaryDescription: 'System boundary description',
  cageCode: 'CAGE code',
  samStatus: 'SAM.gov registration status',
  serviceCommitments: 'Principal service commitments',
};

// The SSP's lists come from the completeness registry (sspCompleteness.ts): the registry decides which of these fields are required and
// which advisory; this is only the order they are listed in.
const SSP_REPORT_FIELD_ORDER: (keyof ReportMetadata)[] = ['systemName', 'organizationName', 'systemOwner', 'primaryAssessor', 'boundaryDescription', 'cageCode', 'samStatus'];

const REQUIRED: Record<ReportDocumentType, (keyof ReportMetadata)[]> = {
  NIST_SP_800_18_SSP: [],
  SOC_2_SYSTEM_DESCRIPTION: ['organizationName', 'systemName', 'systemOwner', 'boundaryDescription'],
  POAM: ['systemName', 'organizationName', 'systemOwner'],
  HIPAA_SECURITY_ASSESSMENT: ['organizationName', 'systemName', 'systemOwner', 'boundaryDescription'],
  HARDWARE_INVENTORY: ['systemName', 'organizationName', 'systemOwner'],
  SOFTWARE_INVENTORY: ['systemName', 'organizationName', 'systemOwner'],
};

const ADVISORY: Partial<Record<ReportDocumentType, (keyof ReportMetadata)[]>> = {
  NIST_SP_800_18_SSP: [],
  SOC_2_SYSTEM_DESCRIPTION: ['serviceCommitments'],
};

/**
 * The recorded values a document of this type would otherwise print as "not recorded" (#151). Pure; a blank or whitespace-only value is a gap.
 * With `ssp` (the program's profile and framework) an SSP also lists the profile items that have no ReportMetadata field (identifier,
 * categorization, the other roles, maintenance), each with the builder section to open; without it the result is the report fields only.
 * With `ssp.inventory` (the Tools and Services register and the data inventory) it also lists the items of sections 1.3 and 1.4: for a CMMC Level 2
 * program a missing CUI category is a gap that stops the export, missing user counts are advisory.
 * With `ssp.documents` (the document register) it also lists the items of section 1.3.2, every one advisory: they never stop an export.
 */
export function getExportGaps(docType: ReportDocumentType, meta: Partial<ReportMetadata>, ssp?: { profile: SspProfile | null; framework: string; inventory?: SspInventoryCompletenessInput; documents?: SspDocumentsCompletenessInput }): ExportGap[] {
  const empty = (field: keyof ReportMetadata) => {
    const v = meta[field];
    return typeof v !== 'string' || v.trim() === '';
  };
  const gaps: ExportGap[] = [];
  if (docType === 'NIST_SP_800_18_SSP') {
    const items = computeSspCompleteness(sspCompletenessFromReport({ ...meta, framework: (ssp?.framework ?? meta.framework) as ReportMetadata['framework'] }, ssp?.profile ?? null, ssp?.inventory, ssp?.documents)).sections.flatMap((s) => s.items);
    const byField = new Map(items.filter((i) => i.reportField).map((i) => [i.reportField as string, i]));
    for (const advisory of [false, true]) {
      for (const field of SSP_REPORT_FIELD_ORDER) {
        const item = byField.get(field);
        if (!item || item.missing !== true || (item.severity === 'advisory') !== advisory) continue;
        gaps.push({ field, label: LABELS[field] ?? String(field), ...(advisory ? { advisory: true } : {}) });
      }
    }
    if (ssp) {
      for (const severity of ['required', 'advisory'] as const) {
        for (const item of items) {
          if (item.reportField || !item.missing || item.severity !== severity) continue;
          gaps.push({ field: item.id, label: item.label, sspSection: item.sectionId, ...(severity === 'advisory' ? { advisory: true } : {}) });
        }
      }
    }
    return gaps;
  }
  for (const field of REQUIRED[docType] ?? []) {
    if (empty(field)) gaps.push({ field, label: LABELS[field] ?? String(field) });
  }
  for (const field of ADVISORY[docType] ?? []) {
    if (empty(field)) gaps.push({ field, label: LABELS[field] ?? String(field), advisory: true });
  }
  return gaps;
}
