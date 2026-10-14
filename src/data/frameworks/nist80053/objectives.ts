import type { ControlObjectivesTemplate } from '../assessmentObjectives';
import type { GeneratedObjective, GeneratedObjectives } from './types';

/**
 * NIST SP 800-53A Rev. 5 assessment objectives (determination statements) and assessment methods, for every control and
 * enhancement of the catalog. The data is large (1.3 MB), so it is not part of the catalog module: the server loads it at start
 * (objectivesNode.ts) and the browser loads it on demand (objectivesLazy.ts). Until it has been loaded these functions return
 * nothing and callers fall back to what they used before.
 */
let store: Record<string, GeneratedObjectives> | null = null;

export function setNist80053Objectives(data: Record<string, GeneratedObjectives>): void {
  store = data;
  templateCache.clear();
  gapCache.clear();
}
export const hasNist80053Objectives = (): boolean => store !== null;

const templateCache = new Map<string, ControlObjectivesTemplate | null>();
const gapCache = new Map<string, Array<{ letter: string; text: string }>>();

const ID = /^([A-Z]{2})-(\d+)(?:\((\d+)\))?$/i;
/** "ac-2(1)" and "AC-02(01)" -> "AC-2(1)". Anything that is not an SP 800-53 id gives ''. */
export function canonical80053Id(raw: string): string {
  const m = raw.trim().replace(/\s+/g, '').match(ID);
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}${m[3] ? `(${Number(m[3])})` : ''}` : '';
}

function uniqueLetters(list: GeneratedObjective[]): Array<{ letter: string; o: GeneratedObjective }> {
  const seen = new Set<string>();
  return list.map((o) => {
    const base = o.letter.toLowerCase().replace(/[^a-z0-9]/g, '') || 'a';
    let letter = base;
    for (let n = 2; seen.has(letter); n++) letter = `${base}x${n}`;
    seen.add(letter);
    return { letter, o };
  });
}

const leaves = (list: GeneratedObjective[]): GeneratedObjective[] => list.filter((o) => o.text);

/** One objective per leaf determination statement: what the control checklist shows. */
export function nist80053ObjectiveTemplate(controlId: string): ControlObjectivesTemplate | undefined {
  const id = canonical80053Id(controlId);
  if (!id || !store) return undefined;
  if (templateCache.has(id)) return templateCache.get(id) ?? undefined;
  const entry = store[id];
  const result: ControlObjectivesTemplate | null = entry
    ? {
        controlNumber: id,
        family: id.slice(0, 2),
        title: id,
        // The app keys an objective as CONTROL[letter] with a plain letter-or-digit suffix: "a.[01]" becomes "a01"
        objectives: uniqueLetters(leaves(entry.objectives)).map(({ letter, o }) => ({ letter, text: o.text!, prefilledTemplate: '' })),
      }
    : null;
  templateCache.set(id, result);
  return result ?? undefined;
}

/**
 * The objectives a gap analysis asks about: one per top-level item of the control (a, b, c...), its sub-objectives joined. A
 * control such as AC-2 has 38 leaf statements but twelve items; asking the local model about twelve is practical, about 38 is not.
 */
export function nist80053GapObjectives(controlId: string): Array<{ letter: string; text: string }> {
  const id = canonical80053Id(controlId);
  if (!id || !store) return [];
  const cached = gapCache.get(id);
  if (cached) return cached;
  const list = store[id]?.objectives ?? [];
  const children = new Map<string, GeneratedObjective[]>();
  for (const o of list) if (o.parent) children.set(o.parent, [...(children.get(o.parent) ?? []), o]);
  const textOf = (o: GeneratedObjective): string[] => (o.text ? [o.text] : (children.get(o.id) ?? []).flatMap(textOf));
  const out = list
    .filter((o) => !o.parent)
    .map((o) => ({ letter: o.letter.toLowerCase(), text: textOf(o).join('; ') }))
    .filter((o) => o.text);
  gapCache.set(id, out);
  return out;
}

export function nist80053AssessmentMethods(controlId: string): GeneratedObjectives['methods'] | undefined {
  const id = canonical80053Id(controlId);
  return id && store ? store[id]?.methods : undefined;
}
