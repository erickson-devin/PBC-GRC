import { getFrameworkControls } from './frameworks/frameworkRegistry';
import type { CiaTriadSelection, ComplianceFramework, FrameworkControlDefinition, ImpactLevel, OverlayFilters } from '../types/framework';
import type { Program, ProgramBaseline } from '../types/program';

/**
 * What a program's framework and baseline mean for the controls shown. Pure; the catalogs in src/data/frameworks are read, not changed.
 */

/** The CIA triad a program's baseline stands for: the same level three times, or "all controls" without a baseline. */
export function programBaselineToCia(baseline: ProgramBaseline | null | undefined): CiaTriadSelection {
  if (baseline === 'LOW' || baseline === 'MODERATE' || baseline === 'HIGH') {
    const level: ImpactLevel = baseline;
    return { confidentiality: level, integrity: level, availability: level, isAllControlsApplied: false };
  }
  return { confidentiality: 'LOW', integrity: 'LOW', availability: 'LOW', isAllControlsApplied: true };
}

/** The controls of a program: its framework's catalog, narrowed by the baseline (NIST SP 800-53) and the overlays. */
export function programFrameworkControls(
  program: Pick<Program, 'framework' | 'baseline'>,
  overlays: OverlayFilters
): FrameworkControlDefinition[] {
  const framework: ComplianceFramework | string = program.framework;
  const isNist = framework === 'NIST_800_53_REV5' || framework === 'nist-800-53-r5';
  const baseline = isNist ? programBaselineToCia(program.baseline) : 'ALL_CONTROLS';
  return getFrameworkControls(framework, baseline, overlays);
}
