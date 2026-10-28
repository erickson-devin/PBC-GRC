import { nistControlsWithPrivacy } from '../../src/data/programScope';
import type { CoverageReport, SspBaseline } from './types';

/**
 * The coverage of an SSP import into a NIST SP 800-53 program that has the privacy baseline (issue #20): measured against the
 * program's security baseline plus the SP 800-53B privacy baseline, each control once. Pure. The staged suggestions are not
 * affected; a control found outside the union is still staged and just does not count here (as in coverageFor).
 */
export function privacyCoverage(baseline: SspBaseline | null, foundIds: ReadonlySet<string>): CoverageReport {
  const catalog = nistControlsWithPrivacy(baseline ?? 'MODERATE', true);
  return {
    framework: 'NIST_800_53_REV5',
    baseline: baseline ?? 'MODERATE',
    privacy: true,
    totalControls: catalog.length,
    foundControls: catalog.filter((c) => foundIds.has(c.id)).length,
    missing: catalog.map((c) => c.id).filter((id) => !foundIds.has(id)),
  };
}
