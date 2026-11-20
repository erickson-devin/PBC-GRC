import type { ControlObjectivesTemplate } from '../assessmentObjectives';
import type { GeneratedObjectives } from '../nist80053/types';
import objectivesFile from './objectives.generated.json';
import catalogFile from './catalog.generated.json';
import type { GeneratedR3CatalogFile, GeneratedR3ObjectivesFile } from './types';

/**
 * NIST SP 800-171A Rev. 3 assessment objectives (determination statements) and assessment methods, for every requirement of
 * SP 800-171 Rev. 3. The file is small (about 150 KB), so unlike the SP 800-53A data it is imported statically: there is no
 * loading step and these functions answer from the first call.
 */
const store = (objectivesFile as unknown as GeneratedR3ObjectivesFile).objectives;
const titles = new Map((catalogFile as unknown as GeneratedR3CatalogFile).requirements.map((r) => [r.id, r.title]));

const templateCache = new Map<string, ControlObjectivesTemplate | null>();

const ID = /^(\d{2})\.(\d{2})\.(\d{2})$/;
/**
 * "03.01.01" -> "03.01.01". Anything else gives '': in particular a Rev. 2 id such as "3.1.1" or "AC.L2-3.1.1" is NOT read as a
 * Rev. 3 id, so Rev. 2 and Rev. 3 can never answer for each other.
 */
export function canonicalR3Id(raw: string): string {
  const m = (raw ?? '').trim().match(ID);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

/** One objective per determination statement (the ODP statements first): what the requirement checklist shows. */
export function nist171r3ObjectiveTemplate(controlId: string): ControlObjectivesTemplate | undefined {
  const id = canonicalR3Id(controlId);
  if (!id) return undefined;
  if (templateCache.has(id)) return templateCache.get(id) ?? undefined;
  const entry = store[id];
  const result: ControlObjectivesTemplate | null = entry
    ? {
        controlNumber: id,
        family: id.slice(0, 5),
        title: titles.get(id) ?? id,
        // The letters are already unique within the requirement and plain letter-or-digit ("b01", "odp01")
        objectives: entry.objectives.filter((o) => o.text).map((o) => ({ letter: o.letter, text: o.text!, prefilledTemplate: '' })),
      }
    : null;
  templateCache.set(id, result);
  return result ?? undefined;
}

export function nist171r3AssessmentMethods(controlId: string): GeneratedObjectives['methods'] | undefined {
  const id = canonicalR3Id(controlId);
  return id ? store[id]?.methods : undefined;
}
