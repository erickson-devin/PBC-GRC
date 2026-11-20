import fs from 'fs';
import path from 'path';
import catalogJson from '../src/data/inventory/toolCatalog.json';
import { MAX_TYPICAL_CONTROLS, catalogEntryToInput, searchCatalog, suggestedControlsForProgram, validateToolCatalog, type ToolCatalog } from '../src/data/inventory/toolCatalog';
import { TOOL_DEPLOYMENTS, TOOL_TYPES } from '../src/types/inventory';
import { isCmmcAssetCategory } from '../src/data/telemetry/assetScope';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';

/**
 * Quick add catalog (#247): src/data/inventory/toolCatalog.json is plain factual data we wrote. Pure suite, no server.
 * Pins the schema, the quality rules (no versions, prices, links, taglines or authorization claims), the controls it
 * names, the lazy loading and the helpers.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const c = catalogJson as unknown as ToolCatalog;
const raw = JSON.stringify(catalogJson);
// The quality rules cover the entries; the trademark notice is pinned separately and itself says there is no pricing or authorization data.
const body = JSON.stringify(c.tools);

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

const l2 = getFrameworkControls('CMMC_L2').map((x) => x.id);
const l2Set = new Set(l2);

console.log('--- TC1: schema ---');
assert(l2.length >= 100 && l2.includes('AC.L2-3.1.5'), 'the CMMC_L2 control ids were loaded', l2.length);
const problems = validateToolCatalog(catalogJson, l2Set);
assert(problems.length === 0, 'validateToolCatalog accepts the shipped catalog', problems.slice(0, 5));

console.log('\n--- TC2: ids and names ---');
assert(c.tools.length >= 120 && c.tools.length <= 170, 'between 120 and 170 entries', c.tools.length);
assert(new Set(c.tools.map((t) => t.id)).size === c.tools.length, 'ids are unique');
assert(c.tools.every((t) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(t.id)), 'ids are lowercase slugs');
assert(new Set(c.tools.map((t) => t.name.toLowerCase())).size === c.tools.length, 'names are unique ignoring case');
assert(c.tools.every((t) => t.name.length > 0 && t.name.length <= 80), 'names are 1 to 80 characters');
assert(c.tools.every((t) => t.name === t.name.trim()), 'names have no stray spaces');

console.log('\n--- TC3: enums ---');
assert(c.tools.every((t) => (TOOL_TYPES as readonly string[]).includes(t.toolType)), 'every toolType is in TOOL_TYPES');
assert(c.tools.every((t) => t.deployments.length > 0 && t.deployments.every((d) => (TOOL_DEPLOYMENTS as readonly string[]).includes(d))), 'deployments are non-empty and allowed');
assert(c.tools.every((t) => new Set(t.deployments).size === t.deployments.length), 'a deployment is not listed twice');
assert(c.tools.every((t) => isCmmcAssetCategory(t.defaultAssetCategory)), 'every defaultAssetCategory is a CMMC asset category');
assert(c.tools.every((t) => t.defaultAssetCategory !== 'OUT_OF_SCOPE'), 'no entry defaults to Out-of-Scope');
assert(c.tools.filter((t) => t.toolType === 'MANAGED_SERVICE').every((t) => t.vendor === '' && t.deployments.length === 1 && t.deployments[0] === 'ESP'), 'managed-service entries are generic: empty vendor, ESP only');
assert(c.tools.filter((t) => t.toolType !== 'MANAGED_SERVICE').every((t) => t.vendor.length > 0 || t.name === 'OpenLDAP'), 'product entries name a vendor (except open source OpenLDAP)');
assert(new Set(c.tools.map((t) => t.toolType)).size >= 25, 'at least 25 tool types are covered', new Set(c.tools.map((t) => t.toolType)).size);

console.log('\n--- TC4: quality rules over the whole file ---');
assert(!/fedramp/i.test(body), 'no FedRAMP wording');
assert(!/\bIL[2-6]\b|impact level|authorized|authorization|ATO\b/i.test(body), 'no impact-level or authorization claims');
assert(!/\$|price|pricing|per user|free tier|free/i.test(body), 'no pricing wording');
assert(!/https?:|www\.|\.com\b/i.test(body), 'no links');
assert(!/[™®©]/.test(body), 'no trademark symbols');
assert(c.tools.every((t) => !/\b(v?\d+(\.\d+)+|20\d\d)\b/.test(`${t.name} ${(t.aliases ?? []).join(' ')}`)), 'no version or year in names or aliases', c.tools.filter((t) => /\b(v?\d+(\.\d+)+|20\d\d)\b/.test(t.name)).map((t) => t.name));
assert(c.tools.every((t) => !/\b(v?\d+(\.\d+)+|20\d\d)\b/.test(t.mission)), 'no version or year in missions');
assert(c.tools.every((t) => !/\b(best|leading|world-class|industry-leading|#1|award|unmatched|revolutionary|number one|premier|ultimate|powerful|seamless)\b/i.test(t.mission)), 'no superlatives in missions');
assert(c.tools.every((t) => t.mission.length >= 10 && t.mission.length <= 140), 'missions are 10 to 140 characters');
assert(c.tools.every((t) => !/[!?]/.test(t.mission) && !/\.$/.test(t.mission)), 'missions are plain phrases: no ! ? or final full stop');
assert(c.tools.every((t) => !/(community edition|enterprise edition|professional edition|standard edition|premium|plus edition)\b/i.test(t.name)), 'no edition tiers in names');
assert(!/[<>]/.test(body), 'no markup characters');
assert(!/\\u00(?:a9|ae)|\\u2122/i.test(body), 'no escaped trademark symbols');

console.log('\n--- TC5/TC6: controls and meta ---');
assert(c.tools.every((t) => t.typicalControls.length >= 1 && t.typicalControls.length <= MAX_TYPICAL_CONTROLS), 'between 1 and 12 typical controls each', c.tools.filter((t) => t.typicalControls.length > 12).map((t) => t.id));
assert(c.tools.every((t) => t.typicalControls.every((id) => l2Set.has(id))), 'every typical control is a CMMC_L2 id');
assert(c.tools.every((t) => new Set(t.typicalControls).size === t.typicalControls.length), 'typical controls are not repeated');
assert(c._meta.notice === 'Product names are trademarks of their owners; no affiliation or endorsement; no pricing or authorization data.', 'trademark notice text');
assert(/^\d{4}-\d{2}-\d{2}$/.test(c._meta.asOf) && c._meta.schemaVersion === 1 && c._meta.compiledBy === 'Pitch Black Cyber, LLC', 'meta: ISO asOf, schemaVersion 1, compiledBy');
assert(c.tools.every((t) => Object.keys(t).every((k) => ['id', 'name', 'vendor', 'toolType', 'mission', 'deployments', 'defaultAssetCategory', 'typicalControls', 'aliases'].includes(k))), 'entries carry only the schema fields');

console.log('\n--- validateToolCatalog catches faults ---');
const clone = () => JSON.parse(raw);
const bad1 = clone();
bad1.tools[0].typicalControls = ['AC.L2-9.9.9'];
assert(validateToolCatalog(bad1, l2Set).some((p) => p.includes('typicalControls')) && !validateToolCatalog(bad1, l2Set).join('').includes('9.9.9'), 'an unknown control is reported without echoing it');
const bad2 = clone();
bad2.tools[1].id = bad2.tools[0].id;
assert(validateToolCatalog(bad2, l2Set).some((p) => p.includes('repeats an id')), 'a repeated id is reported');
const bad3 = clone();
bad3.tools[0].mission = 'short';
bad3.tools[1].deployments = [];
bad3.tools[2].toolType = 'NOPE';
assert(validateToolCatalog(bad3, l2Set).length === 3, 'a short mission, empty deployments and an unknown type are each reported', validateToolCatalog(bad3, l2Set));
const bad4 = clone();
bad4.tools[0].typicalControls = l2.slice(0, 13);
assert(validateToolCatalog(bad4, l2Set).some((p) => p.includes('over 12')), 'more than 12 controls is reported');
assert(validateToolCatalog(null, l2Set).length > 0 && validateToolCatalog({ _meta: {}, tools: {} }, l2Set).length > 0, 'a non-catalog is reported');

console.log('\n--- Helpers ---');
const okta = c.tools.find((t) => t.id === 'okta-workforce-identity');
assert(!!okta, 'a known entry is present');
assert(searchCatalog(c, 'okta').some((t) => t.id === 'okta-workforce-identity'), 'search finds by name');
assert(searchCatalog(c, 'AZURE ACTIVE DIRECTORY').some((t) => t.id === 'microsoft-entra-id'), 'search finds by alias, ignoring case');
assert(searchCatalog(c, 'microsoft zzzz').length === 0 && searchCatalog(c, 'microsoft').every((t) => /microsoft/i.test(`${t.name} ${t.vendor}`)), 'every word must match');
assert(searchCatalog(c, '', 'SIEM').length > 0 && searchCatalog(c, '', 'SIEM').every((t) => t.toolType === 'SIEM'), 'search can be limited to a type');
assert(searchCatalog(c, '').length === c.tools.length, 'an empty query lists everything');
const sorted = searchCatalog(c, '').map((t) => t.name);
assert(JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.localeCompare(b))), 'search results are alphabetical');
// TC9
assert(c.tools.every((t) => catalogEntryToInput(t).seedKey === `catalog:${t.id}`), 'catalogEntryToInput seedKey is catalog:<id>');
const input = catalogEntryToInput(okta!);
assert(input.name === okta!.name && input.vendorName === okta!.vendor && input.toolType === okta!.toolType && input.deployment === okta!.deployments[0] && input.assetCategory === okta!.defaultAssetCategory && input.mission === okta!.mission, 'catalogEntryToInput pre-fills the entry values');
assert(!('annualCostCents' in input) && !('fedrampStatus' in input) && !('endUsers' in input), 'catalogEntryToInput sets no cost, authorization or user count');
const over = catalogEntryToInput(okta!, { deployment: 'ON_PREM', assetCategory: 'CUI_ASSET', seedKey: 'x' } as never);
assert(over.deployment === 'ON_PREM' && over.assetCategory === 'CUI_ASSET' && over.seedKey === 'catalog:okta-workforce-identity', 'overrides apply but the seedKey cannot be overridden');
// TC10
const l1Ids = new Set(getFrameworkControls('CMMC_L1').map((x) => x.id));
assert(c.tools.every((t) => suggestedControlsForProgram(t, l1Ids).every((id) => l1Ids.has(id))), 'for a CMMC_L1 set, only ids in that set are suggested');
assert(c.tools.every((t) => suggestedControlsForProgram(t, l2Set).length === t.typicalControls.length), 'for the CMMC_L2 set, every typical control is suggested');
assert(suggestedControlsForProgram(okta!, new Set()).length === 0, 'an empty program catalog gets no suggestion');
const nist = new Set(getFrameworkControls('NIST_800_171').map((x) => x.id));
const nistSuggested = c.tools.every((t) => suggestedControlsForProgram(t, nist).every((id) => nist.has(id)));
assert(nistSuggested, 'for another framework, only ids in that framework are suggested');
const ed = suggestedControlsForProgram(okta!, l2Set);
assert(new Set(ed).size === ed.length, 'suggestions are not repeated');

console.log('\n--- TC7/TC8: loading ---');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const importers = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))]
  .filter((f) => /(?:from\s*|import\(\s*)['"][^'"]*toolCatalog\.json['"]/.test(read(path.relative(root, f))))
  .map((f) => path.relative(root, f).replace(/\\/g, '/'));
assert(JSON.stringify(importers) === JSON.stringify(['src/data/inventory/toolCatalogLazy.ts']), 'only toolCatalogLazy.ts imports the JSON', importers);
const lazy = read('src/data/inventory/toolCatalogLazy.ts');
assert(/import\('\.\/toolCatalog\.json'\)/.test(lazy) && !/^import .*toolCatalog\.json/m.test(lazy) && lazy.includes('loadToolCatalog'), 'the lazy loader uses a dynamic import behind a module-level promise');
const vite = read('vite.config.ts');
assert(vite.includes("'tool-catalog'"), 'vite.config.ts has a tool-catalog chunk');
assert(vite.indexOf("'tool-catalog'") < vite.indexOf('/src/data/telemetry/'), 'the tool-catalog rule sits before the telemetry rule');
assert(!/console\./.test(read('src/data/inventory/toolCatalog.ts')) && !/fetch\(/.test(read('src/data/inventory/toolCatalog.ts') + lazy), 'the catalog modules never log or fetch');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
