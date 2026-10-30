import './testEnv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { server } from '../server/index';
import { readControlAssessments } from '../server/controlAssessments';
import { getFrameworkControls } from '../src/data/frameworks';
import { nistControlsWithPrivacy } from '../src/data/programScope';

/**
 * Programs over HTTP (a program is a tenant's authorization boundary): the programs API (create, validate, clone, archive, delete,
 * metrics), x-program-id scoping of /controls, its history and /evidence, the 404 for another tenant's program (no oracle), and the
 * archive rule (reads allowed, writes 409). Runs against the in-memory store. Boots the server on port 8080: run it alone.
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

const AC1 = 'AC.L1-3.1.1';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_ps_admin@test.mil';
  const owner = person('u_ps_admin'); // a platform administrator, and the TENANT_OWNER of both tenants they create
  const assessor = person('u_ps_assessor');
  const viewer = person('u_ps_viewer');

  console.log('--- Setup: two tenants, a default program each ---');
  const mk = async (name: string) =>
    (await call('POST', '/tenants', owner, undefined, { name, primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const T = await mk('Scoping T');
  const T2 = await mk('Scoping T2');
  assert(Boolean(T) && Boolean(T2) && T !== T2, 'two tenants created (CMMC Level 2 primary; Level 1, Level 2 and NIST SP 800-53 enabled)', { T, T2 });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ps_assessor', email: 'u_ps_assessor@test.mil', role: 'ASSESSOR' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ps_viewer', email: 'u_ps_viewer@test.mil', role: 'VIEWER' });
  const progs = (tenant: string, query = '') => call('GET', `/tenants/${tenant}/programs${query}`, owner, tenant);
  const newProgram = (tenant: string, body: Json, who = owner) => call('POST', `/tenants/${tenant}/programs`, who, tenant, body);

  console.log('\n--- 1-9: creating programs ---');
  const list1 = await progs(T);
  const programs1 = (list1.body?.programs ?? []) as Json[];
  const DEFAULT = programs1[0]?.id as string;
  assert(list1.status === 200 && programs1.length === 1 && programs1[0].isDefault === true && programs1[0].frameworkId === 'CMMC_L2' && programs1[0].baseline === null && ID_PATTERN.test(DEFAULT), '1 GET /programs: the one default program, on the tenant\'s primary framework CMMC_L2', list1.body);
  const a = await newProgram(T, { name: 'Boundary A', frameworkId: 'CMMC_L2' });
  const A = a.body?.program?.id as string;
  const b = await newProgram(T, { name: 'Boundary B', frameworkId: 'CMMC_L2' });
  const B = b.body?.program?.id as string;
  const c = await newProgram(T, { name: 'Boundary C', frameworkId: 'CMMC_L2' });
  const C = c.body?.program?.id as string;
  assert(a.status === 201 && b.status === 201 && c.status === 201 && [A, B, C].every((id) => ID_PATTERN.test(id)) && new Set([DEFAULT, A, B, C]).size === 4, '2 POST A, B and C: 201 with distinct ids that fit the id pattern', [a.body, b.body, c.body]);
  const dup = await newProgram(T, { name: 'boundary a', frameworkId: 'CMMC_L2' });
  assert(dup.status === 409 && dup.body?.code === 'program_name_taken', '3 a name that differs only by case -> 409 program_name_taken', dup.body);
  const nist = await newProgram(T, { name: 'NIST Boundary', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE' });
  assert(nist.status === 201 && nist.body?.program?.frameworkId === 'NIST_800_53_REV5' && nist.body.program.baseline === 'MODERATE', '4 a NIST SP 800-53 program with the MODERATE baseline -> 201', nist.body);
  const privacy = await newProgram(T, { name: 'NIST Privacy', frameworkId: 'NIST_800_53_REV5', baseline: 'PRIVACY' });
  assert(privacy.status === 400 && privacy.body?.code === 'invalid_baseline', '5 NIST with the PRIVACY baseline -> 400 invalid_baseline', privacy.body);
  const l2Low = await newProgram(T, { name: 'L2 Low', frameworkId: 'CMMC_L2', baseline: 'LOW' });
  assert(l2Low.status === 400 && l2Low.body?.code === 'invalid_baseline', '6 a baseline on a CMMC program -> 400', l2Low.body);
  const soc = await newProgram(T, { name: 'SOC Boundary', frameworkId: 'SOC_2_TYPE_II' });
  assert(soc.status === 403 && soc.body?.code === 'framework_not_enabled', '7 a framework the tenant has not enabled -> 403 framework_not_enabled', soc.body);
  const asAssessor = await newProgram(T, { name: 'By Assessor', frameworkId: 'CMMC_L2' }, assessor);
  const asViewer = await newProgram(T, { name: 'By Viewer', frameworkId: 'CMMC_L2' }, viewer);
  assert(asAssessor.status === 403 && asViewer.status === 403, '8 an ASSESSOR and a VIEWER cannot create programs (403)', [asAssessor.status, asViewer.status]);
  assert((await call('GET', `/tenants/${T}/programs`, viewer, T)).status === 200, '8 ... but a VIEWER can list them');
  const noName = await newProgram(T, { name: '', frameworkId: 'CMMC_L2' });
  assert(noName.status === 400 && noName.body?.code === 'invalid_name', '9 an empty name -> 400 invalid_name', noName.body);

  console.log('\n--- 10-15: controls and history are per program ---');
  const ctl = (tenant: string, program?: string, who = owner) => call('GET', '/controls?framework=CMMC_L2', who, tenant, undefined, program);
  const ctrl = async (tenant: string, program?: string) => ((await ctl(tenant, program)).body?.controls ?? []).find((x: Json) => x.id === AC1) as Json;
  const putA = await call('PUT', `/controls/${AC1}`, owner, T, { implementationNotes: 'A text', status: 'MET' }, A);
  assert(putA.status === 200, '10 PUT a control with x-program-id A -> 200', putA.body);
  const inB = await ctrl(T, B);
  assert(inB?.implementationNotes === '' && inB?.status === 'NOT_STARTED', '11 the same control in program B: no notes, NOT_STARTED', inB);
  const inA = await ctrl(T, A);
  assert(inA?.implementationNotes === 'A text' && inA?.status === 'MET', '12 in program A: the notes and MET', inA);
  const inDefault = await ctrl(T);
  assert(inDefault?.implementationNotes === '' && inDefault?.status === 'NOT_STARTED', '13 with no header (the default program): no notes', inDefault);
  const putB = await call('PUT', `/controls/${AC1}`, owner, T, { implementationNotes: 'B text' }, B);
  const inA2 = await ctrl(T, A);
  const inB2 = await ctrl(T, B);
  assert(putB.status === 200 && inB2?.implementationNotes === 'B text' && inA2?.implementationNotes === 'A text' && inA2?.status === 'MET', '14 a write in B leaves A\'s answer untouched', [inA2, inB2]);
  const histA = await call('GET', `/controls/${AC1}/history`, owner, T, undefined, A);
  const histB = await call('GET', `/controls/${AC1}/history`, owner, T, undefined, B);
  assert(histA.body?.events?.length === 1 && histB.body?.events?.length === 1 && histA.body.events[0].id !== histB.body.events[0].id, '15 the history is per program: one event in A, one in B', [histA.body?.events?.length, histB.body?.events?.length]);

  console.log('\n--- 16-17: the x-program-id header ---');
  const t2Program = (await newProgram(T2, { name: 'T2 Boundary', frameworkId: 'CMMC_L2' })).body?.program?.id as string;
  const foreign = await call('GET', '/controls?framework=CMMC_L2', owner, T, undefined, t2Program);
  const foreignPut = await call('PUT', `/controls/${AC1}`, owner, T, { implementationNotes: 'Intruder' }, t2Program);
  const t2After = await ctrl(T2, t2Program);
  assert(foreign.status === 404 && foreign.body?.code === 'program_not_found' && foreignPut.status === 404 && foreignPut.body?.code === 'program_not_found', '16 another tenant\'s program under x-tenant-id T -> 404 program_not_found (read and write)', [foreign.body, foreignPut.body]);
  assert(t2After?.implementationNotes === '' && t2After?.status === 'NOT_STARTED', '16 and that tenant\'s data is unchanged', t2After);
  const badHeader = await call('GET', '/controls?framework=CMMC_L2', owner, T, undefined, 'bad id!');
  assert(badHeader.status === 400 && /x-program-id/.test(String(badHeader.body?.error)), '17 a malformed x-program-id -> 400', badHeader.body);

  console.log('\n--- 18: evidence is per program ---');
  const up = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'scope.txt', fileSize: 1, mimeType: 'text/plain', fileHash: 'b'.repeat(64) }, A);
  const E = up.body?.evidenceId as string;
  assert(up.status === 201 && Boolean(E), '18 upload-url in A -> 201', up.body);
  const evIn = async (program: string) => ((await call('GET', '/evidence', owner, T, undefined, program)).body?.evidence ?? []) as Json[];
  const evB = await evIn(B);
  assert(!evB.some((e) => e.id === E) && !evB.some((e) => String(e.id).startsWith(`${E}__inh_`)) && evB.length === 0, '18 B\'s evidence list has neither E nor its inherited copies', evB.map((e) => e.id));
  const getB = await call('GET', `/evidence/${E}`, owner, T, undefined, B);
  const verifyB = await call('GET', `/evidence/${E}/verify-integrity`, owner, T, undefined, B);
  const fileB = await call('GET', `/evidence/${E}/file`, owner, T, undefined, B);
  const putLocalB = await call('PUT', `/evidence/upload-local/${E}`, owner, T, { bytes: 'x' }, B);
  assert(getB.status === 404 && verifyB.status === 404 && fileB.status === 404 && putLocalB.status === 404, '18 in B: GET /:id, verify-integrity, /file and upload-local are all 404', [getB.status, verifyB.status, fileB.status, putLocalB.status]);
  const evA = await evIn(A);
  assert(evA.some((e) => e.id === E) && evA.some((e) => String(e.id).startsWith(`${E}__inh_`)), '18 in A: E and the inherited copies', evA.map((e) => e.id));
  assert((await call('GET', `/evidence/${E}`, owner, T, undefined, A)).status === 200 && (await evIn(DEFAULT)).length === 0, '18 E is readable in A and absent from the default program');

  console.log('\n--- 19-23: archive and delete ---');
  const arch = await call('POST', `/tenants/${T}/programs/${A}/archive`, owner, T);
  assert(arch.status === 200 && typeof arch.body?.program?.archivedAt === 'string', '19 archive A -> 200 with archivedAt', arch.body);
  const writeArchived = await call('PUT', `/controls/${AC1}`, owner, T, { implementationNotes: 'More' }, A);
  const uploadArchived = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'x.txt', fileHash: 'c'.repeat(64) }, A);
  const readArchived = await ctl(T, A);
  assert(writeArchived.status === 409 && writeArchived.body?.code === 'program_archived' && uploadArchived.status === 409 && readArchived.status === 200, '19 an archived program: PUT and upload -> 409 program_archived, GET -> 200', [writeArchived.body, uploadArchived.status, readArchived.status]);
  const archDefault = await call('POST', `/tenants/${T}/programs/${DEFAULT}/archive`, owner, T);
  assert(archDefault.status === 409 && archDefault.body?.code === 'program_is_default', '20 archive the default program -> 409 program_is_default', archDefault.body);
  const delDefault = await call('DELETE', `/tenants/${T}/programs/${DEFAULT}`, owner, T);
  assert(delDefault.status === 409 && delDefault.body?.code === 'program_is_default', '21 delete the default program -> 409 program_is_default', delDefault.body);
  const delA = await call('DELETE', `/tenants/${T}/programs/${A}`, owner, T);
  assert(delA.status === 409 && delA.body?.code === 'program_not_empty' && delA.body?.evidence === 1, '22 delete A (it holds evidence) -> 409 program_not_empty with the counts', delA.body);
  const delC = await call('DELETE', `/tenants/${T}/programs/${C}`, owner, T);
  const useC = await call('GET', '/controls?framework=CMMC_L2', owner, T, undefined, C);
  assert(delC.status === 204 && useC.status === 404 && useC.body?.code === 'program_not_found', '23 delete the empty program C -> 204; x-program-id C is then 404', [delC.status, useC.status]);

  console.log('\n--- 24-27: metrics, clone, listing ---');
  const metrics = await call('GET', `/tenants/${T}/programs/${A}/metrics`, owner, T);
  assert(metrics.status === 200 && metrics.body?.documented === 1 && metrics.body.total === getFrameworkControls('CMMC_L2').length && metrics.body.evidence === 1 && metrics.body.openPoam === 0, '24 metrics of A: 1 documented, the Level 2 total, 1 evidence file (the inherited copies do not count), 0 POA&M', metrics.body);
  assert((await call('GET', `/tenants/${T}/programs/${C}/metrics`, owner, T)).status === 404 && (await call('GET', `/tenants/${T}/programs/${t2Program}/metrics`, owner, T)).status === 404, '24 metrics of a deleted or another tenant\'s program -> 404');
  const clone = await newProgram(T, { name: 'Clone', frameworkId: 'CMMC_L2', seed: { cloneFrom: A } });
  const CLONE = clone.body?.program?.id as string;
  const cloned = await ctrl(T, CLONE);
  const cloneEvents = ((await call('GET', `/controls/${AC1}/history`, owner, T, undefined, CLONE)).body?.events ?? []) as Json[];
  assert(clone.status === 201 && cloned?.implementationNotes === 'A text' && cloned?.status === 'NOT_STARTED', '25 a clone of A carries A\'s notes with the status reset to NOT_STARTED', [clone.body, cloned]);
  assert(cloneEvents.length === 1 && cloneEvents[0].source === 'clone' && cloneEvents[0].actorUserId === 'u_ps_admin', '25 each copied row records a clone event under the requesting user', cloneEvents);
  const cloneImports = await call('GET', `/tenants/${T}/ssp-imports`, owner, T, undefined, CLONE);
  assert((await evIn(CLONE)).length === 0 && cloneImports.status === 200 && (cloneImports.body?.jobs ?? []).length === 0, '25 the clone has no evidence and no SSP imports', cloneImports.body);
  assert((await ctrl(T, A))?.implementationNotes === 'A text', '25 and cloning left A untouched');
  const cloneForeign = await newProgram(T, { name: 'Clone Foreign', frameworkId: 'CMMC_L2', seed: { cloneFrom: t2Program } });
  const cloneUnknown = await newProgram(T, { name: 'Clone Unknown', frameworkId: 'CMMC_L2', seed: { cloneFrom: 'no-such-program' } });
  assert(cloneForeign.status === 404 && cloneForeign.body?.code === 'program_not_found' && cloneUnknown.status === 404, '26 cloneFrom another tenant\'s program (or an unknown one) -> 404 program_not_found', [cloneForeign.body, cloneUnknown.status]);
  assert(!(((await progs(T)).body?.programs ?? []) as Json[]).some((p) => p.name === 'Clone Foreign'), '26 and no program was created');
  const listed = ((await progs(T)).body?.programs ?? []) as Json[];
  const listedAll = ((await progs(T, '?includeArchived=true')).body?.programs ?? []) as Json[];
  assert(!listed.some((p) => p.id === A) && listedAll.some((p) => p.id === A && p.archivedAt) && listed[0].id === DEFAULT, '27 the list leaves archived A out; ?includeArchived=true has it; the default is first', [listed.map((p) => p.id), listedAll.length]);
  assert(listed.every((p) => p.metrics && typeof p.metrics.documented === 'number' && typeof p.metrics.total === 'number'), '27 every listed program carries its metrics');

  console.log('\n--- 28-29: immutability, seeding ---');
  const immut = await call('PUT', `/tenants/${T}/programs/${B}`, owner, T, { frameworkId: 'NIST_800_53_REV5' });
  const immutBaseline = await call('PUT', `/tenants/${T}/programs/${B}`, owner, T, { baseline: 'HIGH' });
  assert(immut.status === 400 && immut.body?.code === 'framework_immutable' && immutBaseline.status === 400, '28 PUT a different framework (or baseline) -> 400 framework_immutable / invalid_baseline', [immut.body, immutBaseline.body]);
  const renamed = await call('PUT', `/tenants/${T}/programs/${B}`, owner, T, { name: 'Boundary B2', description: 'd', systemBoundarySummary: 's', frameworkId: 'CMMC_L2' });
  assert(renamed.status === 200 && renamed.body?.program?.name === 'Boundary B2' && renamed.body.program.systemBoundarySummary === 's', '28 but the name, description and summary can change (the same framework is accepted)', renamed.body);
  const defaultBefore = (await call('GET', `/tenants/${T}/programs/${DEFAULT}/metrics`, owner, T)).body;
  const l1 = await newProgram(T, { name: 'Level 1 Boundary', frameworkId: 'CMMC_L1' });
  const L1 = l1.body?.program?.id as string;
  const l1Controls = await call('GET', '/controls', owner, T, undefined, L1);
  const seeded = await readControlAssessments({ tenantId: T, programId: L1 });
  const defaultAfter = (await call('GET', `/tenants/${T}/programs/${DEFAULT}/metrics`, owner, T)).body;
  assert(l1Controls.status === 200 && l1Controls.body?.framework === 'CMMC_L1' && l1Controls.body?.controls?.length === 17 && seeded.size === 17, '29 a fresh CMMC_L1 program asked for no framework serves its own 17 controls and seeds them there', [l1Controls.body?.framework, l1Controls.body?.controls?.length, seeded.size]);
  assert(JSON.stringify(defaultBefore) === JSON.stringify(defaultAfter) && (await readControlAssessments({ tenantId: T, programId: DEFAULT })).size === 0, '29 the default program\'s rows and metrics are unchanged', [defaultBefore, defaultAfter]);

  console.log('\n--- 30: the privacy baseline widens the control universe of its program only ---');
  const plusP = await newProgram(T, { name: 'NIST Moderate plus privacy', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: true });
  const PLUS = plusP.body?.program?.id as string;
  const plainIds = new Set(nistControlsWithPrivacy('MODERATE', false).map((c) => c.id));
  const privOnly = nistControlsWithPrivacy('MODERATE', true).find((c) => !plainIds.has(c.id))?.id ?? '';
  const withP = await call('GET', '/controls?framework=NIST_800_53_REV5&baseline=MOD_MOD_MOD', owner, T, undefined, PLUS);
  assert(plusP.status === 201 && withP.status === 200 && withP.body?.controls?.length === 340 && withP.body.totalCount === 340 && withP.body.privacyBaseline === true, '30 a MODERATE + privacy program lists 340 controls and says privacyBaseline true', [plusP.body, withP.body?.controls?.length, withP.body?.privacyBaseline]);
  assert(privOnly !== '' && withP.body?.controls?.some((c: Json) => c.id === privOnly), '30 and the list includes a privacy-only control', privOnly);
  const plainNist = await call('GET', '/controls?framework=NIST_800_53_REV5&baseline=MOD_MOD_MOD', owner, T, undefined, nist.body?.program?.id as string);
  assert(plainNist.status === 200 && plainNist.body?.controls?.length === 287 && plainNist.body.privacyBaseline === undefined && !plainNist.body.controls.some((c: Json) => c.id === privOnly), '30 a plain MODERATE program lists 287 controls, without the privacy-only control and without the flag', [plainNist.body?.controls?.length, plainNist.body?.privacyBaseline]);

  console.log('\n--- C1-C12: the program decides the baseline and overlays of GET /controls ---');
  const NIST = 'NIST_800_53_REV5';
  const nsRes = await newProgram(T, { name: 'NIST Scoped', frameworkId: NIST, baseline: 'MODERATE', scoping: { noWireless: true } });
  const NS = nsRes.body?.program?.id as string;
  assert(nsRes.status === 201 && JSON.stringify(nsRes.body?.program?.scoping) === JSON.stringify({ noWireless: true }), 'C1 a MODERATE NIST program created with { noWireless: true } -> 201 and the scoping is stored', nsRes.body);
  const noWirelessLen = getFrameworkControls(NIST, 'MOD_MOD_MOD', { nonNetworkedOnly: false, noWireless: true }).length;
  const c2 = await call('GET', '/controls', owner, T, undefined, NS);
  assert(c2.status === 200 && c2.body?.controls?.length === noWirelessLen && !c2.body.controls.some((x: Json) => x.id === 'AC-18') && c2.body.scopedByProgram === true && c2.body.overlays?.noWireless === true, 'C2 no query: the program\'s baseline and overlay (no AC-18, scopedByProgram true)', [c2.status, c2.body?.controls?.length, noWirelessLen]);
  const c3 = await call('GET', `/controls?framework=${NIST}&baseline=LOW_LOW_LOW&overlay=NONE`, owner, T, undefined, NS);
  assert(c3.status === 200 && c3.body?.controls?.length === noWirelessLen && c3.body.baseline === 'MOD_MOD_MOD', 'C3 a query asking for LOW and no overlay is ignored for the program\'s own framework', [c3.body?.controls?.length, c3.body?.baseline]);
  const c4 = await call('GET', `/controls?framework=${NIST}&overlay=NON_NETWORKED`, owner, T, undefined, NS);
  assert(c4.status === 200 && c4.body?.controls?.length === noWirelessLen && c4.body.controls.some((x: Json) => x.id === 'SC-7') && c4.body.overlay === 'NONE', 'C4 ?overlay=NON_NETWORKED is ignored too (SC-7 stays)', [c4.body?.controls?.length, c4.body?.overlay]);
  const c5Put = await call('PUT', `/tenants/${T}/programs/${NS}`, owner, T, { scoping: { nonNetworkedOnly: true } });
  const nonNetIds = getFrameworkControls(NIST, 'MOD_MOD_MOD', { nonNetworkedOnly: true }).map((c) => c.id);
  const nonNetLen = nonNetIds.length;
  const c5 = await call('GET', '/controls', owner, T, undefined, NS);
  // The air-gapped overlay removes SC-7 and also AC-18 (no wireless on a stand-alone system), so the set must equal the catalog's
  const c5Ids = (c5.body?.controls ?? []).map((x: Json) => x.id);
  assert(c5Put.status === 200 && c5.status === 200 && c5Ids.length === nonNetLen && nonNetIds.every((id) => c5Ids.includes(id)) && !c5Ids.includes('SC-7') && c5.body.overlay === 'NON_NETWORKED', 'C5 the owner switches the program to nonNetworkedOnly: the catalog\'s air-gapped set (no SC-7), overlay NON_NETWORKED', [c5Put.status, c5Ids.length, nonNetLen]);
  const c6Assessor = await call('PUT', `/tenants/${T}/programs/${NS}`, assessor, T, { scoping: { nonNetworkedOnly: true } });
  const c6Bogus = await call('PUT', `/tenants/${T}/programs/${NS}`, owner, T, { scoping: { bogus: true } });
  assert(c6Assessor.status === 403 && c6Bogus.status === 400 && c6Bogus.body?.code === 'invalid_scoping', 'C6 an ASSESSOR cannot change the scoping (403); an unknown key -> 400 invalid_scoping', [c6Assessor.status, c6Bogus.status, c6Bogus.body]);
  const c7 = await call('GET', `/tenants/${T}/programs/${NS}/events`, viewer, T);
  assert(c7.status === 200 && c7.body?.events?.[0]?.kind === 'scoping_changed' && !JSON.stringify(c7.body).includes('NIST Scoped'), 'C7 a VIEWER reads the events: the newest is scoping_changed, and no program name in them', c7.body);
  const c8 = await newProgram(T, { name: 'NIST Privacy Scoped', frameworkId: NIST, baseline: 'MODERATE', privacyBaseline: true, scoping: { noPiiProcessing: true } });
  assert(c8.status === 400 && c8.body?.code === 'invalid_scoping', 'C8 noPiiProcessing on a program with the privacy baseline -> 400 invalid_scoping', c8.body);
  const c9Create = await newProgram(T, { name: 'L2 scoped', frameworkId: 'CMMC_L2', scoping: { noWireless: true } });
  const c9 = await call('GET', '/controls?framework=CMMC_L2&overlay=NON_NETWORKED', owner, T);
  assert(c9Create.status === 400 && c9Create.body?.code === 'invalid_scoping' && c9.status === 200 && c9.body?.controls?.length === getFrameworkControls('CMMC_L2').length, 'C9 a CMMC program cannot be scoped (400); a CMMC program ignores ?overlay=NON_NETWORKED', [c9Create.body, c9.body?.controls?.length]);
  const c10 = await call('GET', `/controls?framework=${NIST}&baseline=HIGH_HIGH_HIGH`, owner, T);
  assert(c10.status === 200 && c10.body?.scopedByProgram === false && c10.body.controls?.length === getFrameworkControls(NIST, 'HIGH_HIGH_HIGH').length, 'C10 the crosswalk view of another framework keeps the query baseline (scopedByProgram false)', [c10.body?.controls?.length, c10.body?.scopedByProgram]);
  const c11Arch = await call('POST', `/tenants/${T}/programs/${NS}/archive`, owner, T);
  const c11 = await call('PUT', `/tenants/${T}/programs/${NS}`, owner, T, { scoping: { noWireless: true } });
  assert(c11Arch.status === 200 && c11.status === 409 && c11.body?.code === 'program_archived', 'C11 an archived program\'s scoping cannot be changed (409 program_archived)', [c11Arch.status, c11.status, c11.body]);
  const routeSource = readFileSync(join(process.cwd(), 'server', 'routes', 'controls.ts'), 'utf8').replace(/\r\n/g, '\n');
  const getHandler = routeSource.slice(routeSource.indexOf("router.get('/', async"), routeSource.indexOf("router.put('/:controlId'"));
  assert(getHandler.includes('errorMessage(err)') && !/console\.(error|warn)\([^;]*,\s*err\)/.test(routeSource), 'C12 no controls route logs the whole error object (it can carry a row\'s notes)');

  console.log('\n--- C13-C15: a stale overlay save is refused (issue #115) ---');
  const cfRes = await newProgram(T, { name: 'NIST Conflict', frameworkId: NIST, baseline: 'MODERATE', scoping: { noWireless: true } });
  const CF = cfRes.body?.program?.id as string;
  const cfCount = async () => (((await call('GET', `/tenants/${T}/programs/${CF}/events`, viewer, T)).body?.events ?? []) as Json[]).length;
  const cfBefore = await cfCount();
  const c13 = await call('PUT', `/tenants/${T}/programs/${CF}`, owner, T, { scoping: { noMobileDevices: true }, expectedScoping: { noPiiProcessing: true } });
  assert(cfRes.status === 201 && c13.status === 409 && c13.body?.code === 'scoping_conflict' && (await cfCount()) === cfBefore, 'C13 a stale expectedScoping -> 409 scoping_conflict, and no event is recorded', [c13.status, c13.body?.code, cfBefore]);
  const c14 = await call('PUT', `/tenants/${T}/programs/${CF}`, owner, T, { scoping: { noMobileDevices: true }, expectedScoping: { noWireless: true } });
  assert(c14.status === 200 && JSON.stringify(c14.body?.program?.scoping) === JSON.stringify({ noMobileDevices: true }), 'C14 a matching expectedScoping -> 200 and the change is saved', [c14.status, c14.body]);
  const c15 = await call('PUT', `/tenants/${T}/programs/${CF}`, owner, T, { scoping: {}, expectedScoping: 'x' });
  assert(c15.status === 400 && c15.body?.code === 'invalid_scoping', 'C15 an expectedScoping that is not an object -> 400 invalid_scoping', [c15.status, c15.body]);

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
