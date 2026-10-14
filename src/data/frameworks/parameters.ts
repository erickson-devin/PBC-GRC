import type { ControlParameter, FrameworkControlDefinition } from '../../types/framework';
import { NIST_800_171A_REGISTRY, normalizeControlNumber } from './assessmentObjectives';

/**
 * Organization-defined parameters (ODPs) and vague wording.
 *
 * An assessor cannot test "reviewed periodically". NIST SP 800-53 marks the blanks an organisation must fill in with bracketed
 * tags in the control text:
 *
 *     [Assignment: organization-defined frequency]
 *     [Selection (one or more): change password; ...; [Assignment: organization-defined action]]
 *
 * This module finds those tags (any text can carry them: a catalog statement, or a narrative somebody pasted from NIST), turns
 * them into structured parameters, bridges the platform's own objective-level ODP registry into the same structure, decides
 * whether a parameter has been given a value, and flags the vague wording ("periodically", "as needed") that should become an
 * explicit, testable value. Pure functions, shared by the browser and the server.
 */

// ------------------------------------------------------------------------------------------------ tags

const TAG_START = /\[\s*(Assignment|Selection)\b/gi;

/** Finds the ']' that closes the '[' at `open`, allowing nested brackets (a Selection may contain an Assignment). */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Splits a Selection's body on ';' that are not inside a nested tag. */
function splitChoices(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Extracts the [Assignment: ...] and [Selection ...: ...] tags of a text, outermost tags only (a tag nested in a choice stays
 * part of that choice). Tags without a closing bracket are ignored. \`idPrefix\` makes the ids ("AC-2#1", "AC-2#2", ...).
 */
export function parseParameterTags(text: string, idPrefix: string, source: ControlParameter['source'] = 'STATEMENT'): ControlParameter[] {
  const found: ControlParameter[] = [];
  let from = 0;
  for (;;) {
    TAG_START.lastIndex = from;
    const m = TAG_START.exec(text);
    if (!m) break;
    const start = m.index;
    const end = matchingBracket(text, start);
    if (end === -1) {
      from = start + 1; // unclosed: skip it
      continue;
    }
    from = end + 1;
    const raw = text.slice(start, end + 1);
    const inner = raw.slice(1, -1);
    const colon = inner.indexOf(':');
    if (colon === -1) continue;
    const head = inner.slice(0, colon).trim();
    const body = inner.slice(colon + 1).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const n = found.length + 1;
    if (/^assignment/i.test(head)) {
      found.push({ id: `${idPrefix}#${n}`, kind: 'ASSIGNMENT', label: body.replace(/^organization-defined\s+/i, '') || body, prompt: body, source, raw, start, end: end + 1 });
    } else {
      const choices = splitChoices(inner.slice(colon + 1));
      found.push({
        id: `${idPrefix}#${n}`,
        kind: 'SELECTION',
        label: choices.length ? 'Selection' : body,
        prompt: /one or more/i.test(head) ? 'Select one or more' : 'Select one',
        choices,
        selectionMode: /one or more/i.test(head) ? 'ONE_OR_MORE' : 'ONE',
        source,
        raw,
        start,
        end: end + 1,
      });
    }
  }
  // Several tags of one control often share a label ("time period" three times): a value is recorded under its label, so make them distinct
  const seenLabels = new Map<string, number>();
  for (const p of found) {
    const n = (seenLabels.get(p.label) ?? 0) + 1;
    seenLabels.set(p.label, n);
  }
  const used = new Map<string, number>();
  for (const p of found) {
    if ((seenLabels.get(p.label) ?? 0) < 2) continue;
    const n = (used.get(p.label) ?? 0) + 1;
    used.set(p.label, n);
    p.label = `${p.label} (${n})`;
  }
  return found;
}

/**
 * The text with each [Assignment: ...] / [Selection: ...] tag reduced to what it asks for, so it reads as a sentence:
 * "reviewed [Assignment: organization-defined frequency]" -> "reviewed organization-defined frequency";
 * "[Selection (one or more): a; b]" -> "a or b". Nested tags are reduced too.
 */
export function collapseTags(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    TAG_START.lastIndex = from;
    const m = TAG_START.exec(text);
    if (!m) break;
    const end = matchingBracket(text, m.index);
    if (end === -1) break;
    const inner = text.slice(m.index + 1, end);
    const colon = inner.indexOf(':');
    out += text.slice(from, m.index);
    if (colon === -1) out += text.slice(m.index, end + 1);
    else if (/^\s*assignment/i.test(inner)) out += collapseTags(inner.slice(colon + 1)).replace(/\s+/g, ' ').trim();
    else out += splitChoices(inner.slice(colon + 1)).map((c) => collapseTags(c)).join(' or ');
    from = end + 1;
  }
  return out + text.slice(from);
}

/** Fills `parameters` for every control that supplies a `statement` (a no-op for the catalogs shipped today). */
export function attachParameters(controls: FrameworkControlDefinition[]): FrameworkControlDefinition[] {
  for (const c of controls) if (c.statement && !c.parameters) c.parameters = parseParameterTags(c.statement, c.id);
  return controls;
}

/** The parameters of a control: tags in its statement, plus the ODPs the platform's objective registry defines for it. */
export function resolveParameters(control: Pick<FrameworkControlDefinition, 'id' | 'statement' | 'parameters'>): ControlParameter[] {
  const fromStatement = control.parameters ?? (control.statement ? parseParameterTags(control.statement, control.id) : []);
  // A control whose official text carries its parameters as tags needs no second list from the objective registry
  const registry = fromStatement.length > 0 ? undefined : NIST_800_171A_REGISTRY[normalizeControlNumber(control.id)];
  const seen = new Set<string>();
  const fromObjectives: ControlParameter[] = [];
  for (const objective of registry?.objectives ?? []) {
    for (const p of objective.odpParameters ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      fromObjectives.push({ id: p.id, kind: 'ASSIGNMENT', label: p.label, prompt: p.label, source: 'OBJECTIVE', defaultValue: p.defaultValue });
    }
  }
  return [...fromStatement, ...fromObjectives];
}

// ------------------------------------------------------------------------------------------------ values

/**
 * A parameter's value is recorded in the control's narrative, so it is saved, exported and assessed with the rest of the
 * implementation text: a line "Parameter: <label> = <value>". (Tags in the narrative itself are replaced by their value.)
 */
const lineFor = (label: string, value: string): string => `Parameter: ${label} = ${value}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parameterLineRe = (label: string): RegExp => new RegExp(`^Parameter:\\s*${escapeRe(label)}\\s*=\\s*(.*)$`, 'im');

/** The value a person has recorded for a parameter in `notes`, or undefined if it is still open. */
export function parameterValue(param: ControlParameter, notes: string): string | undefined {
  if (param.source === 'NOTES') return undefined; // a tag still in the text is, by definition, open
  const m = notes.match(parameterLineRe(param.label));
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

export const isParameterOpen = (param: ControlParameter, notes: string): boolean => parameterValue(param, notes) === undefined;

/** Records `value` for a catalog / objective parameter in the narrative (replacing an earlier line for it); '' removes the line. */
export function setParameterValue(notes: string, param: ControlParameter, value: string): string {
  const re = parameterLineRe(param.label);
  const clean = value.replace(/\s+/g, ' ').trim();
  if (re.test(notes)) {
    return clean ? notes.replace(re, lineFor(param.label, clean)) : notes.replace(new RegExp(`\\n?${re.source}`, 'im'), '').replace(/^\n+/, '');
  }
  if (!clean) return notes;
  return `${notes.replace(/\s+$/, '')}${notes.trim() ? '\n' : ''}${lineFor(param.label, clean)}`;
}

/** Replaces a tag found IN the narrative (a NOTES parameter) by its value. Positions come from parseParameterTags on this text. */
export function replaceTag(notes: string, param: ControlParameter, value: string): string {
  if (param.start === undefined || param.end === undefined || notes.slice(param.start, param.end) !== param.raw) return notes; // the text changed since
  return notes.slice(0, param.start) + value.trim() + notes.slice(param.end);
}

// ------------------------------------------------------------------------------------------------ vague wording

/**
 * Words and phrases an assessor cannot test. Deliberately conservative: only wording that stands in for an amount of time, a
 * quantity or a standard. "Quarterly", "every 90 days" or "within 24 hours" are explicit and never listed here.
 */
export const VAGUE_TERMS: readonly string[] = [
  'periodically',
  'regularly',
  'on a regular basis',
  'from time to time',
  'as needed',
  'as necessary',
  'as appropriate',
  'as required',
  'when necessary',
  'if necessary',
  'when needed',
  'promptly',
  'in a timely manner',
  'timely',
  'frequently',
  'occasionally',
  'routinely',
  'organization-defined',
  'TBD',
];

const VAGUE_RE = new RegExp(`(?<![\\w-])(${[...VAGUE_TERMS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\w-])`, 'gi');

export const containsVagueWording = (text: string): boolean => {
  VAGUE_RE.lastIndex = 0;
  return VAGUE_RE.test(text);
};

export interface VagueSpan {
  /** The sentence (or line) that contains vague wording, exactly as written, and its range in the text. */
  sentence: string;
  start: number;
  end: number;
  /** The vague words in it, lower-cased, in order, without repeats. */
  terms: string[];
}

/** The sentences of `text` that contain vague wording. A sentence ends at . ! ? or a line break. */
export function findVagueWording(text: string): VagueSpan[] {
  const out: VagueSpan[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const raw = m[0];
    const sentence = raw.trim();
    if (!sentence || /^Parameter:/i.test(sentence)) continue; // a recorded value is not prose to rewrite
    const terms = [...new Set([...sentence.matchAll(VAGUE_RE)].map((t) => t[1].toLowerCase()))];
    if (terms.length === 0) continue;
    const start = (m.index ?? 0) + (raw.length - raw.trimStart().length);
    out.push({ sentence, start, end: start + sentence.length, terms });
  }
  return out;
}

/** Replaces the sentence of a VagueSpan by `rewrite`, if the text still has it at that place. */
export function replaceSentence(notes: string, span: VagueSpan, rewrite: string): string {
  if (notes.slice(span.start, span.end) !== span.sentence) return notes;
  return notes.slice(0, span.start) + rewrite.trim() + notes.slice(span.end);
}
