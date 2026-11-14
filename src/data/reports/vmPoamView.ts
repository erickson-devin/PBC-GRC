import type { VmAffectedPackage, VmPoamResponse, VmPoamRow, VmPoamStatus, VmSeverity } from '../../types/vm';
import type { POAMEntry } from '../../types/report';
import { NOT_RECORDED } from './documentDefaults';
import { cmmcDisplayId, cmmcGuideId } from '../cmmcGuide/displayId';
import { poamQueryTerms } from './poamView';

/**
 * #274: the POA&M screen's vulnerability side as pure functions: the open items as POA&M entries for the exports, asset groups, search,
 * the rules and notice texts, and the tab and header wording. Nothing here reads storage or logs; asset and package names are only ever
 * returned as text for the caller to render or escape. It must not import documentCompilers (that module imports this one).
 */

export const VM_POAM_FETCH_LIMIT = 1000;
export const VM_POAM_UPCOMING_LIMIT = 100;
/** The "Coming due" list starts collapsed. */
export const VM_UPCOMING_DEFAULT_OPEN = false;
export const VM_POAM_CONTROL_TITLE = 'Vulnerability Remediation Timelines';
const VM_POAM_ORPHAN_KEY = '__no_asset__';

export type VmPoamLoad =
  | { status: 'unsupported' } | { status: 'idle' } | { status: 'loading' }
  | { status: 'no_program' } | { status: 'error' } | { status: 'ready'; data: VmPoamResponse };
export type VmPoamExport = { status: 'ready'; entries: POAMEntry[]; openItemsTotal: number } | { status: 'unavailable' };

export const VM_POAM_COPY = {
  heading: 'Vulnerabilities',
  loading: 'Loading the vulnerability POA&M items…',
  loadError: 'The vulnerability POA&M items could not be loaded. The control entries above are complete; vulnerability items are not shown and are not in the exports.',
  retry: 'Retry',
  noProgram: 'No program is selected, so vulnerability POA&M items cannot be shown.',
  browserOnly: 'Vulnerability POA&M items come from the scanner integration, which needs an organization stored on the server. This organization is stored only in this browser.',
  searchLabel: 'Search vulnerability items',
  searchPlaceholder: 'Search by CVE, asset, package or owner',
  noMatch: 'No vulnerability items match the search.',
  orphanAsset: 'Asset no longer recorded',
  findingRemoved: 'Finding removed with its asset',
  kevTitle: 'Known exploited vulnerability',
  itemsCaption: (asset: string) => `${asset}: vulnerability POA&M items`,
  upcomingToggle: (n: number) => `Coming due: ${n} open ${n === 1 ? 'vulnerability' : 'vulnerabilities'} not yet past ${n === 1 ? 'its' : 'their'} deadline`,
  upcomingNote: 'These are not POA&M items yet and are not in the exports.',
  upcomingCaption: 'Open vulnerabilities not yet past their deadline, soonest first',
  upcomingCap: (shown: number, total: number) => `Showing the first ${shown} of ${total}.`,
  docTitle: '2b. Vulnerability Remediation Items',
  docSummary: 'Each row is one vulnerability that was still open after its remediation deadline. These rows are separate from the control entries in section 2.',
  docNone: 'No vulnerability POA&M items are open for this program.',
  docUnavailable: 'The vulnerability POA&M items could not be loaded when this document was generated, so none are listed. Generate the document again to include them.',
  docCap: (shown: number, total: number) => `This document lists the first ${shown} of ${total} open items.`,
  summaryLabel: 'Open Vulnerability POA&M Items',
  exportFields: 'The document and CSV print each open item\'s owner as the Responsible Role, its target date as the Scheduled Completion Date and its plan as the Remediation Plan. An empty owner or date prints as Not recorded; an empty plan prints the standard remediation sentence.',
  closedLoading: 'Loading the completed and risk-accepted items…',
  refreshFailed: 'The vulnerability items could not be refreshed. The list below may be out of date.',
  openPrograms: 'Open Programs & Boundaries',
  notInExports: 'Not in exports',
  readOnlyNote: 'Only a Tenant Owner or MSP Admin can edit POA&M items.',
};

const SEVERITY_RANK: Record<VmSeverity, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, UNKNOWN: 2, LOW: 1 };

/** Exports carry open items only: completed and risk-accepted items are history. */
export function isOpenVmPoamStatus(s: VmPoamStatus): boolean {
  return s === 'OPEN' || s === 'IN_PROGRESS';
}

/** Weakness ids over the open rows in input order, so the screen and the exports name an item the same way. */
export function vmWeaknessIds(rows: readonly VmPoamRow[]): Map<string, string> {
  const ids = new Map<string, string>();
  let i = 0;
  for (const r of rows) {
    if (!isOpenVmPoamStatus(r.status)) continue;
    i++;
    ids.set(r.id, `POAM-VM-${String(i).padStart(3, '0')}`);
  }
  return ids;
}

export function vmPoamControlTitle(framework: string): string {
  return framework === 'CMMC_L1'
    ? `Vulnerability remediation (no Level 1 practice; related: ${cmmcGuideId('SI.L2-3.14.1', 'CMMC_L1')})`
    : VM_POAM_CONTROL_TITLE;
}

/** Open vulnerability items as POA&M entries. The target date is the recorded one only, never the remediation deadline. */
export function vmPoamEntries(rows: readonly VmPoamRow[], framework: string): POAMEntry[] {
  const ids = vmWeaknessIds(rows);
  const title = vmPoamControlTitle(framework);
  const entries: POAMEntry[] = [];
  for (const row of rows) {
    const weaknessId = ids.get(row.id);
    if (weaknessId === undefined) continue;
    entries.push({
      weaknessId,
      controlId: row.controlId,
      controlDisplayId: cmmcDisplayId(row.controlId, framework),
      controlTitle: title,
      weaknessDescription: row.weakness,
      scheduledCompletionDate: row.scheduledCompletion ?? NOT_RECORDED,
      requiredResources: NOT_RECORDED,
      responsibleRole: row.owner.trim() || NOT_RECORDED,
      remediationPlan: row.mitigation.trim() || 'Remediate or mitigate the vulnerability, then confirm that a later scan no longer reports it.',
      status: row.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OPEN',
      milestones: [],
    });
  }
  return entries;
}

/** What the exports get for a load state: undefined leaves the document exactly as it was before vulnerability items existed. */
export function vmPoamExportFor(load: VmPoamLoad, framework: string): VmPoamExport | undefined {
  switch (load.status) {
    case 'unsupported':
    case 'idle':
      return undefined;
    case 'ready':
      return { status: 'ready', entries: vmPoamEntries(load.data.items, framework), openItemsTotal: load.data.openItemsTotal };
    default:
      return { status: 'unavailable' };
  }
}

export interface VmPoamAssetGroup {
  key: string;
  assetName: string;
  items: VmPoamRow[];
  worstSeverity: VmSeverity | null;
  kevCount: number;
  /** How many of the items are open or in progress. */
  openCount: number;
}

/**
 * Items per asset, a group with open items before one with only closed items, then the most severe asset first; items keep the server's
 * order inside a group. Severity and KEV count come from the open items, or from all of them when none is open.
 */
export function groupVmPoamByAsset(rows: readonly VmPoamRow[]): VmPoamAssetGroup[] {
  const groups = new Map<string, VmPoamAssetGroup>();
  for (const row of rows) {
    const asset = row.finding?.asset ?? null;
    const key = asset ? asset.id : VM_POAM_ORPHAN_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, assetName: asset ? asset.name : VM_POAM_COPY.orphanAsset, items: [], worstSeverity: null, kevCount: 0, openCount: 0 };
      groups.set(key, g);
    }
    g.items.push(row);
    if (isOpenVmPoamStatus(row.status)) g.openCount++;
  }
  for (const g of groups.values()) {
    const counted = g.openCount > 0 ? g.items.filter((r) => isOpenVmPoamStatus(r.status)) : g.items;
    for (const row of counted) {
      if (!row.finding) continue;
      const s = row.finding.severity;
      if (g.worstSeverity === null || SEVERITY_RANK[s] > SEVERITY_RANK[g.worstSeverity]) g.worstSeverity = s;
      if (row.finding.kev) g.kevCount++;
    }
  }
  const rank = (g: VmPoamAssetGroup): number => (g.worstSeverity && g.key !== VM_POAM_ORPHAN_KEY ? SEVERITY_RANK[g.worstSeverity] : 0);
  return [...groups.values()].sort((a, b) =>
    (b.openCount > 0 ? 1 : 0) - (a.openCount > 0 ? 1 : 0) || rank(b) - rank(a) || b.items.length - a.items.length || a.assetName.localeCompare(b.assetName) || a.key.localeCompare(b.key));
}

/** The count text of an asset group: the plain item count while every item is open, else the open and closed counts. */
export function vmGroupCountText(g: Pick<VmPoamAssetGroup, 'items' | 'openCount'>): string {
  const n = g.items.length;
  const closed = n - g.openCount;
  if (closed === 0) return `${n} ${n === 1 ? 'item' : 'items'}`;
  return g.openCount === 0 ? `${closed} closed` : `${g.openCount} open, ${closed} closed`;
}

/** Search over the CVE id, asset name, every package name and the weakness text; all terms must match. In memory only. */
export function filterVmPoamRows(rows: readonly VmPoamRow[], query: string): VmPoamRow[] {
  const terms = poamQueryTerms(query);
  if (terms.length === 0) return [...rows];
  return rows.filter((r) => {
    const hay = [
      r.finding?.vulnId ?? '',
      r.finding?.asset?.name ?? '',
      ...(r.finding?.affectedPackages.map((p) => p.name) ?? []),
      r.weakness,
      r.owner ?? '',
    ].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function vmPackagesView(
  f: { affectedPackages: readonly VmAffectedPackage[]; affectedPackageCount: number },
  max: number = 3
): { shown: VmAffectedPackage[]; more: number } {
  const shown = f.affectedPackages.slice(0, max);
  return { shown, more: Math.max(0, f.affectedPackageCount - shown.length) };
}

export function daysRemainingText(n: number): string {
  if (n < 0) return 'Past deadline';
  if (n === 0) return 'Due within a day';
  return n === 1 ? '1 day left' : `${n} days left`;
}

/** A calendar date without the locale; null reads as None. */
export function isoDate(s: string | null): string {
  return s ? s.slice(0, 10) : 'None';
}

export function vmRulesText(rules: VmPoamResponse['rules'], framework: string): string {
  const id = cmmcDisplayId(rules.controlId, framework);
  const d = (n: number): string => (n === 1 ? '1 day' : `${n} days`);
  const s = rules.slaDays;
  return `A vulnerability becomes a POA&M item under ${id} when it is still open after its remediation deadline. The deadline counts from when the vulnerability was first seen: Critical ${d(s.CRITICAL)}, High ${d(s.HIGH)}, Medium ${d(s.MEDIUM)}, Low ${d(s.LOW)}. Unknown severity uses the Medium deadline, and a known exploited vulnerability (KEV) never gets longer than the Critical deadline. Items are added when the next scan is processed after the deadline. An item is completed automatically when a later scan confirms the fix: the scanner that reported the vulnerability scans the host again and no longer lists it, and no other active scanner still reports it. A host that is not scanned completes nothing. If the vulnerability comes back it gets a new item; the completed one stays in the history. An item a person reopened is not completed automatically. This also applies to items in a program that was the target earlier, unless it is archived.`;
}

export interface VmPoamNotice {
  id: string;
  tone: 'amber' | 'slate';
  text: string;
  /** A link the screen offers next to the text. */
  action?: 'open_programs';
}

/** How many items are closed (completed or risk accepted): the server's total less the open ones, known before the closed rows are loaded. */
export function vmClosedCount(data: VmPoamResponse): number {
  return Math.max(0, data.itemsTotal - data.openItemsTotal);
}

export function vmPoamNotices(data: VmPoamResponse, ctx: { framework: string; targetProgramName: string | null; includeClosed?: boolean }): VmPoamNotice[] {
  const { rules } = data;
  const out: VmPoamNotice[] = [];
  const hasItems = data.items.length > 0;
  if (rules.vmTargetProgramId === null) {
    out.push({ id: 'no_target', tone: 'amber', action: 'open_programs', text: 'No program receives vulnerability POA&M items, so none are created. That needs a CMMC program as the organization default or as the vulnerability target.' });
  } else if (!rules.isVmTarget) {
    out.push({
      id: 'not_target',
      tone: 'slate',
      action: 'open_programs',
      text: `This program is not the vulnerability target, so new items are created in ${ctx.targetProgramName ?? 'another program'}, not here.${hasItems ? ' The items below were created while this program was the target.' : ''}`,
    });
  }
  if (!rules.autocreateEnabled) {
    out.push({ id: 'autocreate_off', tone: 'amber', text: 'Automatic POA&M items are turned off on this server (VM_POAM_AUTOCREATE), so overdue vulnerabilities are not added.' });
  }
  const n = data.overdueWithoutItemCount;
  if (rules.isVmTarget && n > 0) {
    const base = `${n} open ${n === 1 ? 'vulnerability is' : 'vulnerabilities are'} past ${n === 1 ? 'its' : 'their'} deadline without a POA&M item`;
    out.push({ id: 'overdue_without_item', tone: 'amber', text: rules.autocreateEnabled ? `${base} yet. Items are added when the next scan is processed.` : `${base}.` });
  }
  if (ctx.framework === 'CMMC_L1' && (hasItems || rules.isVmTarget)) {
    out.push({
      id: 'level1',
      tone: 'slate',
      text: `Level 1 has no vulnerability remediation practice. These items keep the Level 2 id RA.L2-3.11.3; the closest Level 1 practice is ${cmmcGuideId('SI.L2-3.14.1', 'CMMC_L1')}.`,
    });
  }
  // The cap compares with the open rows shown: completed rows loaded next to them must not hide a truncated open list
  const openShown = data.items.filter((r) => isOpenVmPoamStatus(r.status)).length;
  if (data.openItemsTotal > openShown) {
    out.push({ id: 'cap', tone: 'slate', text: `Showing the first ${openShown} of ${data.openItemsTotal} open items. The exports list the same ${openShown}.` });
  }
  const closedTotal = vmClosedCount(data);
  const closedShown = data.items.length - openShown;
  if (ctx.includeClosed && closedShown < closedTotal) {
    out.push({ id: 'closed_cap', tone: 'slate', text: `Showing the first ${closedShown} of ${closedTotal} completed or risk-accepted items.` });
  }
  return out;
}

export function vmClosedToggleText(n: number): string {
  return `Show completed and risk-accepted items (${n})`;
}

/** Shown while no open item is listed; says so, and where the closed items are. */
export function vmItemsEmptyText(data: VmPoamResponse, opts: { includeClosed?: boolean } = {}): string {
  const base = data.rules.isVmTarget && data.rules.autocreateEnabled && data.overdueWithoutItemCount === 0
    ? 'No vulnerability POA&M items are open, and no open vulnerability is past its deadline.'
    : 'No vulnerability POA&M items are open in this program.';
  const n = vmClosedCount(data);
  if (n === 0) return base;
  if (opts.includeClosed) return `${base} ${n === 1 ? 'The completed or risk-accepted item is' : `The ${n} completed or risk-accepted items are`} listed below.`;
  return `${base} ${n} completed or risk-accepted ${n === 1 ? 'item is' : 'items are'} hidden.`;
}

/** The row after a save, in the loaded response: replaced in place, or removed when it is now closed and closed items are hidden. Same reference when the id is not loaded. */
export function applyVmPoamRowUpdate(data: VmPoamResponse, row: VmPoamRow, includeClosed: boolean): VmPoamResponse {
  const index = data.items.findIndex((r) => r.id === row.id);
  if (index < 0) return data;
  const wasOpen = isOpenVmPoamStatus(data.items[index].status);
  const nowOpen = isOpenVmPoamStatus(row.status);
  const items = !nowOpen && !includeClosed ? data.items.filter((r) => r.id !== row.id) : data.items.map((r) => (r.id === row.id ? row : r));
  return { ...data, items, openItemsTotal: data.openItemsTotal + (nowOpen ? 1 : 0) - (wasOpen ? 1 : 0) };
}

/** An open item whose recorded target date has passed (calendar dates, no clock: `generatedAt` is the response's own). */
export function vmPastTargetDate(row: Pick<VmPoamRow, 'status' | 'scheduledCompletion'>, generatedAt: string): boolean {
  return isOpenVmPoamStatus(row.status) && row.scheduledCompletion !== null && row.scheduledCompletion < generatedAt.slice(0, 10);
}

export function vmResultsText(shown: number, total: number): string {
  if (shown === total) return total === 1 ? 'Showing 1 vulnerability item.' : `Showing all ${total} vulnerability items.`;
  return `Showing ${shown} of ${total} vulnerability items.`;
}

const entriesText = (n: number): string => `${n} control ${n === 1 ? 'entry' : 'entries'}`;
const itemsText = (n: number): string => `${n} open vulnerability ${n === 1 ? 'item' : 'items'}`;

/** The tab count is what the exports hold: control entries plus the open vulnerability items once loaded. */
export function poamTabLabel(controls: number, load: VmPoamLoad): string {
  return `POA&M Table (${controls + (load.status === 'ready' ? load.data.openItemsTotal : 0)})`;
}

export function poamTabAriaLabel(controls: number, load: VmPoamLoad): string {
  if (load.status === 'ready') return `POA&M Table: ${entriesText(controls)}, ${itemsText(load.data.openItemsTotal)}`;
  if (load.status === 'unsupported') return `POA&M Table: ${entriesText(controls)}`;
  return `POA&M Table: ${entriesText(controls)}, vulnerability items not loaded`;
}

export function poamHeaderText(controls: number, load: VmPoamLoad): string {
  switch (load.status) {
    case 'unsupported': return `${entriesText(controls)}.`;
    case 'ready': return `${entriesText(controls)} and ${itemsText(load.data.openItemsTotal)}.`;
    case 'loading':
    case 'idle': return `${entriesText(controls)}. Vulnerability items are loading.`;
    default: return `${entriesText(controls)}. Vulnerability items are not loaded.`;
  }
}

export function poamExportNote(load: VmPoamLoad): string {
  return load.status === 'ready' || load.status === 'unsupported'
    ? 'The document and CSV list every entry, whatever the filters on this screen show.'
    : 'The document and CSV list every control entry, whatever the filters on this screen show. Vulnerability items are not loaded, so they are not in the exports right now.';
}

export function poamEmptyState(
  controlCount: number,
  load: VmPoamLoad
): { tone: 'clear' | 'partial'; title: string; body: string } | null {
  if (controlCount > 0) return null;
  if (load.status === 'ready') {
    const open = load.data.openItemsTotal;
    const overdue = load.data.overdueWithoutItemCount;
    if (open === 0 && overdue === 0) {
      return { tone: 'clear', title: 'No open POA&M entries', body: 'Every control in this program is recorded as Met, and no vulnerability POA&M items are open.' };
    }
    if (open > 0) {
      return { tone: 'partial', title: 'No control entries', body: 'Every control in this program is recorded as Met. Open vulnerability items are listed under Vulnerabilities.' };
    }
    return { tone: 'partial', title: 'No control entries', body: 'Every control in this program is recorded as Met. Some open vulnerabilities are past their deadline without a POA&M item; see Vulnerabilities.' };
  }
  if (load.status === 'unsupported') {
    return { tone: 'clear', title: 'No open POA&M entries', body: 'Every control in this program is recorded as Met. Vulnerability items are not tracked for an organization stored only in this browser.' };
  }
  return { tone: 'partial', title: 'No control entries', body: 'Every control in this program is recorded as Met. Vulnerability items are not loaded, so this is not the full POA&M.' };
}
