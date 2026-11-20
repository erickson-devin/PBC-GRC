// What the SSP prints and checks of the Tools and Services register and the data inventory (#239, #243): section 1.3 (System Details, with 1.3.1 the
// number of end users and privileged users per tool) and 1.4 (Information Types: FCI and the CUI categories). The compiled SSP, the Markdown export
// and the on-screen document take their rows from here, so they word the same data the same way. Pure: types, the asset-scope labels and the output
// defaults only. A value that was never recorded prints as "Not recorded"; nothing here touches storage, the network or the console (names may be CUI).

import type { CmmcAssetCategory } from '../../types/telemetry';
import type { ReportSubsection } from '../../types/report';
import type { DataInventoryRecord, InventoryTool, ProgramInventory, ToolDeployment } from '../../types/inventory';
import type { SspItemStatus } from '../ssp/sspCompleteness';
import type { CuiRegistry } from '../cui/cuiRegistry';
import { CATEGORY_INFO } from '../telemetry/assetScope';
import { NOT_RECORDED } from '../reports/documentDefaults';
import { boundaryTools } from './toolRegisterView';

export interface SspInventoryToolRow {
  id: string;
  name: string;
  deployment: ToolDeployment | null;
  assetCategory: CmmcAssetCategory | null;
  endUsers: number | null;
  privilegedUsers: number | null;
}

export interface SspInventoryCategoryRow {
  /** The registry's category id (the banner abbreviation). */
  id: string;
  /** The registry name; null when the registry is not loaded or no longer lists the id. */
  name: string | null;
  /** 'SPECIFIED' | 'BASIC' | 'BOTH' | 'NONE' from the registry; null without a registry entry. */
  designation: string | null;
  /** The registry's grouping name; null without a registry entry. */
  indexGroup: string | null;
  /** The banner marking(s) the registry lists, for example CUI//SP-CTI; null where none is listed. */
  bannerMarking: string | null;
  /** The tools (by name) that store, process or transmit it. */
  stores: string[];
  processes: string[];
  transmits: string[];
}

/** The register and the data inventory as the SSP prints them. */
export interface SspInventorySnapshot {
  /** False for a browser-only organization, or when nothing was loaded: the SSP then says the sections are not available. */
  supported: boolean;
  /** The program's boundary tools, out-of-scope ones left out (D11), by name. */
  tools: SspInventoryToolRow[];
  handlesFci: boolean | null;
  categories: SspInventoryCategoryRow[];
  /** The `asOf` of the CUI Registry list the category names come from; null without a registry. */
  registryAsOf: string | null;
}

export const SYSTEM_DETAILS_HEADERS = ['Tool or service', 'Deployment', 'CMMC asset category', 'End users', 'Privileged users'];
export const DATA_INVENTORY_HEADERS = ['CUI category', 'Banner marking', 'Basic / Specified', 'Stored in', 'Processed in', 'Transmitted by'];

/** What 1.3 and 1.4 state for an organization stored only in this browser. */
export const INVENTORY_NOT_AVAILABLE = 'Not available: the Tools and Services register needs a server-backed organization.';
export const NO_TOOLS_RECORDED = 'No tools or services are recorded in this system boundary.';
export const NO_CUI_CATEGORIES_SELECTED = 'No CUI categories selected.';
export const CMMC_L2_NEEDS_CUI_CATEGORY = 'A CMMC Level 2 program must select at least one CUI category.';

const DEPLOYMENT_LABELS: Record<ToolDeployment, string> = { ON_PREM: 'On-premises', CLOUD: 'Cloud', ESP: 'External service provider' };
const DESIGNATION_LABELS: Record<string, string> = { BASIC: 'Basic', SPECIFIED: 'Specified', BOTH: 'Basic or Specified', NONE: 'No designation listed' };

const byName = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);

const yesNo = (v: boolean | null): string => (v === true ? 'Yes' : v === false ? 'No' : NOT_RECORDED);

const bannerOf = (c: CuiRegistry['categories'][number]): string | null => {
  const banners = [c.basicBanner, c.specifiedBanner].filter((b): b is string => typeof b === 'string' && b !== '');
  return banners.length > 0 ? banners.join(' / ') : c.marking;
};

interface InventorySources {
  supported: boolean;
  tools: InventoryTool[];
  program: Pick<ProgramInventory, 'declared' | 'toolIds'> | null;
  data: DataInventoryRecord | null;
  registry: CuiRegistry | null;
}

/** The tools of the program's boundary (the whole register while it declares none), in the order and shape both outputs and the completeness check use. */
function boundaryOf(a: InventorySources): InventoryTool[] {
  return boundaryTools(a.tools, a.program ?? { declared: false, toolIds: [] });
}

/**
 * The snapshot the SSP prints: the boundary tools (an out-of-scope tool is not part of 1.3.1) and the data inventory with registry names. Unsupported
 * gives an empty snapshot with `supported: false`. A category the registry does not list keeps its id and no name; a tool that no longer exists is skipped.
 */
export function buildSspInventorySnapshot(a: InventorySources): SspInventorySnapshot {
  if (!a.supported) return { supported: false, tools: [], handlesFci: null, categories: [], registryAsOf: null };
  const tools: SspInventoryToolRow[] = boundaryOf(a)
    .filter((t) => t.assetCategory !== 'OUT_OF_SCOPE')
    .map((t) => ({ id: t.id, name: t.name, deployment: t.deployment, assetCategory: t.assetCategory, endUsers: t.endUsers, privilegedUsers: t.privilegedUsers }))
    .sort((x, y) => byName(x.name, y.name) || x.id.localeCompare(y.id));
  const nameOf = new Map(a.tools.map((t) => [t.id, t.name]));
  const regById = new Map((a.registry?.categories ?? []).map((c) => [c.id, c]));
  const groupName = new Map((a.registry?.indexGroups ?? []).map((g) => [g.id, g.name]));
  const namesWith = (rows: DataInventoryRecord['categories'][number]['tools'], role: 'stores' | 'processes' | 'transmits'): string[] =>
    rows
      .filter((r) => r[role])
      .map((r) => nameOf.get(r.toolId))
      .filter((n): n is string => typeof n === 'string')
      .sort(byName);
  const categories: SspInventoryCategoryRow[] = (a.data?.categories ?? [])
    .map((c) => {
      const reg = regById.get(c.categoryId);
      return {
        id: c.categoryId,
        name: reg?.name ?? null,
        designation: reg?.designation ?? null,
        indexGroup: reg ? groupName.get(reg.indexGroup) ?? null : null,
        bannerMarking: reg ? bannerOf(reg) : null,
        stores: namesWith(c.tools, 'stores'),
        processes: namesWith(c.tools, 'processes'),
        transmits: namesWith(c.tools, 'transmits'),
      };
    })
    .sort((x, y) => byName(x.name ?? x.id, y.name ?? y.id) || x.id.localeCompare(y.id));
  return { supported: true, tools, handlesFci: a.data?.handlesFci ?? null, categories, registryAsOf: a.registry?._meta.asOf ?? null };
}

const count = (n: number | null): string => (n === null ? NOT_RECORDED : String(n));

/** 1.3.1: one row per tool, headers SYSTEM_DETAILS_HEADERS; a missing count prints "Not recorded". */
export function systemDetailsTableRows(s: SspInventorySnapshot): string[][] {
  return s.tools.map((t) => [
    t.name,
    t.deployment ? DEPLOYMENT_LABELS[t.deployment] : NOT_RECORDED,
    t.assetCategory ? CATEGORY_INFO[t.assetCategory].label : NOT_RECORDED,
    count(t.endUsers),
    count(t.privilegedUsers),
  ]);
}

/** 1.4: one row per selected category, headers DATA_INVENTORY_HEADERS; a role with no tool prints "Not recorded". */
export function dataInventoryTableRows(s: SspInventorySnapshot): string[][] {
  const list = (names: string[]): string => (names.length > 0 ? names.join('; ') : NOT_RECORDED);
  return s.categories.map((c) => [
    c.name ?? c.id,
    c.bannerMarking ?? NOT_RECORDED,
    c.designation ? DESIGNATION_LABELS[c.designation] ?? NOT_RECORDED : NOT_RECORDED,
    list(c.stores),
    list(c.processes),
    list(c.transmits),
  ]);
}

/** 1.3 System Details and 1.3.1 Number of End Users and Privileged Users. Unsupported: a single "not available" item. */
export function systemDetailsSubsections(s: SspInventorySnapshot): ReportSubsection[] {
  if (!s.supported) return [{ title: '1.3 System Details', items: [{ label: 'Tools and Services register', value: INVENTORY_NOT_AVAILABLE }] }];
  return [
    {
      title: '1.3 System Details',
      content: 'The tools and services in the system boundary, as recorded in the Tools and Services register. Tools documented as out of scope are not listed.',
    },
    s.tools.length === 0
      ? { title: '1.3.1 Number of End Users and Privileged Users', content: NO_TOOLS_RECORDED }
      : { title: '1.3.1 Number of End Users and Privileged Users', table: { headers: SYSTEM_DETAILS_HEADERS, rows: systemDetailsTableRows(s) } },
  ];
}

/** 1.4 Information Types (FCI and CUI). Unsupported: a single "not available" item. */
export function dataInventorySubsection(s: SspInventorySnapshot, framework: string): ReportSubsection {
  const title = '1.4 Information Types (FCI and CUI)';
  if (!s.supported) return { title, items: [{ label: 'Information types', value: INVENTORY_NOT_AVAILABLE }] };
  const items = [
    { label: 'Federal Contract Information (FCI)', value: yesNo(s.handlesFci) },
    ...(s.registryAsOf ? [{ label: 'CUI category list (NARA CUI Registry) as of', value: s.registryAsOf }] : []),
  ];
  if (s.categories.length === 0) {
    return { title, content: framework === 'CMMC_L2' ? `${NO_CUI_CATEGORIES_SELECTED} ${CMMC_L2_NEEDS_CUI_CATEGORY}` : NO_CUI_CATEGORIES_SELECTED, items };
  }
  return { title, items, table: { headers: DATA_INVENTORY_HEADERS, rows: dataInventoryTableRows(s) } };
}

const mdCell = (v: string): string => v.replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|');
const mdTable = (headers: string[], rows: string[][]): string =>
  `| ${headers.map(mdCell).join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`).join('\n')}\n`;

/** The Markdown of 1.3, 1.3.1 and 1.4 (the same rows as the compiled SSP), ending with a blank line, placed after 1.2 in the Markdown SSP. */
export function sspInventoryMarkdown(s: SspInventorySnapshot, framework: string): string {
  let md = `## 1.3 System Details\n\n`;
  if (!s.supported) return `${md}${INVENTORY_NOT_AVAILABLE}\n\n## 1.4 Information Types (FCI and CUI)\n\n${INVENTORY_NOT_AVAILABLE}\n\n`;
  md += `### 1.3.1 Number of End Users and Privileged Users\n\n`;
  md += s.tools.length === 0 ? `${NO_TOOLS_RECORDED}\n\n` : `${mdTable(SYSTEM_DETAILS_HEADERS, systemDetailsTableRows(s))}\n`;
  md += `## 1.4 Information Types (FCI and CUI)\n\n`;
  md += `- **Federal Contract Information (FCI):** ${yesNo(s.handlesFci)}\n`;
  if (s.registryAsOf) md += `- **CUI category list (NARA CUI Registry) as of:** ${s.registryAsOf}\n`;
  md += `\n`;
  md += s.categories.length === 0
    ? `${framework === 'CMMC_L2' ? `${NO_CUI_CATEGORIES_SELECTED} ${CMMC_L2_NEEDS_CUI_CATEGORY}` : NO_CUI_CATEGORIES_SELECTED}\n\n`
    : `${mdTable(DATA_INVENTORY_HEADERS, dataInventoryTableRows(s))}\n`;
  return md;
}

// ---------------------------------------------------------------------------------------------------------------- completeness

/** What the completeness check needs of the register and the data inventory (the boundary tools, out-of-scope ones included: they are exempt, not absent). */
export interface SspInventoryCompletenessInput {
  /** False for a browser-only organization or while nothing is loaded: sections 1.3 and 1.4 are then "not available" and count for nothing. */
  supported: boolean;
  tools: { id: string; name: string; assetCategory: CmmcAssetCategory | null; endUsers: number | null; privilegedUsers: number | null }[];
  handlesFci: boolean | null;
  categories: { id: string; name: string | null; toolCount: number }[];
}

/** The completeness input of the same sources the snapshot is built from. */
export function buildSspInventoryCompletenessInput(a: InventorySources): SspInventoryCompletenessInput {
  if (!a.supported) return { supported: false, tools: [], handlesFci: null, categories: [] };
  const regName = new Map((a.registry?.categories ?? []).map((c) => [c.id, c.name]));
  const known = new Set(a.tools.map((t) => t.id));
  return {
    supported: true,
    tools: boundaryOf(a).map((t) => ({ id: t.id, name: t.name, assetCategory: t.assetCategory, endUsers: t.endUsers, privilegedUsers: t.privilegedUsers })),
    handlesFci: a.data?.handlesFci ?? null,
    categories: (a.data?.categories ?? []).map((c) => ({ id: c.categoryId, name: regName.get(c.categoryId) ?? null, toolCount: c.tools.filter((r) => known.has(r.toolId) && (r.stores || r.processes || r.transmits)).length })),
  };
}

type InventoryClass = 'cmmc2' | 'cmmc1' | 'nist' | 'light';

function inventoryClassOf(framework: string): InventoryClass {
  if (framework === 'CMMC_L2') return 'cmmc2';
  if (framework === 'CMMC_L1') return 'cmmc1';
  if (framework === 'NIST_800_53_REV5' || framework === 'nist-800-53-r5') return 'nist';
  return 'light';
}

/**
 * The items of sections 1.3 and 1.4 (the same shape as the other completeness items; none has a `reportField`, so a gap reaches the export list with its
 * section). Required items: a tool in the boundary and an asset category on each tool (CMMC and NIST SP 800-53; the category advisory outside CMMC), the
 * FCI answer (CMMC), and for CMMC Level 2 at least one CUI category with a tool that stores, processes or transmits each. User counts are always advisory.
 * Nothing for an unsupported input.
 */
export function inventoryCompletenessItems(framework: string, inv: SspInventoryCompletenessInput): SspItemStatus[] {
  if (!inv.supported) return [];
  const cls = inventoryClassOf(framework);
  const items: SspItemStatus[] = [];
  const sev = (required: boolean) => (required ? 'required' : 'advisory') as SspItemStatus['severity'];

  // 1.3 system details
  const inScope = inv.tools.filter((t) => t.assetCategory !== 'OUT_OF_SCOPE');
  items.push({ id: 'inventory:tools', sectionId: 'system_details', label: 'At least one tool or service in the system boundary', severity: sev(cls !== 'light'), missing: inScope.length === 0 });
  for (const t of inv.tools) {
    items.push({ id: `tool:${t.id}:category`, sectionId: 'system_details', label: `${t.name}: CMMC asset category`, severity: sev(cls === 'cmmc2' || cls === 'cmmc1'), missing: t.assetCategory === null });
  }
  for (const t of inScope) {
    items.push({ id: `tool:${t.id}:users`, sectionId: 'system_details', label: `${t.name}: end user and privileged user counts`, severity: 'advisory', missing: t.endUsers === null || t.privilegedUsers === null });
  }

  // 1.4 information types
  if (cls !== 'light') {
    items.push({ id: 'inventory:fci', sectionId: 'data_inventory', label: 'Federal Contract Information (FCI) answered', severity: sev(cls === 'cmmc2' || cls === 'cmmc1'), missing: inv.handlesFci === null });
  }
  if (cls === 'cmmc1' && inv.handlesFci === false) {
    items.push({ id: 'inventory:l1_fci_no', sectionId: 'data_inventory', label: 'CMMC Level 1 applies to systems that handle FCI, and FCI is answered No', severity: 'advisory', missing: true });
  }
  if (cls === 'cmmc2' || cls === 'nist') {
    items.push({ id: 'inventory:cui', sectionId: 'data_inventory', label: 'At least one CUI category selected', severity: sev(cls === 'cmmc2'), missing: inv.categories.length === 0 });
  }
  if (cls === 'cmmc1' && inv.categories.length > 0) {
    items.push({ id: 'inventory:l1_cui_selected', sectionId: 'data_inventory', label: 'CUI is selected, so CMMC Level 2 applies to this system, not Level 1', severity: 'advisory', missing: true });
  }
  if (cls === 'cmmc2' || cls === 'nist') {
    for (const c of inv.categories) {
      items.push({ id: `cui:${c.id}:systems`, sectionId: 'data_inventory', label: `${c.name ?? c.id}: a tool that stores, processes or transmits it`, severity: sev(cls === 'cmmc2'), missing: c.toolCount === 0 });
    }
  }
  return items;
}
