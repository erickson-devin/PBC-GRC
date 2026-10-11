import './testEnv';
import { server } from '../server/index';
import { canRoleWrite, WRITE_ROLES } from '../src/utils/roles';
import type { TenantRole } from '../src/types/tenant';

/**
 * Server-side RBAC: ASSESSOR and VIEWER are strictly read-only; only TENANT_OWNER and MSP_ADMIN may write.
 * Tokens are dev-only mock tokens that carry a `roles` claim ({ tenantId: role }).
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const TENANT = 'tenant_rbac';

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

const mockJwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify({ sub: 'user_rbac', email: 'rbac@test.mil', ...claims })).toString('base64')}.mock_pbc_signature`;
const tokenFor = (role: TenantRole, tenant = TENANT) => mockJwt({ roles: { [tenant]: role } });

async function call(method: string, path: string, token: string, tenant: string = TENANT, body?: unknown, raw = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-tenant-id': tenant,
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
    },
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const controlUpdate = { status: 'MET', implementationNotes: 'RBAC test update' };
const uploadRequest = { controlId: 'AC.L1-3.1.1', fileName: 'p.pdf', fileHash: 'abc123', fileSize: 1, mimeType: 'application/pdf' };

/**
 * Exit without process.exit(): calling it while fetch's keep-alive sockets are still closing trips a libuv
 * assertion on Windows. Drop the server's connections, then let the event loop drain naturally.
 */
function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Shared role helper ---');
  assert(WRITE_ROLES.length === 2, 'exactly two roles can write');
  assert(canRoleWrite('TENANT_OWNER') && canRoleWrite('MSP_ADMIN'), 'TENANT_OWNER and MSP_ADMIN can write');
  assert(!canRoleWrite('ASSESSOR'), 'ASSESSOR cannot write');
  assert(!canRoleWrite('VIEWER'), 'VIEWER cannot write');
  assert(!canRoleWrite(undefined) && !canRoleWrite(null), 'missing role cannot write (fails closed)');

  console.log('\n--- Writers ---');
  for (const role of ['TENANT_OWNER', 'MSP_ADMIN'] as const) {
    const r = await call('PUT', '/controls/AC.L1-3.1.1', tokenFor(role), TENANT, controlUpdate);
    assert(r.status === 200, `${role}: PUT /controls/:id -> 200`, r);
    const u = await call('POST', '/evidence/upload-url', tokenFor(role), TENANT, uploadRequest);
    assert(u.status === 201, `${role}: POST /evidence/upload-url -> 201`, u);
  }

  console.log('\n--- Read-only roles ---');
  for (const role of ['ASSESSOR', 'VIEWER'] as const) {
    const t = tokenFor(role);
    const put = await call('PUT', '/controls/AC.L1-3.1.1', t, TENANT, controlUpdate);
    assert(put.status === 403, `${role}: PUT /controls/:id -> 403`, put);
    const post = await call('POST', '/evidence/upload-url', t, TENANT, uploadRequest);
    assert(post.status === 403, `${role}: POST /evidence/upload-url -> 403`, post);
    const local = await call('PUT', '/evidence/upload-local/ev_x', t, TENANT, 'data', true);
    assert(local.status === 403, `${role}: PUT /evidence/upload-local/:id -> 403`, local);
    const del = await call('DELETE', '/evidence/ev_x', t);
    assert(del.status === 403, `${role}: DELETE /evidence/:id -> 403 (guard runs before routing)`, del);
    assert((await call('GET', '/controls', t)).status === 200, `${role}: GET /controls -> 200`);
    assert((await call('GET', '/evidence', t)).status === 200, `${role}: GET /evidence -> 200`);
    assert(put.body?.role === role, `${role}: 403 body reports the denied role`, put.body);
  }

  console.log('\n--- Role is per-tenant ---');
  const mixed = mockJwt({ roles: { [TENANT]: 'VIEWER', tenant_other: 'TENANT_OWNER' } });
  assert((await call('PUT', '/controls/AC.L1-3.1.1', mixed, TENANT, controlUpdate)).status === 403, 'owner elsewhere, viewer here -> 403');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', mixed, 'tenant_other', controlUpdate)).status === 200, 'same token, owner tenant -> 200');
  assert((await call('GET', '/controls', tokenFor('TENANT_OWNER', 'tenant_other'), TENANT)).status === 403, 'role in another tenant grants no access here');

  console.log('\n--- Dev mock token without role claims (non-production only) ---');
  const noRole = mockJwt({});
  assert((await call('PUT', '/controls/AC.L1-3.1.1', noRole, TENANT, controlUpdate)).status === 200, 'dev mock token without roles defaults to owner');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
