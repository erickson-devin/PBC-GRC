import { ControlStatus, DomainStat } from '../../types/cmmc';

/**
 * Aggregates per-domain (control family) compliance statistics.
 * Single source of truth shared by the dashboard metrics and the exported reports.
 *
 * @param controls     Controls in scope for the active framework
 * @param controlStates Evaluation state by control ID (missing => NOT_STARTED)
 * @param seedDomains  Optional domain codes to always include, even with zero controls
 */
export function computeDomainStats(
  controls: ReadonlyArray<{ id: string; domain: string }>,
  controlStates: Readonly<Record<string, { status: ControlStatus } | undefined>>,
  seedDomains: ReadonlyArray<string> = []
): Record<string, DomainStat> {
  const stats: Record<string, DomainStat> = {};
  const empty = (): DomainStat => ({ total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 });

  for (const code of seedDomains) {
    stats[code] = empty();
  }

  for (const ctrl of controls) {
    const stat = (stats[ctrl.domain] ??= empty());
    const status = controlStates[ctrl.id]?.status ?? 'NOT_STARTED';
    stat.total += 1;
    if (status === 'MET') stat.met += 1;
    else if (status === 'IN_PROGRESS') stat.inProgress += 1;
    else if (status === 'NOT_MET') stat.notMet += 1;
    else stat.notStarted += 1;
  }

  for (const stat of Object.values(stats)) {
    stat.percentage = stat.total > 0 ? Math.round((stat.met / stat.total) * 100) : 0;
  }

  return stats;
}
