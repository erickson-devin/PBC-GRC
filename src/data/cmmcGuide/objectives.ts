/**
 * Assessment objectives for CMMC controls, taken from the CMMC Assessment Guide (see guide.ts). Every other framework's
 * controls still go through the frozen resolver in src/data/frameworks/assessmentObjectives.ts, unchanged.
 *
 * The hand-written parts of the old registry (the implementation template, the SCAP rule, the telemetry flag, the ODPs) are
 * carried over only to a guide objective whose wording is the same after normalisation. Everything else gets the generic
 * wording the old resolver gave a control it had no template for.
 */
import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import {
  FAR_L1_TO_800_171_MAP,
  NIST_800_171A_REGISTRY,
  getAssessmentObjectivesForControl,
  normalizeControlNumber,
} from '../frameworks/assessmentObjectives';
import type { ObjectiveDefinitionTemplate } from '../frameworks/assessmentObjectives';
import { findControlDefinition, getFrameworkControls } from '../frameworks/frameworkRegistry';
import type { FrameworkControlDefinition } from '../../types/framework';
import { cmmcNumberOf, guideObjectives } from './guide';
import { normalizeObjectiveText } from './validate';

export { normalizeObjectiveText };

export interface CarriedObjective {
  /** The registry key the template came from: '3.1.7', or a FAR key such as 'AC.L1-b.1.i'. */
  sourceKey: string;
  /** The letter it had there, which can differ from the guide's. */
  sourceLetter: string;
  def: ObjectiveDefinitionTemplate;
}

const definitionIndex = new Map<string, Map<string, FrameworkControlDefinition>>();

function definitionOf(controlId: string, framework: string): FrameworkControlDefinition | undefined {
  let own = definitionIndex.get(framework);
  if (!own) {
    own = new Map(getFrameworkControls(framework).map((c) => [c.id, c]));
    definitionIndex.set(framework, own);
  }
  return own.get(controlId) ?? findControlDefinition(controlId);
}

/** The objectives a control had before the guide: exactly what the frozen resolver gave it (AssessmentContext resolved it the same way). */
export function legacyObjectives(controlId: string, framework: string): AssessmentObjective[] {
  const def = definitionOf(controlId, framework);
  return getAssessmentObjectivesForControl(controlId, def?.title, def?.assessmentObjectives);
}

/** The registry entry the frozen resolver used for a CMMC control id (it checks the FAR map first), with its key. */
function legacyEntry(controlId: string): { key: string; objectives: ObjectiveDefinitionTemplate[] } | undefined {
  const trimmed = controlId.trim();
  const normNum = normalizeControlNumber(trimmed);
  const mapped = FAR_L1_TO_800_171_MAP[trimmed.toLowerCase()] || FAR_L1_TO_800_171_MAP[normNum.toLowerCase()];
  const candidates = [mapped, trimmed, trimmed.toUpperCase(), trimmed.toLowerCase(), normNum, normNum.toUpperCase()];
  for (const key of candidates) {
    if (key && NIST_800_171A_REGISTRY[key]) {
      return NIST_800_171A_REGISTRY[key].objectives.length > 0 ? { key, objectives: NIST_800_171A_REGISTRY[key].objectives } : undefined;
    }
  }
  return undefined;
}

const carryCache = new Map<string, Record<string, CarriedObjective>>();

/** For each guide letter that keeps a hand-written template: where it came from. A letter missing from the map has none. */
export function cmmcCarryOver(controlId: string, framework: string): Record<string, CarriedObjective> {
  const cacheKey = `${framework}|${controlId}`;
  const cached = carryCache.get(cacheKey);
  if (cached) return cached;
  const out: Record<string, CarriedObjective> = {};
  const number = cmmcNumberOf(controlId);
  if (number) {
    const legacy = legacyEntry(controlId);
    const byNumber = NIST_800_171A_REGISTRY[number];
    const sources: Array<{ key: string; objectives: ObjectiveDefinitionTemplate[] }> = [];
    if (legacy) sources.push(legacy);
    if (byNumber && byNumber.objectives.length > 0 && legacy?.key !== number) sources.push({ key: number, objectives: byNumber.objectives });
    for (const g of guideObjectives(number, framework)) {
      const want = normalizeObjectiveText(g.text);
      for (const src of sources) {
        const hits = src.objectives.filter((o) => normalizeObjectiveText(o.text) === want);
        if (hits.length === 1) {
          out[g.letter] = { sourceKey: src.key, sourceLetter: hits[0].letter, def: hits[0] };
          break;
        }
      }
    }
  }
  carryCache.set(cacheKey, out);
  return out;
}

/** Where a guide objective's hand-written template came from, or null when it has none. */
export function cmmcCascadeSource(controlId: string, letter: string, framework: string): { key: string; letter: string } | null {
  const c = cmmcCarryOver(controlId, framework)[letter];
  return c ? { key: c.sourceKey, letter: c.sourceLetter } : null;
}

/** The guide letters of a control that have a hand-written template to cascade. */
export function cmmcCascadeLetters(controlId: string, framework: string): string[] {
  return Object.keys(cmmcCarryOver(controlId, framework)).sort();
}

/**
 * The objectives of a control. A CMMC control ('AC.L2-3.1.1', 'AC.L1-3.1.1') gets one objective per letter of the guide;
 * any other control gets the frozen resolver's answer, unchanged. A stored record supplies the status, narrative and evidence;
 * its text and every hand-written extra are replaced, so a stale cached extra cannot survive.
 */
export function getControlObjectives(
  controlId: string,
  controlTitle?: string,
  existingObjectives?: string[],
  customStore?: Record<string, AssessmentObjective>,
  framework: string = 'CMMC_L2'
): AssessmentObjective[] {
  const number = cmmcNumberOf(controlId);
  if (!number) return getAssessmentObjectivesForControl(controlId, controlTitle, existingObjectives, customStore);

  const carry = cmmcCarryOver(controlId, framework);
  return guideObjectives(number, framework).map((g) => {
    const objId = `${controlId}[${g.letter}]`;
    const carried = carry[g.letter]?.def;
    const prefilledTemplate = carried
      ? carried.prefilledTemplate
      : `The enclave implementation satisfies requirement ${number}[${g.letter}] (${g.text}). Compliance is enforced across cloud identity (**Microsoft Entra ID**), endpoint baselines (**Microsoft Intune** / **DISA STIG**s), and network perimeter controls with verified operational configurations.`;
    const existing = customStore?.[objId];
    if (existing) {
      return {
        ...existing,
        text: g.text,
        prefilledTemplate,
        scapRuleId: carried?.scapRuleId,
        isAutoVerifiedByTelemetry: Boolean(carried?.isAutoVerifiedByTelemetry),
        odpParameters: carried ? existing.odpParameters || carried.odpParameters : undefined,
      };
    }
    return {
      id: objId,
      controlId,
      letter: g.letter,
      text: g.text,
      status: 'NOT_STARTED' as ObjectiveStatus,
      prefilledTemplate,
      implementationNarrative: '',
      linkedEvidenceIds: [],
      isAutoVerifiedByTelemetry: Boolean(carried?.isAutoVerifiedByTelemetry),
      scapRuleId: carried?.scapRuleId,
      odpParameters: carried?.odpParameters,
    };
  });
}
