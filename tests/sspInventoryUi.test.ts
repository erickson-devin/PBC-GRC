import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeSspCompleteness } from '../src/data/ssp/sspCompleteness';
import { navEntriesView } from '../src/data/ssp/sspBuilderView';
import {
  DESIGNATION_LABELS,
  SSP_INVENTORY_TEXT,
  assignmentCount,
  bannerText,
  canUntick,
  cuiRequirementLine,
  dataInventorySaveErrorText,
  designationView,
  fciHint,
  fciValue,
  filterRegistry,
  informationTypesCopyLine,
  inventoryNavText,
  matrixRows,
  registryNote,
  removeCategory,
  removeCategoryConfirmText,
  roleValue,
  setFci,
  setToolRole,
  systemDetailsCopyLines,
  systemDetailsRows,
  toggleCategory,
  yesNoLabel,
} from '../src/data/ssp/sspInventoryView';
import { buildSspInventorySnapshot, CMMC_L2_NEEDS_CUI_CATEGORY, INVENTORY_NOT_AVAILABLE, type SspInventoryCompletenessInput } from '../src/data/inventory/sspInventory';
import { groupCategories, categoryLink, type CuiRegistry } from '../src/data/cui/cuiRegistry';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import { SspDataInventorySection } from '../src/components/ssp/SspDataInventorySection';
import { SspSystemDetailsSection } from '../src/components/ssp/SspSystemDetailsSection';
import { SspSectionNav } from '../src/components/ssp/SspSectionNav';
import type { DataInventoryRecord, InventoryTool } from '../src/types/inventory';

/**
 * #239 / #243: SSP sections 1.3 (System details) and 1.4 (Data inventory) in the builder. The pure view module is tested directly, the two section
 * components and the nav are rendered on the server (no browser), and source pins keep the wiring (document view, copy, export, link rules) from drifting.
 * Pure test: no server, no browser, no timers.
 */
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

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const noop = () => undefined;

const registry = JSON.parse(read('src/data/cui/cuiRegistry.json')) as CuiRegistry;
const tool = (over: Partial<InventoryTool> & Pick<InventoryTool, 'id' | 'name'>): InventoryTool => ({
  tenantId: 't1', vendorName: '', vendorId: null, mission: '', toolType: null, deployment: null, assetCategory: null, fedrampStatus: 'UNKNOWN',
  fedrampVerifiedOn: null, crmOnFile: null, endUsers: null, privilegedUsers: null, recoveryRank: null, renewalDate: null, origin: 'MANUAL',
  seedKey: null, notes: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: null, ...over,
});
const blank = (): DataInventoryRecord => ({ handlesFci: null, categories: [], updatedAt: null, updatedBy: null });
const withCti = (rows: { toolId: string; stores: boolean; processes: boolean; transmits: boolean }[] = []): DataInventoryRecord => ({ ...blank(), categories: [{ categoryId: 'CTI', tools: rows }] });
const role = (toolId: string, stores = true, processes = false, transmits = false) => ({ toolId, stores, processes, transmits });

console.log('\n🧩 SSP 1.3 and 1.4 in the builder (#239, #243)');

// ---------------------------------------------------------------- requirement lines
console.log('--- Requirement lines and hints ---');
const l2 = cuiRequirementLine('CMMC_L2', 0);
assert(l2?.tone === 'rose' && l2.text.includes('select at least one CUI category') && l2.text === CMMC_L2_NEEDS_CUI_CATEGORY, 'SI1 a CMMC Level 2 program with no category gets the required-item message');
assert(cuiRequirementLine('CMMC_L2', 2) === null, 'SI1b a Level 2 program with a category gets no line');
assert(cuiRequirementLine('CMMC_L1', 1)?.tone === 'amber' && cuiRequirementLine('CMMC_L1', 0) === null, 'SI1c Level 1: amber when CUI is selected, nothing otherwise');
assert(cuiRequirementLine('SOC_2_TYPE_II', 0)?.tone === 'slate' && cuiRequirementLine('SOC_2_TYPE_II', 0)?.text === SSP_INVENTORY_TEXT.cuiOptional, 'SI1d other frameworks: optional');
assert(fciHint('CMMC_L1', false) === SSP_INVENTORY_TEXT.l1FciNo && fciHint('CMMC_L2', false) === null && fciHint('CMMC_L1', true) === null && fciHint('CMMC_L1', null) === null, 'SI2 only a Level 1 No answer is questioned');
assert(fciValue(true) === 'yes' && fciValue(false) === 'no' && fciValue(null) === 'unset', 'SI2b fciValue');
assert(setFci(blank(), 'yes').handlesFci === true && setFci(blank(), 'no').handlesFci === false && setFci({ ...blank(), handlesFci: true }, 'unset').handlesFci === null, 'SI2c setFci writes the answer and nothing else');

// ---------------------------------------------------------------- record edits
console.log('--- Data inventory edits ---');
const added = toggleCategory(blank(), 'CTI', true);
assert(added.categories.length === 1 && added.categories[0].categoryId === 'CTI' && added.categories[0].tools.length === 0 && toggleCategory(added, 'CTI', true) === added, 'SI3 ticking a category adds it with no tools, once');
assert(toggleCategory(added, 'CTI', false).categories.length === 0, 'SI3b unticking a category with no tools removes it');
const assigned = withCti([role('a')]);
assert(!canUntick(assigned, 'CTI') && toggleCategory(assigned, 'CTI', false) === assigned && canUntick(added, 'CTI') && canUntick(assigned, 'OTHER'), 'SI3c a category with tool assignments cannot be unticked and the record is unchanged');
const r1 = setToolRole(added, 'CTI', 'a', 'stores', true);
const r2 = setToolRole(r1, 'CTI', 'a', 'transmits', true);
assert(assignmentCount(r1, 'CTI') === 1 && roleValue(r2, 'CTI', 'a', 'stores') && roleValue(r2, 'CTI', 'a', 'transmits') && !roleValue(r2, 'CTI', 'a', 'processes'), 'SI3d setToolRole sets one role at a time');
const r3 = setToolRole(setToolRole(r2, 'CTI', 'a', 'stores', false), 'CTI', 'a', 'transmits', false);
assert(assignmentCount(r3, 'CTI') === 0 && r3.categories.length === 1, 'SI3e a row with all three roles false is dropped, the category stays');
assert(setToolRole(blank(), 'CTI', 'a', 'stores', true).categories.length === 0 && setToolRole(added, 'CTI', 'a', 'stores', false).categories[0].tools.length === 0, 'SI3f a role of a category that is not selected is ignored, and clearing a role that is not set adds no row');
assert(removeCategory(assigned, 'CTI').categories.length === 0 && removeCategory(withCti(), 'OTHER').categories.length === 1, 'SI3g removeCategory drops the category with its rows');
assert(removeCategoryConfirmText('CTI', 1) === 'Remove CTI from this SSP? Its 1 tool assignment is removed too.' && removeCategoryConfirmText('CTI', 3).includes('3 tool assignments are removed'), 'SI3h the removal text names the id and counts, singular and plural');
const mr = matrixRows(withCti([role('a'), role('gone')]), 'CTI', [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
assert(mr.map((r) => r.id).join() === 'a,b,gone' && mr[2].outside && mr[2].name === SSP_INVENTORY_TEXT.outsideBoundary && !mr[0].outside, 'SI3i an assigned tool that left the boundary stays visible so it can be cleared, without a name');

// ---------------------------------------------------------------- registry list
console.log('--- Registry list ---');
const all = filterRegistry(registry, '');
assert(all.length > 0 && all.every((g) => g.categories.length > 0) && all.reduce((n, g) => n + g.categories.length, 0) === registry.categories.length, 'SI4 an empty search lists every category');
const exp = filterRegistry(registry, 'export');
const groupIds = new Set(groupCategories(registry).map((g) => g.group.id));
assert(exp.length > 0 && exp.every((g) => groupIds.has(g.group.id)) && exp.every((g) => g.categories.every((c) => c.indexGroup === g.group.id)), 'SI4b the groups match the registry groups and hold only their own categories');
assert(exp.every((g) => g.categories.length > 0) && exp.reduce((n, g) => n + g.categories.length, 0) < registry.categories.length, 'SI4c empty groups are dropped and the list narrows');
assert(filterRegistry(registry, 'cti').some((g) => g.categories.some((c) => c.id === 'CTI')) && filterRegistry(registry, 'CUI//SP-CTI').some((g) => g.categories.some((c) => c.id === 'CTI')), 'SI4d a search matches an abbreviation and a banner marking, any case');
assert(filterRegistry(registry, 'zzzz-no-such').length === 0, 'SI4e no match gives an empty list');
const cti = registry.categories.find((c) => c.id === 'CTI')!;
assert(bannerText(cti) !== null && (bannerText(cti) ?? '').includes('CUI//SP-CTI'), 'SI4f the banner text carries the specified banner');
assert(designationView('BASIC')?.label === 'Basic' && designationView('SPECIFIED')?.label === 'Specified' && designationView('BOTH')?.label === 'Basic and Specified' && designationView('NONE') === null && designationView(null) === null && DESIGNATION_LABELS.BOTH === 'Basic and Specified', 'SI4g markers: Basic, Specified, Basic and Specified, none for NONE');
assert(registryNote(registry._meta) === `List from the NARA CUI Registry as of ${registry._meta.asOf}.`, 'SI4h the registry note carries the as-of date');

// ---------------------------------------------------------------- rows and texts
console.log('--- Rows, nav and texts ---');
const tools = [
  tool({ id: 'a', name: 'Alpha', deployment: 'CLOUD', assetCategory: 'SECURITY_PROTECTION', endUsers: 40, privilegedUsers: 3 }),
  tool({ id: 'b', name: 'Beta', deployment: null, assetCategory: null, endUsers: null, privilegedUsers: 2 }),
  tool({ id: 'c', name: 'Gamma', assetCategory: 'OUT_OF_SCOPE' }),
];
const snap = buildSspInventorySnapshot({ supported: true, tools, program: { declared: false, toolIds: [] }, data: null, registry });
const rows = systemDetailsRows(snap);
assert(rows.length === 2 && rows.map((r) => r.name).join() === 'Alpha,Beta', 'SI5 an out-of-scope tool is left out of 1.3.1');
assert(rows[0].endUsers === '40' && rows[0].privileged === '3' && !rows[0].missing && rows[0].deployment === 'Cloud', 'SI5b counts and the deployment label');
assert(rows[1].endUsers === NOT_RECORDED && rows[1].privileged === '2' && rows[1].missing && rows[1].deployment === NOT_RECORDED && rows[1].category === NOT_RECORDED, 'SI5c a missing count, deployment and category print Not recorded');
assert(systemDetailsCopyLines(snap).join('|') === '- Alpha: 40 end users, 3 privileged|- Beta: Not recorded end users, 2 privileged', 'SI5d the plain-text lines');
const noTools = buildSspInventorySnapshot({ supported: true, tools: [], program: null, data: null, registry: null });
const off = buildSspInventorySnapshot({ supported: false, tools: [], program: null, data: null, registry: null });
assert(systemDetailsCopyLines(noTools)[0].includes('No tools') && systemDetailsCopyLines(off)[0].includes(INVENTORY_NOT_AVAILABLE), 'SI5e empty and unavailable copy lines');
const withData = buildSspInventorySnapshot({ supported: true, tools, program: null, data: { ...withCti([role('a')]), handlesFci: true }, registry });
assert(informationTypesCopyLine(withData) === 'FCI Yes; CUI: CTI' && informationTypesCopyLine(noTools) === 'FCI Not recorded; CUI: none' && informationTypesCopyLine(off) === INVENTORY_NOT_AVAILABLE, 'SI5f the information types line');
assert(yesNoLabel(true) === 'Yes' && yesNoLabel(false) === 'No' && yesNoLabel(null) === NOT_RECORDED, 'SI5g yesNoLabel');

assert(
  inventoryNavText('unsupported') === 'Not available' && inventoryNavText('loading') === 'Loading…' && inventoryNavText('error') === 'Could not load' && inventoryNavText('ready') === null,
  'SI6 inventoryNavText by status'
);
const noInv = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, inventory: undefined });
const navOff = navEntriesView(noInv, { supported: true, status: 'ready', sections: {} });
const navSd = navOff.find((e) => e.id === 'system_details')!;
const navDi = navOff.find((e) => e.id === 'data_inventory')!;
assert(
  !navSd.available && !navDi.available && navSd.review === null && navDi.review === null && navSd.unavailableText === 'Not available' && navDi.unavailableText === 'Not available' &&
    !navSd.complete && navSd.missingText === null && navSd.requiredMissing === 0,
  'SI6b without the register 1.3 and 1.4 are unavailable: no review chip, no count, not complete'
);
assert(navOff.find((e) => e.id === 'identification')!.available && navOff.find((e) => e.id === 'identification')!.review !== null && navOff.find((e) => e.id === 'roles')!.unavailableText === null, 'SI6c the other sections stay available and keep their review chip');
assert(navEntriesView(noInv, { supported: true, status: 'ready', sections: {} }, { inventoryStatus: 'loading' }).find((e) => e.id === 'data_inventory')!.unavailableText === 'Loading…', 'SI6d the nav text follows the register status');
const inv: SspInventoryCompletenessInput = { supported: true, tools: [], handlesFci: null, categories: [] };
const navOn = navEntriesView(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, inventory: inv }), { supported: true, status: 'ready', sections: {} });
const onDi = navOn.find((e) => e.id === 'data_inventory')!;
assert(onDi.available && onDi.requiredMissing >= 1 && onDi.review === null && onDi.missingText !== null && navOn.find((e) => e.id === 'system_details')!.review === null, 'SI6e with the register 1.3 and 1.4 carry their count and still no review chip');
assert((['failed', 'archived', 'invalid', 'forbidden', 'not_in_boundary', 'unknown_category'] as const).every((e) => dataInventorySaveErrorText(e).length > 10), 'SI6f every save error has fixed text');
assert(dataInventorySaveErrorText('forbidden').includes('Tenant Owner or Admin') && !/Tenant Owner or MSP Admin/.test(dataInventorySaveErrorText('forbidden')), 'SI6g the role wording');
const navHtml = renderToStaticMarkup(React.createElement(SspSectionNav, { entries: navOff, activeId: 'identification', onSelect: noop, summary: 's' }));
assert(count(navHtml, 'Not available') === 2 && !navHtml.includes('>Complete<'), 'SI6h the nav shows Not available for 1.3 and 1.4 and no green check for them');

// ---------------------------------------------------------------- render: data inventory
console.log('--- Rendering ---');
const dataProps = (over: Record<string, unknown> = {}) => ({
  framework: 'CMMC_L2',
  data: { status: 'ready' as const, record: blank(), saving: false, saveError: null },
  editable: true, registry, registryStatus: 'ready' as const, boundaryTools: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
  section: undefined, onChange: noop, onReload: noop, onRetryRegistry: noop, onOpenRegister: noop, ...over,
});
const diHtml = (over?: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SspDataInventorySection, dataProps(over) as never));
const di = diHtml();
assert(di.includes('select at least one CUI category') && di.includes('Add CUI categories') && di.includes('type="radio"'), 'SI7 a Level 2 program with no category shows the message, the picker toggle and the FCI radios');
assert(di.includes('target="_blank"') && di.includes('rel="noreferrer noopener"') && di.includes('referrerPolicy="no-referrer"') || di.includes('referrerpolicy="no-referrer"'), 'SI7b the registry link opens only on click in a new tab with no referrer');
assert(di.includes(`href="${categoryLink(registry)}"`) && di.includes('opens in a new tab and leaves this app'), 'SI7c the link goes to the registry category list page and says so');
assert(di.includes(registryNote(registry._meta)) && !di.includes(SSP_INVENTORY_TEXT.unverified), 'SI7d the as-of note shows and a verified list carries no warning');
assert(diHtml({ registry: { ...registry, _meta: { ...registry._meta, verified: false } } }).includes(SSP_INVENTORY_TEXT.unverified), 'SI7e an unverified list says so');
const ro = diHtml({ editable: false, data: { status: 'ready', record: withCti([role('a')]), saving: false, saveError: null } });
assert(!ro.includes('Add CUI categories') && !ro.includes('Remove category') && count(ro, 'disabled=""') >= 5, 'SI7f read-only: no picker, no remove button, every input disabled');
const st = diHtml({ editable: false, data: { status: 'stale', record: blank(), saving: false, saveError: null } });
assert(st.includes('role="alert"') && st.includes('Reload the server copy') && st.includes(SSP_INVENTORY_TEXT.stale), 'SI7g a stale record shows the alert with the reload button');
const uns = diHtml({ editable: false, data: { status: 'unsupported', record: blank(), saving: false, saveError: null } });
assert(uns.includes('server-backed') && !uns.includes('type="radio"') && !uns.includes('Add CUI categories'), 'SI7h a browser-only organization sees the server-backed notice and no form');
assert(diHtml({ data: { status: 'no_program', record: blank(), saving: false, saveError: null } }).includes('Open a program'), 'SI7i no program: say so');
assert(diHtml({ data: { status: 'ready', record: blank(), saving: false, saveError: 'archived' } }).includes('archived'), 'SI7j a save error shows its fixed text');
const filled = diHtml({ data: { status: 'ready', record: { ...withCti([role('a', true, false, true)]), handlesFci: true }, saving: true, saveError: null } });
assert(filled.includes('Controlled Technical Information') && filled.includes('Specified') && filled.includes('Saving…') && filled.includes('View on NARA'), 'SI8 a selected category shows its registry name, marker, link and the saving line');
assert(filled.includes('aria-label="Alpha stores CTI"') && filled.includes('aria-label="Beta transmits CTI"') && filled.includes('aria-label="Remove CTI"'), 'SI8b the tool matrix and the remove button are labelled by tool, role and category id');
assert(filled.includes('<caption class="sr-only">Tools for CTI</caption>') && (filled.match(/checked=""/g) ?? []).length >= 3, 'SI8c the matrix has a caption and the saved roles are ticked');
assert(diHtml({ data: { status: 'ready', record: withCti(), saving: false, saveError: null } }).includes(SSP_INVENTORY_TEXT.noTools), 'SI8d a category with no tool says to assign one');
assert(diHtml({ boundaryTools: [], data: { status: 'ready', record: withCti(), saving: false, saveError: null } }).includes('Open Tools &amp; Services'), 'SI8e no boundary tool: link to the register');
assert(diHtml({ data: { status: 'ready', record: { ...blank(), categories: [{ categoryId: 'NOPE', tools: [] }] }, saving: false, saveError: null } }).includes(SSP_INVENTORY_TEXT.notInRegistry), 'SI8f an id the registry does not list is flagged');
assert(!diHtml({ registry: null, registryStatus: 'error', data: { status: 'ready', record: withCti(), saving: false, saveError: null } }).includes(SSP_INVENTORY_TEXT.notInRegistry) && diHtml({ registry: null, registryStatus: 'error' }).includes(SSP_INVENTORY_TEXT.registryFailed), 'SI8g with the registry list down the ids are shown without a "not in registry" claim, and it says why');
assert(!diHtml({ framework: 'CMMC_L1', data: { status: 'ready', record: { ...blank(), handlesFci: false }, saving: false, saveError: null } }).includes('select at least one') && diHtml({ framework: 'CMMC_L1', data: { status: 'ready', record: { ...blank(), handlesFci: false }, saving: false, saveError: null } }).includes(SSP_INVENTORY_TEXT.l1FciNo), 'SI8h Level 1: the FCI No hint and no CUI requirement');

const sdProps = (over: Record<string, unknown> = {}) => ({ status: 'ready' as const, snapshot: snap, section: undefined, onOpenRegister: noop, onRetry: noop, ...over });
const sdHtml = (over?: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SspSystemDetailsSection, sdProps(over) as never));
const sd = sdHtml({ status: 'unsupported', snapshot: off });
assert(sd.includes('server-backed') && !sd.includes('<table'), 'SI9 a browser-only organization sees the notice and no table');
const sdr = sdHtml();
assert(sdr.includes('<table') && sdr.includes('1.3.1 Number of end users and privileged users') && sdr.includes('Alpha') && !sdr.includes('Gamma') && sdr.includes('scope="col"') && sdr.includes('Open Tools &amp; Services'), 'SI9b the ready table lists the in-scope tools with headers and the register link');
assert(sdr.includes('text-amber-300">Not recorded<') && count(sdr, 'text-amber-300">Not recorded<') === 3, 'SI9c each missing value is flagged in text and colour', count(sdr, 'text-amber-300">Not recorded<'));
assert(sdHtml({ snapshot: noTools }).includes('boundary yet. Add them in Tools &amp; Services.') && sdHtml({ status: 'loading', snapshot: off }).includes('role="status"') && sdHtml({ status: 'error', snapshot: off }).includes('role="alert"') && sdHtml({ status: 'error', snapshot: off }).includes('Try again'), 'SI9d empty, loading and error states');

// ---------------------------------------------------------------- source pins
console.log('--- Source pins ---');
const dataSrc = read('src/components/ssp/SspDataInventorySection.tsx');
const sdSrc = read('src/components/ssp/SspSystemDetailsSection.tsx');
const viewSrc = read('src/data/ssp/sspInventoryView.ts');
const builderSrc = read('src/components/ssp/SSPBuilder.tsx');
const modalSrc = read('src/components/reports/ArtifactExportModal.tsx');
const lazySrc = read('src/data/cui/cuiRegistryLazy.ts');
const navSrc = read('src/components/ssp/SspSectionNav.tsx');
const bViewSrc = read('src/data/ssp/sspBuilderView.ts');
assert(!dataSrc.includes('fetch(') && !sdSrc.includes('fetch(') && !dataSrc.includes('prefetch') && !dataSrc.includes('rel="preload"'), 'SI10 the data inventory section fetches nothing and prefetches nothing');
assert(count(dataSrc, 'target="_blank"') === 1 && count(dataSrc, 'rel="noreferrer noopener"') === 1 && count(dataSrc, '<a ') === 1, 'SI10b every registry link is one anchor with target blank and noreferrer noopener');
assert(builderSrc.includes('{def.signable && (') && count(builderSrc, "setActiveTab('tools')") === 2, 'SI10c the builder signs off only signable sections and links to Tools & Services from both sections');
assert(builderSrc.includes('useSspInventory({ enabled: true })') && builderSrc.includes('inventory: inv.completenessInput') && builderSrc.includes('navEntriesView(completeness, reviews, { inventoryStatus: inv.status })'), 'SI10d the builder feeds the register into the completeness and the nav');
assert(builderSrc.includes('onChange={(r) => dataInv.save(r)}') && builderSrc.includes("editable={canEdit && dataInv.status === 'ready' && !archived}"), 'SI10e 1.4 autosaves through the hook and is editable only for a writer on an open program with the server copy loaded');
assert(builderSrc.includes('SYSTEM DETAILS (USERS):') && builderSrc.includes('INFORMATION TYPES: ') && builderSrc.indexOf('SYSTEM DETAILS (USERS):') > builderSrc.indexOf('RESPONSIBLE ROLES:') && builderSrc.indexOf('SYSTEM DETAILS (USERS):') < builderSrc.indexOf('CLOUD SERVICE PROVIDERS: '), 'SI10f the plain-text copy has 1.3 and 1.4 after the roles');
assert(builderSrc.includes('exportAssessmentMarkdown(profileHook.profile, inv.status') && builderSrc.includes('1.3 System Details') && builderSrc.includes('1.3.1 Number of End Users and Privileged Users') && builderSrc.includes('1.4 Information Types (FCI and CUI)'), 'SI10g the Markdown download and the document view carry 1.3, 1.3.1 and 1.4');
assert(builderSrc.includes('systemDetailsRows(inv.snapshot)') && builderSrc.includes('dataInventoryTableRows(inv.snapshot)') && builderSrc.includes('DATA_INVENTORY_HEADERS') && !builderSrc.includes('categoryLink'), 'SI10h the document view takes its rows from the shared module and prints no link');
assert(modalSrc.includes("useSspInventory({ enabled: isOpen && selectedDocType === 'NIST_SP_800_18_SSP' })") && modalSrc.includes('delete next.sspInventory;') && modalSrc.includes('{ ...next, sspInventory: inventorySnapshot }'), 'SI10i the export modal loads the register for the SSP only and carries the snapshot like the profile (deleted when none)');
assert(modalSrc.includes('inventory: sspInventory.completenessInput }') && modalSrc.includes('Tools and data inventory: ') && modalSrc.includes('could not be loaded, so sections 1.3 and 1.4 say not available.'), 'SI10j the export gaps include the inventory and the readiness line says what is loaded');
const readiness = modalSrc.slice(modalSrc.indexOf('data-testid="export-readiness"'), modalSrc.indexOf('{/* Modal Bottom Action Footer */}'));
assert(readiness.length > 0 && !readiness.includes('sspInventory'), 'SI10k the readiness checklist region is untouched');
assert(navSrc.includes('!e.available') && navSrc.includes('e.unavailableText') && bViewSrc.includes('signable ?') && !/from '\.\.\/\.\.\/(services|context)\//.test(bViewSrc) && !bViewSrc.includes("from 'react'"), 'SI10l the nav shows the unavailable text, the view module signs off only signable sections and stays pure');
const loadAt = lazySrc.indexOf('loading ??=');
const resetAt = lazySrc.indexOf('loading = null');
assert(loadAt >= 0 && resetAt > loadAt && lazySrc.slice(loadAt, resetAt).includes('(err: unknown)') && lazySrc.includes('throw err'), 'SI11 a failed registry load clears the cached promise and still rejects, so a retry can succeed');
assert(!/\bfrom '\.\.\/\.\.\/(services|context)\//.test(viewSrc) && !viewSrc.includes("from 'react'") && !viewSrc.includes('fetch('), 'SI11b the view module is pure');
for (const [name, text] of [['SspDataInventorySection.tsx', dataSrc], ['SspSystemDetailsSection.tsx', sdSrc], ['sspInventoryView.ts', viewSrc], ['cuiRegistryLazy.ts', lazySrc]] as const) {
  assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(text), `SI12 ${name} logs nothing, touches no browser storage, uses no raw HTML and no alert()`);
}
assert(!/Tenant Owner or MSP Admin/.test(dataSrc + sdSrc + viewSrc), 'SI12b the role wording');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
