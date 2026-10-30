import type { OverlayFilters } from '../types/framework';
import type { ProgramScoping } from '../types/program';
import { scopingToOverlays } from './programScope';

// The framework, baseline tier, CIA triad and overlays come from the active program. Only a browser-only tenant keeps its overlays here.
export const overlayFiltersStorageKey = (tenantId: string) => `pbc_overlay_filters_${tenantId}`;

/** A browser-only tenant's saved overlays (all off when none or unreadable). */
export function readBrowserOverlayFilters(tenantId: string): OverlayFilters {
  try {
    const saved = localStorage.getItem(overlayFiltersStorageKey(tenantId));
    if (saved) return scopingToOverlays(JSON.parse(saved) as ProgramScoping);
  } catch {
    // overlay filters storage load fallback
  }
  return { nonNetworkedOnly: false };
}

/** The overlays a browser-only tenant's matrix applies: its saved ones on NIST 800-53, none on any other framework. */
export function browserTenantOverlays(framework: string, overlays?: OverlayFilters): OverlayFilters {
  return framework === 'NIST_800_53_REV5' && overlays ? overlays : { nonNetworkedOnly: false };
}
