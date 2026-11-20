// What the expected-documents checklist says and decides (#250): fixed copy, the state of each row, the counts lines, the suggestion and generate rules and the
// file names. Pure: the checklist data, the register types and the draft generator's family list only; nothing here touches storage, the network, the clock or
// the log. "Today" is injected by the caller. A suggestion is never a link and a generated draft is never present: only a linked, approved document with a
// copy on file in the program counts.

import type { GovernanceDocument } from '../../types/documents';
import type { ExpectedDocument, ExpectedRow } from './expectedDocuments';
import { canGenerateDraft, generatedSeedKey } from './generatedDrafts';
import type { DocumentForm } from './documentUiView';

export const EXPECTED_UI_TEXT = {
  title: 'Expected documents',
  intro: "Documents an assessor usually expects for this program's framework, checked against the Document Register. A document counts as present when it is linked here, approved, and has a copy on file in this program.",
  noProgram: "Open a program to see its expected documents: the checklist follows the program's framework and baseline.",
  unsupported: 'The expected-documents checklist needs the Document Register, which needs a server-backed organization.',
  loading: 'Loading the expected documents…',
  loadFailed: 'The expected-documents list could not be loaded.',
  none: 'No expected documents are listed for this framework.',
  suggestionIntro: 'Suggested from the title and kind. It does not count until you confirm it.',
  suggestionHidden: 'Suggestion hidden until you reload the page.',
  unlinkConfirm: 'Unlink this document from the expected document? The document stays in the register.',
  generateHint: 'Creates a draft in the register from the policy generator. It does not count as present until a person reviews it, attaches the reviewed copy and approves it.',
  readOnly: 'Read-only: only a Tenant Owner or Admin can link, register or generate documents.',
  unverified: 'This list has not yet been checked by a person. It is a starting point, not an assessor\'s requirement list.',
  recommendedHint: 'Not implied by a control requirement, but often asked for.',
} as const;

export type ExpectedRowState = 'PRESENT' | 'DRAFT_ONLY' | 'NO_COPY' | 'MISSING';

/** PRESENT; any linked draft: DRAFT_ONLY; any linked approved document without a copy on file: NO_COPY; else MISSING (nothing linked, or only retired ones). */
export function expectedRowState(row: ExpectedRow, docsById: Record<string, GovernanceDocument>): ExpectedRowState {
  if (row.present) return 'PRESENT';
  const linked = row.satisfiedBy.map((id) => docsById[id]).filter((d): d is GovernanceDocument => !!d && d.status !== 'RETIRED');
  if (linked.some((d) => d.status === 'DRAFT')) return 'DRAFT_ONLY';
  if (linked.some((d) => d.status === 'APPROVED')) return 'NO_COPY';
  return 'MISSING';
}

export const ROW_STATE_VIEW: Record<ExpectedRowState, { tone: 'emerald' | 'amber' | 'rose'; text: string; detail: string }> = {
  PRESENT: { tone: 'emerald', text: 'Present', detail: 'Approved, with a copy on file.' },
  DRAFT_ONLY: { tone: 'amber', text: 'Draft only', detail: 'A linked document is still a draft. It counts once a person approves it.' },
  NO_COPY: { tone: 'amber', text: 'Approved, no copy on file', detail: 'Attach the file or record its location in this program.' },
  MISSING: { tone: 'rose', text: 'Missing', detail: 'No approved document is linked.' },
};

export type RowFilter = 'ALL' | 'MISSING' | 'NOT_READY' | 'PRESENT';

/** Whether a row with this state shows under the filter (NOT_READY is DRAFT_ONLY plus NO_COPY). */
export function rowMatchesFilter(state: ExpectedRowState, filter: RowFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'MISSING') return state === 'MISSING';
  if (filter === 'PRESENT') return state === 'PRESENT';
  return state === 'DRAFT_ONLY' || state === 'NO_COPY';
}

/** Row counts per filter, EXPECTED entries only (the recommended ones are counted apart). */
export function rowFilterCounts(rows: ExpectedRow[], docsById: Record<string, GovernanceDocument>): Record<RowFilter, number> {
  const out: Record<RowFilter, number> = { ALL: 0, MISSING: 0, NOT_READY: 0, PRESENT: 0 };
  for (const r of rows) {
    if (r.entry.requirement !== 'EXPECTED') continue;
    const s = expectedRowState(r, docsById);
    out.ALL += 1;
    if (s === 'MISSING') out.MISSING += 1;
    else if (s === 'PRESENT') out.PRESENT += 1;
    else out.NOT_READY += 1;
  }
  return out;
}

export function presentLine(c: { present: number; total: number }): string {
  return `${c.present} of ${c.total} expected documents present`;
}

export function recommendedLine(c: { recommendedPresent: number; recommendedTotal: number }): string | null {
  return c.recommendedTotal === 0 ? null : `Recommended: ${c.recommendedPresent} of ${c.recommendedTotal} present`;
}

export function overdueLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 present document is past its review date. It still counts; review it.' : `${n} present documents are past their review date. They still count; review them.`;
}

/** The suggested register documents of a row that the person has not dismissed this session. */
export function visibleSuggestions(row: ExpectedRow, dismissed: ReadonlySet<string>): string[] {
  return row.suggestions.filter((id) => !dismissed.has(`${row.entry.id}:${id}`));
}

/**
 * What "Generate draft" does for an entry: nothing when the generator cannot draft it (or it is not a policy), or when the generated draft is already
 * linked; link the draft already in the register; or create it. The seed key keeps one generated row per framework and family.
 */
export function generateAction(
  entry: ExpectedDocument,
  docs: GovernanceDocument[],
  row: ExpectedRow,
  framework: string
): { kind: 'generate'; seedKey: string } | { kind: 'link_existing'; seedKey: string; documentId: string } | null {
  const family = entry.generator?.family;
  if (!family || entry.kind !== 'POLICY' || !canGenerateDraft(framework, family)) return null;
  const seedKey = generatedSeedKey(framework, family);
  const existing = docs.find((d) => d.seedKey === seedKey && d.status !== 'RETIRED');
  if (existing) return row.satisfiedBy.includes(existing.id) ? null : { kind: 'link_existing', seedKey, documentId: existing.id };
  return { kind: 'generate', seedKey };
}

/** The first `max` control ids as shown, and how many more there are. */
export function controlsSummary(ids: string[], displayId: (id: string) => string, max = 6): { shown: string[]; more: number } {
  return { shown: ids.slice(0, max).map(displayId), more: Math.max(0, ids.length - max) };
}

/** `expected-documents-<framework lowercased>-YYYY-MM-DD.csv`: no organization name. */
export function expectedCsvFileName(framework: string, today: string): string {
  return `expected-documents-${framework.toLowerCase()}-${today}.csv`;
}

/** The add form's starting values for an expected document: its kind and name. */
export function registerPrefill(entry: ExpectedDocument): Partial<DocumentForm> {
  return { kind: entry.kind, title: entry.name };
}

export function generateResultText(kind: 'created' | 'linked_existing'): string {
  return kind === 'created'
    ? 'Draft registered from the policy generator and linked. It does not count as present until a person reviews it, attaches the reviewed copy and approves it.'
    : 'A generated draft for this family was already in the register; it is now linked. It does not count as present until it is approved.';
}

/** "As of 2026-11-20", for the catalog's date; blank until the catalog has loaded. */
export function catalogAsOfLine(asOf: string | null): string {
  return asOf ? `Catalog as of ${asOf}.` : '';
}
