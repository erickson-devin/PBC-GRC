import { DOCUMENT_KINDS, type DocumentKind, type GovernanceDocument, type ProgramDocuments } from '../../types/documents';

/**
 * Expected documents checklist (#250): the governance documents an assessor commonly expects for a framework. Plain data
 * written by us (expectedDocuments.json): document type names and our own short descriptions, never copied from an
 * assessment guide or template. The control mapping is our interpretation and has to be checked by a person (`_meta.verified`).
 * The data is injected so the browser can load it lazily. A match between an entry and a register document is only ever
 * a SUGGESTION; a person links it. Only an explicit link to an approved document with a usable copy counts as present.
 */
export const EXPECTED_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] as const;
export type ExpectedFramework = typeof EXPECTED_FRAMEWORKS[number];

export const EXPECTED_REQUIREMENTS = ['EXPECTED', 'RECOMMENDED'] as const;
export type ExpectedRequirement = typeof EXPECTED_REQUIREMENTS[number];

export interface ExpectedDocument {
  id: string;
  /** Generic document type name. */
  name: string;
  /** The register kind it would be filed under. */
  kind: DocumentKind;
  /** Our own one-line description. */
  description: string;
  /** Control ids of the framework whose requirements imply the document. */
  controls: string[];
  /** Lowercase words looked for in a register title (suggestions only). */
  keywords: string[];
  requirement: ExpectedRequirement;
  /** Set when the policy generator can draft it: the control family it generates (POLICY entries only). */
  generator?: { family: string };
}

export interface ExpectedDocumentCatalog {
  _meta: { schemaVersion: 1; compiledBy: string; asOf: string; verified: boolean; notice: string; method: string; reviewNote?: string };
  frameworks: Partial<Record<ExpectedFramework, ExpectedDocument[]>>;
}

export const EXPECTED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MIN_EXPECTED_DESCRIPTION = 10;
export const MAX_EXPECTED_DESCRIPTION = 160;
export const MAX_EXPECTED_NAME = 80;
export const MAX_EXPECTED_KEYWORDS = 8;
/** A suggestion needs this score: the kind matches (+2) and at least one keyword is in the title (+1 each). */
export const SUGGEST_MIN_SCORE = 3;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The list of problems found in a raw catalog, [] when it is well formed. `idsByFramework` holds the control ids of each framework. */
export function validateExpectedCatalog(raw: unknown, idsByFramework: Record<string, ReadonlySet<string>>): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ['catalog is not an object'];
  const meta = raw._meta;
  if (!isObj(meta)) problems.push('_meta is missing');
  else {
    if (meta.schemaVersion !== 1) problems.push('_meta.schemaVersion is not 1');
    for (const k of ['compiledBy', 'asOf', 'notice', 'method']) if (typeof meta[k] !== 'string' || !meta[k]) problems.push(`_meta.${k} is missing`);
    if (typeof meta.asOf === 'string' && !ISO_DATE.test(meta.asOf)) problems.push('_meta.asOf is not an ISO date');
    if (typeof meta.verified !== 'boolean') problems.push('_meta.verified is not a boolean');
  }
  if (!isObj(raw.frameworks)) return [...problems, 'frameworks is not an object'];
  const ids = new Set<string>();
  for (const [fw, list] of Object.entries(raw.frameworks)) {
    const controlIds = idsByFramework[fw];
    if (!(EXPECTED_FRAMEWORKS as readonly string[]).includes(fw) || !controlIds) {
      problems.push(`frameworks.${fw} is not a known framework`);
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(`frameworks.${fw} is not a list`);
      continue;
    }
    const names = new Set<string>();
    list.forEach((t, i) => {
      const at = `${fw}[${i}]`;
      if (!isObj(t)) {
        problems.push(`${at} is not an object`);
        return;
      }
      if (typeof t.id !== 'string' || !EXPECTED_ID_PATTERN.test(t.id)) problems.push(`${at}.id is malformed`);
      else if (ids.has(t.id)) problems.push(`${at}.id repeats an id`);
      else ids.add(t.id);
      if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > MAX_EXPECTED_NAME) problems.push(`${at}.name is missing or too long`);
      else if (names.has(t.name.toLowerCase())) problems.push(`${at}.name repeats a name`);
      else names.add(t.name.toLowerCase());
      if (typeof t.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(t.kind)) problems.push(`${at}.kind is not a document kind`);
      if (typeof t.requirement !== 'string' || !(EXPECTED_REQUIREMENTS as readonly string[]).includes(t.requirement)) problems.push(`${at}.requirement is not known`);
      if (typeof t.description !== 'string' || t.description.length < MIN_EXPECTED_DESCRIPTION || t.description.length > MAX_EXPECTED_DESCRIPTION) problems.push(`${at}.description length is out of bounds`);
      if (!Array.isArray(t.controls) || t.controls.length === 0) problems.push(`${at}.controls is missing`);
      else if (!t.controls.every((c) => typeof c === 'string' && controlIds.has(c)) || new Set(t.controls).size !== t.controls.length) problems.push(`${at}.controls names an unknown or repeated control`);
      if (!Array.isArray(t.keywords) || t.keywords.length === 0 || t.keywords.length > MAX_EXPECTED_KEYWORDS) problems.push(`${at}.keywords is missing or over ${MAX_EXPECTED_KEYWORDS}`);
      else if (!t.keywords.every((k) => typeof k === 'string' && k.length > 0 && k === k.trim().toLowerCase())) problems.push(`${at}.keywords must be trimmed lowercase words`);
      if (t.generator !== undefined) {
        const g = t.generator;
        if (t.kind !== 'POLICY') problems.push(`${at}.generator is only for policies`);
        if (!isObj(g) || typeof g.family !== 'string' || !/^[A-Z]{2,3}$/.test(g.family) || Object.keys(g).length !== 1) problems.push(`${at}.generator is malformed`);
      }
    });
  }
  return problems;
}

/** The entries of a framework that apply to a program: at least one of their controls is in the program's catalog. */
export function applicableExpected(c: ExpectedDocumentCatalog, framework: string, programCatalogIds: ReadonlySet<string>): ExpectedDocument[] {
  const list = (c.frameworks as Record<string, ExpectedDocument[] | undefined>)[framework] ?? [];
  return list.filter((e) => e.controls.some((id) => programCatalogIds.has(id)));
}

/**
 * Register documents that probably are this expected document, best first. A suggestion only: nothing is linked or counted.
 * The kind matching scores 2, each keyword found in the lowercase title 1; a score under SUGGEST_MIN_SCORE, a retired
 * document and one already linked to the entry are left out.
 */
export function suggestMatches(e: Pick<ExpectedDocument, 'kind' | 'keywords'>, docs: Pick<GovernanceDocument, 'id' | 'title' | 'kind' | 'status'>[], alreadyLinked: ReadonlySet<string>): string[] {
  return docs
    .filter((d) => d.status !== 'RETIRED' && !alreadyLinked.has(d.id))
    .map((d) => {
      const title = d.title.toLowerCase();
      return { id: d.id, title, score: (d.kind === e.kind ? 2 : 0) + e.keywords.filter((k) => title.includes(k)).length };
    })
    .filter((s) => s.score >= SUGGEST_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

export type ExpectedState = 'PRESENT' | 'DRAFT_ONLY' | 'MISSING';

export interface ExpectedRow {
  entry: ExpectedDocument;
  /** Ids of the live (not retired) register documents a person linked to the entry. */
  satisfiedBy: string[];
  /** Linked to at least one approved document that has a usable copy (an attachment that still exists, or a location). */
  present: boolean;
  /** PRESENT; DRAFT_ONLY when linked documents exist but none is present; MISSING when nothing live is linked. */
  state: ExpectedState;
  /** Register documents that look like a match; never counted. */
  suggestions: string[];
  /** Present, and every present document is past its review-by date (needs `today`). */
  overdue: boolean;
}

/** The present rule (D7): approved and a usable primary copy: the primary attachment if there is one (it must still exist), else the location. */
export function hasUsableCopy(doc: GovernanceDocument, pd: Pick<ProgramDocuments, 'attachments'>, liveEvidenceIds: ReadonlySet<string>): boolean {
  if (doc.status !== 'APPROVED') return false;
  const primary = pd.attachments.find((a) => a.documentId === doc.id && a.isPrimary);
  if (primary) return liveEvidenceIds.has(primary.evidenceId);
  return !!doc.locationUrl && doc.locationUrl.trim().length > 0;
}

/** One row per entry. `today` (YYYY-MM-DD) is only needed for `overdue`. */
export function expectedStatus(
  entries: ExpectedDocument[],
  docs: GovernanceDocument[],
  pd: Pick<ProgramDocuments, 'attachments' | 'expectations'>,
  liveEvidenceIds: ReadonlySet<string>,
  today?: string
): ExpectedRow[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return entries.map((entry) => {
    const linked = pd.expectations.filter((x) => x.expectedId === entry.id).map((x) => byId.get(x.documentId)).filter((d): d is GovernanceDocument => !!d && d.status !== 'RETIRED');
    const satisfiedBy = [...new Set(linked.map((d) => d.id))];
    const presentDocs = linked.filter((d) => hasUsableCopy(d, pd, liveEvidenceIds));
    const present = presentDocs.length > 0;
    return {
      entry,
      satisfiedBy,
      present,
      state: present ? 'PRESENT' : satisfiedBy.length > 0 ? 'DRAFT_ONLY' : 'MISSING',
      suggestions: suggestMatches(entry, docs, new Set(satisfiedBy)),
      overdue: !!today && present && presentDocs.every((d) => !!d.reviewBy && d.reviewBy < today),
    };
  });
}

export interface ExpectedCounts {
  present: number;
  total: number;
  recommendedPresent: number;
  recommendedTotal: number;
  /** Present rows whose present documents are all past their review-by date (0 when expectedStatus had no `today`). */
  overdue: number;
}

export function presentCounts(rows: ExpectedRow[]): ExpectedCounts {
  const expected = rows.filter((r) => r.entry.requirement === 'EXPECTED');
  const recommended = rows.filter((r) => r.entry.requirement === 'RECOMMENDED');
  return {
    present: expected.filter((r) => r.present).length,
    total: expected.length,
    recommendedPresent: recommended.filter((r) => r.present).length,
    recommendedTotal: recommended.length,
    overdue: rows.filter((r) => r.overdue).length,
  };
}
