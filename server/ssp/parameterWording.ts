import { z } from 'zod';
import { containsVagueWording, findVagueWording } from '../../src/data/frameworks/parameters';
import type { ControlParameter } from '../../src/types/framework';
import { OllamaClient } from './ollama';
import { tokenize } from './retrieval';

/**
 * "Suggest Parameter Wording": help a person turn vague narrative ("accounts are reviewed periodically") or an open
 * organization-defined parameter into explicit, testable wording ("every 90 days"). It runs on the local model only, sends the
 * model one sentence or one parameter (never the whole narrative), and writes nothing: the person picks an option, and the
 * browser puts it in the editor as an ordinary, unsaved edit.
 *
 * A small model will happily answer "regularly" to a request to remove vague words, or rewrite a sentence into something
 * else. So each option is validated by this program before anyone sees it: no vague words, an explicit value, a Selection
 * answered with its own listed choices, and a rewrite that keeps what the sentence said. Options that fail are dropped.
 */
export const WORDING_PROMPT_VERSION = 'odp-ai-2';
const MAX_OPTIONS = 3;
const MAX_VALUE_CHARS = 120;
const MAX_SENTENCE_CHARS = 600;
const MIN_FAITHFUL_SHARE = 0.6;

export interface WordingControl {
  id: string;
  title: string;
  /** What the control requires, in plain words. */
  requirement: string;
}

export type WordingRequest =
  | {
      mode: 'PARAMETER';
      control: WordingControl;
      parameter: Pick<ControlParameter, 'kind' | 'label' | 'prompt' | 'choices' | 'selectionMode'>;
      /** Where the blank sits: the sentence of the control (or of the objective) that holds it, the blank marked <<like this>>. */
      context?: string;
    }
  | { mode: 'SENTENCE'; control: WordingControl; sentence: string; terms: string[] };

export interface WordingOption {
  /** PARAMETER: the value to record ("every 90 days"). SENTENCE: the rewritten sentence. */
  text: string;
  /** Why the model thinks it is reasonable (one short sentence; not a citation). */
  note: string;
}

export interface WordingResult {
  mode: WordingRequest['mode'];
  options: WordingOption[];
  model: string;
  promptVersion: string;
  /** How many of the model's options were thrown away by the checks. */
  rejected: number;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------------------------------------ prompts

export const PARAMETER_SYSTEM = `You help a defense contractor fill in one organization-defined parameter of a NIST security control with audit-ready wording.
An assessor must be able to test the value, so it must be explicit and specific: a number with a unit (every 90 days, within 24 hours, 14 characters), a named job title (the IT Security Manager, the system owner), a named document or tool, or a concrete list of items.
Never use vague words (periodically, regularly, as needed, promptly, appropriate) and never generic filler such as "specific roles", "designated personnel", "relevant criteria" or "as defined by the organization".

You are given the CONTROL, the SENTENCE in which the parameter appears (the blank is marked <<like this>>) and what the PARAMETER is. Every option must read naturally in place of the marked blank in that sentence.
- Give 1 to 3 different options. Each "value" is short (a few words), ready to drop into the sentence.
- Realistic for a small defense contractor and in line with common CMMC, NIST and DISA practice.
- If CHOICES are listed, "value" must be copied exactly from the CHOICES.
- Match what the blank asks for: a frequency or time period needs a number and a unit; "personnel or roles" needs job titles; "criteria", "policy" or "procedures" need concrete items or named documents; "attributes" needs concrete attributes (department, project, clearance level).
- "note" is one short sentence on why the value is reasonable. Do not invent standards or citations.
Answer with JSON only.`;

export const SENTENCE_SYSTEM = `You rewrite one sentence of a security control narrative so that it can be audited.
The sentence uses vague words (listed under VAGUE WORDS). Replace each vague word with an explicit, testable value: a number with a unit (every 90 days, within 24 hours).

Rules:
- Keep the meaning and every other fact in the sentence. Change only what is needed to remove the vague words.
- Do not add tools, roles, systems or claims that the sentence does not already mention. The explicit value is the only addition.
- Give 1 to 3 different rewrites. Each "rewrite" is one complete sentence.
- "note" says in one short sentence which value you chose and why.
Answer with JSON only.`;

export const PARAMETER_SCHEMA = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, note: { type: 'string' } }, required: ['value', 'note'] } } },
  required: ['options'],
} as const;

export const SENTENCE_SCHEMA = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'object', properties: { rewrite: { type: 'string' }, note: { type: 'string' } }, required: ['rewrite', 'note'] } } },
  required: ['options'],
} as const;

const parameterReply = z.object({ options: z.array(z.object({ value: z.string().max(400), note: z.string().max(600) })).max(10) });
const sentenceReply = z.object({ options: z.array(z.object({ rewrite: z.string().max(1500), note: z.string().max(600) })).max(10) });

export function userMessage(req: WordingRequest): string {
  const head = `CONTROL ${req.control.id}: ${req.control.title}\nREQUIREMENT: ${clip(oneLine(req.control.requirement), 500)}`;
  if (req.mode === 'SENTENCE') return `${head}\nSENTENCE: ${JSON.stringify(clip(oneLine(req.sentence), MAX_SENTENCE_CHARS))}\nVAGUE WORDS: ${req.terms.join(', ')}`;
  const p = req.parameter;
  const choices = p.kind === 'SELECTION' && p.choices?.length ? `\nCHOICES:\n${p.choices.map((c) => `- ${c}`).join('\n')}` : '';
  const where = req.context ? `\nSENTENCE: ${JSON.stringify(clip(oneLine(req.context), 400))}` : '';
  return `${head}${where}\nPARAMETER (${p.kind.toLowerCase()}): ${oneLine(p.prompt)}${choices}`;
}

// ------------------------------------------------------------------------------------------------ validation

const PERIOD_WORD = /\b(hourly|daily|weekly|bi-?weekly|monthly|quarterly|semi-?annually|biannually|annually|yearly|immediately|real[- ]time)\b/i;
export const isExplicitValue = (text: string): boolean => /\d/.test(text) || PERIOD_WORD.test(text);

/** Parameters about an amount of time or a quantity need a number or a named period; others (roles, tools) just must not be empty or evasive. */
const NEEDS_QUANTITY = /(frequency|period|time|interval|duration|number|count|length|days|hours|minutes|window|threshold|attempts|retention|size|age|limit)/i;
const EVASIVE = /^(n\/?a|none|tbd|as defined|the organi[sz]ation|organization-defined|to be determined|unknown)\.?$/i;
/** Filler that sounds like an answer and is not one: "specific organizational roles", "designated personnel", "relevant criteria". */
const GENERIC = /\b(specific|designated|relevant|applicable|appropriate|certain|various|organizational|organisational)\s+(organi[sz]ational\s+)?(roles?|personnel|staff|individuals?|people|criteria|policy|policies|procedures?|attributes?|requirements?|mechanisms?|items?)\b/i;

const norm = (s: string): string => oneLine(s).toLowerCase();

/** Checks the options for a PARAMETER request. Returns the usable ones and how many were rejected. */
export function validateParameterOptions(
  param: Pick<ControlParameter, 'kind' | 'prompt' | 'choices' | 'selectionMode'>,
  raw: Array<{ value: string; note: string }>
): { options: WordingOption[]; rejected: number } {
  const seen = new Set<string>();
  const options: WordingOption[] = [];
  let rejected = 0;
  // A choice that still contains an unfilled tag is not something one can pick
  const selectable = (param.choices ?? []).filter((c) => !/\[\s*(assignment|selection)/i.test(c));
  const byNorm = new Map(selectable.map((c) => [norm(c), c]));

  for (const r of raw) {
    let value = oneLine(r.value);
    const note = clip(oneLine(r.note), 200);
    let ok = value.length > 0 && value.length <= MAX_VALUE_CHARS && !containsVagueWording(value) && !EVASIVE.test(value) && !GENERIC.test(value);
    if (ok && param.kind === 'SELECTION') {
      const picked = value.split(/\s*;\s*/).map((v) => byNorm.get(norm(v))).filter((v): v is string => Boolean(v));
      const pieces = value.split(/\s*;\s*/).filter(Boolean);
      const distinct = [...new Set(picked)];
      ok = picked.length === pieces.length && distinct.length > 0 && (param.selectionMode === 'ONE_OR_MORE' || distinct.length === 1);
      if (ok) value = distinct.join('; '); // the catalog's own wording, not the model's
    } else if (ok && NEEDS_QUANTITY.test(param.prompt)) {
      ok = isExplicitValue(value);
    }
    const key = norm(value);
    if (!ok || seen.has(key)) {
      rejected++;
      continue;
    }
    seen.add(key);
    options.push({ text: value, note });
    if (options.length === MAX_OPTIONS) break;
  }
  return { options, rejected: raw.length - options.length };
}

/** Checks the rewrites for a SENTENCE request: no vague words left, an explicit value, and the sentence's own facts kept. */
export function validateSentenceOptions(original: string, terms: string[], raw: Array<{ rewrite: string; note: string }>): { options: WordingOption[]; rejected: number } {
  const seen = new Set<string>([norm(original)]);
  const vague = new Set(terms.flatMap((t) => tokenize(t)));
  const keep = [...new Set(tokenize(original))].filter((t) => !vague.has(t));
  const options: WordingOption[] = [];
  let rejected = 0;
  for (const r of raw) {
    const rewrite = oneLine(r.rewrite);
    const have = new Set(tokenize(rewrite));
    const kept = keep.length === 0 ? 1 : keep.filter((t) => have.has(t)).length / keep.length;
    const ok = rewrite.length >= 10 && rewrite.length <= MAX_SENTENCE_CHARS && !containsVagueWording(rewrite) && isExplicitValue(rewrite) && kept >= MIN_FAITHFUL_SHARE && !seen.has(norm(rewrite));
    if (!ok) {
      rejected++;
      continue;
    }
    seen.add(norm(rewrite));
    options.push({ text: rewrite, note: clip(oneLine(r.note), 200) });
    if (options.length === MAX_OPTIONS) break;
  }
  return { options, rejected: raw.length - options.length };
}

// ------------------------------------------------------------------------------------------------ the call

export class WordingError extends Error {
  constructor(public code: 'bad_answer', message: string) {
    super(message);
    this.name = 'WordingError';
  }
}

/** Asks the local model, then keeps only the options that pass the checks. Throws OllamaError when the model is unusable. */
export async function suggestWording(client: OllamaClient, req: WordingRequest, signal?: AbortSignal): Promise<WordingResult> {
  const sentence = req.mode === 'SENTENCE';
  const reply = await client.chatJson({
    system: sentence ? SENTENCE_SYSTEM : PARAMETER_SYSTEM,
    user: userMessage(req),
    schema: (sentence ? SENTENCE_SCHEMA : PARAMETER_SCHEMA) as unknown as Record<string, unknown>,
    maxTokens: 600,
    signal,
  });
  let checked: { options: WordingOption[]; rejected: number };
  if (req.mode === 'SENTENCE') {
    const parsed = sentenceReply.safeParse(reply.data);
    if (!parsed.success) throw new WordingError('bad_answer', 'The model’s answer did not have the expected shape.');
    checked = validateSentenceOptions(req.sentence, req.terms, parsed.data.options);
  } else {
    const parsed = parameterReply.safeParse(reply.data);
    if (!parsed.success) throw new WordingError('bad_answer', 'The model’s answer did not have the expected shape.');
    checked = validateParameterOptions(req.parameter, parsed.data.options);
  }
  return { mode: req.mode, options: checked.options, model: client.config.model, promptVersion: WORDING_PROMPT_VERSION, rejected: checked.rejected };
}

/** The vague terms of a sentence, as the checks and the prompt will use them. */
export const vagueTermsOf = (sentence: string): string[] => findVagueWording(sentence).flatMap((s) => s.terms);
