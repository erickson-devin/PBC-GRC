import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFrameworkControls } from '../src/data/frameworks';
import {
  INVENTORY_UI_TEXT,
  addToOrder,
  addedToOrderText,
  ariaSort,
  attentionLine,
  batchResultText,
  boundaryRemoveConfirmText,
  catalogMarker,
  centsToInput,
  controlsCell,
  declareFirstText,
  filterCounts,
  formatUsd,
  isRealDate,
  linkDiff,
  linkDiffText,
  localDateIso,
  moveAnnouncement,
  parseCount,
  parseUsdToCents,
  programPartsMessage,
  rebaseLinks,
  rebaseToolForm,
  registerColumns,
  registerCountCaption,
  registerEmptyMessage,
  removeFromOrder,
  removeToolConfirmText,
  removedFromOrderText,
  renewalBadge,
  searchControls,
  searchLimitLine,
  sortTools,
  surveyNotice,
  toolErrorMessage,
  toolFormFrom,
  usersCell,
  validateToolForm,
  fedrampCell,
  triLabel,
} from '../src/data/inventory/inventoryUiView';
import { ToolRecoveryOrder } from '../src/components/inventory/ToolRecoveryOrder';
import { ToolEvidenceStatus } from '../src/components/inventory/ToolEvidenceStatus';
import { ToolCostSummary } from '../src/components/inventory/ToolCostSummary';
import { rollupCosts } from '../src/data/inventory/costRollup';
import type { InventoryTool } from '../src/types/inventory';

/** The Tools and Services screens: their pure view logic (sort, parse, validate, merge, texts) and the presentational components rendered on the server. */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const mk = (o: Partial<InventoryTool> & { id: string; name: string }): InventoryTool => ({
  tenantId: 't1',
  vendorName: '',
  vendorId: null,
  mission: '',
  toolType: null,
  deployment: null,
  assetCategory: null,
  fedrampStatus: 'UNKNOWN',
  fedrampVerifiedOn: null,
  crmOnFile: null,
  endUsers: null,
  privilegedUsers: null,
  recoveryRank: null,
  renewalDate: null,
  origin: 'MANUAL',
  seedKey: null,
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  ...o,
});
const names = (ts: InventoryTool[]): string[] => ts.map((t) => t.name);
const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

// IU1 filter counts
const four = [mk({ id: 'a', name: 'A', deployment: 'ON_PREM' }), mk({ id: 'b', name: 'B', deployment: 'CLOUD' }), mk({ id: 'c', name: 'C', deployment: 'ESP' }), mk({ id: 'd', name: 'D' })];
const fc = filterCounts(four);
assert(fc.ALL === 4 && fc.ON_PREM === 1 && fc.CLOUD === 1 && fc.ESP === 1, 'IU1 filter counts: All keeps a tool with no deployment', fc);

// IU2 sort
const sortSet = [mk({ id: '1', name: 'gamma', endUsers: 5, annualCostCents: 100 }), mk({ id: '2', name: 'alpha', endUsers: null, annualCostCents: null }), mk({ id: '3', name: 'Beta', endUsers: 50, annualCostCents: 900 })];
const ctx = { controlCounts: {} };
assert(names(sortTools(sortSet, 'name', 'asc', ctx)).join() === 'alpha,Beta,gamma', 'IU2 name ascending ignores case');
assert(names(sortTools(sortSet, 'users', 'asc', ctx)).at(-1) === 'alpha' && names(sortTools(sortSet, 'users', 'desc', ctx)).at(-1) === 'alpha', 'IU2 users: a missing count is last in both directions');
assert(names(sortTools(sortSet, 'cost', 'desc', ctx)).join() === 'Beta,gamma,alpha', 'IU2 cost descending, no cost last', names(sortTools(sortSet, 'cost', 'desc', ctx)));
assert(ariaSort('name', 'name', 'desc') === 'descending' && ariaSort('name', 'name', 'asc') === 'ascending' && ariaSort('users', 'name', 'desc') === 'none', 'IU2 aria-sort');
const ranked = [mk({ id: 'r1', name: 'Zed', recoveryRank: 2 }), mk({ id: 'r2', name: 'Yak', recoveryRank: 1 }), mk({ id: 'r3', name: 'Abe' })];
assert(names(sortTools(ranked, 'recovery', 'asc', ctx)).join() === 'Yak,Zed,Abe', 'IU2 recovery ascending is the register order');
assert(sortSet.map((t) => t.name).join() === 'gamma,alpha,Beta', 'IU2 the input is not changed');

// IU3 users cell
assert(usersCell(mk({ id: 'x', name: 'x', endUsers: 40, privilegedUsers: 3 })).text === '40 / 3' && !usersCell(mk({ id: 'x', name: 'x', endUsers: 40, privilegedUsers: 3 })).missing, 'IU3 both counts');
const half = usersCell(mk({ id: 'x', name: 'x', endUsers: 40 }));
assert(half.text === '40 / Not recorded' && half.missing, 'IU3 one count missing', half);
const none = usersCell(mk({ id: 'x', name: 'x' }));
assert(none.text === 'Not recorded' && none.missing, 'IU3 no counts', none);
assert(!usersCell(mk({ id: 'x', name: 'x', assetCategory: 'OUT_OF_SCOPE' })).missing, 'IU3 an out-of-scope tool is never flagged');
const need = [mk({ id: '1', name: '1' }), mk({ id: '2', name: '2', endUsers: 1, privilegedUsers: 0 }), mk({ id: '3', name: '3' })];
assert(attentionLine([need[1]]) === null && attentionLine([need[0], need[1]]) === '1 tool has no user counts (SSP 1.3.1).' && attentionLine(need) === '2 tools have no user counts (SSP 1.3.1).', 'IU3 attention line for 0, 1 and 2');

// IU4 counts
assert(parseCount('').value === null && parseCount('').error === null && parseCount('40').value === 40 && parseCount(' 0 ').value === 0, 'IU4 blank and whole numbers');
assert(['-1', '1.5', '1e3', '10000001', 'abc'].every((s) => parseCount(s).error !== null && parseCount(s).value === null), 'IU4 refused counts');
assert(parseCount('10000000').value === 10000000, 'IU4 the upper bound is allowed');

// IU5 money
assert(parseUsdToCents('12500').value === 1250000 && parseUsdToCents('$12,500.00').value === 1250000 && parseUsdToCents('12500.5').value === 1250050 && parseUsdToCents('').value === null, 'IU5 amounts to cents');
assert(['12.345', '-1', 'abc', '1000000001', '1,2,3'].every((s) => parseUsdToCents(s).error !== null), 'IU5 refused amounts');
assert(parseUsdToCents('1000000000').value === 100_000_000_000, 'IU5 the largest amount');
assert(formatUsd(1250000) === '$12,500.00' && centsToInput(1250000) === '12500.00' && centsToInput(5) === '0.05' && centsToInput(null) === '' && centsToInput(undefined) === '', 'IU5 money formats');

// IU6 dates and renewals
assert(!isRealDate('2027-02-30') && isRealDate('2028-02-29') && !isRealDate('2027-2-3') && !isRealDate('nope'), 'IU6 real dates');
assert(localDateIso(new Date(2026, 0, 5)) === '2026-01-05', 'IU6 local date');
const soon = renewalBadge('2026-12-01', '2026-11-19');
assert(soon?.tone === 'amber' && soon.text === 'Renews in 12 days', 'IU6 renewal soon', soon);
assert(renewalBadge('2026-11-01', '2026-11-19')?.tone === 'rose' && renewalBadge('2027-06-01', '2026-11-19') === null && renewalBadge(null, '2026-11-19') === null, 'IU6 renewal passed, far and none');
assert(renewalBadge('2026-11-19', '2026-11-19')?.text === 'Renews today' && renewalBadge('2026-11-20', '2026-11-19')?.text === 'Renews in 1 day' && renewalBadge('2027-01-18', '2026-11-19')?.text === 'Renews in 60 days', 'IU6 renewal edges');

// IU7 validate
const base = toolFormFrom(null);
assert(validateToolForm(base, '2026-11-19', true).errors.name === 'Enter the tool or service name.' && validateToolForm(base, '2026-11-19', true).input === null, 'IU7 a blank name is refused');
const ok = validateToolForm({ ...base, name: ' Tool ', endUsers: '40', privilegedUsers: '3', annualCost: '12,500.00' }, '2026-11-19', false);
assert(ok.input !== null && ok.input.endUsers === 40 && ok.input.privilegedUsers === 3 && ok.input.name === 'Tool', 'IU7 a valid form', ok);
assert(ok.input !== null && !('annualCostCents' in ok.input), 'IU7 without cost access the input has no cost key');
const withCost = validateToolForm({ ...base, name: 'T', annualCost: '12,500.00' }, '2026-11-19', true);
assert(withCost.input?.annualCostCents === 1250000, 'IU7 with cost access the cost is in cents');
assert(validateToolForm({ ...base, name: 'T', fedrampStatus: 'MODERATE', fedrampVerifiedOn: '2026-11-20' }, '2026-11-19', false).errors.fedrampVerifiedOn === 'The date you checked cannot be in the future.', 'IU7 the date checked cannot be in the future');
assert(validateToolForm({ ...base, name: 'T', renewalDate: '2027-02-30' }, '2026-11-19', false).errors.renewalDate !== undefined, 'IU7 a renewal date must be real');
assert(validateToolForm({ ...base, name: 'T', fedrampStatus: 'UNKNOWN', fedrampVerifiedOn: '2099-01-01' }, '2026-11-19', false).input?.fedrampVerifiedOn === null, 'IU7 the date checked is dropped when the status has none');
assert(validateToolForm({ ...base, name: 'T', endUsers: '-1' }, '2026-11-19', false).errors.endUsers !== undefined, 'IU7 a bad count is refused');

// IU8 rebase
const oldBase = mk({ id: 't', name: 'T', mission: 'old', endUsers: 10 });
const newBase = mk({ id: 't', name: 'T', mission: 'server changed', endUsers: 20, updatedAt: '2026-02-01T00:00:00.000Z' });
const mine = { ...toolFormFrom(oldBase), endUsers: '30' };
const merged = rebaseToolForm(oldBase, newBase, mine, true);
assert(merged.form.mission === 'server changed' && merged.form.endUsers === '30' && merged.conflicts.join() === 'endUsers', 'IU8 untouched fields take the server value; both changed is a conflict', merged.conflicts);
const same = rebaseToolForm(oldBase, newBase, { ...toolFormFrom(oldBase), endUsers: '20' }, true);
assert(same.conflicts.length === 0, 'IU8 the same change on both sides is no conflict');
const costOld = mk({ id: 't', name: 'T', annualCostCents: 100 });
const costNew = mk({ id: 't', name: 'T', annualCostCents: 200 });
assert(rebaseToolForm(costOld, costNew, toolFormFrom(costOld), false).form.annualCost === '2.00', 'IU8 without cost access the cost field just follows the server');

// IU9 error messages
const dup = toolErrorMessage({ name: 'ApiError', status: 409, reason: 'duplicate_name', message: 'MARK' }, 'save');
assert(dup.includes('already in the register') && !dup.includes('MARK'), 'IU9 duplicate name, no echo', dup);
assert(toolErrorMessage({ status: 409, reason: 'stale_order' }, 'order') === INVENTORY_UI_TEXT.staleOrder, 'IU9 stale order');
assert(toolErrorMessage({ status: 409, reason: 'stale_write' }, 'save') === INVENTORY_UI_TEXT.staleTool, 'IU9 stale write');
assert(toolErrorMessage({ status: 403 }, 'save').includes('Tenant Owner or Admin') && toolErrorMessage({ status: 0 }, 'save').includes('could not be reached'), 'IU9 forbidden and unreachable');
assert(toolErrorMessage({ status: 409, reason: 'limit' }, 'links').includes('control links') && toolErrorMessage({ status: 409, reason: 'limit' }, 'save').includes('1,000 tools'), 'IU9 limit for links and for the register');
assert(toolErrorMessage({ status: 409, reason: 'tool_not_in_boundary', message: 'MARK' }, 'links', 'Prog One').includes("Prog One's boundary") && toolErrorMessage(null, 'delete') === 'The tool could not be removed. Try again.', 'IU9 boundary and default messages');
assert(toolErrorMessage({ status: 400, message: 'MARK' }, 'save').includes('did not accept') && !toolErrorMessage({ status: 400, message: 'MARK' }, 'save').includes('MARK'), 'IU9 a 400 never echoes the server message');

// IU10 removal text
const rt0 = removeToolConfirmText(null, false);
const rt1 = removeToolConfirmText({ programs: 0, controlLinks: 0, cuiLinks: 0 }, false);
const rt2 = removeToolConfirmText({ programs: 2, controlLinks: 5, cuiLinks: 1 }, true);
assert(rt0.includes('could not be checked') && rt1.includes('no control links or CUI category assignments') && rt2.includes('In 2 programs') && rt2.includes('5 control links and 1 CUI category assignment') && rt2.includes('recovery order'), 'IU10 removal texts', [rt0, rt1, rt2]);
assert(!removeToolConfirmText({ programs: 1, controlLinks: 1, cuiLinks: 1 }, false).includes('recovery order') && removeToolConfirmText({ programs: 1, controlLinks: 1, cuiLinks: 1 }, false).includes('In 1 program it has 1 control link and 1 CUI category assignment'), 'IU10 singular forms');

// IU11 boundary texts
const df = declareFirstText('P1', 12, 1);
assert(df.includes('all 12 tools') && df.includes('only that one') && declareFirstText('P1', 12, 3).includes('only those'), 'IU11 declare text', df);
assert(boundaryRemoveConfirmText('P1', { controlLinks: 2, cuiLinks: 0 }).includes('2 control links and 0 CUI category assignments'), 'IU11 remove from boundary text');

// IU12 recovery order helpers
assert(addToOrder(['a'], 'b').join() === 'a,b' && addToOrder(['a'], 'a').join() === 'a' && removeFromOrder(['a', 'b'], 'a').join() === 'b', 'IU12 order helpers');
assert(moveAnnouncement('X', 2, 5) === 'Moved X to position 2 of 5.' && addedToOrderText('X', 5) === 'Added X to the recovery order at position 5 of 5.' && removedFromOrderText('X') === 'Removed X from the recovery order.', 'IU12 announcements');

// IU13 control links
const L = (c: string, es = false) => ({ toolId: 't', controlId: c, evidenceSource: es });
assert(linkDiffText(linkDiff([L('c1')], [L('c1')])) === 'No changes.', 'IU13 no changes');
const d = linkDiff([L('c1'), L('c2'), L('c3', true)], [L('c1'), L('c3'), L('c4'), L('c5')]);
assert(d.added === 2 && d.removed === 1 && d.changed === 1 && linkDiffText(d) === 'Adds 2, removes 1, changes 1 evidence-source setting.', 'IU13 diff text', d);
assert(linkDiffText({ added: 0, removed: 3, changed: 2 }) === 'Removes 3, changes 2 evidence-source settings.', 'IU13 only the non-zero parts');
const rb = rebaseLinks(['c1', 'c2'], [L('c1'), L('c3')], [L('c1', true), L('c4')]);
assert(rb.map((l) => l.controlId).join() === 'c1,c3,c4' && rb[0].evidenceSource === true, 'IU13 rebase keeps the server link, the removal and the addition; the draft setting wins', rb);

// IU14 control search
const nist = getFrameworkControls('NIST_800_53_REV5');
const found = searchControls(nist, 'access', 'ALL', (id) => id);
assert(found.shown.length === 50 && found.total > 50, 'IU14 the picker shows at most 50 matches', [found.shown.length, found.total]);
assert((searchLimitLine(50, found.total) ?? '').includes('Refine') && searchLimitLine(3, 3) === null, 'IU14 the refine line');
const l2 = getFrameworkControls('CMMC_L2');
const l2hit = searchControls(l2, '3.1.1', 'ALL', (id) => id);
assert(l2hit.total > 0 && l2hit.shown.some((c) => c.domain === 'AC'), 'IU14 a CMMC Level 2 search by number finds the AC practice');
assert(searchControls(nist, '', 'AC', (id) => id).shown.every((c) => c.domain === 'AC') && searchControls(nist, 'zzzzqq', 'ALL', (id) => id).total === 0, 'IU14 family filter and no match');

// IU15 catalog marker and batch text
assert(catalogMarker({ id: 'abc', name: 'Abc Tool' }, [{ name: 'Other', seedKey: 'catalog:abc' }]) === 'in_register', 'IU15 marker by seed key');
assert(catalogMarker({ id: 'abc', name: 'Abc Tool' }, [{ name: 'abc TOOL ', seedKey: null }]) === 'in_register' && catalogMarker({ id: 'abc', name: 'Abc Tool' }, [{ name: 'Else', seedKey: 'survey:x' }]) === null, 'IU15 marker by name, else none');
assert(
  batchResultText(2, [{ reason: 'duplicate_name' }, { reason: 'duplicate_seed' }], 1) ===
    "Added 2 tools. 2 skipped: 1 already in the register (same name), 1 already added before. The controls of 1 could not be linked; link them from each tool's Controls cell.",
  'IU15 batch result text'
);
assert(batchResultText(1, []) === 'Added 1 tool.' && batchResultText(0, [{ reason: 'limit' }]).includes('1 over the register limit'), 'IU15 batch text singular and limit');
assert(surveyNotice(1) === '1 tool suggested from your technology survey.' && surveyNotice(3) === '3 tools suggested from your technology survey.', 'IU15 survey notice');

// IU16 columns and captions
const bare = registerColumns({ showCost: false, programParts: false, canEdit: false });
assert(!bare.some((c) => ['cost', 'controls', 'boundary', 'actions'].includes(c)), 'IU16 a read role without a program sees no cost, controls, boundary or actions', bare);
const all = registerColumns({ showCost: true, programParts: true, canEdit: true });
assert(all.length === 12 && all.join() === 'tool,deployment,category,fedramp,crm,users,recovery,controls,boundary,cost,renewal,actions', 'IU16 all columns in order', all);
assert(registerCountCaption(1, 1) === '1 tool' && registerCountCaption(12, 12) === '12 tools' && registerCountCaption(3, 12) === '3 of 12 tools', 'IU16 caption');
assert(registerEmptyMessage({ total: 0, canEdit: true }) === INVENTORY_UI_TEXT.emptyEditor && registerEmptyMessage({ total: 0, canEdit: false }) === INVENTORY_UI_TEXT.emptyReader && registerEmptyMessage({ total: 4, canEdit: true }) === INVENTORY_UI_TEXT.emptyFiltered, 'IU16 empty messages');
assert(programPartsMessage('ready') === null && programPartsMessage('unsupported') === null && programPartsMessage('no_program') === INVENTORY_UI_TEXT.noProgram && programPartsMessage('error') === INVENTORY_UI_TEXT.programFailed && programPartsMessage('loading') === INVENTORY_UI_TEXT.programLoading, 'IU16 program parts messages');
assert(controlsCell(null, null).text === '—' && controlsCell(3, 'P1').sr === '3 controls linked in P1' && controlsCell(1, 'P1').sr === '1 control linked in P1', 'IU16 controls cell');
assert(fedrampCell({ deployment: 'ON_PREM', fedrampStatus: 'UNKNOWN', fedrampVerifiedOn: null }).text === 'Not applicable' && fedrampCell({ deployment: 'CLOUD', fedrampStatus: 'MODERATE', fedrampVerifiedOn: null }).unverified && fedrampCell({ deployment: 'CLOUD', fedrampStatus: 'MODERATE', fedrampVerifiedOn: '2026-05-01' }).sub === 'Checked 2026-05-01', 'IU16 FedRAMP cell');
assert(triLabel(null) === 'Not answered' && triLabel(true) === 'Yes' && triLabel(false) === 'No', 'IU16 tri-state label');

// IU17 recovery order, rendered
const three = [mk({ id: 'a', name: 'A', recoveryRank: 1 }), mk({ id: 'b', name: 'B', recoveryRank: 2 }), mk({ id: 'c', name: 'C', recoveryRank: 3 }), mk({ id: 'd', name: 'D' })];
const noop = () => Promise.resolve(true);
const orderProps = { tools: three, busy: false, error: null, onMove: noop, onAdd: noop, onRemove: noop, announcement: 'Moved A to position 2 of 3.' };
const rhtml = renderToStaticMarkup(React.createElement(ToolRecoveryOrder, { ...orderProps, canEdit: true }));
assert(rhtml.includes('aria-label="Move A up"') && /aria-label="Move A up"[^>]*disabled=""|disabled=""[^>]*aria-label="Move A up"/.test(rhtml), 'IU17 the first up button is disabled', rhtml.slice(0, 600));
assert(!/aria-label="Move B up"[^>]*disabled=""/.test(rhtml) && /aria-label="Move C down"[^>]*disabled=""|disabled=""[^>]*aria-label="Move C down"/.test(rhtml), 'IU17 the middle moves and the last down is disabled');
assert((rhtml.match(/<ol/g) ?? []).length === 1 && rhtml.includes('role="status"') && rhtml.includes('Moved A to position 2 of 3.'), 'IU17 one ordered list and a status region');
assert(rhtml.includes('aria-label="Add D to the recovery order"') && rhtml.includes('aria-label="Remove A from the recovery order"'), 'IU17 add and remove buttons');
const rro = renderToStaticMarkup(React.createElement(ToolRecoveryOrder, { ...orderProps, canEdit: false }));
assert(!rro.includes('Move ') && !rro.includes('Add to order') && rro.includes(INVENTORY_UI_TEXT.recoveryReadOnly), 'IU17 read only has no controls');

// IU18 evidence status, rendered
const evBase = { programName: 'P1', rows: [], toolNames: { a: 'A' }, tools: [{ id: 'a', name: 'A' }], toolFilter: 'ALL', onToolFilter: () => undefined, includeNonSource: false, onIncludeNonSource: () => undefined, displayId: (id: string) => id, statusLabel: (s: string) => s, onOpenControl: () => undefined };
assert(renderToStaticMarkup(React.createElement(ToolEvidenceStatus, { ...evBase, state: 'no_program' as const })).includes('Open a program'), 'IU18 no program');
const evRow = renderToStaticMarkup(React.createElement(ToolEvidenceStatus, { ...evBase, state: 'ready' as const, rows: [{ toolId: 'a', controlId: 'AC-2', controlTitle: 'Account management', status: 'NOT_STARTED', evidenceCount: 0, evidenceSource: true }] }));
assert(evRow.includes('No evidence') && evRow.includes('aria-label="Open control AC-2"') && evRow.includes('Evidence status by tool'), 'IU18 a control with no evidence is flagged', evRow.slice(0, 300));
assert(renderToStaticMarkup(React.createElement(ToolEvidenceStatus, { ...evBase, state: 'ready' as const })).includes(INVENTORY_UI_TEXT.evidenceEmpty.slice(0, 20)), 'IU18 empty list text');
assert(renderToStaticMarkup(React.createElement(ToolEvidenceStatus, { ...evBase, state: 'error' as const })).includes('role="alert"'), 'IU18 load error');

// IU19 cost summary, rendered
const costTools = [mk({ id: 'a', name: 'A', annualCostCents: 152500, assetCategory: 'CUI_ASSET' }), mk({ id: 'b', name: 'B', annualCostCents: null })];
const chtml = renderToStaticMarkup(
  React.createElement(ToolCostSummary, {
    total: rollupCosts(costTools),
    program: null,
    renewals: [{ id: 'a', name: 'A', renewalDate: '2026-12-01', daysLeft: 12 }],
    perProgram: { status: 'error', rows: [] },
    onRetry: () => undefined,
  })
);
assert(chtml.includes('role="alert"') && chtml.includes('$1,525.00') && chtml.includes('1 with a cost, 1 without') && chtml.includes('Renews in 12 days'), 'IU19 the total shows even when the per-program totals fail', chtml.slice(0, 400));
const chtml2 = renderToStaticMarkup(
  React.createElement(ToolCostSummary, {
    total: rollupCosts(costTools),
    program: { name: 'P1', rollup: rollupCosts(costTools) },
    renewals: [],
    perProgram: { status: 'ready', rows: [{ programId: 'p', name: 'P1', archived: true, declared: false, toolCount: 2, totalCents: 152500 }] },
    onRetry: () => undefined,
  })
);
assert(chtml2.includes('No renewals in the next 60 days.') && chtml2.includes('P1 (archived)') && chtml2.includes('Whole register (2)') && chtml2.includes('In P1'), 'IU19 per-program table');

// IU20 quick add source
const quick = src('src/components/inventory/ToolQuickAddDialog.tsx');
const gate = quick.indexOf('if (linkSuggested)');
assert(quick.includes('onBatch(items)'), 'IU20 the dialog sends the ticked tools in one batch');
assert(gate > 0 && quick.indexOf('onLinkControls(') > gate, 'IU20 control links are only written after the link box is ticked');
assert(quick.includes('const [linkSuggested, setLinkSuggested] = useState(false)') && quick.includes('const [addToBoundary, setAddToBoundary] = useState(false)'), 'IU20 linking and boundary start off');
assert(quick.includes('Math.min(MAX_BATCH, limitLeft)') && !quick.includes('localStorage'), 'IU20 the batch cap');

// IU21 panel source
const panel = src('src/components/inventory/ToolRegisterPanel.tsx');
assert(panel.includes('seedCandidatesFromStackProfile(') && panel.includes('setSeedOpen(true)'), 'IU21 survey suggestions are offered, not applied');
assert((panel.match(/createBatch/g) ?? []).length === 2 && !panel.replace(/onBatch=\{reg\.createBatch\}/g, '').includes('createBatch'), 'IU21 the panel never batch-creates itself');
assert(panel.includes('toolRegisterCsv(') && panel.includes('includeCost: reg.showCost'), 'IU21 CSV export follows the cost access');
assert(panel.includes('useToolRegister(') && panel.includes('useProgramInventory(') && panel.includes('enabled: view === \'costs\' && costsOn'), 'IU21 memberships load only on the Costs view');
assert(panel.includes('costsOn') && panel.includes('{view === \'costs\' && costsOn && ('), 'IU21 the Costs view needs cost access');

// IU22 privacy and dialog cap, every file of the feature
const dir = join(process.cwd(), 'src', 'components', 'inventory');
const featureFiles = readdirSync(dir).filter((f) => /^(downloadCsv\.ts|Tool.*\.tsx|SurveySeedDialog\.tsx)$/.test(f));
assert(featureFiles.length >= 9, 'IU22 all nine feature files are there', featureFiles);
let clean = true;
let capped = true;
for (const f of [...featureFiles.map((x) => `src/components/inventory/${x}`), 'src/data/inventory/inventoryUiView.ts']) {
  const s = src(f);
  if (/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(s)) {
    clean = false;
    console.error(`    ${f} has a forbidden call`);
  }
  for (const m of s.matchAll(/<DialogOverlay/g)) {
    const chunk = s.slice(m.index ?? 0, (m.index ?? 0) + 900);
    if (!chunk.includes('max-h-[') && !chunk.includes('my-auto')) capped = false;
  }
}
assert(clean, 'IU22 no console, browser storage, alert or raw HTML in the feature files');
assert(capped, 'IU22 every dialog is height-capped');

// IU23 navigation tab
assert(src('src/context/AssessmentContext.tsx').includes("| 'tools'"), "IU23 the 'tools' tab is a navigation tab");
assert(!src('src/data/programDefaultChoice.ts').includes("'tools'"), 'IU23 the register is not program-scoped');

// IU24 the link helpers are generic: links without an evidence-source flag (documents) diff and rebase too
const D = (c: string) => ({ controlId: c });
const dd = linkDiff([D('c1'), D('c2')], [D('c1'), D('c3')]);
assert(dd.added === 1 && dd.removed === 1 && dd.changed === 0, 'IU24 {controlId}-only links never produce a changed count', dd);
assert(linkDiff([D('c1')], [{ controlId: 'c1', evidenceSource: false }]).changed === 0, 'IU24 a missing flag counts as false');
assert(linkDiffText(linkDiff([D('c1')], [D('c1')])) === 'No changes.', 'IU24 no changes for documents');
const rbd = rebaseLinks(['c1', 'c2'], [D('c1'), D('c3')], [D('c1'), D('c4')]);
assert(rbd.map((l) => l.controlId).join() === 'c1,c3,c4' && rbd.every((l) => !('evidenceSource' in l)), 'IU24 rebaseLinks works on {controlId} objects and adds no flag', rbd);
const shared = src('src/components/inventory/ControlLinksDialog.tsx');
assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(shared) && !/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(src('src/components/inventory/EvidenceAttachFieldset.tsx')), 'IU24 the shared dialogs have no console, browser storage, alert or raw HTML');
assert(src('src/components/inventory/ToolControlsEditor.tsx').includes('<ControlLinksDialog'), 'IU24 the tool editor is built on the shared dialog');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
