import { useMemo } from 'react';
import { useAssessment } from '../context/AssessmentContext';
import { useTenant } from '../context/TenantContext';
import { useProgramSummary } from './useProgramSummary';
import { useSspProfile } from './useSspProfile';
import { computeJourney, type JourneyStep } from '../data/journey/programJourney';
import { computeSspCompleteness, resolveSspCompletenessInput } from '../data/ssp/sspCompleteness';
import { exportFormDefaults, getExportGaps } from '../data/reports/exportReadiness';
import { getDefaultDocumentTypeForFramework } from '../data/reports/documentCompilers';
import { getSspGaps, sprsAppliesTo } from '../data/reports/sprsCompiler';
import { memberIsExpired } from '../data/membershipView';
import { isOwnerLevel } from '../utils/roles';

/** Objectives with an answer (Met, Not met or Not applicable): the Assess step's advisory figure, for the CMMC catalogs that carry objectives. */
const ANSWERED = new Set(['MET', 'NOT_MET', 'NOT_APPLICABLE']);

/**
 * The six steps of the program journey (#251) for the active program. It adds no rule of its own: the server's summary (people, inventory and document
 * inputs, sign-offs) is composed with what the client already holds (control statuses, SSP metadata and profile, the export form's defaults) and handed
 * to computeJourney. A browser-only organization gets no summary, so its Tools and Documents steps read as unavailable. Always six steps, in order.
 */
export function useProgramJourney(): JourneyStep[] {
  const { currentTenant, activeProgram, activeFramework, teamMembers } = useTenant();
  const { state, metrics, frameworkControls, getObjectivesForControl } = useAssessment();
  const { summary } = useProgramSummary();
  const { profile } = useSspProfile();
  const serverBacked = Boolean(currentTenant.serverBacked);
  const meta = state.sspMetadata;
  const members = teamMembers[currentTenant.id];

  const ssp = useMemo(
    () => computeSspCompleteness({
      ...resolveSspCompletenessInput({ meta, tenant: currentTenant, program: activeProgram, framework: activeFramework, profile }),
      inventory: summary?.inventory,
      documents: summary?.documents ?? undefined,
    }),
    [meta, currentTenant, activeProgram, activeFramework, profile, summary]
  );

  const exportGaps = useMemo(() => {
    const defaults = exportFormDefaults({ meta, tenant: currentTenant, program: activeProgram, framework: activeFramework });
    return getExportGaps(getDefaultDocumentTypeForFramework(activeFramework), defaults, { profile, framework: activeFramework, inventory: summary?.inventory, documents: summary?.documents ?? undefined });
  }, [meta, currentTenant, activeProgram, activeFramework, profile, summary]);

  const sprsGate = useMemo(() => {
    if (!sprsAppliesTo(activeFramework)) return null;
    const defaults = exportFormDefaults({ meta, tenant: currentTenant, program: activeProgram, framework: activeFramework });
    return getSspGaps(frameworkControls, state.controls, {
      systemName: defaults.systemName ?? '',
      organizationName: defaults.organizationName ?? '',
      systemOwner: defaults.systemOwner ?? '',
      systemBoundaryScope: defaults.boundaryDescription ?? '',
    });
  }, [meta, currentTenant, activeProgram, activeFramework, frameworkControls, state.controls]);

  const objectives = useMemo(() => {
    if (activeFramework !== 'CMMC_L1' && activeFramework !== 'CMMC_L2') return null;
    let answered = 0;
    let total = 0;
    for (const c of frameworkControls) {
      for (const o of getObjectivesForControl(c.id)) {
        total += 1;
        if (ANSWERED.has(o.status)) answered += 1;
      }
    }
    return { answered, total };
  }, [activeFramework, frameworkControls, getObjectivesForControl]);

  const ownerLevel = useMemo(() => {
    const now = Date.now();
    return (members ?? []).filter((m) => m.status === 'ACTIVE' && isOwnerLevel(m.role) && !memberIsExpired(m, now)).length;
  }, [members]);

  return useMemo(
    () => computeJourney({
      framework: activeFramework,
      serverBacked,
      members: { ownerLevel },
      summary,
      ssp,
      assess: { total: metrics.totalControls, met: metrics.metCount, inProgress: metrics.inProgressCount, notMet: metrics.notMetCount, objectives },
      exportGaps,
      sprsGate,
    }),
    [activeFramework, serverBacked, ownerLevel, summary, ssp, metrics, objectives, exportGaps, sprsGate]
  );
}
