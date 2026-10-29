import './testEnv';
process.env.VITE_API_URL = 'http://127.0.0.1:8080';
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
(globalThis as any).window = { localStorage: (globalThis as any).localStorage };

import { server } from '../server/index';
import { isPlatformAdmin, platformAdminEmails } from '../server/auth/platformAdmin';
import { frameworksDefiningControl } from '../server/middleware/frameworkGuard';
import { DEFAULT_PRIMARY_FRAMEWORK, frameworkLabel, frameworkPolicySummary } from '../src/data/tenantFrameworkPolicy';
import { getTenantFrameworkPolicy } from '../server/db';
import fs from 'fs';
import path from 'path';

/**
 * Assessment programs (they replace the commercial license tier): the platform-administrator role, who may set a tenant's
 * program, the server's enforcement that a tenant is only served the frameworks of its program, and that no license tier
 * or price exists anywhere in what the API returns.
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
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

function unitTests() {
  console.log('--- Platform administrator list ---');
  assert(platformAdminEmails({}).size === 0 && !isPlatformAdmin({ email: 'a@x.mil' }, {}), 'with PLATFORM_ADMIN_EMAILS unset there are no platform administrators (fails closed)');
  const env = { PLATFORM_ADMIN_EMAILS: ' Admin@Corp.mil, ops@corp.mil ,, ' } as NodeJS.ProcessEnv;
  assert(isPlatformAdmin({ email: 'admin@corp.mil' }, env) && isPlatformAdmin({ email: 'OPS@CORP.MIL' }, env), 'matching is case-insensitive and tolerates spaces and empty entries');
  assert(!isPlatformAdmin({ email: 'someone@corp.mil' }, env) && !isPlatformAdmin({ email: undefined }, env) && !isPlatformAdmin(null, env), 'anyone else, and a user without an e-mail, is not');
  assert(!isPlatformAdmin({ email: 'admin@corp.mil.evil.com' }, env) && !isPlatformAdmin({ email: 'xadmin@corp.mil' }, env), 'only an exact address matches (no suffix or substring tricks)');

  console.log('\n--- Program labels ---');
  assert(frameworkLabel('CMMC_L2') === 'CMMC Level 2' && frameworkLabel('NIST_800_53_REV5') === 'NIST SP 800-53 Rev. 5' && frameworkLabel('X') === 'X', 'frameworks have readable labels (unknown ids pass through)');
  const prog = frameworkPolicySummary('CMMC_L2', ['CMMC_L2', 'NIST_800_53_REV5']);
  assert(prog.primary === 'CMMC Level 2' && prog.additional.length === 1 && prog.text === 'CMMC Level 2 + NIST SP 800-53 Rev. 5', 'a program reads "primary + additional"', prog);
  assert(frameworkPolicySummary(undefined, undefined).text === frameworkLabel(DEFAULT_PRIMARY_FRAMEWORK) && frameworkPolicySummary('CMMC_L1', ['CMMC_L1', 'CMMC_L1']).additional.length === 0, 'the default program is CMMC Level 1; duplicates collapse');
  assert(DEFAULT_PRIMARY_FRAMEWORK === 'CMMC_L1' && frameworkPolicySummary(undefined, undefined).text === 'CMMC Level 1', 'R1: the default primary framework is CMMC_L1 and reads "CMMC Level 1"');

  console.log('\n--- Which frameworks define a control ---');
  assert(frameworksDefiningControl('AC.L1-3.1.1').has('CMMC_L1') && frameworksDefiningControl('AC.L1-3.1.1').has('CMMC_L2'), 'a Level 1 practice is also part of Level 2');
  assert(frameworksDefiningControl('AC.L2-3.1.3').has('CMMC_L2') && !frameworksDefiningControl('AC.L2-3.1.3').has('CMMC_L1'), 'a Level 2 requirement is not part of Level 1');
  assert(frameworksDefiningControl('ac-2').has('NIST_800_53_REV5') && frameworksDefiningControl('CC1.1').has('SOC_2_TYPE_II'), 'NIST, SOC 2 (and HIPAA) controls are indexed, case-insensitively');
  assert(frameworksDefiningControl('NOT.A.CONTROL').size === 0, 'an unknown id belongs to no framework');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  // Platform administrators of this test installation
  process.env.PLATFORM_ADMIN_EMAILS = 'u_pg_admin@test.mil, Second.Admin@Test.MIL';
  const admin = person('u_pg_admin');
  const second = person('u_pg_second', 'second.admin@test.mil');
  const owner = person('u_pg_owner');

  console.log('\n--- GET /me ---');
  const meAdmin = await call('GET', '/me', admin);
  assert(meAdmin.status === 200 && meAdmin.body?.isPlatformAdmin === true && meAdmin.body?.user.email === 'u_pg_admin@test.mil', 'a listed administrator is reported as one', meAdmin.body);
  assert((await call('GET', '/me', second)).body?.isPlatformAdmin === true, 'matching ignores case');
  assert((await call('GET', '/me', owner)).body?.isPlatformAdmin === false, 'anyone else is not');
  assert((await call('GET', '/me', null)).status === 401, 'unauthenticated -> 401');

  console.log('\n--- GET /platform/admins ---');
  const roster = await call('GET', '/platform/admins', admin);
  assert(roster.status === 200 && roster.body?.admins.map((a: Json) => a.email).join() === 'second.admin@test.mil,u_pg_admin@test.mil', 'an administrator sees the configured administrators (sorted, lower-cased)', roster.body);
  assert((await call('GET', '/platform/admins', owner)).status === 403, 'anyone else is refused: who the administrators are is not public');
  assert((await call('GET', '/platform/admins', null)).status === 401, 'unauthenticated -> 401');

  console.log('\n--- Creating tenants ---');
  const selfService = await call('POST', '/tenants', owner, undefined, { name: 'Self Service Org', primaryFramework: 'NIST_800_53_REV5', enabledFrameworks: ['NIST_800_53_REV5', 'CMMC_L2'], licenseTier: 'ENTERPRISE' });
  const ssTenant = selfService.body?.tenant as Json;
  assert(selfService.status === 201 && ssTenant.primaryFramework === 'CMMC_L1' && ssTenant.enabledFrameworks.join() === 'CMMC_L1', 'a non-administrator gets the default program whatever they ask for', ssTenant);
  const l2 = await call('POST', '/tenants', admin, undefined, { name: 'Dedicated CMMC L2', primaryFramework: 'CMMC_L2' });
  const l2Tenant = l2.body?.tenant as Json;
  assert(l2.status === 201 && l2Tenant.primaryFramework === 'CMMC_L2' && l2Tenant.enabledFrameworks.join() === 'CMMC_L2', 'an administrator provisions a dedicated CMMC Level 2 enclave (and only that)', l2Tenant);
  const nist = await call('POST', '/tenants', admin, undefined, { name: 'Separate NIST Tenant', primaryFramework: 'NIST_800_53_REV5', enabledFrameworks: ['CMMC_L2'] });
  assert(nist.status === 201 && nist.body?.tenant.primaryFramework === 'NIST_800_53_REV5' && nist.body?.tenant.enabledFrameworks.join() === 'NIST_800_53_REV5,CMMC_L2', 'a program can combine frameworks; the primary is always enabled and first', nist.body?.tenant);
  assert(!('licenseTier' in ssTenant) && !('licenseTier' in l2Tenant) && !JSON.stringify([selfService.body, l2.body]).match(/licen|annual|price|FOUNDATIONAL|DEFENSE_PRO|ENTERPRISE/i), 'no license tier or price in any created tenant');
  assert((await call('POST', '/tenants', admin, undefined, { name: 'Bad', primaryFramework: 'ISO_27001' })).status === 400, 'an administrator still cannot pick an unsupported framework');

  const l2Id = l2Tenant.id as string;
  const l1Id = ssTenant.id as string;
  const nistId = nist.body?.tenant.id as string;
  const mine = async (t: string) => ((await call('GET', '/tenants', t)).body?.tenants ?? []) as Json[];
  assert(!JSON.stringify(await mine(admin)).match(/licen|annual|price/i), 'the tenant list carries no license tier either');

  console.log('\n--- The default program of a new tenant ---');
  const l2Programs = await call('GET', `/tenants/${l2Id}/programs`, admin, l2Id);
  const l2List = (l2Programs.body?.programs ?? []) as Json[];
  assert(l2Programs.status === 200 && l2List.length === 1 && l2List[0].isDefault === true && l2List[0].frameworkId === 'CMMC_L2' && l2List[0].baseline === null, 'a tenant created with CMMC Level 2 as its primary framework has one default program on CMMC_L2', l2Programs.body);
  const nistList = ((await call('GET', `/tenants/${nistId}/programs`, admin, nistId)).body?.programs ?? []) as Json[];
  assert(nistList.length === 1 && nistList[0].frameworkId === 'NIST_800_53_REV5' && nistList[0].baseline === 'MODERATE', 'and a NIST-primary tenant has a MODERATE default program', nistList);

  console.log('\n--- The privacy baseline of a program (issue #20) ---');
  const privPost = await call('POST', `/tenants/${nistId}/programs`, admin, nistId, { name: 'Moderate plus privacy', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: true });
  assert(privPost.status === 201 && privPost.body?.program.privacyBaseline === true && privPost.body.program.baseline === 'MODERATE', 'POST a NIST MODERATE program with privacyBaseline true -> 201, privacyBaseline true', privPost.body);
  const cmmcPriv = await call('POST', `/tenants/${nistId}/programs`, admin, nistId, { name: 'L2 plus privacy', frameworkId: 'CMMC_L2', privacyBaseline: true });
  assert(cmmcPriv.status === 400 && cmmcPriv.body?.code === 'invalid_baseline', 'a CMMC_L2 program with privacyBaseline true -> 400 invalid_baseline', cmmcPriv.body);
  const stringPriv = await call('POST', `/tenants/${nistId}/programs`, admin, nistId, { name: 'String privacy', frameworkId: 'NIST_800_53_REV5', privacyBaseline: 'true' });
  assert(stringPriv.status === 400 && stringPriv.body?.code === 'invalid_baseline', "privacyBaseline 'true' (a string) -> 400 invalid_baseline", stringPriv.body);
  const privOff = await call('PUT', `/tenants/${nistId}/programs/${privPost.body?.program.id}`, admin, nistId, { privacyBaseline: false });
  assert(privOff.status === 400 && privOff.body?.code === 'invalid_baseline', 'PUT privacyBaseline false on a privacy program -> 400 invalid_baseline', privOff.body);
  const privSame = await call('PUT', `/tenants/${nistId}/programs/${privPost.body?.program.id}`, admin, nistId, { privacyBaseline: true, description: 'kept' });
  assert(privSame.status === 200 && privSame.body?.program.privacyBaseline === true, 'PUT with the same value is accepted', privSame.body);
  const privList = ((await call('GET', `/tenants/${nistId}/programs`, admin, nistId)).body?.programs ?? []) as Json[];
  assert(privList.find((p) => p.id === privPost.body?.program.id)?.metrics.total === 340, 'GET /programs: metrics.total of a MODERATE + privacy program is 340', privList.map((p) => p.metrics));
  assert(privList.find((p) => p.isDefault)?.privacyBaseline === false && privList.find((p) => p.isDefault)?.metrics.total === 287, 'while the default MODERATE program has no privacy baseline (287)');

  console.log('\n--- Changing a program ---');
  const ownerTok = owner; // owner of l1Id
  const tryOwn = await call('PATCH', `/tenants/${l1Id}`, ownerTok, l1Id, { primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2'] });
  assert(tryOwn.status === 403 && /platform administrator/i.test(tryOwn.body?.error ?? ''), "a tenant owner cannot widen their own tenant's program (403, with the reason)", tryOwn.body);
  assert((await call('PATCH', `/tenants/${l1Id}`, ownerTok, l1Id, { systemName: 'Renamed By Owner' })).status === 200, 'but can still edit their tenant\'s other settings');
  assert((await mine(owner)).find((t) => t.id === l1Id)?.enabledFrameworks.join() === 'CMMC_L1', 'the program is unchanged after the refused attempt');
  // the administrator is not a member of l1Id: they must be to edit it (membership rules are unchanged); they edit the tenants they own
  const widen = await call('PATCH', `/tenants/${l2Id}`, admin, l2Id, { enabledFrameworks: ['CMMC_L2', 'NIST_800_53_REV5'] });
  assert(widen.status === 200 && widen.body?.tenant.enabledFrameworks.join() === 'CMMC_L2,NIST_800_53_REV5', 'an administrator changes the program of a tenant', widen.body?.tenant);
  assert(!JSON.stringify(widen.body).match(/licen|annual|price/i), 'and the response carries no license tier');
  await call('PATCH', `/tenants/${l2Id}`, admin, l2Id, { enabledFrameworks: ['CMMC_L2'] }); // back to L2 only for the enforcement tests below

  console.log('\n--- Framework segregation: the server only serves the frameworks of the tenant\'s program ---');
  const ctl = (t: string, tok: string, q = '') => call('GET', `/controls${q}`, tok, t);
  const l1Default = await ctl(l1Id, owner);
  assert(l1Default.status === 200 && l1Default.body?.controls.length === 17, 'a CMMC Level 1 tenant asking for no framework gets its own (17 controls)', l1Default.body?.controls?.length);
  const l1AsksL2 = await ctl(l1Id, owner, '?framework_id=CMMC_L2');
  assert(l1AsksL2.status === 403 && l1AsksL2.body?.code === 'framework_not_enabled' && /not part of this tenant's assessment program/.test(l1AsksL2.body?.error), 'a Level 1 tenant cannot read Level 2 controls (403)', l1AsksL2.body);
  for (const fw of ['NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY']) assert((await ctl(l1Id, owner, `?framework_id=${fw}`)).status === 403, `...nor ${fw}`);
  assert((await ctl(l1Id, owner, '?framework_id=CMMC_L1')).status === 200, 'but can read its own framework when asking explicitly');

  const l2Default = await ctl(l2Id, admin);
  assert(l2Default.status === 200 && l2Default.body?.controls.length === 110, 'a dedicated Level 2 tenant asking for no framework gets Level 2 (110 controls), not Level 1', l2Default.body?.controls?.length);
  assert((await ctl(l2Id, admin, '?framework_id=NIST_800_53_REV5')).status === 403, 'a Level 2 tenant cannot read NIST SP 800-53 controls');
  assert((await ctl(l2Id, admin, '?framework_id=CMMC_L1')).status === 403, 'and, being dedicated to Level 2, does not serve the separate Level 1 framework either');

  const put = (t: string, tok: string, id: string, status = 'IN_PROGRESS') => call('PUT', `/controls/${encodeURIComponent(id)}`, tok, t, { status });
  assert((await put(l1Id, owner, 'AC.L1-3.1.1')).status === 200, 'scoring a control of the tenant\'s own framework works');
  const l1ScoresL2 = await put(l1Id, owner, 'AC.L2-3.1.3');
  assert(l1ScoresL2.status === 403 && l1ScoresL2.body?.code === 'framework_not_enabled', 'scoring a Level 2 control in a Level 1 tenant is refused', l1ScoresL2.body);
  assert((await put(l1Id, owner, 'AC-2')).status === 403, '...and so is a NIST SP 800-53 control');
  assert((await put(l2Id, admin, 'AC.L2-3.1.3')).status === 200 && (await put(l2Id, admin, 'AC.L1-3.1.1')).status === 200, 'a Level 2 tenant can score Level 2 controls and the Level 1 practices that Level 2 includes');
  assert((await put(l2Id, admin, 'AC-2')).status === 403, 'but not NIST controls');
  assert((await put(l1Id, owner, 'NOT.A.CONTROL')).status !== 403, 'an id no framework defines is not a framework matter (behaviour unchanged)');
  const refusedWrite = (await call('GET', '/controls', owner, l1Id)).body?.controls.find((c: Json) => c.id === 'AC.L2-3.1.3');
  assert(refusedWrite === undefined, 'and the refused write left nothing behind');

  const upload = (t: string, tok: string, controlId: string) => call('POST', '/evidence/upload-url', tok, t, { controlId, fileName: 'p.txt', fileSize: 1, mimeType: 'text/plain', fileHash: 'a'.repeat(64) });
  const evBad = await upload(l1Id, owner, 'AC-2');
  assert(evBad.status === 403 && evBad.body?.code === 'framework_not_enabled', 'evidence cannot be attached to a control outside the program', evBad.body);
  assert((await upload(l1Id, owner, 'AC.L1-3.1.1')).status !== 403, 'evidence for the program\'s own controls is not blocked by segregation');

  console.log('\n--- A program change takes effect immediately ---');
  assert((await ctl(nistId, admin)).body?.controls.length > 17 && (await ctl(nistId, admin)).status === 200, 'a NIST-primary tenant gets NIST controls by default');
  assert((await ctl(nistId, admin, '?framework_id=CMMC_L2')).status === 200, 'and Level 2, which its program also enables');
  assert((await ctl(nistId, admin, '?framework_id=CMMC_L1')).status === 403, 'but not Level 1, which it does not');
  await call('PATCH', `/tenants/${l2Id}`, admin, l2Id, { enabledFrameworks: ['CMMC_L2', 'SOC_2_TYPE_II'] });
  assert((await ctl(l2Id, admin, '?framework_id=SOC_2_TYPE_II')).status === 200, 'after an administrator adds SOC 2, the tenant is served SOC 2');
  await call('PATCH', `/tenants/${l2Id}`, admin, l2Id, { enabledFrameworks: ['CMMC_L2'] });
  assert((await ctl(l2Id, admin, '?framework_id=SOC_2_TYPE_II')).status === 403, 'and after it is removed, no longer');
  const policyNow = await getTenantFrameworkPolicy(l2Id);
  assert(policyNow?.primaryFramework === 'CMMC_L2' && JSON.stringify(policyNow.enabledFrameworks) === JSON.stringify(['CMMC_L2']), 'R3: getTenantFrameworkPolicy returns the tenant\'s primary and enabled frameworks', policyNow);
  assert((await getTenantFrameworkPolicy('no_such_tenant_r2')) === null, 'R2: a tenant with no record has no framework policy (null)');

  console.log('\n--- Tenants are independent ---');
  assert((await ctl(l1Id, owner, '?framework_id=CMMC_L2')).status === 403 && (await ctl(l2Id, admin, '?framework_id=CMMC_L2')).status === 200, "one tenant's program never leaks into another's");

  console.log('\n--- The invitation shows the program the server holds ---');
  const inv = await call('POST', `/tenants/${l2Id}/invites`, admin, l2Id, { email: 'new.owner@test.mil', role: 'TENANT_OWNER' });
  const preview = await call('POST', '/invites/preview', null, undefined, { token: inv.body?.token });
  assert(preview.status === 200 && preview.body?.invitation.primaryFramework === 'CMMC_L2' && preview.body?.invitation.enabledFrameworks.join() === 'CMMC_L2', "the accept page's preview carries the tenant's real program", preview.body);
  assert(!JSON.stringify(preview.body).match(/licen|annual|price|FOUNDATIONAL|DEFENSE_PRO|ENTERPRISE/i), 'with no license tier or price');
  const invL1 = await call('POST', `/tenants/${l1Id}/invites`, owner, l1Id, { email: 'viewer@test.mil', role: 'VIEWER' });
  assert((await call('POST', '/invites/preview', null, undefined, { token: invL1.body?.token })).body?.invitation.primaryFramework === 'CMMC_L1', 'and for a default tenant, CMMC Level 1');

  console.log('\n--- Client ---');
  const { ApiClient } = await import('../src/services/apiClient');
  assert((await ApiClient.getPlatformStatus(admin))?.isPlatformAdmin === true, 'the client learns administrator status from the server');
  assert((await ApiClient.getPlatformStatus(owner))?.isPlatformAdmin === false, 'and is told "no" for everyone else');
  assert((await ApiClient.getPlatformStatus(undefined)) === null && (await ApiClient.getPlatformStatus('garbage')) === null, 'with no usable session the answer is "unknown" (null), never administrator');
  assert((await ApiClient.listPlatformAdmins(admin))?.length === 2 && (await ApiClient.listPlatformAdmins(owner)) === null, 'the console can load the administrator list; a non-administrator gets null');
  const pv = await ApiClient.previewInvite(inv.body?.token);
  assert(pv?.primaryFramework === 'CMMC_L2' && pv.enabledFrameworks[0] === 'CMMC_L2', 'previewInvite returns the program to the accept page');

  console.log('\n--- The old allow-list names are gone ---');
  assert(!fs.existsSync(path.join(process.cwd(), 'src/data/programs.ts')) && fs.existsSync(path.join(process.cwd(), 'src/data/tenantFrameworkPolicy.ts')), 'R4: src/data/programs.ts moved to src/data/tenantFrameworkPolicy.ts');
  const skip = new Set([path.join('src', 'data', 'frameworks'), path.join('src', 'data', 'stigs'), path.join('server', 'ssp')]);
  const oldName = /\bgetTenantProgram\b|\bTenantProgram\b|ensureControlInProgram|\bprogramSummary\b|\bprogramOf\b|data\/programs['"]/;
  const stale: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(rel)) walk(rel); continue; }
      if (/\.(ts|tsx)$/.test(entry.name) && oldName.test(fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n'))) stale.push(rel);
    }
  };
  walk('server');
  walk('src');
  assert(stale.length === 0, 'R4: no source file under server/ or src/ still uses the old allow-list names', stale);
}

async function run() {
  unitTests();
  await apiTests();

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
