import fs from 'fs';
import path from 'path';
import l2Json from '../src/data/cmmcGuide/cmmcL2Guide.generated.json';
import l1Json from '../src/data/cmmcGuide/cmmcL1Guide.generated.json';
import { CMMC_L1_GUIDE, CMMC_L2_GUIDE, CMMC_OBJECTIVE_CATALOG_REV, cmmcGuideTitle, cmmcNumberOf, guideObjectives, withGuideTitle } from '../src/data/cmmcGuide/guide';
import { cmmcCarryOver, cmmcCascadeLetters, cmmcCascadeSource, getControlObjectives, legacyObjectives, normalizeObjectiveText } from '../src/data/cmmcGuide/objectives';
import { controlStatusAfterCatalogUpdate, migrateCachedObjectives, objectiveStatusAfterCatalogUpdate } from '../src/data/cmmcGuide/migration';
import { validateGuideData } from '../src/data/cmmcGuide/validate';
import type { L1GuideFile, L2GuideFile } from '../src/data/cmmcGuide/validate';
import { buildGuideFiles, parseGuideLines } from '../scripts/generateCmmcObjectives';
import type { ParsedGuide } from '../scripts/generateCmmcObjectives';
import { FAR_L1_TO_800_171_MAP, NIST_800_171A_REGISTRY, getAssessmentObjectivesForControl } from '../src/data/frameworks/assessmentObjectives';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import type { AssessmentState } from '../src/types/cmmc';
import type { AssessmentObjective, ObjectiveStatus } from '../src/types/assessment';

/**
 * The CMMC Assessment Guide objectives (DoD CIO, v2.13): the generated data, the parser, the resolver that replaces the
 * platform's older CMMC objectives, the carry-over of the hand-written extras, and the migration of answers given before.
 * Does not boot the server.
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

const l2 = l2Json as unknown as L2GuideFile;
const l1 = l1Json as unknown as L1GuideFile;
const LETTERS = 'abcdefghijklmno';

console.log('--- The generated data ---');
assert(l2.meta.version === '2.13' && l1.meta.version === '2.13', 'G1: both guides are version 2.13', [l2.meta.version, l1.meta.version]);
assert(!/[\\/]/.test(l2.meta.sourceFile) && !/[\\/]/.test(l1.meta.sourceFile), 'G1: sourceFile is a base name', [l2.meta.sourceFile, l1.meta.sourceFile]);
assert(/^[0-9a-f]{64}$/.test(l2.meta.sha256) && /^[0-9a-f]{64}$/.test(l1.meta.sha256), 'G1: sha256 is 64 hex characters');
assert(l2.meta.distribution.startsWith('DISTRIBUTION STATEMENT A') && l1.meta.distribution.startsWith('DISTRIBUTION STATEMENT A'), 'G1: distribution statement A is recorded');
assert(l2.meta.documentNumber === 'DoD-CIO-00003' && l1.meta.documentNumber === 'DoD-CIO-00002' && l2.meta.date === 'September 2024', 'G1: document numbers and date', [l2.meta.documentNumber, l1.meta.documentNumber, l2.meta.date]);
const rawFiles = ['cmmcL2Guide.generated.json', 'cmmcL1Guide.generated.json'].map((f) => fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'cmmcGuide', f), 'utf8'));
assert(rawFiles.every((t) => !/[A-Za-z]:[\\/]|\/Users\/|\/home\//.test(t) && !t.includes('\r')), 'G1: no local path in the generated files, and LF line endings');

const l2Numbers = l2.requirements.map((r) => r.number);
const l2Total = l2.requirements.reduce((n, r) => n + r.objectives.length, 0);
assert(l2.requirements.length === 110 && l2Total === 320, 'G2: Level 2 has 110 requirements and 320 objectives', [l2.requirements.length, l2Total]);
assert(new Set(l2Numbers).size === 110 && l2.requirements.every((r) => r.id === `${r.family}.L2-${r.number}`), 'G2: numbers are unique and ids are family + number');

const EXPECTED_COUNTS = '3.1.1=6 3.1.2=2 3.1.3=5 3.1.4=3 3.1.5=4 3.1.6=2 3.1.7=4 3.1.8=2 3.1.9=2 3.1.10=3 3.1.11=2 3.1.12=4 3.1.13=2 3.1.14=2 3.1.15=4 3.1.16=2 3.1.17=2 3.1.18=3 3.1.19=2 3.1.20=6 3.1.21=3 3.1.22=5 3.2.1=4 3.2.2=3 3.2.3=2 3.3.1=6 3.3.2=2 3.3.3=3 3.3.4=3 3.3.5=2 3.3.6=2 3.3.7=3 3.3.8=6 3.3.9=2 3.4.1=6 3.4.2=2 3.4.3=4 3.4.4=1 3.4.5=8 3.4.6=2 3.4.7=15 3.4.8=3 3.4.9=3 3.5.1=3 3.5.2=3 3.5.3=4 3.5.4=1 3.5.5=2 3.5.6=2 3.5.7=4 3.5.8=2 3.5.9=1 3.5.10=2 3.5.11=1 3.6.1=7 3.6.2=6 3.6.3=1 3.7.1=1 3.7.2=4 3.7.3=1 3.7.4=1 3.7.5=2 3.7.6=1 3.8.1=4 3.8.2=1 3.8.3=2 3.8.4=2 3.8.5=2 3.8.6=1 3.8.7=1 3.8.8=1 3.8.9=1 3.9.1=1 3.9.2=3 3.10.1=4 3.10.2=4 3.10.3=2 3.10.4=1 3.10.5=3 3.10.6=2 3.11.1=2 3.11.2=5 3.11.3=2 3.12.1=2 3.12.2=3 3.12.3=1 3.12.4=8 3.13.1=8 3.13.2=6 3.13.3=3 3.13.4=1 3.13.5=2 3.13.6=2 3.13.7=1 3.13.8=3 3.13.9=3 3.13.10=2 3.13.11=1 3.13.12=3 3.13.13=2 3.13.14=2 3.13.15=1 3.13.16=1 3.14.1=6 3.14.2=2 3.14.3=3 3.14.4=1 3.14.5=3 3.14.6=3 3.14.7=2'.split(' ');
const expectedCounts = Object.fromEntries(EXPECTED_COUNTS.map((e) => e.split('=')).map(([k, v]) => [k, Number(v)]));
const actualCounts = Object.fromEntries(l2.requirements.map((r) => [r.number, r.objectives.length]));
assert(Object.keys(expectedCounts).length === 110 && same(actualCounts, expectedCounts), 'G3: the objective count of every one of the 110 requirements', Object.keys(actualCounts).filter((k) => actualCounts[k] !== expectedCounts[k]));
assert(Object.values(expectedCounts).reduce((a, b) => a + b, 0) === 320, 'G3: the expected counts sum to 320');

const badLetters = [...l2.requirements, ...l1.requirements].filter((r) => r.objectives.map((o) => o.letter).join('') !== LETTERS.slice(0, r.objectives.length));
assert(badLetters.length === 0, 'G4: letters are contiguous from a for every Level 1 and Level 2 requirement', badLetters.map((r) => r.id));

const badTexts = [...l2.requirements, ...l1.requirements].flatMap((r) => r.objectives.map((o) => ({ id: `${r.id}[${o.letter}]`, text: o.text }))).filter(({ text }) => !text || /[;.]$/.test(text) || / (and|or)$/.test(text) || text.includes('Determine if') || /[a-z]- [a-z]/.test(text));
assert(badTexts.length === 0, 'G5: every objective text is clean (no trailing ; . and or, no "Determine if", no split hyphen)', badTexts.slice(0, 5));

const l1Total = l1.requirements.reduce((n, r) => n + r.objectives.length, 0);
assert(l1.requirements.length === 15 && l1Total === 59, 'G6: Level 1 has 15 requirements and 59 objectives', [l1.requirements.length, l1Total]);
assert(l1.requirements.every((r) => /^[A-Z]{2}\.L1-b\.1\.[ivx]+$/.test(r.id)), 'G6: Level 1 ids are family.L1-b.1.<roman>');
assert(new Set(l1.requirements.flatMap((r) => r.numbers)).size === 17, 'G6: the Level 1 requirements cover 17 numbers', [...new Set(l1.requirements.flatMap((r) => r.numbers))]);
assert(same(l1.requirements.find((r) => r.id === 'PE.L1-b.1.ix')?.numbers, ['3.10.3', '3.10.4', '3.10.5']), 'G6: PE.L1-b.1.ix names 3.10.3, 3.10.4 and 3.10.5');
const EXPECTED_L1 = 'i=6 ii=2 iii=6 iv=5 v=3 vi=3 vii=2 viii=4 ix=6 x=8 xi=2 xii=6 xiii=2 xiv=1 xv=3'.split(' ').map((e) => e.split('='));
assert(same(l1.requirements.map((r) => [r.far.replace('b.1.', ''), String(r.objectives.length)]), EXPECTED_L1), 'G6: the objective count of every Level 1 requirement', l1.requirements.map((r) => r.far + '=' + r.objectives.length));

const l2ByNumber = new Map(l2.requirements.map((r) => [r.number, r]));
const l1Numbers = [...new Set(l1.requirements.flatMap((r) => r.numbers))];
const sameLetters = l1Numbers.every((n) => same(l1.requirements.flatMap((r) => r.objectives).filter((o) => o.number === n).map((o) => o.numberLetter).sort(), l2ByNumber.get(n)!.objectives.map((o) => o.letter)));
assert(sameLetters, 'G7: for each of the 17 numbers the Level 1 letters equal the Level 2 letters');
const differing: string[] = [];
for (const r of l1.requirements) {
  for (const o of r.objectives) {
    const t2 = l2ByNumber.get(o.number)!.objectives.find((x) => x.letter === o.numberLetter)!.text;
    if (o.text !== t2) {
      differing.push(`${o.number}${o.numberLetter}`);
      assert(o.text === t2.replace(/\bCUI\b/g, '[FCI]'), `G7: ${o.number}[${o.numberLetter}] differs from Level 2 only by CUI -> [FCI]`);
    }
  }
}
assert(same(differing.sort(), ['3.1.22b', '3.1.22d', '3.1.22e', '3.8.3a', '3.8.3b']), 'G7: the only Level 1 texts that differ are 3.1.22 b, d, e and 3.8.3 a, b', differing);

const problems = validateGuideData(l2, l1);
assert(problems.length === 0, 'G8: validateGuideData accepts the committed files', problems.slice(0, 5));
const broken: L2GuideFile = JSON.parse(JSON.stringify(l2));
broken.requirements.find((r) => r.number === '3.1.1')!.objectives.pop();
const brokenProblems = validateGuideData(broken, l1);
assert(brokenProblems.length > 0 && brokenProblems.some((p) => p.includes('3.1.1')), 'G8: a Level 2 copy without 3.1.1[f] is reported, naming 3.1.1', brokenProblems.slice(0, 3));
const garbled: L2GuideFile = JSON.parse(JSON.stringify(l2));
garbled.requirements[0].displayTitle = 'RIsk Assessments';
assert(validateGuideData(garbled, l1).some((p) => p.includes('displayTitle')), 'G8: a garbled display title is reported');
const absolute: L2GuideFile = JSON.parse(JSON.stringify(l2));
absolute.meta.sourceFile = 'C:\\Users\\x\\guide.pdf';
assert(validateGuideData(absolute, l1).some((p) => p.includes('sourceFile')), 'G8: a path in meta.sourceFile is reported');

console.log('\n--- Titles ---');
assert(cmmcGuideTitle('AC.L2-3.1.3') === 'Control CUI Flow', 'G9: AC.L2-3.1.3', cmmcGuideTitle('AC.L2-3.1.3'));
assert(cmmcGuideTitle('AC.L1-3.1.1') === 'Authorized Access Control', 'G9: AC.L1-3.1.1 gets the Level 2 title', cmmcGuideTitle('AC.L1-3.1.1'));
assert(cmmcGuideTitle('RA.L2-3.11.1') === 'Risk Assessments', 'G9: RA.L2-3.11.1 (extraction fix-up)', cmmcGuideTitle('RA.L2-3.11.1'));
assert(cmmcGuideTitle('CA.L2-3.12.2') === 'Operational Plan of Action', 'G9: CA.L2-3.12.2 (extraction fix-up)', cmmcGuideTitle('CA.L2-3.12.2'));
assert(cmmcGuideTitle('MP.L2-3.8.7') === 'Removeable Media', 'G9: MP.L2-3.8.7 keeps the guide\'s own spelling', cmmcGuideTitle('MP.L2-3.8.7'));
assert(cmmcGuideTitle('SI.L1-3.14.2') !== undefined && !/\[(CUI|FCI) Data\]/.test(cmmcGuideTitle('SI.L1-3.14.2') ?? ''), 'G9: no [CUI Data] / [FCI Data] tag in a display title');
assert(cmmcGuideTitle('AC-2') === undefined && cmmcGuideTitle('3.1.1') === undefined, 'G9: a non-CMMC id has no guide title');
const l2Controls = getFrameworkControls('CMMC_L2');
const l1Controls = getFrameworkControls('CMMC_L1');
assert(l2Controls.find((c) => c.id === 'AC.L2-3.1.3')?.title === 'Information Flow Enforcement' && l2Controls.find((c) => c.id === 'AC.L1-3.1.1')?.title === 'Authorized System Access', 'G9: the catalogs are untouched (the SSP import still sees the catalog titles)');
const ctl = l2Controls.find((c) => c.id === 'AC.L2-3.1.3')!;
assert(withGuideTitle(ctl).title === 'Control CUI Flow' && ctl.title === 'Information Flow Enforcement' && withGuideTitle(ctl).id === ctl.id, 'G9: withGuideTitle returns a copy and leaves the catalog entry alone');
const nonCmmc = { id: 'AC-2', title: 'Account Management' };
assert(withGuideTitle(nonCmmc) === nonCmmc, 'G9: withGuideTitle leaves a non-CMMC control unchanged');

console.log('\n--- The resolver ---');
let resolvedTotal = 0;
let resolverOk = true;
const resolverBad: string[] = [];
for (const c of l2Controls) {
  const n = cmmcNumberOf(c.id)!;
  const got = getControlObjectives(c.id, c.title, c.assessmentObjectives, undefined, 'CMMC_L2');
  const want = l2ByNumber.get(n)!.objectives;
  resolvedTotal += got.length;
  if (!same(got.map((o) => o.id), want.map((o) => `${c.id}[${o.letter}]`)) || !same(got.map((o) => o.text), want.map((o) => o.text))) {
    resolverOk = false;
    resolverBad.push(c.id);
  }
}
assert(resolverOk, 'G10: every Level 2 control resolves to its guide letters and texts', resolverBad.slice(0, 5));
assert(resolvedTotal === 320, 'G10: the Level 2 catalog resolves to 320 objectives', resolvedTotal);
const ac311 = getControlObjectives('AC.L1-3.1.1', undefined, undefined, undefined, 'CMMC_L2');
assert(same(ac311.map((o) => o.letter), ['a', 'b', 'c', 'd', 'e', 'f']), 'G10: AC.L1-3.1.1 in a Level 2 program shows a-f', ac311.map((o) => o.letter));
assert(getControlObjectives('CA.L2-3.12.4', undefined, undefined, undefined, 'CMMC_L2').map((o) => o.letter).join('') === 'abcdefgh', 'G10: CA.L2-3.12.4 shows a-h');

const l1Resolved = l1Controls.reduce((n, c) => n + getControlObjectives(c.id, c.title, c.assessmentObjectives, undefined, 'CMMC_L1').length, 0);
assert(l1Resolved === 59, 'G11: the Level 1 catalog resolves to 59 objectives', l1Resolved);
const pe104 = getControlObjectives('PE.L1-3.10.4', undefined, undefined, undefined, 'CMMC_L1');
assert(pe104.length === 1 && pe104[0].text === 'audit logs of physical access are maintained', 'G11: PE.L1-3.10.4 is one objective', pe104.map((o) => o.text));
assert(getControlObjectives('MP.L1-3.8.3', undefined, undefined, undefined, 'CMMC_L1')[0].text.includes('[FCI]'), 'G11: MP.L1-3.8.3[a] says [FCI] in a Level 1 program');
assert(getControlObjectives('MP.L1-3.8.3', undefined, undefined, undefined, 'CMMC_L2')[0].text.includes('CUI'), 'G11: MP.L1-3.8.3[a] says CUI in a Level 2 program');
assert(same(guideObjectives('3.8.3', 'CMMC_L1').map((o) => o.letter), ['a', 'b']) && guideObjectives('3.99.9', 'CMMC_L2').length === 0, 'G11: guideObjectives by framework, and none for an unknown number');

const l2Ids = l2Controls.map((c) => c.id);
const l1Ids = l1Controls.map((c) => c.id);
assert(l2Ids.length === 110 && l2Ids.every((id) => cmmcNumberOf(id) !== null), 'G12: cmmcNumberOf resolves all 110 Level 2 control ids');
assert(l1Ids.length === 17 && l1Ids.every((id) => cmmcNumberOf(id) !== null), 'G12: cmmcNumberOf resolves all 17 Level 1 control ids', l1Ids.filter((id) => cmmcNumberOf(id) === null));
assert(cmmcNumberOf('3.1.1') === null && cmmcNumberOf('AC.L1-b.1.i') === null && cmmcNumberOf('AC.L2-3.99.9') === null && cmmcNumberOf('AC-2') === null, 'G12: bare numbers, FAR ids, unknown numbers and other frameworks are not CMMC ids');
const fallbacks = [...l2Ids.flatMap((id) => getControlObjectives(id, undefined, undefined, undefined, 'CMMC_L2')), ...l1Ids.flatMap((id) => getControlObjectives(id, undefined, undefined, undefined, 'CMMC_L1'))].filter((o) => /^the (defined )?requirements for /.test(o.text));
assert(fallbacks.length === 0, 'G12: no CMMC control reaches the generic fallback', fallbacks.slice(0, 3).map((o) => o.id));

const soc2 = getFrameworkControls('SOC_2_TYPE_II')[0].id;
const hipaa = getFrameworkControls('HIPAA_SECURITY')[0].id;
for (const id of ['AC-2', 'CA-7(4)', soc2, hipaa, 'UNKNOWN-1']) {
  assert(same(getControlObjectives(id, 'Title', ['Determine if x is done'], undefined, 'NIST_800_53_REV5'), getAssessmentObjectivesForControl(id, 'Title', ['Determine if x is done'])) && same(getControlObjectives(id), getAssessmentObjectivesForControl(id)), `G13: ${id} resolves exactly as the frozen resolver`);
}

console.log('\n--- Carry-over of the hand-written extras ---');
const idx = (id: string, l: string, fw = 'CMMC_L2') => getControlObjectives(id, undefined, undefined, undefined, fw).find((o) => o.letter === l)!;
assert(idx('AC.L2-3.1.7', 'c').prefilledTemplate === NIST_800_171A_REGISTRY['3.1.7'].objectives[1].prefilledTemplate, 'G14: AC.L2-3.1.7[c] carries the template of the registry\'s 3.1.7[b]');
const a317 = idx('AC.L2-3.1.7', 'a');
assert(a317.scapRuleId === undefined && a317.isAutoVerifiedByTelemetry === false && a317.odpParameters === undefined, 'G14: AC.L2-3.1.7[a] carries nothing');
assert(a317.prefilledTemplate.startsWith('The enclave implementation satisfies requirement 3.1.7[a] ('), 'G14: a letter with nothing carried gets the generic wording', a317.prefilledTemplate.slice(0, 60));
assert(idx('AC.L1-3.1.1', 'a').scapRuleId === 'account_unique_id', 'G14: AC.L1-3.1.1[a] keeps the FAR entry\'s scapRuleId', idx('AC.L1-3.1.1', 'a').scapRuleId);
assert(idx('AC.L1-3.1.1', 'f').scapRuleId === 'wireless_disable_interfaces', 'G14: AC.L1-3.1.1[f] takes its scapRuleId from the 3.1.1 entry', idx('AC.L1-3.1.1', 'f').scapRuleId);
const r31311 = NIST_800_171A_REGISTRY['3.13.11'].objectives.find((o) => o.letter === 'a')!;
assert(idx('SC.L2-3.13.11', 'a').prefilledTemplate === r31311.prefilledTemplate, 'G14: SC.L2-3.13.11[a] carries the registry template');

// an independent count of the Level 2 objectives that keep a hand-written template
const norm = (s: string) => s.toLowerCase().replace(/federal contract information/g, 'fci').replace(/controlled unclassified information/g, 'cui').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
let carried = 0;
for (const c of l2Controls) {
  const n = cmmcNumberOf(c.id)!;
  const farKey = FAR_L1_TO_800_171_MAP[c.id.toLowerCase()] ?? FAR_L1_TO_800_171_MAP[n];
  const sources = [...new Set([farKey, n].filter((k): k is string => Boolean(k && NIST_800_171A_REGISTRY[k])))].map((k) => NIST_800_171A_REGISTRY[k].objectives);
  for (const g of l2ByNumber.get(n)!.objectives) {
    for (const objs of sources) {
      const hits = objs.filter((o) => norm(o.text) === norm(g.text));
      if (hits.length === 1) {
        carried++;
        break;
      }
    }
  }
}
const carriedByModule = l2Controls.reduce((n, c) => n + Object.keys(cmmcCarryOver(c.id, 'CMMC_L2')).length, 0);
console.log(`  (Level 2 objectives that carry a hand-written template: ${carriedByModule} of 320)`);
assert(carried === carriedByModule && carried > 0 && carried < 320, 'G14: the number of carried Level 2 objectives equals an independent count', [carried, carriedByModule]);

const store: Record<string, AssessmentObjective> = {
  'AC.L2-3.1.8[a]': {
    id: 'AC.L2-3.1.8[a]', controlId: 'AC.L2-3.1.8', letter: 'a', text: 'old text', status: 'MET', prefilledTemplate: 'old', implementationNarrative: 'kept', linkedEvidenceIds: ['ev'],
    isAutoVerifiedByTelemetry: true, scapRuleId: 'x', odpParameters: [{ id: 'ac_3_1_8_attempts', label: 'Attempts', defaultValue: '3' }],
  },
};
const g15 = getControlObjectives('AC.L2-3.1.8', undefined, undefined, store, 'CMMC_L2')[0];
assert(g15.odpParameters === undefined && g15.scapRuleId === undefined && g15.isAutoVerifiedByTelemetry === false && g15.status === 'MET' && g15.text === l2ByNumber.get('3.1.8')!.objectives[0].text, 'G15: stale cached extras are dropped, the answer and the guide text are kept');
assert(g15.implementationNarrative === 'kept' && same(g15.linkedEvidenceIds, ['ev']), 'G15: the narrative and evidence of a stored record are kept');
assert(store['AC.L2-3.1.8[a]'].text === 'old text', 'G15: the stored record is not mutated');

assert(same(cmmcCascadeSource('AC.L2-3.1.7', 'c', 'CMMC_L2'), { key: '3.1.7', letter: 'b' }), 'G16: cmmcCascadeSource AC.L2-3.1.7[c]', cmmcCascadeSource('AC.L2-3.1.7', 'c', 'CMMC_L2'));
assert(cmmcCascadeSource('AC.L2-3.1.8', 'a', 'CMMC_L2') === null, 'G16: cmmcCascadeSource AC.L2-3.1.8[a] is null');
assert(same(cmmcCascadeLetters('AC.L2-3.1.7', 'CMMC_L2'), ['c', 'd']) || cmmcCascadeLetters('AC.L2-3.1.7', 'CMMC_L2').includes('c'), 'G16: cmmcCascadeLetters lists the carried letters', cmmcCascadeLetters('AC.L2-3.1.7', 'CMMC_L2'));
assert(cmmcCascadeLetters('AC-2', 'CMMC_L2').length === 0, 'G16: a non-CMMC id carries nothing');

console.log('\n--- Migration rule R ---');
const R = objectiveStatusAfterCatalogUpdate;
assert(R('AC.L1-3.1.2[a]', 'MET', 'CMMC_L2') === 'MET', 'G17: AC.L1-3.1.2[a] Met keeps its meaning', R('AC.L1-3.1.2[a]', 'MET', 'CMMC_L2'));
assert(R('AC.L2-3.1.8[a]', 'MET', 'CMMC_L2') === 'IN_PROGRESS', 'G17: AC.L2-3.1.8[a] Met changed meaning');
assert(R('AC.L2-3.1.8[c]', 'MET', 'CMMC_L2') === 'IN_PROGRESS', 'G17: AC.L2-3.1.8[c] Met, the letter no longer exists');
assert(R('CA.L2-3.12.4[a]', 'NOT_APPLICABLE', 'CMMC_L2') === 'IN_PROGRESS', 'G17: CA.L2-3.12.4[a] Not applicable');
for (const s of ['NOT_MET', 'IN_PROGRESS', 'NOT_STARTED'] as ObjectiveStatus[]) assert(R('AC.L2-3.1.8[a]', s, 'CMMC_L2') === s, `G17: ${s} is kept`);
assert(R('AC.L2-3.1.7[b]', 'MET', 'CMMC_L2') === 'IN_PROGRESS', 'G17: AC.L2-3.1.7[b] Met, its text moved to [c] (no re-keying)');
assert(R('MP.L1-3.8.3[a]', 'MET', 'CMMC_L1') === 'MET', 'G17: MP.L1-3.8.3[a] Met in a Level 1 program', R('MP.L1-3.8.3[a]', 'MET', 'CMMC_L1'));
assert(R('MP.L1-3.8.3[a]', 'MET', 'CMMC_L2') === 'IN_PROGRESS', 'G17: MP.L1-3.8.3[a] Met in a Level 2 program');
assert(R('AC-2[a]', 'MET', 'NIST_800_53_REV5') === 'MET' && R('not an objective id', 'MET', 'CMMC_L2') === 'MET', 'G17: other ids are unchanged');
assert(legacyObjectives('AC.L2-3.1.8', 'CMMC_L2').length > 0 && legacyObjectives('AC.L1-3.1.1', 'CMMC_L2').length === 4, 'G17: legacyObjectives is what users saw (AC.L1-3.1.1 showed the FAR a-d)', legacyObjectives('AC.L1-3.1.1', 'CMMC_L2').length);

console.log('\n--- Control rule C ---');
const C = controlStatusAfterCatalogUpdate;
assert(C('CA.L2-3.12.4', 'MET', { 'CA.L2-3.12.4[a]': 'IN_PROGRESS' }, 'CMMC_L2') === 'IN_PROGRESS', 'G18: CA.L2-3.12.4 Met with an In progress objective');
assert(C('AC.L1-3.1.2', 'MET', { 'AC.L1-3.1.2[a]': 'MET', 'AC.L1-3.1.2[b]': 'MET' }, 'CMMC_L2') === 'MET', 'G18: AC.L1-3.1.2 with both letters Met stays Met');
assert(C('AC.L2-3.1.5', 'MET', {}, 'CMMC_L2') === 'MET', 'G18: a Met control with no stored objective answers stays Met');
assert(C('AC.L2-3.1.5', 'MET', { 'AC.L2-3.1.4[a]': 'IN_PROGRESS' }, 'CMMC_L2') === 'MET', 'G18: answers of another control do not count');
assert(C('AC.L2-3.1.4', 'MET', { 'AC.L2-3.1.4[a]': 'MET' }, 'CMMC_L2') === 'IN_PROGRESS', 'G18: AC.L2-3.1.4 with one of three letters answered');
assert(C('AC.L2-3.1.4', 'NOT_MET', { 'AC.L2-3.1.4[a]': 'MET' }, 'CMMC_L2') === 'NOT_MET', 'G18: Not met is kept');
assert(C('AC.L2-3.1.4', 'IN_PROGRESS', { 'AC.L2-3.1.4[a]': 'MET', 'AC.L2-3.1.4[b]': 'MET', 'AC.L2-3.1.4[c]': 'MET' }, 'CMMC_L2') === 'IN_PROGRESS', 'G18: a status is never upgraded');
assert(C('AC-2', 'MET', { 'AC-2[a]': 'IN_PROGRESS' }, 'NIST_800_53_REV5') === 'MET', 'G18: a non-CMMC control is unchanged');

console.log('\n--- Migrating a cached state ---');
const obj = (id: string, status: ObjectiveStatus, extra: Partial<AssessmentObjective> = {}): AssessmentObjective => ({
  id, controlId: id.replace(/\[.*$/, ''), letter: id.replace(/^.*\[|\]$/g, ''), text: 't', status, prefilledTemplate: '', implementationNarrative: '', linkedEvidenceIds: [], isAutoVerifiedByTelemetry: false, ...extra,
});
const ctrl = (id: string, status: 'MET' | 'IN_PROGRESS') => ({ id, status, implementationNotes: '', responsibleRole: '', lastUpdated: '', tags: [] });
const cached = {
  programId: 'p',
  controls: { 'AC.L1-3.1.1': ctrl('AC.L1-3.1.1', 'MET'), 'CA.L2-3.12.4': ctrl('CA.L2-3.12.4', 'MET'), 'AC.L2-3.1.5': ctrl('AC.L2-3.1.5', 'MET') },
  objectives: {
    'AC.L1-3.1.1[a]': obj('AC.L1-3.1.1[a]', 'MET'),
    'AC.L1-3.1.1[c]': obj('AC.L1-3.1.1[c]', 'MET'),
    'CA.L2-3.12.4[a]': obj('CA.L2-3.12.4[a]', 'MET', { implementationNarrative: 'N', linkedEvidenceIds: ['ev1'] }),
    'AC-2[a]': obj('AC-2[a]', 'MET'),
  },
} as unknown as AssessmentState;
const before = JSON.stringify(cached);
const m = migrateCachedObjectives(cached, 'CMMC_L2');
const mo = m.state.objectives!;
assert(mo['AC.L1-3.1.1[a]'].status === 'MET', 'G19: AC.L1-3.1.1[a] stays Met');
assert(mo['AC.L1-3.1.1[c]'].status === 'IN_PROGRESS', 'G19: AC.L1-3.1.1[c] ("connect to systems" vs "connect to the system") becomes In progress', mo['AC.L1-3.1.1[c]'].status);
assert(mo['CA.L2-3.12.4[a]'].status === 'IN_PROGRESS' && mo['CA.L2-3.12.4[a]'].implementationNarrative === 'N' && same(mo['CA.L2-3.12.4[a]'].linkedEvidenceIds, ['ev1']), 'G19: CA.L2-3.12.4[a] becomes In progress, narrative and evidence untouched');
assert(mo['AC-2[a]'].status === 'MET', 'G19: another framework\'s objective is untouched');
assert(m.state.controls['AC.L1-3.1.1'].status === 'IN_PROGRESS' && m.state.controls['CA.L2-3.12.4'].status === 'IN_PROGRESS' && m.state.controls['AC.L2-3.1.5'].status === 'MET', 'G19: controls are re-rolled: two lowered, the one with no answers kept', Object.values(m.state.controls).map((c) => c.status));
assert(m.state.objectivesCatalogRev === CMMC_OBJECTIVE_CATALOG_REV && CMMC_OBJECTIVE_CATALOG_REV === 'cmmc-ag-2.13', 'G19: the state is stamped with the catalog revision');
assert(m.changedObjectives.length === 2 && m.changedControls.length === 2, 'G19: two objectives and two controls changed', [m.changedObjectives.length, m.changedControls.length]);
assert(!JSON.stringify({ o: m.changedObjectives, c: m.changedControls }).includes('N"') && Object.keys(m.changedObjectives[0]).sort().join() === 'from,id,to', 'G19: the change lists hold ids and statuses only');
assert(JSON.stringify(cached) === before, 'G19: the input state is not mutated');

const again = migrateCachedObjectives(m.state, 'CMMC_L2');
assert(again.changedObjectives.length === 0 && again.changedControls.length === 0 && same(again.state, m.state), 'G20: a second migration changes nothing');
const stamped = { ...cached, objectivesCatalogRev: CMMC_OBJECTIVE_CATALOG_REV, objectives: { 'AC.L2-3.1.8[a]': obj('AC.L2-3.1.8[a]', 'MET') } } as unknown as AssessmentState;
assert(migrateCachedObjectives(stamped, 'CMMC_L2').state.objectives!['AC.L2-3.1.8[a]'].status === 'MET', 'G20: a state already at the current revision keeps its Met');
const nist = migrateCachedObjectives(cached, 'NIST_800_53_REV5');
assert(nist.state === cached && nist.changedObjectives.length === 0, 'G20: a non-CMMC program is not touched');
assert(migrateCachedObjectives({ ...cached, objectives: undefined } as unknown as AssessmentState, 'CMMC_L2').state.controls['CA.L2-3.12.4'].status === 'MET', 'G20: a Met control with no stored objectives keeps its status');

console.log('\n--- The parser ---');
const lines = (f: string) => fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', f), 'utf8').split(/\r?\n/);
const fx2 = lines('cmmcGuideL2Excerpt.txt');
const fx1 = lines('cmmcGuideL1Excerpt.txt');
const p2 = parseGuideLines(fx2);
assert(same(p2, parseGuideLines(fx2)), 'G21: parsing is deterministic');
assert(same(p2.requirements.map((r) => r.id), ['AC.L2-3.1.1', 'AC.L2-3.1.2', 'AT.L2-3.2.2']) && p2.level === 2 && p2.version === '2.13', 'G21: the excerpt has 3.1.1, 3.1.2 and 3.2.2, Level 2, version 2.13', [p2.requirements.map((r) => r.id), p2.level, p2.version]);
const r311 = p2.requirements[0];
assert(r311.number === '3.1.1' && r311.family === 'AC' && r311.title === 'Authorized Access Control [CUI Data]' && r311.statement === 'Limit system access to authorized users, processes acting on behalf of authorized users, and devices (including other systems).', 'G21: 3.1.1 title and statement', [r311.title, r311.statement]);
assert(same(r311.objectives.map((o) => o.text), [
  'authorized users are identified',
  'processes acting on behalf of authorized users are identified',
  'devices (and other systems) authorized to connect to the system are identified',
  'system access is limited to authorized users',
  'system access is limited to processes acting on behalf of authorized users',
  'system access is limited to authorized devices (including other systems)',
]), 'G21: the six exact objective texts of 3.1.1');
assert(p2.requirements[1].objectives[0].text === 'the types of transactions and functions that authorized users are permitted to execute are defined', 'G21: AC.L2-3.1.2[a] joins its wrapped line', p2.requirements[1].objectives[0].text);
assert(p2.requirements[2].objectives[2].text.includes('security-related') && !p2.requirements[2].objectives[2].text.includes('- '), 'G21: AT.L2-3.2.2[c] joins "security-" and "related"', p2.requirements[2].objectives[2].text);
assert(p2.requirements.every((r) => !/CMMC Assessment Guide|=== page|NIST SP 800-171A, p/.test(r.statement) && !/(^| )\d{1,3}$/.test(r.statement)), 'G21: no footnote or footer line in a statement');
assert(same(r311.numbers, ['3.1.1']) && same(p2.requirements[1].numbers, ['3.1.2']), 'G21: Level 2 numbers come from the id and KEY REFERENCES');
const p1 = parseGuideLines(fx1);
assert(p1.requirements.length === 1 && p1.requirements[0].id === 'PE.L1-b.1.ix' && p1.requirements[0].far === 'b.1.ix' && p1.level === 1, 'G21: the Level 1 excerpt is PE.L1-b.1.ix', p1.requirements.map((r) => r.id));
assert(same(p1.requirements[0].numbers, ['3.10.3', '3.10.4', '3.10.5']) && p1.requirements[0].objectives.length === 6, 'G21: PE.L1-b.1.ix KEY REFERENCES give 3.10.3, 3.10.4, 3.10.5 and six objectives', p1.requirements[0].numbers);
assert(p1.requirements[0].objectives[2].text === 'audit logs of physical access are maintained', 'G21: PE.L1-b.1.ix[c]');

const throws = (f: () => unknown): string => {
  try {
    f();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
assert(parseGuideLines(fx2.map((l) => (l === '[a] authorized users are identified;' ? '[a] authorized users are identified and' : l))).requirements[0].objectives[0].text === 'authorized users are identified', 'G21: an "and" printed without its semicolon is dropped (IA.L2-3.5.8[a])');
assert(throws(() => parseGuideLines(fx2.map((l) => l.replace(/^\[c\] personnel are adequately/, '[d] personnel are adequately')))).includes('not contiguous'), 'G21: non-contiguous letters throw');
assert(throws(() => parseGuideLines([...fx2, ...fx2])).includes('duplicate'), 'G21: a duplicate requirement throws');
assert(throws(() => parseGuideLines(fx2.map((l) => l.replace(/Level 2 \| Version 2\.13 14$/, 'Level 2 | Version 2.12 14')))).includes('disagree'), 'G21: footers that disagree on the version throw');
assert(throws(() => parseGuideLines(fx2.map((l) => l.replace(/^\[a\] authorized users are identified;$/, 'authorized users are identified;')))).length > 0, 'G21: text before the first letter throws');
assert(throws(() => parseGuideLines(fx2.map((l) => (l === '[c] devices (and other systems) authorized to connect to the system are identified;' ? '[c]' : l)))).includes('empty'), 'G21: an empty objective throws');
assert(throws(() => parseGuideLines(['nothing here'])).length > 0, 'G21: no requirements throws');
assert(throws(() => parseGuideLines(fx2.map((l) => l.replace('• NIST SP 800-171 Rev. 2 3.2.2', '• NIST SP 800-171 Rev. 2 3.2.3')))).includes('KEY REFERENCES'), 'G21: Level 2 KEY REFERENCES that name another number throw');

console.log('\n--- buildGuideFiles ---');
const cover = { version: '2.13', date: 'September 2024', documentNumber: 'DoD-CIO-00003', distribution: 'DISTRIBUTION STATEMENT A. Approved for public release. Distribution is unlimited.', pages: 10 };
const mk = (level: 1 | 2, requirements: ParsedGuide['requirements']): ParsedGuide => ({ level, ...cover, requirements });
const src = { l2: { file: 'C:\\somewhere\\L2.pdf', sha256: 'a'.repeat(64) }, l1: { file: '/somewhere/L1.pdf', sha256: 'b'.repeat(64) } };
const req2 = (number: string, texts: string[]) => ({ id: `AC.L2-${number}`, family: 'AC', number, title: 'Some Title [CUI Data]', statement: 's', numbers: [number], objectives: texts.map((t, i) => ({ letter: LETTERS[i], text: t })) });
const req1 = (texts: string[]) => ({ id: 'AC.L1-b.1.i', family: 'AC', far: 'b.1.i', title: 'Some Title [FCI Data]', statement: 's', numbers: ['3.1.1', '3.1.2'], objectives: texts.map((t, i) => ({ letter: LETTERS[i], text: t })) });
const built = buildGuideFiles(mk(2, [req2('3.1.1', ['CUI is protected', 'access is limited']), req2('3.1.2', ['logs are kept'])]), mk(1, [req1(['[FCI] is protected', 'logs are kept'])]), src);
assert(built.l2.meta.sourceFile === 'L2.pdf' && built.l1.meta.sourceFile === 'L1.pdf', 'G21: only the base name of a Windows or POSIX path is stored', [built.l2.meta.sourceFile, built.l1.meta.sourceFile]);
assert(same(built.l1.requirements[0].objectives.map((o) => [o.number, o.numberLetter]), [['3.1.1', 'a'], ['3.1.2', 'a']]), 'G21: a Level 1 objective is tied to its Level 2 number and letter (CUI treated as [FCI])');
assert(built.l2.requirements[0].displayTitle === 'Some Title' && built.l2.meta.document === 'CMMC Assessment Guide \u2013 Level 2', 'G21: displayTitle drops the tag, meta.document names the level');
assert(throws(() => buildGuideFiles(mk(2, [req2('3.1.1', ['CUI is protected']), req2('3.1.2', ['logs are kept'])]), mk(1, [req1(['nothing like it'])]), src)).includes('matches 0'), 'G21: a Level 1 objective that matches no Level 2 objective throws');
assert(throws(() => buildGuideFiles(mk(2, [req2('3.1.1', ['logs are kept']), req2('3.1.2', ['the logs are kept'])]), mk(1, [req1(['logs are kept'])]), src)).includes('matches 2'), 'G21: a Level 1 objective that matches two Level 2 objectives throws');
assert(throws(() => buildGuideFiles({ ...mk(2, []), date: null }, mk(1, []), src)).includes('date'), 'G21: a guide without a cover date throws');

assert(normalizeObjectiveText('The [CUI] data, and an Apple!') === 'cui data and apple' && normalizeObjectiveText('Federal Contract Information') === 'fci', 'normalizeObjectiveText lowercases, spells out FCI and CUI, drops punctuation and articles');
assert(CMMC_L2_GUIDE.requirements.length === 110 && CMMC_L1_GUIDE.requirements.length === 15, 'the typed guide exports hold both files');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
