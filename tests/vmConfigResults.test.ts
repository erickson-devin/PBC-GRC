import './testEnv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getFrameworkControls } from '../src/data/frameworks';
import { CONFIG_RULE_MAPPINGS, controlsForRule, mapConfigRule, normalizeRuleId } from '../src/data/telemetry/configRuleMap';
import { validateIngestPayload } from '../server/vm/ingestSchema';
import { emptyResultCounts, normalizeConfiguration } from '../server/vm/adapters/config';
import { computeConfigSuggestions, selectLatestScans, type SuggestionAsset, type SuggestionResultRow } from '../server/vm/configSuggestions';
import { __resetVmConfigForTests, getConfigScan, listConfigResults, listConfigScans, loadLatestConfigResults, replaceRunConfigScans } from '../server/vm/configStore';
import { VM_CONFIG_RESULTS } from '../src/types/vm';
import type { VmConfigResult, VmConfigScan } from '../src/types/vm';

/**
 * Pure checks (no server, in-memory store) for configuration results (issue #103): the rule map against the real catalogs, the
 * payload adapter, the suggestion rules and the memory store. Nothing here writes a control.
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

const PREFIX = 'xccdf_org.ssgproject.content_rule_';

async function main() {
  // ---------------------------------------------------------------------------------------------- rule map
  console.log('\n--- rule map ---');
  const l2 = new Set(getFrameworkControls('CMMC_L2').map((c) => c.id));
  const l1 = new Set(getFrameworkControls('CMMC_L1').map((c) => c.id));
  const nist = new Set(getFrameworkControls('NIST_800_53_REV5').map((c) => c.id));
  const badL2 = CONFIG_RULE_MAPPINGS.filter((m) => !l2.has(m.controlId)).map((m) => m.ruleId);
  assert(CONFIG_RULE_MAPPINGS.length === 23 && badL2.length === 0, 'C1: every mapped control id exists in the CMMC Level 2 catalog', badL2);
  const badL1 = CONFIG_RULE_MAPPINGS.filter((m) => m.controlId.includes('.L1-') && !l1.has(m.controlId)).map((m) => m.ruleId);
  assert(badL1.length === 0, 'C2: every Level 1 id exists in the CMMC Level 1 catalog', badL1);
  const badNist = CONFIG_RULE_MAPPINGS.filter((m) => !nist.has(m.nist80053)).map((m) => m.ruleId);
  assert(badNist.length === 0, 'C3: every 800-53 id exists in the NIST SP 800-53 Rev. 5 catalog', badNist);
  assert(mapConfigRule({ ruleId: PREFIX + 'sshd_disable_root_login' })?.controlId === 'AC.L1-3.1.1', 'C4: a full XCCDF rule id maps to AC.L1-3.1.1');
  assert(mapConfigRule({ ruleId: 'sshd_disable_root_login' })?.controlId === 'AC.L1-3.1.1', 'C5: the short rule id maps too');
  assert(mapConfigRule({ ruleId: 'x', cce: 'CCE-27445-6' })?.controlId === 'AC.L2-3.1.10', 'C6: a CCE maps (the level comes from the catalog)');
  assert(mapConfigRule({ ruleId: 'x', cce: 'cce-27445-6' })?.controlId === 'AC.L2-3.1.10', 'C6b: the CCE match is case-insensitive');
  assert(mapConfigRule({ ruleId: '' }) === null, 'C7a: an empty rule id maps to nothing');
  assert(mapConfigRule({ ruleId: 'login' }) === null, 'C7b: a partial rule id maps to nothing (no substring match)');
  assert(mapConfigRule({ ruleId: PREFIX + 'sshd_disable_root_login_extra' }) === null, 'C7c: a longer rule id maps to nothing');
  assert(normalizeRuleId(PREFIX + 'a_b') === 'a_b' && normalizeRuleId('a_b') === 'a_b', 'normalizeRuleId strips only the SSG prefix');
  const distinct = new Set(CONFIG_RULE_MAPPINGS.map((m) => m.controlId));
  console.log(`  (info) ${CONFIG_RULE_MAPPINGS.length} rules map to ${distinct.size} CMMC controls and ${new Set(CONFIG_RULE_MAPPINGS.map((m) => m.nist80053)).size} 800-53 controls`);
  assert(distinct.size > 0, 'C8: the distinct control count is computed');
  assert(controlsForRule({ ruleId: 'sshd_set_idle_timeout' }, 'CMMC_L1').length === 0, 'a Level 2 practice is not offered to a Level 1 program');
  assert(controlsForRule({ ruleId: 'sshd_set_idle_timeout' }, 'NIST_800_53_REV5').join() === 'AC-11', 'the 800-53 id for NIST programs');
  assert(controlsForRule({ ruleId: 'sshd_set_idle_timeout' }, 'SOC_2_TYPE_II').length === 0, 'no controls for SOC 2');

  // ---------------------------------------------------------------------------------------------- adapter
  console.log('\n--- adapter ---');
  const raw = {
    source: { kind: 'SCAP', label: 'openscap' },
    exporter: { name: 'pbc-vm-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: [
      {
        agent_id: 'xccdf-1',
        hostname: 'cfg-host-01',
        configuration: [
          {
            benchmark: { id: 'bench-a', version: '1' },
            profile: { id: 'prof-a' },
            scanner: { name: 'OpenSCAP' },
            started_at: '2026-10-18T11:00:00+02:00',
            scanned_at: '2026-10-18T11:05:00+02:00',
            results: [
              { rule_id: 'z_rule', result: 'pass' },
              { rule_id: 'a_rule', result: 'fail', severity: 'high', title: 'A rule', cce: 'CCE-27286-4' },
              { rule_id: 'b_rule', result: 'fail' },
              { rule_id: 'c_rule', result: 'notapplicable' },
              { rule_id: 'd_rule', result: 'error' },
            ],
          },
        ],
      },
      { agent_id: 'plain', findings: [] },
    ],
  };
  const validated = validateIngestPayload(raw);
  assert(validated.ok, 'the adapter fixture validates', validated.ok ? '' : validated.error);
  if (!validated.ok) throw new Error('fixture invalid');
  const normalized = normalizeConfiguration(validated.value);
  const scans = normalized.get('xccdf-1') ?? [];
  assert(normalized.size === 1 && scans.length === 1 && !normalized.has('plain'), 'N1a: only hosts with configuration are listed');
  const expectedCounts = { ...emptyResultCounts(), pass: 1, fail: 2, notapplicable: 1, error: 1 };
  assert(JSON.stringify(scans[0]?.counts) === JSON.stringify(expectedCounts), 'N1: counts per result value, all nine present', scans[0]?.counts);
  assert(scans[0]?.scannedAt === '2026-10-18T09:05:00.000Z' && scans[0]?.startedAt === '2026-10-18T09:00:00.000Z', 'N1: times are ISO in UTC', [scans[0]?.scannedAt, scans[0]?.startedAt]);
  assert(scans[0]?.results.map((r) => r.ruleId).join() === 'a_rule,b_rule,c_rule,d_rule,z_rule', 'rules are sorted by id');
  assert(scans[0]?.results[0].cce === 'CCE-27286-4' && scans[0]?.results[0].severity === 'high' && scans[0]?.results[1].severity === null && scans[0]?.profileId === 'prof-a', 'optional fields are carried or null');
  assert(Object.keys(emptyResultCounts()).join() === VM_CONFIG_RESULTS.join(), 'emptyResultCounts follows VM_CONFIG_RESULTS');

  // ---------------------------------------------------------------------------------------------- suggestions
  console.log('\n--- suggestions ---');
  let seq = 0;
  const T1 = '2026-10-01T10:00:00.000Z';
  const T2 = '2026-10-02T10:00:00.000Z';
  const mkScan = (assetId: string, over: Partial<VmConfigScan> = {}): VmConfigScan => ({
    id: `scan-${++seq}`,
    tenantId: 't',
    runId: `run-${seq}`,
    sourceId: 'src',
    assetId,
    benchmarkId: 'bench',
    benchmarkVersion: '',
    benchmarkTitle: '',
    profileId: 'prof',
    profileTitle: '',
    scannerName: 'OpenSCAP',
    scannerVersion: '',
    startedAt: null,
    scannedAt: T1,
    receivedAt: T1,
    sourceSha256: null,
    resultCounts: emptyResultCounts(),
    ...over,
  });
  const row = (scan: VmConfigScan, ruleId: string, result: VmConfigResult, cce: string | null = null): SuggestionResultRow => ({ scanId: scan.id, ruleId, cce, result });
  const asset = (id: string, over: Partial<SuggestionAsset> = {}): SuggestionAsset => ({ id, discoveryStatus: 'ACTIVE', cmmcCategory: 'CUI_ASSET', ...over });
  const ROOT = PREFIX + 'sshd_disable_root_login';
  const find = (r: ReturnType<typeof computeConfigSuggestions>, id: string) => r.controls.find((c) => c.controlId === id);

  const sA = mkScan('A');
  const sB = mkScan('B');
  const s1 = computeConfigSuggestions({ scans: [sA, sB], results: [row(sA, ROOT, 'pass'), row(sB, ROOT, 'fail')], boundary: { declared: true, assets: [asset('A'), asset('B')] }, framework: 'CMMC_L2' });
  const c1 = find(s1, 'AC.L1-3.1.1');
  assert(c1?.suggestion === 'NOT_MET' && c1.assets.failing === 1 && c1.assets.passing === 1 && JSON.stringify(c1.failingAssetIds) === '["B"]', 'S1: one failing asset gives NOT_MET and names it', c1);
  assert(s1.supported === true && s1.inScope === 2 && s1.evaluated === 2, 'S1: in-scope and evaluated counts');
  const s2a = computeConfigSuggestions({ scans: [sA, sB], results: [row(sA, ROOT, 'pass'), row(sB, ROOT, 'pass')], boundary: { declared: true, assets: [asset('A'), asset('B')] }, framework: 'CMMC_L2' });
  assert(find(s2a, 'AC.L1-3.1.1')?.suggestion === 'MET', 'S2a: every in-scope asset evaluated and passing gives MET');
  const s2b = computeConfigSuggestions({ scans: [sA, sB], results: [row(sA, ROOT, 'pass'), row(sB, ROOT, 'pass')], boundary: { declared: true, assets: [asset('A'), asset('B'), asset('C')] }, framework: 'CMMC_L2' });
  assert(find(s2b, 'AC.L1-3.1.1')?.suggestion === 'REVIEW' && s2b.evaluated === 2 && s2b.inScope === 3, 'S2b: an asset with no scan gives REVIEW, not MET');

  const sOld = mkScan('A', { scannedAt: T1, receivedAt: '2026-10-03T00:00:00.000Z' });
  const sNew = mkScan('A', { scannedAt: T2, receivedAt: '2026-10-02T10:00:01.000Z' });
  assert(selectLatestScans([sOld, sNew])[0].id === sNew.id, 'S3: the latest scan is chosen by scan time, not by receipt');
  const s3 = computeConfigSuggestions({ scans: [sOld, sNew], results: [row(sOld, ROOT, 'fail'), row(sNew, ROOT, 'pass')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(find(s3, 'AC.L1-3.1.1')?.suggestion === 'MET' && find(s3, 'AC.L1-3.1.1')?.assets.failing === 0, 'S3: a later pass supersedes an earlier fail');

  const s4a = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'error')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(find(s4a, 'AC.L1-3.1.1')?.suggestion === 'REVIEW' && find(s4a, 'AC.L1-3.1.1')?.assets.error === 1, 'S4a: errors only give REVIEW');
  const s4b = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'notapplicable')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(find(s4b, 'AC.L1-3.1.1') === undefined && s4b.controls.length === 0, 'S4b: notapplicable alone gives no suggestion for the control');

  const sD = mkScan('D');
  const sO = mkScan('O');
  const sX = mkScan('X');
  const s5 = computeConfigSuggestions({
    scans: [sA, sD, sO, sX],
    results: [row(sA, ROOT, 'pass'), row(sD, ROOT, 'fail'), row(sO, ROOT, 'fail'), row(sX, ROOT, 'fail')],
    boundary: { declared: true, assets: [asset('A'), asset('D', { discoveryStatus: 'DECOMMISSIONED' }), asset('O', { cmmcCategory: 'OUT_OF_SCOPE' })] },
    framework: 'CMMC_L2',
  });
  assert(find(s5, 'AC.L1-3.1.1')?.suggestion === 'MET' && s5.inScope === 1, 'S5: decommissioned, out-of-scope and outside-boundary assets are ignored', find(s5, 'AC.L1-3.1.1'));
  const sU = mkScan('U');
  const s5b = computeConfigSuggestions({ scans: [sU], results: [row(sU, ROOT, 'pass')], boundary: { declared: false, assets: [asset('U', { discoveryStatus: 'UNCONFIRMED_DISCOVERY' })] }, framework: 'CMMC_L2' });
  assert(find(s5b, 'AC.L1-3.1.1')?.assets.unconfirmed === 1 && find(s5b, 'AC.L1-3.1.1')?.assets.inScope === 1, 'S5b: an unconfirmed asset counts and is counted separately');

  const IDLE = PREFIX + 'sshd_set_idle_timeout';
  const s6 = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'pass'), row(sA, IDLE, 'fail')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L1' });
  assert(s6.controls.length > 0 && s6.controls.every((c) => !c.controlId.includes('.L2-')), 'S6: a Level 1 program gets no Level 2 control');
  const s7 = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'pass'), row(sA, 'foo_bar', 'fail')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(s7.unmappedRuleCount === 1 && find(s7, 'AC.L1-3.1.1')?.suggestion === 'MET', 'S7: an unknown rule is counted, not mapped');
  const sA2 = mkScan('A', { benchmarkId: 'other-bench' });
  const s8 = computeConfigSuggestions({ scans: [sA, sA2], results: [row(sA, ROOT, 'pass'), row(sA2, ROOT, 'fail')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(find(s8, 'AC.L1-3.1.1')?.suggestion === 'NOT_MET' && find(s8, 'AC.L1-3.1.1')?.assets.failing === 1, 'S8: a fail in any of an asset\'s benchmarks fails the asset');
  const s9 = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'fail')], boundary: { declared: true, assets: [asset('A')] }, framework: 'SOC_2_TYPE_II' });
  assert(s9.supported === false && s9.controls.length === 0, 'S9: SOC 2 is not supported and gets no controls');
  const s10 = computeConfigSuggestions({ scans: [sA], results: [row(sA, ROOT, 'fail')], boundary: { declared: true, assets: [asset('A')] }, framework: 'NIST_800_53_REV5' });
  assert(find(s10, 'AC-2')?.suggestion === 'NOT_MET' && s10.controls.every((c) => nist.has(c.controlId)), 'S10: NIST SP 800-53 programs get 800-53 ids');
  const s11 = computeConfigSuggestions({ scans: [sA], results: [row(sA, 'x', 'pass', 'CCE-27286-4')], boundary: { declared: true, assets: [asset('A')] }, framework: 'CMMC_L2' });
  assert(find(s11, 'AC.L1-3.1.1')?.suggestion === 'MET', 'S11: a rule is also found by its CCE');

  // ---------------------------------------------------------------------------------------------- memory store
  console.log('\n--- memory store ---');
  __resetVmConfigForTests();
  const draft = (assetId: string) => ({ assetId, scan: scans[0] });
  const run = { id: 'run-1', sourceId: 'src-1', receivedAt: '2026-10-18T12:00:00.000Z' };
  const stored1 = await replaceRunConfigScans('t1', run, [draft('A'), draft('B')], null);
  const stored2 = await replaceRunConfigScans('t1', run, [draft('A'), draft('B')], null);
  const list = await listConfigScans('t1', { latestOnly: false, limit: 100 });
  assert(stored1 === 10 && stored2 === 10 && list.totalCount === 2 && list.scans.length === 2, 'replaceRunConfigScans is idempotent (a second pass replaces, never adds)', [stored1, stored2, list.totalCount]);
  assert((await replaceRunConfigScans('t1', { ...run, id: 'run-2' }, [draft('A'), draft('A')], null)) === 5, 'a repeated (asset, benchmark, profile, time) in one run is stored once');
  assert((await listConfigScans('t1', { latestOnly: false, limit: 100 })).totalCount === 3, 'another run adds its own scans');
  const latest = await listConfigScans('t1', { latestOnly: true, limit: 100 });
  assert(latest.totalCount === 2, 'latestOnly keeps one scan per asset, source, benchmark and profile', latest.totalCount);
  assert((await listConfigScans('t1', { assetId: 'B', latestOnly: false, limit: 100 })).totalCount === 1, 'assetId filters');
  assert((await listConfigScans('t1', { latestOnly: false, limit: 1 })).scans.length === 1 && (await listConfigScans('t1', { latestOnly: false, limit: 1 })).totalCount === 3, 'limit cuts the page, not the count');
  assert((await listConfigScans('t2', { latestOnly: false, limit: 100 })).totalCount === 0, 'scans are tenant scoped');
  const first = list.scans[0];
  assert((await getConfigScan('t1', first.id))?.id === first.id && (await getConfigScan('t2', first.id)) === null, 'getConfigScan is tenant scoped');
  const res = await listConfigResults('t1', first.id, { limit: 100 });
  assert(res.totalCount === 5 && res.results[0].ruleId === 'a_rule', 'listConfigResults returns the rules by id', res.results.map((r) => r.ruleId));
  const failOnly = await listConfigResults('t1', first.id, { result: 'fail', limit: 100 });
  assert(failOnly.totalCount === 2 && failOnly.results.every((r) => r.result === 'fail'), 'listConfigResults filters by result');
  assert((await listConfigResults('t2', first.id, { limit: 100 })).totalCount === 0, 'results are tenant scoped');
  const loaded = await loadLatestConfigResults('t1', ['A']);
  assert(loaded.scans.length === 1 && loaded.results.length === 5, 'loadLatestConfigResults loads the newest scans of the given assets only', [loaded.scans.length, loaded.results.length]);
  assert((await loadLatestConfigResults('t1', [])).scans.length === 0, 'no assets, nothing loaded');
  await replaceRunConfigScans('t1', run, [], null);
  assert((await listConfigScans('t1', { assetId: 'B', latestOnly: false, limit: 100 })).totalCount === 0, 'reprocessing a run that now has no scans removes its old ones');
  __resetVmConfigForTests();
  assert((await listConfigScans('t1', { latestOnly: false, limit: 100 })).totalCount === 0, '__resetVmConfigForTests empties the store');

  // ---------------------------------------------------------------------------------------------- invariants
  console.log('\n--- invariants ---');
  const read = (p: string) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  for (const file of ['../server/vm/worker.ts', '../server/vm/configStore.ts', '../server/vm/configSuggestions.ts', '../server/vm/adapters/config.ts']) {
    const text = read(file);
    assert(!text.includes('writeControlAssessment') && !text.includes('control_assessments') && !text.includes('controlAssessments'), `N2: ${file.slice(3)} never writes a control`);
  }

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  if (passed !== total) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
