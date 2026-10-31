import './testEnv';
import { server } from '../server/index';
import { readSspMetadata } from '../server/sspMetadata';
import { SSP_METADATA_FIELDS, SSP_METADATA_MAX_CHARS, validateSspMetadata } from '../src/types/sspMetadata';
import { STACK_PROFILE_MAX_BYTES, validateStackProfile } from '../src/data/stackProfileSchema';

/**
 * SSP metadata over HTTP (issue #84): GET/PUT /api/v1/ssp-metadata, one row per program (x-program-id), written by TENANT_OWNER / MSP_ADMIN,
 * read by every role. Covers the stale-write rule (expectedUpdatedAt required, 409 stale_write with only the stamp), the field validation (a 400
 * names the field, never the value), program isolation and the archive rule, the cascade of a program delete, the first-writer race, the
 * digest-only history event, the tenant stack profile on PATCH /tenants/:id, and that no console line carries the text.
 * Runs against the in-memory store. Boots the server on port 8080: run it alone.
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

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

const MARK = 'ENV-MARK-84';

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_sm_owner');
  const rival = person('u_sm_rival');
  const viewer = person('u_sm_viewer');
  const assessor = person('u_sm_assessor');

  // SM20: every console line written while the suite runs is kept, to prove none carries the text
  const captured: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const capture = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
  console.log = capture(origLog);
  console.error = capture(origError);

  console.log('--- Pure validation ---');
  const okMeta = validateSspMetadata({ systemName: 'S', systemEnvironment: MARK });
  assert(okMeta.ok && okMeta.value.systemEnvironment === MARK, 'V1 validateSspMetadata accepts known string fields');
  const badKey = validateSspMetadata({ foo: 'x' });
  const badType = validateSspMetadata({ systemName: 5 });
  const badLen = validateSspMetadata({ cageCode: 'X'.repeat(SSP_METADATA_MAX_CHARS.cageCode + 1) });
  const badArr = validateSspMetadata([]);
  const badNull = validateSspMetadata(null);
  assert(!badKey.ok && !badType.ok && !badLen.ok && !badArr.ok && !badNull.ok, 'V2 an unknown key, a non-string, an over-limit value, an array and null are rejected');
  const leak = validateSspMetadata({ systemName: 5 });
  assert(!leak.ok && leak.error.includes('systemName') && !validateSspMetadata({ systemEnvironment: 7 }).ok, 'V3 the error names the field');
  const leakValue = validateSspMetadata({ systemName: 'ok', samStatus: 'S'.repeat(40) + MARK });
  assert(!leakValue.ok && !leakValue.error.includes(MARK), 'V4 the error never echoes the value');
  assert(SSP_METADATA_FIELDS.length === 11 && SSP_METADATA_FIELDS.every((k) => SSP_METADATA_MAX_CHARS[k] > 0), 'V5 eleven fields, each with a limit');

  const goodProfile = { identityProvider: 'OKTA', edrSolution: 'SENTINELONE', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'JAMF', siemSolution: 'ELASTIC' };
  assert(validateStackProfile(goodProfile).ok && validateStackProfile({ ...goodProfile, odpParams: { AC_2_MAX: '30' } }).ok, 'V6 validateStackProfile accepts the five enums, with or without odpParams');
  const missing: Record<string, unknown> = { ...goodProfile };
  delete missing.mdmSolution;
  assert(
    !validateStackProfile({ ...goodProfile, identityProvider: 'NOPE' }).ok &&
      !validateStackProfile(missing).ok &&
      !validateStackProfile({ ...goodProfile, extra: 1 }).ok &&
      !validateStackProfile({ ...goodProfile, odpParams: { lower: 'x' } }).ok &&
      !validateStackProfile({ ...goodProfile, odpParams: { AC: 5 } }).ok &&
      !validateStackProfile({ ...goodProfile, odpParams: { AC: 'x'.repeat(1001) } }).ok &&
      !validateStackProfile([]).ok,
    'V7 a bad enum, a missing key, an unknown key, a bad odp key, a non-string or long odp value and an array are rejected'
  );
  const manyParams = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`P_${i}`, 'x']));
  assert(!validateStackProfile({ ...goodProfile, odpParams: manyParams }).ok && STACK_PROFILE_MAX_BYTES === 16384, 'V8 more than 50 odp parameters are rejected');

  console.log('--- Setup: a tenant with a viewer and an assessor, two more programs; a rival tenant ---');
  const mk = async (token: string, name: string) =>
    (await call('POST', '/tenants', token, undefined, { name, primaryFramework: 'CMMC_L1', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  const T = await mk(owner, 'SSP Meta T');
  const R = await mk(rival, 'SSP Meta R');
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_sm_viewer', email: 'u_sm_viewer@test.mil', role: 'VIEWER' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_sm_assessor', email: 'u_sm_assessor@test.mil', role: 'ASSESSOR' });
  const DEF = (await call('GET', `/tenants/${T}/programs`, owner, T)).body?.programs?.find((p: Json) => p.isDefault)?.id as string;
  const newProgram = async (name: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId: 'CMMC_L1' })).body?.program?.id as string;
  const P2 = await newProgram('SSP second');
  const P3 = await newProgram('SSP third');
  const P4 = await newProgram('SSP fourth');
  assert(Boolean(T && R && DEF && P2 && P3 && P4), 'setup: tenants and programs exist', { T, R, DEF, P2, P3, P4 });

  const sm1 = await call('GET', '/ssp-metadata', owner, T);
  assert(sm1.status === 200 && sm1.body?.metadata === null && sm1.body.updatedAt === null && sm1.body.updatedBy === null, 'SM1 GET on the default program with no row -> 200, metadata null, updatedAt null', sm1.body);

  const sm2 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-A', systemEnvironment: MARK }, expectedUpdatedAt: null });
  assert(
    sm2.status === 200 && sm2.body?.changed === true && typeof sm2.body.updatedAt === 'string' && sm2.body.metadata?.systemName === 'SYS-A' && sm2.body.metadata.systemEnvironment === MARK,
    'SM2 owner PUT with expectedUpdatedAt null -> 200, changed true, a stamp, the metadata echoed',
    sm2.body
  );
  const stamp1 = sm2.body?.updatedAt as string;

  const sm3 = await call('GET', '/ssp-metadata', owner, T);
  assert(sm3.status === 200 && sm3.body?.updatedAt === stamp1 && sm3.body.metadata?.systemEnvironment === MARK && sm3.body.updatedBy === 'u_sm_owner', 'SM3 GET returns the saved metadata, stamp and writer', sm3.body);

  const sm4 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-B' }, expectedUpdatedAt: null });
  assert(
    sm4.status === 409 && sm4.body?.code === 'stale_write' && sm4.body.current?.updatedAt === stamp1 && !JSON.stringify(sm4.body).includes(MARK),
    'SM4 a second first-write (null) -> 409 stale_write with the current stamp and no text',
    sm4.body
  );

  const sm5 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-A', systemEnvironment: MARK + '-2' }, expectedUpdatedAt: stamp1 });
  const stamp2 = sm5.body?.updatedAt as string;
  assert(sm5.status === 200 && sm5.body?.changed === true && Date.parse(stamp2) > Date.parse(stamp1), 'SM5 PUT with the current stamp and new text -> 200 with a later stamp', sm5.body);

  const sm6 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-C' }, expectedUpdatedAt: stamp1 });
  assert(sm6.status === 409 && sm6.body?.code === 'stale_write' && sm6.body.current?.updatedAt === stamp2, 'SM6 PUT with the old stamp -> 409 stale_write', sm6.body);

  const sm7 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-A', systemEnvironment: MARK + '-2' }, expectedUpdatedAt: stamp2 });
  assert(sm7.status === 200 && sm7.body?.changed === false && sm7.body.updatedAt === stamp2, 'SM7 identical content with the current stamp -> 200, changed false, stamp unchanged', sm7.body);

  const sm8 = [
    (await call('GET', '/ssp-metadata', viewer, T)).status,
    (await call('PUT', '/ssp-metadata', viewer, T, { metadata: { systemName: 'V' }, expectedUpdatedAt: stamp2 })).status,
    (await call('PUT', '/ssp-metadata', assessor, T, { metadata: { systemName: 'A' }, expectedUpdatedAt: stamp2 })).status,
    (await call('GET', '/ssp-metadata', assessor, T)).status,
  ];
  assert(JSON.stringify(sm8) === JSON.stringify([200, 403, 403, 200]), 'SM8 every role reads (200); a viewer and an assessor cannot write (403)', sm8);

  const sm9a = await call('GET', '/ssp-metadata', owner, T, undefined, P2);
  const sm9Put = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'P2-NAME' }, expectedUpdatedAt: null }, P2);
  const sm9Def = await call('GET', '/ssp-metadata', owner, T);
  assert(
    sm9a.status === 200 && sm9a.body?.metadata === null && sm9Put.status === 200 && sm9Def.body?.updatedAt === stamp2 && sm9Def.body.metadata?.systemName === 'SYS-A',
    'SM9 another program starts empty, and writing to it leaves the default program alone',
    [sm9a.body, sm9Put.status, sm9Def.body]
  );

  const sm10 = await call('GET', '/ssp-metadata', rival, R, undefined, DEF);
  const sm10Put = await call('PUT', '/ssp-metadata', rival, R, { metadata: { systemName: 'X' }, expectedUpdatedAt: null }, DEF);
  assert(sm10.status === 404 && sm10.body?.code === 'program_not_found' && sm10Put.status === 404, "SM10 another tenant's program id is 404 program_not_found for read and write", [sm10.status, sm10Put.status]);

  const put = (metadata: unknown, expectedUpdatedAt: unknown = stamp2, program?: string) => call('PUT', '/ssp-metadata', owner, T, { metadata, expectedUpdatedAt }, program);
  const sm11 = await put({ foo: 'x' });
  assert(sm11.status === 400 && sm11.body?.code === 'invalid_ssp_metadata', 'SM11 an unknown field -> 400 invalid_ssp_metadata', sm11.body);
  const sm12 = await put({ systemName: 5 });
  assert(sm12.status === 400 && sm12.body?.code === 'invalid_ssp_metadata' && String(sm12.body.error).includes('systemName'), 'SM12 a non-string value -> 400 naming the field', sm12.body);
  const sm13a = await put({ systemEnvironment: 'E'.repeat(20001) });
  const sm13b = await put({ systemEnvironment: 'E'.repeat(20000) });
  assert(sm13a.status === 400 && sm13b.status === 200, 'SM13 20 001 characters -> 400; exactly 20 000 -> 200', [sm13a.status, sm13b.status]);
  const stamp3 = sm13b.body?.updatedAt as string;
  const sm14a = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'Z' } });
  const sm14b = await put({ systemName: 'Z' }, 'yesterday');
  const sm14c = await put({ systemName: 'Z' }, 12345);
  assert(sm14a.status === 400 && sm14b.status === 400 && sm14c.status === 400, 'SM14 a missing, malformed or numeric expectedUpdatedAt -> 400', [sm14a.status, sm14b.status, sm14c.status]);
  const sm15a = await call('PUT', '/ssp-metadata', owner, T, { expectedUpdatedAt: stamp3 });
  const sm15b = await put([], stamp3);
  assert(sm15a.status === 400 && sm15b.status === 400, 'SM15 missing or array metadata -> 400', [sm15a.status, sm15b.status]);
  const afterBad = await call('GET', '/ssp-metadata', owner, T);
  assert(afterBad.body?.updatedAt === stamp3, 'SM15b the refused writes changed nothing', afterBad.body);

  const archive = await call('POST', `/tenants/${T}/programs/${P2}/archive`, owner, T);
  const sm16w = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'ARCH' }, expectedUpdatedAt: sm9Put.body?.updatedAt }, P2);
  const sm16r = await call('GET', '/ssp-metadata', owner, T, undefined, P2);
  assert(archive.status === 200 && sm16w.status === 409 && sm16w.body?.code === 'program_archived' && sm16r.status === 200 && sm16r.body?.metadata?.systemName === 'P2-NAME', 'SM16 an archived program: PUT 409 program_archived, GET 200', [sm16w.status, sm16w.body, sm16r.status]);

  const sm17Put = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'P3-NAME' }, expectedUpdatedAt: null }, P3);
  const sm17Before = await readSspMetadata({ tenantId: T, programId: P3 });
  const sm17Del = await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T);
  const sm17After = await readSspMetadata({ tenantId: T, programId: P3 });
  assert(sm17Put.status === 200 && sm17Before.metadata?.systemName === 'P3-NAME' && sm17Del.status === 204 && sm17After.metadata === null, 'SM17 deleting a program removes its SSP metadata', [sm17Put.status, sm17Del.status, sm17After]);

  const race = await Promise.all([
    call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'RACE-1' }, expectedUpdatedAt: null }, P4),
    call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'RACE-2' }, expectedUpdatedAt: null }, P4),
  ]);
  const statuses = race.map((r) => r.status).sort();
  assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'SM18 two concurrent first writes: exactly one 200 and one 409', statuses);

  const sm19ok = await call('PATCH', `/tenants/${T}`, owner, T, { stackProfile: { ...goodProfile, odpParams: { AC_2_MAX: '30' } } });
  const sm19List = await call('GET', '/tenants', owner);
  const listed = (sm19List.body?.tenants ?? []).find((t: Json) => t.id === T);
  assert(
    sm19ok.status === 200 && sm19ok.body?.tenant?.stackProfile?.identityProvider === 'OKTA' && listed?.stackProfile?.edrSolution === 'SENTINELONE' && listed.stackProfile.odpParams?.AC_2_MAX === '30',
    'SM19 owner PATCH { stackProfile } -> 200 and GET /tenants lists it',
    [sm19ok.status, listed?.stackProfile]
  );
  const patchProfile = (token: string, stackProfile: unknown) => call('PATCH', `/tenants/${T}`, token, T, { stackProfile });
  const sm19bad = [
    (await patchProfile(owner, { ...goodProfile, identityProvider: 'NOPE' })).status,
    (await patchProfile(owner, { ...goodProfile, extra: 'x' })).status,
    (await patchProfile(owner, { ...goodProfile, odpParams: { AC: 5 } })).status,
    (await patchProfile(viewer, goodProfile)).status,
  ];
  const sm19Still = (await call('GET', '/tenants', owner)).body?.tenants?.find((t: Json) => t.id === T);
  assert(JSON.stringify(sm19bad) === JSON.stringify([400, 400, 400, 403]) && sm19Still?.stackProfile?.identityProvider === 'OKTA', 'SM19b a bad enum, an unknown key, a numeric odp value -> 400; a viewer -> 403; the stored profile is unchanged', sm19bad);

  const eventsRes = await call('GET', `/tenants/${T}/programs/${DEF}/events`, owner, T);
  const events = (eventsRes.body?.events ?? []) as Json[];
  const changed = events.filter((e) => e.kind === 'ssp_metadata_changed');
  const latest = changed.find((e) => e.newValue?.fields?.systemEnvironment?.length === 20000);
  const second = changed.find((e) => e.newValue?.fields?.systemEnvironment?.length === (MARK + '-2').length);
  assert(
    eventsRes.status === 200 && changed.length === 3 && Boolean(latest) && /^[0-9a-f]{64}$/.test(second?.newValue.fields.systemEnvironment.sha256 ?? '') && Object.keys(second?.newValue.fields ?? {}).includes('systemEnvironment'),
    'SM21 the history has ssp_metadata_changed events naming the changed fields with a sha256 and a length',
    changed.map((e) => Object.keys(e.newValue?.fields ?? {}))
  );
  assert(!JSON.stringify(events).includes(MARK) && !JSON.stringify(events).includes('SYS-A'), 'SM21b no event carries any of the text');

  console.log = origLog;
  console.error = origError;
  assert(captured.length > 0 && !captured.some((l) => l.includes(MARK) || l.includes('SYS-A') || l.includes('P2-NAME')), 'SM20 no console line written during the suite contains the text', captured.filter((l) => l.includes(MARK)));

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
