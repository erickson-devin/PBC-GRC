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
 * under two tenants to prove isolation. It inserts and removes rows named "vm_verify..." (and "VM-VERIFY-" rows in vm_vulns).
 * Exit code 0 = all checks passed.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const crypto = await import('crypto');
const { pool, initDb, queryWithTenant, checkDatabaseConnection } = await import('../server/db');
const { createVmToken, listVmTokens, revokeVmToken, lookupVmTokenByHash, sha256Hex, VmTokenError, VM_TOKEN_PATTERN, MAX_ACTIVE_TOKENS_PER_TENANT } =
  await import('../server/vm/tokens');
const { recordReceivedRun, findRunBySha, listRuns, listSources, updateRun, VmStoreError } = await import('../server/vm/store');
const { validateIngestPayload } = await import('../server/vm/ingestSchema');

let failures = 0;
function check(ok: boolean, message: string, detail?: string) {
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}: ${message}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
}

const TENANT_X = 'vm_verify_tenant_x';
const TENANT_Y = 'vm_verify_tenant_y';

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
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM vm_runs WHERE raw_path LIKE '/vm_verify/%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_sources WHERE label ILIKE 'vm_verify%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_service_tokens WHERE name LIKE 'vm_verify%'", []).catch(() => undefined);
    }
    await pool.query("DELETE FROM vm_vulns WHERE vuln_id LIKE 'VM-VERIFY-%'").catch(() => undefined);
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
