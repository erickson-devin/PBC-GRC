import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import app, { server } from '../server/index';
import { parseTrustProxy } from '../server/trustProxy';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { serviceTokenMiddleware } from '../server/middleware/serviceTokenMiddleware';
import { __expireVmTokenForTests, clampTokenDays, generateVmToken, sha256Hex, shouldTouchLastUsed, VM_TOKEN_PATTERN } from '../server/vm/tokens';
import { vmIngestMaxBytes } from '../server/vm/ingestSchema';
import { __drainVmWorkerForTests, __setVmWorkerFaultForTests, enqueueVmRun } from '../server/vm/worker';
import { recordReceivedRun } from '../server/vm/store';

/**
 * Vulnerability-management Phase 2 over HTTP: service tokens (create / list / revoke, transport rule), the scanner push
 * endpoint (authentication, validation, duplicates, size and media-type limits, storage) and the tenant read endpoints.
 * Runs against the in-memory store with a throw-away vault (see ./vmEnv). Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };

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

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (tenant) h['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

const resetLimiters = () => {
  vmIngestRateLimiter.reset();
  vmTokenRateLimiter.reset();
};

/** Posts raw bytes to the ingest endpoint. Limiters are reset first unless `keepLimits`. */
async function ingestRaw(token: string | null, body: Buffer | undefined, headers: Record<string, string> = { 'Content-Type': 'application/json' }, keepLimits = false) {
  if (!keepLimits) resetLimiters();
  const h: Record<string, string> = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: h, body });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}
const ingest = (token: string | null, bytes: Buffer | string) => ingestRaw(token, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

interface PayloadOptions { label?: string; kind?: string; agents?: string[]; extra?: Record<string, unknown> }
function payloadOf(o: PayloadOptions = {}): Record<string, any> {
  const agents = o.agents ?? ['001', '002'];
  return {
    schema_version: 1,
    source: { kind: o.kind ?? 'WAZUH', label: o.label ?? 'wazuh-main' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: agents.map((id, i) => ({
      agent_id: id,
      hostname: 'host-' + id,
      findings: [
        { vuln_id: 'CVE-2024-0001', severity: 'HIGH' },
        ...(i === 0 ? [{ vuln_id: 'CVE-2024-0002', severity: 'LOW' }] : []),
      ],
    })),
    ...(o.extra ?? {}),
  };
}
const bytesOf = (o: PayloadOptions = {}) => Buffer.from(JSON.stringify(payloadOf(o)));

const runFiles = (tenant: string): string[] => {
  const dir = path.join(VM_TEST_VAULT, 'tenants', tenant, 'vm', 'runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

async function shutdown(code: number) {
  process.exitCode = code;
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Pure helpers ---');
  const proxyCases: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined], ['', undefined], ['  ', undefined],
    ['10.0.0.5', '10.0.0.5'], ['10.0.0.0/8, ::1', '10.0.0.0/8,::1'], ['loopback', 'loopback'],
  ];
  for (const [input, expected] of proxyCases) {
    assert(parseTrustProxy(input) === expected, `parseTrustProxy(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, parseTrustProxy(input));
  }
  for (const bad of ['true', 'TRUE', 'false', '1', '2']) {
    let message = '';
    try { parseTrustProxy(bad); } catch (err) { message = (err as Error).message; }
    assert(message.includes('TRUST_PROXY'), `parseTrustProxy(${JSON.stringify(bad)}) throws a TRUST_PROXY error`, message);
  }
  assert(clampTokenDays(1000) === 730 && clampTokenDays(0) === 1 && clampTokenDays(undefined) === 365 && clampTokenDays(Number.NaN) === 365 && clampTokenDays(1.9) === 1, 'clampTokenDays: 1000 -> 730, 0 -> 1, undefined / NaN -> 365, 1.9 -> 1');
  const nowMs = Date.now();
  assert(shouldTouchLastUsed(null, nowMs) && shouldTouchLastUsed(new Date(nowMs - 61_000), nowMs) && !shouldTouchLastUsed(new Date(nowMs - 5_000), nowMs), 'shouldTouchLastUsed: unset or older than a minute -> true, recent -> false');
  assert(sha256Hex('{}') === '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'sha256Hex of "{}"');
  assert(VM_TOKEN_PATTERN.test(generateVmToken()) && generateVmToken() !== generateVmToken(), 'generated tokens match the pattern and are unique');
  assert(vmIngestMaxBytes() === 262144, 'vmEnv sets the ingest limit to 262144 bytes', vmIngestMaxBytes());

  console.log('\n--- Limiter key option (fake req / res) ---');
  const fakeRes = () => {
    const r = { code: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { r.headers[k] = v; }, status(c: number) { r.code = c; return r; }, json() { return r; } };
    return r;
  };
  const hit = (id: string | undefined, ip = '9.9.9.9') => {
    const res = fakeRes();
    let nexted = false;
    vmTokenRateLimiter({ ip, serviceToken: id ? { id, tenantId: 't', scopes: ['vm:ingest'] } : undefined } as unknown as Request, res as unknown as Response, () => { nexted = true; });
    return { nexted, code: res.code };
  };
  vmTokenRateLimiter.reset();
  let lastA = { nexted: true, code: 0 };
  for (let i = 0; i < 31; i++) lastA = hit('tok_a');
  assert(!lastA.nexted && lastA.code === 429, 'the 31st request of one token id -> 429');
  assert(hit('tok_b').nexted, 'another token id from the same address has its own bucket');
  let lastNone = { nexted: true, code: 0 };
  for (let i = 0; i < 31; i++) lastNone = hit(undefined, 'ip-' + i);
  assert(!lastNone.nexted && lastNone.code === 429, 'requests without a service token share the "-" bucket, whatever the address');
  vmTokenRateLimiter.reset();

  console.log('\n--- Setup: users, tenants, members ---');
  const ownerA = person('u_vm_owner_a');
  const ownerB = person('u_vm_owner_b');
  const ownerC = person('u_vm_owner_c');
  const mkTenant = async (owner: string, name: string) => (await call('POST', '/tenants', owner, undefined, { name })).body?.tenant?.id as string;
  const A = await mkTenant(ownerA, 'VM Org A');
  const B = await mkTenant(ownerB, 'VM Org B');
  const C = await mkTenant(ownerC, 'VM Org C');
  assert(Boolean(A && B && C), 'three tenants created', { A, B, C });
  await call('POST', `/tenants/${A}/members`, ownerA, A, { userId: 'u_vm_assessor', email: 'vma@test.mil', role: 'ASSESSOR' });
  await call('POST', `/tenants/${A}/members`, ownerA, A, { userId: 'u_vm_viewer', email: 'vmv@test.mil', role: 'VIEWER' });
  const assessor = person('u_vm_assessor');
  const viewer = person('u_vm_viewer');

  const createToken = (owner: string, tenant: string, body: unknown, headers: Record<string, string> = HTTPS) => call('POST', `/tenants/${tenant}/vm/tokens`, owner, tenant, body, headers);
  const listTokens = async (owner: string, tenant: string) => ((await call('GET', `/tenants/${tenant}/vm/tokens`, owner, tenant)).body?.tokens ?? []) as Json[];

  console.log('\n--- Token creation and transport ---');
  const noHttps = await createToken(ownerA, A, { name: 'plain http' }, {});
  assert(noHttps.status === 403 && noHttps.body?.error === 'vm_insecure_transport', 'without X-Forwarded-Proto: https -> 403 vm_insecure_transport', noHttps.body);
  const first = await createToken(ownerA, A, { name: '  ingest-main  ' });
  const tokenA = first.body?.token as string;
  const tokenARecord = first.body?.record as Json;
  assert(first.status === 201 && VM_TOKEN_PATTERN.test(tokenA), 'with the header the owner creates a token (201, pbcvm_ + 43 characters)', first.body);
  assert(tokenARecord.name === 'ingest-main' && JSON.stringify(tokenARecord.scopes) === '["vm:ingest"]' && tokenARecord.tokenPrefix === tokenA.slice(0, 12) && tokenARecord.revokedAt === null && tokenARecord.lastUsedAt === null, 'name trimmed, default scope vm:ingest, display prefix, never used', tokenARecord);
  assert(tokenARecord.createdByUserId === 'u_vm_owner_a' && String(tokenARecord.createdBy).includes('u_vm_owner_a'), 'createdBy / createdByUserId identify the creator', tokenARecord);
  assert(!JSON.stringify(tokenARecord).includes(tokenA) && !('tokenHash' in tokenARecord) && !('token_hash' in tokenARecord), 'the record carries neither the token nor a hash');

  app.set('trust proxy', false);
  const noTrust = await createToken(ownerA, A, { name: 'forged header' });
  app.set('trust proxy', 'loopback');
  assert(noTrust.status === 403 && noTrust.body?.error === 'vm_insecure_transport', 'with trust proxy off the header is ignored -> 403', noTrust.body);
  const stillOk = await createToken(ownerA, A, { name: 'second' });
  assert(stillOk.status === 201, 'after restoring trust proxy the header is honoured again (201)', stillOk.body);

  process.env.VM_ALLOW_INSECURE_TOKENS = 'true';
  const override = await createToken(ownerA, A, { name: 'override' }, {});
  delete process.env.VM_ALLOW_INSECURE_TOKENS;
  assert(override.status === 201, 'VM_ALLOW_INSECURE_TOKENS=true allows creation over plain HTTP (201)', override.body);
  assert((await createToken(ownerA, A, { name: 'after override' }, {})).status === 403, 'and removing it restores the refusal (403)');

  const viewerCreate = await createToken(viewer, A, { name: 'x' });
  const assessorCreate = await createToken(assessor, A, { name: 'x' });
  assert(viewerCreate.status === 403 && viewerCreate.body?.error !== 'vm_insecure_transport', 'a VIEWER cannot create a token (403, by role)', viewerCreate.body);
  assert(assessorCreate.status === 403 && assessorCreate.body?.error !== 'vm_insecure_transport', 'an ASSESSOR cannot create a token (403, by role)', assessorCreate.body);
  assert((await createToken(ownerB, A, { name: 'x' })).status === 403, "another tenant's owner cannot create a token here (403)");
  assert((await createToken(null, A, { name: 'x' })).status === 401, 'no session => 401');

  console.log('\n--- Token validation ---');
  const bad: Array<[string, unknown]> = [
    ['no body', undefined],
    ['missing name', {}],
    ['blank name', { name: '   ' }],
    ['name over 255 characters', { name: 'n'.repeat(256) }],
    ['name with a control character', { name: 'a\nb' }],
    ['name that is not text', { name: 5 }],
    ['empty scopes', { name: 'x', scopes: [] }],
    ['unknown scope', { name: 'x', scopes: ['vm:admin'] }],
    ['scopes that is not a list', { name: 'x', scopes: 'vm:ingest' }],
    ['expiresInDays as text', { name: 'x', expiresInDays: '30' }],
    ['expiresInDays null', { name: 'x', expiresInDays: null }],
  ];
  for (const [label, body] of bad) {
    const r = await createToken(ownerA, A, body);
    assert(r.status === 400, `${label} -> 400`, r.body);
  }
  const edge = await createToken(ownerA, A, { name: 'n'.repeat(255), scopes: ['vm:ingest'] });
  assert(edge.status === 201 && edge.body?.record?.name.length === 255, 'a 255 character name with an explicit scope is accepted');

  console.log('\n--- Lifetime clamps and the active-token cap (tenant C) ---');
  const daysOf = (r: Json) => (new Date(r.body?.record.expiresAt).getTime() - Date.now()) / 86_400_000;
  const long = await createToken(ownerC, C, { name: 'long', expiresInDays: 1000 });
  assert(long.status === 201 && daysOf(long) > 729.9 && daysOf(long) <= 730.01, '1000 days is clamped to about 730', daysOf(long));
  const zero = await createToken(ownerC, C, { name: 'zero', expiresInDays: 0 });
  assert(zero.status === 201 && daysOf(zero) > 0.99 && daysOf(zero) <= 1.01, '0 days is clamped to about 1', daysOf(zero));
  const ids: string[] = [long.body?.record.id, zero.body?.record.id];
  for (let i = 2; i < 10; i++) ids.push((await createToken(ownerC, C, { name: 'fill-' + i })).body?.record.id);
  assert(ids.length === 10 && ids.every(Boolean), 'ten active tokens exist');
  const eleventh = await createToken(ownerC, C, { name: 'eleventh' });
  assert(eleventh.status === 429 && eleventh.body?.code === 'limit', 'the 11th active token -> 429 code limit', eleventh.body);
  __expireVmTokenForTests(ids[0]);
  const afterExpire = await createToken(ownerC, C, { name: 'after expiry' });
  assert(afterExpire.status === 201, 'an expired token frees a slot (201)', afterExpire.body);
  assert((await createToken(ownerC, C, { name: 'full again' })).status === 429, 'the tenant is full again (429)');
  const rev = await call('POST', `/tenants/${C}/vm/tokens/${ids[1]}/revoke`, ownerC, C);
  assert(rev.status === 200 && Boolean(rev.body?.token?.revokedAt), 'revoking a token (200) ...', rev.body);
  assert((await createToken(ownerC, C, { name: 'after revoke' })).status === 201, '... frees a slot (201)');

  console.log('\n--- Listing and revoking tokens (tenant A) ---');
  const tokens = await listTokens(ownerA, A);
  const listText = JSON.stringify(tokens);
  assert(tokens.length >= 4 && tokens.every((t) => /^pbcvm_/.test(t.tokenPrefix) && t.tokenPrefix.length === 12), 'the list shows each token by its display prefix', tokens.map((t) => t.tokenPrefix));
  assert(!listText.includes(tokenA) && !listText.includes(sha256Hex(tokenA)) && !/token_?hash/i.test(listText), 'the list never contains a token, its hash or a hash field');
  const listRes = await call('GET', `/tenants/${A}/vm/tokens`, ownerA, A);
  assert(listRes.body?.tenantId === A && listRes.body?.totalCount === tokens.length, 'the list reports tenantId and totalCount');
  assert((await call('GET', `/tenants/${A}/vm/tokens`, viewer, A)).status === 403, 'a VIEWER cannot list tokens (403)');
  assert((await call('GET', `/tenants/${A}/vm/tokens`, assessor, A)).status === 403, 'an ASSESSOR cannot list tokens (403)');
  assert((await call('GET', `/tenants/${B}/vm/tokens`, ownerA, A)).status === 403, 'the URL tenant must match the active tenant (403)');

  const victim = (await createToken(ownerA, A, { name: 'to revoke' })).body?.record.id as string;
  const revoked1 = await call('POST', `/tenants/${A}/vm/tokens/${victim}/revoke`, ownerA, A);
  const revoked2 = await call('POST', `/tenants/${A}/vm/tokens/${victim}/revoke`, ownerA, A);
  assert(revoked1.status === 200 && revoked2.status === 200 && revoked1.body?.token?.revokedAt === revoked2.body?.token?.revokedAt, 'revoking twice is idempotent (200, same revokedAt)', [revoked1.body, revoked2.body]);
  assert((await call('POST', `/tenants/${A}/vm/tokens/vmt_doesnotexist/revoke`, ownerA, A)).status === 404, 'an unknown id -> 404');
  assert((await call('POST', `/tenants/${A}/vm/tokens/a.b/revoke`, ownerA, A)).status === 404, 'an id with characters outside the pattern -> 404');
  assert((await call('POST', `/tenants/${B}/vm/tokens/${victim}/revoke`, ownerB, B)).status === 404, "another tenant's owner cannot revoke this tenant's token (404)");
  assert((await call('POST', `/tenants/${A}/vm/tokens/${victim}/revoke`, viewer, A)).status === 403, 'a VIEWER cannot revoke (403)');

  console.log('\n--- Ingest authentication ---');
  const unknownWellFormed = 'pbcvm_' + 'A'.repeat(43);
  const revokedToken = (await createToken(ownerA, A, { name: 'will be revoked' })).body as Json;
  await call('POST', `/tenants/${A}/vm/tokens/${revokedToken.record.id}/revoke`, ownerA, A);
  const expiredToken = (await createToken(ownerA, A, { name: 'will expire' })).body as Json;
  __expireVmTokenForTests(expiredToken.record.id);
  const variants: Array<[string, Record<string, string>]> = [
    ['no Authorization header', { 'Content-Type': 'application/json' }],
    ['a Basic scheme', { 'Content-Type': 'application/json', Authorization: 'Basic abc' }],
    ['an empty bearer', { 'Content-Type': 'application/json', Authorization: 'Bearer ' }],
    ['a bearer that is not a token', { 'Content-Type': 'application/json', Authorization: 'Bearer notatoken' }],
    ['a pbcvm_ token of the wrong length', { 'Content-Type': 'application/json', Authorization: 'Bearer pbcvm_short' }],
    ['a well-formed unknown token', { 'Content-Type': 'application/json', Authorization: 'Bearer ' + unknownWellFormed }],
    ['a revoked token', { 'Content-Type': 'application/json', Authorization: 'Bearer ' + revokedToken.token }],
    ['an expired token', { 'Content-Type': 'application/json', Authorization: 'Bearer ' + expiredToken.token }],
  ];
  const texts: string[] = [];
  for (const [label, headers] of variants) {
    const r = await ingestRaw(null, bytesOf(), headers);
    texts.push(r.text);
    assert(r.status === 401, `${label} -> 401`, r.text);
  }
  assert(texts.every((t) => t === texts[0]) && texts[0].length > 0, 'all eight 401 bodies are byte-identical', texts);
  const asSession = await call('GET', `/tenants/${A}/vm/runs`, tokenA, A);
  assert(asSession.status === 401, 'a pbcvm_ token is not a user session (401)', asSession.body);
  const fakeReq = { headers: { authorization: 'Bearer ' + tokenA } } as unknown as Request;
  const scopeRes = fakeRes() as ReturnType<typeof fakeRes> & { body?: unknown };
  scopeRes.json = function (b: unknown) { scopeRes.body = b; return scopeRes; };
  let scopeNext = false;
  await serviceTokenMiddleware('vm:other' as never)(fakeReq, scopeRes as unknown as Response, () => { scopeNext = true; });
  assert(scopeRes.code === 403 && JSON.stringify(scopeRes.body) === '{"error":"insufficient_scope"}' && !scopeNext, 'a valid token without the required scope -> 403 insufficient_scope (direct middleware call)', [scopeRes.code, scopeRes.body]);
  assert(!(fakeReq as Request).user && !(fakeReq as Request).tenantRole, 'the middleware never sets req.user or req.tenantRole');

  console.log('\n--- Ingest: happy path ---');
  const body1 = bytesOf({ label: 'wazuh-main' });
  const filesBefore = runFiles(A).length;
  const ok = await ingest(tokenA, body1);
  assert(ok.status === 202 && ok.body?.status === 'RECEIVED' && typeof ok.body?.run_id === 'string', 'a valid payload -> 202 RECEIVED with a run id', ok.body);
  const expectedSha = crypto.createHash('sha256').update(body1).digest('hex');
  assert(ok.body?.sha256 === expectedSha, 'the returned sha256 is the digest of the exact request bytes', ok.body);
  const stored = path.join(VM_TEST_VAULT, 'tenants', A, 'vm', 'runs', `${ok.body?.run_id}.json`);
  assert(fs.existsSync(stored) && fs.readFileSync(stored).equals(body1), 'the file under <vault>/tenants/<A>/vm/runs/<run_id>.json is byte-identical');
  assert(runFiles(A).length === filesBefore + 1, 'exactly one new file');
  await __drainVmWorkerForTests();
  const runs = (await call('GET', `/tenants/${A}/vm/runs`, ownerA, A)).body as Json;
  const stat = (runs.runs as Json[]).find((r) => r.id === ok.body?.run_id) as Json;
  assert(runs.tenantId === A && runs.totalCount === (runs.runs as Json[]).length && Boolean(stat), 'the run appears in the runs list', runs);
  assert(stat.status === 'NORMALIZED' && stat.hostCount === 2 && stat.findingCount === 3 && stat.rawSha256 === expectedSha && stat.rawBytes === body1.length && stat.exporterName === 'pbc-wazuh-exporter' && stat.exporterVersion === '1.0.0' && stat.collectedAt === '2026-10-18T12:00:00.000Z' && Boolean(stat.sourceId) && Boolean(stat.receivedAt), 'run fields: status, counts, sha, bytes, exporter, collectedAt', stat);
  assert(stat.startedAt !== null && stat.finishedAt !== null && stat.error === null && stat.warning === null, 'the worker normalized the run: startedAt and finishedAt set, no error, no warning (T64)', stat);
  assert(!('rawPath' in stat) && !JSON.stringify(runs).includes(VM_TEST_VAULT), 'the runs list does not expose rawPath or the vault location');
  const sources = (await call('GET', `/tenants/${A}/vm/sources`, ownerA, A)).body as Json;
  const src = (sources.sources as Json[]).find((s) => s.label === 'wazuh-main') as Json;
  assert(sources.tenantId === A && sources.totalCount === 1 && src?.kind === 'WAZUH' && src.lastRunId === ok.body?.run_id && src.enabled === true, 'the sources list shows the source with its last run', sources);
  const used = (await listTokens(ownerA, A)).find((t) => t.id === tokenARecord.id);
  assert(Boolean(used?.lastUsedAt), 'lastUsedAt is set after the first ingest', used);
  assert((await call('GET', `/tenants/${A}/vm/runs?limit=1`, ownerA, A)).body?.runs.length === 1, '?limit=1 returns one run');
  assert((await call('GET', `/tenants/${A}/vm/runs?limit=0`, ownerA, A)).status === 400 && (await call('GET', `/tenants/${A}/vm/runs?limit=501`, ownerA, A)).status === 400, '?limit outside 1..500 -> 400');
  assert((await call('GET', `/tenants/${A}/vm/runs`, viewer, A)).status === 200 && (await call('GET', `/tenants/${A}/vm/sources`, viewer, A)).status === 200, 'a VIEWER can read runs and sources (200)');

  console.log('\n--- Worker: findings and assets after the first run (tenant A) ---');
  const happyFindings = ((await call('GET', `/tenants/${A}/vm/findings`, ownerA, A)).body ?? {}) as Json;
  const hf = (happyFindings.findings ?? []) as Json[];
  assert(happyFindings.tenantId === A && happyFindings.totalCount === 3 && hf.length === 3, 'the first run yields three findings (two hosts: 2 + 1)', happyFindings);
  assert(hf.every((f) => f.status === 'OPEN' && Boolean(f.slaDueAt) && f.tenantId === A), 'each finding is OPEN with an SLA deadline');
  assert(hf.filter((f) => f.vulnId === 'CVE-2024-0001' && f.severity === 'HIGH').length === 2 && hf.filter((f) => f.vulnId === 'CVE-2024-0002' && f.severity === 'LOW').length === 1, 'two HIGH CVE-2024-0001 findings and one LOW CVE-2024-0002 finding', hf.map((f) => [f.vulnId, f.severity]));
  const days = (f: Json) => (Date.parse(f.slaDueAt) - Date.parse(f.firstSeenAt)) / 86_400_000;
  assert(hf.every((f) => days(f) === (f.severity === 'HIGH' ? 30 : 180)), 'default SLA: HIGH 30 days, LOW 180 days after first sight', hf.map((f) => [f.severity, days(f)]));
  assert(hf[0].severity === 'HIGH' && hf[2].severity === 'LOW', 'findings are listed most severe first', hf.map((f) => f.severity));
  assert(new Set(hf.map((f) => f.assetId)).size === 2, 'the findings belong to two assets');
  const agentAssets = (((await call('GET', `/tenants/${A}/assets`, ownerA, A)).body?.assets ?? []) as Json[]).filter((a) => a.hostName === 'host-001' || a.hostName === 'host-002');
  assert(agentAssets.length === 2 && agentAssets.every((a) => a.sourceOrigin === 'AGENT_REPORT' && a.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && a.cmmcAssetCategory === 'CONTRACTOR_RISK'), 'the agent hosts exist as AGENT_REPORT / UNCONFIRMED_DISCOVERY / CONTRACTOR_RISK assets (T50)', agentAssets);
  assert(hf.every((f) => agentAssets.some((a) => a.id === f.assetId)), 'every finding points at one of those assets');

  console.log('\n--- Ingest: duplicates, variants, labels, kinds, tenants ---');
  const dup = await ingest(tokenA, body1);
  assert(dup.status === 200 && dup.body?.duplicate === true && dup.body?.run_id === ok.body?.run_id && dup.body?.sha256 === expectedSha, 'the same bytes again -> 200 duplicate with the original run id', dup.body);
  assert(runFiles(A).length === filesBefore + 1, 'a duplicate stores no file');
  const spaced = await ingest(tokenA, Buffer.from(JSON.stringify(payloadOf({ label: 'wazuh-main' }), null, 2)));
  assert(spaced.status === 202 && spaced.body?.run_id !== ok.body?.run_id, 'the same content with different whitespace is a new run (202)', spaced.body);
  const upper = await ingest(tokenA, bytesOf({ label: 'WAZUH-MAIN', agents: ['009'] }));
  const srcAfter = ((await call('GET', `/tenants/${A}/vm/sources`, ownerA, A)).body?.sources ?? []) as Json[];
  assert(upper.status === 202 && srcAfter.length === 1 && srcAfter[0].lastRunId === upper.body?.run_id, 'a label differing only in case reuses the source', srcAfter);
  const filesPreMismatch = runFiles(A).length;
  const mismatch = await ingest(tokenA, bytesOf({ label: 'wazuh-main', kind: 'NMAP', agents: ['010'] }));
  assert(mismatch.status === 409 && mismatch.body?.error === 'vm_source_kind_mismatch', 'the same label with another kind -> 409 vm_source_kind_mismatch', mismatch.body);
  assert(runFiles(A).length === filesPreMismatch, 'a kind mismatch leaves no file behind');
  const tokenB = (await createToken(ownerB, B, { name: 'b-ingest' })).body?.token as string;
  const bRun = await ingest(tokenB, body1);
  assert(bRun.status === 202 && bRun.body?.sha256 === expectedSha && bRun.body?.run_id !== ok.body?.run_id, 'tenant B can ingest the same bytes (202, its own run)', bRun.body);
  assert(fs.existsSync(path.join(VM_TEST_VAULT, 'tenants', B, 'vm', 'runs', `${bRun.body?.run_id}.json`)), "and its file lives under tenant B's directory");

  console.log('\n--- Concurrency ---');
  const raceBytes = bytesOf({ label: 'race-src', agents: ['r1'] });
  const filesPreRace = runFiles(A).length;
  resetLimiters();
  const race = await Promise.all([1, 2, 3, 4, 5].map(() => ingestRaw(tokenA, raceBytes, { 'Content-Type': 'application/json' }, true)));
  const codes = race.map((r) => r.status).sort();
  assert(codes.filter((c) => c === 202).length === 1 && codes.filter((c) => c === 200).length === 4, 'five concurrent identical new bodies: one 202, four 200', codes);
  assert(new Set(race.map((r) => r.body?.run_id)).size === 1, 'all five answers name the same run');
  assert(runFiles(A).length === filesPreRace + 1, 'exactly one new file (losers remove theirs)', runFiles(A).length - filesPreRace);

  console.log('\n--- Ingest: 400 table ---');
  const filesPre400 = runFiles(A).length;
  const noHosts = payloadOf(); delete noHosts.hosts;
  const dupAgent = payloadOf({ agents: ['x', 'x'] });
  const cases: Array<[string, Buffer, string | RegExp]> = [
    ['not JSON', Buffer.from('{not json'), '$: body is not valid JSON'],
    ['hosts missing', Buffer.from(JSON.stringify(noHosts)), /^\$\.hosts: /],
    ['an unknown field', Buffer.from(JSON.stringify(payloadOf({ extra: { extra: 1 } }))), '$.extra: unknown field'],
    ['an unknown kind', Buffer.from(JSON.stringify(payloadOf({ kind: 'QUALYS' }))), /^\$\.source\.kind: /],
    ['an unknown severity', Buffer.from(JSON.stringify({ ...payloadOf(), hosts: [{ agent_id: 'a', findings: [{ vuln_id: 'CVE-2024-0001', severity: 'SEVERE' }] }] })), /^\$\.hosts\[0\]\.findings\[0\]\.severity: /],
    ['a duplicate agent_id', Buffer.from(JSON.stringify(dupAgent)), '$.hosts[1].agent_id: duplicate agent_id (also at $.hosts[0])'],
    ['a JSON array root', Buffer.from('[]'), /^\$: /],
  ];
  for (const [label, bytes, expected] of cases) {
    const r = await ingest(tokenA, bytes);
    const message = String(r.body?.error);
    assert(r.status === 400 && (typeof expected === 'string' ? message === expected : expected.test(message)), `${label} -> 400`, r.body);
  }
  const empty = await ingestRaw(tokenA, Buffer.alloc(0));
  assert(empty.status === 400 && empty.body?.error === '$: request body is required', 'an empty body -> 400 $: request body is required', empty.body);
  assert(runFiles(A).length === filesPre400, 'no 400 case leaves a file behind');

  console.log('\n--- Ingest: size, media type, storage ---');
  const big = Buffer.alloc(300_000, 0x20);
  const tooBig = await ingest(tokenA, big);
  assert(tooBig.status === 413 && tooBig.body?.error === 'payload_too_large', 'a 300 000 byte body (limit 262 144) -> 413 payload_too_large', tooBig.body);
  const bigNoToken = await ingest(null, big);
  assert(bigNoToken.status === 401, 'the same body without a token -> 401 (the token is checked before the body is read)', bigNoToken.body);
  const plain = await ingestRaw(tokenA, bytesOf(), { 'Content-Type': 'text/plain' });
  assert(plain.status === 415, 'text/plain -> 415', plain.body);
  const noType = await ingestRaw(tokenA, bytesOf(), {});
  assert(noType.status === 415, 'no content type -> 415', noType.body);
  const gz = await ingestRaw(tokenA, bytesOf({ label: 'gz-src' }), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  assert(gz.status === 415 && gz.body?.error === 'unsupported_content_encoding', 'Content-Encoding: gzip -> 415 unsupported_content_encoding', gz.body);
  process.env.STORAGE_PROVIDER = 'gcs';
  const noStore = await ingest(tokenA, bytesOf({ label: 'gcs-src', agents: ['g1'] }));
  process.env.STORAGE_PROVIDER = 'local';
  assert(noStore.status === 503 && noStore.body?.error === 'vm_requires_local_storage', 'a non-local STORAGE_PROVIDER at runtime (gcs) -> 503 vm_requires_local_storage', noStore.body);
  const afterGcs = await ingest(tokenA, bytesOf({ label: 'gcs-src', agents: ['g1'] }));
  assert(afterGcs.status === 202, 'and local storage works again afterwards (202)', afterGcs.body);

  console.log('\n--- Cross-tenant reads ---');
  const bRuns = ((await call('GET', `/tenants/${B}/vm/runs`, ownerB, B)).body?.runs ?? []) as Json[];
  const bSources = ((await call('GET', `/tenants/${B}/vm/sources`, ownerB, B)).body?.sources ?? []) as Json[];
  assert(bRuns.length === 1 && bRuns[0].id === bRun.body?.run_id && bRuns.every((r) => r.tenantId === B), "tenant B sees only its own run", bRuns.map((r) => r.id));
  assert(bSources.length === 1 && bSources[0].tenantId === B, 'tenant B sees only its own source', bSources);
  assert((await call('GET', `/tenants/${A}/vm/runs`, ownerB, B)).status === 403 && (await call('GET', `/tenants/${A}/vm/sources`, ownerB, B)).status === 403, "tenant B's owner cannot read tenant A's runs or sources (403)");
  assert((await call('GET', `/tenants/${A}/vm/runs`, ownerB, A)).status === 403, 'even with x-tenant-id set to A (403)');

  console.log('\n--- Worker: other agents, closure, re-sighting, filters (tenant A) ---');
  await __drainVmWorkerForTests();
  const findingsOf = async (tenant: string, who: string, query = '') => ((await call('GET', `/tenants/${tenant}/vm/findings${query}`, who, tenant)).body?.findings ?? []) as Json[];
  const assetIdByName = async (name: string) => ((((await call('GET', `/tenants/${A}/assets`, ownerA, A)).body?.assets ?? []) as Json[]).find((a) => a.hostName === name)?.id ?? '') as string;
  const runById = async (id: string) => ((((await call('GET', `/tenants/${A}/vm/runs`, ownerA, A)).body?.runs ?? []) as Json[]).find((r) => r.id === id) ?? {}) as Json;
  const host1 = await assetIdByName('host-001');
  const host2 = await assetIdByName('host-002');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const afterUpper = await findingsOf(A, ownerA, `?assetId=${host1}`);
  assert(afterUpper.length === 2 && afterUpper.every((f) => f.status === 'OPEN'), "a run of the same source that reports another host (009) leaves host-001's findings OPEN (T11)", afterUpper);
  assert((await findingsOf(A, ownerA, `?assetId=${await assetIdByName('host-009')}`)).length === 2, 'the other agent produced its own two findings');
  const firstSeenBefore = new Map(afterUpper.map((f) => [f.vulnId, f.firstSeenAt as string]));

  const closureRun = await ingest(tokenA, Buffer.from(JSON.stringify({
    ...payloadOf({ label: 'wazuh-main' }),
    collected_at: '2026-10-19T12:00:00Z',
    hosts: [
      { agent_id: '001', hostname: 'host-001', findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }] },
      { agent_id: '002', hostname: 'host-002', findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }] },
    ],
  })));
  assert(closureRun.status === 202, 'a run that omits CVE-2024-0002 on host-001 is accepted (202)', closureRun.body);
  await __drainVmWorkerForTests();
  const closed = await findingsOf(A, ownerA, `?assetId=${host1}`);
  const omitted = closed.find((f) => f.vulnId === 'CVE-2024-0002') as Json;
  assert(omitted?.status === 'RESOLVED' && omitted.resolvedRunId === closureRun.body?.run_id && Boolean(omitted.resolvedAt), 'the omitted finding is RESOLVED by that run (T10)', omitted);
  assert(closed.find((f) => f.vulnId === 'CVE-2024-0001')?.status === 'OPEN', 'the other finding on that host stays OPEN');
  assert((await findingsOf(A, ownerA, `?assetId=${host2}`)).every((f) => f.status === 'OPEN'), "the other host's finding stays OPEN (T11)");
  assert((await findingsOf(A, ownerA, `?assetId=${await assetIdByName('host-009')}`)).every((f) => f.status === 'OPEN'), "a host the run did not report keeps its findings OPEN (T11)");

  const resolvedOnly = await findingsOf(A, ownerA, '?status=RESOLVED');
  assert(resolvedOnly.length === 1 && resolvedOnly.every((f) => f.status === 'RESOLVED'), '?status=RESOLVED returns only the resolved finding', resolvedOnly);
  const lowOnly = await findingsOf(A, ownerA, '?severity=LOW');
  assert(lowOnly.length >= 2 && lowOnly.every((f) => f.severity === 'LOW'), '?severity=LOW returns only LOW findings', lowOnly.map((f) => f.severity));
  assert((await findingsOf(A, ownerA, '?limit=1')).length === 1, '?limit=1 returns one finding');
  const badQueries: Array<[string, string]> = [['severity=SEVERE', 'an unknown severity'], ['status=GONE', 'an unknown status'], ['limit=0', 'limit 0'], ['limit=1001', 'limit 1001'], ['limit=abc', 'a non-numeric limit'], ['assetId=a.b', 'an assetId with characters outside the pattern']];
  for (const [q, label] of badQueries) {
    assert((await call('GET', `/tenants/${A}/vm/findings?${q}`, ownerA, A)).status === 400, `${label} -> 400`);
  }

  await sleep(10);
  const resight = await ingest(tokenA, Buffer.from(JSON.stringify({ ...payloadOf({ label: 'wazuh-main' }), collected_at: '2026-10-20T12:00:00Z' })));
  assert(resight.status === 202, 'a run that reports the omitted CVE again is accepted (202)', resight.body);
  await __drainVmWorkerForTests();
  const reopened = (await findingsOf(A, ownerA, `?assetId=${host1}`)).find((f) => f.vulnId === 'CVE-2024-0002') as Json;
  assert(reopened?.status === 'OPEN' && reopened.resolvedAt === null && reopened.resolvedRunId === null, 're-sighting reopens the finding (T17)', reopened);
  assert(Date.parse(reopened.firstSeenAt) > Date.parse(firstSeenBefore.get('CVE-2024-0002') as string), 'and restarts its clock (first_seen_at is later)', [reopened.firstSeenAt, firstSeenBefore.get('CVE-2024-0002')]);
  assert((await findingsOf(A, ownerA, '?status=RESOLVED')).length === 0, 'no finding is resolved afterwards');

  console.log('\n--- Worker: findings access ---');
  assert((await call('GET', `/tenants/${A}/vm/findings`, viewer, A)).status === 200 && (await call('GET', `/tenants/${A}/vm/findings`, assessor, A)).status === 200, 'a VIEWER and an ASSESSOR can read findings (200)');
  assert((await call('GET', `/tenants/${A}/vm/findings`, ownerB, B)).status === 403 && (await call('GET', `/tenants/${A}/vm/findings`, ownerB, A)).status === 403, "tenant B's owner cannot read tenant A's findings (403)");
  assert((await call('GET', `/tenants/${A}/vm/findings`, null, A)).status === 401, 'no session => 401');
  const bFindings = await findingsOf(B, ownerB);
  assert(bFindings.length === 3 && bFindings.every((f) => f.tenantId === B) && !bFindings.some((f) => hf.some((h) => h.id === f.id)), "tenant B's list holds only its own three findings", bFindings.length);

  console.log('\n--- Worker: failures, terminal runs, reprocess ---');
  const runsDir = path.join(VM_TEST_VAULT, 'tenants', A, 'vm', 'runs');
  const receivedInput = (label: string, rawPath: string, rawSha256: string, rawBytes = 0) => ({ id: crypto.randomUUID(), kind: 'WAZUH' as const, label, collectedAt: null, exporterName: 'x', exporterVersion: '1', hostCount: 0, findingCount: 0, rawPath, rawSha256, rawBytes });

  const missing = await recordReceivedRun(A, receivedInput('fail-src', path.join(runsDir, 'missing.json'), 'a'.repeat(64)));
  enqueueVmRun(A, missing.run.id);
  await __drainVmWorkerForTests();
  const missingRun = await runById(missing.run.id);
  assert(missingRun.status === 'FAILED' && missingRun.error === 'The stored payload could not be read.' && missingRun.finishedAt !== null, 'a missing stored payload -> FAILED "The stored payload could not be read." (T65)', missingRun);

  fs.mkdirSync(runsDir, { recursive: true });
  const badSumId = crypto.randomUUID();
  const badSumFile = path.join(runsDir, `${badSumId}.json`);
  fs.writeFileSync(badSumFile, bytesOf({ label: 'sum-src', agents: ['q1'] }));
  const badSum = await recordReceivedRun(A, { ...receivedInput('sum-src', badSumFile, '0'.repeat(64)), id: badSumId });
  enqueueVmRun(A, badSum.run.id);
  await __drainVmWorkerForTests();
  const badSumRun = await runById(badSumId);
  assert(badSumRun.status === 'FAILED' && badSumRun.error === 'The stored payload does not match its recorded checksum.', 'a checksum mismatch -> FAILED with the checksum message (T66)', badSumRun);

  const invalidBytes = Buffer.from('{"schema_version":1}');
  const invalidId = crypto.randomUUID();
  const invalidFile = path.join(runsDir, `${invalidId}.json`);
  fs.writeFileSync(invalidFile, invalidBytes);
  await recordReceivedRun(A, { ...receivedInput('invalid-src', invalidFile, crypto.createHash('sha256').update(invalidBytes).digest('hex'), invalidBytes.length), id: invalidId });
  enqueueVmRun(A, invalidId);
  await __drainVmWorkerForTests();
  const invalidRun = await runById(invalidId);
  assert(invalidRun.status === 'FAILED' && String(invalidRun.error).startsWith('$.'), 'a stored payload that fails validation -> FAILED with the "$." message (T67)', invalidRun);

  const outsideId = crypto.randomUUID();
  const outsideFile = path.join(VM_TEST_VAULT, `${outsideId}.json`);
  fs.writeFileSync(outsideFile, bytesOf({ label: 'outside-src', agents: ['o1'] }));
  const outside = await recordReceivedRun(A, { ...receivedInput('outside-src', outsideFile, crypto.createHash('sha256').update(fs.readFileSync(outsideFile)).digest('hex')), id: outsideId });
  enqueueVmRun(A, outside.run.id);
  await __drainVmWorkerForTests();
  const outsideRun = await runById(outsideId);
  assert(outsideRun.status === 'FAILED' && outsideRun.error === 'The stored payload could not be read.', 'a recorded path outside the tenant directory is not read (FAILED unreadable)', outsideRun);

  const s1 = await ingest(tokenA, bytesOf({ label: 's1-src', kind: 'SENTINELONE', agents: ['s1'] }));
  await __drainVmWorkerForTests();
  const s1Run = await runById(s1.body?.run_id);
  assert(s1.status === 202 && s1Run.status === 'FAILED' && s1Run.error === 'No normalizer for SENTINELONE yet.', 'a kind without an adapter -> FAILED "No normalizer for SENTINELONE yet." (T68)', s1Run);

  const happyId = ok.body?.run_id as string;
  const happyBefore = await runById(happyId);
  assert(happyBefore.status === 'NORMALIZED', 'the first run is NORMALIZED', happyBefore);
  enqueueVmRun(A, happyId);
  await __drainVmWorkerForTests();
  const happyAfter = await runById(happyId);
  assert(happyAfter.status === 'NORMALIZED' && happyAfter.finishedAt === happyBefore.finishedAt, 'enqueueing a finished run is a no-op (finishedAt unchanged) (T71)', [happyBefore.finishedAt, happyAfter.finishedAt]);

  const beforeReprocess = await findingsOf(A, ownerA);
  await sleep(10);
  const re1 = await call('POST', `/tenants/${A}/vm/runs/${happyId}/reprocess`, ownerA, A);
  assert(re1.status === 202 && re1.body?.run_id === happyId && re1.body?.status === 'RECEIVED', 'the owner reprocesses a run (202 RECEIVED)', re1.body);
  await __drainVmWorkerForTests();
  const afterReprocess = await findingsOf(A, ownerA);
  const reRun = await runById(happyId);
  assert(reRun.status === 'NORMALIZED' && reRun.error === null && reRun.finishedAt !== happyBefore.finishedAt, 'the run is NORMALIZED again with a new finishedAt', reRun);
  assert(afterReprocess.length === beforeReprocess.length && afterReprocess.every((f) => beforeReprocess.find((b) => b.id === f.id)?.firstSeenAt === f.firstSeenAt), 'reprocessing is idempotent: same findings, same first_seen_at', [beforeReprocess.length, afterReprocess.length]);
  assert((await call('POST', `/tenants/${A}/vm/runs/${happyId}/reprocess`, viewer, A)).status === 403 && (await call('POST', `/tenants/${A}/vm/runs/${happyId}/reprocess`, assessor, A)).status === 403, 'a VIEWER and an ASSESSOR cannot reprocess (403)');
  assert((await call('POST', `/tenants/${A}/vm/runs/${happyId}/reprocess`, ownerB, B)).status === 403, "another tenant's owner cannot reprocess (403)");
  assert((await call('POST', `/tenants/${A}/vm/runs/no-such-run/reprocess`, ownerA, A)).status === 404 && (await call('POST', `/tenants/${A}/vm/runs/a.b/reprocess`, ownerA, A)).status === 404, 'an unknown or malformed run id -> 404');
  assert((await call('POST', `/tenants/${B}/vm/runs/${happyId}/reprocess`, ownerB, B)).status === 404, "a run of another tenant -> 404");
  const re2 = await call('POST', `/tenants/${A}/vm/runs/${s1.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const s1Again = await runById(s1.body?.run_id);
  assert(re2.status === 202 && s1Again.status === 'FAILED' && s1Again.error === 'No normalizer for SENTINELONE yet.', 'reprocessing the SENTINELONE run -> 202 and FAILED again with the same message', [re2.body, s1Again]);

  console.log('\n--- Worker: fault after save (in memory there is no rollback) ---');
  __setVmWorkerFaultForTests('after_save');
  const faulty = await ingest(tokenA, bytesOf({ label: 'fault-src', agents: ['f1'] }));
  await __drainVmWorkerForTests();
  __setVmWorkerFaultForTests(null);
  const faultyRun = await runById(faulty.body?.run_id);
  assert(faulty.status === 202 && faultyRun.status === 'FAILED' && faultyRun.error === 'Normalization failed unexpectedly. Check the server log.', 'a failure part-way -> FAILED with the generic message', faultyRun);
  assert(!JSON.stringify(faultyRun).includes('host-f1') && !JSON.stringify(faultyRun).includes('fault injected'), 'the run error carries no payload value and no internal message');
  // The in-memory store has no transactions: what was saved before the fault stays (PostgreSQL rolls it back: scripts/verifyVmLive.ts).
  const faultAsset = await assetIdByName('host-f1');
  assert(Boolean(faultAsset) && (await findingsOf(A, ownerA, `?assetId=${faultAsset}`)).length === 2, 'in memory mode the findings saved before the fault remain');
  const re3 = await call('POST', `/tenants/${A}/vm/runs/${faulty.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const faultyAgain = await runById(faulty.body?.run_id);
  assert(re3.status === 202 && faultyAgain.status === 'NORMALIZED' && faultyAgain.error === null, 'after clearing the fault, reprocessing the run -> NORMALIZED', faultyAgain);
  assert((await findingsOf(A, ownerA, `?assetId=${faultAsset}`)).length === 2, 'and adds no duplicate findings');

  console.log('\n--- Rate limiting (unauthenticated ingest) ---');
  resetLimiters();
  const limited: number[] = [];
  for (let i = 0; i < 31; i++) limited.push((await ingestRaw(null, bytesOf(), { 'Content-Type': 'application/json' }, true)).status);
  assert(limited.slice(0, 30).every((s) => s === 401) && limited[30] === 429, 'the 31st unauthenticated ingest from one address -> 429 (first 30 -> 401)', limited);
  resetLimiters();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
