import { getFrameworkControls } from '../src/data/frameworks';
import { PROGRAM_SCOPING_KEYS, programFrameworkControls, scopingToOverlays } from '../src/data/programScope';
import type { ComplianceFramework, FrameworkControlDefinition, OverlayFilters } from '../src/types/framework';
import type { Program } from './programs';

/**
 * The controls of a program as its screens list them: the framework's catalog narrowed by the baseline (NIST SP 800-53, the privacy baseline included
 * when the program has it) and by the overlays the program switched on (the same rule as the program card, getProgramMetrics). The catalog text is
 * shipped with the app and is not CUI. Used by the program summary and the global search.
 */
export function programCatalogControls(program: Pick<Program, 'frameworkId' | 'baseline' | 'privacyBaseline' | 'scoping'>): FrameworkControlDefinition[] {
  if (PROGRAM_SCOPING_KEYS.some((k) => program.scoping[k])) {
    return programFrameworkControls({ framework: program.frameworkId as ComplianceFramework, baseline: program.baseline, privacyBaseline: program.privacyBaseline }, scopingToOverlays(program.scoping));
  }
  return program.privacyBaseline
    ? programFrameworkControls({ framework: program.frameworkId as ComplianceFramework, baseline: program.baseline, privacyBaseline: true }, {} as OverlayFilters)
    : getFrameworkControls(program.frameworkId, program.baseline ?? 'ALL_CONTROLS');
}
