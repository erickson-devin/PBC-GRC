import './testEnv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { server } from '../server/index';

/**
 * Boundary asset membership over HTTP (issue #26): which assets of the tenant's inventory a program declares inside its boundary.
 * GET/PATCH /programs/:id/assets and GET /programs/asset-memberships: delta semantics, validation, tenant isolation (no oracle), the
 * archive rule, the history event (ids only, never a host name), the cascade of an asset or program delete, and that the inventory and
 * the VM pipeline stay tenant-wide. Runs against the in-memory store. Boots the server on port 8080: run it alone.
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
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

const HOST = 'MEMBER-HOST-1';

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_pa_owner@test.mil,u_pa_rival@test.mil';
  const owner = person('u_pa_owner');
  const rival = person('u_pa_rival');
  const viewer = person('u_pa_viewer');

  // M14: every console line written while the suite runs is kept, to prove none carries a host name
  const captured: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const capture = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
  console.log = capture(origLog);
  console.error = capture(origError);

  console.log('--- Setup: a tenant with two assets and a second program; a rival tenant with one asset ---');
  const mk = async (token: string, name: string) =>
    (await call('POST', '/tenants', token, undefined, { name, primaryFramework: 'CMMC_L1', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  const T = await mk(owner, 'Assets T');
  const R = await mk(rival, 'Assets R');
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_pa_viewer', email: 'u_pa_viewer@test.mil', role: 'VIEWER' });
  const a1 = (await call('POST', `/tenants/${T}/assets`, owner, T, { hostName: HOST, cmmcAssetCategory: 'CUI_ASSET' })).body?.asset?.id as string;
  const a2 = (await call('POST', `/tenants/${T}/assets`, owner, T, { hostName: 'member-host-2', cmmcAssetCategory: 'SECURITY_PROTECTION' })).body?.asset?.id as string;
  const r1 = (await call('POST', `/tenants/${R}/assets`, rival, R, { hostName: 'rival-host-1', cmmcAssetCategory: 'CUI_ASSET' })).body?.asset?.id as string;
  const progs = await call('GET', `/tenants/${T}/programs`, owner, T);
  const DEF = progs.body?.programs?.find((p: Json) => p.isDefault)?.id as string;
  const P2 = (await call('POST', `/tenants/${T}/programs`, owner, T, { name: 'Second boundary', frameworkId: 'CMMC_L1' })).body?.program?.id as string;
  const RP = (await call('GET', `/tenants/${R}/programs`, rival, R)).body?.programs?.[0]?.id as string;
  assert(Boolean(T && R && a1 && a2 && r1 && DEF && P2 && RP), 'setup: tenants, assets and programs exist', { T, R, a1, a2, r1, DEF, P2, RP });
  const assetsUrl = (tenant: string, program: string) => `/tenants/${tenant}/programs/${program}/assets`;

  const m1 = await call('GET', assetsUrl(T, DEF), owner, T);
  assert(m1.status === 200 && m1.body?.declared === false && m1.body.assetIds.length === 0 && m1.body.summary?.total === 2 && m1.body.programId === DEF, 'M1 a program with no declared assets: declared false, no ids, summary covers the whole inventory (2)', m1.body);

  const m2 = await call('PATCH', assetsUrl(T, P2), owner, T, { add: [a1] });
  const m2Get = await call('GET', assetsUrl(T, P2), owner, T);
  assert(
    m2.status === 200 && m2.body?.declared === true && m2.body.added === 1 && m2.body.removed === 0 && JSON.stringify(m2.body.assetIds) === JSON.stringify([a1]) && m2Get.body?.summary?.inScope === 1 && m2Get.body.summary.total === 1,
    'M2 PATCH add [a1] -> declared, added 1; GET summary counts only the member (inScope 1)',
    [m2.body, m2Get.body]
  );

  const eventsOf = async (program: string) => ((await call('GET', `/tenants/${T}/programs/${program}/events`, owner, T)).body?.events ?? []) as Json[];
  const before = (await eventsOf(P2)).length;
  const m3 = await call('PATCH', assetsUrl(T, P2), owner, T, { add: [a1] });
  assert(m3.status === 200 && m3.body?.added === 0 && m3.body.assetIds.length === 1 && (await eventsOf(P2)).length === before, 'M3 the same PATCH again: added 0 and no new event', m3.body);

  const m4 = await call('PATCH', assetsUrl(T, P2), owner, T, { add: ['nope'] });
  const m4Get = await call('GET', assetsUrl(T, P2), owner, T);
  assert(m4.status === 400 && m4.body?.code === 'unknown_assets' && m4.body.count === 1 && m4Get.body?.assetIds?.length === 1, 'M4 an unknown id -> 400 unknown_assets with count 1; membership unchanged', [m4.body, m4Get.body]);

  const m5 = await call('PATCH', assetsUrl(T, P2), owner, T, { add: [r1] });
  assert(m5.status === 400 && m5.body?.code === 'unknown_assets', "M5 another tenant's asset id looks like an unknown one (400 unknown_assets)", m5.body);

  const bad = async (body: unknown) => (await call('PATCH', assetsUrl(T, P2), owner, T, body)).body?.code;
  const codes = [
    await bad({ add: a1 }),
    await bad({ add: ['bad id!'] }),
    await bad({}),
    await bad({ add: [a1], remove: [a1] }),
    await bad({ add: Array.from({ length: 5001 }, (_, i) => `x${i}`) }),
  ];
  assert(codes.every((c) => c === 'invalid_asset_ids'), 'M6 a non-array, a malformed id, an empty body, an id in both lists and 5001 ids are each 400 invalid_asset_ids', codes);

  const m7Patch = await call('PATCH', assetsUrl(T, P2), viewer, T, { add: [a2] });
  const m7Get = await call('GET', assetsUrl(T, P2), viewer, T);
  assert(m7Patch.status === 403 && m7Get.status === 200 && m7Get.body?.assetIds?.length === 1, 'M7 a VIEWER cannot change the assets (403) but can read them (200)', [m7Patch.status, m7Get.status]);

  const m12 = await call('PATCH', assetsUrl(T, P2), owner, T, { remove: [a2] });
  assert(m12.status === 200 && m12.body?.removed === 0 && m12.body.assetIds.length === 1, 'M12 removing a non-member changes nothing (removed 0)', m12.body);

  const m15 = await call('GET', `/tenants/${T}/assets`, owner, T);
  assert(m15.status === 200 && m15.body?.assets?.length === 2, 'M15 the inventory stays tenant-wide: GET /assets still lists both assets', m15.body?.assets?.length);

  const m13 = await eventsOf(P2);
  assert(m13.some((e) => e.kind === 'assets_changed' && e.newValue?.added === 1) && !JSON.stringify(m13).includes(HOST), 'M13 the history has an assets_changed event, and no host name in it', m13.map((e) => e.kind));

  const m10 = await call('GET', `/tenants/${T}/programs/asset-memberships`, owner, T);
  const all = await call('GET', `/tenants/${T}/programs?includeArchived=true`, owner, T);
  const mem = (m10.body?.memberships ?? []) as Json[];
  const p2Mem = mem.find((m) => m.programId === P2);
  assert(
    m10.status === 200 && mem.length === all.body?.totalCount && mem[0]?.programId === DEF && p2Mem?.archived === false && JSON.stringify(p2Mem?.assetIds) === JSON.stringify([a1]),
    'M10 asset-memberships: every program, the default first, p2 with [a1] and its archived flag',
    m10.body
  );

  const m9a = await call('GET', assetsUrl(T, 'no-such-program'), owner, T);
  const m9b = await call('GET', assetsUrl(T, RP), owner, T);
  const m9c = await call('PATCH', assetsUrl(T, RP), owner, T, { add: [a1] });
  assert(m9a.status === 404 && m9a.body?.code === 'program_not_found' && m9b.status === 404 && m9c.status === 404 && m9c.body?.code === 'program_not_found', "M9 an unknown program and another tenant's program are both 404 program_not_found", [m9a.status, m9b.status, m9c.status]);

  const m8Arch = await call('POST', `/tenants/${T}/programs/${P2}/archive`, owner, T);
  const m8 = await call('PATCH', assetsUrl(T, P2), owner, T, { add: [a2] });
  const m8Get = await call('GET', assetsUrl(T, P2), owner, T);
  const m8Mem = ((await call('GET', `/tenants/${T}/programs/asset-memberships`, owner, T)).body?.memberships ?? []) as Json[];
  assert(
    m8Arch.status === 200 && m8.status === 409 && m8.body?.code === 'program_archived' && m8Get.status === 200 && m8Get.body?.assetIds?.length === 1 && m8Mem.find((m) => m.programId === P2)?.archived === true,
    'M8 an archived program: PATCH 409 program_archived; GET 200; asset-memberships flags it archived',
    [m8.status, m8.body, m8Get.status]
  );
  await call('POST', `/tenants/${T}/programs/${P2}/unarchive`, owner, T);

  const m11Del = await call('DELETE', `/tenants/${T}/assets/${a1}`, owner, T);
  const m11 = await call('GET', assetsUrl(T, P2), owner, T);
  assert(m11Del.status === 200 && m11.status === 200 && m11.body?.assetIds?.length === 0 && m11.body.declared === false, 'M11 deleting an asset removes it from every boundary (declared false again)', [m11Del.status, m11.body]);

  const P3 = (await call('POST', `/tenants/${T}/programs`, owner, T, { name: 'Third boundary', frameworkId: 'CMMC_L1' })).body?.program?.id as string;
  const m17Add = await call('PATCH', assetsUrl(T, P3), owner, T, { add: [a2] });
  const m17Del = await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T);
  const m17Mem = ((await call('GET', `/tenants/${T}/programs/asset-memberships`, owner, T)).body?.memberships ?? []) as Json[];
  assert(m17Add.status === 200 && m17Del.status === 204 && !m17Mem.some((m) => m.programId === P3), 'M17 a program with members can be deleted (204) and then leaves the memberships', [m17Add.status, m17Del.status]);

  console.log = origLog;
  console.error = origError;
  assert(captured.length > 0 && !captured.some((l) => l.includes(HOST)), 'M14 no console line written during the suite contains the host name', captured.filter((l) => l.includes(HOST)));

  const vmSources = ['snapshotWriter.ts', 'worker.ts', 'findingsStore.ts'].map((f) => readFileSync(join(process.cwd(), 'server', 'vm', f), 'utf8'));
  assert(vmSources.every((s) => !/programAssets/.test(s)), 'M16 the VM pipeline (snapshot writer, worker, findings store) does not use membership: it stays tenant-wide');

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
