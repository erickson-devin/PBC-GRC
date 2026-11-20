import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import { server } from '../server/index';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { __drainVmWorkerForTests } from '../server/vm/worker';
import { getDefaultRemediationPolicy, listDecisionStates, requestDecision } from '../server/vm/remediationStore';
import { firstProgram } from './programFixture';
import { VM_KEV_RULE_TEXT, computeRemediationTier } from '../src/data/vmRemediation';
import type { VmRemediationPolicy } from '../src/data/vmRemediation';

/**
 * Vulnerability remediation policy and risk decisions (#268) over HTTP: the editable timelines (GET / PUT /vm/remediation-policy, its history, the
 * summary), the tier on every finding and POA&M row, which overdue findings get a POA&M draft, and the two-person risk decisions (request, approve,
 * reject, withdraw, revoke). Role, tenant and stale-write rules, the derived states (time is injected, never waited for), and that no justification,
 * CVE id or host name reaches the console, an event or the evidence snapshot. Runs against the in-memory store with a throw-away vault (see ./vmEnv).
 * Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const DAY = 86_400_000;

// Everything written to the console from here on is kept, so that the log-hygiene cases can read it back; the assertions print through the originals.
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
const captured: string[] = [];
const keep = (...args: unknown[]) => { captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
console.log = keep;
console.warn = keep;
console.error = keep;

let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    rawLog(`  ✓ PASS: ${name}`);
  } else {
    rawError(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const say = (s: string) => rawLog(s);

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
/** A caller whose role in `tenant` comes from the token (how an MSP Admin is represented in these suites). */
const claimed = (sub: string, role: string, tenant: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });

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

async function ingest(token: string, payload: unknown) {
  vmIngestRateLimiter.reset();
  vmTokenRateLimiter.reset();
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: { ...HTTPS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: Buffer.from(JSON.stringify(payload)) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: string[]) => [...xs].sort();
const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

async function shutdown(code: number) {
  process.exitCode = code;
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

const DEF: VmRemediationPolicy = { slaDays: { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 }, warnOnly: ['MEDIUM', 'LOW'], graceDays: 0 };
const withDays = (low: number, over: Partial<VmRemediationPolicy> = {}): VmRemediationPolicy => ({ ...DEF, slaDays: { ...DEF.slaDays, LOW: low }, ...over });

// The fixture the cases share: one host with one finding of each severity, all first seen in 2020 (so every one is overdue under any sane policy).
const SECRET_HOST = 'host-rem-secret';
const JUSTIFICATION = 'Compensating control SECRET-JUSTIFICATION-TEXT is in place';
const CVE = { CRITICAL: 'CVE-2024-2001', HIGH: 'CVE-2024-2002', MEDIUM: 'CVE-2024-2003', LOW: 'CVE-2024-2004' } as const;

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  for (const k of ['VM_WARN_ONLY_SEVERITIES', 'VM_GRACE_DAYS', 'VM_SLA_DAYS_CRITICAL', 'VM_SLA_DAYS_HIGH', 'VM_SLA_DAYS_MEDIUM', 'VM_SLA_DAYS_LOW', 'VM_POAM_AUTOCREATE']) delete process.env[k];
  process.env.PLATFORM_ADMIN_EMAILS = 'u_rem_platform@test.mil';

  say('--- E1-E4: the defaults the environment gives ---');
  assert(same(getDefaultRemediationPolicy({}), DEF), 'E1 no settings -> the Critical/High/Medium/Low days 15/30/90/180, Medium and Low warn-only, no grace', getDefaultRemediationPolicy({}));
  assert(same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: '' }).warnOnly, ['MEDIUM', 'LOW']) && same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: 'none' }).warnOnly, []) && same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: ' NONE ' }).warnOnly, []), "E2 '' means the default and 'none' means an empty list");
  assert(
    same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: ' low , medium ' }).warnOnly, ['MEDIUM', 'LOW']) &&
      same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: 'low' }).warnOnly, ['LOW']) &&
      same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: 'HIGH' }).warnOnly, ['MEDIUM', 'LOW']) &&
      same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: 'MEDIUM' }).warnOnly, ['MEDIUM', 'LOW']) &&
      same(getDefaultRemediationPolicy({ VM_WARN_ONLY_SEVERITIES: 'medium,high' }).warnOnly, ['MEDIUM', 'LOW']),
    'E3 a list is case- and space-insensitive; HIGH, or MEDIUM without LOW, is ignored (the default applies)',
  );
  assert(
    getDefaultRemediationPolicy({ VM_GRACE_DAYS: '7' }).graceDays === 7 && getDefaultRemediationPolicy({ VM_GRACE_DAYS: '99' }).graceDays === 30 && getDefaultRemediationPolicy({ VM_GRACE_DAYS: 'x' }).graceDays === 0 && getDefaultRemediationPolicy({ VM_GRACE_DAYS: '' }).graceDays === 0,
    "E4 the grace days: '7' is 7, '99' is clamped to 30, 'x' and '' are 0",
  );
  const envSla = getDefaultRemediationPolicy({ VM_SLA_DAYS_HIGH: '45', VM_SLA_DAYS_LOW: '' });
  assert(envSla.slaDays.HIGH === 45 && envSla.slaDays.LOW === 180, 'E4 the VM_SLA_DAYS_* settings are still the deadline defaults (empty means the default)', envSla.slaDays);

  say('\n--- Setup: tenants, roles, one host with one finding of each severity ---');
  const mkTenant = async (who: string, name: string) => (await call('POST', '/tenants', who, undefined, { name })).body?.tenant?.id as string;
  const ownerA = person('u_rem_oa');
  const ownerB = person('u_rem_ob');
  const A = await mkTenant(ownerA, 'Remediation A');
  const B = await mkTenant(ownerB, 'Remediation B');
  assert(Boolean(A && B), 'two tenants created', { A, B });
  await firstProgram(A);
  await firstProgram(B);
  const addMember = (tenant: string, owner: string, sub: string, role: string) => call('POST', `/tenants/${tenant}/members`, owner, tenant, { userId: sub, email: `${sub}@test.mil`, role });
  const viewerA = person('u_rem_v');
  const assessorA = person('u_rem_as');
  const adminA = person('u_rem_ad');
  await addMember(A, ownerA, 'u_rem_v', 'VIEWER');
  await addMember(A, ownerA, 'u_rem_as', 'ASSESSOR');
  await addMember(A, ownerA, 'u_rem_ad', 'TENANT_ADMIN');
  const mspA = claimed('u_rem_msp', 'MSP_ADMIN', A);

  const policyOf = (who: string | null, tenant = A) => call('GET', `/tenants/${tenant}/vm/remediation-policy`, who, tenant);
  const eventsOf = (who: string, tenant = A) => call('GET', `/tenants/${tenant}/vm/remediation-policy/events`, who, tenant);
  let stamp: string | null = null;
  const save = (policy: VmRemediationPolicy, who: string, expected: string | null | 'omit' = stamp, tenant = A) =>
    call('PUT', `/tenants/${tenant}/vm/remediation-policy`, who, tenant, expected === 'omit' ? { ...policy } : { ...policy, expectedUpdatedAt: expected });

  say('\n--- R01-R04: authentication, tenant boundary, defaults, who may change it ---');
  const r01 = await policyOf(null);
  assert(r01.status === 401, 'R01 no session -> 401', r01.status);
  const r02 = await policyOf(ownerB);
  assert(r02.status === 403, "R02 another tenant's owner -> 403", r02.status);
  const r03 = await policyOf(viewerA);
  assert(
    r03.status === 200 && r03.body?.source === 'defaults' && same(r03.body?.policy, getDefaultRemediationPolicy()) && same(r03.body?.defaults, getDefaultRemediationPolicy()) && r03.body?.updatedAt === null && r03.body?.kevRule === VM_KEV_RULE_TEXT && r03.body?.limits?.graceMax === 30,
    'R03 a VIEWER reads the defaults: source "defaults", the environment policy, no stamp, the fixed known-exploited rule and the limits',
    r03.body,
  );
  const r04a = await save(DEF, adminA, null);
  const r04b = await save(DEF, viewerA, null);
  const r04c = await save(DEF, assessorA, null);
  assert(r04a.status === 403 && r04a.body?.reason === 'owner_required' && r04b.status === 403 && r04c.status === 403, 'R04 a TENANT_ADMIN (owner_required), a VIEWER and an ASSESSOR cannot change the policy -> 403', [r04a.status, r04a.body, r04b.status, r04c.status]);
  assert((await eventsOf(ownerA)).body?.events?.length === 0, 'R04 nothing was recorded by the refused saves');

  say('\n--- R05-R07: saving, stale writes, validation ---');
  const r05 = await save(withDays(200), ownerA, null);
  stamp = r05.body?.updatedAt ?? null;
  const ev05 = await eventsOf(viewerA);
  assert(r05.status === 200 && r05.body?.changed === true && r05.body?.policy?.slaDays?.LOW === 200 && typeof stamp === 'string', 'R05 an owner saves the first policy -> 200 changed', r05.body);
  const after05 = await policyOf(viewerA);
  assert(after05.body?.source === 'tenant' && after05.body?.updatedAt === stamp && after05.body?.updatedBy === 'u_rem_oa' && after05.body?.policy?.slaDays?.LOW === 200, 'R05 the policy now comes from the tenant, with its stamp and author', after05.body);
  const events05 = (ev05.body?.events ?? []) as Json[];
  assert(ev05.status === 200 && events05.length === 1 && events05[0].oldPolicy === null && events05[0].newPolicy?.slaDays?.LOW === 200 && events05[0].actor === 'u_rem_oa' && events05[0].actorRole === 'TENANT_OWNER', 'R05 one event: no old policy, the new numbers, who and in which role', events05);
  const unchanged = await save(withDays(200), ownerA, stamp);
  assert(unchanged.status === 200 && unchanged.body?.changed === false && unchanged.body?.updatedAt === stamp && (await eventsOf(ownerA)).body?.events?.length === 1, 'R05 a save that changes nothing -> changed:false, the stamp stays and no event is written', unchanged.body);

  const r06a = await save(withDays(210), ownerA, null);
  const r06b = await save(withDays(210), ownerA, '2020-01-01T00:00:00.000Z');
  assert(r06a.status === 409 && r06a.body?.reason === 'stale_write' && r06a.body?.current?.updatedAt === stamp, 'R06 a save that expects no policy when one exists -> 409 stale_write with the current stamp', [r06a.status, r06a.body]);
  assert(r06b.status === 409 && r06b.body?.reason === 'stale_write', 'R06 a save with an old stamp -> 409 stale_write', [r06b.status, r06b.body]);
  assert((await save(withDays(210), ownerA, 'omit')).status === 400, 'R06 a save with no expectedUpdatedAt at all -> 400');
  assert((await policyOf(ownerA)).body?.policy?.slaDays?.LOW === 200, 'R06 neither refused save changed the policy');

  const r07 = await save({ ...DEF, warnOnly: ['HIGH' as 'MEDIUM'] }, ownerA, stamp);
  assert(r07.status === 400 && r07.body?.reason === 'invalid_policy' && r07.body?.field === 'warnOnly' && r07.body?.rule === 'not_allowed', 'R07 a warn-only HIGH -> 400 invalid_policy naming the field and the rule', r07.body);
  const r07b = await save({ ...DEF, warnOnly: ['MEDIUM'] }, ownerA, stamp);
  const r07c = await save({ ...DEF, graceDays: 31 }, ownerA, stamp);
  const r07d = await save({ ...DEF, slaDays: { ...DEF.slaDays, HIGH: 10 } }, ownerA, stamp);
  const r07e = await call('PUT', `/tenants/${A}/vm/remediation-policy`, ownerA, A, { ...DEF, expectedUpdatedAt: stamp, extra: 1 });
  assert(
    r07b.body?.rule === 'order' && r07c.body?.field === 'graceDays' && r07c.body?.rule === 'integer_range' && r07d.body?.field === 'slaDays.HIGH' && r07d.body?.rule === 'order' && r07e.body?.rule === 'unknown_key',
    'R07 Medium without Low, grace 31, High before Critical and an unknown key are each refused with their field and rule',
    [r07b.body, r07c.body, r07d.body, r07e.body],
  );
  assert(!JSON.stringify([r07.body, r07b.body, r07c.body, r07d.body]).includes('31') && (await eventsOf(ownerA)).body?.events?.length === 1, 'R07 the refusals never echo a value and record no event');

  say('\n--- Ingest one host: a CRITICAL, a HIGH, a MEDIUM and a LOW, all first seen in 2020 ---');
  const tokenRes = await call('POST', `/tenants/${A}/vm/tokens`, ownerA, A, { name: 'rem-ingest' }, HTTPS);
  const tokenA = tokenRes.body?.token as string;
  const collectedAt = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
  const payload = (at: string) => ({
    schema_version: 1,
    source: { kind: 'WAZUH', label: 'rem-api-src' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: at,
    hosts: [{ agent_id: 'r1', hostname: SECRET_HOST, findings: (Object.keys(CVE) as Array<keyof typeof CVE>).map((s) => ({ vuln_id: CVE[s], severity: s, detected_at: '2020-01-01T00:00:00Z' })) }],
  });
  const first = await ingest(tokenA, payload(collectedAt(0)));
  await __drainVmWorkerForTests();
  assert(tokenRes.status === 201 && first.status === 202, 'the tenant has a token and one ingested run', [tokenRes.status, first.status]);
  const findingsOf = async (tenant = A, who = ownerA, query = '?status=OPEN&limit=1000') => ((await call('GET', `/tenants/${tenant}/vm/findings${query}`, who, tenant)).body?.findings ?? []) as Json[];
  const poamOf = (who = ownerA, tenant = A) => call('GET', `/tenants/${tenant}/vm/poam?status=all`, who, tenant);
  const itemSeverities = (r: { body: Json | null }) => sorted(((r.body?.items ?? []) as Json[]).map((i) => i.finding?.severity as string));

  say('\n--- R08: only a gap gets a POA&M item ---');
  const open08 = await findingsOf();
  const nowMs = Date.now();
  const gapSeverities = sorted(open08.filter((f) => computeRemediationTier({ status: f.status, severity: f.severity, slaDueAt: f.slaDueAt, kev: Boolean(f.kev) }, withDays(200), null, nowMs).tier === 'GAP').map((f) => f.severity as string));
  const p08 = await poamOf();
  assert(same(gapSeverities, ['CRITICAL', 'HIGH']), 'R08 under Medium and Low warn-only the computed gaps are the CRITICAL and the HIGH', gapSeverities);
  assert(p08.status === 200 && same(itemSeverities(p08), gapSeverities) && p08.body?.itemsTotal === 2, 'R08 the POA&M items are exactly the gaps (the MEDIUM and the LOW, past their deadline, got none)', itemSeverities(p08));
  assert(same(p08.body?.rules?.policy, withDays(200)) && same(p08.body?.rules?.slaDays, withDays(200).slaDays) && p08.body?.overdueWithoutItemCount === 0, 'R08 rules.policy is the saved policy, slaDays are its deadlines, and no gap lacks an item', p08.body?.rules);
  const rows08 = (p08.body?.items ?? []) as Json[];
  assert(rows08.every((i) => i.finding?.remediation?.tier === 'GAP'), 'R08 each POA&M row carries the tier of its finding', rows08.map((i) => i.finding?.remediation));

  say('\n--- R11: a tier on every finding; the summary is their tally ---');
  const all11 = await findingsOf(A, viewerA, '?limit=1000');
  const tiers11 = all11.map((f) => f.remediation?.tier as string);
  const tally = (t: string) => tiers11.filter((x) => x === t).length;
  const s11 = await call('GET', `/tenants/${A}/vm/remediation/summary`, viewerA, A);
  assert(all11.length === 4 && all11.every((f) => typeof f.remediation?.tier === 'string' && typeof f.kev === 'boolean'), 'R11 every finding has kev and a remediation tier', all11.map((f) => f.remediation));
  assert(
    s11.status === 200 && s11.body?.counts?.gap === tally('GAP') && s11.body?.counts?.warning === tally('WARNING') && s11.body?.counts?.onTrack === tally('ON_TRACK') && s11.body?.counts?.accepted === tally('ACCEPTED') && tally('GAP') === 2 && tally('WARNING') === 2,
    'R11 the summary counts are the tally of the tiers (2 gaps, 2 warnings)',
    s11.body,
  );
  assert(s11.body?.gapCritical === 1 && s11.body?.gapHigh === 1 && s11.body?.gapKev === 0 && same(s11.body?.warningBySeverity, { MEDIUM: 1, LOW: 1 }) && s11.body?.pendingDecisions === 0 && same(s11.body?.expiringSoon, []), 'R11 the breakdown: one Critical and one High gap, a Medium and a Low warning, nothing pending or expiring', s11.body);
  assert((await call('GET', `/tenants/${A}/vm/remediation/summary`, ownerB, A)).status === 403, 'R11 another tenant\'s owner cannot read the summary -> 403');

  say('\n--- R09: a new deadline recomputes the open findings ---');
  const before09 = new Map(open08.map((f) => [f.vulnId as string, f.slaDueAt as string]));
  const r09 = await save(withDays(3650), ownerA, stamp);
  stamp = r09.body?.updatedAt ?? stamp;
  const after09 = await findingsOf();
  const changed09 = after09.filter((f) => before09.get(f.vulnId) !== f.slaDueAt).length;
  const lowFinding = after09.find((f) => f.vulnId === CVE.LOW) as Json;
  assert(r09.status === 200 && r09.body?.changed === true && r09.body?.impact?.openRecomputed === changed09 && changed09 === 1, 'R09 impact.openRecomputed is the number of open findings whose due date changed (only the LOW)', [r09.body?.impact, changed09]);
  assert(Date.parse(lowFinding.slaDueAt) === Date.parse(lowFinding.firstSeenAt) + 3650 * DAY, 'R09 the LOW finding is now due its first sight + 3650 days', [lowFinding.slaDueAt, lowFinding.firstSeenAt]);
  assert(r09.body?.impact?.gap === 2 && r09.body?.impact?.warning === 1, 'R09 impact counts the gaps and warnings under the new policy (the LOW is no longer overdue)', r09.body?.impact);
  assert((await poamOf()).body?.itemsTotal === 2, 'R09 the POA&M items are unchanged by the save');
  assert(((await eventsOf(ownerA)).body?.events as Json[])[0]?.openFindingsRecomputed === 1, 'R09 the event records how many due dates changed');

  say('\n--- R10: warn-only off -> the next processed run drafts the rest ---');
  const r10 = await save(withDays(200, { warnOnly: [] }), ownerA, stamp);
  stamp = r10.body?.updatedAt ?? stamp;
  assert(r10.status === 200 && r10.body?.impact?.gap === 4 && r10.body?.impact?.warning === 0 && (await poamOf()).body?.itemsTotal === 2 && (await poamOf()).body?.overdueWithoutItemCount === 2, 'R10 with no warn-only severity all four are gaps, but nothing is drafted by the save itself (two lack an item)', r10.body?.impact);
  const reproc = await call('POST', `/tenants/${A}/vm/runs/${first.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const p10 = await poamOf();
  assert(reproc.status === 202 && p10.body?.itemsTotal === 4 && same(itemSeverities(p10), ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']) && p10.body?.overdueWithoutItemCount === 0, 'R10 reprocessing the run creates the MEDIUM and the LOW items (four in all), and the earlier two stay', [reproc.status, itemSeverities(p10)]);

  say('\n--- R12: an MSP Admin may change the policy; the history lists every save ---');
  const r12 = await save(withDays(200, { warnOnly: [], graceDays: 5 }), mspA, stamp);
  stamp = r12.body?.updatedAt ?? stamp;
  assert(r12.status === 200 && r12.body?.changed === true && r12.body?.policy?.graceDays === 5, 'R12 an MSP Admin saves -> 200', r12.body);
  const events12 = ((await eventsOf(assessorA)).body?.events ?? []) as Json[];
  assert(events12.length === 4 && events12[0].actorRole === 'MSP_ADMIN' && events12[0].oldPolicy?.graceDays === 0 && events12[0].newPolicy?.graceDays === 5 && events12[3].oldPolicy === null, 'R12 four events (one per real change), newest first, each with the old and new numbers and the role', events12.map((e) => e.actorRole));
  assert((await call('GET', `/tenants/${A}/vm/remediation-policy/events?limit=2`, ownerA, A)).body?.events?.length === 2 && (await call('GET', `/tenants/${A}/vm/remediation-policy/events?limit=101`, ownerA, A)).status === 400, 'R12 the history takes limit 1..100');
  assert((await save(withDays(200, { warnOnly: [], graceDays: 0 }), ownerA, stamp)).body?.updatedAt !== stamp, 'R12 the stamp moves on every real change');

  say('\n--- Decisions: a second tenant with its own people and one host, no POA&M drafts yet ---');
  const ownerD = person('u_dec_o1');
  const D = await mkTenant(ownerD, 'Decisions D');
  await firstProgram(D);
  const owner2 = person('u_dec_o2');
  const adminD = person('u_dec_ad');
  const viewerD = person('u_dec_v');
  const assessorD = person('u_dec_as');
  await addMember(D, ownerD, 'u_dec_o2', 'TENANT_OWNER');
  await addMember(D, ownerD, 'u_dec_ad', 'TENANT_ADMIN');
  await addMember(D, ownerD, 'u_dec_v', 'VIEWER');
  await addMember(D, ownerD, 'u_dec_as', 'ASSESSOR');
  const mspD = claimed('u_dec_msp', 'MSP_ADMIN', D);
  const tokenD = (await call('POST', `/tenants/${D}/vm/tokens`, ownerD, D, { name: 'dec-ingest' }, HTTPS)).body?.token as string;
  const pkg = (version: string) => ({ name: 'openssl', version });
  const payloadD = (at: string, highVersion: string) => ({
    schema_version: 1,
    source: { kind: 'WAZUH', label: 'dec-api-src' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: at,
    hosts: [{
      agent_id: 'd1',
      hostname: SECRET_HOST + '-d',
      findings: (Object.keys(CVE) as Array<keyof typeof CVE>).map((s) => ({ vuln_id: CVE[s], severity: s, detected_at: '2020-01-01T00:00:00Z', ...(s === 'HIGH' ? { package: pkg(highVersion) } : {}) })),
    }],
  });
  process.env.VM_POAM_AUTOCREATE = 'false';
  const firstD = await ingest(tokenD, payloadD(collectedAt(0), '1.0'));
  await __drainVmWorkerForTests();
  delete process.env.VM_POAM_AUTOCREATE;
  const idOf = async (vulnId: string) => ((await findingsOf(D, ownerD)).find((f) => f.vulnId === vulnId) as Json).id as string;
  const critId = await idOf(CVE.CRITICAL);
  const highId = await idOf(CVE.HIGH);
  const medId = await idOf(CVE.MEDIUM);
  const tierOfFinding = async (vulnId: string, who = ownerD) => ((await findingsOf(D, who)).find((f) => f.vulnId === vulnId) as Json).remediation?.tier as string;
  const decisionsOf = (findingId: string, who: string) => call('GET', `/tenants/${D}/vm/findings/${findingId}/decisions`, who, D);
  const request = (findingId: string, who: string, over: Record<string, unknown> = {}) =>
    call('POST', `/tenants/${D}/vm/findings/${findingId}/decisions`, who, D, { kind: 'RISK_ACCEPTED', justification: JUSTIFICATION, expiresAt: ymd(20), ...over });
  const act = (decisionId: string, action: string, who: string) => call('POST', `/tenants/${D}/vm/decisions/${decisionId}/${action}`, who, D);
  const poamD = () => call('GET', `/tenants/${D}/vm/poam?status=all`, ownerD, D);
  assert(firstD.status === 202 && (await poamD()).body?.itemsTotal === 0 && (await tierOfFinding(CVE.CRITICAL)) === 'GAP', 'setup: the host is ingested with automatic items off: four findings, no item, the CRITICAL is a gap', [firstD.status]);

  say('\n--- D01: who may request; the request body ---');
  const d01a = await request(critId, viewerD);
  const d01b = await request(critId, assessorD);
  assert(d01a.status === 403 && d01b.status === 403, 'D01 a VIEWER and an ASSESSOR cannot request a decision -> 403', [d01a.status, d01b.status]);
  const bad = async (over: Record<string, unknown>) => (await request(critId, adminD, over)).body;
  const b1 = await bad({ justification: '   ' });
  const b2 = await bad({ justification: 'x'.repeat(4001) });
  const b3 = await bad({ expiresAt: ymd(0) });
  const b4 = await bad({ expiresAt: ymd(366) });
  const b5 = await bad({ kind: 'RESOLVED' });
  const b6 = await bad({ expiresAt: 'tomorrow' });
  assert(
    b1?.reason === 'invalid_decision' && b1?.field === 'justification' && b1?.code === 'required' && b2?.code === 'too_long' && b3?.field === 'expiresAt' && b3?.code === 'range' && b4?.code === 'range' && b5?.field === 'kind' && b5?.code === 'kind' && b6?.code === 'range',
    'D01 an empty or 4001-character justification, an expiry of today or beyond 365 days, a bad kind and a bad date are each 400 invalid_decision with their field and code',
    [b1, b2, b3, b4, b5, b6],
  );
  assert((await request(critId, adminD, { expiresAt: ymd(365) })).status === 201, 'D01 an expiry 365 days ahead is allowed');
  assert((await act(((await decisionsOf(critId, ownerD)).body?.decisions as Json[])[0].id, 'withdraw', adminD)).status === 200, 'D01 (that request is withdrawn again by its requester to keep the next cases clean)');
  assert((await request('does-not-exist', adminD)).status === 404 && (await request('a b', adminD)).status === 404 && (await call('POST', `/tenants/${D}/vm/findings/${critId}/decisions`, ownerB, D, {})).status === 403, 'D01 an unknown or malformed finding id -> 404; another tenant\'s owner -> 403');

  say('\n--- D02-D05: a pending request changes nothing; two people are always needed ---');
  const d02 = await request(critId, adminD);
  const dec02 = d02.body?.decision as Json;
  assert(
    d02.status === 201 && dec02?.state === 'PENDING' && dec02?.kind === 'RISK_ACCEPTED' && dec02?.requestedByMe === true && dec02?.requestedBy === 'u_dec_ad' && dec02?.justification === JUSTIFICATION && dec02?.justificationLength === [...JUSTIFICATION].length && /^[0-9a-f]{64}$/.test(dec02?.justificationSha256) && dec02?.approvedBy === null && same(dec02?.events, []) && dec02?.vulnId === CVE.CRITICAL && dec02?.assetName === SECRET_HOST + '-d',
    'D02 a TENANT_ADMIN requests RISK_ACCEPTED on the CRITICAL -> 201 PENDING, requested by me, with the digest and length of the text',
    d02.body,
  );
  assert((await tierOfFinding(CVE.CRITICAL)) === 'GAP', 'D02 the finding is still a gap while the request waits');
  const d03 = await request(critId, ownerD);
  assert(d03.status === 409 && d03.body?.reason === 'decision_pending', 'D03 a second request for the finding while one waits -> 409 decision_pending', d03.body);
  const d03b = await request(highId, ownerD, { kind: 'FALSE_POSITIVE' });
  const decHigh = d03b.body?.decision as Json;
  assert(d03b.status === 201 && decHigh?.requestedByMe === true, 'D03 another finding can have its own request (by an owner)', d03b.body);
  const d04 = await act(decHigh.id, 'approve', ownerD);
  assert(d04.status === 403 && d04.body?.reason === 'self_approval_forbidden', 'D04 an owner cannot approve their own request -> 403 self_approval_forbidden (no single-owner exception)', d04.body);
  const d04b = await act(decHigh.id, 'withdraw', owner2);
  const d04c = await act(decHigh.id, 'withdraw', ownerD);
  assert(d04b.status === 403 && d04b.body?.reason === 'not_requester' && d04c.status === 200 && d04c.body?.decision?.state === 'WITHDRAWN', 'D04 only the requester can withdraw (another owner -> 403 not_requester); the request is then WITHDRAWN', [d04b.body, d04c.body?.decision?.state]);
  assert((await act(decHigh.id, 'approve', owner2)).status === 409 && (await act(decHigh.id, 'approve', owner2)).body?.reason === 'decision_not_pending', 'D04 a withdrawn request cannot be approved -> 409 decision_not_pending');
  const d05a = await act(dec02.id, 'approve', adminD);
  const d05b = await act(dec02.id, 'reject', adminD);
  const d05c = await act(dec02.id, 'approve', viewerD);
  assert(d05a.status === 403 && d05a.body?.reason === 'owner_required' && d05b.status === 403 && d05b.body?.reason === 'owner_required' && d05c.status === 403, 'D05 a TENANT_ADMIN cannot approve or reject (owner_required); a VIEWER cannot act at all -> 403', [d05a.body, d05b.body, d05c.status]);
  assert((await act('nope', 'approve', owner2)).status === 404 && (await act('a b', 'approve', owner2)).status === 404, 'D05 an unknown or malformed decision id -> 404');
  assert((await decisionsOf(critId, ownerD)).body?.decisions?.[0]?.state === 'PENDING', 'D05 the refused calls changed nothing');

  say('\n--- D06: a second owner approves: accepted, no draft, evidence by digest ---');
  const d06 = await act(dec02.id, 'approve', owner2);
  assert(d06.status === 200 && d06.body?.decision?.state === 'ACTIVE' && d06.body?.decision?.approvedBy === 'u_dec_o2' && typeof d06.body?.decision?.approvedAt === 'string' && d06.body?.decision?.requestedByMe === false && d06.body?.decision?.events?.[0]?.action === 'approved' && d06.body?.decision?.events?.[0]?.actorRole === 'TENANT_OWNER', 'D06 another owner approves -> 200 ACTIVE, with who and when', d06.body);
  const crit06 = (await findingsOf(D, ownerD)).find((f) => f.vulnId === CVE.CRITICAL) as Json;
  assert(crit06.remediation?.tier === 'ACCEPTED' && crit06.remediation?.reason === 'risk_accepted' && crit06.remediation?.decision?.id === dec02.id && crit06.status === 'OPEN', 'D06 the finding is ACCEPTED (derived from the decision; its stored status stays OPEN)', crit06.remediation);
  const reproc06 = await call('POST', `/tenants/${D}/vm/runs/${firstD.body?.run_id}/reprocess`, ownerD, D);
  await __drainVmWorkerForTests();
  const p06 = await poamD();
  assert(reproc06.status === 202 && same(((p06.body?.items ?? []) as Json[]).map((i) => i.finding?.severity), ['HIGH']) && p06.body?.overdueWithoutItemCount === 0, 'D06 the next processed run drafts the HIGH but not the accepted CRITICAL (the MEDIUM and LOW are warnings)', ((p06.body?.items ?? []) as Json[]).map((i) => i.finding?.severity));
  assert(((p06.body?.items ?? []) as Json[])[0]?.finding?.remediation?.tier === 'GAP', 'D06 the item row carries its finding\'s tier');
  const snap = await call('POST', `/tenants/${D}/vm/snapshot`, ownerD, D);
  const latest = await call('GET', `/tenants/${D}/vm/snapshot/latest`, ownerD, D);
  const report = latest.body?.report as Json;
  assert(snap.status === 201 && report?.version === 2 && report?.remediation?.accepted?.riskAccepted === 1 && report?.remediation?.gaps?.total === 1 && report?.remediation?.gaps?.high === 1, 'D06 the snapshot counts one risk acceptance and one gap (the HIGH)', [snap.status, report?.remediation]);
  assert(!latest.text.includes(JUSTIFICATION) && !latest.text.includes('SECRET-JUSTIFICATION'), 'D06 the evidence snapshot never carries the justification text');
  const sum06 = await call('GET', `/tenants/${D}/vm/remediation/summary`, viewerD, D);
  assert(sum06.body?.counts?.accepted === 1 && sum06.body?.counts?.gap === 1 && sum06.body?.expiringSoon?.length === 1 && sum06.body?.expiringSoon?.[0]?.decisionId === dec02.id && sum06.body?.expiringSoon?.[0]?.assetName === SECRET_HOST + '-d', 'D06 the summary counts the accepted finding and lists the decision expiring within 30 days', sum06.body);

  say('\n--- D07: revoke ---');
  const d07a = await act(dec02.id, 'revoke', adminD);
  const d07b = await act(dec02.id, 'revoke', mspD);
  assert(d07a.status === 403 && d07b.status === 200 && d07b.body?.decision?.state === 'REVOKED' && d07b.body?.decision?.events?.length === 2, 'D07 a TENANT_ADMIN cannot revoke; an MSP Admin can -> REVOKED', [d07a.status, d07b.body?.decision?.state]);
  const again = await act(dec02.id, 'revoke', owner2);
  assert(again.status === 409 && again.body?.reason === 'decision_not_active', 'D07 revoking again -> 409 decision_not_active', again.body);
  assert((await tierOfFinding(CVE.CRITICAL)) === 'GAP', 'D07 the finding is a gap again');
  await call('POST', `/tenants/${D}/vm/runs/${firstD.body?.run_id}/reprocess`, ownerD, D);
  await __drainVmWorkerForTests();
  assert(sorted((((await poamD()).body?.items ?? []) as Json[]).map((i) => i.finding?.severity)).join() === 'CRITICAL,HIGH', 'D07 the next processed run drafts the CRITICAL now');

  say('\n--- D08: a false positive lapses when the packages change; a risk acceptance would not ---');
  const d08 = await request(highId, adminD, { kind: 'FALSE_POSITIVE' });
  const decFp = d08.body?.decision as Json;
  assert(d08.status === 201 && (await act(decFp.id, 'approve', mspD)).body?.decision?.state === 'ACTIVE' && (await tierOfFinding(CVE.HIGH)) === 'ACCEPTED', 'D08 a false-positive request is approved by an MSP Admin -> the HIGH is ACCEPTED', d08.body);
  const second = await ingest(tokenD, payloadD(collectedAt(30_000), '1.1'));
  await __drainVmWorkerForTests();
  const decsHigh = ((await decisionsOf(highId, ownerD)).body?.decisions ?? []) as Json[];
  assert(second.status === 202 && decsHigh.find((d) => d.id === decFp.id)?.state === 'PACKAGE_CHANGED' && (await tierOfFinding(CVE.HIGH)) === 'GAP', 'D08 after a scan with a new package version the decision is PACKAGE_CHANGED and the HIGH is a gap again', decsHigh.map((d) => d.state));

  say('\n--- D09: expiry is derived from an injected clock ---');
  const d09 = await request(critId, adminD, { expiresAt: ymd(20) });
  const decRa = d09.body?.decision as Json;
  assert((await act(decRa.id, 'approve', owner2)).body?.decision?.state === 'ACTIVE', 'D09 a risk acceptance is approved again');
  const nowIso = new Date().toISOString();
  const future = new Date(Date.now() + 25 * DAY).toISOString();
  const atNow = (await listDecisionStates(D, nowIso)).find((v) => v.decision.id === decRa.id);
  const atFuture = (await listDecisionStates(D, future)).find((v) => v.decision.id === decRa.id);
  assert(atNow?.state === 'ACTIVE' && atFuture?.state === 'EXPIRED', 'D09 listDecisionStates: ACTIVE now, EXPIRED 25 days later (the clock is injected; nothing waits)', [atNow?.state, atFuture?.state]);
  const expiring = await call('GET', `/tenants/${D}/vm/decisions?state=expiring`, viewerD, D);
  const activeList = await call('GET', `/tenants/${D}/vm/decisions?state=active`, viewerD, D);
  const pendingList = await call('GET', `/tenants/${D}/vm/decisions?state=pending`, viewerD, D);
  const allList = await call('GET', `/tenants/${D}/vm/decisions`, viewerD, D);
  assert(
    (expiring.body?.decisions as Json[])?.length === 1 && (expiring.body?.decisions as Json[])[0].id === decRa.id && (activeList.body?.decisions as Json[])?.length === 1 && (pendingList.body?.decisions as Json[])?.length === 0 && (allList.body?.decisions as Json[])?.length >= 4,
    'D09 the lists by state: one expiring, one active, none pending, and the full history', [expiring.body, allList.body?.decisions?.length],
  );
  assert((await call('GET', `/tenants/${D}/vm/decisions?state=bogus`, viewerD, D)).status === 400, 'D09 an unknown state -> 400');
  assert((allList.body?.decisions as Json[]).every((d, i, xs) => i === 0 || xs[i - 1].requestedAt >= d.requestedAt), 'D09 newest request first');

  say('\n--- D10: who reads the justification ---');
  const dv = (await call('GET', `/tenants/${D}/vm/decisions?state=active`, viewerD, D)).body?.decisions?.[0] as Json;
  const da = (await call('GET', `/tenants/${D}/vm/decisions?state=active`, assessorD, D)).body?.decisions?.[0] as Json;
  const dw = (await call('GET', `/tenants/${D}/vm/decisions?state=active`, adminD, D)).body?.decisions?.[0] as Json;
  assert(dv?.justification === null && dv?.justificationLength === [...JUSTIFICATION].length && /^[0-9a-f]{64}$/.test(dv?.justificationSha256), 'D10 a VIEWER gets justification null, its length and its digest', dv);
  assert(da?.justification === JUSTIFICATION && dw?.justification === JUSTIFICATION && da?.requestedByMe === false && dw?.requestedByMe === true, 'D10 an ASSESSOR and a TENANT_ADMIN read the text; requestedByMe follows the caller', [da?.requestedByMe, dw?.requestedByMe]);
  assert(!(await call('GET', `/tenants/${D}/vm/findings/${critId}/decisions`, viewerD, D)).text.includes('SECRET-JUSTIFICATION'), 'D10 the per-finding list hides the text from a VIEWER too');
  assert((await decisionsOf('does-not-exist', ownerD)).status === 404 && (await decisionsOf(critId, ownerB)).status === 403, 'D10 an unknown finding -> 404; another tenant -> 403');

  say('\n--- D13: a request past its expiry cannot be approved ---');
  const seedNow = new Date(Date.now() - 10 * DAY).toISOString();
  const seeded = await requestDecision(D, medId, { kind: 'RISK_ACCEPTED', justification: 'seeded justification', expiresAt: new Date(Date.now() - 5 * DAY).toISOString() }, { name: 'u_dec_ad', userId: 'u_dec_ad', role: 'TENANT_ADMIN' }, seedNow);
  assert(seeded.state === 'PENDING', 'D13 a request seeded through the store with an injected past clock is PENDING then', seeded.state);
  const d13 = await act(seeded.decision.id, 'approve', owner2);
  assert(d13.status === 409 && d13.body?.reason === 'decision_expired', 'D13 approving it now -> 409 decision_expired', d13.body);
  assert(((await decisionsOf(medId, ownerD)).body?.decisions as Json[])[0]?.state === 'EXPIRED', 'D13 its state is EXPIRED');
  assert((await request(medId, adminD)).status === 201, 'D13 an expired request does not block a new one');
  const rej = ((await decisionsOf(medId, ownerD)).body?.decisions as Json[])[0];
  assert((await act(rej.id, 'reject', owner2)).body?.decision?.state === 'REJECTED' && (await act(rej.id, 'approve', owner2)).body?.reason === 'decision_not_pending', 'D13 a rejected request stays rejected');

  say('\n--- D11-D12 and R13: nothing sensitive in the console or the events ---');
  const logText = captured.join('\n');
  assert(!logText.includes('SECRET-JUSTIFICATION') && !logText.includes('seeded justification'), 'D11 no justification text reaches the console');
  assert(!/CVE-2024-200\d/.test(logText) && !logText.includes(SECRET_HOST), 'R13 no CVE id or host name reaches the console');
  assert(captured.some((l) => l.includes('approved decision')) && captured.some((l) => l.includes('saved the remediation policy')), 'D11 the log lines that exist carry ids only (a decision and a policy save were logged)');
  const decisionEvents = ((allList.body?.decisions ?? []) as Json[]).flatMap((d) => d.events as Json[]);
  assert(decisionEvents.length > 0 && decisionEvents.every((e) => same(Object.keys(e).sort(), ['action', 'actor', 'actorRole', 'createdAt'])), 'D12 decision events carry an action, an actor, a role and a time - no justification key');
  assert(!JSON.stringify((await eventsOf(ownerA)).body).includes('justification'), 'D12 the policy events carry no text either');

  say('\n--- Tenant isolation ---');
  assert(!(await call('GET', `/tenants/${B}/vm/decisions`, ownerB, B)).text.includes(JUSTIFICATION) && ((await call('GET', `/tenants/${B}/vm/decisions`, ownerB, B)).body?.decisions as Json[]).length === 0 && (await findingsOf(B, ownerB)).length === 0, "another tenant sees none of this tenant's decisions or findings");
  assert((await call('GET', `/tenants/${B}/vm/remediation-policy`, ownerB, B)).body?.source === 'defaults', "another tenant's policy is still the defaults");
}

run()
  .then(async () => {
    rawLog(`\n📊 TEST RESULTS: ${passed} / ${total}`);
    await shutdown(passed === total ? 0 : 1);
  })
  .catch(async (err) => {
    rawError('Test run failed:', err);
    await shutdown(1);
  });
