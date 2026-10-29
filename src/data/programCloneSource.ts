import { normalizeProgramFramework } from './programSync';
import type { Program } from '../types/program';

/**
 * The program the "clone from an existing program" seed starts on: the active program when it is open and on the chosen
 * framework, else the first open program on that framework, else '' (no program of that framework: the user must choose).
 */
export function defaultCloneSourceId(
  openPrograms: readonly Pick<Program, 'id' | 'framework'>[],
  activeProgramId: string | null | undefined,
  framework: string,
): string {
  const wanted = normalizeProgramFramework(framework);
  const same = openPrograms.filter((p) => wanted !== null && normalizeProgramFramework(p.framework) === wanted);
  if (activeProgramId && same.some((p) => p.id === activeProgramId)) return activeProgramId;
  return same[0]?.id ?? '';
}
