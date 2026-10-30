/**
 * Event Horizon: Singularity - Automated SPRS & DoD eMASS Export Engine
 * Computes official DoD Supplier Performance Risk System (SPRS) scores (-203 to +110)
 * and generates structured eMASS Control Implementation Matrix CSVs.
 *
 * Source: NIST SP 800-171 DoD Assessment Methodology, Version 1.2.1 (24 June 2020), Annex A.
 * Method: start at 110; for each requirement that is NOT implemented, subtract its value (5, 3 or 1).
 * Annex A assigns 44 requirements 5 points, 14 requirements 3 points and 51 requirements 1 point
 * (total 313, so a fully non-compliant system scores 110 - 313 = -203). Requirement 3.12.4 (the SSP)
 * has no point value ("NA"): it gates scoring instead (see isSspComplete).
 */

import { FrameworkControlDefinition } from '../../types/framework';
import { ControlState, SSPMetadata } from '../../types/cmmc';
import { ReportMetadata, POAMEntry } from '../../types/report';
import { SprsScoreResult } from '../../types/audit';

export const SPRS_MAX_SCORE = 110;
export const SPRS_MIN_SCORE = -203;
/** Sum of every Annex A deduction: SPRS_MAX_SCORE - SPRS_MIN_SCORE. */
export const SPRS_TOTAL_POSSIBLE_DEDUCTION = 313;

/** NIST SP 800-171 requirement that is the System Security Plan. Not point-weighted ("NA"); gates the score. */
export const SPRS_SSP_REQUIREMENT = '3.12.4';

// 44 requirements @ 5 points (Annex A, Version 1.2.1)
export const SPRS_FIVE_POINT_REQUIREMENTS = new Set([
  '3.1.1', '3.1.2', '3.1.12', '3.1.13', '3.1.16', '3.1.17', '3.1.18',
  '3.2.1', '3.2.2',
  '3.3.1', '3.3.5',
  '3.4.1', '3.4.2', '3.4.5', '3.4.6', '3.4.7', '3.4.8',
  '3.5.1', '3.5.2', '3.5.3', '3.5.10',
  '3.6.1', '3.6.2',
  '3.7.2', '3.7.5',
  '3.8.3', '3.8.7',
  '3.9.2',
  '3.10.1', '3.10.2',
  '3.11.2',
  '3.12.1', '3.12.3',
  '3.13.1', '3.13.2', '3.13.5', '3.13.6', '3.13.11', '3.13.15',
  '3.14.1', '3.14.2', '3.14.3', '3.14.4', '3.14.6',
]);

// 14 requirements @ 3 points (Annex A, Version 1.2.1). Every other requirement except 3.12.4 is 1 point (51).
export const SPRS_THREE_POINT_REQUIREMENTS = new Set([
  '3.1.5', '3.1.19',
  '3.3.2',
  '3.7.1', '3.7.4',
  '3.8.1', '3.8.2', '3.8.8',
  '3.9.1',
  '3.11.1',
  '3.12.2',
  '3.13.8',
  '3.14.5', '3.14.7',
]);

/**
 * Extracts normalized NIST SP 800-171 requirement number (e.g. "AC.L1-3.1.1" -> "3.1.1").
 */
export function extractNistRequirementId(controlId: string): string {
  const match = controlId.match(/(\d+\.\d+\.\d+)/);
  if (match) return match[1];
  return controlId;
}

/**
 * Returns the DoD SPRS point deduction (5, 3 or 1) for an unmet requirement,
 * or 0 for 3.12.4 (SSP), which carries no point value.
 */
export function getSprsPointDeduction(controlId: string): number {
  const nistId = extractNistRequirementId(controlId);
  if (nistId === SPRS_SSP_REQUIREMENT) return 0;
  if (SPRS_FIVE_POINT_REQUIREMENTS.has(nistId)) return 5;
  if (SPRS_THREE_POINT_REQUIREMENTS.has(nistId)) return 3;
  return 1;
}

/** The SSP fields that must be filled in before a System Security Plan can be considered complete. */
type SspIdentity = Pick<SSPMetadata, 'systemName' | 'organizationName' | 'systemOwner' | 'systemBoundaryScope'>;

const hasText = (value: string | undefined | null): boolean => Boolean(value && value.trim().length > 0);

/**
 * SSP gate. DoD Assessment Methodology section 5(g): the assessment is based on review of the SSP,
 * so "it is not possible to conduct the assessment" without one. The SSP is complete when
 * requirement 3.12.4 is marked MET AND the plan's identification and boundary fields are filled in.
 * Returns a human-readable list of what is still missing (empty = gate open).
 */
export function getSspGaps(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  sspMetadata: SspIdentity | null | undefined
): string[] {
  const gaps: string[] = [];

  const sspControl = controls.find((c) => extractNistRequirementId(c.id) === SPRS_SSP_REQUIREMENT);
  if (!sspControl) {
    gaps.push('Requirement 3.12.4 (System Security Plan) is not part of this control catalog');
  } else if (controlStates[sspControl.id]?.status !== 'MET') {
    gaps.push('Requirement 3.12.4 (System Security Plan) is not marked MET');
  }

  const fields: [keyof SspIdentity, string][] = [
    ['systemName', 'System name'],
    ['organizationName', 'Organization name'],
    ['systemOwner', 'System owner'],
    ['systemBoundaryScope', 'System boundary scope'],
  ];
  for (const [key, label] of fields) {
    if (!hasText(sspMetadata?.[key])) gaps.push(`${label} is empty in the SSP`);
  }

  return gaps;
}

export function isSspComplete(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  sspMetadata: SspIdentity | null | undefined
): boolean {
  return getSspGaps(controls, controlStates, sspMetadata).length === 0;
}

/**
 * Calculates the DoD SPRS / CMMC Level 2 assessment score.
 *
 *   score = 110 - sum(value of every requirement that is not MET)
 *
 * Without a completed SSP (see isSspComplete) no score can be calculated: `score` is null and
 * `scoreStatus` is 'NOT_SCORED'. Counts and deductions are still reported so the gap is visible.
 * IN_PROGRESS and NOT_STARTED requirements count as not implemented; a POA&M earns no credit.
 */
export function calculateSprsScore(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  sspMetadata: SspIdentity | null | undefined
): SprsScoreResult {
  let totalDeductions = 0;
  let metCount = 0;
  let inProgressCount = 0;
  let notMetCount = 0;
  let notStartedCount = 0;

  const deductionsByWeight = {
    fivePoint: [] as string[],
    threePoint: [] as string[],
    onePoint: [] as string[],
  };

  for (const ctrl of controls) {
    const status = controlStates[ctrl.id]?.status || 'NOT_STARTED';
    const weight = getSprsPointDeduction(ctrl.id);

    if (status === 'MET') {
      metCount++;
      continue;
    }

    if (status === 'IN_PROGRESS') inProgressCount++;
    else if (status === 'NOT_MET') notMetCount++;
    else notStartedCount++;

    if (weight === 0) continue; // 3.12.4: gates the score, carries no deduction

    totalDeductions += weight;
    if (weight === 5) deductionsByWeight.fivePoint.push(ctrl.id);
    else if (weight === 3) deductionsByWeight.threePoint.push(ctrl.id);
    else deductionsByWeight.onePoint.push(ctrl.id);
  }

  const completionPercentage = controls.length > 0 ? Math.round((metCount / controls.length) * 100) : 0;
  const sspGaps = getSspGaps(controls, controlStates, sspMetadata);
  const sspComplete = sspGaps.length === 0;

  return {
    score: sspComplete ? SPRS_MAX_SCORE - totalDeductions : null,
    scoreStatus: sspComplete ? 'SCORED' : 'NOT_SCORED',
    sspGaps,
    notScoredReason: sspComplete
      ? undefined
      : 'No completed System Security Plan (requirement 3.12.4). The DoD Assessment Methodology does not allow a score without one.',
    maxScore: SPRS_MAX_SCORE,
    minScore: SPRS_MIN_SCORE,
    totalControls: controls.length,
    metCount,
    inProgressCount,
    notMetCount,
    notStartedCount,
    totalDeductions,
    deductionsByWeight,
    completionPercentage,
  };
}

/** SPRS point values exist only for CMMC Level 2 (NIST SP 800-171). */
export const sprsAppliesTo = (framework: string | null | undefined): boolean => framework === 'CMMC_L2';

/** Plain-language notes on what the eMASS CSV contains for a framework. */
export function emassCsvNotes(framework: string): string[] {
  const notes = ['One row per control of this program: its ID, title, domain, implementation status, narrative, responsible role, evaluation date and verified artifacts.'];
  if (!sprsAppliesTo(framework)) notes.push('The SPRS Weight column reads N/A: SPRS point values exist only for CMMC Level 2.');
  if (framework !== 'CMMC_L1' && framework !== 'CMMC_L2') notes.push('The NIST SP 800-171 Ref column reads N/A: this framework does not map to NIST SP 800-171 requirements.');
  return notes;
}

/**
 * Generates RFC 4180 compliant eMASS Control Implementation Matrix CSV.
 * Formatted for direct upload to DoD Enterprise Mission Assurance Support Service.
 */
export function generateEmassControlMatrixCsv(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  metadata: ReportMetadata
): string {
  const headers = [
    'System ID / Name',
    'CAGE Code',
    'Control ID',
    'NIST SP 800-171 Ref',
    'Control Title',
    'Domain',
    'Implementation Status',
    'SPRS Weight',
    'Implementation Narrative / Justification',
    'Responsible Role',
    'Test / Evaluation Date',
    'Verified Artifacts',
    'POA&M Scheduled Date',
  ];

  const escapeCsv = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null) return '""';
    const text = String(val).replace(/"/g, '""');
    return `"${text}"`;
  };

  let csv = headers.map(h => `"${h}"`).join(',') + '\r\n';
  const sprsApplies = sprsAppliesTo(metadata.framework);
  const mapsTo171 = metadata.framework === 'CMMC_L1' || metadata.framework === 'CMMC_L2';

  for (const ctrl of controls) {
    const state = controlStates[ctrl.id];
    const status = state?.status || 'NOT_STARTED';
    const nistId = extractNistRequirementId(ctrl.id);
    const weight = getSprsPointDeduction(ctrl.id);

    let emassStatus = 'Not Implemented';
    if (status === 'MET') emassStatus = 'Implemented';
    else if (status === 'IN_PROGRESS') emassStatus = 'Planned / In Progress';

    const narrative = state?.implementationNotes || ctrl.plainEnglishSummary || 'Pending assessor evaluation.';
    const role = state?.responsibleRole || 'Information System Security Officer (ISSO)';
    const evalDate = state?.lastUpdated ? state.lastUpdated.split('T')[0] : metadata.assessmentDate || new Date().toISOString().split('T')[0];

    const row = [
      escapeCsv(metadata.systemName || 'Enclave System'),
      escapeCsv(metadata.cageCode || 'N/A'),
      escapeCsv(ctrl.id),
      escapeCsv(mapsTo171 ? nistId : 'N/A'),
      escapeCsv(ctrl.title),
      escapeCsv(ctrl.domain),
      escapeCsv(emassStatus),
      escapeCsv(!sprsApplies ? 'N/A' : status === 'MET' || weight === 0 ? 0 : -weight),
      escapeCsv(narrative),
      escapeCsv(role),
      escapeCsv(evalDate),
      escapeCsv(state?.tags ? state.tags.join('; ') : 'Self-Assessment Narrative'),
      escapeCsv(status !== 'MET' ? '90 Days from Baseline' : 'N/A'),
    ];

    csv += row.join(',') + '\r\n';
  }

  return csv;
}

/**
 * Generates an official SPRS Assessment Summary Record for submission.
 */
export function generateSprsAssessmentSummary(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  metadata: ReportMetadata,
  poamEntries: POAMEntry[] = []
): Record<string, any> {
  const sprs = calculateSprsScore(controls, controlStates, {
    systemName: metadata.systemName,
    organizationName: metadata.organizationName,
    systemOwner: metadata.systemOwner,
    systemBoundaryScope: metadata.boundaryDescription,
  });

  return {
    sprsSubmissionHeader: {
      platform: 'Event Horizon: Singularity (Pitch Black Cyber)',
      authority: 'Defense Federal Acquisition Regulation Supplement (DFARS) 252.204-7019 / 7020',
      submissionType: 'Basic Assessment (Self-Assessment)',
      confidenceLevel: 'Low / Medium (Contractor Enclave Self-Attestation)',
      assessmentDate: metadata.assessmentDate || new Date().toISOString().split('T')[0],
      exportTimestamp: new Date().toISOString(),
    },
    organizationProfile: {
      commercialEntity: metadata.organizationName,
      cageCode: metadata.cageCode || 'N/A',
      samStatus: metadata.samStatus || 'Active',
      systemName: metadata.systemName,
      systemOwner: metadata.systemOwner,
      primaryAssessor: metadata.primaryAssessor,
      enclaveBoundaryScope: metadata.boundaryDescription,
    },
    sprsMetrics: {
      activeSprsScore: sprs.score ?? 'NOT SCORED',
      scoreStatus: sprs.scoreStatus,
      notScoredReason: sprs.notScoredReason ?? null,
      maximumPossibleScore: sprs.maxScore,
      totalRequirementsEvaluated: sprs.totalControls,
      implementedControls: sprs.metCount,
      inProgressControls: sprs.inProgressCount,
      unmetControls: sprs.notMetCount,
      totalDeductions: sprs.totalDeductions,
      readinessPercentage: `${sprs.completionPercentage}%`,
      compliancePosture:
        sprs.scoreStatus === 'NOT_SCORED'
          ? 'Not Scored: System Security Plan required'
          : sprs.score === SPRS_MAX_SCORE
          ? 'Full NIST SP 800-171 Compliance'
          : 'POA&M Remediation Underway',
    },
    deficienciesBreakdown: {
      criticalFivePointDeductions: sprs.deductionsByWeight.fivePoint,
      intermediateThreePointDeductions: sprs.deductionsByWeight.threePoint,
      standardOnePointDeductions: sprs.deductionsByWeight.onePoint,
    },
    remediationMilestonesSummary: {
      totalPoamWeaknesses: poamEntries.length,
      estimatedRemediationHorizon: poamEntries.length > 0 ? '90 Days' : '0 Days (Audit Ready)',
      activeWeaknesses: poamEntries.slice(0, 10).map(p => ({
        weaknessId: p.weaknessId,
        controlId: p.controlId,
        targetDate: p.scheduledCompletionDate,
        responsibleRole: p.responsibleRole,
      })),
    },
  };
}

/**
 * Downloads the eMASS Control Matrix CSV.
 */
export function downloadEmassCsv(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  metadata: ReportMetadata
): void {
  const csv = generateEmassControlMatrixCsv(controls, controlStates, metadata);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (metadata.systemName || 'enclave').toLowerCase().replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `${safeName}_emass_matrix_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Downloads the official SPRS Assessment Summary JSON.
 */
export function downloadSprsSummaryJson(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  metadata: ReportMetadata,
  poamEntries: POAMEntry[] = []
): void {
  const summary = generateSprsAssessmentSummary(controls, controlStates, metadata, poamEntries);
  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (metadata.cageCode || metadata.systemName || 'sprs').toLowerCase().replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `sprs_assessment_${safeName}_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Display text for a score: "+105", "-12", "0", or "Not Scored" when no completed SSP exists. */
export function formatSprsScore(result: Pick<SprsScoreResult, 'score'>): string {
  if (result.score === null) return 'Not Scored';
  return result.score > 0 ? `+${result.score}` : String(result.score);
}
