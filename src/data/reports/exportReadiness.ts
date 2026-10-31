import type { ReportDocumentType, ReportMetadata } from '../../types/report';

export interface ExportGap {
  /** The ReportMetadata field that is empty. */
  field: keyof ReportMetadata;
  label: string;
  /** Advisory gaps do not stop an export; they only say the document will print "not recorded". */
  advisory?: boolean;
}

const LABELS: Partial<Record<keyof ReportMetadata, string>> = {
  systemName: 'System name',
  organizationName: 'Organization name',
  systemOwner: 'System owner',
  primaryAssessor: 'Assessor or author',
  boundaryDescription: 'System boundary description',
  cageCode: 'CAGE code',
  samStatus: 'SAM.gov registration status',
};

const REQUIRED: Record<ReportDocumentType, (keyof ReportMetadata)[]> = {
  NIST_SP_800_18_SSP: ['systemName', 'organizationName', 'systemOwner', 'primaryAssessor', 'boundaryDescription'],
  SOC_2_SYSTEM_DESCRIPTION: ['organizationName', 'systemName', 'systemOwner', 'boundaryDescription'],
  POAM: ['systemName', 'organizationName', 'systemOwner'],
  HIPAA_SECURITY_ASSESSMENT: ['organizationName', 'systemName', 'systemOwner', 'boundaryDescription'],
};

const ADVISORY: Partial<Record<ReportDocumentType, (keyof ReportMetadata)[]>> = {
  NIST_SP_800_18_SSP: ['cageCode', 'samStatus'],
};

/** The recorded values a document of this type would otherwise print as "not recorded" (#151). Pure; a blank or whitespace-only value is a gap. */
export function getExportGaps(docType: ReportDocumentType, meta: Partial<ReportMetadata>): ExportGap[] {
  const empty = (field: keyof ReportMetadata) => {
    const v = meta[field];
    return typeof v !== 'string' || v.trim() === '';
  };
  const gaps: ExportGap[] = [];
  for (const field of REQUIRED[docType] ?? []) {
    if (empty(field)) gaps.push({ field, label: LABELS[field] ?? String(field) });
  }
  for (const field of ADVISORY[docType] ?? []) {
    if (empty(field)) gaps.push({ field, label: LABELS[field] ?? String(field), advisory: true });
  }
  return gaps;
}
