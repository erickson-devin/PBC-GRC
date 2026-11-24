import { getSprsPointDeduction } from './sprsCompiler';

/**
 * How many controls fall in each SPRS point class (the matrix impact chips): 5, 3 and 1 point deductions, and `none` for the
 * requirement that carries no point value (3.12.4, the System Security Plan). The four counts add up to the controls given.
 */
export function sprsWeightCounts(controls: readonly { id: string }[]): { five: number; three: number; one: number; none: number } {
  const counts = { five: 0, three: 0, one: 0, none: 0 };
  for (const c of controls) {
    const w = getSprsPointDeduction(c.id);
    if (w === 5) counts.five++;
    else if (w === 3) counts.three++;
    else if (w === 1) counts.one++;
    else counts.none++;
  }
  return counts;
}
