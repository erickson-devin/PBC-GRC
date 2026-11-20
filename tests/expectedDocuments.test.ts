import fs from 'fs';
import path from 'path';
import catalogJson from '../src/data/documents/expectedDocuments.json';
import {
  EXPECTED_FRAMEWORKS,
  applicableExpected,
  expectedStatus,
  presentCounts,
  suggestMatches,
  validateExpectedCatalog,
  type ExpectedDocument,
  type ExpectedDocumentCatalog,
} from '../src/data/documents/expectedDocuments';
import { EXPECTED_CATALOG, EXPECTED_IDS, expectedFor, isKnownExpectedId } from '../server/documents/expectedCatalog';
import { DOCUMENT_KINDS, type GovernanceDocument } from '../src/types/documents';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';

/**
 * Expected documents checklist (#250): src/data/documents/expectedDocuments.json is plain data we wrote (document type
 * names and our own descriptions). Pure suite, no server. Pins the schema, the authoring rules, the controls it names,
 * the lazy loading, the server copy and the matching and counting helpers.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const c = catalogJson as unknown as ExpectedDocumentCatalog;

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

const ids = (fw: string, baseline?: string) => new Set(getFrameworkControls(fw, baseline ?? 'ALL_CONTROLS').map((x) => x.id));
const idsByFramework = { CMMC_L1: ids('CMMC_L1'), CMMC_L2: ids('CMMC_L2'), NIST_800_53_REV5: ids('NIST_800_53_REV5') };
const all: { fw: string; e: ExpectedDocument }[] = Object.entries(c.frameworks).flatMap(([fw, list]) => (list ?? []).map((e) => ({ fw, e })));
// Entry text only (the notice says "Not copied from ..." and so is not an entry)
const body = JSON.stringify(c.frameworks);

console.log('--- E1: schema ---');
assert(idsByFramework.CMMC_L2.size >= 100 && idsByFramework.CMMC_L2.has('CA.L2-3.12.4') && idsByFramework.NIST_800_53_REV5.has('AC-1'), 'the control ids of the three frameworks were loaded');
const problems = validateExpectedCatalog(catalogJson, idsByFramework);
assert(problems.length === 0, 'validateExpectedCatalog accepts the shipped catalog', problems.slice(0, 5));

console.log('\n--- E2: ids, names and text ---');
assert(new Set(all.map((x) => x.e.id)).size === all.length, 'ids are unique across the file');
assert(all.every((x) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(x.e.id)), 'ids are lowercase slugs');
const prefixOf: Record<string, string> = { CMMC_L1: 'cmmc-l1-', CMMC_L2: 'cmmc-l2-', NIST_800_53_REV5: 'nist-80053-' };
assert(all.every((x) => x.e.id.startsWith(prefixOf[x.fw])), 'every id starts with its framework prefix');
assert(Object.keys(c.frameworks).every((fw) => new Set(c.frameworks[fw as keyof typeof c.frameworks]!.map((e) => e.name.toLowerCase())).size === c.frameworks[fw as keyof typeof c.frameworks]!.length), 'names are unique per framework, ignoring case');
assert(all.every((x) => x.e.name === x.e.name.trim() && x.e.name.length > 0 && x.e.name.length <= 80), 'names are 1 to 80 characters with no stray spaces');
assert(all.every((x) => x.e.description.length >= 10 && x.e.description.length <= 160), 'descriptions are 10 to 160 characters', all.filter((x) => x.e.description.length > 160 || x.e.description.length < 10).map((x) => x.e.id));
assert(all.every((x) => /[.]$/.test(x.e.description)), 'descriptions are sentences ending in a full stop');
assert(!/[<>]/.test(JSON.stringify(c)), 'no markup characters anywhere in the file');
assert(!/\bshall\b/i.test(body), 'no "shall" in the entries');
assert(!/required by|mandated|mandatory|\bmust\b|compliant|guarantee|certif/i.test(body), 'no claim that a document is required, mandated or certifies anything');
assert(!/https?:|www\.|\.com\b|[™®©]/i.test(body), 'no links or trademark symbols');
assert(all.every((x) => !/\b(v?\d+(\.\d+)+|20\d\d)\b/.test(`${x.e.name} ${x.e.description}`)), 'no version, clause number or year in names or descriptions');

console.log('\n--- E3: kinds, keywords and the generator ---');
assert(all.every((x) => (DOCUMENT_KINDS as readonly string[]).includes(x.e.kind)), 'every kind is a document kind');
assert(all.every((x) => x.e.requirement === 'EXPECTED' || x.e.requirement === 'RECOMMENDED'), 'every requirement is EXPECTED or RECOMMENDED');
assert(all.every((x) => x.e.keywords.length >= 1 && x.e.keywords.length <= 8 && x.e.keywords.every((k) => k === k.trim().toLowerCase() && k.length >= 2)), 'keywords are 1 to 8 trimmed lowercase words');
assert(all.every((x) => x.e.generator === undefined || x.e.kind === 'POLICY'), 'the generator flag appears only on POLICY entries');
// The families PolicyLibraryView offers for each framework (the generator picks controls by domain or id prefix)
const GENERATOR_FAMILIES: Record<string, string[]> = {
  CMMC_L1: ['AC', 'IA', 'MP', 'PE', 'SC', 'SI'],
  CMMC_L2: ['AC', 'AT', 'AU', 'CA', 'CM', 'IA', 'IR', 'MA', 'MP', 'PE', 'PS', 'RA', 'SC', 'SI'],
  NIST_800_53_REV5: ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SC', 'SI', 'SR'],
};
const withGenerator = all.filter((x) => x.e.generator);
assert(withGenerator.length > 0 && withGenerator.every((x) => GENERATOR_FAMILIES[x.fw].includes(x.e.generator!.family)), 'every generator family is one the Living Policy Library offers for that framework', withGenerator.filter((x) => !GENERATOR_FAMILIES[x.fw].includes(x.e.generator!.family)).map((x) => x.e.id));
assert(withGenerator.every((x) => {
  const fam = x.e.generator!.family;
  const matching = getFrameworkControls(x.fw).filter((ctl) => (ctl.domain || '').toUpperCase() === fam || ctl.id.toUpperCase().startsWith(`${fam}.`) || ctl.id.toUpperCase().startsWith(`${fam}-`));
  return matching.length >= 1;
}), 'each generator family selects at least one control of its framework');
assert(withGenerator.every((x) => x.e.controls.some((id) => {
  const ctl = getFrameworkControls(x.fw).find((k) => k.id === id);
  return !!ctl && (ctl.domain || '').toUpperCase() === x.e.generator!.family;
})), 'a generator entry maps at least one control of the family it generates');
assert(all.filter((x) => x.e.kind === 'POLICY' && !x.e.generator).every((x) => /acceptable use|rules of behavior/i.test(x.e.name)), 'policies without a generator are only the acceptable-use / rules-of-behavior ones');

console.log('\n--- E4: coverage and the D10 level ---');
for (const fw of EXPECTED_FRAMEWORKS) assert((c.frameworks[fw] ?? []).length >= 1, `${fw} has at least one entry`);
const l2 = c.frameworks.CMMC_L2 ?? [];
assert(l2.some((e) => e.kind === 'PLAN' && e.controls.includes('CA.L2-3.12.4')), 'CMMC_L2 has the system security plan (PLAN, CA.L2-3.12.4)');
assert(l2.some((e) => e.kind === 'PLAN' && e.controls.includes('CA.L2-3.12.2')), 'CMMC_L2 has the plan of action and milestones (PLAN, CA.L2-3.12.2)');
const l1 = c.frameworks.CMMC_L1 ?? [];
const l1Ssp = l1.find((e) => e.kind === 'PLAN' && /system security plan/i.test(e.name));
assert(!!l1Ssp && l1Ssp.requirement === 'RECOMMENDED', 'the CMMC Level 1 system security plan is RECOMMENDED, not expected (D10)');
assert(l1.filter((e) => !/system security plan/i.test(e.name)).every((e) => e.requirement === 'EXPECTED'), 'the other CMMC Level 1 entries are EXPECTED');
assert((c.frameworks.NIST_800_53_REV5 ?? []).filter((e) => e.generator).length === 20, 'NIST has the 20 policy-and-procedures documents, all with a generator');
assert(Object.entries(c.frameworks).every(([fw, list]) => list!.every((e) => e.controls.every((id) => idsByFramework[fw as keyof typeof idsByFramework].has(id)))), 'every mapped control id exists in its framework');
assert(all.length >= 40 && all.length <= 80, 'the whole list stays modest (40 to 80 entries)', all.length);

console.log('\n--- E5: applicableExpected ---');
const nist = c.frameworks.NIST_800_53_REV5 ?? [];
const low = ids('NIST_800_53_REV5', 'LOW');
const lowApplicable = applicableExpected(c, 'NIST_800_53_REV5', low).map((e) => e.id);
assert(JSON.stringify(lowApplicable) === JSON.stringify(nist.filter((e) => e.controls.some((id) => low.has(id))).map((e) => e.id)), 'for the LOW baseline set it returns the entries with at least one control in the set');
assert(low.size < idsByFramework.NIST_800_53_REV5.size && lowApplicable.length > 0, 'the LOW baseline set is a smaller, non-empty set');
assert(applicableExpected(c, 'NIST_800_53_REV5', idsByFramework.NIST_800_53_REV5).length === nist.length, 'with the full catalog it returns every NIST entry');
assert(applicableExpected(c, 'NIST_800_53_REV5', new Set()).length === 0, 'an empty program catalog gets nothing');
assert(applicableExpected(c, 'SOC_2_TYPE_II', idsByFramework.NIST_800_53_REV5).length === 0, 'a framework without a list gets nothing');
assert(applicableExpected(c, 'CMMC_L2', idsByFramework.CMMC_L1).every((e) => e.controls.some((id) => idsByFramework.CMMC_L1.has(id))), 'only entries naming a control in the given set are returned');

console.log('\n--- E6: suggestMatches ---');
const doc = (id: string, title: string, kind: GovernanceDocument['kind'], status: GovernanceDocument['status'] = 'DRAFT'): GovernanceDocument => ({
  id, tenantId: 't', kind, title, reference: '', owner: '', version: '', status, approvalDate: status === 'APPROVED' ? '2026-11-01' : null, reviewBy: null,
  approvedBy: null, approvedAt: null, locationUrl: null, origin: 'MANUAL', seedKey: null, notes: '', createdAt: '', updatedAt: '', updatedBy: null,
});
const irEntry = { kind: 'PLAN' as const, keywords: ['incident', 'response'] };
const sugDocs = [doc('d1', 'Incident Response Plan', 'PLAN'), doc('d2', 'IR Policy', 'POLICY'), doc('d3', 'Incident Response Plan old', 'PLAN', 'RETIRED')];
assert(JSON.stringify(suggestMatches(irEntry, sugDocs, new Set())) === JSON.stringify(['d1']), 'a matching kind and keywords is suggested; another kind and a retired document are not');
assert(suggestMatches(irEntry, sugDocs, new Set(['d1'])).length === 0, 'a document already linked is not suggested again');
assert(JSON.stringify(suggestMatches(irEntry, [doc('d6', 'Incident handling', 'PLAN')], new Set())) === JSON.stringify(['d6']), 'the kind plus one keyword is enough (score 3)');
assert(suggestMatches(irEntry, [doc('d4', 'Handbook', 'PLAN')], new Set()).length === 0, 'the kind alone (no keyword in the title) stays under the score');
assert(suggestMatches(irEntry, [doc('d5', 'Incident Response Plan', 'POLICY')], new Set()).length === 0, 'both keywords without the kind score 2 and are not suggested');
assert(JSON.stringify(suggestMatches(irEntry, [doc('a', 'Incident handling', 'PLAN'), doc('b', 'Incident response handling', 'PLAN')], new Set())) === JSON.stringify(['b', 'a']), 'the best score comes first');
assert(JSON.stringify(suggestMatches({ kind: 'PLAN', keywords: ['incident'] }, [doc('z', 'INCIDENT PLAN', 'PLAN')], new Set())) === JSON.stringify(['z']), 'the title is matched ignoring case');

console.log('\n--- E7: expectedStatus and presentCounts ---');
const mk = (id: string, requirement: ExpectedDocument['requirement'], kind: ExpectedDocument['kind'] = 'PLAN'): ExpectedDocument => ({ id, name: id, kind, description: 'A test entry for the counts.', controls: ['X'], keywords: [id], requirement });
const e1 = mk('e1', 'EXPECTED');
const e2 = mk('e2', 'EXPECTED');
const e3 = mk('e3', 'RECOMMENDED');
const A = doc('A', 'Plan A', 'PLAN', 'APPROVED');
const B = doc('B', 'Plan B', 'PLAN', 'DRAFT');
const C = { ...doc('C', 'e3 notes', 'PLAN', 'APPROVED'), locationUrl: 'https://intranet.example/c' };
const att = (documentId: string, evidenceId: string, isPrimary: boolean) => ({ documentId, evidenceId, isPrimary, linkedAt: '', linkedBy: null });
const pd = {
  attachments: [att('A', 'ev-a', true)],
  expectations: [{ expectedId: 'e1', documentId: 'A' }, { expectedId: 'e2', documentId: 'B' }],
};
const rows = expectedStatus([e1, e2, e3], [A, B, C], pd, new Set(['ev-a']));
assert(rows[0].present && rows[0].state === 'PRESENT' && JSON.stringify(rows[0].satisfiedBy) === '["A"]', 'approved with a live primary copy and linked: present');
assert(!rows[1].present && rows[1].state === 'DRAFT_ONLY' && JSON.stringify(rows[1].satisfiedBy) === '["B"]', 'a draft that is linked: draft only, not present');
assert(!rows[2].present && rows[2].state === 'MISSING' && rows[2].satisfiedBy.length === 0, 'an approved document that is only suggested is missing, not present');
assert(JSON.stringify(presentCounts(rows)) === JSON.stringify({ present: 1, total: 2, recommendedPresent: 0, recommendedTotal: 1, overdue: 0 }), 'presentCounts: 1 of 2 expected present, 0 of 1 recommended', presentCounts(rows));
assert(rows[2].suggestions.length === 1 && rows[2].suggestions[0] === 'C', 'the matching approved document is offered as a suggestion for e3');
const rowsGone = expectedStatus([e1], [A], pd, new Set());
assert(!rowsGone[0].present && rowsGone[0].state === 'DRAFT_ONLY', 'the primary attachment no longer exists: not present');
const rowsLoc = expectedStatus([e3], [C], { attachments: [], expectations: [{ expectedId: 'e3', documentId: 'C' }] }, new Set());
assert(rowsLoc[0].present, 'approved with a location and no attachment: present');
const rowsNoCopy = expectedStatus([e3], [doc('C', 'x', 'PLAN', 'APPROVED')], { attachments: [], expectations: [{ expectedId: 'e3', documentId: 'C' }] }, new Set());
assert(!rowsNoCopy[0].present, 'approved with neither an attachment nor a location: not present');
const rowsRetired = expectedStatus([e1], [{ ...A, status: 'RETIRED' }], pd, new Set(['ev-a']));
assert(!rowsRetired[0].present && rowsRetired[0].state === 'MISSING' && rowsRetired[0].satisfiedBy.length === 0, 'a retired document does not satisfy an entry');
const rowsUnknown = expectedStatus([e1], [], pd, new Set(['ev-a']));
assert(rowsUnknown[0].state === 'MISSING', 'a link to a document that is not in the program list is ignored');
const overdueRows = expectedStatus([e1, e2], [{ ...A, reviewBy: '2026-11-18' }, { ...C, reviewBy: '2026-12-31' }], { attachments: [att('A', 'ev-a', true)], expectations: [{ expectedId: 'e1', documentId: 'A' }, { expectedId: 'e2', documentId: 'C' }] }, new Set(['ev-a']), '2026-11-19');
assert(overdueRows[0].overdue && !overdueRows[1].overdue && presentCounts(overdueRows).overdue === 1, 'overdue: present and past the review-by date, counted separately, still present');
assert(presentCounts(expectedStatus([e1], [{ ...A, reviewBy: '2026-11-18' }], pd, new Set(['ev-a']))).overdue === 0, 'without today nothing is overdue');
assert(presentCounts([]).total === 0 && presentCounts([]).present === 0, 'no rows, no counts');

console.log('\n--- E8: meta ---');
assert(c._meta.schemaVersion === 1 && c._meta.compiledBy === 'Pitch Black Cyber, LLC', 'schemaVersion is 1 and compiledBy is Pitch Black Cyber, LLC');
assert(/^\d{4}-\d{2}-\d{2}$/.test(c._meta.asOf) && !Number.isNaN(Date.parse(c._meta.asOf)), 'asOf is an ISO date', c._meta.asOf);
assert(c._meta.notice.includes('Not copied') && c._meta.notice.includes('Pitch Black Cyber'), 'the notice says the text is ours and not copied');
assert(c._meta.verified === false && /checked by a person/i.test(c._meta.reviewNote ?? ''), 'verified is false and the review note asks for a person to check each mapping');
assert(c._meta.method.length > 0, 'the method is stated');
// Validation catches bad data
const clone = () => JSON.parse(JSON.stringify(catalogJson)) as ExpectedDocumentCatalog;
const bad1 = clone();
bad1.frameworks.CMMC_L2![0].controls = ['NOT.A-CONTROL'];
assert(validateExpectedCatalog(bad1, idsByFramework).some((p) => p.includes('unknown or repeated control')), 'an unknown control id is reported');
const bad2 = clone();
bad2.frameworks.CMMC_L2![1].id = bad2.frameworks.CMMC_L2![0].id;
assert(validateExpectedCatalog(bad2, idsByFramework).some((p) => p.includes('repeats an id')), 'a repeated id is reported');
const bad3 = clone();
(bad3.frameworks.CMMC_L2![0] as { kind: string }).kind = 'policy';
assert(validateExpectedCatalog(bad3, idsByFramework).some((p) => p.includes('kind')), 'a kind outside the allowed set is reported');
const bad4 = clone();
bad4.frameworks.CMMC_L2![0].description = 'x'.repeat(161);
assert(validateExpectedCatalog(bad4, idsByFramework).some((p) => p.includes('description')), 'a description over 160 characters is reported');
const bad5 = clone();
bad5.frameworks.CMMC_L2![0].generator = { family: 'CA' };
assert(validateExpectedCatalog(bad5, idsByFramework).some((p) => p.includes('generator is only for policies')), 'a generator on a non-policy is reported');
const bad6 = clone();
bad6.frameworks.CMMC_L2![0].keywords = ['Mixed Case'];
assert(validateExpectedCatalog(bad6, idsByFramework).some((p) => p.includes('keywords')), 'a keyword that is not lowercase is reported');
const bad7 = clone();
bad7.frameworks.CMMC_L2![1].name = bad7.frameworks.CMMC_L2![0].name.toUpperCase();
assert(validateExpectedCatalog(bad7, idsByFramework).some((p) => p.includes('repeats a name')), 'a repeated name is reported, ignoring case');
assert(validateExpectedCatalog(null, idsByFramework).length > 0 && validateExpectedCatalog({ _meta: {}, frameworks: [] }, idsByFramework).length > 0, 'a non-catalog is reported');
assert(validateExpectedCatalog({ ...clone(), frameworks: { SOC_2_TYPE_II: [] } }, idsByFramework).some((p) => p.includes('not a known framework')), 'an unknown framework is reported');

console.log('\n--- E9: loading and the server copy ---');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const importers = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))]
  .filter((f) => /(?:from\s*|import\(\s*)['"][^'"]*expectedDocuments\.json['"]/.test(read(path.relative(root, f))))
  .map((f) => path.relative(root, f).replace(/\\/g, '/'))
  .sort();
assert(JSON.stringify(importers) === JSON.stringify(['server/documents/expectedCatalog.ts', 'src/data/documents/expectedDocumentsLazy.ts']), 'only the lazy loader and the server module import the JSON', importers);
const lazy = read('src/data/documents/expectedDocumentsLazy.ts');
assert(/import\('\.\/expectedDocuments\.json'\)/.test(lazy) && !/^import .*expectedDocuments\.json/m.test(lazy) && lazy.includes('loadExpectedDocuments'), 'the lazy loader uses a dynamic import behind a module-level promise');
assert(/loading \?\?= import\(/.test(lazy) && /loading = null;/.test(lazy) && /throw err;/.test(lazy), 'a failed load clears the cached promise (so a retry can succeed) and rethrows');
const lazyModule = lazy.indexOf('let loading');
assert(lazyModule >= 0 && lazy.indexOf('loading ??=') > lazyModule && !/const loading/.test(lazy), 'the cached promise is a module-level variable that can be reset');
const server = read('server/documents/expectedCatalog.ts');
assert(/^import catalog from '\.\.\/\.\.\/src\/data\/documents\/expectedDocuments\.json';/m.test(server) && !/import\(/.test(server), 'the server module imports the JSON statically');
assert(JSON.stringify(EXPECTED_CATALOG) === JSON.stringify(catalogJson), 'the server module exports the same catalog');
assert(EXPECTED_IDS.size === all.length && all.every((x) => EXPECTED_IDS.has(x.e.id)), 'EXPECTED_IDS holds every id');
assert(JSON.stringify(expectedFor('CMMC_L2')) === JSON.stringify(c.frameworks.CMMC_L2) && expectedFor('NOPE').length === 0, 'expectedFor returns a framework list, [] for an unknown framework');
assert(isKnownExpectedId('cmmc-l2-system-security-plan') && !isKnownExpectedId('nope') && !isKnownExpectedId(5), 'isKnownExpectedId accepts only catalog ids');
const vite = read('vite.config.ts');
assert(vite.includes("'expected-documents'"), 'vite.config.ts has an expected-documents chunk');
assert(vite.indexOf("'expected-documents'") < vite.indexOf('/src/data/telemetry/'), 'the expected-documents rule sits before the telemetry rule');
const mod = read('src/data/documents/expectedDocuments.ts');
assert(!/console\./.test(mod + lazy + server) && !/fetch\(/.test(mod + lazy + server), 'the catalog modules never log or fetch');
assert(!/localStorage|sessionStorage/.test(mod + lazy + server), 'the catalog modules use no browser storage');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
