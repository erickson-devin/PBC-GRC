import fs from 'node:fs';
import path from 'node:path';
import { CMMC_L1_GUIDE, CMMC_L2_GUIDE, cmmcNumberOf } from '../src/data/cmmcGuide/guide';
import { cmmcDisplayId, cmmcGuideId, cmmcGuideLetter, cmmcGuideObjectiveId, cmmcStoredIds, cmmcStoredObjectiveId, normalizeImportedCmmcIds } from '../src/data/cmmcGuide/displayId';
import { L1_OBJECTIVE_COUNT } from '../src/data/cmmcGuide/validate';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { mapDocumentToControls } from '../server/ssp/controlMapper';
import { resolveControlId } from '../server/ssp/grounding';
import type { AssessmentState, ControlState } from '../src/types/cmmc';
import type { ReportMetadata } from '../src/types/report';
import type { Tenant } from '../src/types/tenant';
import { compileNistSSP, generatePOAMEntries } from '../src/data/reports/documentCompilers';
import { generatePoamCsv } from '../src/data/reports/reportExporters';
import { calculateSprsScore, generateEmassControlMatrixCsv, generateSprsAssessmentSummary, getSspGaps } from '../src/data/reports/sprsCompiler';
import { generatePolicyDocument } from '../src/data/reports/policyDocumentGenerator';
import { buildSspMarkdown, createInitialState } from '../src/services/storageService';

/**
 * The guide's control ids as a display alias ('AC.L2-3.1.1', 'AC.L1-b.1.i'): the stored ids are never renamed. The helper, its
 * inverses, the import normaliser, and the pins that show the SSP import needs no change. Does not boot the server.
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

const l2 = getFrameworkControls('CMMC_L2');
const l1 = getFrameworkControls('CMMC_L1');
const PE = ['PE.L1-3.10.3', 'PE.L1-3.10.4', 'PE.L1-3.10.5'];

console.log('--- The guide id of a control ---');
assert(cmmcGuideId('AC.L1-3.1.1', 'CMMC_L2') === 'AC.L2-3.1.1' && cmmcGuideId('AC.L2-3.1.3', 'CMMC_L2') === 'AC.L2-3.1.3', 'I1: a Level 2 program shows the Level 2 guide id');

const l2Guide = l2.map((c) => cmmcGuideId(c.id, 'CMMC_L2'));
const expectedL2 = l2.map((c) => CMMC_L2_GUIDE.requirements.find((r) => r.number === cmmcNumberOf(c.id))!.id);
const l1Prefixed = l2.filter((c) => /\.L1-/.test(c.id)).length;
assert(l2.length === 110 && same(l2Guide, expectedL2), 'I2: every Level 2 control shows the guide requirement id of its number', l2.length);
assert(new Set(l2Guide).size === 110, 'I2: the 110 Level 2 guide ids are distinct', new Set(l2Guide).size);
assert(l1Prefixed === 17 && l2.filter((c, i) => l2Guide[i] !== c.id).length === l1Prefixed, 'I2: exactly the 17 Level 1 prefixed controls change', l1Prefixed);

assert(cmmcGuideId('AC.L1-3.1.1', 'CMMC_L1') === 'AC.L1-b.1.i' && cmmcGuideId('SI.L1-3.14.5', 'CMMC_L1') === 'SI.L1-b.1.xv', 'I3: a Level 1 program shows the FAR id');
assert(PE.every((id) => cmmcGuideId(id, 'CMMC_L1') === 'PE.L1-b.1.ix'), 'I3: the three PE controls share PE.L1-b.1.ix');
const l1Ids = l1.map((c) => cmmcGuideId(c.id, 'CMMC_L1'));
assert(l1.length === 17 && new Set(l1Ids).size === 15 && same([...new Set(l1Ids)].sort(), CMMC_L1_GUIDE.requirements.map((r) => r.id).sort()), 'I3: the 17 Level 1 controls give the 15 guide ids', [l1.length, new Set(l1Ids).size]);

console.log('--- The display id ---');
assert(cmmcDisplayId('PE.L1-3.10.4', 'CMMC_L1') === 'PE.L1-b.1.ix (3.10.4)' && cmmcDisplayId('PE.L1-3.10.3', 'CMMC_L1') === 'PE.L1-b.1.ix (3.10.3)' && cmmcDisplayId('PE.L1-3.10.5', 'CMMC_L1') === 'PE.L1-b.1.ix (3.10.5)', 'I4: the shared FAR id carries the number');
assert(cmmcDisplayId('AC.L1-3.1.1', 'CMMC_L1') === 'AC.L1-b.1.i', 'I4: a FAR id of one control stands alone');
assert(cmmcDisplayId('PE.L1-3.10.4', 'CMMC_L2') === 'PE.L2-3.10.4' && cmmcDisplayId('AC.L1-3.1.1', undefined) === 'AC.L2-3.1.1', 'I4: Level 2 and no framework show the Level 2 id');

console.log('--- Ids that are not CMMC ---');
const others = ['AC-2', 'CC6.1', '3.1.1', 'AC-2[a]'];
assert(others.every((id) => cmmcGuideId(id, 'CMMC_L1') === id && cmmcDisplayId(id, 'CMMC_L2') === id && cmmcGuideObjectiveId(id, 'CMMC_L1') === id && cmmcGuideLetter(id, 'a', 'CMMC_L1') === 'a'), 'I5: other frameworks and bare numbers are unchanged');

console.log('--- Objective ids and letters ---');
assert(cmmcGuideObjectiveId('AC.L1-3.1.1[a]', 'CMMC_L2') === 'AC.L2-3.1.1[a]', 'I6: Level 2 objective id');
assert(cmmcGuideObjectiveId('PE.L1-3.10.4[a]', 'CMMC_L1') === 'PE.L1-b.1.ix[c]' && cmmcGuideObjectiveId('PE.L1-3.10.5[c]', 'CMMC_L1') === 'PE.L1-b.1.ix[f]', 'I6: Level 1 objectives use the guide lettering');
const l1Objectives = CMMC_L1_GUIDE.requirements.flatMap((r) => r.objectives.map((o) => ({ r, o })));
const l1Stored = (o: { number: string; numberLetter: string }) => `${l1.find((c) => cmmcNumberOf(c.id) === o.number)!.id}[${o.numberLetter}]`;
assert(l1Objectives.length === L1_OBJECTIVE_COUNT && l1Objectives.length === 59, 'I6: the guide has 59 Level 1 objectives', l1Objectives.length);
assert(l1Objectives.every(({ r, o }) => cmmcGuideObjectiveId(l1Stored(o), 'CMMC_L1') === `${r.id}[${o.letter}]` && cmmcStoredObjectiveId(`${r.id}[${o.letter}]`) === l1Stored(o)), 'I6: every Level 1 objective round-trips');
assert(cmmcGuideObjectiveId('AC.L1-3.1.1[a]', 'CMMC_L1') === 'AC.L1-b.1.i[a]' && cmmcGuideObjectiveId('AC.L1-3.1.1', 'CMMC_L1') === 'AC.L1-3.1.1', 'I6: a plain Level 1 objective, and a control id given as an objective id');

console.log('--- The inverses ---');
assert(same(cmmcStoredIds('AC.L2-3.1.1'), ['AC.L1-3.1.1']) && same(cmmcStoredIds('ac.l1-b.1.i'), ['AC.L1-3.1.1']), 'I7: guide ids name the stored id, in any case');
assert(same(cmmcStoredIds('PE.L1-b.1.ix'), PE), 'I7: the shared FAR id names the three PE controls', cmmcStoredIds('PE.L1-b.1.ix'));
assert(cmmcStoredIds('AC-2').length === 0 && cmmcStoredIds('3.1.1').length === 0 && cmmcStoredIds('AC.L1-3.1.3').length === 0, 'I7: anything else names nothing');
assert(l2.every((c) => same(cmmcStoredIds(c.id), [c.id]) && same(cmmcStoredIds(cmmcGuideId(c.id, 'CMMC_L2')), [c.id])), 'I7: all 110 Level 2 controls round-trip');
assert(l1.every((c) => cmmcStoredIds(cmmcGuideId(c.id, 'CMMC_L1')).includes(c.id)), 'I7: all 17 Level 1 controls are found again from their FAR id');
assert(cmmcStoredObjectiveId('PE.L1-b.1.ix[c]') === 'PE.L1-3.10.4[a]' && cmmcStoredObjectiveId('AC.L2-3.1.1[d]') === 'AC.L1-3.1.1[d]' && cmmcStoredObjectiveId('PE.L1-b.1.ix[z]') === null, 'I8: objective ids go back to the stored id');
assert(cmmcStoredObjectiveId('AC-2[a]') === null && cmmcStoredObjectiveId('AC.L2-3.1.1') === null && cmmcStoredObjectiveId('AC.L2-3.1.1[z]') === null, 'I8: not an objective of a CMMC control');
assert(CMMC_L2_GUIDE.requirements.every((r) => r.objectives.every((o) => {
  const id = cmmcStoredIds(r.id)[0];
  return cmmcStoredObjectiveId(`${r.id}[${o.letter}]`) === `${id}[${o.letter}]` && cmmcGuideObjectiveId(`${id}[${o.letter}]`, 'CMMC_L2') === `${r.id}[${o.letter}]`;
})), 'I8: all 320 Level 2 objectives round-trip');
assert(cmmcGuideLetter('PE.L1-3.10.4', 'a', 'CMMC_L1') === 'c' && cmmcGuideLetter('PE.L1-3.10.4', 'a', 'CMMC_L2') === 'a', 'I9: the guide letter of a re-lettered objective');

console.log('--- Importing a state saved with guide ids ---');
const ctl = (id: string) => ({ id, status: 'MET', implementationNotes: `n-${id}`, responsibleRole: '', lastUpdated: '', tags: [] });
const obj = (id: string, controlId: string, letter: string) => ({ id, controlId, letter, text: 't' });
const evi = (controlId: string) => ({ id: 'e1', tenantId: 't', controlId, name: 'f', fileSize: 1, mimeType: 'x', uploadedAt: '' });
const input = {
  version: '1',
  tenantId: 't',
  sspMetadata: {},
  controls: { 'AC.L2-3.1.1': ctl('AC.L2-3.1.1'), 'PE.L1-b.1.ix': ctl('PE.L1-b.1.ix') },
  objectives: { 'AC.L1-b.1.i[a]': obj('AC.L1-b.1.i[a]', 'AC.L1-b.1.i', 'a') },
  evidenceIndex: [evi('AC.L2-3.1.1')],
  lastSaved: '',
} as unknown as AssessmentState;
const before = JSON.stringify(input);
const r = normalizeImportedCmmcIds(input, 'CMMC_L1');
assert(JSON.stringify(input) === before, 'I10: the input is not mutated');
assert(same(Object.keys(r.state.controls), ['AC.L1-3.1.1', 'PE.L1-b.1.ix']) && r.state.controls['AC.L1-3.1.1'].id === 'AC.L1-3.1.1' && r.state.controls['AC.L1-3.1.1'].implementationNotes === 'n-AC.L2-3.1.1', 'I10: the control is re-keyed, the ambiguous FAR id left alone');
assert(same(Object.keys(r.state.objectives!), ['AC.L1-3.1.1[a]']) && r.state.objectives!['AC.L1-3.1.1[a]'].id === 'AC.L1-3.1.1[a]' && r.state.objectives!['AC.L1-3.1.1[a]'].controlId === 'AC.L1-3.1.1', 'I10: the objective key, id and controlId are rewritten');
assert(r.state.evidenceIndex[0].controlId === 'AC.L1-3.1.1', 'I10: the evidence index is rewritten');
assert(r.renamed === 3 && r.skipped === 1, 'I10: counts', [r.renamed, r.skipped]);

const both = {
  ...input,
  controls: { 'AC.L1-3.1.1': ctl('AC.L1-3.1.1'), 'AC.L2-3.1.1': ctl('AC.L2-3.1.1') },
  objectives: { 'AC.L1-3.1.1[a]': obj('AC.L1-3.1.1[a]', 'AC.L1-3.1.1', 'a'), 'AC.L2-3.1.1[a]': obj('AC.L2-3.1.1[a]', 'AC.L2-3.1.1', 'a') },
  evidenceIndex: [],
} as unknown as AssessmentState;
const rb = normalizeImportedCmmcIds(both, 'CMMC_L2');
assert(same(Object.keys(rb.state.controls), ['AC.L1-3.1.1']) && rb.state.controls['AC.L1-3.1.1'].implementationNotes === 'n-AC.L1-3.1.1' && same(Object.keys(rb.state.objectives!), ['AC.L1-3.1.1[a]']), 'I10: a key already stored wins over its alias');
assert(rb.renamed === 0 && rb.skipped === 2, 'I10: the dropped aliases are counted as skipped', [rb.renamed, rb.skipped]);
const rn = normalizeImportedCmmcIds(input, 'NIST_800_171');
assert(rn.renamed === 0 && rn.skipped === 0 && rn.state.controls['AC.L2-3.1.1'] !== undefined, 'I10: another framework is left alone');

console.log('--- The SSP import (no server/ssp change needed) ---');
const sspText = 'AC.L2-3.1.1 Authorized Access Control\nAccess is limited to named directory accounts and reviewed by the IT lead every quarter.';
for (const fw of ['CMMC_L2', 'CMMC_L1'] as const) {
  const s = mapDocumentToControls(sspText, [], fw).staged[0];
  assert(s?.controlId === 'AC.L1-3.1.1' && s?.matchKind === 'CMMC_ID_SECTION', `I11: a Level 2 id in a ${fw} document lands on the stored id`, s && [s.controlId, s.matchKind]);
}
const res = resolveControlId('AC.L2-3.1.1', 'CMMC_L1');
assert(res.ok === true && (res as { controlId: string }).controlId === 'AC.L1-3.1.1', 'I11: resolveControlId accepts the Level 2 id');
assert(resolveControlId('AC.L1-b.1.i', 'CMMC_L1').ok === false, 'I11: resolveControlId does not accept a FAR id');
assert(mapDocumentToControls('AC.L1-b.1.i Authorized Access\nAccess is limited to named directory accounts and reviewed by the IT lead every quarter.', [], 'CMMC_L1').staged.length === 0, 'I11: a FAR id in a document stages nothing');

console.log('--- Exported documents show the guide id; scoring keeps the stored id ---');
const meta = (framework: 'CMMC_L1' | 'CMMC_L2'): ReportMetadata => ({
  systemName: 'Enclave', organizationName: 'Org', cageCode: '1ABC2', samStatus: 'Active', systemOwner: 'Owner', primaryAssessor: 'Assessor',
  boundaryDescription: 'Boundary', systemEnvironment: 'On-prem', operationalStatus: 'Operational', cloudServiceProviders: 'None',
  classificationLevel: 'CUI', assessmentDate: '2026-01-01', version: '1.0', framework,
} as unknown as ReportMetadata);
const st = (id: string, status: ControlState['status']): ControlState => ({ id, status, implementationNotes: '', responsibleRole: '', lastUpdated: '', tags: [] });
const statesOf = (cs: { id: string }[], status: ControlState['status']) => Object.fromEntries(cs.map((c) => [c.id, st(c.id, status)]));
const cellsOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : (r as { cells: unknown[] }).cells);

const sspL2 = compileNistSSP(meta('CMMC_L2'), l2, statesOf(l2, 'NOT_STARTED'));
const acRowsL2 = (sspL2.sections[2].subsections || []).flatMap((s) => s.table?.rows || []).map(cellsOf);
assert(acRowsL2.some((r) => r[0] === 'AC.L2-3.1.1') && !acRowsL2.some((r) => r[0] === 'AC.L1-3.1.1'), 'E1: the Level 2 SSP row shows the guide id of AC.L1-3.1.1');

const emass = generateEmassControlMatrixCsv(l2, statesOf(l2, 'NOT_STARTED'), meta('CMMC_L2'));
assert(emass.includes('"AC.L2-3.1.1","3.1.1"') && !emass.includes('"AC.L1-3.1.1"'), 'E2: the eMASS Control ID column shows the guide id, the 800-171 reference stays');

const poamL2 = generatePOAMEntries(l2, {}, undefined, 'CMMC_L2');
const poamCsv = generatePoamCsv(poamL2);
assert(poamL2[0].controlId === 'AC.L1-3.1.1' && poamL2[0].controlDisplayId === 'AC.L2-3.1.1', 'E3: a POA&M entry keeps the stored id and carries the display id', [poamL2[0].controlId, poamL2[0].controlDisplayId]);
assert(poamCsv.split('\r\n')[1].split(',')[1] === '"AC.L2-3.1.1"' && !poamCsv.includes('"AC.L1-3.1.1"'), 'E3: the POA&M CSV row starts with the display id', poamCsv.split('\r\n')[1].slice(0, 60));
const peL1 = l1.filter((c) => PE.includes(c.id));
const poamPe = generatePOAMEntries(peL1, {}, {}, 'CMMC_L1');
assert(poamPe.length === 3 && same(poamPe.map((e) => e.controlDisplayId), PE.map((id) => `PE.L1-b.1.ix (${id.slice('PE.L1-'.length)})`)), 'E3: a Level 1 POA&M names the three PE controls by the shared FAR id and their numbers', poamPe.map((e) => e.controlDisplayId));
assert(poamPe[1].weaknessDescription.includes('[c] ') && !poamPe[1].weaknessDescription.includes('[a] '), 'E3: the Level 1 weakness text uses the guide letters (3.10.4 [a] is [c])', poamPe[1].weaknessDescription.slice(0, 120));
assert(poamPe[1].remediationPlan.includes('Validate objectives: [c]'), 'E3: the "Validate objectives" line uses the guide letters', poamPe[1].remediationPlan);

const gaps = getSspGaps(l2, statesOf(l2, 'NOT_STARTED'), null);
assert(gaps.some((g) => g.includes('CA.L2-3.12.4') && g.includes('is not marked MET')), 'E4: the SSP gap names the guide id', gaps);

const states5 = statesOf(l2, 'MET');
states5['AC.L1-3.1.1'] = st('AC.L1-3.1.1', 'NOT_MET');
const score = calculateSprsScore(l2, states5, null);
const summary = generateSprsAssessmentSummary(l2, states5, meta('CMMC_L2'), poamL2);
assert(same(score.deductionsByWeight.fivePoint, ['AC.L1-3.1.1']) && score.totalDeductions === 5, 'E5: the score still lists and counts the stored id', score.deductionsByWeight.fivePoint);
assert(same(summary.deficienciesBreakdown.criticalFivePointDeductions, ['AC.L2-3.1.1']), 'E5: the SPRS summary list shows the guide id', summary.deficienciesBreakdown.criticalFivePointDeductions);
assert(summary.remediationMilestonesSummary.activeWeaknesses[0].controlId === 'AC.L2-3.1.1', 'E5: the summary weakness list shows the guide id');

const tenant = { id: 't-ids', name: 'Org', cageCode: '', samStatus: 'ACTIVE', systemName: 'Sys', systemOwner: 'Owner', industry: '', createdAt: '', updatedAt: '' } as Tenant;
const policy = generatePolicyDocument(tenant, 'PE', 'Physical Protection', 'CMMC_L1');
assert(policy.includes('### PE.L1-b.1.ix (3.10.4) - ') && policy.includes('**Objective c**') && !policy.includes('### PE.L1-3.10.4'), 'E6: the Level 1 policy shows the FAR id with the number and the guide letter');

const mdState = createInitialState({ ...tenant, primaryFramework: 'CMMC_L1' } as Tenant, 'CMMC_L1');
const md = buildSspMarkdown(mdState, l1, 'CMMC_L1');
assert(md.includes('### AC.L1-b.1.i: ') && !md.includes('### AC.L1-3.1.1'), 'E7: the Markdown SSP shows the FAR id');

// A3 screens (#283): source pins. Stored ids stay the keys; the display id is only what is shown and searched.
const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const matrixSrc = readSrc('src/components/dashboard/AssessmentMatrix.tsx');
assert(matrixSrc.includes('cmmcDisplayId(') && matrixSrc.includes('ctrl.id.toLowerCase().includes(query)'), 'S1: the matrix shows the display id and still searches the stored id');
assert(readSrc('src/components/audit/AuditTrailViewer.tsx').includes('cmmcStoredIds('), 'S2: the audit search translates a typed guide id to the stored id');
assert(readSrc('src/components/vault/EvidenceVaultView.tsx').includes('item.controlId'), 'S3: the vault still reads item.controlId');
const ctxSrc = readSrc('src/context/AssessmentContext.tsx');
assert(/normalizeImportedCmmcIds\(parsed, activeFramework\)\.state/.test(ctxSrc) && ctxSrc.indexOf('normalizeImportedCmmcIds(parsed') < ctxSrc.indexOf('migrateCachedObjectives(normalized'), 'S4: the JSON import re-keys guide ids before migrating');
const cardSrc = readSrc('src/components/dashboard/ControlCard.tsx');
assert(cardSrc.includes('aria-label={`Open ${cmmcDisplayId(control.id, activeFramework)}`}') && cardSrc.includes('{cmmcDisplayId(control.id, activeFramework)}'), 'S5: the card button is named with the same id the card shows');
// -- sections E1-E7 and S1-S3 are appended here --

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
