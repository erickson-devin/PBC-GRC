import './testEnv';
import { SSP_TEST_VAULT } from './sspEnv';
import fs from 'fs';
import { server } from '../server/index';
import { __resetOllamaCacheForTests } from '../server/ssp/ollama';
import { NIST_800_53_CONTROLS } from '../src/data/frameworks/nist80053Controls';
import { getFrameworkControls } from '../src/data/frameworks';
import { parseParameterTags, collapseTags } from '../src/data/frameworks/parameters';
import { chunkDocument, isAnchorLine } from '../server/ssp/chunk';
import { coverageFor, mapDocumentToControls } from '../server/ssp/controlMapper';
import { privacyCoverage } from '../server/ssp/privacyCoverage';
import { nistControlsWithPrivacy } from '../src/data/programScope';
import { explicitControlIds } from '../server/ssp/analyze';
import { resolveControlId } from '../server/ssp/grounding';
import { candidatesForSection, controlSupport, DEFAULT_MAX_CANDIDATES } from '../server/ssp/retrieval';
import { MIN_SCORE_53 } from '../server/ssp/retrieval53';
import { buildExtractiveGapAnalysis, isWeakMatch, objectivesFor } from '../server/ssp/gapAnalysis';
import { startFakeOllama } from './fakeOllama';
import { makeDocx } from './sspFixtures';

/**
 * Phase 3: NIST SP 800-53 Rev. 5 in the SSP import. The generated catalog (base controls, enhancements, baselines, ODP tags),
 * 800-53 identifiers in documents, the two-tier candidate search, the guardrails kept from the CMMC search, the SP 800-53A
 * objectives for the gap analysis, and an import through the API.
 */
const F = 'NIST_800_53_REV5' as const;
const BASE = 'http://127.0.0.1:8080/api/v1';
process.env.PLATFORM_ADMIN_EMAILS = 'u_n53_owner@test.mil'; // only an administrator provisions a NIST program

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

function catalogTests() {
  console.log('--- The catalog ---');
  const all = NIST_800_53_CONTROLS;
  const base = all.filter((c) => c.controlKind === 'BASE');
  const enh = all.filter((c) => c.controlKind === 'ENHANCEMENT');
  assert(all.length > 1000 && base.length >= 280 && enh.length >= 650 && base.length + enh.length === all.length, 'the whole catalog: over a thousand controls, base controls and enhancements told apart', { all: all.length, base: base.length });
  assert(new Set(all.map((c) => c.id)).size === all.length, 'ids are unique');
  const ids = new Set(all.map((c) => c.id));
  assert(enh.every((c) => c.parentControlId && ids.has(c.parentControlId) && c.id.startsWith(c.parentControlId + '(')) && base.every((c) => !c.parentControlId && /^[A-Z]{2}-\d+$/.test(c.id)), 'every enhancement names an existing base control and carries its id (AC-2(1) under AC-2)');
  assert(new Set(all.map((c) => c.domain)).size === 20, 'all twenty families');
  const count = (level: 'low' | 'moderate' | 'high') => all.filter((c) => c.baselines?.[level]).length;
  assert(count('low') === 149 && count('moderate') === 287 && count('high') === 370, 'baselines as published in SP 800-53B: Low 149, Moderate 287, High 370', [count('low'), count('moderate'), count('high')]);
  assert(all.filter((c) => c.baselines?.low).every((c) => c.baselines?.moderate) && all.filter((c) => c.baselines?.moderate).every((c) => c.baselines?.high), 'baselines nest: Low within Moderate within High');
  const ac2 = all.find((c) => c.id === 'AC-2')!;
  assert(ac2.baselineImpact === 'LOW' && all.find((c) => c.id === 'AC-2(4)')!.baselineImpact === 'MODERATE', 'baselineImpact is the lowest baseline that includes the control');
  const tagged = all.filter((c) => /\[(Assignment|Selection)/.test(c.statement ?? ''));
  assert(tagged.length > 600, 'most controls carry [Assignment: ...] / [Selection: ...] tags in their statement', tagged.length);
  assert(parseParameterTags(ac2.statement!, 'AC-2').length === 10, 'AC-2 has ten organization-defined parameters, found by the Phase 2 parser');
  const sel = parseParameterTags(all.find((c) => c.id === 'AC-4(4)')!.statement!, 'AC-4(4)');
  assert(sel.some((p) => p.kind === 'SELECTION' && p.selectionMode === 'ONE_OR_MORE' && (p.choices?.length ?? 0) >= 3), 'a Selection (one or more) with its choices (AC-4(4))');
  assert(all.every((c) => !/\{\{|\}\}/.test((c.statement ?? '') + c.discussion)), 'no placeholder of the source data is left unresolved');
  assert(collapseTags('Review [Assignment: organization-defined frequency] using [Selection (one or more): a; [Assignment: organization-defined tool]].') === 'Review organization-defined frequency using a or organization-defined tool.', 'tags read as plain words when collapsed');
  assert(getFrameworkControls(F, 'MOD_MOD_MOD').length === 287 && getFrameworkControls(F, 'LOW_LOW_LOW').length === 149 && getFrameworkControls(F, 'HIGH_HIGH_HIGH').length === 370 && getFrameworkControls(F).length === all.length, 'getFrameworkControls filters by baseline membership (and the whole catalog is available)');
}

const DOC = [
  'System Security Plan - Acme Federal Systems',
  'Cover page. Version 2.0. This cover section does not describe any security control at all.',
  '',
  'AC-2 Account Management',
  'Accounts are created by the IT lead after manager approval. Account types include individual, shared, service and emergency accounts, and shared accounts are prohibited except for service use. Account managers review all accounts every quarter and disable accounts within 24 hours when users are terminated or transferred. Authenticator rules are covered in IA-5 and the plan for AC-99 is not written yet.',
  '',
  'AC-2(1) Automated System Account Management',
  'Account creation, modification, disabling and removal are automated through the identity provider, which notifies account managers of every change to a system account.',
  '',
  'SC-28 Protection of Information at Rest',
  'All laptops and servers use full disk encryption with AES-256 to protect the confidentiality of information at rest, and database backups are encrypted with keys held in a hardware security module.',
  '',
  'Legacy note: the old plan mapped this to 3.1.1 and to AC.L2-3.1.5 of CMMC.',
];

function chunkAndMapTests() {
  console.log('\n--- Identifiers in a document ---');
  const text = DOC.join('\n');
  assert(chunkDocument(text, []).length < chunkDocument(text, [], { refStyle: 'nist53' }).length, 'an SP 800-53 heading starts a section only when the import is for SP 800-53 (CMMC chunking is unchanged)');
  assert(isAnchorLine('AC-2(1) Automated System Account Management', 'nist53') && isAnchorLine('| AC-02 | Account Management', 'nist53') && !isAnchorLine('Accounts follow the rules set out in AC-2 as described elsewhere.', 'nist53') && !isAnchorLine('AC-2 Account Management', 'cmmc'), 'a line that starts with an identifier anchors a section; a sentence that refers to one does not');
  const mapped = mapDocumentToControls(text, [], F);
  const by = new Map(mapped.staged.map((s) => [s.controlId, s]));
  assert(['AC-2', 'AC-2(1)', 'SC-28'].every((id) => by.get(id)?.matchKind === 'NIST53_ID_SECTION'), 'AC-2, the enhancement AC-2(1) and SC-28 are found as sections of their own', [...by.keys()]);
  assert(by.get('IA-5')?.matchKind === 'MENTION', 'a control only referred to inside another section is a mention');
  assert(by.get('AC-2')!.suggestedNotes.includes('Accounts are created by the IT lead') && !by.get('AC-2')!.suggestedNotes.includes('Automated System Account Management'), 'each section keeps its own text: the enhancement is not folded into its base control');
  assert(mapped.unmapped.some((u) => u.reference === 'AC-99' && u.reason === 'NOT_IN_CATALOG') && mapped.unmapped.some((u) => u.reference === 'AC.L2-3.1.5' && u.reason === 'OUT_OF_SCOPE'), 'AC-99 is reported as not in the catalog; a CMMC identifier as out of scope', mapped.unmapped);
  assert(mapDocumentToControls('AC-02(01) Automated System Account Management\nAccounts are managed with automation and every change is announced.', [], F).staged[0]?.controlId === 'AC-2(1)', 'zero-padded identifiers (AC-02(01)) mean the same control');
  assert(mapped.staged.every((s) => s.framework === F) && mapDocumentToControls(text, [], 'CMMC_L2').staged.every((s) => s.framework === 'CMMC_L2' && !/^[A-Z]{2}-\d/.test(s.controlId)), 'a CMMC import of the same text finds no SP 800-53 control');

  console.log('\n--- Coverage is measured against the chosen baseline ---');
  const found = new Set(['AC-2', 'AC-2(4)', 'SC-28', 'AC-2(11)']); // AC-2(11) is in the High baseline only
  const cMod = coverageFor(F, 'MODERATE', found);
  const cLow = coverageFor(F, 'LOW', found);
  const cHigh = coverageFor(F, 'HIGH', found);
  assert(cMod.totalControls === 287 && cLow.totalControls === 149 && cHigh.totalControls === 370 && cMod.baseline === 'MODERATE', 'the total is the size of the baseline');
  assert(cMod.foundControls === 3 && cLow.foundControls === 1 && cHigh.foundControls === 4 && !cMod.missing.includes('AC-2') && cMod.missing.length === 287 - 3 && cMod.missing.includes('AC-3'), 'only controls inside the baseline count as found; the rest are listed as missing');
  assert(coverageFor(F, undefined, found).baseline === 'MODERATE' && coverageFor('CMMC_L2', null, new Set()).baseline === undefined, 'Moderate unless chosen; CMMC reports have no baseline');

  console.log('\n--- The privacy baseline (issue #20) ---');
  const privIds = new Set(NIST_800_53_CONTROLS.filter((c) => c.baselines?.privacy).map((c) => c.id));
  const unionMod = nistControlsWithPrivacy('MODERATE', true);
  assert(privIds.size === 96 && unionMod.length === 340 && nistControlsWithPrivacy('LOW', true).length === 205 && nistControlsWithPrivacy('HIGH', true).length === 423, 'the privacy baseline has 96 controls and combines to 340 / 205 / 423 with Moderate / Low / High (a catalog change is noticed here)', [privIds.size, unionMod.length]);
  const modIds = new Set(getFrameworkControls(F, 'MOD_MOD_MOD').map((c) => c.id));
  const privOnlyId = [...privIds].find((id) => !modIds.has(id)) ?? '';
  const pc = privacyCoverage('MODERATE', new Set(['AC-1', privOnlyId]));
  assert(privOnlyId !== '' && pc.totalControls === 340 && pc.foundControls === 2 && pc.privacy === true && pc.framework === F && pc.baseline === 'MODERATE' && !pc.missing.includes('AC-1') && !pc.missing.includes(privOnlyId) && pc.missing.length === 338, 'privacyCoverage counts the security and the privacy-only control it is given and leaves them out of "missing"', { ...pc, missing: pc.missing.length });
  const pcLow = privacyCoverage('LOW', new Set());
  assert(pcLow.totalControls === 205 && pcLow.missing.length === pcLow.totalControls && pcLow.foundControls === 0 && privacyCoverage(null, new Set()).baseline === 'MODERATE', 'nothing found -> every control is missing (205 for Low); no baseline means Moderate');

  console.log('\n--- What the model may name ---');
  const offered = new Set(['AC-2', 'AC-2(1)']);
  const ok = (raw: unknown) => { const r = resolveControlId(raw, F, offered); return r.ok ? r.controlId : r.reason; };
  assert(ok('AC-2(1)') === 'AC-2(1)' && ok('ac-2 (1)') === 'AC-2(1)' && ok('AC-02(01)') === 'AC-2(1)' && ok('NIST SP 800-53 AC-2') === 'AC-2', 'written in any usual way, an identifier resolves to the catalog id');
  assert(ok('SC-28') === 'NOT_OFFERED' && ok('ZZ-9') === 'UNKNOWN_CONTROL' && ok('AC-99') === 'UNKNOWN_CONTROL' && ok('AC.L2-3.1.5') === 'OUT_OF_SCOPE' && ok(42) === 'UNKNOWN_CONTROL', 'a control that was not offered, does not exist, or belongs to CMMC is refused');
  assert(explicitControlIds('See AC-2, and AC-2(1) and ac-17 and SC-28; also AC-99', F).sort().join() === 'AC-2,AC-2(1),SC-28', 'identifiers a section names outright (only ones that exist)');
}

function retrievalTests() {
  console.log('\n--- Two-tier candidate search ---');
  const accounts = DOC[4];
  const rest = DOC[10];
  const c1 = candidatesForSection(accounts, F);
  assert(c1[0]?.id === 'AC-2' && c1.length <= DEFAULT_MAX_CANDIDATES, 'a section about account management offers AC-2 first and no more candidates than the CMMC limit', c1.map((c) => c.id));
  assert(c1.filter((c) => c.id !== 'AC-2').every((c) => c.id.startsWith('AC-2(')), 'the others are enhancements of AC-2: enhancements are only searched under the base controls that made it through tier 1', c1.map((c) => c.id));
  assert(c1.find((c) => c.id.includes('('))?.requirement.startsWith('Enhancement of AC-2 Account Management'), 'an enhancement is offered together with the control it refines');
  const c2 = candidatesForSection(rest, F);
  assert(c2[0]?.id === 'SC-28' && c2.every((c) => c.score >= MIN_SCORE_53), 'encryption at rest finds SC-28, and nothing below the score floor', c2.map((c) => `${c.id}:${c.score.toFixed(0)}`));
  assert(candidatesForSection(DOC[1], F).length === 0 && candidatesForSection('Thank you for reading. Page 3 of 40. Table of contents follows.', F).length === 0, 'a cover page or a table of contents matches nothing: it would not be sent to the model');
  assert(candidatesForSection(accounts, F, [], { max: 1 }).length === 1, 'the candidate limit is honoured');
  assert(candidatesForSection(accounts, F, [], { minScore: 99 }).length === 0, 'the operator can raise the floor');
  assert(candidatesForSection(accounts, F, [], { minScore: 0 }).every((c) => c.score >= MIN_SCORE_53), 'but cannot lower it below the 800-53 floor');
  const named = candidatesForSection('Nothing useful here at all.', F, ['SC-7(3)']);
  assert(named.length === 1 && named[0].explicit && named[0].id === 'SC-7(3)', 'a control the section names is always offered, whatever its text');
  const withParent = candidatesForSection(DOC[7], F, ['AC-2(1)']);
  assert(withParent.some((c) => c.id === 'AC-2(1)' && c.explicit), 'an enhancement named in the heading is offered (and its parent is searched for siblings)');

  console.log('\n--- Quote fit is checked against the catalog text ---');
  const right = controlSupport(accounts, 'AC-2', F);
  const wrong = controlSupport(accounts, 'SC-28', F);
  assert(right.rank === 0 && right.score > 20 && wrong.rank > 5 && wrong.score < 4, 'a quotation about accounts fits AC-2, and does not fit SC-28', { right, wrong });
  const enh = controlSupport('Account creation, modification, disabling and removal are automated through the identity provider, which notifies account managers of every change to a system account.', 'AC-2(1)', F);
  assert(enh.rank <= 2 && enh.score >= 4, 'an enhancement is ranked among the enhancements, and fits', enh);
  const orphan = controlSupport(rest, 'AC-2(1)', F);
  assert(orphan.rank > 100 && orphan.score === 0, 'a quotation about encryption cannot support an account-management enhancement: its base control must fit too', orphan);
  assert(controlSupport(accounts, 'ZZ-99', F).rank > 1000, 'an id that is not in the catalog never fits');
}

function objectiveTests() {
  console.log('\n--- SP 800-53A objectives for the gap analysis ---');
  const ac2 = objectivesFor('AC-2', F);
  assert(ac2.length === 12 && ac2.map((o) => o.letter).join('') === 'abcdefghijkl', 'AC-2 is assessed on its twelve items (a to l), not its 38 sub-statements', ac2.length);
  assert(ac2.every((o) => o.text.length > 5 && !/[[\]{}]/.test(o.text)), 'objective texts read as plain words (parameter tags collapsed)');
  assert(ac2[0].text.includes('account types allowed') && ac2[0].text.includes('; '), 'an item with sub-objectives joins them');
  assert(objectivesFor('AC-2(1)', F).length === 1 && objectivesFor('SC-28', F).length >= 1, 'enhancements and other controls have their own objectives');
  const every = NIST_800_53_CONTROLS.filter((c) => objectivesFor(c.id, F).length === 0);
  assert(every.length === 0, 'every control and enhancement of the catalog has objectives', every.slice(0, 5).map((c) => c.id));
  assert(Math.max(...NIST_800_53_CONTROLS.map((c) => objectivesFor(c.id, F).length)) <= 12, 'no control has more than twelve, so one model call per objective stays practical');

  // the extractive logic, unchanged, with SP 800-53A objectives
  const objectives = objectivesFor('AC-2', F);
  const excerpts = DOC[4];
  const reply = { answers: [{ letter: 'b', sentence: 'Accounts are created by the IT lead after manager approval.' }, { letter: 'j', sentence: 'Account managers review all accounts every quarter and disable accounts within 24 hours when users are terminated or transferred.' }, { letter: 'a', sentence: 'NONE' }] };
  const gap = buildExtractiveGapAnalysis(reply, objectives, excerpts);
  const stat = (l: string) => gap.objectives!.find((o) => o.letter === l)!;
  assert(stat('b').status === 'ADDRESSED' && stat('j').status === 'ADDRESSED' && stat('a').status === 'NOT_ADDRESSED' && stat('c').status === 'NOT_ASSESSED', 'a copied sentence found in the document counts; NONE is not addressed; no answer is not assessed');
  assert(gap.summary.startsWith('2 of 12 assessment objectives have a supporting sentence') && gap.gaps.some((g) => g.missingElement === 'The AI found no supporting sentence for objective [a]'), 'the reviewer-facing wording is the one chosen in Phase 2');
  assert(isWeakMatch(objectives[9].text, 'The weather in Paris was pleasant on Tuesday.') && !isWeakMatch(objectives[9].text, 'Accounts are reviewed for compliance with the account management requirements every quarter.'), 'the weak-match check of Phase 2 applies to SP 800-53A objectives too');
}

// ---------------------------------------------------------------------------------------------- API

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
async function upload(token: string, tenant: string, file: Buffer, fields: Record<string, string>, program?: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)]), 'plan.docx');
  const res = await fetch(`${BASE}/tenants/${tenant}/ssp-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant, ...(program ? { 'x-program-id': program } : {}) }, body: form });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
async function waitFor(token: string, tenant: string, jobId: string, ms = 30000, program?: string): Promise<Json> {
  const until = Date.now() + ms;
  for (;;) {
    const job = (await call('GET', `/tenants/${tenant}/ssp-imports/${jobId}`, token, tenant, undefined, program)).body?.job as Json;
    if (job && ['READY_FOR_REVIEW', 'FAILED', 'CANCELLED', 'COMMITTED'].includes(job.status)) return job;
    if (Date.now() > until) throw new Error('timed out waiting for the import: ' + JSON.stringify(job?.status));
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** A stand-in model that copies the first sentence under a heading for each offered control the section names. */
function model53(req: { system: string; user: string }): unknown {
  const grab = (from: string, to: string) => req.user.slice(req.user.indexOf(from) + from.length, req.user.lastIndexOf(to)).trim();
  if (req.system.startsWith('You read one section')) {
    const offered = [...req.user.matchAll(/^- ([A-Z]{2}-\d+(?:\(\d+\))?):/gm)].map((m) => m[1]);
    const section = grab('<<<\n', '\n>>>');
    const quote = (section.split('\n').slice(1).join(' ').match(/[^.!?]+[.!?]/)?.[0] ?? '').trim();
    return { findings: offered.filter((id) => section.includes(id)).map((id) => ({ controlId: id, implementation: `The plan says: ${quote.slice(0, 80)}`, quote, coverage: 'FULL', confidence: 0.9 })) };
  }
  if (req.system.startsWith('You find one sentence')) {
    const text = grab('EXCERPTS\n<<<\n', '\n>>>');
    const sentence = (text.split('\n').slice(1).join(' ').match(/[^.!?]+[.!?]/)?.[0] ?? 'NONE').trim();
    return { sentence };
  }
  return { __raw: 'no' };
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const fake = await startFakeOllama(['llama3.2:3b']);
  fake.onChat = model53;
  process.env.OLLAMA_BASE_URL = fake.url;
  process.env.OLLAMA_MODEL = 'llama3.2:3b';
  process.env.SSP_AI_ENABLED = 'true';
  __resetOllamaCacheForTests();

  const owner = person('u_n53_owner');
  const nist = (await call('POST', '/tenants', owner, undefined, { name: 'Federal Org', primaryFramework: F, enabledFrameworks: ['CMMC_L2'] })).body?.tenant?.id as string;
  const l1 = (await call('POST', '/tenants', person('u_n53_other'), undefined, { name: 'Level 1 Org' })).body?.tenant?.id as string;
  const docx = await makeDocx(DOC);

  console.log('\n--- An SP 800-53 import through the API ---');
  const cap = (await call('GET', `/tenants/${nist}/ssp-imports/capabilities`, owner, nist)).body as Json;
  assert(cap.frameworks.includes(F) && cap.frameworks.includes('CMMC_L2'), 'the NIST program is offered SP 800-53 (and its other framework)', cap.frameworks);
  const capL1 = (await call('GET', `/tenants/${l1}/ssp-imports/capabilities`, person('u_n53_other'), l1)).body as Json;
  assert(!capL1.frameworks.includes(F), 'a Level 1 tenant is not offered it');
  assert((await upload(person('u_n53_other'), l1, docx, { framework: F })).status === 403, 'and cannot import to it (403)');
  assert((await upload(owner, nist, docx, { framework: F, baseline: 'EXTREME' })).status === 400, 'an unknown baseline is a 400');

  const up = await upload(owner, nist, docx, { framework: F });
  assert(up.status === 202 && up.body?.job?.framework === F && up.body.job.baseline === 'MODERATE', 'accepted; the baseline defaults to Moderate and is kept on the job', up.body?.job);
  const job = await waitFor(owner, nist, up.body?.job?.id);
  assert(job.status === 'READY_FOR_REVIEW' && job.coverage?.framework === F && job.coverage.baseline === 'MODERATE' && job.coverage.totalControls === 287, 'ready for review; coverage is measured against the 287 Moderate controls', job.coverage && { ...job.coverage, missing: undefined });
  const staged = ((await call('GET', `/tenants/${nist}/ssp-imports/${job.id}/staged`, owner, nist)).body?.staged ?? []) as Json[];
  const ids = staged.map((s) => s.controlId).sort();
  assert(ids.join() === ['AC-2', 'AC-2(1)', 'IA-5', 'SC-28'].sort().join() && staged.every((s) => s.framework === F), 'AC-2, AC-2(1), SC-28 and the mentioned IA-5 are staged for review', ids);
  assert(staged.every((s) => s.reviewState === 'PENDING' && s.current === null || s.current?.notes === ''), 'nothing was written to the controls: they are only suggestions');

  const high = await upload(owner, nist, docx, { framework: F, baseline: 'HIGH' });
  const highJob = await waitFor(owner, nist, high.body?.job?.id);
  assert(highJob.baseline === 'HIGH' && highJob.coverage.totalControls === 370, 'a High import is measured against the 370 High controls');

  const cmmc = await upload(owner, nist, docx, { framework: 'CMMC_L2', baseline: 'LOW' });
  const cmmcJob = await waitFor(owner, nist, cmmc.body?.job?.id);
  assert(cmmcJob.baseline === null && cmmcJob.coverage.baseline === undefined && cmmcJob.coverage.totalControls === 110, 'a CMMC import ignores any baseline');

  console.log('\n--- A program with the privacy baseline is measured against the union (issue #20) ---');
  const plusProgram = (await call('POST', `/tenants/${nist}/programs`, owner, nist, { name: 'Moderate plus privacy', frameworkId: F, baseline: 'MODERATE', privacyBaseline: true })).body?.program?.id as string;
  const privUp = await upload(owner, nist, docx, { framework: F }, plusProgram);
  const privJob = await waitFor(owner, nist, privUp.body?.job?.id, 30000, plusProgram);
  assert(privJob.status === 'READY_FOR_REVIEW' && privJob.coverage?.privacy === true && privJob.coverage.totalControls === 340 && privJob.coverage.baseline === 'MODERATE', 'a rules import into a MODERATE + privacy program is measured against the 340 union', privJob.coverage && { ...privJob.coverage, missing: undefined });
  const privStaged = ((await call('GET', `/tenants/${nist}/ssp-imports/${privJob.id}/staged`, owner, nist, undefined, plusProgram)).body?.staged ?? []) as Json[];
  assert(privStaged.map((s) => s.controlId).sort().join() === ids.join() && privJob.coverage.foundControls === privStaged.filter((s) => privJob.coverage.missing.indexOf(s.controlId) < 0).length, 'the staged suggestions are the same as without the privacy baseline', privStaged.map((s) => s.controlId));
  assert(job.coverage.privacy === undefined && job.coverage.totalControls === 287, 'a plain MODERATE program has no privacy flag and 287 controls (the import above)');

  console.log('\n--- With the local model ---');
  fake.chats.length = 0;
  const ai = await upload(owner, nist, docx, { framework: F, analysis: 'ai' });
  assert(ai.status === 202, 'accepted with the AI analysis', ai.body);
  const aiJob = await waitFor(owner, nist, ai.body?.job?.id);
  const aiStaged = ((await call('GET', `/tenants/${nist}/ssp-imports/${aiJob.id}/staged`, owner, nist)).body?.staged ?? []) as Json[];
  const byId = new Map(aiStaged.map((s) => [s.controlId, s]));
  assert(aiJob.status === 'READY_FOR_REVIEW' && aiJob.analyzer === 'ollama:llama3.2:3b' && aiJob.stageProgress?.ai?.findingsGrounded >= 3, 'the model analysed it and its findings were checked against the document', aiJob.stageProgress?.ai);
  assert(['AC-2', 'AC-2(1)', 'SC-28'].every((id) => byId.get(id)?.origin === 'AI' && byId.get(id)?.sourceQuotes?.[0]?.verified), 'AC-2, AC-2(1) and SC-28 are AI suggestions with verified quotations', [...byId.entries()].map(([k, v]) => `${k}:${v.origin}`));
  assert(byId.get('AC-2')?.gapAnalysis?.objectives?.length === 12 && byId.get('AC-2(1)')?.gapAnalysis?.objectives?.length === 1, 'the gap analysis ran per SP 800-53A objective: twelve for AC-2, one for AC-2(1)', byId.get('AC-2')?.gapAnalysis?.objectives?.length);
  const sent = fake.chats.filter((c) => c.system.startsWith('You read one section'));
  assert(sent.length >= 3 && sent.every((c) => (c.user.match(/^- [A-Z]{2}-\d/gm) ?? []).length <= DEFAULT_MAX_CANDIDATES + 3), 'each section was offered only a few candidates', sent.map((c) => (c.user.match(/^- [A-Z]{2}-\d/gm) ?? []).length));
  assert(!sent.some((c) => c.user.includes('Cover page. Version 2.0')), 'the cover page was never sent to the model');

  await fake.close();
}

async function run() {
  catalogTests();
  chunkAndMapTests();
  retrievalTests();
  objectiveTests();
  await apiTests();
}

run()
  .catch((e) => {
    console.error('TEST CRASHED:', e);
    total++;
  })
  .finally(() => {
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    fs.rmSync(SSP_TEST_VAULT, { recursive: true, force: true });
    server.closeAllConnections();
    server.close();
    process.exit(passed === total ? 0 : 1);
  });
