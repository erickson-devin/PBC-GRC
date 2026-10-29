import { emptyScopeSummary } from './telemetry/assetScope';
import type { AssetScopeSummary } from './telemetry/assetScope';
import type { CmmcAssetCategory } from '../types/telemetry';
import type { Program } from '../types/program';

/**
 * Boundary asset membership (issue #26), pure helpers. Assets stay tenant-wide; a program declares which of them sit inside its
 * boundary. A program that declares none uses the whole inventory (declared: false). Ids only: no host name, address or note.
 */

/** One program's membership as GET / PATCH .../programs/:id/assets return it. */
export interface ProgramAssets {
  programId: string;
  /** True when the program names at least one asset; false means its boundary is the whole inventory. */
  declared: boolean;
  assetIds: string[];
  /** The scope counts for the declared assets (the whole inventory when not declared), as the server computed them. */
  summary: AssetScopeSummary;
}

/** The program names shown next to an asset. */
export interface MembershipLabel {
  id: string;
  name: string;
  archived: boolean;
  isDefault: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

function parseSummary(raw: unknown): AssetScopeSummary {
  const out = emptyScopeSummary();
  if (!isRecord(raw)) return out;
  out.total = num(raw.total);
  out.inScope = num(raw.inScope);
  out.unconfirmed = num(raw.unconfirmed);
  out.decommissioned = num(raw.decommissioned);
  if (isRecord(raw.byCategory)) {
    for (const key of Object.keys(out.byCategory) as CmmcAssetCategory[]) out.byCategory[key] = num(raw.byCategory[key]);
  }
  return out;
}

/** The body of GET / PATCH .../programs/:id/assets. Anything unreadable gives an empty, undeclared membership. */
export function parseProgramAssets(raw: unknown): ProgramAssets {
  const b = isRecord(raw) ? raw : {};
  const assetIds = ids(b.assetIds);
  return {
    programId: typeof b.programId === 'string' ? b.programId : '',
    declared: typeof b.declared === 'boolean' ? b.declared : assetIds.length > 0,
    assetIds,
    summary: parseSummary(b.summary),
  };
}

/** The body of GET .../programs/asset-memberships as { programId: assetIds }. Rows without a program id are dropped. */
export function parseAssetMemberships(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const rows = isRecord(raw) && Array.isArray(raw.memberships) ? raw.memberships : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.programId !== 'string' || !row.programId) continue;
    out[row.programId] = ids(row.assetIds);
  }
  return out;
}

/** The assets inside a program's boundary: the members when declared, the whole inventory when not. */
export function boundaryAssets<T extends { id: string }>(assets: ReadonlyArray<T>, assetIds: ReadonlyArray<string>, declared: boolean): T[] {
  if (!declared) return [...assets];
  const members = new Set(assetIds);
  return assets.filter((a) => members.has(a.id));
}

/** What to send so the program's members become `wanted`: ids to add and ids to remove (delta, so two editors do not overwrite each other). */
export function membershipDelta(current: ReadonlySet<string>, wanted: ReadonlySet<string>): { add: string[]; remove: string[] } {
  return {
    add: [...wanted].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !wanted.has(id)),
  };
}

/** The programs an asset belongs to, default program first, then in list order. */
export function membershipLabels(
  assetId: string,
  memberships: Readonly<Record<string, ReadonlyArray<string>>>,
  programs: ReadonlyArray<Pick<Program, 'id' | 'name' | 'archived' | 'isDefault'>>
): MembershipLabel[] {
  const labels = programs
    .filter((p) => memberships[p.id]?.includes(assetId))
    .map((p) => ({ id: p.id, name: p.name, archived: Boolean(p.archived), isDefault: Boolean(p.isDefault) }));
  return [...labels.filter((l) => l.isDefault), ...labels.filter((l) => !l.isDefault)];
}
