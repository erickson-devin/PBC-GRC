import fs from 'fs';
import path from 'path';
import registryJson from '../src/data/cui/cuiRegistry.json';
import { CUI_DESIGNATIONS, categoryLink, groupCategories, validateCuiRegistry, type CuiRegistry } from '../src/data/cui/cuiRegistry';
import { CUI_CATEGORY_IDS, CUI_REGISTRY, isKnownCuiCategory } from '../server/inventory/cuiCategories';

/**
 * CUI Registry data (#243): the NARA category list transcribed into src/data/cui/cuiRegistry.json. Pure suite, no server.
 * Pins the shape, the counts the transcription was made from, the SQL id pattern, the lazy loading and the server list.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const r = registryJson as unknown as CuiRegistry;

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
const cat = (id: string) => r.categories.find((c) => c.id === id);

console.log('--- CR1: provenance ---');
assert(r._meta.source === 'U.S. National Archives and Records Administration (NARA), CUI Registry', 'source names NARA');
assert(r._meta.sourceUrls.categoryList === 'https://www.archives.gov/cui/registry/category-list', 'category list URL');
assert(r._meta.sourceUrls.markingList === 'https://www.archives.gov/cui/registry/category-marking-list', 'marking list URL');
assert(/not subject to copyright/i.test(r._meta.license), 'license says not subject to copyright');
assert(r._meta.asOf === '2026-11-19', 'asOf is the fetch date');
assert(r._meta.sourceLastReviewed.categoryList === '2025-03-06' && r._meta.sourceLastReviewed.markingList === '2024-04-09', 'source last-reviewed dates are recorded');
assert(r._meta.verified === true && typeof r._meta.verified === 'boolean', 'verified is true');
assert(r._meta.verifiedNote.includes('126 categories, 20 groupings'), 'verifiedNote states the counts');
assert(r._meta.compiledBy === 'Pitch Black Cyber, LLC', 'compiledBy');
assert(validateCuiRegistry(registryJson).length === 0, 'validateCuiRegistry accepts the shipped file', validateCuiRegistry(registryJson));

console.log('\n--- Groupings and counts ---');
const EXPECTED_GROUPS: [string, number][] = [
  ['Critical Infrastructure', 11],
  ['Defense', 5],
  ['Export Control', 2],
  ['Financial', 12],
  ['Immigration', 7],
  ['Intelligence', 8],
  ['International Agreements', 1],
  ['Law Enforcement', 18],
  ['Legal', 12],
  ['Natural and Cultural Resources', 3],
  ['North Atlantic Treaty Organization (NATO)', 2],
  ['Nuclear', 5],
  ['Patent', 3],
  ['Privacy', 9],
  ['Procurement and Acquisition', 3],
  ['Proprietary Business Information', 6],
  ['Provisional', 9],
  ['Statistical', 4],
  ['Tax', 4],
  ['Transportation', 2],
];
assert(r.indexGroups.length === 20, '20 groupings', r.indexGroups.length);
assert(JSON.stringify(r.indexGroups.map((g) => g.name)) === JSON.stringify(EXPECTED_GROUPS.map(([n]) => n)), 'groupings are in the listed order');
assert(r.categories.length === 126, '126 categories', r.categories.length);
const grouped = groupCategories(r);
assert(grouped.length === 20 && grouped.every((g, i) => g.group.name === EXPECTED_GROUPS[i][0]), 'groupCategories keeps the grouping order');
for (const [i, [name, n]] of EXPECTED_GROUPS.entries()) assert(grouped[i].categories.length === n, `${name}: ${n} categories`, grouped[i].categories.length);
assert(grouped.reduce((s, g) => s + g.categories.length, 0) === 126, 'every category sits under a grouping');
assert(new Set(r.indexGroups.map((g) => g.id)).size === 20, 'grouping ids are unique');
assert(r.categories.every((c) => r.indexGroups.some((g) => g.id === c.indexGroup)), 'every indexGroup is a listed grouping');
assert(cat('DCRIT')?.indexGroup === 'defense', 'DoD Critical Infrastructure Security Information is under Defense (page 1 is the source)');

console.log('\n--- Ids ---');
assert(new Set(r.categories.map((c) => c.id)).size === r.categories.length, 'category ids are unique');
assert(r.categories.every((c) => /^[A-Z][A-Z0-9_-]{0,47}$/.test(c.id)), 'every id matches the SQL CHECK pattern', r.categories.filter((c) => !/^[A-Z][A-Z0-9_-]{0,47}$/.test(c.id)).map((c) => c.id));
assert(r.categories.every((c) => !c.marking || c.id === c.marking), 'a category with a marking uses it as its id');
assert(r.categories.filter((c) => !c.marking).length === 11, 'eleven categories list no marking (nine Provisional, two NATO)');
assert(r.categories.filter((c) => !c.marking).every((c) => c.indexGroup === 'provisional' || c.indexGroup === 'nato'), 'only Provisional and NATO rows have no marking');
assert(r.categories.filter((c) => !c.marking).every((c) => /^[A-Z0-9-]+$/.test(c.id)), 'markingless ids are slugs of the name');
assert(cat('NATO-RESTRICTED')?.name === 'NATO Restricted', 'NATO Restricted gets the slug id NATO-RESTRICTED');

console.log('\n--- Banners and designation ---');
assert(r.categories.every((c) => c.specifiedBanner === null || /^CUI\/\/SP-[A-Z]+$/.test(c.specifiedBanner)), 'every specified banner is CUI//SP-XXX');
assert(r.categories.every((c) => c.specifiedBanner === null || c.specifiedBanner === `CUI//SP-${c.marking}`), 'a specified banner carries the category marking');
assert(r.categories.every((c) => c.basicBanner === null || c.basicBanner === 'CUI' || c.basicBanner === 'CUI//NETW'), 'basic banners are CUI, except Net Worth');
assert(r.categories.every((c) => (CUI_DESIGNATIONS as readonly string[]).includes(c.designation)), 'every designation is SPECIFIED, BASIC, BOTH or NONE');
assert(
  r.categories.every((c) => c.designation === (c.specifiedBanner && c.basicBanner ? 'BOTH' : c.specifiedBanner ? 'SPECIFIED' : c.basicBanner ? 'BASIC' : 'NONE')),
  'designation is derived only from the listed banners'
);
const cti = cat('CTI');
assert(cti?.name === 'Controlled Technical Information' && cti.indexGroup === 'defense' && cti.specifiedBanner === 'CUI//SP-CTI' && cti.basicBanner === null && cti.designation === 'SPECIFIED', 'Controlled Technical Information', cti);
assert(cat('EXPT')?.designation === 'BOTH' && cat('EXPT')?.specifiedBanner === 'CUI//SP-EXPT' && cat('EXPT')?.basicBanner === 'CUI', 'Export Controlled is BOTH');
assert(cat('PRVCY')?.name === 'General Privacy' && cat('PRVCY')?.designation === 'BOTH', 'General Privacy is BOTH');
assert(cat('NETW')?.name === 'Net Worth' && cat('NETW')?.basicBanner === 'CUI//NETW' && cat('NETW')?.specifiedBanner === null && cat('NETW')?.designation === 'BASIC', 'Net Worth Basic banner is CUI//NETW');
const nato = cat('NATO-RESTRICTED');
assert(nato?.designation === 'NONE' && nato.marking === null && nato.specifiedBanner === null && nato.basicBanner === null, 'NATO Restricted: no marking, no banner, NONE', nato);
assert(cat('NATO-UNCLASSIFIED')?.designation === 'NONE', 'NATO Unclassified is NONE');
assert(r.categories.filter((c) => c.designation === 'NONE').length === 2, 'only the two NATO rows are NONE');
assert(r.categories.every((c) => c.basicBanner !== 'CUI//NETW' || c.id === 'NETW'), 'Net Worth is the only non-plain basic banner');
assert(r.categories.every((c) => c.name === c.name.trim() && c.name.length > 0), 'names are written as listed (no stray spaces)');

console.log('\n--- No markup, no links per category ---');
const raw = JSON.stringify(registryJson);
assert(![...raw.matchAll(/"([^"\\]*)"/g)].some((m) => /[<>]/.test(m[1])), 'no string contains < or >');
assert(r.categories.every((c) => !('url' in c)), 'no per-category URL (not verified)');
assert(categoryLink(r, r.categories[0]) === r._meta.sourceUrls.categoryList, 'categoryLink is the category list page');
assert(!/https?:\/\//.test(raw.replace(/https:\/\/www\.archives\.gov\/cui\/registry\/category-(marking-)?list/g, '')), 'the only links are the two NARA pages');

console.log('\n--- validateCuiRegistry catches faults ---');
const clone = () => JSON.parse(raw);
const bad1 = clone();
bad1.categories[1].id = bad1.categories[0].id;
assert(validateCuiRegistry(bad1).some((p) => p.includes('repeats')), 'a repeated id is reported');
const bad2 = clone();
bad2.categories[0].designation = 'BASIC';
assert(validateCuiRegistry(bad2).some((p) => p.includes('designation')), 'a designation that does not match the banners is reported');
const bad3 = clone();
bad3.categories[0].indexGroup = 'nowhere';
assert(validateCuiRegistry(bad3).some((p) => p.includes('indexGroup')) && !validateCuiRegistry(bad3).join('').includes('nowhere'), 'an unknown grouping is reported without echoing it');
assert(validateCuiRegistry(null).length > 0 && validateCuiRegistry({}).length > 0, 'a non-registry is reported');

console.log('\n--- CR7/CR8: loading ---');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const importers = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))]
  .filter((f) => /(?:from\s*|import\(\s*)['"][^'"]*cuiRegistry\.json['"]/.test(read(path.relative(root, f))))
  .map((f) => path.relative(root, f).replace(/\\/g, '/'))
  .sort();
assert(JSON.stringify(importers) === JSON.stringify(['server/inventory/cuiCategories.ts', 'src/data/cui/cuiRegistryLazy.ts']), 'only the lazy loader and the server list import the JSON', importers);
assert(/import\('\.\/cuiRegistry\.json'\)/.test(read('src/data/cui/cuiRegistryLazy.ts')) && !/^import .*cuiRegistry\.json/m.test(read('src/data/cui/cuiRegistryLazy.ts')), 'the lazy loader uses a dynamic import');
assert(/import registry from '\.\.\/\.\.\/src\/data\/cui\/cuiRegistry\.json'/.test(read('server/inventory/cuiCategories.ts')), 'the server imports the JSON statically');
const vite = read('vite.config.ts');
assert(vite.includes("'cui-registry'"), 'vite.config.ts has a cui-registry chunk');
assert(vite.indexOf("'cui-registry'") < vite.indexOf('/src/data/telemetry/'), 'the cui-registry rule sits before the telemetry rule');

console.log('\n--- CR9: server-side list ---');
assert(CUI_REGISTRY.categories.length === 126, 'the server holds the same 126 categories');
assert(CUI_CATEGORY_IDS.size === CUI_REGISTRY.categories.length, 'CUI_CATEGORY_IDS has one entry per category', CUI_CATEGORY_IDS.size);
assert(r.categories.every((c) => CUI_CATEGORY_IDS.has(c.id)), 'every category id is in CUI_CATEGORY_IDS');
assert(isKnownCuiCategory('CTI') && isKnownCuiCategory('NATO-RESTRICTED'), 'isKnownCuiCategory accepts shipped ids');
assert(!isKnownCuiCategory('NOPE-MARK') && !isKnownCuiCategory('') && !isKnownCuiCategory(null) && !isKnownCuiCategory(7) && !isKnownCuiCategory('cti'), 'isKnownCuiCategory refuses unknown ids and non-strings');
assert(!/console\./.test(read('server/inventory/cuiCategories.ts')), 'the server list never logs');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
