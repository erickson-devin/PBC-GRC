// Cost and renewal roll-ups of the Tools and Services register (#249). Pure: money is whole US cents (never floating point) and "today" is passed in,
// so nothing reads the clock. The server leaves `annualCostCents` out for the read roles: an absent key is "not available", never zero, so a roll-up of
// such rows says `available: false` instead of printing 0.

import type { CmmcAssetCategory } from '../../types/telemetry';
import type { InventoryTool } from '../../types/inventory';
import { CMMC_ASSET_CATEGORIES } from '../telemetry/assetScope';

export type CostCategory = CmmcAssetCategory | 'UNCLASSIFIED';

export interface CostRollup {
  /** False when the rows carry no cost at all (a read role): the totals are then not zero but unknown, and must not be shown. */
  available: boolean;
  totalCents: number;
  byCategory: Record<CostCategory, number>;
  /** Tools with a recorded annual cost. */
  withCost: number;
  /** Tools whose cost is not recorded (0 when the cost is not available). */
  missingCost: number;
}

const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const blankByCategory = (): Record<CostCategory, number> => {
  const out = { UNCLASSIFIED: 0 } as Record<CostCategory, number>;
  for (const c of CMMC_ASSET_CATEGORIES) out[c] = 0;
  return out;
};

/** True when the cost reaches this role: any row carries the key (null means recorded as blank). An empty register has nothing to hide. */
export function costVisible(tools: Pick<InventoryTool, 'annualCostCents'>[]): boolean {
  return tools.length === 0 || tools.some((t) => 'annualCostCents' in t);
}

/** Total annual cost in cents, per CMMC asset category (no category: UNCLASSIFIED; out-of-scope tools are counted in their own category). */
export function rollupCosts(tools: Pick<InventoryTool, 'annualCostCents' | 'assetCategory'>[]): CostRollup {
  const available = costVisible(tools);
  const out: CostRollup = { available, totalCents: 0, byCategory: blankByCategory(), withCost: 0, missingCost: 0 };
  if (!available) return out;
  for (const t of tools) {
    if (isCents(t.annualCostCents)) {
      out.totalCents += t.annualCostCents;
      out.byCategory[t.assetCategory ?? 'UNCLASSIFIED'] += t.annualCostCents;
      out.withCost += 1;
    } else {
      out.missingCost += 1;
    }
  }
  return out;
}

/**
 * The roll-up of each program, by program id: the tools the program declares, or the whole register for a program that declares none (the same
 * rule as the program's boundary everywhere else). A declared id that is no longer in the register counts for nothing.
 */
export function rollupByProgram(
  tools: Pick<InventoryTool, 'id' | 'annualCostCents' | 'assetCategory'>[],
  memberships: { programId: string; declared: boolean; toolIds: string[] }[]
): Record<string, CostRollup> {
  const out: Record<string, CostRollup> = {};
  for (const m of memberships) {
    const ids = new Set(m.toolIds);
    out[m.programId] = rollupCosts(m.declared ? tools.filter((t) => ids.has(t.id)) : tools);
  }
  return out;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day number (days since 1970-01-01, UTC) of a real YYYY-MM-DD date; null for anything else. */
function dayNumber(iso: string): number | null {
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

/**
 * The items whose renewal date falls from `today` through `days` days after it (today counts, a date that has passed does not), soonest first.
 * `today` is a YYYY-MM-DD date passed in by the caller; an item with no or an invalid date is left out.
 */
export function upcomingRenewals(items: { id: string; renewalDate: string | null }[], today: string, days: number): { id: string; renewalDate: string; daysLeft: number }[] {
  const start = dayNumber(today);
  if (start === null) return [];
  const out: { id: string; renewalDate: string; daysLeft: number }[] = [];
  for (const it of items) {
    if (!it.renewalDate) continue;
    const day = dayNumber(it.renewalDate);
    if (day === null) continue;
    const daysLeft = day - start;
    if (daysLeft >= 0 && daysLeft <= days) out.push({ id: it.id, renewalDate: it.renewalDate, daysLeft });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.id.localeCompare(b.id));
}
