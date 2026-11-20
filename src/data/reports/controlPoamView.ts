import type { ControlPoamRecord } from '../../types/controlPoam';

/**
 * #304: the control POA&M fields as the report compilers and the screens read them. Pure; no text of a record is ever logged.
 */

/** What the hook knows about the program's recorded control POA&M fields. `unsupported` is an organization stored only in the browser. */
export type ControlPoamLoad =
  | { status: 'unsupported' } | { status: 'idle' } | { status: 'loading' }
  | { status: 'no_program' } | { status: 'error' } | { status: 'ready'; entries: ControlPoamRecord[] };

/** The records by control id, for generatePOAMEntries and the document compilers. */
export function controlPoamMap(records: readonly ControlPoamRecord[]): Record<string, ControlPoamRecord> {
  const map: Record<string, ControlPoamRecord> = {};
  for (const r of records) map[r.controlId] = r;
  return map;
}

/** What the exports get for a load state: the map once loaded, otherwise undefined (every field then prints as not recorded). */
export function controlPoamExportFor(load: ControlPoamLoad): Record<string, ControlPoamRecord> | undefined {
  return load.status === 'ready' ? controlPoamMap(load.entries) : undefined;
}

/** The list with one saved entry put in (replacing the one of the same control), by control id. */
export function applyControlPoamEntry(entries: readonly ControlPoamRecord[], entry: ControlPoamRecord): ControlPoamRecord[] {
  const rest = entries.filter((e) => e.controlId !== entry.controlId);
  return [...rest, entry].sort((a, b) => (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0));
}
