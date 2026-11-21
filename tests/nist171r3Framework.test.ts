import './testEnv';
import { server } from '../server/index';
import { FRAMEWORK_REGISTRY, findControlDefinition, getFrameworkControls } from '../src/data/frameworks';
import { SSP_IMPORT_FRAMEWORKS } from '../src/types/sspImport';
import { TABLES_SQL, PROGRAM_FRAMEWORK_IDS } from '../server/schema';
import { NIST_171_R3_CONTROLS } from '../src/data/frameworks/nist171r3/controls';

/**
 * NIST SP 800-171 Rev. 3 as a registered framework (#255): the registry and lookups (pure), the guarantees that keep the SSP import
 * on its three frameworks, and a Rev. 3 program over HTTP (create, the programs that cannot carry a baseline, scoping or the VM
 * target, GET and PUT /controls, the framework policy of a tenant). Runs against the in-memory store. Boots the server on port 8080:
 * run it alone.
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

const R3 = 'NIST_800_171_R3';
const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
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

function pureTests() {
  console.log('--- The registry and the lookups ---');
  const def = FRAMEWORK_REGISTRY[R3];
  const controls = getFrameworkControls(R3);
  assert(Boolean(def) && def.id === R3 && def.totalControls === controls.length && controls.length > 0, 'the registry entry exists and totalControls equals the length of getFrameworkControls', [def?.totalControls, controls.length]);
  assert(def.name === 'NIST SP 800-171 Rev. 3 (Protecting CUI)' && def.shortName === 'NIST SP 800-171 Rev. 3' && def.authority === 'NIST SP 800-171 Rev. 3 / NIST SP 800-171A Rev. 3', 'the registry strings are the agreed ones', [def.name, def.shortName, def.authority]);
  assert(controls.every((c) => c.framework === R3), 'every control belongs to NIST_800_171_R3');
  assert(findControlDefinition('03.01.01')?.framework === R3, "findControlDefinition('03.01.01') is a Rev. 3 control");
  assert(findControlDefinition('AC.L2-3.1.3')?.framework === 'CMMC_L2' && findControlDefinition('AC.L1-3.1.1')?.framework === 'CMMC_L1', "findControlDefinition still resolves 'AC.L2-3.1.3' to CMMC_L2 and 'AC.L1-3.1.1' to CMMC_L1");
  assert(getFrameworkControls('CMMC_L2').length === 110, 'CMMC_L2 still has 110 controls');
  const definers = Object.keys(FRAMEWORK_REGISTRY)
    .filter((k) => FRAMEWORK_REGISTRY[k].id === k)
    .filter((k) => getFrameworkControls(k).some((c) => c.id === '03.01.01'));
  assert(definers.length === 1 && definers[0] === R3, 'only NIST_800_171_R3 defines the id 03.01.01', definers);
  assert(getFrameworkControls(R3, 'MOD_MOD_MOD').length === controls.length, 'a baseline does not filter Rev. 3 (MOD_MOD_MOD gives every requirement)');
  assert(getFrameworkControls(R3, 'ALL_CONTROLS', { noWireless: true }).length === controls.length, 'Rev. 3 carries no overlay flags: noWireless filters nothing');
  assert(NIST_171_R3_CONTROLS.length === controls.length && NIST_171_R3_CONTROLS.every((c) => c.parameters !== undefined), 'every Rev. 3 control carries its precomputed parameters');
  const ac1 = findControlDefinition('03.01.01');
  assert((ac1?.parameters ?? []).length > 0 && ac1!.parameters!.every((p) => p.id.startsWith('03.01.01#')), 'the parameters of 03.01.01 are numbered 03.01.01#n');

  console.log('\n--- What keeps the SSP import on its three frameworks ---');
  assert(JSON.stringify([...SSP_IMPORT_FRAMEWORKS]) === JSON.stringify(['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5']), 'SSP_IMPORT_FRAMEWORKS is still the three frameworks');
  assert(TABLES_SQL.includes("CHECK (framework IN ('CMMC_L1','CMMC_L2','NIST_800_53_REV5'))"), "ssp_import_jobs_framework_check still lists exactly ('CMMC_L1','CMMC_L2','NIST_800_53_REV5')");
  assert(!TABLES_SQL.match(/ssp_import_jobs_framework_check[^;]*NIST_800_171_R3/), 'and does not mention Rev. 3');
  assert((PROGRAM_FRAMEWORK_IDS as readonly string[]).includes(R3), 'PROGRAM_FRAMEWORK_IDS lists Rev. 3');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_r3_admin@test.mil';
  const owner = person('u_r3_admin');

  console.log('\n--- Setup: a tenant with Rev. 3 and one without ---');
  const mk = async (name: string, enabledFrameworks: string[]) =>
    (await call('POST', '/tenants', owner, undefined, { name, primaryFramework: 'CMMC_L2', enabledFrameworks })).body?.tenant?.id as string;
  const T = await mk('R3 Tenant', ['CMMC_L2', R3]);
  const T2 = await mk('No R3 Tenant', ['CMMC_L2']);
  assert(Boolean(T) && Boolean(T2) && T !== T2, 'two tenants created (one with Rev. 3 enabled, one without)', { T, T2 });
  const newProgram = (tenant: string, body: Json) => call('POST', `/tenants/${tenant}/programs`, owner, tenant, body);

  console.log('\n--- A Rev. 3 program ---');
  const first = await newProgram(T, { name: 'CMMC Boundary', frameworkId: 'CMMC_L2' });
  assert(first.status === 201, 'the first (default) program, CMMC_L2, is created', first.body);
  const r3 = await newProgram(T, { name: 'Rev 3 Boundary', frameworkId: R3 });
  const P = r3.body?.program?.id as string;
  assert(r3.status === 201 && r3.body?.program?.frameworkId === R3 && r3.body.program.baseline === null, 'create a Rev. 3 program -> 201, baseline null', r3.body);
  const withBaseline = await newProgram(T, { name: 'R3 Moderate', frameworkId: R3, baseline: 'MODERATE' });
  assert(withBaseline.status === 400 && withBaseline.body?.code === 'invalid_baseline', 'with a baseline -> 400 invalid_baseline', withBaseline.body);
  const withPrivacy = await newProgram(T, { name: 'R3 Privacy', frameworkId: R3, privacyBaseline: true });
  assert(withPrivacy.status === 400 && withPrivacy.body?.code === 'invalid_baseline', 'with the privacy baseline -> 400 invalid_baseline', withPrivacy.body);
  const withScoping = await newProgram(T, { name: 'R3 Scoped', frameworkId: R3, scoping: { noWireless: true } });
  assert(withScoping.status === 400 && withScoping.body?.code === 'invalid_scoping', 'with scoping { noWireless: true } -> 400 invalid_scoping', withScoping.body);
  const vm = await call('PUT', `/tenants/${T}/programs/${P}/vm-target`, owner, T);
  assert(vm.status !== 200 && vm.body?.code === 'invalid_vm_target', 'as the VM target -> invalid_vm_target', [vm.status, vm.body]);

  console.log('\n--- Its controls ---');
  const list = await call('GET', '/controls', owner, T, undefined, P);
  const ids = ((list.body?.controls ?? []) as Json[]).map((c) => c.id);
  const want = getFrameworkControls(R3).map((c) => c.id);
  assert(list.status === 200 && list.body?.framework === R3 && JSON.stringify(ids) === JSON.stringify(want), 'GET /controls with the program -> 200 and exactly the Rev. 3 requirements, in catalog order', [list.status, list.body?.framework, ids.length, want.length]);
  const put = await call('PUT', '/controls/03.01.01', owner, T, { status: 'MET', implementationNotes: 'Rev 3 note' }, P);
  assert(put.status === 200, 'PUT /controls/03.01.01 MET -> 200', put.body);
  const after = ((await call('GET', '/controls', owner, T, undefined, P)).body?.controls ?? []).find((c: Json) => c.id === '03.01.01') as Json;
  assert(after?.status === 'MET' && after?.implementationNotes === 'Rev 3 note', 'and it reads back', after);
  const alias = await call('GET', '/controls?framework_id=NIST_SP_800_171_R3', owner, T, undefined, P);
  assert(alias.status === 200 && alias.body?.framework === R3, 'the alias NIST_SP_800_171_R3 resolves to Rev. 3', alias.body?.framework);

  console.log('\n--- The SSP import stays CMMC / SP 800-53 only ---');
  const form = new FormData();
  form.append('framework', R3);
  form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), 'ssp.pdf');
  const up = await fetch(`${BASE}/tenants/${T}/ssp-imports`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'x-tenant-id': T, 'x-program-id': P }, body: form });
  assert(up.status === 400, 'POST /ssp-imports with framework NIST_800_171_R3 -> 400', up.status);
  const cap = (await call('GET', `/tenants/${T}/ssp-imports/capabilities`, owner, T, undefined, P)).body as Json;
  assert(Array.isArray(cap?.frameworks) && !cap.frameworks.includes(R3) && cap.frameworks.includes('CMMC_L2'), 'GET /ssp-imports/capabilities does not offer Rev. 3', cap?.frameworks);

  console.log('\n--- The framework registry endpoint ---');
  const fw = await call('GET', '/controls/frameworks', owner, T, undefined, P);
  const canonical = Object.keys(FRAMEWORK_REGISTRY).filter((k) => FRAMEWORK_REGISTRY[k].id === k).length;
  assert(fw.status === 200 && fw.body?.frameworks?.length === canonical && fw.body.frameworks.some((f: Json) => f.id === R3), 'GET /controls/frameworks lists every canonical framework, Rev. 3 among them', [fw.body?.frameworks?.length, canonical]);

  console.log('\n--- A tenant without Rev. 3 ---');
  await newProgram(T2, { name: 'Only Boundary', frameworkId: 'CMMC_L2' });
  const denied = await newProgram(T2, { name: 'R3 Denied', frameworkId: R3 });
  assert(denied.status === 403 && denied.body?.code === 'framework_not_enabled', 'create a Rev. 3 program -> 403 framework_not_enabled', denied.body);
  const deniedList = await call('GET', `/controls?framework_id=${R3}`, owner, T2);
  assert(deniedList.status === 403, 'GET /controls?framework_id=NIST_800_171_R3 -> 403', [deniedList.status, deniedList.body]);

  console.log('\n--- Platform administration accepts the id ---');
  const bad = await call('POST', '/tenants', owner, undefined, { name: 'Bad Framework', primaryFramework: 'NOT_A_FRAMEWORK' });
  const r3Primary = await call('POST', '/tenants', owner, undefined, { name: 'R3 Primary', primaryFramework: R3, enabledFrameworks: [R3] });
  assert(bad.status === 400 && r3Primary.status === 201 && r3Primary.body?.tenant?.primaryFramework === R3, 'an unknown primaryFramework is 400; NIST_800_171_R3 is accepted', [bad.status, r3Primary.status, r3Primary.body?.tenant?.primaryFramework]);
}

async function run() {
  pureTests();
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
