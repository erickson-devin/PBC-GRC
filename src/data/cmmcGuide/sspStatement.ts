import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import { stripInlineBold } from '../../utils/markdownBlocks';
import { cmmcGuideLetter } from './displayId';
import { cmmcNumberOf, guideObjectives } from './guide';
import { getControlObjectives, starterTemplateVariants } from './objectives';

/**
 * The implementation statement an SSP prints for a control (#293): the control-level notes, then one paragraph per objective
 * narrative, so the screen, the export and the Markdown cannot drift. Pure: read-only, logs nothing, stores nothing. Objective
 * narratives may contain CUI and appear only where the control notes already do.
 *
 * Product decisions that live here and nowhere else:
 *  - GUARDED_FRAMEWORKS (the scope): CMMC Level 1 / 2 only; any other framework prints its notes byte for byte except Markdown bold.
 *  - STATUS_PREFIX (D5): a narrative on an objective that is not Met prints with a status prefix; set a prefix to '' to drop it.
 *  - STARTER_TEXT_NEEDS_MET (D6): unedited starter-template text prints only once the objective is Met.
 *  - Not applicable: the objective's narrative is the reason, printed as `[b] Not applicable: <reason>`; always printed, even with no reason.
 *  - Markdown bold: the starter templates carry `**bold**` and an SSP prints plain text, so the bold marks are removed from the output.
 */
export interface ObjectiveAnswer {
  status: ObjectiveStatus;
  implementationNarrative?: string | null;
}

export interface ComposedStatement {
  text: string;
  /** The printed (guide) letters, in guide order. */
  objectiveLetters: string[];
}

export const GUARDED_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2'];
export const STARTER_TEXT_NEEDS_MET = true;
export const STATUS_PREFIX: Record<ObjectiveStatus, string> = {
  MET: '',
  NOT_APPLICABLE: 'Not applicable: ',
  IN_PROGRESS: '(In progress) ',
  NOT_MET: '(Not met) ',
  NOT_STARTED: '(Not started) ',
};
export const NO_NOT_APPLICABLE_REASON = 'no reason is recorded.';

/**
 * Whether an objective's narrative is printed in the SSP: non-blank, not an unedited starter text that is not yet Met, not already in the notes.
 * `otherStarters` are older starter texts of the objective (starterTemplateVariants). A Not applicable narrative is the reason: it prints
 * whenever it is written and is not starter text, whatever the notes say.
 */
export function objectiveNarrativePrints(
  o: Pick<AssessmentObjective, 'status' | 'implementationNarrative' | 'prefilledTemplate'>,
  notes: string,
  otherStarters: readonly string[] = []
): boolean {
  const n = (o.implementationNarrative ?? '').trim();
  const starter = n === (o.prefilledTemplate ?? '').trim() || otherStarters.includes(n);
  if (o.status === 'NOT_APPLICABLE') return n !== '' && !starter;
  if (n === '') return false;
  if (STARTER_TEXT_NEEDS_MET && o.status !== 'MET' && starter) return false;
  return !(notes ?? '').includes(n);
}

const LEGACY_TEMPLATE_HEADER = /^\[Objective ([A-Za-z0-9]+) - [^\n]*\]:[ \t]*$/gm;

/**
 * Older versions appended `[Objective A - <text>]:` plus the starter template to the control notes. At print time only: drops those
 * sections while they still hold unedited starter text (or nothing), and relabels an edited one `[a] ...` like a typed narrative.
 * The stored notes are never rewritten. Notes without such a header come back untouched.
 */
export function normalizeLegacyTemplateSections(
  controlId: string,
  notes: string,
  rows: readonly Pick<AssessmentObjective, 'letter' | 'prefilledTemplate'>[],
  framework: string
): string {
  if (!GUARDED_FRAMEWORKS.includes(framework) || cmmcNumberOf(controlId) === null) return notes;
  const text = (notes ?? '').replace(/\r\n/g, '\n');
  const headers = [...text.matchAll(LEGACY_TEMPLATE_HEADER)];
  if (headers.length === 0) return notes;
  const parts: string[] = [];
  const preamble = text.slice(0, headers[0].index).replace(/\s+$/, '');
  if (preamble !== '') parts.push(preamble);
  for (const [k, h] of headers.entries()) {
    const start = h.index! + h[0].length;
    const end = k + 1 < headers.length ? headers[k + 1].index! : text.length;
    const body = text.slice(start, end).trim();
    if (body === '') continue;
    const letter = h[1].toLowerCase();
    const row = rows.find((r) => r.letter.toLowerCase() === letter);
    if (row && ((row.prefilledTemplate ?? '').trim() === body || starterTemplateVariants(controlId, row.letter, framework).includes(body))) continue;
    parts.push(`[${cmmcGuideLetter(controlId, letter, framework)}] ${body}`);
  }
  return parts.join('\n\n');
}

export function composeImplementationStatement(
  controlId: string,
  notes: string | null | undefined,
  objectives: Readonly<Record<string, ObjectiveAnswer>> | undefined,
  framework: string
): ComposedStatement {
  const raw = notes ?? '';
  if (!GUARDED_FRAMEWORKS.includes(framework) || cmmcNumberOf(controlId) === null) {
    return { text: stripInlineBold(raw), objectiveLetters: [] };
  }
  const rows = getControlObjectives(controlId, undefined, undefined, (objectives ?? {}) as unknown as Record<string, AssessmentObjective>, framework);
  // An answer does not have to carry its letter, so the letter comes from the guide (rows are in guide order).
  const guide = guideObjectives(cmmcNumberOf(controlId)!, framework);
  const base = normalizeLegacyTemplateSections(controlId, raw, rows.map((r, i) => ({ letter: guide[i].letter, prefilledTemplate: r.prefilledTemplate })), framework);
  if (objectives === undefined) return { text: stripInlineBold(base), objectiveLetters: [] };
  const letters: string[] = [];
  const paragraphs: string[] = [];
  for (const [i, o] of rows.entries()) {
    const prints = objectiveNarrativePrints(o, base, starterTemplateVariants(controlId, guide[i].letter, framework));
    const narrative = (o.implementationNarrative ?? '').trim();
    if (o.status !== 'NOT_APPLICABLE' && !prints) continue;
    const letter = cmmcGuideLetter(controlId, guide[i].letter, framework);
    letters.push(letter);
    const body = o.status === 'NOT_APPLICABLE' && !prints ? NO_NOT_APPLICABLE_REASON : narrative;
    paragraphs.push(`[${letter}] ${STATUS_PREFIX[o.status] ?? ''}${body}`);
  }
  if (paragraphs.length === 0) return { text: stripInlineBold(base), objectiveLetters: [] };
  const joined = paragraphs.join('\n\n');
  const text = base.trim() === '' ? joined : `${base.replace(/\s+$/, '')}\n\n${joined}`;
  return { text: stripInlineBold(text), objectiveLetters: letters };
}
