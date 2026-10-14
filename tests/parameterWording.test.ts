import './testEnv';
import './localAuthEnv';
import { server } from '../server/index';
import { __resetAiAssistThrottleForTests, sentenceAround } from '../server/routes/aiAssist';
import { getFrameworkControls } from '../src/data/frameworks';
import { resolveParameters } from '../src/data/frameworks/parameters';
import { __resetOllamaCacheForTests } from '../server/ssp/ollama';
import { isExplicitValue, userMessage, validateParameterOptions, validateSentenceOptions } from '../server/ssp/parameterWording';
import { startFakeOllama } from './fakeOllama';

/**
 * "Suggest Parameter Wording": the checks that stop a small model's bad answers (pure), and the API that serves them (roles,
 * privacy, bad input, an unavailable model, malformed answers).
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
process.env.PLATFORM_ADMIN_EMAILS = 'u_aia_owner@test.mil';
delete process.env.AUTH_MODE; // mock tokens, as in the other API tests

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

function unitTests() {
  console.log('--- Explicit values ---');
  for (const ok of ['every 90 days', 'within 24 hours', 'quarterly', '14 characters', 'Immediately', 'real-time', 'weekly']) assert(isExplicitValue(ok), `explicit: "${ok}"`);
  for (const bad of ['periodically', 'regularly', 'a while', 'often', 'as needed']) assert(!isExplicitValue(bad), `not explicit: "${bad}"`);

  console.log('\n--- A parameter: what a small model gets wrong is dropped ---');
  const freq = { kind: 'ASSIGNMENT' as const, prompt: 'organization-defined frequency' };
  const raw = [
    { value: 'every 90 days', note: 'Quarterly is common.' },
    { value: 'periodically', note: 'vague' },
    { value: 'quarterly', note: 'Same idea.' },
    { value: 'Every 90 DAYS', note: 'duplicate' },
    { value: '   ', note: 'empty' },
    { value: 'tbd', note: 'evasive' },
    { value: 'the organization', note: 'evasive' },
  ];
  const f = validateParameterOptions(freq, raw);
  assert(f.options.map((o) => o.text).join() === 'every 90 days,quarterly' && f.rejected === 5, 'vague, duplicate, empty and evasive values are dropped; two explicit ones remain', f);
  assert(validateParameterOptions(freq, [{ value: 'a while', note: '' }]).options.length === 0, 'a frequency without a number or a named period is dropped');
  const roles = { kind: 'ASSIGNMENT' as const, prompt: 'organization-defined personnel or roles' };
  const r = validateParameterOptions(roles, [{ value: 'the ISSM', note: 'Owns the control.' }, { value: 'regularly', note: '' }, { value: 'N/A', note: '' }]);
  assert(r.options.length === 1 && r.options[0].text === 'the ISSM', 'a role needs no digit, but vague or evasive answers are still dropped');
  assert(validateParameterOptions(freq, Array.from({ length: 8 }, (_, i) => ({ value: `every ${i + 1} days`, note: '' }))).options.length === 3, 'at most three options are offered');
  assert(validateParameterOptions(freq, [{ value: 'every 90 days', note: 'x'.repeat(500) }]).options[0].note.length <= 200, 'a long note is cut short');

  const sel = { kind: 'SELECTION' as const, prompt: 'Select one', selectionMode: 'ONE' as const, choices: ['block', 'allow', '[Assignment: organization-defined action]'] };
  const s1 = validateParameterOptions(sel, [{ value: 'Block', note: 'a' }, { value: 'block; allow', note: 'b' }, { value: 'deny', note: 'c' }, { value: '[Assignment: organization-defined action]', note: 'd' }]);
  assert(s1.options.length === 1 && s1.options[0].text === 'block', 'a Selection is answered only with one of its own choices, returned as the catalog wrote it', s1);
  const s2 = validateParameterOptions({ ...sel, selectionMode: 'ONE_OR_MORE' }, [{ value: 'block; allow', note: '' }, { value: 'block; deny', note: '' }]);
  assert(s2.options.length === 1 && s2.options[0].text === 'block; allow', '"one or more" accepts several listed choices, never an unlisted one', s2);
  assert(validateParameterOptions(sel, [{ value: '[Assignment: organization-defined action]', note: '' }]).options.length === 0, 'a choice that still contains an unfilled tag cannot be picked');

  console.log('\n--- A sentence: kept faithful, no vague words left ---');
  const original = 'Accounts are reviewed periodically by the IT lead.';
  const sentence = validateSentenceOptions(original, ['periodically'], [
    { rewrite: 'Accounts are reviewed every 90 days by the IT lead.', note: 'Quarterly review.' },
    { rewrite: 'Accounts are reviewed regularly by the IT lead every 90 days.', note: 'still vague' },
    { rewrite: 'Accounts are reviewed by the IT lead.', note: 'no explicit value' },
    { rewrite: 'Backups run every 7 days and logs are archived.', note: 'drifted' },
    { rewrite: 'Accounts are reviewed periodically by the IT lead.', note: 'unchanged' },
    { rewrite: 'Accounts are reviewed every 90 days by the IT lead.', note: 'duplicate' },
    { rewrite: 'Accounts are reviewed quarterly by the IT lead.', note: 'Alternative.' },
  ]);
  assert(sentence.options.map((o) => o.text).join('|') === 'Accounts are reviewed every 90 days by the IT lead.|Accounts are reviewed quarterly by the IT lead.' && sentence.rejected === 5, 'only faithful rewrites with an explicit value survive', sentence);
  assert(validateSentenceOptions(original, ['periodically'], [{ rewrite: 'x'.repeat(700), note: '' }]).options.length === 0, 'an over-long rewrite is dropped');

  const generic = validateParameterOptions({ kind: 'ASSIGNMENT', prompt: 'organization-defined personnel or roles' }, [
    { value: 'specific organizational roles', note: '' },
    { value: 'designated personnel', note: '' },
    { value: 'relevant criteria', note: '' },
    { value: 'the IT Security Manager', note: 'Owns the control.' },
  ]);
  assert(generic.options.length === 1 && generic.options[0].text === 'the IT Security Manager', 'generic filler ("specific organizational roles", "designated personnel") is dropped; a named role stays', generic);

  const ac2 = getFrameworkControls('NIST_800_53_REV5').find((c) => c.id === 'AC-2')!;
  const params = resolveParameters(ac2);
  const approvals = params.find((p) => p.prompt === 'organization-defined personnel or roles')!;
  const around = sentenceAround(ac2, approvals) ?? '';
  assert(/^Require approvals by <<organization-defined personnel or roles>> for requests to create accounts;$/.test(around), 'an 800-53 parameter is sent with the line of the control that holds it, the blank marked', around);
  const nested = sentenceAround(ac2, params.find((p) => p.prompt === 'organization-defined time period')!) ?? '';
  assert(nested.includes('<<organization-defined time period>>') && nested.startsWith('Notify account managers'), 'a short list item is sent with the line that introduces it', nested);

  console.log('\n--- What is sent to the model ---');
  const msg = userMessage({ mode: 'SENTENCE', control: { id: 'AC.L1-3.1.1', title: 'Authorized Access', requirement: 'Limit system access.' }, sentence: original, terms: ['periodically'] });
  assert(msg.includes('AC.L1-3.1.1') && msg.includes(JSON.stringify(original)) && msg.includes('VAGUE WORDS: periodically') && msg.split('\n').length === 4, 'a sentence request is the control, the one sentence and the vague words: nothing else');
  const pm = userMessage({ mode: 'PARAMETER', control: { id: 'IA-5', title: 'Authenticators', requirement: 'Manage authenticators.' }, parameter: { kind: 'SELECTION', label: 'Selection', prompt: 'Select one', choices: ['a', 'b'] } });
  assert(/CHOICES:\n- a\n- b$/.test(pm), 'a Selection request lists its choices');
  const ctxMsg = userMessage({ mode: 'PARAMETER', control: { id: 'AC-2', title: 'Account Management', requirement: 'Manage accounts.' }, parameter: { kind: 'ASSIGNMENT', label: 'time period', prompt: 'organization-defined time period' }, context: 'Disable accounts within <<organization-defined time period>> when users are terminated.' });
  assert(ctxMsg.includes('SENTENCE: "Disable accounts within <<organization-defined time period>> when users are terminated."'), 'a parameter request carries the sentence the blank sits in, the blank marked');
}

// ---------------------------------------------------------------------------------------------- API

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

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const fake = await startFakeOllama(['llama3.2:3b']);
  fake.onChat = (req) => {
    if (req.system.startsWith('You help a defense contractor')) {
      if (req.user.includes('BADJSON')) return { __raw: 'no' };
      const choices = [...req.user.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
      if (req.user.includes('ONLYVAGUE')) return { options: [{ value: 'periodically', note: '' }, { value: 'as needed', note: '' }] };
      if (choices.length) return { options: [{ value: choices[0], note: 'ok' }, { value: 'something else', note: 'x' }] };
      return { options: [{ value: 'every 90 days', note: 'Quarterly review is common.' }, { value: 'periodically', note: 'vague' }, { value: 'every 90 days', note: 'dup' }] };
    }
    const sentence = JSON.parse(req.user.match(/^SENTENCE: (".*")$/m)![1]) as string;
    return { options: [{ rewrite: sentence.replace(/periodically/i, 'every 90 days'), note: 'Quarterly.' }, { rewrite: 'The IT lead disables accounts.', note: 'drift' }, { rewrite: sentence.replace(/periodically/i, 'regularly'), note: 'vague' }] };
  };
  process.env.OLLAMA_BASE_URL = fake.url;
  process.env.OLLAMA_MODEL = 'llama3.2:3b';
  process.env.SSP_AI_ENABLED = 'true';
  const reset = () => { __resetOllamaCacheForTests(); __resetAiAssistThrottleForTests(); fake.chats.length = 0; fake.models = ['llama3.2:3b']; fake.failNext = 0; };
  reset();

  const owner = person('u_aia_owner');
  const assessor = person('u_aia_assessor');
  const viewer = person('u_aia_viewer');
  const stranger = person('u_aia_stranger');
  const l2 = (await call('POST', '/tenants', owner, undefined, { name: 'ODP Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  for (const [sub, role] of [['u_aia_assessor', 'ASSESSOR'], ['u_aia_viewer', 'VIEWER']] as const) await call('POST', `/tenants/${l2}/members`, owner, l2, { userId: sub, email: `${sub}@test.mil`, role });
  const l1 = (await call('POST', '/tenants', stranger, undefined, { name: 'L1 Org' })).body?.tenant?.id as string;
  const root = `/tenants/${l2}/ai-assist`;
  const ask = (tok: string | null, body: unknown, tenant = l2) => call('POST', `/tenants/${tenant}/ai-assist/parameter-wording`, tok, tenant, body);
  const SENT = 'Accounts are reviewed periodically by the IT lead.';

  console.log('\n--- Status ---');
  const st = await call('GET', `${root}/status`, owner, l2);
  assert(st.status === 200 && st.body?.available === true && st.body?.model === 'llama3.2:3b' && st.body?.canUse === true, 'status: available, with the model, and the owner may use it', st.body);
  const stA = await call('GET', `${root}/status`, assessor, l2);
  assert(stA.status === 200 && stA.body?.canUse === false, 'an assessor can read the status but is told they cannot use it');
  assert((await call('GET', `${root}/status`, null, l2)).status === 401, 'no session: 401');
  process.env.SSP_AI_ENABLED = 'false';
  __resetOllamaCacheForTests();
  const stOff = await call('GET', `${root}/status`, owner, l2);
  assert(stOff.body?.available === false && /switched off/.test(stOff.body?.reason), 'switched off: not available, with the reason');
  process.env.SSP_AI_ENABLED = 'true';
  reset();

  console.log('\n--- A vague sentence ---');
  const sres = await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT, notes: 'SECRET-CUI: the rest of the narrative must never be sent' });
  assert(sres.status === 200 && sres.body?.mode === 'SENTENCE' && sres.body.options.length === 1 && sres.body.options[0].text === 'Accounts are reviewed every 90 days by the IT lead.', 'one good rewrite comes back; the drifting and still-vague ones were dropped', sres.body);
  assert(sres.body?.rejected === 2 && sres.body?.model === 'llama3.2:3b' && sres.body?.promptVersion === 'odp-ai-2', 'with how many were dropped, the model and the prompt version');
  const sent = fake.chats[0];
  assert(sent.user.includes('AC.L1-3.1.1') && sent.user.includes(JSON.stringify(SENT)) && !sent.user.includes('SECRET-CUI') && !sent.system.includes('SECRET-CUI'), 'only the control and the one sentence reached the model: other fields (the rest of the narrative) never do');
  assert(sent.format?.required?.includes('options') && sent.options.temperature === 0, 'the answer is schema-constrained and deterministic');
  assert((await ask(assessor, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 403 && (await ask(viewer, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 403, 'an assessor and a viewer cannot ask (403): it is an editing action');
  assert((await ask(null, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 401, 'no session: 401');
  assert((await ask(stranger, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 403, 'a person from another tenant is refused (403)');

  console.log('\n--- An open parameter ---');
  const registry = await ask(owner, { controlId: 'AC.L2-3.1.8', parameterId: 'ac_3_1_8_window' });
  assert(registry.status === 200 && registry.body?.mode === 'PARAMETER' && registry.body.options.map((o: Json) => o.text).join() === 'every 90 days', 'a registry parameter (AC 3.1.8 observation window) is answered with explicit values only', registry.body);
  assert(/Observation Window/.test(fake.chats[fake.chats.length - 1].user) && /REQUIREMENT:/.test(fake.chats[fake.chats.length - 1].user), 'the control and the parameter are in the prompt');
  assert(/SENTENCE: "[^"]*\(the blank is: Observation Window\)"/.test(fake.chats[fake.chats.length - 1].user), 'a registry parameter is sent with the objective it belongs to', fake.chats[fake.chats.length - 1].user);
  const withCtx = await ask(owner, { controlId: 'AC.L1-3.1.1', parameter: { kind: 'ASSIGNMENT', prompt: 'organization-defined frequency' }, context: 'Accounts are reviewed <<organization-defined frequency>> by the IT lead.' });
  assert(withCtx.status === 200 && fake.chats[fake.chats.length - 1].user.includes('SENTENCE: "Accounts are reviewed <<organization-defined frequency>> by the IT lead."'), 'the editor may pass the one sentence of the narrative that holds a tag');
  const inlineSel = await ask(owner, { controlId: 'AC.L1-3.1.1', parameter: { kind: 'SELECTION', label: 'Selection', prompt: 'Select one', choices: ['lock the account', 'notify the administrator'] } });
  assert(inlineSel.status === 200 && inlineSel.body.options.length === 1 && inlineSel.body.options[0].text === 'lock the account', 'a Selection found in the narrative is answered with one of its choices (the made-up one is dropped)', inlineSel.body);
  const inlineAssign = await ask(owner, { controlId: 'AC.L1-3.1.1', parameter: { kind: 'ASSIGNMENT', prompt: 'organization-defined frequency' } });
  assert(inlineAssign.status === 200 && inlineAssign.body.options[0].text === 'every 90 days', 'an Assignment tag found in the narrative works the same way');
  const vagueOnly = await ask(owner, { controlId: 'AC.L1-3.1.1', parameter: { kind: 'ASSIGNMENT', prompt: 'organization-defined frequency ONLYVAGUE' } });
  assert(vagueOnly.status === 200 && vagueOnly.body.options.length === 0 && vagueOnly.body.rejected === 2, 'if every answer is vague the result is an empty list, not an error');

  console.log('\n--- Bad requests ---');
  const bad: Array<[string, unknown, number]> = [
    ['no control id', { sentence: SENT }, 400],
    ['a malformed control id', { controlId: '../../etc', sentence: SENT }, 400],
    ['none of parameterId / parameter / sentence', { controlId: 'AC.L1-3.1.1' }, 400],
    ['two of them', { controlId: 'AC.L1-3.1.1', sentence: SENT, parameter: { kind: 'ASSIGNMENT', prompt: 'x' } }, 400],
    ['a sentence without vague wording', { controlId: 'AC.L1-3.1.1', sentence: 'Accounts are reviewed every 90 days.' }, 400],
    ['a sentence that is too long', { controlId: 'AC.L1-3.1.1', sentence: 'periodically '.repeat(100) }, 400],
    ['an unknown parameter id', { controlId: 'AC.L1-3.1.1', parameterId: 'nope' }, 400],
    ['a parameter of the wrong kind', { controlId: 'AC.L1-3.1.1', parameter: { kind: 'FREEFORM', prompt: 'x' } }, 400],
    ['a Selection without choices', { controlId: 'AC.L1-3.1.1', parameter: { kind: 'SELECTION', prompt: 'x' } }, 400],
    ['a Selection with too many choices', { controlId: 'AC.L1-3.1.1', parameter: { kind: 'SELECTION', prompt: 'x', choices: Array.from({ length: 13 }, (_, i) => `c${i}`) } }, 400],
    ['an unknown control', { controlId: 'ZZ-99', sentence: SENT }, 404],
  ];
  for (const [name, body, status] of bad) assert((await ask(owner, body)).status === status, `${name}: ${status}`);
  const noModelCalls = fake.chats.length;
  await ask(owner, { controlId: 'AC.L1-3.1.1' });
  assert(fake.chats.length === noModelCalls, 'a refused request never calls the model');
  const notInProgram = await ask(stranger, { controlId: 'AU.L2-3.3.1', sentence: SENT }, l1);
  assert(notInProgram.status === 403 && notInProgram.body?.code === 'framework_not_enabled', 'a control outside the tenant\'s assessment program is refused (403)', notInProgram.body);

  console.log('\n--- The model is unavailable or answers badly ---');
  reset();
  fake.onChat = () => ({ __raw: 'sure, here you go' });
  const bj = await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT });
  assert(bj.status === 502 && bj.body?.code === 'ai_bad_answer', 'an answer that is not JSON is a 502, with a plain message');
  fake.onChat = () => ({ options: 'many' });
  assert((await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 502, 'an answer of the wrong shape is a 502 too');
  reset();
  fake.models = [];
  __resetOllamaCacheForTests();
  const missing = await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT });
  assert(missing.status === 503 && missing.body?.code === 'ai_unavailable' && /not installed/.test(missing.body?.error), 'model not installed: 503 with the reason');
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
  reset();
  assert((await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 503, 'Ollama unreachable: 503');
  process.env.OLLAMA_BASE_URL = 'https://api.openai.com';
  reset();
  const blocked = await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT });
  assert(blocked.status === 503 && fake.chats.length === 0, 'a public host is never contacted: the local-network guard applies here too');
  process.env.OLLAMA_BASE_URL = fake.url;
  process.env.SSP_AI_ENABLED = 'false';
  reset();
  assert((await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status === 503, 'switched off: 503');
  process.env.SSP_AI_ENABLED = 'true';
  reset();

  console.log('\n--- Throttle ---');
  fake.onChat = () => ({ options: [{ rewrite: 'Accounts are reviewed every 90 days by the IT lead.', note: '' }] });
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await ask(owner, { controlId: 'AC.L1-3.1.1', sentence: SENT })).status;
  assert(last === 429, 'more than 20 requests a minute from one person are throttled (429)', last);

  await fake.close();
}

async function run() {
  unitTests();
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
    server.closeAllConnections();
    server.close();
    process.exit(passed === total ? 0 : 1);
  });
