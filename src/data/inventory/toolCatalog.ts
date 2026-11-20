import type { CmmcAssetCategory } from '../../types/telemetry';
import { TOOL_DEPLOYMENTS, TOOL_TYPES, type ToolDeployment, type ToolInput, type ToolType } from '../../types/inventory';
import { isCmmcAssetCategory } from '../telemetry/assetScope';
import { getEquivalentControlIds } from '../frameworks/controlMappings';

/**
 * Quick-add catalog of commonly used tools and services (#247). Plain factual data written by us: a commonly written
 * product name, the vendor company, a generic one-line mission, how it is usually deployed and which CMMC Level 2
 * practices it typically supports. No versions, prices, links, taglines or authorization claims, and nothing here
 * is a statement about a customer's environment. The data (toolCatalog.json) is injected so the browser can load it lazily.
 */
export interface ToolCatalogEntry {
  id: string;
  name: string;
  /** Company name; empty for the generic managed-service entries. */
  vendor: string;
  toolType: ToolType;
  mission: string;
  /** As commonly offered; the first is the default. */
  deployments: ToolDeployment[];
  defaultAssetCategory: CmmcAssetCategory;
  /** CMMC Level 2 practice ids, at most MAX_TYPICAL_CONTROLS. */
  typicalControls: string[];
  aliases?: string[];
}

export interface ToolCatalog {
  _meta: { schemaVersion: 1; compiledBy: string; asOf: string; notice: string };
  tools: ToolCatalogEntry[];
}

export const MAX_TYPICAL_CONTROLS = 12;
export const MAX_CATALOG_NAME = 80;
export const MIN_CATALOG_MISSION = 10;
export const MAX_CATALOG_MISSION = 140;
export const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The list of problems found in a raw catalog, [] when it is well formed. `cmmcL2Ids` is the set of CMMC Level 2 control ids. */
export function validateToolCatalog(raw: unknown, cmmcL2Ids: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ['catalog is not an object'];
  const meta = raw._meta;
  if (!isObj(meta)) problems.push('_meta is missing');
  else {
    if (meta.schemaVersion !== 1) problems.push('_meta.schemaVersion is not 1');
    for (const k of ['compiledBy', 'asOf', 'notice']) if (typeof meta[k] !== 'string' || !meta[k]) problems.push(`_meta.${k} is missing`);
    if (typeof meta.asOf === 'string' && !ISO_DATE.test(meta.asOf)) problems.push('_meta.asOf is not an ISO date');
  }
  if (!Array.isArray(raw.tools)) return [...problems, 'tools is not a list'];
  const ids = new Set<string>();
  const names = new Set<string>();
  raw.tools.forEach((t, i) => {
    const at = `tools[${i}]`;
    if (!isObj(t)) {
      problems.push(`${at} is not an object`);
      return;
    }
    if (typeof t.id !== 'string' || !CATALOG_ID_PATTERN.test(t.id)) problems.push(`${at}.id is malformed`);
    else if (ids.has(t.id)) problems.push(`${at}.id repeats an id`);
    else ids.add(t.id);
    if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > MAX_CATALOG_NAME) problems.push(`${at}.name is missing or too long`);
    else if (names.has(t.name.toLowerCase())) problems.push(`${at}.name repeats a name`);
    else names.add(t.name.toLowerCase());
    if (typeof t.vendor !== 'string' || t.vendor.length > 255) problems.push(`${at}.vendor is malformed`);
    if (typeof t.toolType !== 'string' || !(TOOL_TYPES as readonly string[]).includes(t.toolType)) problems.push(`${at}.toolType is not a known type`);
    if (typeof t.mission !== 'string' || t.mission.length < MIN_CATALOG_MISSION || t.mission.length > MAX_CATALOG_MISSION) problems.push(`${at}.mission length is out of bounds`);
    if (!Array.isArray(t.deployments) || t.deployments.length === 0 || !t.deployments.every((d) => (TOOL_DEPLOYMENTS as readonly unknown[]).includes(d)) || new Set(t.deployments).size !== t.deployments.length) problems.push(`${at}.deployments is malformed`);
    if (!isCmmcAssetCategory(t.defaultAssetCategory)) problems.push(`${at}.defaultAssetCategory is not a CMMC asset category`);
    if (!Array.isArray(t.typicalControls) || t.typicalControls.length > MAX_TYPICAL_CONTROLS) problems.push(`${at}.typicalControls is malformed or over ${MAX_TYPICAL_CONTROLS}`);
    else if (!t.typicalControls.every((c) => typeof c === 'string' && cmmcL2Ids.has(c)) || new Set(t.typicalControls).size !== t.typicalControls.length) problems.push(`${at}.typicalControls names an unknown or repeated control`);
    if (t.aliases !== undefined && (!Array.isArray(t.aliases) || !t.aliases.every((a) => typeof a === 'string' && a.length > 0 && a.length <= MAX_CATALOG_NAME))) problems.push(`${at}.aliases is malformed`);
  });
  return problems;
}

/** Case-insensitive match on name, vendor and aliases (every word of the query must appear), optionally limited to one type. Alphabetical by name. */
export function searchCatalog(c: ToolCatalog, q: string, type?: ToolType): ToolCatalogEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return c.tools
    .filter((e) => (!type || e.toolType === type) && words.every((w) => `${e.name} ${e.vendor} ${(e.aliases ?? []).join(' ')}`.toLowerCase().includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The register input for a catalog entry: category and deployment are pre-filled (the user may change them). seedKey is 'catalog:<id>'. */
export function catalogEntryToInput(e: ToolCatalogEntry, overrides: Partial<ToolInput> = {}): ToolInput & { seedKey: string } {
  return {
    name: e.name,
    vendorName: e.vendor,
    mission: e.mission,
    toolType: e.toolType,
    deployment: e.deployments[0] ?? null,
    assetCategory: e.defaultAssetCategory,
    ...overrides,
    seedKey: `catalog:${e.id}`,
  };
}

/**
 * The entry's typical controls that exist in a program's catalog: the id itself, else the single equivalent id of another
 * framework that the program has (an ambiguous equivalence is left out). A suggestion only: a link is a compliance
 * assertion, so the user must tick it.
 */
export function suggestedControlsForProgram(e: ToolCatalogEntry, programCatalogIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of e.typicalControls) {
    if (programCatalogIds.has(id)) {
      out.push(id);
      continue;
    }
    const match = [...new Set(getEquivalentControlIds(id))].filter((x) => programCatalogIds.has(x));
    if (match.length === 1) out.push(match[0]);
  }
  return [...new Set(out)];
}
