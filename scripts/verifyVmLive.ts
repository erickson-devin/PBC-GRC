/**
 * Live verification of the vulnerability-management token and run stores against a REAL PostgreSQL database.
 *
 *   DATABASE_URL=postgres://grc_app:...@host:5432/db npm run db:verify-vm
 *   (or the DB_HOST / DB_USER / DB_PASS / DB_NAME variables the server uses)
 *
 * Why it exists: the HTTP suite tests/vmIngest.test.ts can only run in memory mode (tests/testEnv.ts pins DB_MODE=memory by
 * design), so this script is how the PostgreSQL branches of server/vm/tokens.ts and server/vm/store.ts are proven. It is
 * NOT part of test:all. Run it against a throwaway database, as the ordinary application role (not a superuser and not
 * BYPASSRLS: those roles skip row-level security, which would hide exactly the failures this script looks for).
 *
 * Runs initDb(), then exercises the real exported functions: service-token create / hash-only storage / discovery lookup /
 * throttled last_used_at / list / cap / revoke, and run-store receive / dedupe / source resolution / list / update, each
 * under two tenants to prove isolation, then the normalization worker end to end (findings, closure, assets, a forced failure that
 * must roll the whole run back, reprocess idempotence), and finally the scheduler (section 14: the cross-tenant enumeration
 * policy, stale_since, the snapshot evidence files and rows, the control notes block; section 15: the control assessment history; section 16: staleness from the last normalized run and its backfill, issue #59; section 17: a failed snapshot leaves no row, event or file, issue #56; section 18: two managers of one kind keep separate agent ids and a finding closes only when no other source still lists it, issue #62 and #63; section 19: legacy bare-kind agent id keys are rewritten, issue #63; section 20: configuration scan results, issue #103; section 21: affected packages, issue #267; section 22: one POA&M item per finding episode and program, and the snapshot's POA&M count on PostgreSQL, issue #275; section 23: the POA&M read view, issue #274; section 24: the program-wide scanner inventory reads, package grouping, hotfix exclusion, limit, ordering and asset restriction, issue #279; section 25: POA&M completion, issue #295; section 26: editing a POA&M item, issue #297). It inserts and removes rows named
 * "vm_verify..." / "vm-verify..." (and "VM-VERIFY-" and "CVE-2099-" rows in vm_vulns), the snapshot evidence and control
 * rows of the two verify tenants, and payload and snapshot files under the tenant's vault directory.
 * Exit code 0 = all checks passed.
 */
// Type-only (erased at run time): the Express Request augmentation (req.tenantId) lives here, and the framework guard that
// the snapshot writer imports needs it when this script is type-checked on its own.
import type {} from '../server/middleware/authMiddleware';

export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const crypto = await import('crypto');
const fs = await import('fs');
const path = await import('path');
const { pool, initDb, queryWithTenant, queryWithProgram, checkDatabaseConnection } = await import('../server/db');
const { createVmToken, listVmTokens, revokeVmToken, lookupVmTokenByHash, sha256Hex, VmTokenError, VM_TOKEN_PATTERN, MAX_ACTIVE_TOKENS_PER_TENANT } =
  await import('../server/vm/tokens');
const { recordReceivedRun, findRunBySha, getRun, listRuns, listSources, resetRunForReprocess, updateRun, enumerateSchedulerSources, VmStoreError } = await import('../server/vm/store');
const { VmPoamEditError, getVmPoamRow, listFindings, listVmPoamItemEvents, loadSnapshotFindings, loadVmPoamView, updateVmPoamItem, withVmTenantTx } = await import('../server/vm/findingsStore');
const { createAgentReportedAsset } = await import('../server/assets');
const { replaceHostInventory, aggregateObservedSoftware, listObservedHostsForAssets } = await import('../server/vm/inventoryStore');
const { enqueueVmRun, __drainVmWorkerForTests, __setVmWorkerFaultForTests } = await import('../server/vm/worker');
const { runVmSchedulerTick } = await import('../server/vm/scheduler');
const { runVmSnapshot, latestSnapshotAt, loadSnapshotInput, __setVmSnapshotFaultForTests } = await import('../server/vm/snapshotWriter');
const { StaleWriteError, writeControlAssessment, listControlAssessmentEvents, readControlAssessments } = await import('../server/controlAssessments');
const { archiveProgram, createProgram, listPrograms, resolveVmTargetProgram, setVmTargetProgram } = await import('../server/programs');
const { VM_NOTES_BEGIN, computeSnapshot, getVmSnapshotConfig } = await import('../server/vm/snapshot');
const { localStorageRoot } = await import('../server/evidence/storage');
const { validateIngestPayload } = await import('../server/vm/ingestSchema');

// The control history and answers are program-scoped: the VM snapshot writes into the tenant's VM target (its first program, the organization default).
// A tenant starts with no program: the first scopeOf call creates it.
const scopeOf = async (tenantId: string) => {
  const existing = (await listPrograms(tenantId))[0] ?? (await createProgram(tenantId, { name: 'VM Verify Boundary', frameworkId: 'CMMC_L2' }, 'vm_verify'));
  return { tenantId, programId: existing.id };
};

let failures = 0;
function check(ok: boolean, message: string, detail?: string) {
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}: ${message}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
}

const TENANT_X = 'vm_verify_tenant_x';
const TENANT_Y = 'vm_verify_tenant_y';
/** Payload files written by section 11 onward; removed in the cleanup. */
const rawFiles: string[] = [];

/** Runs `fn`, returning the thrown value (or null when it did not throw). */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}
const describe = (err: unknown): string => (err === null ? 'no error' : `${(err as Error)?.name}: ${(err as Error)?.message}`);
const isTokenError = (err: unknown, code: string): boolean => err instanceof VmTokenError && err.code === code;
const isStoreError = (err: unknown, code: string): boolean => err instanceof VmStoreError && err.code === code;

async function main() {
  if (!(await checkDatabaseConnection())) {
    console.error('Cannot connect to PostgreSQL; set DATABASE_URL (or DB_HOST/DB_USER/DB_PASS/DB_NAME).');
    process.exit(2);
  }

  console.log('--- 1. Connection and initDb ---');
  await initDb();
  const version = await pool.query("SELECT current_setting('server_version') AS v");
  check(true, `connected; initDb() completed (PostgreSQL ${version.rows[0]?.v})`);

  try {
    console.log('\n--- 2. createVmToken ---');
    const created = await createVmToken(TENANT_X, { name: 'vm_verify_token', scopes: ['vm:ingest'], createdBy: 'vm_verify', createdByUserId: null });
    const { token, record } = created;
    check(VM_TOKEN_PATTERN.test(token), 'the token matches VM_TOKEN_PATTERN');
    check(record.tokenPrefix === token.slice(0, 12), 'tokenPrefix is the first 12 characters of the token', record.tokenPrefix);
    check(!('tokenHash' in record) && !('token_hash' in record), 'the returned record has no token hash');
    const days = (new Date(record.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    check(days > 364 && days < 366, 'expiresAt is about 365 days ahead', `${days.toFixed(2)} days`);

    console.log('\n--- 3. Only the hash is stored ---');
    const stored = await queryWithTenant(TENANT_X, "SELECT token_hash, row_to_json(t)::text AS whole FROM vm_service_tokens t WHERE name = 'vm_verify_token'", []);
    check(stored.rows.length === 1, 'tenant X reads back exactly its token row', `saw ${stored.rows.length}`);
    check(stored.rows[0]?.token_hash === sha256Hex(token), 'token_hash equals sha256Hex(token)');
    check(!String(stored.rows[0]?.whole ?? '').includes(token), 'the plaintext token does not appear anywhere in the stored row');

    console.log('\n--- 4. lookupVmTokenByHash ---');
    const hash = sha256Hex(token);
    const first = await lookupVmTokenByHash(hash);
    check(first !== null && first.tenantId === TENANT_X, 'lookup by hash finds the token and reports its tenant', JSON.stringify(first));
    check(first !== null && first.lastUsedAt !== null, 'the lookup set last_used_at (discovery read, tenant switch and write in one transaction)');
    const second = await lookupVmTokenByHash(hash);
    check(second !== null && second.lastUsedAt === first?.lastUsedAt, 'an immediate second lookup leaves last_used_at unchanged (throttled)', `${first?.lastUsedAt} vs ${second?.lastUsedAt}`);
    check((await lookupVmTokenByHash('f'.repeat(64))) === null, 'an unknown hash returns null');
    check((await lookupVmTokenByHash('zz')) === null, 'a malformed hash returns null');

    console.log('\n--- 5. No tenant context ---');
    const noContext = await pool.query("SELECT 1 FROM vm_service_tokens WHERE name = 'vm_verify_token'");
    check(noContext.rowCount === 0, 'no tenant context => zero token rows visible', `saw ${noContext.rowCount}`);

    console.log('\n--- 6. listVmTokens ---');
    const listX = await listVmTokens(TENANT_X);
    check(listX.some((t) => t.id === record.id), 'listVmTokens(X) contains the token');
    const listJson = JSON.stringify(listX);
    check(!listJson.includes(token) && !listJson.includes(hash), 'the list contains neither the token nor its hash');
    const listY = await listVmTokens(TENANT_Y);
    check(listY.length === 0, 'listVmTokens(Y) is empty', `saw ${listY.length}`);

    console.log('\n--- 7. Cap and revoke ---');
    const extra: { id: string; token: string }[] = [];
    for (let n = 1; n < MAX_ACTIVE_TOKENS_PER_TENANT; n++) {
      const c = await createVmToken(TENANT_X, { name: `vm_verify_token_${n}`, scopes: ['vm:ingest'], createdBy: 'vm_verify', createdByUserId: null });
      extra.push({ id: c.record.id, token: c.token });
    }
    const activeNow = (await listVmTokens(TENANT_X)).filter((t) => !t.revokedAt && new Date(t.expiresAt).getTime() > Date.now()).length;
    check(activeNow === MAX_ACTIVE_TOKENS_PER_TENANT, `tenant X now has ${MAX_ACTIVE_TOKENS_PER_TENANT} active tokens`, `saw ${activeNow}`);
    const overLimit = await thrown(() => createVmToken(TENANT_X, { name: 'vm_verify_token_over', scopes: ['vm:ingest'], createdBy: 'vm_verify', createdByUserId: null }));
    check(isTokenError(overLimit, 'limit'), 'one more token is refused with VmTokenError "limit"', describe(overLimit));

    const victim = extra[0];
    const revoked = await revokeVmToken(TENANT_X, victim.id);
    check(Boolean(revoked.revokedAt), 'revokeVmToken sets revokedAt', JSON.stringify(revoked));
    const revokedAgain = await revokeVmToken(TENANT_X, victim.id);
    check(revokedAgain.revokedAt === revoked.revokedAt, 'a second revoke is idempotent (same revokedAt)', `${revoked.revokedAt} vs ${revokedAgain.revokedAt}`);
    const afterRevoke = await thrown(() => createVmToken(TENANT_X, { name: 'vm_verify_token_again', scopes: ['vm:ingest'], createdBy: 'vm_verify', createdByUserId: null }));
    check(afterRevoke === null, 'after a revoke a new token can be created again', describe(afterRevoke));
    const crossRevoke = await thrown(() => revokeVmToken(TENANT_Y, record.id));
    check(isTokenError(crossRevoke, 'not_found'), "tenant Y cannot revoke tenant X's token (VmTokenError \"not_found\")", describe(crossRevoke));
    const stillThere = await lookupVmTokenByHash(sha256Hex(victim.token));
    check(stillThere !== null && Boolean(stillThere.revokedAt), 'lookup of a revoked token still returns the record with revokedAt set (the middleware does the 401)', JSON.stringify(stillThere));

    console.log('\n--- 8. Run store ---');
    const SHA_A = 'a'.repeat(64);
    const input = {
      id: crypto.randomUUID(),
      kind: 'WAZUH' as const,
      label: 'vm_verify_src',
      collectedAt: new Date().toISOString(),
      exporterName: 'vm-verify',
      exporterVersion: '0.0.0',
      hostCount: 1,
      findingCount: 1,
      rawPath: '/vm_verify/raw.json',
      rawSha256: SHA_A,
      rawBytes: 2,
    };
    const received = await recordReceivedRun(TENANT_X, input);
    check(received.run.status === 'RECEIVED', 'recordReceivedRun returns a run in status RECEIVED', received.run.status);
    check(received.source.kind === 'WAZUH', 'the source was created with the run kind', received.source.kind);
    check(received.source.lastRunId === received.run.id, 'source.lastRunId points at the new run');
    check(received.source.expectedIntervalMinutes === 1440, 'source.expectedIntervalMinutes defaults to 1440', String(received.source.expectedIntervalMinutes));
    const bySha = await findRunBySha(TENANT_X, SHA_A);
    check(bySha !== null && bySha.id === received.run.id, 'findRunBySha(X) finds the run');
    check((await findRunBySha(TENANT_Y, SHA_A)) === null, 'findRunBySha(Y) does not see tenant X\'s run');
    const upper = await recordReceivedRun(TENANT_X, { ...input, id: crypto.randomUUID(), label: 'VM_VERIFY_SRC', rawSha256: 'b'.repeat(64), rawPath: '/vm_verify/raw2.json' });
    check(upper.source.id === received.source.id, 'the same label in another case resolves to the same source (case-insensitive)', `${upper.source.id} vs ${received.source.id}`);
    const dup = await thrown(() => recordReceivedRun(TENANT_X, { ...input, id: crypto.randomUUID() }));
    check(isStoreError(dup, 'duplicate'), 'the same raw sha256 again is refused with VmStoreError "duplicate"', describe(dup));
    const mismatch = await thrown(() => recordReceivedRun(TENANT_X, { ...input, id: crypto.randomUUID(), kind: 'NUCLEI', rawSha256: 'c'.repeat(64), rawPath: '/vm_verify/raw3.json' }));
    check(isStoreError(mismatch, 'source_kind_mismatch'), 'the same label with another kind is refused with "source_kind_mismatch"', describe(mismatch));
    const runsX = await listRuns(TENANT_X);
    check(runsX.length === 2, 'listRuns(X) returns the two stored runs (the refused ones left nothing behind)', `saw ${runsX.length}`);
    check(runsX.length === 2 && runsX[0].id === upper.run.id && runsX[1].id === received.run.id, 'listRuns(X) is newest first', JSON.stringify(runsX.map((r) => r.id)));
    check((await listRuns(TENANT_Y)).length === 0, 'listRuns(Y) is empty');
    const sourcesX = await listSources(TENANT_X);
    check(sourcesX.length === 1, 'listSources(X) returns exactly one source', `saw ${sourcesX.length}`);
    const patched = await updateRun(TENANT_X, received.run.id, { status: 'NORMALIZED', finishedAt: new Date().toISOString() });
    check(patched.status === 'NORMALIZED' && patched.finishedAt !== null, 'updateRun applies the status and finishedAt patch', JSON.stringify(patched));
    const crossUpdate = await thrown(() => updateRun(TENANT_Y, received.run.id, { status: 'NORMALIZED', finishedAt: new Date().toISOString() }));
    check(isStoreError(crossUpdate, 'not_found'), "tenant Y cannot update tenant X's run (VmStoreError \"not_found\")", describe(crossUpdate));

    console.log('\n--- 9. vm_vulns source default and CHECK ---');
    await pool.query("INSERT INTO vm_vulns (vuln_id) VALUES ('VM-VERIFY-0001') ON CONFLICT DO NOTHING");
    const vuln = await pool.query("SELECT source FROM vm_vulns WHERE vuln_id = 'VM-VERIFY-0001'");
    check(vuln.rows[0]?.source === 'INGEST', "vm_vulns.source defaults to 'INGEST'", String(vuln.rows[0]?.source));
    const bogus = (await thrown(() => pool.query("UPDATE vm_vulns SET source = 'BOGUS' WHERE vuln_id = 'VM-VERIFY-0001'"))) as { code?: string; constraint?: string } | null;
    check(bogus !== null && bogus.code === '23514' && bogus.constraint === 'vm_vulns_source_check', "a source outside the allowed list is refused by vm_vulns_source_check", `code ${bogus?.code}, constraint ${bogus?.constraint}`);

    console.log('\n--- 10. validateIngestPayload ---');
    const verdict = validateIngestPayload({
      source: { kind: 'WAZUH', label: 'vm_verify_src' },
      exporter: { name: 'vm-verify', version: '0.0.0' },
      collected_at: new Date().toISOString(),
      hosts: [],
    });
    check(verdict.ok, 'a minimal valid payload is accepted under NODE_ENV=production', verdict.ok ? '' : verdict.error);
    console.log('\n--- 11. Worker end to end ---');
    const writeRun = async (label: string, collectedAt: string, hosts: Array<{ agent: string; name: string; cves: Array<[string, string] | [string, string, { name: string; version: string; fixed_version: string | null }]> }>, tenant = TENANT_X) => {
      const id = crypto.randomUUID();
      const bytes = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          source: { kind: 'WAZUH', label },
          exporter: { name: 'vm-verify', version: '0.0.0' },
          collected_at: collectedAt,
          hosts: hosts.map((h) => ({ agent_id: h.agent, hostname: h.name, findings: h.cves.map(([vuln_id, severity, pkg]) => ({ vuln_id, severity, ...(pkg ? { package: pkg } : {}) })) })),
        }),
      );
      const file = path.join(localStorageRoot(), 'tenants', tenant, 'vm', 'runs', `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      rawFiles.push(file);
      await recordReceivedRun(tenant, {
        id,
        kind: 'WAZUH',
        label,
        collectedAt,
        exporterName: 'vm-verify',
        exporterVersion: '0.0.0',
        hostCount: hosts.length,
        findingCount: hosts.reduce((n, h) => n + h.cves.length, 0),
        rawPath: file,
        rawSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        rawBytes: bytes.length,
      });
      return id;
    };
    const count = async (sql: string, params: string[]): Promise<number> => Number((await queryWithTenant(TENANT_X, sql, params)).rows[0]?.n);

    const workerRun1 = await writeRun('vm_verify_worker', '2099-01-01T00:00:00Z', [
      { agent: 'vmv-1', name: 'vm-verify-h1', cves: [['CVE-2099-0001', 'HIGH'], ['CVE-2099-0002', 'LOW']] },
      { agent: 'vmv-2', name: 'vm-verify-h2', cves: [['CVE-2099-0001', 'HIGH']] },
    ]);
    enqueueVmRun(TENANT_X, workerRun1);
    await __drainVmWorkerForTests();
    const normalized = await getRun(TENANT_X, workerRun1);
    check(normalized?.status === 'NORMALIZED' && normalized.error === null && normalized.finishedAt !== null, 'the worker normalizes the run (NORMALIZED, finishedAt set)', JSON.stringify(normalized));
    const open = await listFindings(TENANT_X, { limit: 100 });
    check(open.length === 3 && open.every((f) => f.status === 'OPEN'), 'listFindings(X) holds 3 OPEN findings', JSON.stringify(open.map((f) => [f.vulnId, f.status])));
    const agentAssets = await queryWithTenant(TENANT_X, "SELECT asset_name, source_origin, discovery_status, cmmc_category FROM enclave_assets WHERE tenant_id = $1 AND asset_name LIKE 'vm-verify%' ORDER BY asset_name", [TENANT_X]);
    check(
      agentAssets.rows.length === 2 && agentAssets.rows.every((r) => r.source_origin === 'AGENT_REPORT' && r.discovery_status === 'UNCONFIRMED_DISCOVERY' && r.cmmc_category === 'CONTRACTOR_RISK'),
      'two AGENT_REPORT / UNCONFIRMED_DISCOVERY / CONTRACTOR_RISK assets were created',
      JSON.stringify(agentAssets.rows),
    );
    check((await listFindings(TENANT_Y, { limit: 100 })).length === 0, 'listFindings(Y) is empty');
    check((await count('SELECT count(*)::int AS n FROM vm_run_assets WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun1])) === 2, 'vm_run_assets records the 2 assets the first run reported (#62)');
    const workerSourceId = (await listSources(TENANT_X)).find((s) => s.label === 'vm_verify_worker')?.id;
    const h1Keys = await queryWithTenant(TENANT_X, "SELECT agent_ids FROM enclave_assets WHERE tenant_id = $1 AND asset_name = 'vm-verify-h1'", [TENANT_X]);
    check(
      JSON.stringify(h1Keys.rows[0]?.agent_ids) === JSON.stringify({ [`wazuh:${workerSourceId}`]: 'vmv-1' }),
      'the agent id is stored under wazuh:<source id>, with no bare "wazuh" key (#63)',
      JSON.stringify(h1Keys.rows[0]?.agent_ids),
    );

    const workerRun2 = await writeRun('vm_verify_worker', '2099-01-02T00:00:00Z', [
      { agent: 'vmv-1', name: 'vm-verify-h1', cves: [['CVE-2099-0001', 'HIGH']] },
      { agent: 'vmv-2', name: 'vm-verify-h2', cves: [['CVE-2099-0001', 'HIGH']] },
    ]);
    enqueueVmRun(TENANT_X, workerRun2);
    await __drainVmWorkerForTests();
    const closed = await queryWithTenant(TENANT_X, "SELECT status, resolved_run_id FROM vm_findings WHERE tenant_id = $1 AND vuln_id = 'CVE-2099-0002'", [TENANT_X]);
    check(closed.rows.length === 1 && closed.rows[0].status === 'RESOLVED' && closed.rows[0].resolved_run_id === workerRun2, 'the omitted finding is RESOLVED with resolved_run_id = the second run', JSON.stringify(closed.rows));
    check((await count("SELECT count(*)::int AS n FROM vm_findings WHERE tenant_id = $1 AND status = 'OPEN'", [TENANT_X])) === 2, 'the other findings stay OPEN');

    console.log('\n--- 12. Rollback ---');
    __setVmWorkerFaultForTests('after_save');
    const workerRun3 = await writeRun('vm_verify_worker', '2099-01-03T00:00:00Z', [
      { agent: 'vmv-3', name: 'vm-verify-h3', cves: [['CVE-2099-0003', 'CRITICAL']] },
    ]);
    enqueueVmRun(TENANT_X, workerRun3);
    await __drainVmWorkerForTests();
    __setVmWorkerFaultForTests(null);
    const failedRun = await getRun(TENANT_X, workerRun3);
    check(failedRun?.status === 'FAILED' && failedRun.error === 'Normalization failed unexpectedly. Check the server log.', 'a failure after the findings were saved -> run FAILED with the generic message', JSON.stringify(failedRun));
    check((await count("SELECT count(*)::int AS n FROM vm_findings WHERE tenant_id = $1 AND vuln_id = 'CVE-2099-0003'", [TENANT_X])) === 0, 'no finding of the failed run survived (the transaction rolled back)');
    check((await count('SELECT count(*)::int AS n FROM vm_sightings WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun3])) === 0, 'no sighting of the failed run survived');
    check((await count("SELECT count(*)::int AS n FROM enclave_assets WHERE tenant_id = $1 AND asset_name = 'vm-verify-h3'", [TENANT_X])) === 0, 'the asset created by the failed run was rolled back too');
    check((await count('SELECT count(*)::int AS n FROM vm_run_assets WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun3])) === 0, 'no vm_run_assets row of the failed run survived');
    await resetRunForReprocess(TENANT_X, workerRun3);
    enqueueVmRun(TENANT_X, workerRun3);
    await __drainVmWorkerForTests();
    const retried = await getRun(TENANT_X, workerRun3);
    check(retried?.status === 'NORMALIZED' && retried.error === null, 'after clearing the fault, reprocessing the run -> NORMALIZED', JSON.stringify(retried));
    check((await count("SELECT count(*)::int AS n FROM vm_findings WHERE tenant_id = $1 AND vuln_id = 'CVE-2099-0003'", [TENANT_X])) === 1, 'and the finding exists now');
    check((await count('SELECT count(*)::int AS n FROM vm_run_assets WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun3])) === 1, 'and so does its vm_run_assets row');

    console.log('\n--- 13. Sightings are unique per run ---');
    await resetRunForReprocess(TENANT_X, workerRun1);
    enqueueVmRun(TENANT_X, workerRun1);
    await __drainVmWorkerForTests();
    check((await getRun(TENANT_X, workerRun1))?.status === 'NORMALIZED', 'the first run is reprocessed (NORMALIZED)');
    check((await count('SELECT count(*)::int AS n FROM vm_sightings WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun1])) === 3, 'it still has exactly 3 sightings after the reprocess');
    check((await count('SELECT count(*)::int AS n FROM vm_run_assets WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, workerRun1])) === 2, 'and still exactly 2 vm_run_assets rows (idempotent)');

    console.log('\n--- 14. Scheduler enumeration and snapshot ---');
    // a. The scheduler's one cross-tenant read.
    const SOURCE_KEYS = ['enabled', 'expectedIntervalMinutes', 'label', 'lastNormalizedAt', 'lastRunAt', 'sourceId', 'staleSince', 'tenantId'];
    const enumerated = await enumerateSchedulerSources();
    check(enumerated.some((r) => r.tenantId === TENANT_X && r.label === 'vm_verify_worker'), 'enumerateSchedulerSources() includes the worker source of tenant X', JSON.stringify(enumerated.map((r) => [r.tenantId, r.label])));
    check(enumerated.length > 0 && enumerated.every((r) => Object.keys(r).sort().join() === SOURCE_KEYS.join()), 'every row has exactly the 8 documented keys', JSON.stringify(enumerated[0] ? Object.keys(enumerated[0]) : []));
    // b, c, d, e. The policy is closed without the setting, and the setting is transaction-local and SELECT-only.
    const noGuc = await pool.query('SELECT count(*)::int AS n FROM vm_sources');
    check(noGuc.rows[0]?.n === 0, 'no tenant context and no scheduler setting => zero vm_sources rows visible', String(noGuc.rows[0]?.n));
    await pool.query("SELECT set_config('app.vm_scheduler', 'on', true)");
    const afterLocalGuc = await pool.query('SELECT count(*)::int AS n FROM vm_sources');
    check(afterLocalGuc.rows[0]?.n === 0, 'the scheduler setting is local to its transaction: a separate query still sees zero rows', String(afterLocalGuc.rows[0]?.n));
    const policy = await pool.query("SELECT cmd, qual FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'vm_sources' AND policyname = 'rls_vm_sources_scheduler'");
    check(policy.rows.length === 1 && policy.rows[0].cmd === 'SELECT' && String(policy.rows[0].qual).includes('app.vm_scheduler'), 'rls_vm_sources_scheduler exists, is FOR SELECT and reads app.vm_scheduler', JSON.stringify(policy.rows));
    const gucClient = await pool.connect();
    let gucUpdated = -1;
    try {
      await gucClient.query('BEGIN');
      await gucClient.query("SELECT set_config('app.vm_scheduler', 'on', true)");
      gucUpdated = (await gucClient.query('UPDATE vm_sources SET stale_since = now()')).rowCount ?? -1;
    } finally {
      await gucClient.query('ROLLBACK').catch(() => undefined);
      gucClient.release();
    }
    check(gucUpdated === 0, 'with the scheduler setting on, an UPDATE of vm_sources changes no row (the policy is SELECT-only)', String(gucUpdated));

    // f, g. A tick two days ahead marks the worker source stale and snapshots tenant X.
    // A tenant starts with no program and the tick skips such a tenant (no VM target), so both tenants get their first program first.
    await scopeOf(TENANT_X);
    await scopeOf(TENANT_Y);
    const workerSource = async () => (await listSources(TENANT_X)).find((s) => s.label === 'vm_verify_worker');
    const tick = await runVmSchedulerTick({ now: new Date(Date.now() + 2 * 86_400_000), onlyTenantIds: [TENANT_X, TENANT_Y] });
    check(tick.skipped === false && tick.errors === 0, 'a scheduler tick two days ahead runs without errors', JSON.stringify(tick));
    check((await workerSource())?.staleSince !== null && (await workerSource())?.staleSince !== undefined, 'it marked the worker source stale (stale_since set)', String((await workerSource())?.staleSince));
    await runVmSchedulerTick({ now: new Date(), onlyTenantIds: [TENANT_X, TENANT_Y] });
    check((await workerSource())?.staleSince === null, 'a tick at the real time clears stale_since again', String((await workerSource())?.staleSince));

    check((await latestSnapshotAt(TENANT_X)) !== null, 'the same tick snapshotted tenant X (latestSnapshotAt is set)');
    const snapshotRows = async () => (await queryWithProgram(await scopeOf(TENANT_X), "SELECT * FROM evidence_metadata WHERE tenant_id = $1 AND uploaded_by = 'system:vm-snapshot'", [TENANT_X])).rows;
    const firstSnapshot = await snapshotRows();
    check(firstSnapshot.length === 12, 'tenant X holds 12 snapshot evidence rows (no program record: 3 controls x 2 files, plus 3 SI inheritances x 2)', String(firstSnapshot.length));
    const baseRows = firstSnapshot.filter((r) => r.sync_status !== 'inherited');
    check(
      baseRows.length === 6 && baseRows.every((r) => crypto.createHash('sha256').update(fs.readFileSync(r.gcs_path)).digest('hex') === r.file_hash),
      'the sha256 of every stored snapshot file equals the recorded file_hash',
      String(baseRows.length),
    );
    const SNAPSHOT_CONTROLS = ['RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1'];
    const live = await readControlAssessments(await scopeOf(TENANT_X));
    check(
      live.size === 3 && SNAPSHOT_CONTROLS.every((id) => live.get(id)?.status === 'NOT_STARTED' && (live.get(id)?.notes.split(VM_NOTES_BEGIN).length ?? 0) === 2),
      'three control rows were created: NOT_STARTED, each with exactly one snapshot block',
      JSON.stringify([...live.entries()].map(([id, c]) => [id, c.status])),
    );

    // h. A human answer survives the next snapshot.
    const block = live.get('SI.L1-3.14.1')?.notes ?? '';
    await writeControlAssessment(await scopeOf(TENANT_X), 'SI.L1-3.14.1', () => ({ status: 'MET', notes: `Human text\n\n${block}`, role: null, updatedBy: 'vm_verify' }), { source: 'human', actor: 'vm_verify', userId: null });
    await runVmSnapshot(TENANT_X, { trigger: 'manual' });
    const afterHuman = (await readControlAssessments(await scopeOf(TENANT_X))).get('SI.L1-3.14.1');
    check(
      afterHuman?.status === 'MET' && afterHuman.notes.startsWith('Human text') && afterHuman.notes.split(VM_NOTES_BEGIN).length === 2,
      'a second snapshot keeps the human status and text and holds one block',
      JSON.stringify(afterHuman),
    );
    check((await snapshotRows()).length === 24, 'tenant X now holds 24 snapshot evidence rows');

    // i. Tenant isolation of the evidence rows (evidence_metadata is program-scoped: read under Y's own default program, then under X's
    // program with Y's tenant, which no row policy lets through).
    const ofY = await queryWithProgram(await scopeOf(TENANT_Y), "SELECT * FROM evidence_metadata WHERE uploaded_by = 'system:vm-snapshot'", []);
    check(ofY.rows.every((r) => r.tenant_id === TENANT_Y) && ofY.rows.length === 0, "tenant Y sees none of tenant X's snapshot evidence", String(ofY.rows.length));
    const ofYWithXProgram = await queryWithProgram({ tenantId: TENANT_Y, programId: (await scopeOf(TENANT_X)).programId }, "SELECT * FROM evidence_metadata WHERE uploaded_by = 'system:vm-snapshot'", []);
    check(ofYWithXProgram.rows.length === 0, "tenant Y sees none of them even when it runs in the id of tenant X's program", String(ofYWithXProgram.rows.length));
    const ofXNoProgram = await queryWithTenant(TENANT_X, "SELECT * FROM evidence_metadata WHERE uploaded_by = 'system:vm-snapshot'", []);
    check(ofXNoProgram.rows.length === 0, 'tenant X with no program context sees none of its own snapshot evidence (the program row policy)', String(ofXNoProgram.rows.length));

    console.log('\n--- 15. Control assessment history ---');
    const events = await listControlAssessmentEvents(await scopeOf(TENANT_X), 'SI.L1-3.14.1', 50);
    check(
      events.length === 3 && events.map((e) => e.source).join(',') === 'vm-snapshot,human,vm-snapshot',
      'SI.L1-3.14.1 has 3 events, newest first: vm-snapshot, human, vm-snapshot',
      JSON.stringify(events.map((e) => e.source)),
    );
    check(
      events[2]?.oldStatus === null && events[2].newStatus === 'NOT_STARTED' && events[2].notesChanged === true,
      'the oldest event is the creation: null -> NOT_STARTED, notes changed',
      JSON.stringify(events[2]),
    );
    check(events[1]?.oldStatus === 'NOT_STARTED' && events[1].newStatus === 'MET', 'the human event is NOT_STARTED -> MET', JSON.stringify(events[1]));
    check(
      events[0]?.oldStatus === 'MET' && events[0].newStatus === 'MET' && events[0].notesChanged === true,
      'the newest event is the second snapshot: MET -> MET, notes changed',
      JSON.stringify(events[0]),
    );
    const eventCount = async (): Promise<number> =>
      Number((await queryWithProgram(await scopeOf(TENANT_X), 'SELECT count(*)::int AS n FROM control_assessment_events WHERE tenant_id = $1', [TENANT_X])).rows[0]?.n);
    check((await eventCount()) === 7, 'tenant X holds 7 events (3 from the first tick, 1 human, 3 from the second snapshot)', String(await eventCount()));

    await writeControlAssessment(await scopeOf(TENANT_X), 'SI.L1-3.14.1', () => ({ status: null, notes: 'x', role: null, updatedBy: 'vm_verify' }), { source: 'human', actor: 'vm_verify', userId: null });
    check((await readControlAssessments(await scopeOf(TENANT_X))).get('SI.L1-3.14.1')?.status === 'MET', 'a write with a null status keeps MET');
    const beforeRollback = await eventCount();
    const txClient = await pool.connect();
    try {
      await txClient.query('BEGIN');
      await txClient.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', TENANT_X]);
      await writeControlAssessment(await scopeOf(TENANT_X), 'SI.L1-3.14.1', () => ({ status: 'NOT_MET', notes: null, role: null, updatedBy: 'vm_verify' }), { source: 'human', actor: 'vm_verify', userId: null }, txClient);
    } finally {
      await txClient.query('ROLLBACK').catch(() => undefined);
      txClient.release();
    }
    check((await readControlAssessments(await scopeOf(TENANT_X))).get('SI.L1-3.14.1')?.status === 'MET', 'a write inside a rolled-back caller transaction leaves the status MET');
    check((await eventCount()) === beforeRollback, 'and its event was rolled back with it (the event count is unchanged)', `${beforeRollback} -> ${await eventCount()}`);
    const noContextEvents = await pool.query('SELECT count(*)::int AS n FROM control_assessment_events');
    check(Number(noContextEvents.rows[0].n) === 0, 'without a tenant context no control_assessment_events row is visible', String(noContextEvents.rows[0].n));

    console.log('\n--- 16. Staleness follows the last normalized run (#59) ---');
    const normalizedMs = async (): Promise<number | null> => {
      const t = (await workerSource())?.lastNormalizedAt;
      return t ? new Date(t).getTime() : null;
    };
    const workerId = (await workerSource())?.id;
    const newestNormalized = Math.max(...(await listRuns(TENANT_X)).filter((r) => r.sourceId === workerId && r.status === 'NORMALIZED').map((r) => new Date(r.receivedAt).getTime()));
    const workerNormalized = await normalizedMs();
    check(workerNormalized !== null && workerNormalized === newestNormalized, 'the worker source lastNormalizedAt is the received time of its newest NORMALIZED run (to the millisecond)', `${workerNormalized} vs ${newestNormalized}`);
    await recordReceivedRun(TENANT_X, { ...input, id: crypto.randomUUID(), label: 'vm_verify_received_only', rawSha256: 'e'.repeat(64), rawPath: '/vm_verify/r' });
    await runVmSchedulerTick({ now: new Date(), onlyTenantIds: [TENANT_X] });
    const receivedOnly = (await listSources(TENANT_X)).find((s) => s.label === 'vm_verify_received_only');
    check(receivedOnly !== undefined && receivedOnly.lastRunAt !== null && receivedOnly.lastNormalizedAt === null && receivedOnly.staleSince !== null, 'a source that only received a run has no lastNormalizedAt and a real-time tick marks it stale', JSON.stringify(receivedOnly));
    await pool.query('ALTER TABLE vm_sources DROP COLUMN last_normalized_at');
    await initDb();
    check((await normalizedMs()) === workerNormalized, 'after dropping the column, initDb() restores the worker value from the NORMALIZED runs (backfill)', `${await normalizedMs()} vs ${workerNormalized}`);
    await initDb();
    check((await normalizedMs()) === workerNormalized, 'a second initDb() leaves it unchanged (the backfill runs once)', `${await normalizedMs()} vs ${workerNormalized}`);
    const leaked = await pool.query("SELECT current_setting('app.current_tenant_id', true) AS tenant, current_setting('app.vm_scheduler', true) AS scheduler");
    check(!leaked.rows[0]?.tenant && !leaked.rows[0]?.scheduler, 'no tenant or scheduler setting is left set after initDb()', JSON.stringify(leaked.rows[0]));

    console.log('\n--- 17. A failed snapshot leaves nothing behind (#56) ---');
    const snapDir = path.join(localStorageRoot(), 'tenants', TENANT_X, 'vm', 'snapshots');
    const snapFiles = (): number => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir).length : 0);
    const siNotes = async (): Promise<string | undefined> => (await readControlAssessments(await scopeOf(TENANT_X))).get('SI.L1-3.14.1')?.notes;
    const rowsBefore = (await snapshotRows()).length;
    const eventsBefore = await eventCount();
    const notesBefore = await siNotes();
    const latestBefore = await latestSnapshotAt(TENANT_X);
    const filesBefore = snapFiles();
    __setVmSnapshotFaultForTests(TENANT_X, 'after_first_note');
    const failedSnapshot = await thrown(() => runVmSnapshot(TENANT_X, { trigger: 'manual' }));
    __setVmSnapshotFaultForTests(null);
    check(failedSnapshot !== null, 'a failure after the first control note makes runVmSnapshot throw', describe(failedSnapshot));
    check(rowsBefore === 24 && (await snapshotRows()).length === rowsBefore, 'the snapshot evidence rows stay at 24', `${rowsBefore} -> ${(await snapshotRows()).length}`);
    check((await eventCount()) === eventsBefore, 'no history event was left behind', `${eventsBefore} -> ${await eventCount()}`);
    check((await siNotes()) === notesBefore, 'the SI.L1-3.14.1 notes are unchanged');
    check((await latestSnapshotAt(TENANT_X)) === latestBefore, 'latestSnapshotAt is unchanged (the retry is not postponed)');
    check(snapFiles() === filesBefore, 'the snapshot directory holds the same number of files (the failed snapshot files were removed)', `${filesBefore} -> ${snapFiles()}`);
    await runVmSnapshot(TENANT_X, { trigger: 'manual' });
    check((await snapshotRows()).length === 36, 'with the fault cleared the retry writes the snapshot (36 rows)', String((await snapshotRows()).length));

    console.log('\n--- 18. Two managers: agent ids per source, closure waits for every source (#62, #63) ---');
    const runAs = async (tenant: string, label: string, collectedAt: string, hosts: Array<{ agent: string; name: string; cves: string[] }>): Promise<string> => {
      const id = await writeRun(label, collectedAt, hosts.map((h) => ({ agent: h.agent, name: h.name, cves: h.cves.map((c): [string, string] => [c, 'HIGH']) })), tenant);
      enqueueVmRun(tenant, id);
      await __drainVmWorkerForTests();
      return id;
    };
    const assetNamed = async (tenant: string, name: string): Promise<string | undefined> =>
      (await queryWithTenant(tenant, 'SELECT id FROM enclave_assets WHERE tenant_id = $1 AND asset_name = $2', [tenant, name])).rows[0]?.id as string | undefined;
    await runAs(TENANT_X, 'vm_verify_mgr_a', '2099-02-01T00:00:00Z', [{ agent: '600', name: 'vm-verify-a-600', cves: [] }]);
    await runAs(TENANT_X, 'vm_verify_mgr_b', '2099-02-01T00:00:01Z', [{ agent: '600', name: 'vm-verify-b-600', cves: [] }]);
    const idA600 = await assetNamed(TENANT_X, 'vm-verify-a-600');
    const idB600 = await assetNamed(TENANT_X, 'vm-verify-b-600');
    check(Boolean(idA600) && Boolean(idB600) && idA600 !== idB600, 'agent 600 of two managers are two different assets', `${idA600} / ${idB600}`);
    await runAs(TENANT_X, 'vm_verify_mgr_a', '2099-02-01T00:00:02Z', [{ agent: '600', name: 'vm-verify-a-600-renamed', cves: [] }]);
    check((await assetNamed(TENANT_X, 'vm-verify-a-600-renamed')) === undefined, "a renamed host is still manager A's agent 600: no new asset");

    await runAs(TENANT_X, 'vm_verify_mgr_a', '2099-02-01T01:00:00Z', [{ agent: '500', name: 'vm-verify-shared', cves: ['CVE-2099-0010'] }]);
    await runAs(TENANT_X, 'vm_verify_mgr_b', '2099-02-01T01:00:01Z', [{ agent: '501', name: 'vm-verify-shared', cves: ['CVE-2099-0010'] }]);
    const sharedFinding = async () =>
      (await queryWithTenant(TENANT_X, "SELECT status, resolved_run_id FROM vm_findings WHERE tenant_id = $1 AND vuln_id = 'CVE-2099-0010'", [TENANT_X])).rows;
    check(JSON.stringify((await sharedFinding()).map((r) => r.status)) === '["OPEN"]', 'both managers report one host: one OPEN finding', JSON.stringify(await sharedFinding()));
    await runAs(TENANT_X, 'vm_verify_mgr_a', '2099-02-01T01:00:02Z', [{ agent: '500', name: 'vm-verify-shared', cves: [] }]);
    check((await sharedFinding())[0]?.status === 'OPEN', 'manager A drops the finding while manager B still lists it: it stays OPEN', JSON.stringify(await sharedFinding()));
    const bDrops = await runAs(TENANT_X, 'vm_verify_mgr_b', '2099-02-01T01:00:03Z', [{ agent: '501', name: 'vm-verify-shared', cves: [] }]);
    check((await sharedFinding())[0]?.status === 'RESOLVED' && (await sharedFinding())[0]?.resolved_run_id === bDrops, 'manager B drops it too: RESOLVED by that run', JSON.stringify(await sharedFinding()));

    console.log('\n--- 19. Legacy bare-kind agent id keys (#63) ---');
    for (const [name, agentId] of [['vm-verify-legacy-1', 'lg-1'], ['vm-verify-legacy-2', 'lg-2']] as const) {
      await createAgentReportedAsset(TENANT_Y, {
        agentId, hostName: name, ipAddress: '', macAddress: '', osProfile: 'custom', notes: 'vm_verify legacy key',
        agentIds: { wazuh: agentId }, sourceOrigin: 'AGENT_REPORT', discoveryStatus: 'UNCONFIRMED_DISCOVERY', cmmcAssetCategory: 'CONTRACTOR_RISK',
      }, new Date().toISOString(), 'vm_verify');
    }
    const legacyKeys = async () => (await queryWithTenant(TENANT_Y, "SELECT asset_name, agent_ids FROM enclave_assets WHERE tenant_id = $1 AND asset_name LIKE 'vm-verify-legacy-%' ORDER BY asset_name", [TENANT_Y])).rows;
    check(JSON.stringify((await legacyKeys()).map((r) => r.agent_ids)) === '[{"wazuh":"lg-1"},{"wazuh":"lg-2"}]', 'two legacy assets exist with the bare "wazuh" key', JSON.stringify(await legacyKeys()));
    await runAs(TENANT_Y, 'vm_verify_legacy', '2099-03-01T00:00:00Z', [{ agent: 'lg-1', name: 'vm-verify-legacy-renamed', cves: [] }]);
    const srcY = (await listSources(TENANT_Y)).find((s) => s.label === 'vm_verify_legacy')?.id;
    check((await assetNamed(TENANT_Y, 'vm-verify-legacy-renamed')) === undefined, "the legacy key still matched the tenant's only wazuh source: no new asset");
    const rewritten = JSON.stringify((await legacyKeys()).map((r) => r.agent_ids));
    check(Boolean(srcY) && rewritten === JSON.stringify([{ [`wazuh:${srcY}`]: 'lg-1' }, { [`wazuh:${srcY}`]: 'lg-2' }]) && !rewritten.includes('"wazuh"'), 'both rows were rewritten to wazuh:<source id>, with no bare "wazuh" key', rewritten);
    await runAs(TENANT_Y, 'vm_verify_legacy', '2099-03-01T00:00:01Z', [{ agent: 'lg-1', name: 'vm-verify-legacy-renamed', cves: [] }]);
    check(JSON.stringify((await legacyKeys()).map((r) => r.agent_ids)) === rewritten, 'a second run changes nothing');

    console.log('\n--- 20. Configuration results (#103) ---');
    const writeScapRun = async (label: string, collectedAt: string, hostname: string, tenant = TENANT_X) => {
      const id = crypto.randomUUID();
      const results = [
        { rule_id: 'xccdf_org.ssgproject.content_rule_sshd_disable_root_login', result: 'pass' },
        { rule_id: 'xccdf_org.ssgproject.content_rule_accounts_password_pam_minlen', cce: 'CCE-27407-6', result: 'fail' },
        { rule_id: 'foo_bar', result: 'notapplicable' },
      ];
      const bytes = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          source: { kind: 'SCAP', label },
          exporter: { name: 'vm-verify', version: '0.0.0' },
          collected_at: collectedAt,
          hosts: [
            {
              agent_id: 'xccdf-' + crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 32),
              hostname,
              configuration: [{ benchmark: { id: 'vm_verify_bench' }, scanner: { name: 'vm-verify' }, scanned_at: collectedAt, results }],
            },
          ],
        }),
      );
      const file = path.join(localStorageRoot(), 'tenants', tenant, 'vm', 'runs', `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      rawFiles.push(file);
      await recordReceivedRun(tenant, {
        id,
        kind: 'SCAP',
        label,
        collectedAt,
        exporterName: 'vm-verify',
        exporterVersion: '0.0.0',
        hostCount: 1,
        findingCount: 0,
        configResultCount: results.length,
        rawPath: file,
        rawSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        rawBytes: bytes.length,
      });
      return id;
    };
    const scansOfRun = (runId: string) => count('SELECT count(*)::int AS n FROM vm_config_scans WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, runId]);
    const resultsOfRun = (runId: string) =>
      count('SELECT count(*)::int AS n FROM vm_config_results r JOIN vm_config_scans s ON s.tenant_id = r.tenant_id AND s.id = r.scan_id WHERE s.tenant_id = $1 AND s.run_id = $2', [TENANT_X, runId]);

    const scapRun1 = await writeScapRun('vm_verify_scap', '2099-04-01T00:00:00Z', 'vm-verify-cfg-1');
    enqueueVmRun(TENANT_X, scapRun1);
    await __drainVmWorkerForTests();
    const scapNormalized = await getRun(TENANT_X, scapRun1);
    check(scapNormalized?.status === 'NORMALIZED' && scapNormalized.error === null, 'a SCAP run is NORMALIZED by the worker', JSON.stringify(scapNormalized));
    check((await scansOfRun(scapRun1)) === 1 && (await resultsOfRun(scapRun1)) === 3, 'the run stored one scan with three rule results');
    check(scapNormalized?.configResultCount === 3 && scapNormalized.findingCount === 0, 'the run records 3 configuration results and 0 findings', JSON.stringify(scapNormalized));
    const cfgAsset = await queryWithTenant(TENANT_X, "SELECT discovery_status, last_vuln_seen_at FROM enclave_assets WHERE tenant_id = $1 AND asset_name = 'vm-verify-cfg-1'", [TENANT_X]);
    check(cfgAsset.rows.length === 1 && cfgAsset.rows[0].discovery_status === 'UNCONFIRMED_DISCOVERY' && cfgAsset.rows[0].last_vuln_seen_at === null, 'the new asset is UNCONFIRMED_DISCOVERY and its last_vuln_seen_at stays null (no vulnerability scanner saw it)', JSON.stringify(cfgAsset.rows));
    check((await count('SELECT count(*)::int AS n FROM vm_run_assets WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, scapRun1])) === 0, 'a configuration-only host has no vm_run_assets row (it takes no part in closure or coverage)');
    const cfgPlain = await queryWithTenant(TENANT_X, "SELECT scanned_at, received_at, result_counts FROM vm_config_scans WHERE tenant_id = $1 AND run_id = $2", [TENANT_X, scapRun1]);
    check(cfgPlain.rows[0]?.result_counts?.pass === 1 && cfgPlain.rows[0]?.result_counts?.fail === 1 && cfgPlain.rows[0]?.result_counts?.notapplicable === 1, 'result_counts holds the per-value counts', JSON.stringify(cfgPlain.rows[0]?.result_counts));

    await resetRunForReprocess(TENANT_X, scapRun1);
    enqueueVmRun(TENANT_X, scapRun1);
    await __drainVmWorkerForTests();
    check((await getRun(TENANT_X, scapRun1))?.status === 'NORMALIZED' && (await scansOfRun(scapRun1)) === 1 && (await resultsOfRun(scapRun1)) === 3, 'reprocessing the run keeps exactly one scan and three results (idempotent)');

    __setVmWorkerFaultForTests('after_save');
    const scapRun2 = await writeScapRun('vm_verify_scap', '2099-04-02T00:00:00Z', 'vm-verify-cfg-2');
    enqueueVmRun(TENANT_X, scapRun2);
    await __drainVmWorkerForTests();
    __setVmWorkerFaultForTests(null);
    check((await getRun(TENANT_X, scapRun2))?.status === 'FAILED', 'a failure after the scans were saved -> run FAILED');
    check((await scansOfRun(scapRun2)) === 0 && (await resultsOfRun(scapRun2)) === 0, 'no scan or result of the failed run survived (the transaction rolled back)');
    check((await count("SELECT count(*)::int AS n FROM enclave_assets WHERE tenant_id = $1 AND asset_name = 'vm-verify-cfg-2'", [TENANT_X])) === 0, 'the asset created by the failed run was rolled back too');
    check((await scansOfRun(scapRun1)) === 1, 'the earlier run keeps its scan');

    console.log('\n--- 21. Affected packages (#267) ---');
    const pkgOf = async () => (await listFindings(TENANT_X, { limit: 100 })).filter((x) => x.vulnId === 'CVE-2099-0005');
    const pkgRun1 = await writeRun('vm_verify_packages', '2099-05-01T00:00:00Z', [
      { agent: 'vmv-p', name: 'vm-verify-p1', cves: [['CVE-2099-0005', 'HIGH', { name: 'openssl', version: '3.0.2', fixed_version: '3.0.13' }], ['CVE-2099-0005', 'HIGH', { name: 'libssl3', version: '3.0.2', fixed_version: null }]] },
    ]);
    enqueueVmRun(TENANT_X, pkgRun1);
    await __drainVmWorkerForTests();
    const pkgInserted = await pkgOf();
    check(pkgInserted.length === 1 && pkgInserted[0].affectedPackages.length === 2 && pkgInserted[0].affectedPackageCount === 2 && pkgInserted[0].affectedPackages[0].name === 'libssl3', 'INSERT: one finding keeps both packages (jsonb column, count 2)', JSON.stringify(pkgInserted));
    const pkgRun2 = await writeRun('vm_verify_packages', '2099-05-02T00:00:00Z', [
      { agent: 'vmv-p', name: 'vm-verify-p1', cves: [['CVE-2099-0005', 'HIGH', { name: 'openssl', version: '3.0.2', fixed_version: '3.0.13' }]] },
    ]);
    enqueueVmRun(TENANT_X, pkgRun2);
    await __drainVmWorkerForTests();
    const pkgUpdated = await pkgOf();
    check(pkgUpdated.length === 1 && pkgUpdated[0].status === 'OPEN' && pkgUpdated[0].affectedPackages.length === 1 && pkgUpdated[0].affectedPackageCount === 1 && pkgUpdated[0].affectedPackages[0].name === 'openssl', 'UPDATE: a run with one package shrinks the list and the finding stays OPEN (::jsonb cast)', JSON.stringify(pkgUpdated));

    console.log('\n--- 22. POA&M per episode and program (#275) ---');
    // Like writeRun, but the findings are written as given (a detected_at puts the finding past its deadline).
    const writeFindingsRun = async (label: string, collectedAt: string, hosts: Array<{ agent: string; name: string; findings: Record<string, unknown>[] }>) => {
      const id = crypto.randomUUID();
      const bytes = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          source: { kind: 'WAZUH', label },
          exporter: { name: 'vm-verify', version: '0.0.0' },
          collected_at: collectedAt,
          hosts: hosts.map((h) => ({ agent_id: h.agent, hostname: h.name, findings: h.findings })),
        }),
      );
      const file = path.join(localStorageRoot(), 'tenants', TENANT_X, 'vm', 'runs', `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      rawFiles.push(file);
      await recordReceivedRun(TENANT_X, {
        id,
        kind: 'WAZUH',
        label,
        collectedAt,
        exporterName: 'vm-verify',
        exporterVersion: '0.0.0',
        hostCount: hosts.length,
        findingCount: hosts.reduce((n, h) => n + h.findings.length, 0),
        rawPath: file,
        rawSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        rawBytes: bytes.length,
      });
      return id;
    };
    const processRun = async (id: string) => {
      enqueueVmRun(TENANT_X, id);
      await __drainVmWorkerForTests();
    };
    const reprocessRun = async (id: string) => {
      await resetRunForReprocess(TENANT_X, id);
      await processRun(id);
    };
    const target22 = await resolveVmTargetProgram(TENANT_X);
    if (!target22) throw new Error('tenant X has no VM target program');
    const scope = { tenantId: TENANT_X, programId: target22.program.id };
    const episodesOf = async (s: { tenantId: string; programId: string }, findingId: string): Promise<string[]> =>
      (await queryWithProgram(s, 'SELECT finding_first_seen_at FROM vm_poam_items WHERE tenant_id = $1 AND finding_id = $2 ORDER BY finding_first_seen_at', [s.tenantId, findingId])).rows.map((r) => new Date(r.finding_first_seen_at).toISOString());
    const itemCountIn = async (s: { tenantId: string; programId: string }): Promise<number> =>
      Number((await queryWithProgram(s, 'SELECT count(*)::int AS n FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2', [s.tenantId, s.programId])).rows[0]?.n);
    const hostPoam = (detectedAt: string | null): Array<{ agent: string; name: string; findings: Record<string, unknown>[] }> => [
      { agent: 'vmv-poam', name: 'vm-verify-poam', findings: detectedAt === null ? [] : [{ vuln_id: 'CVE-2099-0100', severity: 'CRITICAL', detected_at: detectedAt }] },
    ];

    const poamRun1 = await writeFindingsRun('vm_verify_poam', '2099-06-01T00:00:00Z', hostPoam('2020-01-01T00:00:00Z'));
    await processRun(poamRun1);
    const poamFinding = (await queryWithTenant(TENANT_X, "SELECT id FROM vm_findings WHERE tenant_id = $1 AND vuln_id = 'CVE-2099-0100'", [TENANT_X])).rows[0]?.id as string;
    const episodes1 = await episodesOf(scope, poamFinding);
    check(episodes1.length === 1 && episodes1[0].startsWith('2020-01-01'), 'an overdue finding gets one POA&M item in the VM target program, recording its episode (finding_first_seen_at)', JSON.stringify(episodes1));

    // #275 item 2: the snapshot reads the target program's items on PostgreSQL (the transaction sets the program)
    const snapPoam = (await loadSnapshotFindings(TENANT_X, scope.programId)).poam;
    check(snapPoam.some((p) => p.findingId === poamFinding), 'loadSnapshotFindings returns the target program\'s item under row security');
    const report22 = computeSnapshot(await loadSnapshotInput(TENANT_X, new Date(), getVmSnapshotConfig(), 'vmsnap_verify_x', scope.programId));
    check(report22.poam.overdueWithPoam >= 1, 'the snapshot counts the overdue finding as having a POA&M item (overdueWithPoam >= 1)', JSON.stringify(report22.poam));

    await reprocessRun(poamRun1);
    check((await episodesOf(scope, poamFinding)).length === 1, 'reprocessing the run keeps exactly one item for the episode (unique index and ON CONFLICT)');

    // close the episode, move its resolved_at into the past, then report the finding again: a new episode
    const poamRun2 = await writeFindingsRun('vm_verify_poam', '2099-06-02T00:00:00Z', hostPoam(null));
    await processRun(poamRun2);
    check((await queryWithTenant(TENANT_X, 'SELECT status FROM vm_findings WHERE tenant_id = $1 AND id = $2', [TENANT_X, poamFinding])).rows[0]?.status === 'RESOLVED', 'a run that no longer lists the finding resolves it');
    await queryWithTenant(TENANT_X, "UPDATE vm_findings SET resolved_at = '2025-06-01T00:00:00Z' WHERE tenant_id = $1 AND id = $2", [TENANT_X, poamFinding]);
    const poamRun3 = await writeFindingsRun('vm_verify_poam', '2099-06-03T00:00:00Z', hostPoam('2025-07-01T00:00:00Z'));
    await processRun(poamRun3);
    const episodes2 = await episodesOf(scope, poamFinding);
    check(episodes2.length === 2 && episodes2[0].startsWith('2020-01-01') && episodes2[1].startsWith('2025-07-01'), 'the reopened, overdue finding gets a second item for its new episode (the first one was completed by the worker, section 25)', JSON.stringify(episodes2));

    // target change: the new program gets items although the previous target keeps its own
    const itemsInDefault = await itemCountIn(scope);
    const target2 = await createProgram(TENANT_X, { name: 'VM Verify Target 2', frameworkId: 'CMMC_L2' }, 'vm_verify');
    const scope2 = { tenantId: TENANT_X, programId: target2.id };
    await setVmTargetProgram(TENANT_X, target2.id, { actor: 'vm_verify', userId: null });
    check((await loadSnapshotFindings(TENANT_X, target2.id)).poam.length === 0, 'under the second program the first program\'s items are not visible (row security)');
    await reprocessRun(poamRun3);
    const overdueNow = await count("SELECT count(*)::int AS n FROM vm_findings WHERE tenant_id = $1 AND status = 'OPEN' AND sla_due_at < now()", [TENANT_X]);
    check(overdueNow >= 1 && (await itemCountIn(scope2)) === overdueNow, 'after a target change the new program gets one item for every overdue open finding', `${await itemCountIn(scope2)} items for ${overdueNow} findings`);
    check((await itemCountIn(scope)) === itemsInDefault, 'the previous target program keeps its items and gains none');
    await reprocessRun(poamRun3);
    check((await itemCountIn(scope2)) === overdueNow, 'a second reprocess adds nothing to the new target');
    await setVmTargetProgram(TENANT_X, scope.programId, { actor: 'vm_verify', userId: null });

    console.log('\n--- 23. POA&M view (#274) ---');
    const viewNow = new Date().toISOString();
    const viewOptions = { openOnly: true, limit: 1000, offset: 0, upcomingLimit: 1000, includeFindingWindow: true };
    const viewX = await loadVmPoamView(scope, viewNow, viewOptions);
    const viewRow = viewX.items.find((i) => i.finding?.id === poamFinding);
    check(Boolean(viewRow) && viewRow?.finding?.vulnId === 'CVE-2099-0100' && viewRow?.finding?.asset?.name === 'vm-verify-poam' && viewRow?.finding?.slaDueAt !== null && viewRow?.controlId === 'RA.L2-3.11.3', 'the view returns the item with its finding, host name and deadline', JSON.stringify(viewRow));
    const openInDefault = Number((await queryWithProgram(scope, "SELECT count(*)::int AS n FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2 AND status IN ('OPEN', 'IN_PROGRESS')", [TENANT_X, scope.programId])).rows[0]?.n);
    check(viewX.itemsTotal === itemsInDefault && viewX.openItemsTotal === openInDefault, 'the view counts the program\'s items (the open count is the SQL count: completed items no longer count, #295)', `${viewX.itemsTotal} / ${viewX.openItemsTotal} of ${itemsInDefault} (open in SQL: ${openInDefault})`);
    const upcomingSql = await count("SELECT count(*)::int AS n FROM vm_findings WHERE tenant_id = $1 AND status = 'OPEN' AND sla_due_at >= $2::timestamptz", [TENANT_X, viewNow]);
    check(viewX.upcomingTotal === upcomingSql && viewX.upcoming.length === Math.min(1000, upcomingSql), 'upcomingTotal equals the SQL count of open findings not yet due', `${viewX.upcomingTotal} vs ${upcomingSql}`);
    const viewP2 = await loadVmPoamView(scope2, viewNow, { ...viewOptions, includeFindingWindow: false });
    check(viewP2.itemsTotal === overdueNow && viewP2.upcoming.length === 0 && viewP2.upcomingTotal === 0 && viewP2.overdueWithoutItemCount === 0, 'a program that is not the target gets its own items and no upcoming rows', JSON.stringify([viewP2.itemsTotal, viewP2.upcomingTotal]));
    check(!viewP2.items.some((i) => viewX.items.some((j) => j.id === i.id)), 'the two programs\' items are disjoint');
    const scopeY = await scopeOf(TENANT_Y);
    const viewY = await loadVmPoamView(scopeY, viewNow, viewOptions);
    check(viewY.items.length === 0 && viewY.itemsTotal === 0, 'tenant Y sees none of tenant X\'s items');
    const viewCross = await loadVmPoamView({ tenantId: TENANT_Y, programId: scope.programId }, viewNow, viewOptions);
    check(viewCross.items.length === 0 && viewCross.itemsTotal === 0, 'tenant X\'s program id under tenant Y returns no item (row security)');

    console.log('\n--- 24. Scanner-reported inventory, program-wide (#279) ---');
    // Three hosts of tenant X; the packages differ only by case and spaces, by one version, one is a hotfix and one name is not ASCII.
    const invRun = await writeRun('vm_verify_inventory', '2099-07-01T00:00:00Z', [{ agent: 'vmv-inv', name: 'vm-verify-inv-0', cves: [] }]);
    const invSource = (await listSources(TENANT_X)).find((s) => s.label === 'vm_verify_inventory');
    if (!invSource) throw new Error('the inventory verify source was not created');
    const invAsset = async (name: string, agentId: string): Promise<string> => {
      const made = await createAgentReportedAsset(TENANT_X, {
        agentId, hostName: name, ipAddress: '', macAddress: '', osProfile: 'custom', notes: 'vm_verify inventory',
        agentIds: { wazuh: agentId }, sourceOrigin: 'AGENT_REPORT', discoveryStatus: 'UNCONFIRMED_DISCOVERY', cmmcAssetCategory: 'CONTRACTOR_RISK',
      }, new Date().toISOString(), 'vm_verify');
      if (!made) throw new Error('the inventory verify asset was not created');
      return made.id;
    };
    const invA1 = await invAsset('vm-verify-inv-1', 'inv-1');
    const invA2 = await invAsset('vm-verify-inv-2', 'inv-2');
    const invA3 = await invAsset('vm-verify-inv-3', 'inv-3');
    const pkg = (name: string, version: string, vendor: string, type = 'deb') => ({ name, version, vendor, architecture: 'amd64', type, installedAt: null });
    const invDraft = (assetId: string, agentId: string, hostname: string, software: ReturnType<typeof pkg>[]) => ({
      assetId, agentId, hostname,
      inv: { ip: '', mac: '', os: { name: 'Ubuntu', version: '22.04', platform: 'ubuntu', kernel: '' }, hardware: null, software },
    });
    await withVmTenantTx(TENANT_X, (client) =>
      replaceHostInventory(TENANT_X, { id: invRun, sourceId: invSource.id }, '2099-07-01T00:00:00Z', [
        invDraft(invA1, 'inv-1', 'vm-verify-inv-1', [
          pkg('OpenSSL ', '3.0.2', ' The OpenSSL Project'),
          pkg('OpenSSL', '3.0.13', 'The OpenSSL Project'),
          pkg('KB5001234', '1', 'Microsoft', 'hotfix'),
          pkg('Café Tool', '1', 'Zed'),
        ]),
        invDraft(invA2, 'inv-2', 'vm-verify-inv-2', [pkg('openssl', '3.0.2', 'the openssl project ')]),
        invDraft(invA3, 'inv-3', 'vm-verify-inv-3', [pkg('zzz-only-h3', '1', '')]),
      ], client),
    );
    const invIds = [invA1, invA2, invA3];
    const all24 = await aggregateObservedSoftware(TENANT_X, invIds, { limit: 100 });
    const names24 = all24.items.map((g) => `${g.name.trim().toLowerCase()}@${g.version}`);
    check(all24.totalGroups === 4 && all24.items.length === 4, 'four groups: the case and space variants merged, the other version kept apart, the hotfix left out', JSON.stringify(names24));
    const merged = all24.items.find((g) => g.name.trim().toLowerCase() === 'openssl' && g.version === '3.0.2');
    check(Boolean(merged) && merged?.assetCount === 2 && merged?.assetIds.length === 2 && merged?.vendor.trim().toLowerCase() === 'the openssl project', 'the openssl 3.0.2 variants form one group on 2 assets', JSON.stringify(merged));
    check(all24.items.find((g) => g.version === '3.0.13')?.assetCount === 1, 'openssl 3.0.13 is a separate group on 1 asset');
    check(!all24.items.some((g) => g.name === 'KB5001234'), 'the hotfix row is omitted');
    check(all24.items.some((g) => g.name === 'Café Tool' && g.version === '1'), 'a non-ASCII name comes back intact');
    check(names24.join('|') === ['café tool@1', 'openssl@3.0.13', 'openssl@3.0.2', 'zzz-only-h3@1'].join('|'), 'groups come back in ascending group-key order (byte order)', names24.join('|'));
    const cut24 = await aggregateObservedSoftware(TENANT_X, invIds, { limit: 2 });
    check(cut24.totalGroups === 4 && cut24.items.length === 2 && cut24.items.map((g) => g.name.trim().toLowerCase()).join('|') === 'café tool|openssl', 'limit 2 returns the first two groups and totalGroups 4 (truncated)', JSON.stringify([cut24.totalGroups, cut24.items.length]));
    const only12 = await aggregateObservedSoftware(TENANT_X, [invA1, invA2], { limit: 100 });
    check(only12.totalGroups === 3 && !only12.items.some((g) => g.name === 'zzz-only-h3'), 'restricted to two asset ids, the third asset\'s package is absent', JSON.stringify(only12.items.map((g) => g.name)));
    const only2 = await aggregateObservedSoftware(TENANT_X, [invA2], { limit: 100 });
    check(only2.totalGroups === 1 && only2.items[0]?.assetCount === 1, 'restricted to one asset id, only that asset\'s package group remains', JSON.stringify(only2.items.map((g) => g.name)));
    check((await aggregateObservedSoftware(TENANT_X, [], { limit: 100 })).totalGroups === 0, 'an empty asset id list returns nothing');
    const otherTenant = await aggregateObservedSoftware(TENANT_Y, invIds, { limit: 100 });
    check(otherTenant.totalGroups === 0 && otherTenant.items.length === 0, 'another tenant gets nothing for the same asset ids (row security)');
    const wholeTenant = await aggregateObservedSoftware(TENANT_X, null, { limit: 100 });
    check(wholeTenant.items.some((g) => g.name === 'zzz-only-h3'), 'null asset ids cover every asset of the tenant');
    const hosts13 = await listObservedHostsForAssets(TENANT_X, [invA1, invA3]);
    check(hosts13.length === 2 && hosts13.every((h) => h.assetId === invA1 || h.assetId === invA3) && hosts13.every((h) => h.sourceId === invSource.id), 'listObservedHostsForAssets returns only the requested assets\' rows', JSON.stringify(hosts13.map((h) => h.assetId)));
    check((await listObservedHostsForAssets(TENANT_X, [])).length === 0 && (await listObservedHostsForAssets(TENANT_Y, invIds)).length === 0, 'no asset ids, or another tenant, returns no host row');
    check((await listObservedHostsForAssets(TENANT_X, null)).filter((h) => invIds.includes(h.assetId)).length === 3, 'null asset ids return the rows of all three assets');
    console.log('\n--- 25. POA&M completion when a later scan confirms the fix (#295) ---');
    const findingIdOf = async (vulnId: string): Promise<string> =>
      (await queryWithTenant(TENANT_X, 'SELECT id FROM vm_findings WHERE tenant_id = $1 AND vuln_id = $2', [TENANT_X, vulnId])).rows[0]?.id as string;
    const itemRowsOf = async (s: { tenantId: string; programId: string }, findingId: string) =>
      (await queryWithProgram(s, 'SELECT id, status, status_changed_by, updated_by, auto_complete, updated_at FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2 AND finding_id = $3 ORDER BY finding_first_seen_at', [s.tenantId, s.programId, findingId])).rows;
    const eventCountOf = async (s: { tenantId: string; programId: string }, runId: string): Promise<number> =>
      Number((await queryWithProgram(s, 'SELECT count(*)::int AS n FROM vm_poam_item_events WHERE tenant_id = $1 AND run_id = $2', [s.tenantId, runId])).rows[0]?.n);

    // 25a: the run that no longer listed CVE-2099-0100 (poamRun2) completed the first episode's item and wrote one system event under the target program
    const items25 = await itemRowsOf(scope, poamFinding);
    check(items25.length === 2 && items25[0].status === 'COMPLETED' && items25[0].status_changed_by === 'system:vm-worker' && items25[0].updated_by === 'system:vm-worker', 'the item of the resolved episode is COMPLETED by the worker', JSON.stringify(items25));
    check(items25[1].status === 'OPEN', 'the item of the reopened episode is still OPEN', JSON.stringify(items25));
    check((await eventCountOf(scope, poamRun2)) === 1, 'one vm_poam_item_events row with the run id is visible under the target program');
    check((await eventCountOf(scope2, poamRun2)) === 0, 'the event is not visible under another program (row security)');
    check(Number((await queryWithTenant(TENANT_X, 'SELECT count(*)::int AS n FROM vm_poam_item_events WHERE tenant_id = $1', [TENANT_X])).rows[0]?.n) === 0, 'a tenant context with no program sees no event');
    const sysEvent = (await queryWithProgram(scope, 'SELECT source, actor, actor_user_id, old_status, new_status, owner_changed, mitigation_changed, new_owner_sha256 FROM vm_poam_item_events WHERE tenant_id = $1 AND run_id = $2', [TENANT_X, poamRun2])).rows[0];
    check(sysEvent?.source === 'system' && sysEvent.actor === 'system:vm-worker' && sysEvent.actor_user_id === null && sysEvent.old_status === 'OPEN' && sysEvent.new_status === 'COMPLETED' && sysEvent.owner_changed === false && sysEvent.mitigation_changed === false && sysEvent.new_owner_sha256 === null, 'the event records OPEN -> COMPLETED by the worker, no user id, no text digest', JSON.stringify(sysEvent));

    // 25b: reprocessing the resolving run completes nothing twice
    await reprocessRun(poamRun2);
    const items25b = await itemRowsOf(scope, poamFinding);
    check((await eventCountOf(scope, poamRun2)) === 1 && new Date(items25b[0].updated_at).toISOString() === new Date(items25[0].updated_at).toISOString() && items25b[0].status === 'COMPLETED', 'reprocessing the run adds no event and leaves the item untouched (same updated_at)');

    // the open items the screen counts are exactly the SQL count (completed ones no longer count)
    const openSql = Number((await queryWithProgram(scope, "SELECT count(*)::int AS n FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2 AND status IN ('OPEN', 'IN_PROGRESS')", [TENANT_X, scope.programId])).rows[0]?.n);
    const view25 = await loadVmPoamView(scope, new Date().toISOString(), { openOnly: false, limit: 1000, offset: 0, upcomingLimit: 0, includeFindingWindow: false });
    check(view25.openItemsTotal === openSql && view25.openItemsTotal < view25.itemsTotal, 'openItemsTotal equals the SQL count of open items and is below the total', `${view25.openItemsTotal} / ${openSql} / ${view25.itemsTotal}`);

    // 25c: an item a person reopened (auto_complete = FALSE) is not completed; once the flag is back (backlog sweep) the next run completes it
    const poam2a = await writeFindingsRun('vm_verify_poam2', '2099-06-04T00:00:00Z', [{ agent: 'vmv-poam2', name: 'vm-verify-poam2', findings: [{ vuln_id: 'CVE-2099-0101', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }] }]);
    await processRun(poam2a);
    const finding2 = await findingIdOf('CVE-2099-0101');
    await queryWithProgram(scope, 'UPDATE vm_poam_items SET auto_complete = FALSE WHERE tenant_id = $1 AND program_id = $2 AND finding_id = $3', [TENANT_X, scope.programId, finding2]);
    const poam2b = await writeFindingsRun('vm_verify_poam2', '2099-06-05T00:00:00Z', [{ agent: 'vmv-poam2', name: 'vm-verify-poam2', findings: [] }]);
    await processRun(poam2b);
    const items25c = await itemRowsOf(scope, finding2);
    check((await queryWithTenant(TENANT_X, 'SELECT status FROM vm_findings WHERE tenant_id = $1 AND id = $2', [TENANT_X, finding2])).rows[0]?.status === 'RESOLVED' && items25c.length === 1 && items25c[0].status === 'OPEN' && (await eventCountOf(scope, poam2b)) === 0, 'an item with auto_complete FALSE stays OPEN although its finding is RESOLVED', JSON.stringify(items25c));
    await queryWithProgram(scope, 'UPDATE vm_poam_items SET auto_complete = TRUE WHERE tenant_id = $1 AND program_id = $2 AND finding_id = $3', [TENANT_X, scope.programId, finding2]);
    await reprocessRun(poam2b);
    const items25c2 = await itemRowsOf(scope, finding2);
    check(items25c2[0].status === 'COMPLETED' && (await eventCountOf(scope, poam2b)) === 1, 'the next run sweeps it up: every eligible item completes, not only those the run resolved', JSON.stringify(items25c2));

    // 25d: items left in a program that was the VM target earlier complete too, unless that program is archived
    const target3 = await createProgram(TENANT_X, { name: 'VM Verify Target 3', frameworkId: 'CMMC_L2' }, 'vm_verify');
    const scope3 = { tenantId: TENANT_X, programId: target3.id };
    const poam3a = await writeFindingsRun('vm_verify_poam3', '2099-06-06T00:00:00Z', [{ agent: 'vmv-poam3', name: 'vm-verify-poam3', findings: [{ vuln_id: 'CVE-2099-0102', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }] }]);
    await processRun(poam3a); // target: the default program
    const finding3 = await findingIdOf('CVE-2099-0102');
    await setVmTargetProgram(TENANT_X, target2.id, { actor: 'vm_verify', userId: null });
    const poam3b = await writeFindingsRun('vm_verify_poam3', '2099-06-07T00:00:00Z', [
      { agent: 'vmv-poam3', name: 'vm-verify-poam3', findings: [{ vuln_id: 'CVE-2099-0102', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }] },
      { agent: 'vmv-poam4', name: 'vm-verify-poam4', findings: [{ vuln_id: 'CVE-2099-0103', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }] },
    ]);
    await processRun(poam3b); // target: the second program, which gets an item for each
    const finding4 = await findingIdOf('CVE-2099-0103');
    await setVmTargetProgram(TENANT_X, target3.id, { actor: 'vm_verify', userId: null });
    await archiveProgram(TENANT_X, target2.id);
    const poam3c = await writeFindingsRun('vm_verify_poam3', '2099-06-08T00:00:00Z', [
      { agent: 'vmv-poam3', name: 'vm-verify-poam3', findings: [] },
      { agent: 'vmv-poam4', name: 'vm-verify-poam4', findings: [] },
    ]);
    await processRun(poam3c); // target: the third program; the default program is a previous target, the second is archived
    const prevDefault = await itemRowsOf(scope, finding3);
    const archived3 = await itemRowsOf(scope2, finding3);
    const archived4 = await itemRowsOf(scope2, finding4);
    check(prevDefault.length === 1 && prevDefault[0].status === 'COMPLETED' && prevDefault[0].status_changed_by === 'system:vm-worker', 'the item in a previous, non-archived target program is completed', JSON.stringify(prevDefault));
    check(archived3.length === 1 && archived3[0].status === 'OPEN' && archived4.length === 1 && archived4[0].status === 'OPEN', 'the items in an archived program are frozen: untouched', JSON.stringify([archived3, archived4]));
    check((await eventCountOf(scope, poam3c)) === 1 && (await eventCountOf(scope2, poam3c)) === 0 && (await eventCountOf(scope3, poam3c)) === 0, 'the event is recorded under the item\'s own program (and none for the archived one)');
    // the transaction's program setting was restored to the target before the run's later writes: the run is NORMALIZED and the target's own items are readable
    check((await getRun(TENANT_X, poam3c))?.status === 'NORMALIZED', 'the run finished NORMALIZED after switching programs inside its transaction');
    await setVmTargetProgram(TENANT_X, scope.programId, { actor: 'vm_verify', userId: null });
    console.log('\n--- 26. Editing a vulnerability POA&M item (#297) ---');
    const humanEvents = async (s: { tenantId: string; programId: string }, itemId: string): Promise<number> =>
      Number((await queryWithProgram(s, "SELECT count(*)::int AS n FROM vm_poam_item_events WHERE tenant_id = $1 AND item_id = $2 AND source = 'human'", [s.tenantId, itemId])).rows[0]?.n);
    const poam5a = await writeFindingsRun('vm_verify_poam5', '2099-06-09T00:00:00Z', [{ agent: 'vmv-poam5', name: 'vm-verify-poam5', findings: [{ vuln_id: 'CVE-2099-0104', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }] }]);
    await processRun(poam5a);
    const finding5 = await findingIdOf('CVE-2099-0104');
    const item5 = (await itemRowsOf(scope, finding5))[0];
    check(item5?.status === 'OPEN' && item5.auto_complete === true, 'the item to edit exists, OPEN and auto-completing', JSON.stringify(item5));
    const stamp5 = new Date(item5.updated_at).toISOString();

    // 26a: an edit under the target program changes the row and writes one human event with digests, never the text
    const edited = await updateVmPoamItem(scope, item5.id as string, { owner: 'vm-verify owner', mitigation: 'vm-verify mitigation', scheduledCompletion: '2099-12-15', status: 'IN_PROGRESS' }, stamp5, { actor: 'vm_verify editor', userId: 'vm_verify_user' });
    check(edited?.changed === true && edited.item.owner === 'vm-verify owner' && edited.item.scheduledCompletion === '2099-12-15' && edited.item.status === 'IN_PROGRESS' && edited.item.updatedBy === 'vm_verify editor' && edited.item.statusChangedBy === 'vm_verify editor' && Date.parse(edited.item.updatedAt) > Date.parse(stamp5), 'updateVmPoamItem edits the row and bumps updated_at', JSON.stringify(edited));
    const ev5 = (await queryWithProgram(scope, "SELECT source, actor, actor_user_id, old_status, new_status, owner_changed, mitigation_changed, new_owner_sha256, new_owner_length, new_mitigation_sha256 FROM vm_poam_item_events WHERE tenant_id = $1 AND item_id = $2 AND source = 'human'", [TENANT_X, item5.id])).rows;
    check(ev5.length === 1 && ev5[0].actor === 'vm_verify editor' && ev5[0].actor_user_id === 'vm_verify_user' && ev5[0].old_status === 'OPEN' && ev5[0].new_status === 'IN_PROGRESS' && ev5[0].owner_changed === true && ev5[0].mitigation_changed === true && ev5[0].new_owner_sha256 === sha256Hex('vm-verify owner') && ev5[0].new_owner_length === 15, 'one human event with the user id, the statuses, the changed flags and the SHA-256 and length of the new owner', JSON.stringify(ev5));
    const noText = (await queryWithProgram(scope, 'SELECT row_to_json(e)::text AS t FROM vm_poam_item_events e WHERE tenant_id = $1 AND item_id = $2', [TENANT_X, item5.id])).rows.every((r) => !String(r.t).includes('vm-verify owner') && !String(r.t).includes('vm-verify mitigation'));
    check(noText, 'no event row holds the owner or the mitigation text');
    const events5 = await listVmPoamItemEvents(scope, item5.id as string, 100);
    check(events5.length === 1 && events5[0].source === 'human' && events5[0].newScheduledCompletion === '2099-12-15' && events5[0].oldScheduledCompletion === null, 'listVmPoamItemEvents returns the event with its dates');
    const one5 = await getVmPoamRow(scope, item5.id as string);
    check(one5?.id === item5.id && one5?.owner === 'vm-verify owner' && one5?.mitigation === 'vm-verify mitigation', 'getVmPoamRow reads the edited item');

    // 26b: another program's scope finds nothing and changes nothing
    const other = await updateVmPoamItem(scope2, item5.id as string, { owner: 'vm-verify intruder' }, new Date(edited!.item.updatedAt).toISOString(), { actor: 'vm_verify editor', userId: null });
    check(other === null && (await getVmPoamRow(scope2, item5.id as string)) === null && (await listVmPoamItemEvents(scope2, item5.id as string, 100)).length === 0, 'under another program the item is not found, not readable and has no history (row security)');
    check((await getVmPoamRow(scope, item5.id as string))?.owner === 'vm-verify owner', 'the row is unchanged after the refused attempt');

    // 26c: a stale stamp, a no-op, and the status rules
    let stale = false;
    try { await updateVmPoamItem(scope, item5.id as string, { owner: 'vm-verify late' }, stamp5, { actor: 'vm_verify editor', userId: null }); } catch (err) { stale = err instanceof StaleWriteError; }
    check(stale, 'a stale expected stamp is refused with StaleWriteError');
    const noop = await updateVmPoamItem(scope, item5.id as string, { owner: 'vm-verify owner' }, edited!.item.updatedAt, { actor: 'vm_verify editor', userId: null });
    check(noop?.changed === false && noop.item.updatedAt === edited!.item.updatedAt && (await humanEvents(scope, item5.id as string)) === 1, 'a patch that changes nothing writes no event and keeps updated_at');
    let editCode = '';
    try { await updateVmPoamItem(scope, item5.id as string, { status: 'COMPLETED' }, edited!.item.updatedAt, { actor: 'vm_verify editor', userId: null }); } catch (err) { editCode = err instanceof VmPoamEditError ? err.code : 'other'; }
    check(editCode === 'finding_still_open', 'COMPLETED while the finding is still OPEN is refused (finding_still_open)', editCode);
    editCode = '';
    try { await updateVmPoamItem(scope, item5.id as string, { status: 'RISK_ACCEPTED', mitigation: '' }, edited!.item.updatedAt, { actor: 'vm_verify editor', userId: null }); } catch (err) { editCode = err instanceof VmPoamEditError ? err.code : 'other'; }
    check(editCode === 'mitigation_required', 'RISK_ACCEPTED with no mitigation is refused (mitigation_required)', editCode);

    // 26d: the scan stops listing the finding: the worker completes the item; a person reopens it (auto_complete FALSE) and the next run leaves it alone
    const poam5b = await writeFindingsRun('vm_verify_poam5', '2099-06-10T00:00:00Z', [{ agent: 'vmv-poam5', name: 'vm-verify-poam5', findings: [] }]);
    await processRun(poam5b);
    const done5 = (await itemRowsOf(scope, finding5))[0];
    check(done5.status === 'COMPLETED' && done5.status_changed_by === 'system:vm-worker', 'the worker completed the edited IN_PROGRESS item', JSON.stringify(done5));
    const reopened = await updateVmPoamItem(scope, item5.id as string, { status: 'OPEN' }, new Date(done5.updated_at).toISOString(), { actor: 'vm_verify editor', userId: 'vm_verify_user' });
    const reopenedRow = (await itemRowsOf(scope, finding5))[0];
    check(reopened?.changed === true && reopened.item.status === 'OPEN' && reopened.item.autoComplete === false && reopenedRow.auto_complete === false, 'reopening a COMPLETED item sets auto_complete to FALSE', JSON.stringify(reopenedRow));
    await reprocessRun(poam5b);
    const after5 = (await itemRowsOf(scope, finding5))[0];
    check(after5.status === 'OPEN' && new Date(after5.updated_at).toISOString() === reopened!.item.updatedAt, 'the next worker run leaves the reopened item OPEN and untouched', JSON.stringify(after5));
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      // The six program-scoped tables are only reachable under the program context: delete through the tenant's default program
      const programId = (await queryWithTenant(t, 'SELECT id FROM programs WHERE tenant_id = $1 AND is_default', [t]).catch(() => null))?.rows[0]?.id as string | undefined;
      const inProgram = (sql: string, params: string[]) => (programId ? queryWithProgram({ tenantId: t, programId }, sql, params) : Promise.resolve(undefined));
      // POA&M items live in the program that was the VM target when they were created: clear every program of the tenant, or the RESTRICT key keeps the programs
      const programIds = ((await queryWithTenant(t, 'SELECT id FROM programs WHERE tenant_id = $1', [t]).catch(() => null))?.rows ?? []).map((r) => r.id as string);
      for (const pid of programIds) await queryWithProgram({ tenantId: t, programId: pid }, 'DELETE FROM vm_poam_items WHERE tenant_id = $1', [t]).catch(() => undefined);
      for (const pid of programIds) await queryWithProgram({ tenantId: t, programId: pid }, 'DELETE FROM vm_poam_item_events WHERE tenant_id = $1', [t]).catch(() => undefined); // the history has no foreign key to the program
      await queryWithTenant(t, 'DELETE FROM vm_sightings WHERE tenant_id = $1', [t]).catch(() => undefined);
      await queryWithTenant(t, 'DELETE FROM vm_findings WHERE tenant_id = $1', [t]).catch(() => undefined);
      await queryWithTenant(t, 'DELETE FROM vm_run_assets WHERE tenant_id = $1', [t]).catch(() => undefined);
      await queryWithTenant(t, 'DELETE FROM vm_config_scans WHERE tenant_id = $1', [t]).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM enclave_assets WHERE asset_name LIKE 'vm-verify%'", []).catch(() => undefined);
      await queryWithTenant(t, 'DELETE FROM vm_runs WHERE tenant_id = $1', [t]).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_runs WHERE raw_path LIKE '/vm_verify/%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_sources WHERE label ILIKE 'vm_verify%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_service_tokens WHERE name LIKE 'vm_verify%'", []).catch(() => undefined);
      await inProgram("DELETE FROM evidence_metadata WHERE tenant_id = $1 AND uploaded_by = 'system:vm-snapshot'", [t]).catch(() => undefined);
      await inProgram('DELETE FROM control_assessment_events WHERE tenant_id = $1', [t]).catch(() => undefined);
      await inProgram("DELETE FROM control_assessments WHERE tenant_id = $1 AND control_id IN ('RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1', 'CA.L2-3.12.3')", [t]).catch(() => undefined);
      await queryWithTenant(t, 'DELETE FROM programs WHERE tenant_id = $1', [t]).catch(() => undefined); // the program scopeOf created
      fs.rmSync(path.join(localStorageRoot(), 'tenants', t, 'vm', 'snapshots'), { recursive: true, force: true });
    }
    await pool.query("DELETE FROM vm_vulns WHERE vuln_id LIKE 'VM-VERIFY-%' OR vuln_id LIKE 'CVE-2099-%'").catch(() => undefined);
    for (const f of rawFiles) fs.rmSync(f, { force: true });
  }
}

main()
  .catch((err) => {
    console.error('Unexpected error:', err);
    failures++;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    console.log(failures === 0 ? '\nAll vulnerability-management live checks passed.' : `\n${failures} vulnerability-management live check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
