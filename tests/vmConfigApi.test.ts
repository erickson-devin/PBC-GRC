import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { server } from '../server/index';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { __drainVmWorkerForTests } from '../server/vm/worker';
import { listControlAssessmentEvents, readControlAssessments } from '../server/controlAssessments';
import { changeProgramAssets } from '../server/programAssets';
import { createProgram } from '../server/programs';
import { firstProgram } from './programFixture';
import { createAgentReportedAsset, listAgentAssetCandidates } from '../server/assets';

/**
 * Configuration (SCAP / XCCDF) results over HTTP (issue #103): a configuration-only push, the three read endpoints, the rule that
 * automation never sets a control, mixing with a Wazuh push on one host, reprocessing, boundaries, access and the snapshot exclusion.
 * Runs against the in-memory store with a throw-away vault (see ./vmEnv); the worker is drained, never timed. Boots the server on
 * port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const PREFIX = 'xccdf_org.ssgproject.content_rule_';
const CFG_HOST = 'HOST-MARK-CFG';
const CFG_IP = '10.91.0.7';

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

async function ingest(token: string, payload: unknown) {
  resetLimiters();
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: { ...HTTPS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: Buffer.from(JSON.stringify(payload)) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const agentOf = (host: string) => 'xccdf-' + crypto.createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 32);

function scapPayload(label: string, hosts: Array<{ hostname: string; ip?: string; results?: Json[]; findings?: Json[] }>): Json {
  return {
    schema_version: 1,
    source: { kind: 'SCAP', label },
    exporter: { name: 'pbc-vm-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: hosts.map((h) => ({
      agent_id: agentOf(h.hostname),
      hostname: h.hostname,
      ...(h.ip ? { ip: h.ip } : {}),
      ...(h.findings ? { findings: h.findings } : {}),
      configuration: [
        {
          benchmark: { id: 'xccdf_org.ssgproject.content_benchmark_RHEL-9', version: '0.1.69', title: 'Example RHEL 9 benchmark' },
          profile: { id: 'xccdf_org.ssgproject.content_profile_cui', title: 'CUI' },
          scanner: { name: 'OpenSCAP', version: '1.3.9' },
          started_at: '2026-10-18T11:00:00Z',
          scanned_at: '2026-10-18T11:05:00Z',
          results: h.results ?? [
            { rule_id: PREFIX + 'sshd_disable_root_login', result: 'pass', severity: 'medium', title: 'Disable root login' },
            { rule_id: PREFIX + 'accounts_password_pam_minlen', cce: 'CCE-27407-6', result: 'fail', severity: 'medium' },
            { rule_id: 'foo_bar', result: 'notapplicable' },
          ],
        },
      ],
    })),
  };
}

function wazuhPayload(label: string, hostname: string, agent: string, withConfig = false): Json {
  return {
    schema_version: 1,
    source: { kind: 'WAZUH', label },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: [
      {
        agent_id: agent,
        hostname,
        findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }],
        ...(withConfig
          ? { configuration: [{ benchmark: { id: 'bench-mixed' }, scanner: { name: 'wazuh-sca' }, scanned_at: '2026-10-18T11:05:00Z', results: [{ rule_id: 'rule_one', result: 'pass' }] }] }
          : {}),
      },
    ],
  };
}

async function shutdown(code: number) {
  process.exitCode = code;
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Setup: users, tenants, tokens ---');
  process.env.PLATFORM_ADMIN_EMAILS = 'u_cfg_admin@test.mil';
  const admin = person('u_cfg_admin');
  const viewer = person('u_cfg_viewer');
  const owner2 = person('u_cfg_o2');
  const owner3 = person('u_cfg_o3');
  const owner4 = person('u_cfg_o4');
  const mkTenant = async (who: string, name: string, extra: Record<string, unknown> = {}) =>
    (await call('POST', '/tenants', who, undefined, { name, ...extra })).body?.tenant?.id as string;
  const T1 = await mkTenant(admin, 'Cfg CMMC L2', { primaryFramework: 'CMMC_L2' });
  const T2 = await mkTenant(owner2, 'Cfg Other');
  const T3 = await mkTenant(owner3, 'Cfg Mixed');
  const T4 = await mkTenant(owner4, 'Cfg Scap Only');
  const defaultProgram1 = await firstProgram(T1, 'CMMC_L2'); // a tenant starts with no program: the first one is its organization default
  assert(Boolean(T1 && T2 && T3 && T4), 'four tenants created (T1 is CMMC Level 2)', { T1, T2, T3, T4 });
  await call('POST', `/tenants/${T1}/members`, admin, T1, { userId: 'u_cfg_viewer', email: 'u_cfg_viewer@test.mil', role: 'VIEWER' });
  const tokenOf = async (owner: string, tenant: string) => (await call('POST', `/tenants/${tenant}/vm/tokens`, owner, tenant, { name: 'cfg-ingest' }, HTTPS)).body?.token as string;
  const tok1 = await tokenOf(admin, T1);
  const tok3 = await tokenOf(owner3, T3);
  const tok4 = await tokenOf(owner4, T4);
  assert(Boolean(tok1 && tok3 && tok4), 'service tokens created');

  const runsOf = async (tenant: string, who: string) => ((await call('GET', `/tenants/${tenant}/vm/runs`, who, tenant)).body?.runs ?? []) as Json[];
  const scansOf = async (tenant: string, who: string, query = '') => (await call('GET', `/tenants/${tenant}/vm/config/scans${query}`, who, tenant)).body as Json;
  const findingsOf = async (tenant: string, who: string) => ((await call('GET', `/tenants/${tenant}/vm/findings`, who, tenant)).body?.findings ?? []) as Json[];

  console.log('\n--- A1-A5: a configuration-only push ---');
  const captured: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const capture = (...args: unknown[]) => { captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture; console.info = capture;
  let pushed: { status: number; body: Json | null };
  try {
    pushed = await ingest(tok1, scapPayload('scap-main', [{ hostname: CFG_HOST, ip: CFG_IP }]));
    await __drainVmWorkerForTests();
  } finally {
    console.log = original.log; console.error = original.error; console.warn = original.warn; console.info = original.info;
  }
  const runId = pushed.body?.run_id as string;
  const run1 = (await runsOf(T1, admin)).find((r) => r.id === runId) as Json;
  assert(pushed.status === 202 && run1?.status === 'NORMALIZED' && run1.findingCount === 0 && run1.configResultCount === 3, 'A1 a SCAP push is accepted and NORMALIZED with 0 findings and 3 configuration results', [pushed.status, run1]);

  const scans1 = await scansOf(T1, admin);
  const scan1 = (scans1?.scans ?? [])[0] as Json;
  assert(scans1?.totalCount === 1 && scan1?.resultCounts?.pass === 1 && scan1.resultCounts.fail === 1 && scan1.resultCounts.notapplicable === 1, 'A2 GET config/scans: one scan with pass 1, fail 1, notapplicable 1', scans1);
  assert(Boolean(scan1) && !('rawPath' in scan1) && !JSON.stringify(scans1).includes('rawPath') && scan1.runId === runId, 'A2 the scan carries no raw path and names its run');

  const res1 = (await call('GET', `/tenants/${T1}/vm/config/scans/${scan1?.id}/results`, admin, T1)).body as Json;
  const rows1 = (res1?.results ?? []) as Json[];
  const rowOf = (id: string) => rows1.find((r) => r.ruleId === id);
  assert(rows1.length === 3 && res1.totalCount === 3 && res1.scanId === scan1.id, 'A3 results: three rows', res1);
  assert(
    rowOf(PREFIX + 'sshd_disable_root_login')?.controls?.cmmc === 'AC.L1-3.1.1' && rowOf(PREFIX + 'accounts_password_pam_minlen')?.controls?.cmmc === 'AC.L1-3.1.1' && rowOf('foo_bar')?.controls === null,
    'A3 mapped rows name AC.L1-3.1.1, an unknown rule has controls null',
    rows1.map((r) => [r.ruleId, r.controls]),
  );
  const onlyFail = (await call('GET', `/tenants/${T1}/vm/config/scans/${scan1?.id}/results?result=fail`, admin, T1)).body as Json;
  assert(onlyFail?.totalCount === 1 && onlyFail.results[0].result === 'fail', 'A3 the result filter works');

  const sug = (await call('GET', `/tenants/${T1}/vm/config/suggestions`, admin, T1)).body as Json;
  const sugControl = ((sug?.controls ?? []) as Json[]).find((c) => c.controlId === 'AC.L1-3.1.1');
  assert(sug?.supported === true && sug.frameworkId === 'CMMC_L2' && sugControl?.suggestion === 'NOT_MET' && sugControl.assets.failing === 1, 'A4 the suggestion for AC.L1-3.1.1 is NOT_MET', sug);
  assert(sug?.boundary?.declared === false && sug.boundary.inScope === 1 && sug.boundary.evaluated === 1 && sugControl?.assets?.unconfirmed === 1 && sug.unmappedRuleCount === 1, 'A4 the whole inventory is the boundary; the new host is unconfirmed; one rule is unmapped', [sug?.boundary, sugControl?.assets, sug?.unmappedRuleCount]);
  assert(Array.isArray(sugControl?.failingAssetIds) && sugControl.failingAssetIds.length === 1 && !JSON.stringify(sug).includes(CFG_HOST) && !JSON.stringify(sug).includes(CFG_IP), 'A4 suggestions name assets by id only');

  const controlsRes = await call('GET', '/controls?framework=CMMC_L2', admin, T1);
  const control = ((controlsRes.body?.controls ?? []) as Json[]).find((c) => c.id === 'AC.L1-3.1.1');
  const events = await listControlAssessmentEvents({ tenantId: T1, programId: defaultProgram1.id }, 'AC.L1-3.1.1', 50);
  const live = await readControlAssessments({ tenantId: T1, programId: defaultProgram1.id });
  assert(Boolean(control) && control?.status === 'NOT_STARTED' && events.length === 0 && !live.has('AC.L1-3.1.1'), 'A5 the control is untouched: status NOT_STARTED, no history, no stored assessment', [control?.status, events.length]);

  const candidates1 = await listAgentAssetCandidates(T1);
  const cfgAsset = candidates1.find((c) => c.hostName === CFG_HOST);
  assert(cfgAsset?.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && cfgAsset.lastVulnSeenAt === null, 'A6 a host new from a SCAP-only run is an unconfirmed asset never seen by a vulnerability scanner (lastVulnSeenAt null)', cfgAsset);
  assert((await findingsOf(T1, admin)).length === 0, 'no findings were created by a configuration-only push');

  const leaked = captured.filter((l) => l.includes(CFG_HOST) || l.includes(CFG_IP));
  assert(captured.length > 0 && leaked.length === 0, 'A11 console output during the push and the worker carries neither the host name nor the address', leaked.length);

  console.log('\n--- A7: reprocessing ---');
  const again = await call('POST', `/tenants/${T1}/vm/runs/${runId}/reprocess`, admin, T1);
  await __drainVmWorkerForTests();
  const scansAfter = await scansOf(T1, admin);
  const resAfter = (await call('GET', `/tenants/${T1}/vm/config/scans/${scansAfter?.scans?.[0]?.id}/results`, admin, T1)).body as Json;
  assert(again.status === 202 && scansAfter?.totalCount === 1 && resAfter?.totalCount === 3, 'A7 reprocessing the run keeps one scan with three results', [again.status, scansAfter?.totalCount, resAfter?.totalCount]);
  assert((await runsOf(T1, admin)).find((r) => r.id === runId)?.status === 'NORMALIZED', 'A7 the run is NORMALIZED again');

  console.log('\n--- A8-A9: access and validation ---');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans`, viewer, T1)).status === 200, 'A8 a VIEWER can read the scans');
  assert((await call('GET', `/tenants/${T1}/vm/config/suggestions`, viewer, T1)).status === 200, 'A8 a VIEWER can read the suggestions');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans`, owner2, T1)).status === 403, 'A8 a non-member is refused (403)');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans`, null, T1)).status === 401, 'no session => 401');
  assert((await call('GET', `/tenants/${T2}/vm/config/scans/${scan1.id}/results`, owner2, T2)).status === 404, "another tenant's scan id -> 404");
  assert(((await scansOf(T2, owner2))?.totalCount) === 0, "another tenant sees none of T1's scans");
  assert((await call('GET', `/tenants/${T1}/vm/config/scans?assetId=a%20b`, admin, T1)).status === 400, 'A9 assetId "a b" -> 400');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans?limit=0`, admin, T1)).status === 400, 'A9 limit=0 -> 400');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans?limit=501`, admin, T1)).status === 400, 'A9 limit=501 -> 400');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans?latest=maybe`, admin, T1)).status === 400, 'A9 latest=maybe -> 400');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans/bad!/results`, admin, T1)).status === 404, 'A9 a scan id outside the pattern -> 404');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans/${scan1.id}/results?result=PASS`, admin, T1)).status === 400, 'A9 an unknown result value -> 400');
  assert((await call('GET', `/tenants/${T1}/vm/config/scans/${scan1.id}/results?limit=5001`, admin, T1)).status === 400, 'A9 results limit=5001 -> 400');
  const byAsset = await scansOf(T1, admin, `?assetId=${cfgAsset?.id}&latest=true`);
  assert(byAsset?.totalCount === 1, 'assetId and latest=true select the asset\'s newest scan', byAsset?.totalCount);

  console.log('\n--- A10: a program whose boundary excludes the asset ---');
  const bystander = await createAgentReportedAsset(T1, {
    agentId: 'by-1', hostName: 'bystander', ipAddress: '', macAddress: '', osProfile: 'custom', notes: '', agentIds: {},
    sourceOrigin: 'AGENT_REPORT', discoveryStatus: 'UNCONFIRMED_DISCOVERY', cmmcAssetCategory: 'CONTRACTOR_RISK',
  }, null, 'test');
  const program2 = await createProgram(T1, { name: 'Second boundary', frameworkId: 'CMMC_L2' }, 'u_cfg_admin');
  await changeProgramAssets(T1, program2.id, { add: [bystander!.id], remove: [] }, { actor: 'test', userId: null });
  const sug2 = (await call('GET', `/tenants/${T1}/vm/config/suggestions`, admin, T1, undefined, { 'x-program-id': program2.id })).body as Json;
  assert(sug2?.programId === program2.id && sug2.boundary?.declared === true && sug2.boundary.inScope === 1 && sug2.boundary.evaluated === 0 && Array.isArray(sug2.controls) && sug2.controls.length === 0, 'A10 a program whose boundary excludes the scanned asset has no suggestions', sug2);
  assert((await call('GET', `/tenants/${T1}/vm/config/suggestions`, admin, T1, undefined, { 'x-program-id': 'no-such-program' })).status === 404, 'an unknown program -> 404');

  console.log('\n--- A6, A14: mixing with a Wazuh push (tenant T3) ---');
  const wazuh = await ingest(tok3, wazuhPayload('wazuh-main', CFG_HOST, 'w-1'));
  await __drainVmWorkerForTests();
  const wazuhRun = (await runsOf(T3, owner3)).find((r) => r.id === wazuh.body?.run_id) as Json;
  const afterWazuh = (await listAgentAssetCandidates(T3)).find((c) => c.hostName === CFG_HOST);
  const scapMix = await ingest(tok3, scapPayload('scap-main', [{ hostname: CFG_HOST, ip: CFG_IP }, { hostname: 'SCAP-ONLY-NEW' }]));
  await __drainVmWorkerForTests();
  const mixRun = (await runsOf(T3, owner3)).find((r) => r.id === scapMix.body?.run_id) as Json;
  const finding = (await findingsOf(T3, owner3))[0] as Json;
  const afterScap = await listAgentAssetCandidates(T3);
  const sameHost = afterScap.find((c) => c.hostName === CFG_HOST);
  const newHost = afterScap.find((c) => c.hostName === 'SCAP-ONLY-NEW');
  assert(wazuh.status === 202 && wazuhRun?.status === 'NORMALIZED' && mixRun?.status === 'NORMALIZED' && afterScap.length === 2, 'A6 both runs are NORMALIZED and the SCAP host matched the Wazuh asset by name (two assets in all)', [wazuhRun?.status, mixRun?.status, afterScap.length]);
  assert((await findingsOf(T3, owner3)).length === 1 && finding?.status === 'OPEN', 'A6 the Wazuh finding is still OPEN: a configuration-only host does not close it', finding);
  assert(Boolean(sameHost) && sameHost?.lastVulnSeenAt === wazuhRun?.receivedAt && sameHost?.lastVulnSeenAt === afterWazuh?.lastVulnSeenAt, 'A6 last_vuln_seen_at is the Wazuh run\'s receipt time, unmoved by the SCAP run', [sameHost?.lastVulnSeenAt, wazuhRun?.receivedAt]);
  assert(Boolean(newHost) && newHost?.lastVulnSeenAt === null, 'A6 a host only SCAP reported has lastVulnSeenAt null', newHost);
  assert(Object.keys(sameHost?.agentIds ?? {}).length === 2, 'A6 the asset carries both agent ids (wazuh and scap sources)', sameHost?.agentIds);

  const mixed = await ingest(tok3, wazuhPayload('wazuh-main', 'mixed-host', 'w-2', true));
  await __drainVmWorkerForTests();
  const mixedAsset = (await listAgentAssetCandidates(T3)).find((c) => c.hostName === 'mixed-host');
  const mixedScans = await scansOf(T3, owner3, `?assetId=${mixedAsset?.id}`);
  const mixedFinding = (await findingsOf(T3, owner3)).find((f) => f.assetId === mixedAsset?.id);
  assert(mixed.status === 202 && mixedFinding?.status === 'OPEN' && mixedScans?.totalCount === 1 && mixedAsset?.lastVulnSeenAt !== null, 'A14 a Wazuh host with findings and configuration: finding OPEN, one scan stored, host seen by the scanner', [mixed.status, mixedFinding?.status, mixedScans?.totalCount]);

  console.log('\n--- A12-A13: a SCAP source (tenant T4) ---');
  const bad = await ingest(tok4, scapPayload('scap-bad', [{ hostname: 'bad-host', findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }] }]));
  await __drainVmWorkerForTests();
  const badRun = (await runsOf(T4, owner4)).find((r) => r.id === bad.body?.run_id) as Json;
  assert(bad.status === 202 && badRun?.status === 'FAILED' && badRun.error === 'No normalizer for SCAP yet.', 'A12 a SCAP payload that reports findings is FAILED "No normalizer for SCAP yet."', badRun);
  assert((await scansOf(T4, owner4))?.totalCount === 0, 'A12 a failed run stores no scans');
  const good = await ingest(tok4, scapPayload('scap-good', [{ hostname: 'good-host' }]));
  await __drainVmWorkerForTests();
  assert(good.status === 202 && (await scansOf(T4, owner4))?.totalCount === 1, 'a configuration-only SCAP push in the same tenant works');
  const snapshot = await call('POST', `/tenants/${T4}/vm/snapshot`, owner4, T4);
  assert(snapshot.status === 409 && snapshot.body?.error === 'vm_no_sources', 'A13 a tenant with only SCAP sources has no vulnerability sources: the snapshot answers 409 vm_no_sources', snapshot.body);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
