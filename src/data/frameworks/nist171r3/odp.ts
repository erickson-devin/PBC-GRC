import type { FrameworkControlDefinition } from '../../../types/framework';
import catalogFile from './catalog.generated.json';
import type { GeneratedR3CatalogFile } from './types';
import { DOD_ODP_DEFAULTS, type DodOdpDefaults } from './odpDefaults';

const catalog = catalogFile as unknown as GeneratedR3CatalogFile;

/**
 * Adds the DoD default value to the parameters of the controls: parameter "<id>#n" is the ODP at requirements[i].odps[n - 1].
 * Only when the table is verified as a whole and the entry is verified. Pure: returns new objects, the input is not changed.
 */
export function attachDodDefaults(controls: FrameworkControlDefinition[], defaults: DodOdpDefaults = DOD_ODP_DEFAULTS): FrameworkControlDefinition[] {
  if (!defaults.meta.verified) return controls;
  const odpsOf = new Map(catalog.requirements.map((r) => [r.id, r.odps]));
  return controls.map((c) => {
    const odps = odpsOf.get(c.id);
    if (!odps || !c.parameters) return c;
    const parameters = c.parameters.map((p) => {
      const n = Number(p.id.slice(p.id.lastIndexOf('#') + 1));
      const entry = Number.isInteger(n) && n >= 1 ? defaults.values[odps[n - 1]] : undefined;
      return entry && entry.verified && entry.value ? { ...p, defaultValue: entry.value, defaultSource: 'DOD_ODP' as const } : p;
    });
    return { ...c, parameters };
  });
}

/** The provenance of the DoD table, or null while it is not verified (nothing from it is in use). */
export function dodDefaultsMeta(defaults: DodOdpDefaults = DOD_ODP_DEFAULTS): DodOdpDefaults['meta'] | null {
  return defaults.meta.verified ? defaults.meta : null;
}

/** Problems with a defaults table: a key that is not an ODP with a tag of its own, or a verified table without its provenance. */
export function checkDodDefaults(defaults: DodOdpDefaults, odps: GeneratedR3CatalogFile['odps']): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(defaults.values)) {
    if (!odps[id]) problems.push(`${id} is not an ODP of the catalog`);
    else if (odps[id].placement !== 'TAG') problems.push(`${id} has placement ${odps[id].placement}, so it has no statement tag to take a default`);
  }
  if (defaults.meta.verified) {
    if (!defaults.meta.date || !defaults.meta.url) problems.push('the DoD defaults are marked verified but meta.date or meta.url is empty');
    if (!/^[0-9a-f]{64}$/i.test(defaults.meta.sha256)) problems.push('the DoD defaults are marked verified but meta.sha256 is not 64 hex characters');
  }
  return problems;
}
