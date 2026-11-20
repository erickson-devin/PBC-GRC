import './testEnv';
import { server } from '../server/index';
import { firstProgram } from './programFixture';
import { listProgramEvents } from '../server/programs';
import { readSspProfile } from '../server/sspProfile';
import { computeSectionDigest, readSspReviews } from '../server/sspReviews';
import { readSspMetadata } from '../server/sspMetadata';

/**
 * SSP profile and section sign-offs over HTTP (issues #238, #241, #242, #246): GET/PUT /api/v1/ssp-metadata/profile (structured SSP fields,
 * its own stamp, expectedUpdatedAt required, 409 stale_write) and GET/POST /api/v1/ssp-metadata/reviews (the server computes the content digest of
 * each section's saved fields, the reviewer comes from the session, a stale digest is a 409 section_changed, sign-offs are append-only).
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

const MARK = 'PROFILE-MARK-238';

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_sp_owner');
  const admin2 = person('u_sp_admin2');
  const rival = person('u_sp_rival');
  const viewer = person('u_sp_viewer');
  const assessor = person('u_sp_assessor');

  // R15: every console line written while the suite runs is kept, to prove none carries the text
  const captured: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const capture = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
  console.log = capture(origLog);
  console.error = capture(origError);

  console.log('--- Setup: a tenant with an admin, a viewer and an assessor, three more programs; a rival tenant ---');
  const mk = async (token: string, name: string) =>
    (await call('POST', '/tenants', token, undefined, { name, primaryFramework: 'CMMC_L1', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  const T = await mk(owner, 'SSP Profile T');
  const R = await mk(rival, 'SSP Profile R');
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_sp_admin2', email: 'u_sp_admin2@test.mil', role: 'TENANT_ADMIN' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_sp_viewer', email: 'u_sp_viewer@test.mil', role: 'VIEWER' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_sp_assessor', email: 'u_sp_assessor@test.mil', role: 'ASSESSOR' });
  const DEF = (await firstProgram(T)).id;
  await firstProgram(R);
  const newProgram = async (name: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId: 'CMMC_L1' })).body?.program?.id as string;
  const P2 = await newProgram('SSP profile second');
  const P3 = await newProgram('SSP profile third');
  const P4 = await newProgram('SSP profile fourth');
  assert(Boolean(T && R && DEF && P2 && P3 && P4), 'setup: tenants and programs exist', { T, R, DEF, P2, P3, P4 });

  console.log('--- Profile ---');
  const fullProfile = {
    systemIdentifier: 'SYS-1',
    confidentialityImpact: 'MODERATE',
    integrityImpact: 'MODERATE',
    availabilityImpact: 'LOW',
    roles: [{ id: 'r1', roleKey: 'system_owner', name: 'Jane Doe', email: 'jane@test.mil' }, { id: 'r2', roleKey: 'isso_ciso', name: MARK, email: '' }],
    maintenance: { hardwareMaintainedByOrg: true, hardwareOwnedByOrg: false, softwareMaintainedByOrg: true, softwareOwnedByOrg: true, exceptions: `Leased printers ${MARK}` },
  };
  const p1 = await call('GET', '/ssp-metadata/profile', owner, T);
  assert(p1.status === 200 && p1.body?.profile === null && p1.body.updatedAt === null && p1.body.updatedBy === null, 'P1 GET on a fresh program -> 200, all null', p1.body);

  const p2 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: fullProfile, expectedUpdatedAt: null });
  const stamp1 = p2.body?.updatedAt as string;
  assert(p2.status === 200 && p2.body?.changed === true && typeof stamp1 === 'string' && p2.body.profile?.systemIdentifier === 'SYS-1', 'P2 owner PUT with expectedUpdatedAt null -> 200, changed true, a stamp', p2.body);

  const p3 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: fullProfile, expectedUpdatedAt: stamp1 });
  assert(p3.status === 200 && p3.body?.changed === false && p3.body.updatedAt === stamp1, 'P3 the same profile again with the returned stamp -> 200, changed false, stamp unchanged', p3.body);

  const p4a = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { ...fullProfile, systemIdentifier: 'SYS-2' }, expectedUpdatedAt: stamp1 });
  const stamp2 = p4a.body?.updatedAt as string;
  const p4 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { ...fullProfile, systemIdentifier: 'SYS-3' }, expectedUpdatedAt: stamp1 });
  assert(
    p4a.status === 200 && Date.parse(stamp2) > Date.parse(stamp1) && p4.status === 409 && p4.body?.code === 'stale_write' && p4.body.current?.updatedAt === stamp2 && !JSON.stringify(p4.body).includes(MARK),
    'P4 PUT with the previous stamp after a change -> 409 stale_write with the current stamp and no text',
    [p4a.status, p4.status, p4.body]
  );

  const p5 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: fullProfile });
  assert(p5.status === 400 && p5.body?.code === 'invalid_expected_updated_at', 'P5 PUT without expectedUpdatedAt -> 400 invalid_expected_updated_at', p5.body);

  const p6 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { confidentialityImpact: 'EXTREME' }, expectedUpdatedAt: stamp2 });
  assert(p6.status === 400 && p6.body?.code === 'invalid_ssp_profile' && String(p6.body.error).includes('confidentialityImpact'), 'P6 an unknown impact level -> 400 invalid_ssp_profile naming the field', p6.body);

  const p7 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { roles: [{ id: 'r1', roleKey: 'system_owner', name: 'X', email: `x-${MARK}` }] }, expectedUpdatedAt: stamp2 });
  assert(p7.status === 400 && p7.body?.code === 'invalid_ssp_profile' && String(p7.body.error).includes('roles[0].email') && !JSON.stringify(p7.body).includes(MARK), 'P7 a bad email -> 400 with the path and not the value', p7.body);

  const p8 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { foo: 1 }, expectedUpdatedAt: stamp2 });
  assert(p8.status === 400 && p8.body?.code === 'invalid_ssp_profile', 'P8 an unknown key -> 400 invalid_ssp_profile', p8.body);

  const p9a = await call('PUT', '/ssp-metadata/profile', viewer, T, { profile: fullProfile, expectedUpdatedAt: stamp2 });
  const p9b = await call('PUT', '/ssp-metadata/profile', assessor, T, { profile: fullProfile, expectedUpdatedAt: stamp2 });
  const p9c = await call('GET', '/ssp-metadata/profile', viewer, T);
  assert(p9a.status === 403 && p9b.status === 403 && p9c.status === 200 && p9c.body?.profile?.systemIdentifier === 'SYS-2', 'P9 viewer and assessor PUT -> 403; a viewer can read the profile', [p9a.status, p9b.status, p9c.status]);

  const p10 = await call('GET', '/ssp-metadata/profile', owner, T, undefined, P3);
  assert(p10.status === 200 && p10.body?.profile === null, "P10 another program does not see the first program's profile", p10.body);

  const arch = await call('POST', `/tenants/${T}/programs/${P4}/archive`, owner, T);
  const p11 = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: fullProfile, expectedUpdatedAt: null }, P4);
  assert(arch.status === 200 && p11.status === 409 && p11.body?.code === 'program_archived', 'P11 PUT on an archived program -> 409 program_archived', [arch.status, p11.status, p11.body]);

  const p12Put = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: fullProfile, expectedUpdatedAt: null }, P2);
  const p12Before = await readSspProfile({ tenantId: T, programId: P2 });
  const p12Del = await call('DELETE', `/tenants/${T}/programs/${P2}`, owner, T);
  const p12After = await readSspProfile({ tenantId: T, programId: P2 });
  const p12Rev = await readSspReviews({ tenantId: T, programId: P2 });
  assert(p12Put.status === 200 && p12Before.profile?.systemIdentifier === 'SYS-1' && p12Del.status === 204 && p12After.profile === null && p12Rev.history.length === 0, 'P12 deleting a program removes its profile', [p12Put.status, p12Del.status, p12After]);

  const events = await listProgramEvents({ tenantId: T, programId: DEF });
  const evJson = JSON.stringify(events);
  const ev0 = events[0] as any;
  assert(
    ev0?.kind === 'ssp_metadata_changed' && typeof ev0.newValue?.profile?.systemIdentifier?.sha256 === 'string' && typeof ev0.newValue.profile.systemIdentifier.length === 'number' && !evJson.includes(MARK) && !evJson.includes('SYS-'),
    'P13 the profile history event holds the changed keys with a sha256 and length, no text',
    ev0
  );

  const m1 = await call('GET', '/ssp-metadata', owner, T);
  const metaStamp = m1.body?.updatedAt ?? null;
  const pm = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { ...fullProfile, systemIdentifier: 'SYS-4' }, expectedUpdatedAt: stamp2 });
  const m2 = await call('GET', '/ssp-metadata', owner, T);
  const m3 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-NAME', systemEnvironment: 'ENV' }, expectedUpdatedAt: metaStamp });
  assert(pm.status === 200 && m2.body?.updatedAt === metaStamp && m3.status === 200 && m3.body?.changed === true, 'P14 a profile PUT leaves the metadata stamp alone, and a metadata PUT with the old stamp still succeeds', [pm.status, m2.body?.updatedAt, m3.status]);
  let profileStamp = pm.body?.updatedAt as string;
  let metaStamp2 = m3.body?.updatedAt as string;

  console.log('--- Reviews ---');
  const IDS = ['identification', 'roles', 'environment', 'maintenance'];
  const fresh = await call('GET', '/ssp-metadata/reviews', owner, T, undefined, P3);
  assert(
    fresh.status === 200 && fresh.body?.sections?.length === 4 && IDS.every((id, i) => fresh.body!.sections[i].sectionId === id) &&
      fresh.body.sections.every((s: Json) => s.latest === null && s.reviewed === false && /^[0-9a-f]{64}$/.test(s.currentDigest)) && fresh.body.history.length === 0,
    'R1 a fresh GET /reviews -> 4 sections in order, no review, a 64-hex digest each',
    fresh.body
  );

  const getRev = async (token = owner, program = DEF) => (await call('GET', '/ssp-metadata/reviews', token, T, undefined, program)).body as Json;
  const stateOf = (r: Json, id: string) => r.sections.find((s: Json) => s.sectionId === id);
  const rev0 = await getRev();
  const r2 = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'identification', expectedDigest: stateOf(rev0, 'identification').currentDigest });
  assert(
    r2.status === 201 && r2.body?.changed === true && r2.body.review?.reviewerUserId === 'u_sp_owner' && r2.body.review.reviewerName === 'u_sp_owner' && r2.body.review.reviewerRole === 'TENANT_OWNER' && r2.body.section?.reviewed === true,
    'R2 owner POST with the current digest -> 201, the reviewer is the caller, role TENANT_OWNER, section reviewed',
    r2.body
  );

  const rev1 = await getRev();
  const r3 = await call('POST', '/ssp-metadata/reviews', admin2, T, { sectionId: 'roles', expectedDigest: stateOf(rev1, 'roles').currentDigest, reviewerUserId: 'x', reviewerName: 'Forged', reviewerRole: 'VIEWER', createdAt: '2000-01-01T00:00:00.000Z' });
  assert(
    r3.status === 201 && r3.body?.review?.reviewerUserId === 'u_sp_admin2' && r3.body.review.reviewerName === 'u_sp_admin2' && r3.body.review.reviewerRole === 'TENANT_ADMIN' && !String(r3.body.review.createdAt).startsWith('2000'),
    'R3 reviewer fields and createdAt in the body are ignored',
    r3.body
  );

  const idBefore = await getRev();
  assert(stateOf(idBefore, 'identification').reviewed === true && stateOf(idBefore, 'roles').reviewed === true && stateOf(idBefore, 'environment').reviewed === false, 'R2b only the signed sections show reviewed');

  const r4 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-NAME-2', systemEnvironment: 'ENV' }, expectedUpdatedAt: metaStamp2 });
  metaStamp2 = r4.body?.updatedAt as string;
  const afterName = await getRev();
  assert(r4.status === 200 && stateOf(afterName, 'identification').reviewed === false && stateOf(afterName, 'identification').latest?.contentSha256 === r2.body?.review.contentSha256 && afterName.history.length === 2, 'R4 a systemName change makes identification unreviewed; the history keeps the sign-off', afterName);

  const r1b = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'identification', expectedDigest: stateOf(afterName, 'identification').currentDigest });
  const envSigned = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: stateOf(afterName, 'environment').currentDigest });
  const r5 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-NAME-2', systemEnvironment: 'ENV', assessmentDate: '2026-01-01' }, expectedUpdatedAt: metaStamp2 });
  metaStamp2 = r5.body?.updatedAt as string;
  const afterDate = await getRev();
  assert(r1b.status === 201 && envSigned.status === 201 && r5.status === 200 && r5.body?.changed === true && stateOf(afterDate, 'identification').reviewed === true && stateOf(afterDate, 'environment').reviewed === true, 'R5 an assessmentDate-only change leaves identification reviewed', afterDate.sections);

  const r6 = await call('PUT', '/ssp-metadata', owner, T, { metadata: { systemName: 'SYS-NAME-2', systemEnvironment: 'ENV', systemBoundaryScope: 'BOUNDARY' }, expectedUpdatedAt: metaStamp2 });
  metaStamp2 = r6.body?.updatedAt as string;
  const afterScope = await getRev();
  assert(r6.status === 200 && stateOf(afterScope, 'environment').reviewed === false && stateOf(afterScope, 'identification').reviewed === true && stateOf(afterScope, 'roles').reviewed === true, 'R6 a systemBoundaryScope change affects environment only', afterScope.sections);

  const histLen = afterScope.history.length;
  const r7 = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: stateOf(afterDate, 'environment').currentDigest });
  const histAfter7 = await getRev();
  assert(
    r7.status === 409 && r7.body?.code === 'section_changed' && r7.body.currentDigest === stateOf(afterScope, 'environment').currentDigest && histAfter7.history.length === histLen,
    'R7 a stale expectedDigest -> 409 section_changed with the current digest, nothing written',
    r7.body
  );

  const r8a = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'controls', expectedDigest: stateOf(afterScope, 'environment').currentDigest });
  const r8b = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: 'abc' });
  const r8c = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: stateOf(afterScope, 'environment').currentDigest.toUpperCase() });
  assert(r8a.status === 400 && r8a.body?.code === 'invalid_section' && r8b.status === 400 && r8b.body?.code === 'invalid_expected_digest' && r8c.status === 400, 'R8 an unknown section -> 400 invalid_section; a bad digest -> 400 invalid_expected_digest', [r8a.body, r8b.body, r8c.status]);

  const r9a = await call('POST', '/ssp-metadata/reviews', viewer, T, { sectionId: 'environment', expectedDigest: stateOf(afterScope, 'environment').currentDigest });
  const r9b = await call('POST', '/ssp-metadata/reviews', assessor, T, { sectionId: 'environment', expectedDigest: stateOf(afterScope, 'environment').currentDigest });
  const r9c = await call('GET', '/ssp-metadata/reviews', viewer, T);
  assert(r9a.status === 403 && r9b.status === 403 && r9c.status === 200 && r9c.body?.history.length === histLen, 'R9 viewer and assessor POST -> 403; a viewer can read the history', [r9a.status, r9b.status, r9c.status]);

  const envDigest = stateOf(afterScope, 'environment').currentDigest;
  const r10a = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: envDigest });
  const r10b = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'environment', expectedDigest: envDigest });
  const r10c = await call('POST', '/ssp-metadata/reviews', admin2, T, { sectionId: 'environment', expectedDigest: envDigest });
  const afterTen = await getRev();
  assert(
    r10a.status === 201 && r10b.status === 200 && r10b.body?.changed === false && r10b.body.review?.id === r10a.body.review?.id && r10c.status === 201 && afterTen.history.length === histLen + 2,
    'R10 the same reviewer and digest again -> 200 changed false; a second admin -> 201; the history grew by two',
    [r10a.status, r10b.status, r10c.status, afterTen.history.length - histLen]
  );

  const rolesBefore = stateOf(afterTen, 'roles');
  const rolesLatestBefore = rolesBefore.latest?.id;
  const rp = await call('PUT', '/ssp-metadata/profile', owner, T, { profile: { ...fullProfile, systemIdentifier: 'SYS-4', roles: [{ id: 'r1', roleKey: 'system_owner', name: 'Jane Doe', email: 'jane@test.mil' }, { id: 'r3', roleKey: 'ir_lead', name: 'Sam', email: '' }] }, expectedUpdatedAt: profileStamp });
  profileStamp = rp.body?.updatedAt as string;
  const afterRoles = await getRev();
  assert(rp.status === 200 && rolesBefore.reviewed === true && stateOf(afterRoles, 'roles').reviewed === false && stateOf(afterRoles, 'roles').latest?.id === rolesLatestBefore && stateOf(afterRoles, 'identification').reviewed === stateOf(afterTen, 'identification').reviewed, 'R11 a profile change to the roles makes roles unreviewed and leaves identification as it was', afterRoles.sections);

  const other = await call('GET', '/ssp-metadata/reviews', owner, T, undefined, P3);
  const rivalSees = await call('GET', '/ssp-metadata/reviews', rival, R);
  assert(other.status === 200 && other.body?.history.length === 0 && other.body.sections.every((s: Json) => s.latest === null) && rivalSees.status === 200 && rivalSees.body?.history.length === 0, 'R12 another program and another tenant see none of these reviews', [other.body?.history.length, rivalSees.body?.history.length]);

  const stored = await readSspMetadata({ tenantId: T, programId: DEF });
  const storedProfile = await readSspProfile({ tenantId: T, programId: DEF });
  const final = await getRev();
  assert(
    IDS.every((id) => stateOf(final, id).currentDigest === computeSectionDigest(id as any, { metadata: stored.metadata ?? {}, profile: storedProfile.profile })),
    'R13 currentDigest equals computeSectionDigest of the stored content'
  );

  const arch2 = await call('GET', '/ssp-metadata/reviews', owner, T, undefined, P4);
  const r14 = await call('POST', '/ssp-metadata/reviews', owner, T, { sectionId: 'identification', expectedDigest: stateOf(arch2.body!, 'identification').currentDigest }, P4);
  assert(r14.status === 409 && r14.body?.code === 'program_archived', 'R14 POST on an archived program -> 409 program_archived', [r14.status, r14.body]);

  console.log = origLog;
  console.error = origError;
  assert(captured.length > 0 && !captured.some((l) => l.includes(MARK) || l.includes('SYS-') || l.includes('Jane Doe')), 'R15 no console line written during the suite contains the text', captured.filter((l) => l.includes(MARK)));

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
