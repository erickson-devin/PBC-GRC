import './testEnv';
import { SSP_TEST_VAULT } from './sspEnv';
import fs from 'fs';
import { server } from '../server/index';
import { __resetOllamaCacheForTests } from '../server/ssp/ollama';
import { startFakeOllama } from './fakeOllama';
import { scriptedModel } from './fakeSspModel';
import { makeDocx } from './sspFixtures';

/**
 * SSP import with the AI analysis, through the API: the availability check before anything is accepted, AI suggestions in the
 * staging area, falling back to the rules when the model fails, cancelling, and the rule that the model never touches a
 * control: its suggestions are committed (or not) by a person, exactly like the rule-based ones.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';

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

const DOC_LINES = [
  'System Security Plan - Acme Defense LLC',
  'Prepared by the compliance team. Version 1.2. This cover section does not describe any security control at all.',
  '',
  '1. ACCESS CONTROL',
  '',
  'AC.L1-3.1.1 Authorized Access Control',
  'Access to company systems is limited to authorized users. Accounts are created by the IT lead after manager approval and reviewed every quarter by the security manager.',
  '',
  '2. MEDIA PROTECTION',
  '',
  'Removable media is encrypted and labeled. Hard drives are sanitized using NIST 800-88 methods before disposal or reuse, and a sanitization record is kept by the facilities manager for each device.',
];

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;

async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
async function upload(token: string, tenant: string, file: Buffer, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)]), 'plan.docx');
  const res = await fetch(`${BASE}/tenants/${tenant}/ssp-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant }, body: form });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
async function waitFor(token: string, tenant: string, jobId: string, done: (j: Json) => boolean, ms = 30000): Promise<Json> {
  const until = Date.now() + ms;
  for (;;) {
    const job = (await call('GET', `/tenants/${tenant}/ssp-imports/${jobId}`, token, tenant)).body?.job as Json;
    if (job && done(job)) return job;
    if (Date.now() > until) throw new Error('timed out waiting for the import: ' + JSON.stringify(job?.status));
    await new Promise((r) => setTimeout(r, 80));
  }
}
const terminal = (j: Json) => ['READY_FOR_REVIEW', 'FAILED', 'CANCELLED', 'COMMITTED'].includes(j.status);

async function main() {
  await new Promise((r) => setTimeout(r, 500));
  const fake = await startFakeOllama(['llama3.2:3b']);
  fake.onChat = scriptedModel;

  const owner = person('u_ai_owner');
  const assessor = person('u_ai_assessor');
  const tenant = (await call('POST', '/tenants', owner, undefined, { name: 'AI Org' })).body?.tenant?.id as string;
  await call('POST', `/tenants/${tenant}/members`, owner, tenant, { userId: 'u_ai_assessor', email: 'u_ai_assessor@test.mil', role: 'ASSESSOR' });
  const root = `/tenants/${tenant}/ssp-imports`;
  const docx = await makeDocx(DOC_LINES);
  const reset = () => { __resetOllamaCacheForTests(); fake.chats.length = 0; fake.failNext = 0; fake.delayMs = 0; fake.models = ['llama3.2:3b']; };

  console.log('--- The AI analysis is off by default ---');
  delete process.env.SSP_AI_ENABLED;
  process.env.OLLAMA_BASE_URL = fake.url;
  reset();
  const capOff = (await call('GET', `${root}/capabilities`, owner, tenant)).body as Json;
  assert(capOff.ai === false && capOff.aiStatus.enabled === false && /switched off/.test(capOff.aiStatus.reason), 'switched off: capabilities say so, with the reason', capOff.aiStatus);
  const refusedOff = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  assert(refusedOff.status === 409 && refusedOff.body?.code === 'ai_unavailable', 'asking for the AI analysis while it is off is refused (409 ai_unavailable)', refusedOff.body);
  assert(((await call('GET', root, owner, tenant)).body?.jobs ?? []).length === 0 && fake.chats.length === 0, 'and nothing was created or sent to the model');
  assert((await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'maybe' })).status === 400, 'an unknown analysis mode is a 400');
  const rulesJob = await upload(owner, tenant, docx, { framework: 'CMMC_L1' });
  const rulesDone = await waitFor(owner, tenant, rulesJob.body?.job?.id, terminal);
  assert(rulesDone.analyzer === 'regex-v1' && rulesDone.status === 'READY_FOR_REVIEW' && fake.chats.length === 0, 'with no analysis requested the import is rule-based and never touches the model');
  await call('DELETE', `${root}/${rulesDone.id}`, owner, tenant);

  console.log('\n--- Checked before processing ---');
  process.env.SSP_AI_ENABLED = 'true';
  reset();
  const capOn = (await call('GET', `${root}/capabilities`, owner, tenant)).body as Json;
  assert(capOn.ai === true && capOn.aiStatus.available === true && capOn.aiStatus.model === 'llama3.2:3b', 'enabled, reachable and the model installed: the AI analysis is offered');
  fake.models = ['mistral:7b'];
  __resetOllamaCacheForTests();
  const capMissing = (await call('GET', `${root}/capabilities`, owner, tenant)).body as Json;
  assert(capMissing.ai === false && /ollama pull llama3.2:3b/.test(capMissing.aiStatus.reason) && /mistral:7b/.test(capMissing.aiStatus.reason), 'model not installed: not offered, and the reason says how to load it and what is installed', capMissing.aiStatus.reason);
  const refusedMissing = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  assert(refusedMissing.status === 409 && /not installed/.test(refusedMissing.body?.error) && fake.chats.length === 0, 'an upload asking for AI is refused up front when the model is missing, before any work', refusedMissing.body);
  assert(((await call('GET', root, owner, tenant)).body?.jobs ?? []).length === 0, 'no job and no stored document were created for the refused upload');
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
  reset();
  const refusedDown = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  assert(refusedDown.status === 409 && /Cannot reach Ollama/.test(refusedDown.body?.error), 'an unreachable Ollama is refused up front too');
  process.env.OLLAMA_BASE_URL = 'https://api.openai.com';
  reset();
  const refusedPublic = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  assert(refusedPublic.status === 409 && /not on this machine/.test(refusedPublic.body?.error), 'a base URL pointing at a public host is refused: documents never leave the machine / private network');
  process.env.OLLAMA_BASE_URL = fake.url;
  reset();

  console.log('\n--- An AI import end to end ---');
  const up = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  assert(up.status === 202 && up.body?.job?.analyzer === 'ollama:llama3.2:3b', 'accepted (202), and the job records which model analysed it', up.body?.job?.analyzer);
  const jobId = up.body?.job?.id as string;
  const job = await waitFor(owner, tenant, jobId, terminal);
  assert(job.status === 'READY_FOR_REVIEW' && job.analyzer === 'ollama:llama3.2:3b', 'ready for review, still marked as an AI analysis', job);
  const ai = job.stageProgress?.ai;
  assert(ai?.model === 'llama3.2:3b' && ai.promptVersion === 'ssp-ai-1' && ai.sectionsAnalyzed >= 2 && ai.findingsGrounded >= 2 && ai.gapAnalyses >= 2, 'the AI run statistics are kept on the job', ai);
  const staged = ((await call('GET', `${root}/${jobId}/staged`, assessor, tenant)).body?.staged ?? []) as Json[];
  const byId = new Map(staged.map((s) => [s.controlId, s]));
  const ac = byId.get('AC.L1-3.1.1');
  const mp = byId.get('MP.L1-3.8.3');
  assert(ac?.origin === 'AI' && ac.matchKind === 'AI_EXTRACTED' && mp?.origin === 'AI', 'an assessor can read the AI suggestions (the named control and the one found by meaning)');
  assert(ac.gapAnalysis.source === 'ai' && ac.gapAnalysis.objectives.length >= 3 && ac.gapAnalysis.objectives[0].status === 'ADDRESSED', 'with the 800-171A objective assessment');
  assert(ac.sourceQuotes.every((q: Json) => q.verified && q.quote.length > 20), 'and verified quotations');
  assert(staged.every((s) => s.reviewState === 'PENDING'), 'everything is PENDING: the model decided nothing');

  console.log('\n--- The model never changes a control; a person commits ---');
  const controls = async (): Promise<Json[]> => ((await call('GET', '/controls?framework=CMMC_L1', owner, tenant)).body?.controls ?? []) as Json[];
  assert((await controls()).every((c) => c.implementationNotes === ''), 'after the AI analysis every control is still empty');
  assert((await call('PATCH', `${root}/${jobId}/staged/${ac.id}`, assessor, tenant, { reviewState: 'ACCEPTED' })).status === 403, 'an assessor cannot accept an AI suggestion');
  await call('PATCH', `${root}/${jobId}/staged/${ac.id}`, owner, tenant, { reviewState: 'ACCEPTED' });
  assert((await controls()).every((c) => c.implementationNotes === ''), 'accepting still writes nothing');
  const commit = await call('POST', `${root}/${jobId}/commit`, owner, tenant, {});
  assert(commit.body?.committed.length === 1, 'the owner commits the one accepted AI suggestion');
  const after = (await controls()).find((c) => c.id === 'AC.L1-3.1.1')!;
  assert(after.implementationNotes === ac.suggestedNotes && after.status === 'NOT_STARTED', 'its text was written, the status was not changed', after);
  assert((await controls()).find((c) => c.id === 'MP.L1-3.8.3')!.implementationNotes === '', 'the AI suggestion nobody accepted never reached its control');

  console.log('\n--- When the model fails, the rules still deliver ---');
  reset();
  const six = Array.from({ length: 6 }, (_, i) => `${i + 1}. SECTION ${i + 1}\n\nAC.L1-3.1.1 Authorized Access Control\nAccess to company systems is limited to authorized users. Accounts are reviewed every quarter by the security manager number ${i}.`).join('\n\n');
  fake.failNext = 1000;
  const broken = await upload(owner, tenant, await makeDocx(six.split('\n')), { framework: 'CMMC_L1', analysis: 'ai' });
  const brokenDone = await waitFor(owner, tenant, broken.body?.job?.id, terminal, 60000);
  assert(brokenDone.status === 'READY_FOR_REVIEW' && brokenDone.analyzer === 'regex-v1', 'a model that fails on every section does not fail the import: it completes with the rule-based result', brokenDone.analyzer);
  assert(/AI analysis could not be completed/.test(brokenDone.stageProgress?.warning ?? '') && !brokenDone.stageProgress?.ai, 'and the reviewer is told, in plain words', brokenDone.stageProgress?.warning);
  const brokenStaged = ((await call('GET', `${root}/${brokenDone.id}/staged`, owner, tenant)).body?.staged ?? []) as Json[];
  assert(brokenStaged.length >= 1 && brokenStaged.every((s) => s.origin === 'RULES'), 'the suggestions are labelled as rule-based');
  fake.failNext = 0;

  reset();
  const going = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  fake.models = [];
  __resetOllamaCacheForTests();
  const goingDone = await waitFor(owner, tenant, going.body?.job?.id, terminal);
  assert(goingDone.status === 'READY_FOR_REVIEW' && goingDone.analyzer === 'regex-v1' && /AI analysis could not be completed/.test(goingDone.stageProgress?.warning ?? ''), 'a model that disappears after the upload is noticed before work starts, and the import falls back', goingDone.stageProgress);
  fake.models = ['llama3.2:3b'];

  console.log('\n--- Cancelling ---');
  reset();
  fake.delayMs = 400;
  const slow = await upload(owner, tenant, docx, { framework: 'CMMC_L1', analysis: 'ai' });
  const slowId = slow.body?.job?.id as string;
  await waitFor(owner, tenant, slowId, (j) => j.status === 'ANALYZING', 20000);
  assert((await call('POST', `${root}/${slowId}/cancel`, assessor, tenant)).status === 403, 'an assessor cannot cancel');
  assert((await call('POST', `${root}/${slowId}/cancel`, owner, tenant)).status === 202, 'an owner cancels a running AI analysis (202)');
  const cancelled = await waitFor(owner, tenant, slowId, terminal);
  assert(cancelled.status === 'CANCELLED', 'the job ends CANCELLED', cancelled.status);
  assert(((await call('GET', `${root}/${slowId}/staged`, owner, tenant)).body?.staged ?? []).length === 0, 'and nothing was staged');
  assert((await call('POST', `${root}/${slowId}/cancel`, owner, tenant)).status === 409, 'cancelling a finished import is a 409');
  assert((await call('POST', `${root}/sspj_nope/cancel`, owner, tenant)).status === 404, 'an unknown import is a 404');
  fake.delayMs = 0;
  await new Promise((r) => setTimeout(r, 600));

  await fake.close();
}

main()
  .catch((e) => {
    console.error('TEST CRASHED:', e);
    total++;
  })
  .finally(() => {
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    server.closeAllConnections();
    server.close();
    fs.rmSync(SSP_TEST_VAULT, { recursive: true, force: true });
    process.exit(passed === total ? 0 : 1);
  });
