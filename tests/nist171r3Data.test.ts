import catalogJson from '../src/data/frameworks/nist171r3/catalog.generated.json';
import objectivesJson from '../src/data/frameworks/nist171r3/objectives.generated.json';
import mappingJson from '../src/data/frameworks/nist171r3/r2r3.generated.json';
import type { GeneratedR2R3File, GeneratedR3CatalogFile, GeneratedR3ObjectivesFile } from '../src/data/frameworks/nist171r3/types';
import { parseParameterTags } from '../src/data/frameworks/parameters';
import { crosswalkRequirements, requirementNumberOf } from '../src/data/frameworks/nist80053/crosswalk';
import { canonical80053Id } from '../src/data/frameworks/nist80053/objectives';
import { cmmcNumberOf } from '../src/data/cmmcGuide/guide';
import { NIST_800_171A_REGISTRY, normalizeControlNumber } from '../src/data/frameworks/assessmentObjectives';
import { CMMC_LEVEL_2_CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import { CMMC_LEVEL_1_CONTROLS } from '../src/data/cmmcLevel1Controls';

/**
 * The committed NIST SP 800-171 Rev. 3 data (catalog, SP 800-171A objectives, Rev. 2 -> Rev. 3 mapping) against its own
 * invariants and against the platform's other catalogs. Every count is computed from the data, none is written down here. Pure:
 * does not boot the server.
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const catalog = catalogJson as unknown as GeneratedR3CatalogFile;
const objectivesFile = objectivesJson as unknown as GeneratedR3ObjectivesFile;
const mapping = mappingJson as unknown as GeneratedR2R3File;
const ID = /^03\.\d{2}\.\d{2}$/;
const ids = catalog.requirements.map((r) => r.id);
const active = new Set(ids);
const compare = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

console.log('--- Provenance ---');
const metas = [catalog.meta, objectivesFile.meta, mapping.meta];
assert(metas.every((m) => m.generatedBy === 'scripts/generateNist171r3.ts'), 'D1: every file names its generator');
assert(metas.every((m) => /^[0-9a-f]{40}$/.test(m.oscalCommit)), 'D2: every file pins a 40 character commit', metas.map((m) => m.oscalCommit));
assert(metas.every((m) => Object.keys(m.sources).length >= 2 && Object.values(m.sources).every((s) => /^[0-9a-f]{64}$/.test(s.sha256))), 'D3: every source has a 64 hex character sha256');
assert(metas.every((m) => Object.values(m.sources).every((s) => /^https:\/\//.test(s.url))), 'D4: every source has an https url');
assert(metas.every((m) => m.sources.catalog?.url.includes(m.oscalCommit)), 'D5: the catalog url is pinned to the commit, not to a branch');
assert(metas.every((m) => same(m.sources, catalog.meta.sources) && m.oscalVersion === catalog.meta.oscalVersion), 'D6: the three files were built from the same sources');
assert(typeof metas[0].oscalVersion === 'string' && metas[0].oscalVersion.length > 0, 'D7: the catalog version is recorded');

console.log('\n--- Catalog: requirements ---');
assert(ids.length > 0, 'D8: the catalog has requirements', ids.length);
assert(ids.every((id) => ID.test(id)), 'D9: every id is 03.xx.xx', ids.filter((id) => !ID.test(id)));
assert(new Set(ids).size === ids.length, 'D10: ids are unique');
assert(same(ids, [...ids].sort(compare)), 'D11: requirements are in id order');
const familyCodes = new Set(catalog.families.map((f) => f.code));
assert(catalog.families.length > 0 && catalog.families.every((f) => /^03\.\d{2}$/.test(f.code) && f.title.trim() !== ''), 'D12: families have a code and a title', catalog.families);
assert(catalog.requirements.every((r) => r.family === r.id.slice(0, 5) && familyCodes.has(r.family)), 'D13: every requirement is in the family its id says, and the family exists');
assert(catalog.families.every((f) => ids.some((id) => id.startsWith(`${f.code}.`))), 'D14: every family has an active requirement');
assert(catalog.requirements.every((r) => r.title.trim() !== '' && r.title !== r.id && r.statement.trim() !== '' && r.discussion.trim() !== ''), 'D15: title, statement and discussion are all present');
assert(!catalog.requirements.some((r) => /\{\{|\}\}|\]\(|<[a-z]/i.test(r.statement + r.discussion + r.title)), 'D16: no placeholder, link markup or tag is left in the text');
const unlabelled = catalog.requirements.filter((r) => r.statement.includes('\n') && !r.statement.split('\n').every((l) => /^( {2})?([a-z]|\d+)\. \S/.test(l)));
assert(unlabelled.length === 0, 'D17: a multi-line statement labels every line (a. / 1.)', unlabelled.map((r) => r.id));
assert(!catalog.requirements.some((r) => r.statement.split('\n').some((l) => /\s$/.test(l) || /^\s{3,}/.test(l))), 'D18: no line has trailing white space or deeper indentation than two spaces');

console.log('\n--- Catalog: ODPs and tags ---');
const tagProblems: string[] = [];
const orderProblems: string[] = [];
for (const r of catalog.requirements) {
  const found = parseParameterTags(r.statement, r.id);
  if (found.length !== r.odps.length) tagProblems.push(`${r.id}: ${found.length} tags parsed, ${r.odps.length} ODPs`);
  r.odps.forEach((odp, i) => {
    const e = catalog.odps[odp];
    if (!e || e.requirement !== r.id || e.tag !== i + 1 || e.placement !== 'TAG' || e.kind !== found[i]?.kind) orderProblems.push(`${r.id}#${i + 1} ${odp}`);
  });
}
assert(tagProblems.length === 0, 'D19: parseParameterTags finds exactly as many tags as the requirement has ODPs', tagProblems.slice(0, 5));
assert(orderProblems.length === 0, 'D20: odps[n - 1] is the ODP of tag n, of the right kind', orderProblems.slice(0, 5));
const opened = catalog.requirements.filter((r) => (r.statement.match(/\[\s*(Assignment|Selection)\b/gi) ?? []).length < r.odps.length);
assert(opened.length === 0, 'D21: no requirement has fewer opening brackets than ODP tags', opened.map((r) => r.id));
const odpEntries = Object.entries(catalog.odps);
assert(odpEntries.length > 0 && odpEntries.every(([id, o]) => /^A\.03\.\d{2}\.\d{2}\.ODP\[\d{2}\]$/.test(id) && id.startsWith(`A.${o.requirement}.ODP[`)), 'D22: ODP ids are A.<requirement>.ODP[nn]');
assert(odpEntries.every(([, o]) => active.has(o.requirement)), 'D23: every ODP belongs to an active requirement');
assert(odpEntries.every(([id, o]) => (o.placement === 'TAG' ? catalog.requirements.find((r) => r.id === o.requirement)?.odps[(o.tag as number) - 1] === id : o.tag === null)), 'D24: a TAG ODP sits at its tag number, every other ODP has no tag');
assert(odpEntries.every(([, o]) => o.placement !== 'NESTED' || (typeof o.parentTag === 'number' && catalog.odps[catalog.requirements.find((r) => r.id === o.requirement)?.odps[o.parentTag - 1] ?? '']?.kind === 'SELECTION')), 'D25: a NESTED ODP names a Selection tag of its requirement');
assert(odpEntries.every(([, o]) => o.placement === 'NESTED' || !('parentTag' in o)), 'D26: only NESTED ODPs have a parentTag');
assert(odpEntries.every(([, o]) => (o.kind === 'SELECTION') === (o.label === 'Selection')) && odpEntries.every(([, o]) => o.label.trim() !== ''), 'D27: Selections are labelled Selection, every ODP has a label');
assert(catalog.requirements.every((r) => r.odps.every((id) => catalog.odps[id])) && new Set(catalog.requirements.flatMap((r) => r.odps)).size === catalog.requirements.flatMap((r) => r.odps).length, 'D28: an ODP is the tag of at most one place');
const referencedIds = new Set<string>([...catalog.requirements.flatMap((r) => r.odps), ...odpEntries.filter(([, o]) => o.placement !== 'TAG').map(([id]) => id)]);
assert(odpEntries.every(([id]) => referencedIds.has(id)), 'D29: every ODP is a tag, nested in a tag, or used by the objectives');
const objectiveRefs = (req: string): string => (objectivesFile.objectives[req]?.objectives ?? []).map((o) => o.text ?? '').join('\n');
assert(odpEntries.filter(([, o]) => o.placement === 'OBJECTIVES').every(([, o]) => /\[(Assignment|Selection)/.test(objectiveRefs(o.requirement))), 'D30: an OBJECTIVES ODP really appears as a tag in an objective of its requirement');

console.log('\n--- Catalog: withdrawn requirements ---');
const withdrawnIds = Object.keys(catalog.withdrawn);
assert(withdrawnIds.every((id) => ID.test(id)) && same(withdrawnIds, [...withdrawnIds].sort(compare)), 'D31: withdrawn ids are 03.xx.xx in order');
assert(withdrawnIds.every((id) => !active.has(id)), 'D32: no requirement is both active and withdrawn');
const links = Object.values(catalog.withdrawn).flat();
assert(links.every((l) => active.has(l.id)), 'D33: every withdrawn target is an active requirement', links.filter((l) => !active.has(l.id)));
assert(links.every((l) => l.relation === 'INCORPORATED_INTO' || l.relation === 'ADDRESSED_BY'), 'D34: every withdrawn relation is INCORPORATED_INTO or ADDRESSED_BY');
assert(Object.values(catalog.withdrawn).every((ls) => new Set(ls.map((l) => l.id)).size === ls.length), 'D35: a withdrawn requirement names a successor once');
assert(withdrawnIds.every((id) => familyCodes.has(id.slice(0, 5))), 'D36: every withdrawn requirement is in a known family');

console.log('\n--- Objectives (SP 800-171A) ---');
const objKeys = Object.keys(objectivesFile.objectives);
assert(objKeys.every((k) => active.has(k)), 'D37: objectives exist only for active requirements');
assert(ids.every((id) => (objectivesFile.objectives[id]?.objectives.length ?? 0) > 0), 'D38: every active requirement has objectives', ids.filter((id) => !objectivesFile.objectives[id]));
const objProblems: string[] = [];
for (const [req, entry] of Object.entries(objectivesFile.objectives)) {
  const letters = entry.objectives.map((o) => o.letter);
  if (new Set(letters).size !== letters.length) objProblems.push(`${req}: letters repeat`);
  for (const o of entry.objectives) {
    if (!/^[a-z0-9]+$/.test(o.letter)) objProblems.push(`${req}: letter ${o.letter}`);
    if (!o.id.startsWith(`A.${req}`)) objProblems.push(`${req}: id ${o.id}`);
    if (!o.text || o.text.trim() === '' || /\{\{|\}\}|\]\(/.test(o.text)) objProblems.push(`${req}: text of ${o.id}`);
    if ('parent' in o) objProblems.push(`${req}: ${o.id} has a parent`);
  }
}
assert(objProblems.length === 0, 'D39: letters are unique [a-z0-9]+, ids start A.<requirement>, texts are plain, objectives are flat', objProblems.slice(0, 5));
const odpObjectiveProblems: string[] = [];
for (const [id, o] of odpEntries) {
  const listed = objectivesFile.objectives[o.requirement]?.objectives.find((x) => x.id === id);
  if (o.guideline && (!listed || listed.letter !== `odp${id.replace(/^.*\[(\d+)\]$/, '$1')}`)) odpObjectiveProblems.push(id);
  if (!o.guideline && listed) odpObjectiveProblems.push(`${id} has an objective but no guideline`);
}
assert(odpObjectiveProblems.length === 0, 'D40: an ODP with NIST\'s guideline has its determination statement as objective odpNN', odpObjectiveProblems.slice(0, 5));
assert(Object.values(objectivesFile.objectives).every((e) => { const first = e.objectives.findIndex((o) => !/^odp/.test(o.letter)); return first === -1 || e.objectives.slice(first).every((o) => !/^odp/.test(o.letter)); }), 'D41: ODP statements come first, no ODP statement follows an objective');
assert(Object.values(objectivesFile.objectives).every((e) => ['examine', 'interview', 'test'].every((m) => Array.isArray((e.methods as any)[m]) && (e.methods as any)[m].every((s: unknown) => typeof s === 'string' && s.trim() !== ''))), 'D43: methods are lists of non-empty strings');
// NIST's catalog gives no assessment-method part at all to these two requirements (generated by a run; a regeneration that
// changes the list must be looked at, not waved through)
const withoutMethods = Object.entries(objectivesFile.objectives).filter(([, e]) => e.methods.examine.length + e.methods.interview.length + e.methods.test.length === 0).map(([k]) => k);
assert(same(withoutMethods, ['03.01.22', '03.14.03']), 'D44: the requirements without any assessment method are exactly the two NIST gives none', withoutMethods);
assert(!Object.values(objectivesFile.objectives).some((e) => [...e.methods.examine, ...e.methods.interview, ...e.methods.test].some((s) => /\{\{|\}\}|\]\(/.test(s))), 'D45: no markup in the methods');

console.log('\n--- Rev. 2 -> Rev. 3 mapping ---');
const r2 = Object.keys(mapping.requirements);
assert(same(r2, crosswalkRequirements()), 'D46: mapping keys are exactly the Rev. 2 requirements of the platform crosswalk, in order', r2.length);
assert(r2.every((k) => /^3\.\d{1,2}\.\d{1,2}$/.test(k)), 'D47: keys are Rev. 2 identifiers (3.1.1)');
const entries = Object.entries(mapping.requirements);
const targets = entries.flatMap(([, e]) => e.targets);
assert(targets.every((t) => active.has(t.id)), 'D48: every target is an active Rev. 3 requirement', targets.filter((t) => !active.has(t.id)));
assert(targets.every((t) => t.relation === 'SAME' || t.relation === 'INCORPORATED_INTO' || t.relation === 'ADDRESSED_BY'), 'D49: relations are SAME, INCORPORATED_INTO or ADDRESSED_BY');
assert(entries.every(([, e]) => new Set(e.targets.map((t) => t.id)).size === e.targets.length), 'D50: a requirement names a target once');
assert(entries.every(([, e]) => e.withdrawn === true || e.withdrawn === undefined), 'D51: withdrawn is true or absent');
assert(entries.every(([, e]) => (e.withdrawn ? e.changeType === undefined && e.newOdp === undefined : ['NO_SIGNIFICANT_CHANGE', 'MINOR_CHANGE', 'SIGNIFICANT_CHANGE'].includes(e.changeType as string) && typeof e.newOdp === 'boolean')), 'D52: a carried requirement has a change type and newOdp, a withdrawn one has neither');
assert(entries.every(([, e]) => (e.withdrawn ? e.targets.every((t) => t.relation !== 'SAME') : e.targets.length > 0 && e.targets.every((t) => t.relation === 'SAME'))), 'D53: carried requirements lead by SAME, withdrawn ones by their NIST link relation');
const noSuccessor = entries.filter(([, e]) => e.targets.length === 0).map(([k]) => k);
assert(same(Object.keys(mapping.withdrawnWithoutSuccessor).sort(compare), [...noSuccessor].sort(compare)) && Object.values(mapping.withdrawnWithoutSuccessor).every((v) => v === true), 'D54: withdrawnWithoutSuccessor is exactly the entries without targets', noSuccessor);
assert(noSuccessor.every((k) => mapping.requirements[k].withdrawn === true), 'D55: a requirement without targets is a withdrawn one');
const targeted = new Set(targets.map((t) => t.id));
assert(same(mapping.newInR3, ids.filter((id) => !targeted.has(id))), 'D56: newInR3 is the active ids no Rev. 2 requirement targets, in order', mapping.newInR3);
assert(mapping.newInR3.every((id) => active.has(id)) && new Set(mapping.newInR3).size === mapping.newInR3.length, 'D57: newInR3 holds active ids once');
assert(ids.every((id) => targeted.has(id) !== mapping.newInR3.includes(id)), 'D58: every active Rev. 3 requirement is either targeted or new, never both');
// the mapping against the catalog's own withdrawn links
const placeholderOf = (k: string) => k.split('.').map((p) => p.padStart(2, '0')).join('.');
const linkProblems: string[] = [];
for (const [k, e] of entries) {
  const placeholder = placeholderOf(k);
  const nist = catalog.withdrawn[placeholder];
  if (e.withdrawn && !nist) linkProblems.push(`${k}: withdrawn but ${placeholder} is not withdrawn in the catalog`);
  if (e.withdrawn && nist && !same(e.targets, nist)) linkProblems.push(`${k}: targets differ from the catalog links`);
  if (!e.withdrawn && nist) for (const l of nist) if (!e.targets.some((t) => t.id === l.id)) linkProblems.push(`${k}: catalog link ${l.id} is missing`);
}
assert(linkProblems.length === 0, 'D59: withdrawn entries carry exactly the catalog links; a carried requirement keeps any link its placeholder has', linkProblems);
assert(withdrawnIds.every((id) => mapping.requirements[id.split('.').map(Number).join('.')] !== undefined), 'D60: every withdrawn Rev. 3 requirement is some Rev. 2 requirement of the mapping');
assert(Array.isArray(mapping.corrections) && mapping.corrections.every((c) => typeof c === 'string' && c.trim() !== ''), 'D61: corrections are a list of sentences');
assert(mapping.corrections.every((c) => !/\{|\}/.test(c)), 'D62: corrections carry no placeholder');

console.log('\n--- No collision with the other catalogs ---');
assert(ids.every((id) => requirementNumberOf(id) === null), 'D63: requirementNumberOf (the Rev. 2 crosswalk) does not recognise a Rev. 3 id', ids.filter((id) => requirementNumberOf(id) !== null));
assert(ids.every((id) => cmmcNumberOf(id) === null), 'D64: cmmcNumberOf does not recognise a Rev. 3 id', ids.filter((id) => cmmcNumberOf(id) !== null));
assert(ids.every((id) => canonical80053Id(id) === ''), 'D65: canonical80053Id does not recognise a Rev. 3 id', ids.filter((id) => canonical80053Id(id) !== ''));
assert(ids.every((id) => NIST_800_171A_REGISTRY[normalizeControlNumber(id)] === undefined), 'D66: the Rev. 2 800-171A objective registry has no entry for a Rev. 3 id', ids.filter((id) => NIST_800_171A_REGISTRY[normalizeControlNumber(id)] !== undefined));
const cmmcIds = new Set([...CMMC_LEVEL_2_CONTROLS, ...CMMC_LEVEL_1_CONTROLS].map((c) => c.id));
assert(ids.every((id) => !cmmcIds.has(id)) && withdrawnIds.every((id) => !cmmcIds.has(id)), 'D67: no Rev. 3 id is a CMMC control id');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
