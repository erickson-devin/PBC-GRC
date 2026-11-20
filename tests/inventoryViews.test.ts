/**
 * #239 / #243 / #248 / #249: the client logic of the Tools and Services register. The register view (filters, order, boundary, evidence status), the
 * survey suggestions, the cost and renewal roll-ups, the CSV, the SSP 1.3 / 1.4 rows, the completeness items and their export gaps, the compiled SSP
 * and the Markdown with and without inventory data, and the privacy of the hooks (React state only: no browser storage, no console).
 * Pure test: no server, no browser.
 */
import fs from 'fs';
import path from 'path';
import { filterTools, sortForRegister, moveInOrder, boundaryTools, controlCountsByTool, hasMissingUserCounts, toolsMissingUserCounts, toolEvidenceStatus } from '../src/data/inventory/toolRegisterView';
import { seedCandidatesFromStackProfile, SURVEY_SEED_SKIP } from '../src/data/inventory/stackSeed';
import { rollupCosts, rollupByProgram, upcomingRenewals, costVisible } from '../src/data/inventory/costRollup';
import { toolRegisterCsv, vendorRegisterCsv, centsToDollars } from '../src/data/reports/inventoryRegisterCsv';
import {
  DATA_INVENTORY_HEADERS,
  SYSTEM_DETAILS_HEADERS,
  buildSspInventoryCompletenessInput,
  buildSspInventorySnapshot,
  dataInventorySubsection,
  inventoryCompletenessItems,
  sspInventoryMarkdown,
  systemDetailsSubsections,
  type SspInventoryCompletenessInput,
  type SspInventorySnapshot,
} from '../src/data/inventory/sspInventory';
import { computeSspCompleteness, sspCompletenessFromReport } from '../src/data/ssp/sspCompleteness';
import { SSP_SECTIONS } from '../src/data/ssp/sspSections';
import { getExportGaps } from '../src/data/reports/exportReadiness';
import { compileNistSSP } from '../src/data/reports/documentCompilers';
import { buildSspMarkdown } from '../src/services/storageService';
import { stackValueLabel } from '../src/data/stackDraftView';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import type { InventoryTool, InventoryVendor, ToolControlLink, DataInventoryRecord } from '../src/types/inventory';
import type { CuiRegistry } from '../src/data/cui/cuiRegistry';
import type { ReportMetadata } from '../src/types/report';
import type { AssessmentState } from '../src/types/cmmc';
import type { EnclaveStackProfile } from '../src/types/tenant';

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

const tool = (over: Partial<InventoryTool> & Pick<InventoryTool, 'id' | 'name'>): InventoryTool => ({
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
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  updatedBy: null,
  ...over,
});
const ids = (ts: { id: string }[]): string => ts.map((t) => t.id).join();

const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data/cui/cuiRegistry.json'), 'utf8')) as CuiRegistry;
const ctiCat = registry.categories.find((c) => c.id === 'CTI')!;

console.log('--- Register view ---');
const a = tool({ id: 'a', name: 'Falcon', vendorName: 'Falcon Corp', mission: 'Endpoint detection', deployment: 'ON_PREM' });
const b = tool({ id: 'b', name: 'Okta', deployment: 'CLOUD', mission: 'Single sign-on' });
const c = tool({ id: 'c', name: 'Managed SOC', deployment: 'ESP' });
const d = tool({ id: 'd', name: 'Whiteboard' });
const all4 = [a, b, c, d];
assert(filterTools(all4, 'ALL').length === 4 && ids(filterTools(all4, 'ON_PREM')) === 'a' && ids(filterTools(all4, 'CLOUD')) === 'b' && ids(filterTools(all4, 'ESP')) === 'c', 'V1 the filters All, On-prem, Cloud and Service providers; a tool with no deployment shows under All only');
assert(ids(filterTools(all4, 'ALL', 'FAL')) === 'a' && ids(filterTools([tool({ id: 'x', name: 'X', vendorName: 'Falcon Corp' })], 'ALL', 'fal')) === 'x' && ids(filterTools(all4, 'ALL', 'sign-on')) === 'b' && ids(filterTools(all4, 'CLOUD', 'fal')) === '', 'V1b the search is case-insensitive on name, vendor and mission, and combines with the filter');
assert(ids(filterTools(all4, 'ALL', '   ')) === 'a,b,c,d', 'V1c a blank search keeps every tool');
const ranked = [tool({ id: 'z', name: 'Zed' }), tool({ id: 'r2', name: 'Two', recoveryRank: 2 }), tool({ id: 'm', name: 'alpha' }), tool({ id: 'r1', name: 'One', recoveryRank: 1 })];
const sortedIds = ids(sortForRegister(ranked));
assert(sortedIds === 'r1,r2,m,z' && ids(ranked) === 'z,r2,m,r1', 'V1d the register lists the recovery order first, then the others by name, without changing its input', sortedIds);
assert(JSON.stringify(moveInOrder(['a', 'b', 'c'], 'c', 'up')) === '["a","c","b"]' && JSON.stringify(moveInOrder(['a', 'b', 'c'], 'a', 'down')) === '["b","a","c"]', 'V2 moveInOrder swaps with the neighbour');
const same = ['a', 'b', 'c'];
assert(JSON.stringify(moveInOrder(same, 'a', 'up')) === '["a","b","c"]' && JSON.stringify(moveInOrder(same, 'c', 'down')) === '["a","b","c"]' && JSON.stringify(moveInOrder(same, 'z', 'up')) === '["a","b","c"]' && moveInOrder(same, 'a', 'up') !== same, 'V2b it is unchanged at either end and for an unknown id, and always a new array');
assert(ids(boundaryTools(all4, { declared: false, toolIds: [] })) === 'a,b,c,d' && ids(boundaryTools(all4, { declared: true, toolIds: ['b', 'zz'] })) === 'b' && boundaryTools(all4, { declared: true, toolIds: [] }).length === 0, 'V2c an undeclared program uses the whole register; a declared one only its tools (a gone id counts for nothing)');
const links: ToolControlLink[] = [{ toolId: 'a', controlId: 'c1', evidenceSource: true }, { toolId: 'a', controlId: 'c2', evidenceSource: false }, { toolId: 'b', controlId: 'c1', evidenceSource: false }];
assert(JSON.stringify(controlCountsByTool(links)) === '{"a":2,"b":1}' && JSON.stringify(controlCountsByTool([])) === '{}', 'V2d controls linked per tool');
assert(hasMissingUserCounts(tool({ id: 'u1', name: 'U', assetCategory: 'CUI_ASSET', endUsers: 4, privilegedUsers: null })) && !hasMissingUserCounts(tool({ id: 'u2', name: 'U', assetCategory: 'CUI_ASSET', endUsers: 4, privilegedUsers: 0 })) && !hasMissingUserCounts(tool({ id: 'u3', name: 'U', assetCategory: 'OUT_OF_SCOPE' })), 'V2e a row is flagged when either user count is missing; zero is a count; out of scope is never flagged');
assert(ids(toolsMissingUserCounts([a, tool({ id: 'ok', name: 'Ok', endUsers: 1, privilegedUsers: 1 })])) === 'a', 'V2f the rows missing counts');

console.log('\n--- Evidence status ---');
const ctl = [{ id: 'c1', title: 'Control one', status: 'IMPLEMENTED' }, { id: 'c2', title: 'Control two', status: 'IN_PROGRESS' }];
const ev = toolEvidenceStatus([{ toolId: 'A', controlId: 'c1', evidenceSource: true }, { toolId: 'A', controlId: 'c2', evidenceSource: false }], ctl, [{ controlId: 'c1' }, { controlId: 'c1' }, { controlId: 'c9' }]);
assert(ev.length === 1 && ev[0].controlId === 'c1' && ev[0].evidenceCount === 2 && ev[0].controlTitle === 'Control one' && ev[0].status === 'IMPLEMENTED' && ev[0].evidenceSource === true, 'V6 only the links marked as an evidence source, with the control status and evidence count', ev);
const evAll = toolEvidenceStatus([{ toolId: 'A', controlId: 'c1', evidenceSource: true }, { toolId: 'A', controlId: 'c2', evidenceSource: false }], ctl, [{ controlId: 'c1' }], { includeNonSource: true });
assert(evAll.length === 2 && evAll[1].evidenceCount === 0, 'V6b includeNonSource adds the others, with no evidence counted as 0');
const evTool = toolEvidenceStatus([{ toolId: 'A', controlId: 'c1', evidenceSource: true }, { toolId: 'B', controlId: 'c2', evidenceSource: true }], ctl, [], { toolId: 'B' });
assert(evTool.length === 1 && evTool[0].toolId === 'B' && toolEvidenceStatus([{ toolId: 'A', controlId: 'gone', evidenceSource: true }], ctl, [])[0].status === 'UNKNOWN', 'V6c one tool only; a control that is not in the list is UNKNOWN, never invented');

console.log('\n--- Survey suggestions ---');
const profile = { identityProvider: 'OKTA', edrSolution: 'CUSTOM', customLabels: { edrSolution: 'Falcon X' }, infrastructure: 'HYBRID_CLOUD', mdmSolution: 'INTUNE', siemSolution: 'LOCAL_AUDITD' } as EnclaveStackProfile;
const cands = seedCandidatesFromStackProfile(profile, [{ name: 'intune', seedKey: null }]);
assert(
  JSON.stringify(cands.map((x) => x.name)) === JSON.stringify([stackValueLabel('identityProvider', 'OKTA'), 'Falcon X', stackValueLabel('siemSolution', 'LOCAL_AUDITD')]) && cands.map((x) => x.name).join() === 'Okta,Falcon X,Syslog / Auditd',
  'V3 the suggestions are named as the survey names them; a duplicate (ignoring case) and an approach (Hybrid Cloud) are left out',
  cands.map((x) => x.name)
);
assert(cands.map((x) => x.seedKey).join() === 'survey:identityProvider,survey:edrSolution,survey:siemSolution' && cands[1].deployment === null && cands[0].deployment === 'CLOUD' && cands[2].deployment === 'ON_PREM' && cands.every((x) => x.assetCategory === 'SECURITY_PROTECTION'), 'V3a seed keys are survey:<step>, a custom answer has no deployment, the others the usual one');
assert(seedCandidatesFromStackProfile(undefined, []).length === 0, 'V3b no survey, no suggestions');
assert(seedCandidatesFromStackProfile(profile, [{ name: 'Okta Workforce', seedKey: 'survey:identityProvider' }]).every((x) => x.seedKey !== 'survey:identityProvider'), 'V3c a tool already added from a step is never suggested again, whatever it was renamed to');
const skipProfile = { identityProvider: 'ACTIVE_DIRECTORY', edrSolution: 'GENERIC_AV', infrastructure: 'HYBRID_CLOUD', mdmSolution: 'MANUAL_GPO', siemSolution: 'ELASTIC' } as EnclaveStackProfile;
assert(seedCandidatesFromStackProfile(skipProfile, []).map((x) => x.seedKey).join() === 'survey:identityProvider,survey:siemSolution' && SURVEY_SEED_SKIP.infrastructure?.includes('HYBRID_CLOUD') === true && SURVEY_SEED_SKIP.mdmSolution?.includes('MANUAL_GPO') === true && SURVEY_SEED_SKIP.edrSolution?.includes('GENERIC_AV') === true, 'V3d Hybrid Cloud, Manual GPO and Commercial AV are not tools: skipped');
assert(new Set(seedCandidatesFromStackProfile({ ...profile, identityProvider: 'CUSTOM', customLabels: { identityProvider: 'same', edrSolution: 'Same' } } as EnclaveStackProfile, []).map((x) => x.name.toLowerCase())).size === seedCandidatesFromStackProfile({ ...profile, identityProvider: 'CUSTOM', customLabels: { identityProvider: 'same', edrSolution: 'Same' } } as EnclaveStackProfile, []).length, 'V3e two steps with the same name are suggested once');

console.log('\n--- CSV ---');
const evil = tool({ id: 'e', name: '=HYPERLINK("x")', mission: '+cmd', vendorName: '@v', deployment: 'CLOUD', assetCategory: 'CUI_ASSET', endUsers: 10, privilegedUsers: 2, annualCostCents: 1250000, renewalDate: '2027-03-31' });
const csvNo = toolRegisterCsv([evil], { includeCost: false });
const csvLines = csvNo.split('\r\n');
assert(csvLines[0].startsWith('"Name","Vendor"') && !csvLines[0].includes('Annual cost') && csvLines[1].startsWith(`"'=HYPERLINK(""x"")","'@v","'+cmd"`) && csvLines.length === 3 && csvLines[2] === '' && !csvNo.replace(/\r\n/g, '').includes('\n') && !csvNo.includes('12500'), 'V4 without cost: no cost column or value; a formula in a name, vendor or mission gets an apostrophe; every line ends CRLF');
const csvYes = toolRegisterCsv([evil, tool({ id: 'n', name: 'No cost', annualCostCents: null }), tool({ id: 'o', name: 'Absent cost' })], { includeCost: true, controlCounts: { e: 3 } });
const yesRows = csvYes.split('\r\n');
assert(yesRows[0].endsWith('"Annual cost (USD)"') && yesRows[0].includes('"Controls linked"') && yesRows[1].endsWith('"12500.00"') && yesRows[1].includes('"3","12500.00"') && yesRows[2].endsWith('""') && yesRows[3].endsWith('""'), 'V4b with cost: the last header is Annual cost (USD), whole cents print as dollars, a blank or absent cost is blank (never 0.00)', yesRows.slice(0, 2));
assert(centsToDollars(1250000) === '12500.00' && centsToDollars(5) === '0.05' && centsToDollars(100) === '1.00' && centsToDollars(1999) === '19.99', 'V4c cents print as dollars with two digits');
const vendorLookup = toolRegisterCsv([tool({ id: 'v', name: 'T', vendorName: 'Typed', vendorId: 'v1' })], { includeCost: false, vendorsById: { v1: 'Register Vendor' } });
assert(vendorLookup.includes('"Register Vendor"') && !vendorLookup.includes('Typed'), 'V4d a tool linked to a vendor record shows the record name');
const vendor: InventoryVendor = {
  id: 'v1', tenantId: 't1', name: '=cmd', kind: 'CSP', services: 'Hosting', contractStart: '2026-01-01', contractEnd: '2027-01-01', renewalDate: null, fedrampStatus: 'MODERATE', fedrampReference: 'REF', fedrampVerifiedOn: '2026-10-01',
  crmOnFile: true, lastReviewDate: null, notes: 'a private note', createdAt: 'x', updatedAt: 'x', updatedBy: null,
};
const vcsv = vendorRegisterCsv([vendor], { v1: ['Falcon', '=Odd'] });
assert(vcsv.split('\r\n')[1].startsWith(`"'=cmd","CSP"`) && vcsv.includes('"Falcon; =Odd"') && !vcsv.includes('private note') && vcsv.endsWith('\r\n'), 'V4e the vendor CSV guards formulas, lists the tools of each vendor and leaves the notes out');
const csvSrc = fs.readFileSync(path.join(process.cwd(), 'src/data/reports/inventoryRegisterCsv.ts'), 'utf8');
assert(csvSrc.includes("from './csv'") && !csvSrc.includes(`replace(/"/g, '""')`), 'V4f the register CSV uses csvCell and has no quote escaping of its own');

console.log('\n--- Cost and renewals ---');
const ct = [
  tool({ id: 'A', name: 'A', assetCategory: 'CUI_ASSET', annualCostCents: 100000 }),
  tool({ id: 'B', name: 'B', assetCategory: 'SECURITY_PROTECTION', annualCostCents: 50000 }),
  tool({ id: 'C', name: 'C', assetCategory: 'CUI_ASSET', annualCostCents: null }),
  tool({ id: 'D', name: 'D', assetCategory: 'OUT_OF_SCOPE', annualCostCents: 2500 }),
  tool({ id: 'E', name: 'E', annualCostCents: 7 }),
];
const roll = rollupCosts(ct);
assert(roll.available && roll.totalCents === 152507 && roll.missingCost === 1 && roll.withCost === 4 && roll.byCategory.CUI_ASSET === 100000 && roll.byCategory.SECURITY_PROTECTION === 50000 && roll.byCategory.OUT_OF_SCOPE === 2500 && roll.byCategory.UNCLASSIFIED === 7 && roll.byCategory.CONTRACTOR_RISK === 0, 'V5 totals in cents, per asset category (no category: UNCLASSIFIED), with and without cost counted', roll);
const byProg = rollupByProgram(ct, [{ programId: 'p1', declared: true, toolIds: ['A', 'C', 'gone'] }, { programId: 'p2', declared: false, toolIds: [] }]);
assert(byProg.p1.totalCents === 100000 && byProg.p1.missingCost === 1 && byProg.p2.totalCents === 152507, 'V5b a declared program counts its tools, an undeclared one the whole register', byProg);
assert(rollupCosts([tool({ id: 'x', name: 'x', annualCostCents: 10 }), tool({ id: 'y', name: 'y', annualCostCents: 20 })]).totalCents === 30 && Number.isInteger(rollupCosts(ct).totalCents), 'V5c integer cents: no floating point drift');
const hidden = rollupCosts([tool({ id: 'h1', name: 'h1', assetCategory: 'CUI_ASSET' }), tool({ id: 'h2', name: 'h2' })]);
assert(!hidden.available && hidden.totalCents === 0 && hidden.missingCost === 0 && hidden.withCost === 0 && !costVisible([tool({ id: 'h', name: 'h' })]) && costVisible([tool({ id: 'k', name: 'k', annualCostCents: null })]) && costVisible([]), 'V5d rows with no cost key (a read role) are "not available", not zero and not missing; a null cost key is a recorded blank');
assert(rollupCosts([tool({ id: 'n', name: 'n', annualCostCents: -5 }), tool({ id: 'f', name: 'f', annualCostCents: 1.5 })]).totalCents === 0, 'V5e a negative or fractional value is never added');
const ren = upcomingRenewals([{ id: 'x', renewalDate: '2026-12-01' }, { id: 'y', renewalDate: '2027-06-01' }, { id: 'z', renewalDate: '2026-11-01' }, { id: 'n', renewalDate: null }, { id: 'bad', renewalDate: '2027-02-30' }, { id: 't', renewalDate: '2026-11-19' }], '2026-11-19', 60);
assert(JSON.stringify(ren) === '[{"id":"t","renewalDate":"2026-11-19","daysLeft":0},{"id":"x","renewalDate":"2026-12-01","daysLeft":12}]', 'V5f renewals within the window, today included, soonest first; passed, far, blank and impossible dates left out', ren);
assert(upcomingRenewals([{ id: 'x', renewalDate: '2027-01-18' }], '2026-11-19', 60).length === 1 && upcomingRenewals([{ id: 'x', renewalDate: '2027-01-19' }], '2026-11-19', 60).length === 0 && upcomingRenewals([{ id: 'x', renewalDate: '2027-01-01' }], 'not a date', 60).length === 0, 'V5g day 60 is in, day 61 is out, and an invalid today gives nothing (the clock is never read)');

console.log('\n--- SSP 1.3 and 1.4 rows ---');
const x = tool({ id: 'x', name: 'Xray', deployment: 'CLOUD', assetCategory: 'CUI_ASSET', endUsers: 10, privilegedUsers: 2 });
const y = tool({ id: 'y', name: 'Yankee', deployment: 'ON_PREM', assetCategory: 'SECURITY_PROTECTION', endUsers: 5 });
const z = tool({ id: 'z', name: 'Zulu', assetCategory: 'OUT_OF_SCOPE', endUsers: 1, privilegedUsers: 1 });
const dataRec: DataInventoryRecord = {
  handlesFci: true,
  categories: [{ categoryId: 'CTI', tools: [{ toolId: 'x', stores: true, processes: false, transmits: false }, { toolId: 'y', stores: false, processes: false, transmits: true }] }, { categoryId: 'GONE-CAT', tools: [] }],
  updatedAt: '2026-11-19T00:00:00.000Z',
  updatedBy: 'u',
};
const snap = buildSspInventorySnapshot({ supported: true, tools: [z, y, x], program: { declared: false, toolIds: [] }, data: dataRec, registry });
assert(snap.supported && snap.tools.map((t) => t.id).join() === 'x,y' && snap.handlesFci === true && snap.registryAsOf === registry._meta.asOf, 'V7a the snapshot lists the boundary tools by name, out of scope left out');
const ctiRow = snap.categories.find((r) => r.id === 'CTI')!;
const goneRow = snap.categories.find((r) => r.id === 'GONE-CAT')!;
assert(ctiRow.name === ctiCat.name && ctiRow.stores.join() === 'Xray' && ctiRow.transmits.join() === 'Yankee' && ctiRow.processes.length === 0 && ctiRow.designation === ctiCat.designation && typeof ctiRow.indexGroup === 'string' && goneRow.name === null && goneRow.designation === null && goneRow.bannerMarking === null, 'V7b registry names and roles by tool name; a category the registry does not list keeps its id and no name');
assert(boundaryOnly(buildSspInventorySnapshot({ supported: true, tools: [x, y], program: { declared: true, toolIds: ['y', 'gone'] }, data: null, registry: null })) === 'y', 'V7c a declared program lists only its tools');
function boundaryOnly(s: SspInventorySnapshot): string {
  return s.tools.map((t) => t.id).join();
}
const sub = systemDetailsSubsections(snap);
const table = sub.find((s) => s.title.startsWith('1.3.1'))!.table!;
assert(sub[0].title === '1.3 System Details' && JSON.stringify(table.headers) === JSON.stringify(SYSTEM_DETAILS_HEADERS) && table.rows.length === 2 && (table.rows[1] as string[])[4] === NOT_RECORDED && (table.rows[0] as string[])[3] === '10' && !JSON.stringify(table.rows).includes('Zulu'), 'V7 1.3.1: the headers, one row per boundary tool, a missing privileged count prints Not recorded, out of scope is absent', table.rows);
const unsupported = buildSspInventorySnapshot({ supported: false, tools: [x], program: null, data: dataRec, registry });
const unsub = systemDetailsSubsections(unsupported);
assert(unsub.length === 1 && unsub[0].items!.some((i) => i.value.includes('server-backed')) && !unsub[0].table && !unsupported.tools.length && !unsupported.categories.length, 'V7d unsupported: a single not available item that names the server-backed requirement, no table');
assert(systemDetailsSubsections(buildSspInventorySnapshot({ supported: true, tools: [], program: null, data: null, registry: null }))[1].content?.includes('No tools') === true, 'V7e an empty boundary says no tools are recorded');
const dsub = dataInventorySubsection(snap, 'CMMC_L2');
const drow = (dsub.table!.rows as string[][]).find((r) => r[0] === ctiCat.name)!;
assert(dsub.items![0].value === 'Yes' && JSON.stringify(dsub.table!.headers) === JSON.stringify(DATA_INVENTORY_HEADERS) && drow[3] === 'Xray' && drow[4] === NOT_RECORDED && drow[5] === 'Yankee' && drow[1] !== NOT_RECORDED, 'V8 1.4: FCI Yes, the category row with its banner marking and the tool in "Stored in" and "Transmitted by"', drow);
const emptyData = buildSspInventorySnapshot({ supported: true, tools: [x], program: null, data: { handlesFci: null, categories: [], updatedAt: null, updatedBy: null }, registry });
assert(dataInventorySubsection(emptyData, 'CMMC_L2').content!.includes('No CUI categories selected') && dataInventorySubsection(emptyData, 'CMMC_L2').content!.includes('Level 2') && !dataInventorySubsection(emptyData, 'SOC_2_TYPE_II').content!.includes('Level 2') && dataInventorySubsection(emptyData, 'CMMC_L2').items![0].value === NOT_RECORDED, 'V8b no categories: the sentence (with the Level 2 requirement only for CMMC L2), an unanswered FCI prints Not recorded');
assert(dataInventorySubsection(unsupported, 'CMMC_L2').items![0].value.includes('server-backed'), 'V8c unsupported 1.4 says not available');

console.log('\n--- Completeness ---');
const inputOf = (over: Partial<SspInventoryCompletenessInput> = {}): SspInventoryCompletenessInput => ({
  supported: true,
  tools: [{ id: 'x', name: 'Xray', assetCategory: 'CUI_ASSET', endUsers: 10, privilegedUsers: 2 }],
  handlesFci: true,
  categories: [{ id: 'CTI', name: 'Controlled Technical Information', toolCount: 1 }],
  ...over,
});
const itemsOf = (framework: string, inv: SspInventoryCompletenessInput) => inventoryCompletenessItems(framework, inv);
const find = (items: ReturnType<typeof itemsOf>, id: string) => items.find((i) => i.id === id);
const l2Cat = itemsOf('CMMC_L2', inputOf({ categories: [] }));
assert(find(l2Cat, 'inventory:cui')?.severity === 'required' && find(l2Cat, 'inventory:cui')?.missing === true && find(itemsOf('CMMC_L2', inputOf()), 'inventory:cui')?.missing === false && find(itemsOf('CMMC_L1', inputOf({ categories: [] })), 'inventory:cui') === undefined && find(itemsOf('NIST_800_53_REV5', inputOf({ categories: [] })), 'inventory:cui')?.severity === 'advisory', 'V9 a CMMC Level 2 program must select at least one CUI category (required); advisory for NIST; not asked of Level 1');
const noSystems = itemsOf('CMMC_L2', inputOf({ categories: [{ id: 'CTI', name: 'Controlled Technical Information', toolCount: 0 }] }));
assert(find(noSystems, 'cui:CTI:systems')?.missing === true && find(noSystems, 'cui:CTI:systems')?.severity === 'required' && find(itemsOf('NIST_800_53_REV5', inputOf({ categories: [{ id: 'CTI', name: null, toolCount: 0 }] })), 'cui:CTI:systems')?.severity === 'advisory', 'V9a a category with no tool is a required gap for Level 2 and advisory for NIST');
const usersMissing = itemsOf('CMMC_L2', inputOf({ tools: [{ id: 'u', name: 'U', assetCategory: 'CUI_ASSET', endUsers: 3, privilegedUsers: null }, { id: 'o', name: 'O', assetCategory: 'OUT_OF_SCOPE', endUsers: null, privilegedUsers: null }, { id: 'n', name: 'N', assetCategory: null, endUsers: 1, privilegedUsers: 1 }] }));
assert(find(usersMissing, 'tool:u:users')?.severity === 'advisory' && find(usersMissing, 'tool:u:users')?.missing === true && find(usersMissing, 'tool:o:users') === undefined && find(usersMissing, 'tool:n:category')?.missing === true && find(usersMissing, 'tool:n:category')?.severity === 'required' && find(itemsOf('SOC_2_TYPE_II', inputOf({ tools: [{ id: 'n', name: 'N', assetCategory: null, endUsers: 1, privilegedUsers: 1 }] })), 'tool:n:category')?.severity === 'advisory', 'V9b missing user counts are advisory in every framework (out of scope exempt); a missing asset category is required for CMMC and advisory elsewhere');
assert(find(itemsOf('CMMC_L2', inputOf({ tools: [] })), 'inventory:tools')?.missing === true && find(itemsOf('CMMC_L2', inputOf({ tools: [{ id: 'z', name: 'Z', assetCategory: 'OUT_OF_SCOPE', endUsers: null, privilegedUsers: null }] })), 'inventory:tools')?.missing === true && find(itemsOf('HIPAA_SECURITY', inputOf({ tools: [] })), 'inventory:tools')?.severity === 'advisory', 'V9c a boundary with no in-scope tool is missing (required except SOC 2 and HIPAA)');
assert(find(itemsOf('CMMC_L1', inputOf({ handlesFci: false })), 'inventory:l1_fci_no')?.severity === 'advisory' && find(itemsOf('CMMC_L1', inputOf()), 'inventory:l1_cui_selected')?.severity === 'advisory' && find(itemsOf('CMMC_L2', inputOf({ handlesFci: false })), 'inventory:l1_fci_no') === undefined && find(itemsOf('CMMC_L2', inputOf({ handlesFci: null })), 'inventory:fci')?.missing === true && find(itemsOf('SOC_2_TYPE_II', inputOf({ handlesFci: null })), 'inventory:fci') === undefined, 'V9d the Level 1 notes are advisory; the FCI answer is asked of CMMC, not of SOC 2');
assert(inventoryCompletenessItems('CMMC_L2', inputOf({ supported: false })).length === 0, 'V9e an unsupported input has no items');
const l2Full = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, inventory: inputOf({ categories: [] }) });
const dataSection = l2Full.sections.find((s) => s.sectionId === 'data_inventory')!;
const detailsSection = l2Full.sections.find((s) => s.sectionId === 'system_details')!;
const requiredMissingItems = dataSection.items.filter((i) => i.severity === 'required' && i.missing).length;
assert(dataSection.available && detailsSection.available && dataSection.requiredMissing === requiredMissingItems && requiredMissingItems >= 1 && dataSection.items.some((i) => i.id === 'inventory:cui' && i.missing), 'V9f with an inventory both sections are available and the section count is the number of required missing items');
const without = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null });
const withoutOthers = without.sections.filter((s) => s.sectionId !== 'system_details' && s.sectionId !== 'data_inventory');
assert(
  without.sections.filter((s) => !s.available).map((s) => s.sectionId).join() === 'system_details,data_inventory' && without.sections.every((s) => (s.available ? true : s.items.length === 0 && s.requiredTotal === 0 && s.requiredMissing === 0 && s.advisoryMissing === 0))
    && without.requiredMissing === withoutOthers.reduce((n, s) => n + s.requiredMissing, 0) && without.advisoryMissing === withoutOthers.reduce((n, s) => n + s.advisoryMissing, 0) && withoutOthers.every((s) => s.available),
  'V9g without an inventory 1.3 and 1.4 are unavailable and the totals are the sum over the other four sections'
);
const unsupportedC = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, inventory: inputOf({ supported: false }) });
assert(unsupportedC.requiredMissing === without.requiredMissing && unsupportedC.sections.filter((s) => !s.available).length === 2, 'V9h an unsupported inventory counts for nothing, like none');
assert(SSP_SECTIONS.filter((s) => !s.signable).map((s) => s.id).join() === 'system_details,data_inventory', 'V9i 1.3 and 1.4 are not signable');
const meta: Partial<ReportMetadata> = { framework: 'CMMC_L2', systemName: 'S', organizationName: 'O', primaryAssessor: 'A', boundaryDescription: 'B', systemOwner: 'Jane', cageCode: 'C', samStatus: 'ACTIVE' };
const gapsNoInv = getExportGaps('NIST_SP_800_18_SSP', meta, { profile: null, framework: 'CMMC_L2' });
const gapsInv = getExportGaps('NIST_SP_800_18_SSP', meta, { profile: null, framework: 'CMMC_L2', inventory: inputOf({ categories: [], tools: [{ id: 'u', name: 'U', assetCategory: 'CUI_ASSET', endUsers: null, privilegedUsers: null }] }) });
const cuiGap = gapsInv.find((g) => g.field === 'inventory:cui');
const usersGap = gapsInv.find((g) => g.field === 'tool:u:users');
assert(!gapsNoInv.some((g) => g.sspSection === 'system_details' || g.sspSection === 'data_inventory') && cuiGap?.sspSection === 'data_inventory' && !cuiGap.advisory && usersGap?.sspSection === 'system_details' && usersGap.advisory === true, 'V9j export gaps: none without an inventory; with one, the missing CUI category stops the export and a missing user count is advisory, each with its section');
const reportInput = sspCompletenessFromReport(meta, null, inputOf());
assert(reportInput.inventory?.supported === true && sspCompletenessFromReport(meta, null).inventory === undefined && !('inventory' in sspCompletenessFromReport(meta, null)), 'V9k the report form carries the inventory only when given');
const builtInput = buildSspInventoryCompletenessInput({ supported: true, tools: [z, y, x], program: { declared: true, toolIds: ['x', 'z'] }, data: dataRec, registry });
assert(builtInput.tools.map((t) => t.id).sort().join() === 'x,z' && builtInput.handlesFci === true && builtInput.categories.find((cat) => cat.id === 'CTI')?.toolCount === 2 && builtInput.categories.find((cat) => cat.id === 'CTI')?.name === ctiCat.name && builtInput.categories.find((cat) => cat.id === 'GONE-CAT')?.toolCount === 0 && !buildSspInventoryCompletenessInput({ supported: false, tools: [x], program: null, data: dataRec, registry }).supported, 'V9l the completeness input from the sources: boundary tools (out of scope included, as exempt), tool counts per category');

console.log('\n--- Compiled SSP and Markdown ---');
const fullMeta: ReportMetadata = {
  systemName: 'Sys', organizationName: 'Org', cageCode: 'C', samStatus: 'ACTIVE', systemOwner: 'Jane', primaryAssessor: 'A', boundaryDescription: 'B', systemEnvironment: 'E', operationalStatus: 'Operational',
  cloudServiceProviders: 'CSP', classificationLevel: 'UNCLASSIFIED // CUI', assessmentDate: '2026-11-19', version: '1.0.0', framework: 'CMMC_L2',
};
const docPlain = compileNistSSP(fullMeta, [], {}, []);
const docUndefined = compileNistSSP({ ...fullMeta, sspInventory: undefined }, [], {}, []);
const subTitles = (doc: ReturnType<typeof compileNistSSP>) => doc.sections[0].subsections!.map((s) => s.title);
assert(JSON.stringify(docPlain.sections) === JSON.stringify(docUndefined.sections) && JSON.stringify(docPlain.summaryMetrics) === JSON.stringify(docUndefined.summaryMetrics) && subTitles(docPlain).join('|') === '1.1 System Identification & Categorization|1.2 Responsible Organization & Roles', 'V10 without inventory data the compiled SSP is byte-identical and prints no 1.3 or 1.4');
const docInv = compileNistSSP({ ...fullMeta, sspInventory: snap }, [], {}, []);
assert(subTitles(docInv).join('|') === '1.1 System Identification & Categorization|1.2 Responsible Organization & Roles|1.3 System Details|1.3.1 Number of End Users and Privileged Users|1.4 Information Types (FCI and CUI)', 'V10b with inventory data 1.3, 1.3.1 and 1.4 follow the roles', subTitles(docInv));
assert(JSON.stringify(docInv.sections.slice(1)) === JSON.stringify(docPlain.sections.slice(1)), 'V10c nothing else in the SSP changes');
const docUns = compileNistSSP({ ...fullMeta, sspInventory: unsupported }, [], {}, []);
assert(subTitles(docUns).join('|').includes('1.3 System Details') && JSON.stringify(docUns).includes('server-backed'), 'V10d an unsupported snapshot prints a not available line');
const state = { version: '2.0.0', tenantId: 't1', sspMetadata: { systemName: 'Sys', organizationName: 'Org', systemOwner: 'Jane', authorName: 'A', cageCode: 'C', samStatus: 'ACTIVE', assessmentDate: '2026-11-19', systemBoundaryScope: 'B', systemEnvironment: 'E', cloudServiceProviders: 'CSP', version: '1.0.0' }, controls: {}, evidenceIndex: [], lastSaved: 'x' } as unknown as AssessmentState;
const mdPlain = buildSspMarkdown(state, [], 'CMMC_L2', null);
assert(mdPlain === buildSspMarkdown(state, [], 'CMMC_L2', null, undefined) && mdPlain === buildSspMarkdown(state, [], 'CMMC_L2', null, null) && !mdPlain.includes('1.3 System Details') && !mdPlain.includes('1.4 Information Types'), 'V10e without inventory data the Markdown SSP is byte-identical');
const mdInv = buildSspMarkdown(state, [], 'CMMC_L2', null, snap);
const i12 = mdInv.indexOf('## 1.2 Responsible'), i13 = mdInv.indexOf('## 1.3 System Details'), i131 = mdInv.indexOf('### 1.3.1 Number of End Users'), i14 = mdInv.indexOf('## 1.4 Information Types'), i21 = mdInv.indexOf('## 2.1 System Scope');
assert(i12 > 0 && i12 < i13 && i13 < i131 && i131 < i14 && i14 < i21 && mdInv.includes('| Xray | Cloud |') && mdInv.includes(ctiCat.name) && mdInv.replace(sspInventoryMarkdown(snap, 'CMMC_L2'), '') === mdPlain, 'V10f with inventory data the Markdown places 1.3, 1.3.1 and 1.4 after 1.2 and before 2.1, and nothing else changes');
const pipe = buildSspInventorySnapshot({ supported: true, tools: [tool({ id: 'p', name: 'A | B\nC', assetCategory: 'CUI_ASSET' })], program: null, data: null, registry: null });
assert(sspInventoryMarkdown(pipe, 'CMMC_L2').includes('| A \\| B C |') && sspInventoryMarkdown(unsupported, 'CMMC_L2').includes('server-backed'), 'V10g a pipe or line break in a name cannot break the Markdown table; unsupported says not available');

console.log('\n--- Privacy of the hooks and modules ---');
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const hookFiles = ['src/hooks/useToolRegister.ts', 'src/hooks/useVendorRegister.ts', 'src/hooks/useProgramInventory.ts', 'src/hooks/useDataInventory.ts', 'src/hooks/useToolMemberships.ts', 'src/hooks/useSspInventory.ts', 'src/services/inventoryService.ts'];
for (const f of hookFiles) assert(!/localStorage|sessionStorage|indexedDB|\.setItem\(|console\./.test(read(f)), `V11 ${f} uses no browser storage and no console`);
const pureFiles = ['src/data/inventory/toolRegisterView.ts', 'src/data/inventory/stackSeed.ts', 'src/data/inventory/costRollup.ts', 'src/data/inventory/sspInventory.ts', 'src/data/reports/inventoryRegisterCsv.ts'];
for (const f of pureFiles) assert(!/localStorage|sessionStorage|console\.|fetch\(|Date\.now|new Date\(\)|dangerouslySetInnerHTML/.test(read(f)), `V11b ${f} is pure: no storage, console, network, clock or raw HTML`);
const apiSrc = read('src/services/apiClient.ts');
assert(!/inventory[^\n]*console\./i.test(apiSrc), 'V11c the register calls in the api client never log');
assert(/subscribeInventory/.test(read('src/hooks/useToolRegister.ts')) && /status: 'unsupported'|'unsupported'/.test(read('src/hooks/useToolRegister.ts')) && /Boolean\(currentTenant\.serverBacked\)/.test(read('src/hooks/useToolRegister.ts')) && /Boolean\(currentTenant\.serverBacked\)/.test(read('src/hooks/useVendorRegister.ts')), 'V12 the register hooks are unsupported for a browser-only tenant and follow each other\'s changes');
assert(/showCost: canEdit/.test(read('src/hooks/useToolRegister.ts')), 'V12b the cost is shown to the write roles only');
assert(/'stale'/.test(read('src/hooks/useDataInventory.ts')) && /createStampedSaveChain/.test(read('src/hooks/useDataInventory.ts')) && /DATA_INVENTORY_SAVE_DELAY_MS = 600/.test(read('src/hooks/useDataInventory.ts')), 'V12c the data inventory saves debounced with the last stamp and goes stale on a 409');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
