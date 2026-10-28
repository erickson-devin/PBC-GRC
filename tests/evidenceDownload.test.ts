import './testEnv';
import './evidenceEnv';
import crypto from 'crypto';
import { server } from '../server/index';

/**
 * Evidence download over HTTP: upload (upload-url, then the raw PUT), GET /evidence/:id/file as the owner and as a VIEWER member,
 * the 401 without a token, the no-store and nosniff headers, verify-integrity, an inherited copy's file, and a record whose bytes
 * were never uploaded (404). Section H: every /api response (public, 401, 200, ingest, malformed-JSON 400) carries Cache-Control: no-store. Runs against the in-memory store and a throw-away vault. Boots the server on port 8080: run it alone.
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
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, rawBody?: string) {
  const headers: Record<string, string> = { 'Content-Type': rawBody !== undefined ? 'application/octet-stream' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const AC1 = 'AC.L1-3.1.1';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_ed_admin@test.mil';
  const owner = person('u_ed_admin'); // a platform administrator, and the TENANT_OWNER of the tenant they create
  const viewer = person('u_ed_viewer');

  console.log('--- Setup: a tenant with a VIEWER member ---');
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Evidence Download T', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  assert(Boolean(T), 'tenant created', T);
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ed_viewer', email: 'u_ed_viewer@test.mil', role: 'VIEWER' });

  console.log('\n--- D1: upload ---');
  const up = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'hello.txt', fileSize: 5, mimeType: 'text/plain', fileHash: sha256('hello') });
  const E = up.body?.evidenceId as string;
  assert(up.status === 201 && Boolean(E), 'D1 POST upload-url -> 201', up.body);
  const put = await call('PUT', `/evidence/upload-local/${E}`, owner, T, undefined, 'hello');
  assert(put.status === 200 && put.body?.hashVerified === true, 'D1 PUT the bytes -> 200, hashVerified true', put.body);

  console.log('\n--- D2-D4: GET /file ---');
  const file = await call('GET', `/evidence/${E}/file`, owner, T);
  assert(file.status === 200 && file.text === 'hello', 'D2 owner: 200 with the uploaded bytes', [file.status, file.text]);
  assert(file.headers.get('cache-control') === 'no-store', 'D2 Cache-Control is exactly no-store', file.headers.get('cache-control'));
  assert(file.headers.get('x-content-type-options') === 'nosniff', 'D2 X-Content-Type-Options is nosniff', file.headers.get('x-content-type-options'));
  const anon = await call('GET', `/evidence/${E}/file`, null, T);
  assert(anon.status === 401 && !anon.text.includes('hello'), 'D3 no Authorization -> 401 and the bytes are not in the body', [anon.status, anon.text]);
  const asViewer = await call('GET', `/evidence/${E}/file`, viewer, T);
  assert(asViewer.status === 200 && asViewer.text === 'hello', 'D4 a VIEWER member can download -> 200', [asViewer.status, asViewer.text]);

  console.log('\n--- D5-D6: list and verify-integrity ---');
  const list = await call('GET', '/evidence', owner, T);
  assert(list.status === 200 && list.headers.get('cache-control') === 'no-store', 'D5 GET /evidence: Cache-Control no-store', [list.status, list.headers.get('cache-control')]);
  const ver = await call('GET', `/evidence/${E}/verify-integrity`, owner, T);
  assert(ver.status === 200 && ver.body?.verified === true && ver.body?.currentHash === sha256('hello'), 'D6 verify-integrity: verified, currentHash is the SHA-256 of hello', ver.body);

  console.log('\n--- D7: an inherited copy ---');
  const inherited = ((list.body?.evidence ?? []) as Json[]).find((e) => String(e.id).startsWith(`${E}__inh_`));
  if (!inherited) {
    console.log('  - SKIP: D7 the upload created no inherited rows for this control (nothing to download)');
  } else {
    const inh = await call('GET', `/evidence/${inherited.id}/file`, owner, T);
    assert(inh.status === 200 && inh.text === 'hello', `D7 /file for the inherited id ${inherited.id} -> 200 with the same bytes`, [inh.status, inh.text]);
  }

  console.log('\n--- D8: a record whose bytes were never uploaded ---');
  const up2 = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'empty.txt', fileHash: sha256('never') });
  const E2 = up2.body?.evidenceId as string;
  const file2 = await call('GET', `/evidence/${E2}/file`, owner, T);
  const ver2 = await call('GET', `/evidence/${E2}/verify-integrity`, owner, T);
  assert(up2.status === 201 && file2.status === 404 && ver2.status === 404, 'D8 upload-url without a PUT: /file and verify-integrity are 404', [up2.status, file2.status, ver2.status]);

  console.log('\n--- H: /api no-store ---');
  const noStore = (r: { headers: Headers }) => r.headers.get('cache-control') === 'no-store';
  const h1 = await call('GET', '/health', null);
  assert(h1.status === 200 && noStore(h1) && h1.headers.get('x-content-type-options') === 'nosniff', 'H1 GET /health without a token -> 200, no-store, nosniff', [h1.status, h1.headers.get('cache-control')]);
  const h2 = await call('GET', '/tenants', null);
  assert(h2.status === 401 && noStore(h2), 'H2 GET /tenants without a token -> 401, no-store', [h2.status, h2.headers.get('cache-control')]);
  const h3 = await call('GET', `/evidence/${E}/file`, null);
  assert(h3.status === 401 && noStore(h3), 'H3 GET /evidence/:id/file without a token -> 401, no-store', [h3.status, h3.headers.get('cache-control')]);
  const h4 = await call('GET', '/tenants', owner);
  assert(h4.status === 200 && noStore(h4), 'H4 GET /tenants as the owner -> 200, no-store', [h4.status, h4.headers.get('cache-control')]);
  const h5 = await call('GET', `/tenants/${T}/assets`, owner, T);
  assert(h5.status === 200 && noStore(h5), 'H5 GET /tenants/:id/assets as the owner -> 200, no-store', [h5.status, h5.headers.get('cache-control')]);
  const h6 = await call('POST', '/vm/ingest', null, undefined, {});
  assert(h6.status === 401 && noStore(h6), 'H6 POST /vm/ingest without Authorization -> 401, no-store', [h6.status, h6.headers.get('cache-control')]);
  const h7 = await fetch(`${BASE}/tenants`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: '{bad' });
  await h7.text();
  assert(h7.status === 400 && noStore(h7), 'H7 POST /tenants with a malformed JSON body -> 400, no-store', [h7.status, h7.headers.get('cache-control')]);
  const h8 = await call('GET', '/auth/config', null);
  assert(noStore(h8), 'H8 GET /auth/config -> no-store', [h8.status, h8.headers.get('cache-control')]);
}

run()
  .catch((err) => {
    console.error('Unexpected error:', err);
    total++;
  })
  .finally(() => {
    console.log(`\n📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${total ? Math.round((passed / total) * 100) : 0}%)`);
    process.exitCode = passed === total ? 0 : 1;
    server.closeAllConnections();
    server.close();
  });
