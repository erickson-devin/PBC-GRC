/**
 * Shapes of the CMMC Assessment Guide data (cmmcL2Guide.generated.json / cmmcL1Guide.generated.json, written by
 * scripts/generateCmmcObjectives.ts), the text normaliser the platform compares objectives with, and the checks that both
 * the generator's --check and the tests run. No imports: the generator loads this file before any generated data exists.
 */

export interface GuideMeta {
  generatedBy: string;
  document: string;
  version: string;
  date: string;
  documentNumber: string;
  distribution: string;
  /** The base name only, never a path. */
  sourceFile: string;
  sha256: string;
  pages: number;
}

export interface GuideObjective {
  letter: string;
  text: string;
}

export interface L2Requirement {
  id: string;
  number: string;
  family: string;
  title: string;
  displayTitle: string;
  statement: string;
  objectives: GuideObjective[];
}

export interface L1Objective extends GuideObjective {
  /** The 800-171 requirement and letter this Level 1 objective is the same determination as. */
  number: string;
  numberLetter: string;
}

export interface L1Requirement {
  id: string;
  /** FAR 52.204-21 paragraph, e.g. 'b.1.ix'. */
  far: string;
  /** The 800-171 requirements the guide's KEY REFERENCES name, e.g. ['3.10.3', '3.10.4', '3.10.5']. */
  numbers: string[];
  family: string;
  title: string;
  displayTitle: string;
  statement: string;
  objectives: L1Objective[];
}

export interface L2GuideFile {
  meta: GuideMeta;
  requirements: L2Requirement[];
}

export interface L1GuideFile {
  meta: GuideMeta;
  requirements: L1Requirement[];
}

export const L2_REQUIREMENT_COUNT = 110;
export const L2_OBJECTIVE_COUNT = 320;
export const L1_REQUIREMENT_COUNT = 15;
export const L1_OBJECTIVE_COUNT = 59;

/** Lower-cases, spells out FCI / CUI, drops punctuation and the articles, so two wordings of one determination compare equal. */
export function normalizeObjectiveText(s: string): string {
  return s
    .toLowerCase()
    .replace(/federal contract information/g, 'fci')
    .replace(/controlled unclassified information/g, 'cui')
    .replace(/\[(fci|cui)\]/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && w !== 'the' && w !== 'a' && w !== 'an')
    .join(' ');
}

/** Words the guide's title extraction is known to garble, fixed to the guide's own contents page. */
export const TITLE_FIXUPS: Record<string, string> = {
  'RIsk Assessments': 'Risk Assessments',
  'operational Plan of Action': 'Operational Plan of Action',
  'Malicious Code ProTection [FCI Data]': 'Malicious Code Protection [FCI Data]',
};

/** The title the screens show: the extraction fix-ups applied, and the trailing [CUI Data] / [FCI Data] tag dropped. */
export function displayTitleOf(title: string): string {
  return (TITLE_FIXUPS[title] ?? title).replace(/\s*\[(?:CUI|FCI) Data\]$/, '').trim();
}

const BAD_DISPLAY_TITLE = /^[a-z]|[a-z][A-Z]|[A-Z]{2}[a-z]|\[(CUI|FCI) Data\]/;

function letterProblems(id: string, objectives: GuideObjective[], out: string[]): void {
  if (objectives.length === 0) out.push(`${id}: no objectives`);
  objectives.forEach((o, k) => {
    if (o.letter !== String.fromCharCode(97 + k)) out.push(`${id}: objective ${k + 1} has letter '${o.letter}', expected '${String.fromCharCode(97 + k)}'`);
    if (!o.text || o.text !== o.text.trim()) out.push(`${id}[${o.letter}]: empty or untrimmed text`);
  });
}

function metaProblems(label: string, meta: GuideMeta, out: string[]): void {
  for (const k of ['generatedBy', 'document', 'version', 'date', 'documentNumber', 'distribution', 'sourceFile'] as const) {
    if (typeof meta?.[k] !== 'string' || !meta[k]) out.push(`${label} meta.${k} is missing`);
  }
  if (!/^[0-9a-f]{64}$/.test(meta?.sha256 ?? '')) out.push(`${label} meta.sha256 is not 64 hex characters`);
  if (!Number.isInteger(meta?.pages) || meta.pages <= 0) out.push(`${label} meta.pages is missing`);
  if (/[\\/]/.test(meta?.sourceFile ?? '')) out.push(`${label} meta.sourceFile must be a base name, not a path`);
}

/** Every structural problem in the two generated files; an empty list means they are consistent. */
export function validateGuideData(l2: L2GuideFile, l1: L1GuideFile): string[] {
  const out: string[] = [];
  metaProblems('Level 2', l2.meta, out);
  metaProblems('Level 1', l1.meta, out);

  const l2Total = l2.requirements.reduce((n, r) => n + r.objectives.length, 0);
  if (l2.requirements.length !== L2_REQUIREMENT_COUNT) out.push(`Level 2 has ${l2.requirements.length} requirements, expected ${L2_REQUIREMENT_COUNT}`);
  if (l2Total !== L2_OBJECTIVE_COUNT) out.push(`Level 2 has ${l2Total} objectives, expected ${L2_OBJECTIVE_COUNT}`);
  const byNumber = new Map<string, L2Requirement>();
  for (const r of l2.requirements) {
    if (!/^[A-Z]{2}\.L2-3\.\d{1,2}\.\d{1,2}$/.test(r.id) || r.id !== `${r.family}.L2-${r.number}`) out.push(`${r.id}: id does not match family and number ${r.number}`);
    if (byNumber.has(r.number)) out.push(`${r.number}: more than one Level 2 requirement`);
    byNumber.set(r.number, r);
    letterProblems(r.id, r.objectives, out);
    if (!r.statement) out.push(`${r.id}: empty statement`);
    if (!r.displayTitle || BAD_DISPLAY_TITLE.test(r.displayTitle)) out.push(`${r.id}: displayTitle '${r.displayTitle}' looks garbled`);
  }

  const l1Total = l1.requirements.reduce((n, r) => n + r.objectives.length, 0);
  if (l1.requirements.length !== L1_REQUIREMENT_COUNT) out.push(`Level 1 has ${l1.requirements.length} requirements, expected ${L1_REQUIREMENT_COUNT}`);
  if (l1Total !== L1_OBJECTIVE_COUNT) out.push(`Level 1 has ${l1Total} objectives, expected ${L1_OBJECTIVE_COUNT}`);
  const seenFar = new Set<string>();
  const lettersByNumber = new Map<string, string[]>();
  for (const r of l1.requirements) {
    if (!/^[A-Z]{2}\.L1-b\.1\.[ivx]+$/.test(r.id) || r.id !== `${r.family}.L1-${r.far}`) out.push(`${r.id}: id does not match family and FAR paragraph ${r.far}`);
    if (seenFar.has(r.far)) out.push(`${r.far}: more than one Level 1 requirement`);
    seenFar.add(r.far);
    letterProblems(r.id, r.objectives, out);
    if (!r.statement) out.push(`${r.id}: empty statement`);
    if (!r.displayTitle || BAD_DISPLAY_TITLE.test(r.displayTitle)) out.push(`${r.id}: displayTitle '${r.displayTitle}' looks garbled`);
    if (r.numbers.length === 0) out.push(`${r.id}: no 800-171 numbers`);
    for (const n of r.numbers) if (!byNumber.has(n)) out.push(`${r.id}: ${n} is not a Level 2 requirement`);
    for (const o of r.objectives) {
      if (!r.numbers.includes(o.number)) {
        out.push(`${r.id}[${o.letter}]: number ${o.number} is not one of ${r.numbers.join(', ')}`);
        continue;
      }
      const l2o = byNumber.get(o.number)?.objectives.find((x) => x.letter === o.numberLetter);
      if (!l2o) {
        out.push(`${r.id}[${o.letter}]: no Level 2 objective ${o.number}[${o.numberLetter}]`);
        continue;
      }
      if (o.text !== l2o.text.replace(/\bCUI\b/g, '[FCI]')) out.push(`${o.number}[${o.numberLetter}]: Level 1 text differs from Level 2 text other than CUI -> [FCI]`);
      const seen = lettersByNumber.get(o.number) ?? [];
      seen.push(o.numberLetter);
      lettersByNumber.set(o.number, seen);
    }
  }
  for (const [n, letters] of lettersByNumber) {
    const want = byNumber.get(n)!.objectives.map((o) => o.letter).join('');
    if ([...letters].sort().join('') !== want) out.push(`${n}: Level 1 covers letters '${[...letters].sort().join('')}', Level 2 has '${want}'`);
  }
  return out;
}
