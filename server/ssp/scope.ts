import { getFrameworkControls } from '../../src/data/frameworks';
import type { FrameworkControlDefinition } from '../../src/types/framework';
import type { SspBaseline, SspImportFramework } from './types';

const TIER: Record<SspBaseline, 'LOW_LOW_LOW' | 'MOD_MOD_MOD' | 'HIGH_HIGH_HIGH'> = { LOW: 'LOW_LOW_LOW', MODERATE: 'MOD_MOD_MOD', HIGH: 'HIGH_HIGH_HIGH' };

/**
 * The controls an import is measured against: every control of a CMMC level, or for NIST SP 800-53 the controls and control
 * enhancements of one SP 800-53B baseline (Moderate unless chosen otherwise).
 */
export function baselineControls(framework: SspImportFramework, baseline?: SspBaseline | null): FrameworkControlDefinition[] {
  return framework === 'NIST_800_53_REV5' ? getFrameworkControls(framework, TIER[baseline ?? 'MODERATE']) : getFrameworkControls(framework);
}
