import './testEnv';
import './evidenceEnv';
import crypto from 'crypto';
import fs from 'fs';
import { server } from '../server/index';
import { queryWithProgram } from '../server/db';

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
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, rawBody?: string, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': rawBody !== undefined ? 'application/octet-stream' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
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

  console.log('\n--- X: DELETE /evidence/:id ---');
  const listOf = async (program?: string) => (((await call('GET', '/evidence', owner, T, undefined, undefined, program)).body?.evidence ?? []) as Json[]);
  const pathOf = async (id: string, program?: string) => String((await listOf(program)).find((e) => e.id === id)?.gcsPath ?? '');
  const gcsE = await pathOf(E);
  assert(gcsE !== '' && fs.existsSync(gcsE), 'X0 the uploaded file is on disk before the deletes', gcsE === '' ? 'no path' : fs.existsSync(gcsE));

  const x1 = await call('DELETE', `/evidence/${E}`, viewer, T);
  const x1file = await call('GET', `/evidence/${E}/file`, owner, T);
  assert(x1.status === 403 && x1file.status === 200 && x1file.text === 'hello', 'X1 a VIEWER cannot delete -> 403 and the file still downloads', [x1.status, x1file.status]);
  const x2 = await call('DELETE', `/evidence/${E}`, null, T);
  assert(x2.status === 401, 'X2 no token -> 401', x2.status);
  const x3 = await call('DELETE', '/evidence/bad.id', owner, T);
  assert(x3.status === 400 && x3.body?.error === 'Invalid evidence ID', 'X3 an id with a dot -> 400', [x3.status, x3.body]);
  const x4 = await call('DELETE', '/evidence/ev_0_zzzzz', owner, T);
  assert(x4.status === 404 && x4.body?.error === 'Evidence not found', 'X4 an unknown id -> 404', [x4.status, x4.body]);

  const inhRow = (await listOf()).find((e) => String(e.id).startsWith(`${E}__inh_`));
  if (!inhRow) {
    console.log('  - SKIP: X5 the upload created no inherited rows for this control (nothing to delete on its own)');
  } else {
    const x5 = await call('DELETE', `/evidence/${inhRow.id}`, owner, T);
    const x5file = await call('GET', `/evidence/${E}/file`, owner, T);
    assert(
      x5.status === 200 && JSON.stringify(x5.body?.removedIds) === JSON.stringify([inhRow.id]) && x5.body?.fileRemoved === false && fs.existsSync(gcsE) && x5file.status === 200 && x5file.text === 'hello',
      'X5 deleting an inherited copy removes only that row and keeps the file',
      x5.body
    );
  }

  const beforeX6 = (await listOf()).map((e) => String(e.id)).filter((id) => id === E || id.startsWith(`${E}__inh_`)).sort();
  const x6 = await call('DELETE', `/evidence/${E}`, owner, T);
  const afterX6 = (await listOf()).map((e) => String(e.id));
  const x6file = await call('GET', `/evidence/${E}/file`, owner, T);
  assert(
    x6.status === 200 && x6.body?.deleted === true && JSON.stringify([...(x6.body?.removedIds ?? [])].sort()) === JSON.stringify(beforeX6) && x6.body?.fileRemoved === true,
    'X6 deleting the base record removes it and its remaining copies and the file',
    [x6.status, x6.body, beforeX6]
  );
  assert(!fs.existsSync(gcsE) && !afterX6.some((id) => id === E || id.startsWith(`${E}__inh_`)) && x6file.status === 404, 'X6 the file is gone from disk, the list has none of the rows and /file is 404', [fs.existsSync(gcsE), x6file.status]);
  assert(x6.headers.get('cache-control') === 'no-store', 'X6 the DELETE response is no-store', x6.headers.get('cache-control'));
  const x7 = await call('DELETE', `/evidence/${E}`, owner, T);
  assert(x7.status === 404, 'X7 deleting it again -> 404', x7.status);
  const x8 = await call('DELETE', `/evidence/${E2}`, owner, T);
  assert(x8.status === 200 && x8.body?.fileRemoved === false && (x8.body?.removedIds ?? []).includes(E2), 'X8 a record whose bytes were never uploaded is deleted, with no file removed', x8.body);

  console.log('\n--- X9-X10: another program, an archived program ---');
  const px = await call('POST', `/tenants/${T}/programs`, owner, T, { name: 'Evidence delete P', frameworkId: 'CMMC_L1' });
  const P = px.body?.program?.id as string;
  assert(px.status === 201 && Boolean(P), 'X9 program created', [px.status, px.body]);
  const up3 = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'program.txt', fileSize: 7, mimeType: 'text/plain', fileHash: sha256('program') }, undefined, P);
  const E3 = up3.body?.evidenceId as string;
  const put3 = await call('PUT', `/evidence/upload-local/${E3}`, owner, T, undefined, 'program', P);
  const gcs3 = await pathOf(E3, P);
  assert(up3.status === 201 && put3.status === 200 && gcs3 !== '' && fs.existsSync(gcs3), 'X9 evidence uploaded under the program', [up3.status, put3.status]);
  const x9 = await call('DELETE', `/evidence/${E3}`, owner, T);
  assert(x9.status === 404 && fs.existsSync(gcs3), 'X9 deleting it in the default program (no x-program-id) -> 404 and the file stays', [x9.status, fs.existsSync(gcs3)]);
  const arch = await call('POST', `/tenants/${T}/programs/${P}/archive`, owner, T);
  const x10 = await call('DELETE', `/evidence/${E3}`, owner, T, undefined, undefined, P);
  assert(arch.status === 200 && x10.status === 409 && x10.body?.code === 'program_archived' && fs.existsSync(gcs3), 'X10 an archived program refuses the delete -> 409 program_archived and the file stays', [arch.status, x10.status, x10.body]);
  const unarch = await call('POST', `/tenants/${T}/programs/${P}/unarchive`, owner, T);
  const x10b = await call('DELETE', `/evidence/${E3}`, owner, T, undefined, undefined, P);
  assert(unarch.status === 200 && x10b.status === 200 && x10b.body?.fileRemoved === true && !fs.existsSync(gcs3), 'X10 after unarchiving the delete -> 200 and the file is removed', [unarch.status, x10b.status, x10b.body]);

  console.log('\n--- X11-X12: a shared file, system-managed evidence ---');
  const defaultProgram = (((await call('GET', `/tenants/${T}/programs`, owner, T)).body?.programs ?? []) as Json[]).find((p) => p.isDefault)?.id as string;
  assert(Boolean(defaultProgram), 'X11 the default program id is known', defaultProgram);
  const up4 = await call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: 'shared.txt', fileSize: 6, mimeType: 'text/plain', fileHash: sha256('shared') });
  const E4 = up4.body?.evidenceId as string;
  await call('PUT', `/evidence/upload-local/${E4}`, owner, T, undefined, 'shared');
  const gcs4 = await pathOf(E4);
  const insertRow = `
    INSERT INTO evidence_metadata (
      id, tenant_id, control_id, file_name, file_size, mime_type,
      gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12
    )
    RETURNING *;
  `;
  const E4b = 'ev_shared_second_row';
  await queryWithProgram({ tenantId: T, programId: defaultProgram }, insertRow, [E4b, T, AC1, 'shared.txt', 6, 'text/plain', gcs4, sha256('shared'), 'local_storage', 'second row on the same file', 'Assessor', defaultProgram]);
  const x11 = await call('DELETE', `/evidence/${E4}`, owner, T);
  assert(x11.status === 200 && x11.body?.fileRemoved === false && fs.existsSync(gcs4), 'X11 a second row uses the file: deleting the first keeps it', [x11.status, x11.body]);
  const x11b = await call('DELETE', `/evidence/${E4b}`, owner, T);
  assert(x11b.status === 200 && x11b.body?.fileRemoved === true && !fs.existsSync(gcs4), 'X11 deleting the last row that uses the file removes it', [x11b.status, x11b.body]);

  const E5 = 'ev_vm_snapshot_row';
  await queryWithProgram({ tenantId: T, programId: defaultProgram }, insertRow, [E5, T, AC1, 'snapshot.json', 2, 'application/json', 'vm-snapshot-not-a-file', sha256('snap'), 'local_storage', 'VM snapshot', 'system:vm-snapshot', defaultProgram]);
  const x12 = await call('DELETE', `/evidence/${E5}`, owner, T);
  const x12list = await listOf();
  assert(x12.status === 409 && x12.body?.code === 'evidence_system_managed' && x12list.some((e) => e.id === E5), 'X12 VM snapshot evidence -> 409 evidence_system_managed and the row stays', [x12.status, x12.body]);
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
