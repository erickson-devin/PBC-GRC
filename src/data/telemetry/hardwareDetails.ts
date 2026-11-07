import type { EnclaveAsset } from '../../types/telemetry';

/** Free-text limits for the hand-recorded hardware fields (the server enforces the same ones). */
export const HARDWARE_LIMITS = { manufacturer: 255, model: 255, serialNumber: 128, location: 255 } as const;

type HardwareFields = Pick<EnclaveAsset, 'manufacturer' | 'model' | 'serialNumber' | 'location'>;

const clean = (v: string | undefined): string => (v ?? '').trim();

/** One display line, e.g. "Dell PowerEdge R650 · S/N 7XK2L93 · Rack 4"; null when nothing is recorded. */
export function hardwareSummary(a: HardwareFields): string | null {
  const make = [clean(a.manufacturer), clean(a.model)].filter(Boolean).join(' ');
  const serial = clean(a.serialNumber);
  const parts = [make, serial ? `S/N ${serial}` : '', clean(a.location)].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** True when the trimmed, case-insensitive query appears in any hardware field; an empty query matches nothing. */
export function hardwareMatches(a: HardwareFields, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return [a.manufacturer, a.model, a.serialNumber, a.location].some((v) => clean(v).toLowerCase().includes(needle));
}
