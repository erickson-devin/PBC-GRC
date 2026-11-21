// What SSP sections 1.3 (System Details) and 1.4 (Information Types) say and decide on screen (#239, #243): every label, status line and edit of the
// data inventory that a component shows lives here so a test can pin it. Pure: types, the shared labels and the CUI Registry helpers only. Nothing
// here prints a tool name, a category choice or a note in an error text (they can be CUI) and nothing touches storage or the network, and nothing is logged.

import type { DataInventorySaveError } from '../../hooks/useDataInventory';
import type { CuiToolRole, DataInventoryRecord } from '../../types/inventory';
import { CATEGORY_INFO } from '../telemetry/assetScope';
import { NOT_RECORDED } from '../reports/documentDefaults';
import { groupCategories, type CuiCategory, type CuiRegistry } from '../cui/cuiRegistry';
import { DEPLOYMENT_LABELS } from '../inventory/inventoryUiView';
import {
  CMMC_L2_NEEDS_CUI_CATEGORY,
  R3_NEEDS_CUI_CATEGORY,
  INVENTORY_NOT_AVAILABLE,
  NO_TOOLS_RECORDED,
  type SspInventorySnapshot,
} from '../inventory/sspInventory';

export const SSP_INVENTORY_TEXT = {
  unsupported: INVENTORY_NOT_AVAILABLE,
  noProgram: 'Open a program to record its data inventory.',
  detailsIntro: "Built from the Tools and Services register: the tools in this program's boundary with their end-user and privileged-user counts (SSP 1.3.1). Out-of-scope tools are left out. Edit them in the register.",
  detailsEmpty: "No tools in this program's boundary yet. Add them in Tools & Services.",
  detailsLoading: 'Loading the tools…',
  detailsFailed: 'The tools could not be loaded.',
  dataIntro: 'What information this system handles: Federal Contract Information (FCI) and the CUI categories from the NARA CUI Registry, with the tools that store, process or transmit each (SSP 1.4).',
  fciQuestion: 'Does this system process, store or transmit Federal Contract Information (FCI)?',
  l1FciNo: 'A CMMC Level 1 program exists to protect FCI: check this answer.',
  l2Required: CMMC_L2_NEEDS_CUI_CATEGORY,
  r3Required: R3_NEEDS_CUI_CATEGORY,
  l1CuiSelected: 'CUI is selected, so CMMC Level 2 applies to this system, not Level 1.',
  cuiOptional: 'Optional for this framework.',
  noTools: 'No tool assigned yet: tick where this information is stored, processed or transmitted.',
  noBoundaryTools: "This program's boundary has no tools yet. Add them in Tools & Services.",
  hasAssignments: 'Has tool assignments: remove it from its card below.',
  notInRegistry: 'Not in this version of the registry list',
  registryLoading: 'Loading the CUI category list…',
  registryFailed: 'The CUI category list could not be loaded. Selected categories are shown by their abbreviation.',
  unverified: 'Not yet checked against the live registry',
  specifiedHint: 'Specified categories carry extra handling rules set by law or policy: check the registry entry.',
  noMatch: 'No categories match.',
  outsideBoundary: 'A tool no longer in this boundary',
  stale: 'Someone else changed the data inventory on the server, so your last change was not saved. Reload to see the current version, then make your change again.',
  readOnly: 'Read-only: you can see the data inventory, but only a Tenant Owner or Admin can change it.',
  archivedReadOnly: 'This program is archived, so its data inventory is read-only.',
} as const;

/** The marker a category carries; none for a category the registry lists no banner for. */
export const DESIGNATION_LABELS = { BASIC: 'Basic', SPECIFIED: 'Specified', BOTH: 'Basic and Specified' } as const;

export type DesignationTone = 'slate' | 'amber' | 'violet';

export function designationView(d: string | null | undefined): { label: string; tone: DesignationTone } | null {
  if (d === 'BASIC') return { label: DESIGNATION_LABELS.BASIC, tone: 'slate' };
  if (d === 'SPECIFIED') return { label: DESIGNATION_LABELS.SPECIFIED, tone: 'amber' };
  if (d === 'BOTH') return { label: DESIGNATION_LABELS.BOTH, tone: 'violet' };
  return null;
}

export function registryNote(meta: CuiRegistry['_meta']): string {
  return `List from the NARA CUI Registry as of ${meta.asOf}.`;
}

// ---------------------------------------------------------------- the data inventory record

export function fciValue(b: boolean | null): 'yes' | 'no' | 'unset' {
  return b === true ? 'yes' : b === false ? 'no' : 'unset';
}

export function setFci(r: DataInventoryRecord, v: 'yes' | 'no' | 'unset'): DataInventoryRecord {
  return { ...r, handlesFci: v === 'yes' ? true : v === 'no' ? false : null };
}

const rowsOf = (r: DataInventoryRecord, id: string): CuiToolRole[] => r.categories.find((c) => c.categoryId === id)?.tools ?? [];

/** The number of tools assigned to a selected category (a row exists only while at least one role is ticked). */
export function assignmentCount(r: DataInventoryRecord, id: string): number {
  return rowsOf(r, id).length;
}

/** A category with tool assignments cannot be unticked in the picker: it is removed from its card, with a confirmation. */
export function canUntick(r: DataInventoryRecord, id: string): boolean {
  return assignmentCount(r, id) === 0;
}

/** On adds the category with no tools; off removes it only when it has no tools (otherwise the record is returned unchanged). */
export function toggleCategory(r: DataInventoryRecord, id: string, on: boolean): DataInventoryRecord {
  const has = r.categories.some((c) => c.categoryId === id);
  if (on) return has ? r : { ...r, categories: [...r.categories, { categoryId: id, tools: [] }] };
  if (!has || !canUntick(r, id)) return r;
  return removeCategory(r, id);
}

export function removeCategory(r: DataInventoryRecord, id: string): DataInventoryRecord {
  return { ...r, categories: r.categories.filter((c) => c.categoryId !== id) };
}

export type CuiRole = 'stores' | 'processes' | 'transmits';

export function roleValue(r: DataInventoryRecord, catId: string, toolId: string, role: CuiRole): boolean {
  return rowsOf(r, catId).find((t) => t.toolId === toolId)?.[role] === true;
}

/** Sets one of the three roles of a tool in a category. A row with all three false is dropped (the server keeps no such row). A category that is not selected is left alone. */
export function setToolRole(r: DataInventoryRecord, catId: string, toolId: string, role: CuiRole, v: boolean): DataInventoryRecord {
  if (!r.categories.some((c) => c.categoryId === catId)) return r;
  return {
    ...r,
    categories: r.categories.map((c) => {
      if (c.categoryId !== catId) return c;
      const existing = c.tools.find((t) => t.toolId === toolId);
      const next: CuiToolRole = { toolId, stores: false, processes: false, transmits: false, ...existing, [role]: v };
      const keep = next.stores || next.processes || next.transmits;
      if (!existing) return keep ? { ...c, tools: [...c.tools, next] } : c;
      return { ...c, tools: keep ? c.tools.map((t) => (t.toolId === toolId ? next : t)) : c.tools.filter((t) => t.toolId !== toolId) };
    }),
  };
}

/** The rows of a category's tool matrix: every boundary tool, then any assigned tool that has left the boundary (named by a fixed text, never a name). */
export function matrixRows(r: DataInventoryRecord, catId: string, boundaryTools: { id: string; name: string }[]): { id: string; name: string; outside: boolean }[] {
  const inBoundary = new Set(boundaryTools.map((t) => t.id));
  const outside = rowsOf(r, catId)
    .filter((t) => !inBoundary.has(t.toolId))
    .map((t) => ({ id: t.toolId, name: SSP_INVENTORY_TEXT.outsideBoundary, outside: true }));
  return [...boundaryTools.map((t) => ({ id: t.id, name: t.name, outside: false })), ...outside];
}

// ---------------------------------------------------------------- the registry list

export function filterRegistry(reg: CuiRegistry, q: string): { group: { id: string; name: string }; categories: CuiCategory[] }[] {
  const needle = q.trim().toLowerCase();
  return groupCategories(reg)
    .map(({ group, categories }) => ({
      group: { id: group.id, name: group.name },
      categories: needle === ''
        ? categories
        : categories.filter((c) =>
            [c.name, c.id, c.marking, c.specifiedBanner, c.basicBanner, group.name].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))
          ),
    }))
    .filter((g) => g.categories.length > 0);
}

/** The group name and the category from the registry, for a selected id; null where the registry does not list the id. */
export function registryEntry(reg: CuiRegistry | null, id: string): { category: CuiCategory; groupName: string | null } | null {
  const category = reg?.categories.find((c) => c.id === id);
  if (!reg || !category) return null;
  return { category, groupName: reg.indexGroups.find((g) => g.id === category.indexGroup)?.name ?? null };
}

/** The banner marking(s) the registry lists, else the marking abbreviation; null when none. */
export function bannerText(c: CuiCategory): string | null {
  const banners = [c.basicBanner, c.specifiedBanner].filter((b): b is string => typeof b === 'string' && b !== '');
  return banners.length > 0 ? banners.join(' / ') : c.marking;
}

// ---------------------------------------------------------------- requirement lines and texts

export function cuiRequirementLine(framework: string, count: number): { tone: 'rose' | 'amber' | 'slate'; text: string } | null {
  if (framework === 'CMMC_L2') return count === 0 ? { tone: 'rose', text: SSP_INVENTORY_TEXT.l2Required } : null;
  if (framework === 'NIST_800_171_R3') return count === 0 ? { tone: 'rose', text: SSP_INVENTORY_TEXT.r3Required } : null;
  if (framework === 'CMMC_L1') return count > 0 ? { tone: 'amber', text: SSP_INVENTORY_TEXT.l1CuiSelected } : null;
  return { tone: 'slate', text: SSP_INVENTORY_TEXT.cuiOptional };
}

export function fciHint(framework: string, handlesFci: boolean | null): string | null {
  return framework === 'CMMC_L1' && handlesFci === false ? SSP_INVENTORY_TEXT.l1FciNo : null;
}

/** The category id (a registry abbreviation) only: never a name from the register. */
export function removeCategoryConfirmText(categoryId: string, toolRows: number): string {
  return `Remove ${categoryId} from this SSP? Its ${toolRows} tool ${toolRows === 1 ? 'assignment is' : 'assignments are'} removed too.`;
}

export function dataInventorySaveErrorText(e: DataInventorySaveError): string {
  switch (e) {
    case 'archived':
      return 'This program is archived, so it is read-only. Nothing was saved.';
    case 'invalid':
      return 'A value was refused by the server and was not saved.';
    case 'forbidden':
      return 'Only a Tenant Owner or Admin can change the SSP. Nothing was saved.';
    case 'not_in_boundary':
      return "A tool is no longer in this program's boundary, so the change was not saved. Reload to see the current version.";
    case 'unknown_category':
      return 'A CUI category is not in the shipped registry list, so the change was not saved.';
    default:
      return 'The last change to the data inventory was not saved. Try again.';
  }
}

export function inventoryNavText(status: 'unsupported' | 'loading' | 'ready' | 'error'): string | null {
  switch (status) {
    case 'unsupported':
      return 'Not available';
    case 'loading':
      return 'Loading…';
    case 'error':
      return 'Could not load';
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 1.3 and 1.4 as the builder prints them

export interface SystemDetailsRowView {
  id: string;
  name: string;
  deployment: string;
  category: string;
  endUsers: string;
  privileged: string;
  missing: boolean;
}

/** The 1.3.1 rows: the same tools, order and wording as the compiled SSP (the snapshot already leaves out out-of-scope tools). */
export function systemDetailsRows(s: SspInventorySnapshot): SystemDetailsRowView[] {
  const count = (n: number | null): string => (n === null ? NOT_RECORDED : String(n));
  return s.tools.map((t) => ({
    id: t.id,
    name: t.name,
    deployment: t.deployment ? DEPLOYMENT_LABELS[t.deployment] : NOT_RECORDED,
    category: t.assetCategory ? CATEGORY_INFO[t.assetCategory].label : NOT_RECORDED,
    endUsers: count(t.endUsers),
    privileged: count(t.privilegedUsers),
    missing: t.endUsers === null || t.privilegedUsers === null,
  }));
}

export function yesNoLabel(b: boolean | null): string {
  return b === true ? 'Yes' : b === false ? 'No' : NOT_RECORDED;
}

/** The plain-text copy lines of 1.3.1 (one per tool). Unavailable or empty: a single line saying so. */
export function systemDetailsCopyLines(s: SspInventorySnapshot): string[] {
  if (!s.supported) return [`- ${INVENTORY_NOT_AVAILABLE}`];
  if (s.tools.length === 0) return [`- ${NO_TOOLS_RECORDED}`];
  return systemDetailsRows(s).map((r) => `- ${r.name}: ${r.endUsers} end users, ${r.privileged} privileged`);
}

/** The plain-text copy line of 1.4: the FCI answer and the CUI category ids (ids only, as in the picker). */
export function informationTypesCopyLine(s: SspInventorySnapshot): string {
  if (!s.supported) return INVENTORY_NOT_AVAILABLE;
  return `FCI ${yesNoLabel(s.handlesFci)}; CUI: ${s.categories.length === 0 ? 'none' : s.categories.map((c) => c.id).join(', ')}`;
}
