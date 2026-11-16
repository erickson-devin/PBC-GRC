import { cmmcDisplayId } from './cmmcGuide/displayId';

/** The control matrix's search placeholder and empty-filter message (#294). Pure: no React, no storage, no logging. */

/** The example id is shown the way the program shows its ids (a Level 2 program shows the Level 2 guide id, not the stored one). */
export function matrixSearchPlaceholder(shortName: string, firstControlId: string | undefined, framework: string): string {
  return `Search ${shortName} by control ID (e.g. ${firstControlId ? cmmcDisplayId(firstControlId, framework) : 'AC-2'}), title, authority reference, or keywords...`;
}

export function matrixEmptyFilterMessage(f: { catalog: boolean; metMismatch: boolean }): string {
  if (f.catalog && f.metMismatch) {
    return 'The filters "Met with open objectives" and "Changed by the objective update" are on. Clear them or the other filters to see more controls.';
  }
  if (f.catalog) return 'The filter "Changed by the objective update" is on. Clear it or the other filters to see more controls.';
  if (f.metMismatch) return 'The filter "Met with open objectives" is on. Clear it or the other filters to see more controls.';
  return 'Try clearing your search query or switching family and status filters.';
}
