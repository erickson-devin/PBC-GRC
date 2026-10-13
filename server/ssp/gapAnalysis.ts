import { getFrameworkControls } from '../../src/data/frameworks';
import { NIST_800_171A_REGISTRY } from '../../src/data/frameworks/assessmentObjectives';
import { groundQuote } from './grounding';
import { numberOf } from './controlMapper';
import type { OllamaClient } from './ollama';
import { GAP_SCHEMA, GAP_SYSTEM, gapReply, gapUserMessage } from './prompts';
import type { GapAnalysis, GapItem, ObjectiveAssessment, SspImportFramework } from './types';

/**
 * Gap analysis: how does what the document says compare with what the control requires, objective by objective?
 *
 * The objectives are the official NIST SP 800-171A determination statements ([a], [b], [c]...) for the control. The model
 * is shown the requirement, the objectives and the document's own text for that control, and decides for each objective
 * whether the document addresses it. It is not trusted on that: a claim of ADDRESSED or PARTIAL stands only if the model
 * can point to a passage that really is in the document (see grounding.ts); otherwise the objective is marked UNSUPPORTED.
 * Objectives nothing speaks to always produce a gap, whatever the model listed.
 */

const SEVERITY_ORDER: Record<GapItem['severity'], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const MAX_GAPS = 12;

export interface ObjectiveDef {
  letter: string;
  text: string;
}

/** The 800-171A objectives of a control (falling back to the catalog's own list, lettered a, b, c...). */
export function objectivesFor(controlId: string, framework: SspImportFramework): ObjectiveDef[] {
  const number = numberOf(controlId);
  const official = number ? NIST_800_171A_REGISTRY[number]?.objectives : undefined;
  if (official && official.length > 0) return official.map((o) => ({ letter: o.letter.toLowerCase(), text: o.text }));
  const def = getFrameworkControls(framework).find((c) => c.id === controlId);
  return (def?.assessmentObjectives ?? []).map((text, i) => ({ letter: String.fromCharCode(97 + i), text }));
}

const normLetter = (raw: string): string => raw.trim().toLowerCase().replace(/^[\[(]|[\])]$/g, '').replace(/[.:]$/, '');

export interface GapInput {
  controlId: string;
  framework: SspImportFramework;
  /** The document's own text where this control is described (never the model's summary). */
  excerpts: string;
}

/**
 * Compares the document's text for one control with its requirement and objectives. Throws OllamaError when the model cannot
 * be used; the caller decides what to show instead.
 */
export async function analyzeGaps(client: OllamaClient, input: GapInput, signal?: AbortSignal): Promise<GapAnalysis> {
  const def = getFrameworkControls(input.framework).find((c) => c.id === input.controlId);
  if (!def) throw new Error(`Unknown control ${input.controlId}`);
  const objectives = objectivesFor(input.controlId, input.framework);
  const requirement = [def.plainEnglishSummary, def.discussion].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  const reply = await client.chatJson({
    system: GAP_SYSTEM,
    user: gapUserMessage({ controlId: def.id, title: def.title, requirement, objectives, excerpts: input.excerpts }),
    schema: GAP_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    signal,
  });
  const parsed = gapReply.safeParse(reply.data);
  if (!parsed.success) throw new Error('The model’s gap analysis did not have the expected shape.');
  return buildGapAnalysis(parsed.data, objectives, input.excerpts);
}

/** Turns the model's (validated) answer into a GapAnalysis, applying the grounding rules. Pure. */
export function buildGapAnalysis(
  reply: { summary: string; objectives: Array<{ letter: string; status: 'ADDRESSED' | 'PARTIAL' | 'NOT_ADDRESSED'; evidence: string }>; gaps: Array<{ severity: GapItem['severity']; objective: string; missingElement: string; recommendation: string }> },
  objectives: ObjectiveDef[],
  excerpts: string
): GapAnalysis {
  const known = new Set(objectives.map((o) => o.letter));
  const byLetter = new Map(reply.objectives.map((o) => [normLetter(o.letter), o]));

  const assessed: ObjectiveAssessment[] = objectives.map((def) => {
    const claim = byLetter.get(def.letter);
    if (!claim) return { letter: def.letter, text: def.text, status: 'NOT_ASSESSED' };
    if (claim.status === 'NOT_ADDRESSED') return { letter: def.letter, text: def.text, status: 'NOT_ADDRESSED' };
    const grounded = groundQuote(excerpts, 0, claim.evidence);
    return grounded.ok
      ? { letter: def.letter, text: def.text, status: claim.status, evidence: grounded.quote.quote }
      : { letter: def.letter, text: def.text, status: 'UNSUPPORTED' };
  });

  const gaps: GapItem[] = [];
  for (const g of reply.gaps) {
    const letter = normLetter(g.objective);
    gaps.push({
      severity: g.severity,
      ...(known.has(letter) ? { objective: letter } : {}),
      missingElement: g.missingElement.trim(),
      recommendation: g.recommendation.trim(),
    });
  }
  // Whatever the model listed, an objective the document does not address is a gap
  for (const o of assessed) {
    if (o.status === 'ADDRESSED' || o.status === 'PARTIAL') continue;
    if (gaps.some((g) => g.objective === o.letter)) continue;
    gaps.push(
      o.status === 'NOT_ADDRESSED'
        ? { severity: 'MEDIUM', objective: o.letter, missingElement: `Objective [${o.letter}] is not addressed`, recommendation: `Describe how the organisation meets: ${o.text}.` }
        : o.status === 'UNSUPPORTED'
          ? { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] is not supported by the text`, recommendation: `The model said this is addressed but could not point to a passage that says so. Check the document, and state plainly: ${o.text}.` }
          : { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] was not assessed`, recommendation: `Review the document against: ${o.text}.` }
    );
  }
  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.objective ?? '').localeCompare(b.objective ?? ''));

  const total = assessed.length;
  const addressed = assessed.filter((o) => o.status === 'ADDRESSED').length;
  const partial = assessed.filter((o) => o.status === 'PARTIAL').length;
  const tally = total === 0 ? 'No assessment objectives are defined for this control.' : `${addressed} of ${total} assessment objectives addressed${partial ? `, ${partial} partly` : ''}.`;
  const modelSummary = reply.summary.trim().slice(0, 400);
  return {
    source: 'ai',
    summary: modelSummary ? `${tally} ${modelSummary}` : tally,
    gaps: gaps.slice(0, MAX_GAPS),
    objectives: assessed,
  };
}
