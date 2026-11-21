// CSV of the document register (#240) and of the expected documents checklist (#250). Pure: every cell goes through csvCell, so text a spreadsheet
// could read as a formula is neutralised. Enum values are written as their stored codes (stable, importable), dates as stored. Review state is
// computed from the injected `today`. Titles, owners and locations may be CUI: the file is built locally and handed to the person, nothing here
// logs or sends a value.

import type { GovernanceDocument } from '../../types/documents';
import type { ExpectedRow } from '../documents/expectedDocuments';
import { reviewState } from '../documents/documentRegisterView';
import { csvCell } from './csv';

const CRLF = '\r\n';

const line = (cells: (string | number | null | undefined)[]): string => cells.map(csvCell).join(',');

export const DOCUMENT_CSV_HEADERS = [
  'Title',
  'Reference',
  'Kind',
  'Status',
  'Version',
  'Approval date',
  'Review by',
  'Review state',
  'Owner',
  'Origin',
  'Primary copy',
  'Internal location',
  'Connected controls',
];

/**
 * One row per document given (the caller passes the rows shown). `controlCounts` and `primaryLabel` are by document id: the number of controls linked
 * in the active program and the primary copy as the screen words it (a file name, "File removed" or the location); a missing entry is 0 and blank.
 */
export function documentRegisterCsv(
  docs: GovernanceDocument[],
  o: { today: string; controlCounts: Record<string, number>; primaryLabel: Record<string, string> }
): string {
  const rows = docs.map((d) =>
    line([
      d.title,
      d.reference,
      d.kind,
      d.status,
      d.version,
      d.approvalDate ?? '',
      d.reviewBy ?? '',
      reviewState(d, o.today),
      d.owner,
      d.origin,
      o.primaryLabel[d.id] ?? '',
      d.locationUrl ?? '',
      o.controlCounts[d.id] ?? 0,
    ])
  );
  return [line(DOCUMENT_CSV_HEADERS), ...rows].join(CRLF) + CRLF;
}

export const EXPECTED_DOCUMENTS_CSV_HEADERS = ['Expected document', 'Requirement', 'Kind', 'Status', 'Review overdue', 'Satisfied by', 'Controls', 'Description'];

/** One row per checklist entry: PRESENT / DRAFT_ONLY / MISSING, and the titles of the register documents a person linked (`titlesById`). Suggestions are not written: they count for nothing. */
export function expectedDocumentsCsv(rows: ExpectedRow[], titlesById: Record<string, string>): string {
  const body = rows.map((r) =>
    line([
      r.entry.name,
      r.entry.requirement,
      r.entry.kind,
      r.state,
      r.overdue ? 'Yes' : 'No',
      r.satisfiedBy.map((id) => titlesById[id] ?? '').filter((t) => t !== '').join('; '),
      r.entry.controls.join('; '),
      r.entry.description,
    ])
  );
  return [line(EXPECTED_DOCUMENTS_CSV_HEADERS), ...body].join(CRLF) + CRLF;
}
