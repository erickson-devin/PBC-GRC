// What the Tools and Services screens say and decide (#239, #247, #249): fixed copy, labels, sort and filter helpers, the tool form (parsing, validation,
// three-way merge after a stale write), the confirmation texts and the control-link helpers. Pure: types plus assetScope, toolRegisterView and
// costRollup; nothing here touches storage, the network, the clock or the log. Tool names, missions, notes and cost may be CUI: no text here
// ever echoes a server message or a value, and the confirmation texts never carry a tool name.

import type { CmmcAssetCategory } from '../../types/telemetry';
import type {
  FedrampStatus,
  InventoryTool,
  ToolDeployment,
  ToolInput,
  ToolOrigin,
  ToolType,
} from '../../types/inventory';
import { isCmmcAssetCategory } from '../telemetry/assetScope';
import { hasMissingUserCounts, sortForRegister, type ToolFilter } from './toolRegisterView';

export const INVENTORY_UI_TEXT = {
  panelTitle: 'Tools and Services',
  panelIntro: 'The tools and services your system uses: what each does, where it runs, its CMMC asset category, user counts and the controls it supports. Shared by every program in this organization; boundary membership and control links belong to each program.',
  unsupported: 'The Tools and Services register is kept on the server, so it needs a server-backed organization. This organization is stored only in this browser',
  unsupportedMoveHint: ': move it to the server from the notice above the asset inventory',
  readOnly: 'Read-only: only a Tenant Owner or Admin can change the Tools and Services register. Annual costs are shown to Tenant Owners and Admins only.',
  loading: 'Loading the Tools and Services register…',
  loadFailed: 'The Tools and Services register could not be loaded.',
  emptyEditor: 'No tools recorded yet. Add the tools and services your system uses, or pick them from the catalog with Quick add.',
  emptyReader: 'No tools recorded yet. A Tenant Owner or Admin can add them.',
  emptyFiltered: 'No tools match your search and filter.',
  noProgram: 'No program is open, so control links and boundary membership are not shown. The register itself is shared by every program.',
  programLoading: 'Loading the program boundary…',
  programFailed: "The program's boundary and control links could not be loaded. The register itself is unaffected.",
  undeclaredEditor: ' Tick "In this boundary" on the tools it covers.',
  undeclaredReader: ' A Tenant Owner or Admin can declare them.',
  limitReached: 'The register holds at most 1,000 tools. Remove tools you no longer need to add more.',
  surveyHint: 'Nothing is added until you review them.',
  surveyDialogIntro: 'These come from your technology survey answers. Nothing is added until you choose Add; check each tool afterwards and fill in its user counts.',
  quickAddIntro: 'Tick the tools you use. Type, deployment and CMMC asset category are filled in as suggestions you can change here or later.',
  quickAddLinkHint: 'A link says the tool helps meet that control. Leave this off to link controls yourself after checking them.',
  quickAddNeedsBoundary: 'Add the tools to the boundary to link their controls.',
  quickAddMax: 'You can add up to 200 tools at a time.',
  catalogLoading: 'Loading the tool catalog…',
  catalogFailed: 'The tool catalog could not be loaded.',
  fedrampHint: 'This app ships no authorization data: check the FedRAMP Marketplace yourself and record the date you checked.',
  usersHint: 'Printed in SSP 1.3.1. Privileged users are the people with administrative rights in this tool.',
  costHint: 'US dollars per year. Shown to Tenant Owners and Admins only.',
  staleTool: 'Someone else changed this tool while you were editing. Nothing was saved. Your entries are kept; fields only they changed now show their values. Check the highlighted fields, then save again.',
  conflictField: 'Changed by someone else too: check this value.',
  toolGone: 'This tool was removed meanwhile. Nothing was saved.',
  recoveryIntro: 'The order in which tools are restored after an outage, first to last. One order for the whole organization.',
  recoveryReadOnly: 'Read-only: only a Tenant Owner or Admin can change the recovery order.',
  recoveryEmpty: 'No tool is in the recovery order yet.',
  staleOrder: 'The recovery order changed elsewhere; the current order is loaded. Check it and move the tool again.',
  linksIntro: 'Links belong to this program only; other programs keep their own.',
  linksStale: 'The links for this tool changed elsewhere. Nothing was saved. The current links are loaded with your additions and removals kept on top; check them and save again.',
  linksNotInBoundary: "This tool is not in this program's boundary. Add it to the boundary before linking controls.",
  linksReadOnly: 'Read-only: only a Tenant Owner or Admin can change control links.',
  evidenceIntro: "For each control a tool is linked to in this program: the control's status and how many evidence files it has.",
  evidenceNoProgram: 'Open a program to see evidence status: control links belong to a program.',
  evidenceEmpty: "No tool is linked to a control in this program yet. Use a tool's Controls cell to link them.",
  costsIntro: 'Annual cost and renewals from the register. Programs that have not declared their tools count the whole register.',
  membershipsFailed: 'The per-program totals could not be loaded.',
} as const;

export const DEPLOYMENT_LABELS: Record<ToolDeployment, string> = {
  ON_PREM: 'On-premises',
  CLOUD: 'Cloud',
  ESP: 'External service provider',
};

export const FILTER_LABELS: Record<ToolFilter, string> = {
  ALL: 'All',
  ON_PREM: 'On-premises',
  CLOUD: 'Cloud',
  ESP: 'Service providers',
};

export const FEDRAMP_LABELS: Record<FedrampStatus, string> = {
  UNKNOWN: 'Not checked',
  NOT_APPLICABLE: 'Not applicable',
  NOT_AUTHORIZED: 'Not authorized',
  IN_PROCESS: 'In process',
  LI_SAAS: 'Li-SaaS',
  LOW: 'Low',
  MODERATE: 'Moderate',
  HIGH: 'High',
  MODERATE_EQUIVALENT: 'Moderate equivalent',
};

export const ORIGIN_LABELS: Record<ToolOrigin, string> = {
  MANUAL: 'Added by hand',
  SURVEY: 'From survey',
  CATALOG: 'From catalog',
};

export const TOOL_TYPE_LABELS: Record<ToolType, string> = {
  IDENTITY_SSO: 'Identity and single sign-on',
  MFA: 'Multi-factor authentication',
  DIRECTORY: 'Directory service',
  PAM: 'Privileged access management',
  EDR: 'Endpoint detection and response',
  ANTIVIRUS: 'Antivirus',
  SIEM: 'Security event monitoring (SIEM)',
  LOG_MANAGEMENT: 'Log management',
  VULNERABILITY_SCANNING: 'Vulnerability scanning',
  PATCH_RMM: 'Patching and remote management',
  MDM_UEM: 'Device management (MDM / UEM)',
  CONFIG_MANAGEMENT: 'Configuration management',
  EMAIL_COLLABORATION: 'Email and collaboration',
  EMAIL_SECURITY: 'Email security',
  FILE_SHARING: 'File sharing and storage',
  BACKUP_RECOVERY: 'Backup and recovery',
  FIREWALL_NETWORK: 'Firewall and network security',
  REMOTE_ACCESS_VPN: 'Remote access and VPN',
  WEB_DNS_FILTERING: 'Web and DNS filtering',
  DLP: 'Data loss prevention',
  ENCRYPTION_KEY_MGMT: 'Encryption and key management',
  CLOUD_PLATFORM: 'Cloud or hosting platform',
  ITSM_TICKETING: 'IT service management and ticketing',
  SECURITY_AWARENESS: 'Security awareness training',
  PASSWORD_MANAGER: 'Password manager',
  SECURE_FILE_TRANSFER: 'Secure file transfer',
  PHYSICAL_SECURITY: 'Physical security',
  MANAGED_SERVICE: 'Managed service',
  OTHER: 'Other',
};

const lower = (s: string): string => s.toLowerCase();
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// ---- Filters, sort and the register table ----

/** How many tools each deployment filter shows (All counts every tool, including those with no deployment recorded). */
export function filterCounts(tools: InventoryTool[]): Record<ToolFilter, number> {
  const out: Record<ToolFilter, number> = { ALL: tools.length, ON_PREM: 0, CLOUD: 0, ESP: 0 };
  for (const t of tools) if (t.deployment) out[t.deployment] += 1;
  return out;
}

export type ToolSortKey = 'recovery' | 'name' | 'category' | 'users' | 'controls' | 'renewal' | 'cost';

type SortValue = string | number | null;

function sortValue(t: InventoryTool, key: ToolSortKey, controlCounts: Record<string, number>): SortValue {
  switch (key) {
    case 'recovery': return t.recoveryRank;
    case 'name': return lower(t.name);
    case 'category': return t.assetCategory;
    case 'users': return t.endUsers;
    case 'controls': return controlCounts[t.id] ?? 0;
    case 'renewal': return t.renewalDate;
    case 'cost': return typeof t.annualCostCents === 'number' ? t.annualCostCents : null;
  }
}

/** The register in the chosen order: a missing value sorts last in both directions, ties by name. Recovery ascending is the register's own order. A new array. */
export function sortTools(t: InventoryTool[], key: ToolSortKey, dir: 'asc' | 'desc', ctx: { controlCounts: Record<string, number> }): InventoryTool[] {
  if (key === 'recovery' && dir === 'asc') return sortForRegister(t);
  const sign = dir === 'asc' ? 1 : -1;
  return t.slice().sort((a, b) => {
    const va = sortValue(a, key, ctx.controlCounts);
    const vb = sortValue(b, key, ctx.controlCounts);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) {
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      if (c !== 0) return sign * c;
    }
    return lower(a.name).localeCompare(lower(b.name)) || a.id.localeCompare(b.id);
  });
}

export function ariaSort(key: ToolSortKey, active: ToolSortKey, dir: 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (key !== active) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

export function usersCell(t: Pick<InventoryTool, 'assetCategory' | 'endUsers' | 'privilegedUsers'>): { text: string; missing: boolean } {
  const missing = hasMissingUserCounts(t);
  if (t.endUsers === null && t.privilegedUsers === null) return { text: 'Not recorded', missing };
  const end = t.endUsers === null ? 'Not recorded' : String(t.endUsers);
  const priv = t.privilegedUsers === null ? 'Not recorded' : String(t.privilegedUsers);
  return { text: `${end} / ${priv}`, missing };
}

/** The line above the table about tools with no user counts (SSP 1.3.1); null when there are none. */
export function attentionLine(tools: Pick<InventoryTool, 'assetCategory' | 'endUsers' | 'privilegedUsers'>[]): string | null {
  const n = tools.filter(hasMissingUserCounts).length;
  if (n === 0) return null;
  return n === 1 ? '1 tool has no user counts (SSP 1.3.1).' : `${n} tools have no user counts (SSP 1.3.1).`;
}

const FEDRAMP_CLAIMS: FedrampStatus[] = ['LI_SAAS', 'LOW', 'MODERATE', 'HIGH', 'MODERATE_EQUIVALENT'];

/** The FedRAMP cell: a status that claims an authorization with no date checked is flagged (this app ships no authorization data). */
export function fedrampCell(t: Pick<InventoryTool, 'deployment' | 'fedrampStatus' | 'fedrampVerifiedOn'>): { text: string; sub: string | null; unverified: boolean } {
  if (t.deployment === 'ON_PREM' && t.fedrampStatus === 'UNKNOWN') return { text: 'Not applicable', sub: null, unverified: false };
  return {
    text: FEDRAMP_LABELS[t.fedrampStatus] ?? t.fedrampStatus,
    sub: t.fedrampVerifiedOn ? `Checked ${t.fedrampVerifiedOn}` : null,
    unverified: FEDRAMP_CLAIMS.includes(t.fedrampStatus) && !t.fedrampVerifiedOn,
  };
}

export function triLabel(b: boolean | null): 'Yes' | 'No' | 'Not answered' {
  return b === null ? 'Not answered' : b ? 'Yes' : 'No';
}

/** The table's columns in order: the Controls and Boundary columns need the program, the cost column needs a write role, Actions needs one too. */
export function registerColumns(a: { showCost: boolean; programParts: boolean; canEdit: boolean }): string[] {
  return [
    'tool', 'deployment', 'category', 'fedramp', 'crm', 'users', 'recovery',
    ...(a.programParts ? ['controls', 'boundary'] : []),
    ...(a.showCost ? ['cost'] : []),
    'renewal',
    ...(a.canEdit ? ['actions'] : []),
  ];
}

export function registerCountCaption(shown: number, total: number): string {
  if (shown === total) return `${total} ${plural(total, 'tool', 'tools')}`;
  return `${shown} of ${total} ${plural(total, 'tool', 'tools')}`;
}

export function registerEmptyMessage(a: { total: number; canEdit: boolean }): string {
  if (a.total > 0) return INVENTORY_UI_TEXT.emptyFiltered;
  return a.canEdit ? INVENTORY_UI_TEXT.emptyEditor : INVENTORY_UI_TEXT.emptyReader;
}

export type ProgramParts = 'unsupported' | 'no_program' | 'loading' | 'error' | 'ready';

export function programPartsMessage(p: ProgramParts): string | null {
  if (p === 'no_program') return INVENTORY_UI_TEXT.noProgram;
  if (p === 'loading') return INVENTORY_UI_TEXT.programLoading;
  if (p === 'error') return INVENTORY_UI_TEXT.programFailed;
  return null;
}

// ---- Boundary and removal texts ----

export function undeclaredNote(programName: string, total: number): string {
  return `${programName} has not declared its tools: its SSP lists the whole register (${total} ${plural(total, 'tool', 'tools')}).`;
}

export function declareFirstText(programName: string, total: number, adding: number): string {
  return `${programName} has not declared its tools, so its SSP lists all ${total} ${plural(total, 'tool', 'tools')} in the register. After this change it declares ${adding} ${plural(adding, 'tool', 'tools')}, and its SSP lists only ${adding === 1 ? 'that one' : 'those'}.`;
}

export function boundaryRemoveConfirmText(programName: string, inUse: { controlLinks: number; cuiLinks: number }): string {
  const n = inUse.controlLinks;
  const m = inUse.cuiLinks;
  return `Take this tool out of ${programName}'s boundary? Its ${n} control ${plural(n, 'link', 'links')} and ${m} CUI category ${plural(m, 'assignment', 'assignments')} in ${programName} are removed too.`;
}

export function removeToolConfirmText(u: { programs: number; controlLinks: number; cuiLinks: number } | null, ranked: boolean): string {
  let text: string;
  if (u === null) {
    text = 'Remove this tool from the register? Where it is used could not be checked: any control links and CUI category assignments it has in any program are removed too.';
  } else if (u.programs === 0 && u.controlLinks === 0 && u.cuiLinks === 0) {
    text = 'Remove this tool from the register? It has no control links or CUI category assignments in any program.';
  } else {
    text = `Remove this tool from the register? In ${u.programs} ${plural(u.programs, 'program', 'programs')} it has ${u.controlLinks} control ${plural(u.controlLinks, 'link', 'links')} and ${u.cuiLinks} CUI category ${plural(u.cuiLinks, 'assignment', 'assignments')}; they are removed too.`;
  }
  return ranked ? `${text} It also leaves the recovery order.` : text;
}

// ---- Recovery order ----

export function addToOrder(order: string[], id: string): string[] {
  return order.includes(id) ? order.slice() : [...order, id];
}

export function removeFromOrder(order: string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

export function moveAnnouncement(name: string, pos: number, total: number): string {
  return `Moved ${name} to position ${pos} of ${total}.`;
}

export function addedToOrderText(name: string, total: number): string {
  return `Added ${name} to the recovery order at position ${total} of ${total}.`;
}

export function removedFromOrderText(name: string): string {
  return `Removed ${name} from the recovery order.`;
}

// ---- Control links ----

export function controlsCell(n: number | null, programName: string | null): { text: string; sr: string } {
  if (n === null) return { text: '—', sr: 'No program open' };
  return { text: String(n), sr: `${n} ${plural(n, 'control', 'controls')} linked in ${programName ?? 'this program'}` };
}

/** A control link of any register: tools carry the evidence-source flag, documents do not (a missing flag counts as false). */
export type GenericControlLink = { controlId: string; evidenceSource?: boolean };

export function linkDiff<L extends GenericControlLink>(before: L[], after: L[]): { added: number; removed: number; changed: number } {
  const was = new Map(before.map((l) => [l.controlId, l.evidenceSource === true]));
  const now = new Map(after.map((l) => [l.controlId, l.evidenceSource === true]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, es] of now) {
    if (!was.has(id)) added += 1;
    else if (was.get(id) !== es) changed += 1;
  }
  for (const id of was.keys()) if (!now.has(id)) removed += 1;
  return { added, removed, changed };
}

export function linkDiffText(d: ReturnType<typeof linkDiff>): string {
  const parts: string[] = [];
  if (d.added > 0) parts.push(`adds ${d.added}`);
  if (d.removed > 0) parts.push(`removes ${d.removed}`);
  if (d.changed > 0) parts.push(`changes ${d.changed} evidence-source ${plural(d.changed, 'setting', 'settings')}`);
  if (parts.length === 0) return 'No changes.';
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * After a stale write: the server's links, with what the person did on top. A control they added is added, a control they removed (it was in
 * `oldIds` and is not in the draft) is removed, and on a control both hold the person's evidence-source setting wins.
 */
export function rebaseLinks<L extends GenericControlLink>(oldIds: string[], server: L[], draft: L[]): L[] {
  const old = new Set(oldIds);
  const draftById = new Map(draft.map((l) => [l.controlId, l]));
  const removed = new Set(oldIds.filter((id) => !draftById.has(id)));
  const out: L[] = [];
  const seen = new Set<string>();
  for (const l of server) {
    if (removed.has(l.controlId)) continue;
    const mine = draftById.get(l.controlId);
    out.push(mine && 'evidenceSource' in mine ? { ...l, evidenceSource: mine.evidenceSource } : l);
    seen.add(l.controlId);
  }
  for (const l of draft) {
    if (!old.has(l.controlId) && !seen.has(l.controlId)) {
      out.push(l);
      seen.add(l.controlId);
    }
  }
  return out;
}

/** The controls that match the search words (control id as shown, stored id or title) in one family, at most `limit` of them; `total` is the number of matches. */
export function searchControls<C extends { id: string; title: string; domain: string }>(
  cs: C[],
  q: string,
  domain: string,
  displayId: (id: string) => string,
  limit = 50
): { shown: C[]; total: number } {
  const words = lower(q).split(/\s+/).filter(Boolean);
  const matches = cs.filter((c) => {
    if (domain !== 'ALL' && c.domain !== domain) return false;
    if (words.length === 0) return true;
    const hay = lower(`${displayId(c.id)} ${c.id} ${c.title}`);
    return words.every((w) => hay.includes(w));
  });
  return { shown: matches.slice(0, limit), total: matches.length };
}

export function searchLimitLine(shown: number, total: number): string | null {
  if (total <= shown) return null;
  return `Showing ${shown} of ${total} matches. Refine the search to see more.`;
}

// ---- Quick add and survey suggestions ----

export function catalogMarker(e: { id: string; name: string }, tools: Pick<InventoryTool, 'name' | 'seedKey'>[]): 'in_register' | null {
  const name = lower(e.name.trim());
  return tools.some((t) => t.seedKey === `catalog:${e.id}` || lower(t.name.trim()) === name) ? 'in_register' : null;
}

export function batchResultText(created: number, skipped: { reason: string }[], linkFailures = 0): string {
  let text = `Added ${created} ${plural(created, 'tool', 'tools')}.`;
  if (skipped.length > 0) {
    const a = skipped.filter((s) => s.reason === 'duplicate_name').length;
    const b = skipped.filter((s) => s.reason === 'duplicate_seed').length;
    const c = skipped.filter((s) => s.reason === 'limit').length;
    const parts: string[] = [];
    if (a > 0) parts.push(`${a} already in the register (same name)`);
    if (b > 0) parts.push(`${b} already added before`);
    if (c > 0) parts.push(`${c} over the register limit`);
    text += ` ${skipped.length} skipped${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
  }
  if (linkFailures > 0) text += ` The controls of ${linkFailures} could not be linked; link them from each tool's Controls cell.`;
  return text;
}

export function surveyNotice(n: number): string {
  return n === 1 ? '1 tool suggested from your technology survey.' : `${n} tools suggested from your technology survey.`;
}

// ---- Dates, numbers and money ----

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 (UTC) of a real YYYY-MM-DD date; null for anything else. */
function dayNumber(iso: string): number | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

export function isRealDate(s: string): boolean {
  return dayNumber(s) !== null;
}

/** The local calendar date, YYYY-MM-DD. */
export function localDateIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A pill for a renewal that has passed or comes within `days` days (today counts); null otherwise. */
export function renewalBadge(date: string | null, today: string, days = 60): { tone: 'rose' | 'amber'; text: string } | null {
  if (!date) return null;
  const a = dayNumber(date);
  const b = dayNumber(today);
  if (a === null || b === null) return null;
  const left = a - b;
  if (left < 0) return { tone: 'rose', text: 'Renewal date passed' };
  if (left === 0) return { tone: 'amber', text: 'Renews today' };
  if (left <= days) return { tone: 'amber', text: `Renews in ${left} ${plural(left, 'day', 'days')}` };
  return null;
}

const COUNT_ERROR = 'Enter a whole number from 0 to 10,000,000, or leave it blank.';
const USD_ERROR = 'Enter an amount in US dollars, such as 12500 or 12,500.00, or leave it blank.';
const MAX_COUNT = 10_000_000;
const MAX_COST_CENTS = 100_000_000_000;

export function parseCount(raw: string): { value: number | null; error: string | null } {
  const s = raw.trim();
  if (s === '') return { value: null, error: null };
  if (!/^\d{1,9}$/.test(s)) return { value: null, error: COUNT_ERROR };
  const n = Number(s);
  return n > MAX_COUNT ? { value: null, error: COUNT_ERROR } : { value: n, error: null };
}

/** Whole US cents from what a person types ("12500", "$12,500.00", "12500.5"): integer arithmetic only. */
export function parseUsdToCents(raw: string): { value: number | null; error: string | null } {
  const s = raw.trim();
  if (s === '') return { value: null, error: null };
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { value: null, error: USD_ERROR };
  const dollars = m[1].replace(/,/g, '');
  if (dollars.length > 12) return { value: null, error: USD_ERROR };
  const cents = Number(dollars) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return cents > MAX_COST_CENTS ? { value: null, error: USD_ERROR } : { value: cents, error: null };
}

/** 1250000 -> "12500.00"; null or absent -> "". */
export function centsToInput(c: number | null | undefined): string {
  if (typeof c !== 'number') return '';
  const whole = Math.floor(c / 100);
  return `${whole}.${String(c % 100).padStart(2, '0')}`;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUsd(c: number): string {
  return USD.format(c / 100);
}

// ---- The tool form ----

export interface ToolForm {
  name: string;
  vendorName: string;
  vendorId: string;
  mission: string;
  toolType: ToolType | '';
  deployment: ToolDeployment | '';
  assetCategory: CmmcAssetCategory | '';
  fedrampStatus: FedrampStatus;
  fedrampVerifiedOn: string;
  crmOnFile: 'yes' | 'no' | 'unset';
  endUsers: string;
  privilegedUsers: string;
  annualCost: string;
  renewalDate: string;
  notes: string;
}

export type ToolFormField = keyof ToolForm;

const triToForm = (b: boolean | null | undefined): 'yes' | 'no' | 'unset' => (b === true ? 'yes' : b === false ? 'no' : 'unset');
const countToForm = (n: number | null | undefined): string => (typeof n === 'number' ? String(n) : '');

/** The form for an existing tool, or for a new one (optionally filled in from a suggestion). */
export function toolFormFrom(t: InventoryTool | null, prefill?: Partial<ToolInput>): ToolForm {
  const s: Partial<ToolInput> = t ?? prefill ?? {};
  return {
    name: s.name ?? '',
    vendorName: s.vendorName ?? '',
    vendorId: s.vendorId ?? '',
    mission: s.mission ?? '',
    toolType: s.toolType ?? '',
    deployment: s.deployment ?? '',
    assetCategory: s.assetCategory ?? '',
    fedrampStatus: s.fedrampStatus ?? 'UNKNOWN',
    fedrampVerifiedOn: s.fedrampVerifiedOn ?? '',
    crmOnFile: triToForm(s.crmOnFile),
    endUsers: countToForm(s.endUsers),
    privilegedUsers: countToForm(s.privilegedUsers),
    annualCost: centsToInput(s.annualCostCents),
    renewalDate: s.renewalDate ?? '',
    notes: s.notes ?? '',
  };
}

const NO_FEDRAMP_DATE: FedrampStatus[] = ['UNKNOWN', 'NOT_APPLICABLE'];

/** True when the "date you checked" field applies to this FedRAMP status. */
export function fedrampDateApplies(status: FedrampStatus): boolean {
  return !NO_FEDRAMP_DATE.includes(status);
}

/** Why the form cannot be saved, per field, and otherwise the input to send. Without `includeCost` the input has no cost key at all (the server leaves it alone). */
export function validateToolForm(f: ToolForm, today: string, includeCost: boolean): { input: ToolInput | null; errors: Partial<Record<ToolFormField, string>> } {
  const errors: Partial<Record<ToolFormField, string>> = {};
  const dateError = 'Enter a real date (YYYY-MM-DD), or leave it blank.';
  if (f.name.trim() === '') errors.name = 'Enter the tool or service name.';
  const end = parseCount(f.endUsers);
  if (end.error) errors.endUsers = end.error;
  const priv = parseCount(f.privilegedUsers);
  if (priv.error) errors.privilegedUsers = priv.error;
  let cents: number | null = null;
  if (includeCost) {
    const c = parseUsdToCents(f.annualCost);
    if (c.error) errors.annualCost = c.error;
    cents = c.value;
  }
  const verifiedOn = fedrampDateApplies(f.fedrampStatus) ? f.fedrampVerifiedOn.trim() : '';
  if (verifiedOn !== '') {
    if (!isRealDate(verifiedOn)) errors.fedrampVerifiedOn = dateError;
    else if (verifiedOn > today) errors.fedrampVerifiedOn = 'The date you checked cannot be in the future.';
  }
  const renewal = f.renewalDate.trim();
  if (renewal !== '' && !isRealDate(renewal)) errors.renewalDate = dateError;
  if (Object.keys(errors).length > 0) return { input: null, errors };
  const input: ToolInput = {
    name: f.name.trim(),
    vendorName: f.vendorName.trim(),
    vendorId: f.vendorId === '' ? null : f.vendorId,
    mission: f.mission.trim(),
    toolType: f.toolType === '' ? null : f.toolType,
    deployment: f.deployment === '' ? null : f.deployment,
    assetCategory: f.assetCategory === '' || !isCmmcAssetCategory(f.assetCategory) ? null : f.assetCategory,
    fedrampStatus: f.fedrampStatus,
    fedrampVerifiedOn: verifiedOn === '' ? null : verifiedOn,
    crmOnFile: f.crmOnFile === 'yes' ? true : f.crmOnFile === 'no' ? false : null,
    endUsers: end.value,
    privilegedUsers: priv.value,
    renewalDate: renewal === '' ? null : renewal,
    notes: f.notes.trim(),
  };
  if (includeCost) input.annualCostCents = cents;
  return { input, errors };
}

const FORM_FIELDS: ToolFormField[] = [
  'name', 'vendorName', 'vendorId', 'mission', 'toolType', 'deployment', 'assetCategory', 'fedrampStatus', 'fedrampVerifiedOn',
  'crmOnFile', 'endUsers', 'privilegedUsers', 'annualCost', 'renewalDate', 'notes',
];

const norm = (f: ToolForm, k: ToolFormField): string => f[k].trim();

/** Three-way merge after a stale write: fields the person did not touch take the new server value; conflicts = touched by both, to different values. */
export function rebaseToolForm(oldBase: InventoryTool, newBase: InventoryTool, form: ToolForm, includeCost: boolean): { form: ToolForm; conflicts: ToolFormField[] } {
  const was = toolFormFrom(oldBase);
  const now = toolFormFrom(newBase);
  const next: ToolForm = { ...now };
  const conflicts: ToolFormField[] = [];
  for (const k of FORM_FIELDS) {
    if (k === 'annualCost' && !includeCost) continue;
    if (norm(form, k) === norm(was, k)) continue;
    (next as unknown as Record<string, string>)[k] = form[k];
    if (norm(now, k) !== norm(was, k) && norm(now, k) !== norm(form, k)) conflicts.push(k);
  }
  return { form: next, conflicts };
}

// ---- Errors ----

export type ToolAction = 'save' | 'delete' | 'order' | 'boundary' | 'links' | 'batch';

const DEFAULT_ERROR: Record<ToolAction, string> = {
  save: 'The tool could not be saved. Try again.',
  delete: 'The tool could not be removed. Try again.',
  order: 'The recovery order could not be changed. Try again.',
  boundary: 'The boundary could not be changed. Try again.',
  links: 'The control links could not be saved. Try again.',
  batch: 'The tools could not be added. Nothing was added; try again.',
};

/** Fixed text for a refused request: never the server's message and never a value. */
export function toolErrorMessage(err: unknown, action: ToolAction, programName?: string): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  switch (e.reason) {
    case 'duplicate_name': return 'A tool with this name is already in the register (names are compared without regard to case). Nothing was saved.';
    case 'stale_write': return INVENTORY_UI_TEXT.staleTool;
    case 'stale_order': return INVENTORY_UI_TEXT.staleOrder;
    case 'tool_not_in_boundary': return `This tool is not in ${programName ?? 'this program'}'s boundary. Add it to the boundary first. Nothing was saved.`;
    case 'control_not_in_program': return "One of these controls is not in this program's catalog. Nothing was saved; the links have been reloaded.";
    case 'vendor_not_found': return 'That vendor record was removed meanwhile. Choose another or none. Nothing was saved.';
    case 'not_found':
    case 'tool_not_found': return 'This tool was removed meanwhile. The list has been refreshed.';
    case 'unknown_tools': return 'Some of these tools were removed meanwhile. Nothing was saved; the list has been refreshed.';
    case 'limit':
      return action === 'links'
        ? 'This tool or program holds the most control links it can. Nothing was saved.'
        : 'The register already holds 1,000 tools, the most it can hold. Remove tools you no longer need, then try again.';
    case 'program_archived': return 'This program is archived, so its boundary, control links and data inventory are read-only. Nothing was saved.';
    case 'invalid_expected_updated_at': return 'This page is out of date. Reload it and try again. Nothing was saved.';
    default: break;
  }
  if (e.status === 400) return 'The server did not accept these values. Check the fields and that none is too long. Nothing was saved.';
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change the Tools and Services register. Nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved; try again.';
  return DEFAULT_ERROR[action];
}
