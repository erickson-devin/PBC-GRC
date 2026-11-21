// The per-domain status rows of the dashboard chart (#252): one stacked bar per domain, built without a chart library. Every row carries its text
// alternative (`text`), so the bar is never the only way to read it. Pure: types only.

import type { DomainStat } from '../../types/cmmc';

export type DomainChartStatus = 'MET' | 'IN_PROGRESS' | 'NOT_MET' | 'NOT_STARTED';

export interface DomainChartRow {
  code: string;
  name: string;
  total: number;
  /** Always the four statuses in this order (Met, In progress, Not met, Not started); empty for a domain with no controls. `pct` sums to 100. */
  segments: { status: DomainChartStatus; count: number; pct: number }[];
  /** e.g. "AC: 1 met, 1 in progress, 0 not met, 1 not started, of 3". */
  text: string;
}

/** Whole percentages that sum to exactly 100 (largest remainder; a tie goes to the earlier segment). Zero total gives all zeros. */
function percentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c / total) * 100);
  const floors = exact.map((x) => Math.floor(x));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] += 1;
    left -= 1;
  }
  return floors;
}

/** One row per domain of `domains`, in its order (the registry's); a domain with stats but not in `domains` follows, by code. */
export function domainChartRows(stats: Record<string, DomainStat>, domains: Record<string, { name: string }>): DomainChartRow[] {
  const codes = [...Object.keys(domains), ...Object.keys(stats).filter((c) => !(c in domains)).sort()];
  return codes.map((code) => {
    const s = stats[code];
    const name = domains[code]?.name ?? code;
    const total = s?.total ?? 0;
    if (!s || total === 0) return { code, name, total: 0, segments: [], text: `${code}: no controls` };
    const counts = [s.met, s.inProgress, s.notMet, s.notStarted];
    const pct = percentages(counts);
    const statuses: DomainChartStatus[] = ['MET', 'IN_PROGRESS', 'NOT_MET', 'NOT_STARTED'];
    return {
      code,
      name,
      total,
      segments: statuses.map((status, i) => ({ status, count: counts[i], pct: pct[i] })),
      text: `${code}: ${s.met} met, ${s.inProgress} in progress, ${s.notMet} not met, ${s.notStarted} not started, of ${total}`,
    };
  });
}

/** One sentence for the figure caption. */
export function domainChartSummary(rows: DomainChartRow[]): string {
  const withControls = rows.filter((r) => r.total > 0);
  if (withControls.length === 0) return 'No controls in any domain.';
  const met = withControls.reduce((n, r) => n + (r.segments[0]?.count ?? 0), 0);
  const total = withControls.reduce((n, r) => n + r.total, 0);
  const complete = withControls.filter((r) => r.segments[0]?.count === r.total).length;
  return `Control status across ${withControls.length} ${withControls.length === 1 ? 'domain' : 'domains'}: ${met} of ${total} controls Met; ${complete} ${complete === 1 ? 'domain is' : 'domains are'} fully Met.`;
}
