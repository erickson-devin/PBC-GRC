import fs from 'fs';
import { spawnSync } from 'child_process';
import { isNonProductionEnv, runtimeEnvWarnings } from '../server/runtimeEnv';

/**
 * The database no longer falls back silently. Without DB_MODE=memory, an unreachable PostgreSQL is a hard
 * failure: startup exits non-zero, queries throw, health reports unavailable, and nothing quietly switches to
 * the in-memory store. (This test deliberately does NOT import ./testEnv.)
 */
process.env.NODE_ENV = 'test';
delete process.env.DB_MODE;
process.env.DATABASE_URL = '';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1'; // nothing listens here: connection refused immediately

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
const rejects = async (p: Promise<unknown>): Promise<string | null> => p.then(() => null, (e: Error) => e.message);

async function run() {
  const db = await import('../server/db');

  console.log('--- Mode selection ---');
  assert(db.getDbMode({} as NodeJS.ProcessEnv) === 'postgres', 'default mode is postgres (not memory)');
  assert(db.getDbMode({ DB_MODE: 'memory' } as NodeJS.ProcessEnv) === 'memory', 'DB_MODE=memory is the only way to get the in-memory store');
  assert(db.getDbMode({ DB_MODE: ' MEMORY ' } as NodeJS.ProcessEnv) === 'memory', 'value is trimmed and case-insensitive');
  let invalid: string | null = null;
  try { db.getDbMode({ DB_MODE: 'sqlite' } as NodeJS.ProcessEnv); } catch (e) { invalid = (e as Error).message; }
  assert(invalid !== null, 'an unknown DB_MODE is an error, not a silent default', invalid);
  let prod: string | null = null;
  try { db.assertDbModeAllowed({ DB_MODE: 'memory', NODE_ENV: 'production' } as NodeJS.ProcessEnv); } catch (e) { prod = (e as Error).message; }
  assert(prod !== null && /production/.test(prod), 'DB_MODE=memory is refused when NODE_ENV=production', prod);
  assert((() => { try { db.assertDbModeAllowed({ DB_MODE: 'memory', NODE_ENV: 'development' } as NodeJS.ProcessEnv); return true; } catch { return false; } })(), 'memory mode is allowed with NODE_ENV=development');
  const throwsMsg = (env: Record<string, string>): string | null => { try { db.assertDbModeAllowed(env as NodeJS.ProcessEnv); return null; } catch (e) { return (e as Error).message; } };
  const unsetMsg = throwsMsg({ DB_MODE: 'memory' });
  assert(unsetMsg !== null && /NODE_ENV is not set/.test(unsetMsg), 'DB_MODE=memory is refused when NODE_ENV is unset (fail closed, #160)', unsetMsg);
  const stagingMsg = throwsMsg({ DB_MODE: 'memory', NODE_ENV: 'staging' });
  assert(stagingMsg !== null && /NODE_ENV=staging/.test(stagingMsg), 'DB_MODE=memory is refused when NODE_ENV=staging', stagingMsg);
  assert(throwsMsg({ DB_MODE: 'memory', NODE_ENV: 'test' }) === null, 'memory mode is allowed with NODE_ENV=test');
  assert(throwsMsg({}) === null, 'PostgreSQL mode never trips the guard, whatever NODE_ENV is');

  console.log('\n--- NODE_ENV helpers (#160) ---');
  assert(isNonProductionEnv({ NODE_ENV: 'development' }) && isNonProductionEnv({ NODE_ENV: 'test' }) && isNonProductionEnv({ NODE_ENV: ' Test ' }), 'development and test (trimmed, any case) are non-production');
  assert(['production', 'staging', 'dev', ''].every((v) => !isNonProductionEnv({ NODE_ENV: v })) && !isNonProductionEnv({}), 'production, staging, dev, blank and unset are all treated as production');
  const unsetWarn = runtimeEnvWarnings({});
  assert(unsetWarn.length === 1 && unsetWarn[0].includes('NODE_ENV is not set'), 'an unset NODE_ENV gives one startup warning', unsetWarn);
  assert(['production', 'development', 'test'].every((v) => runtimeEnvWarnings({ NODE_ENV: v }).length === 0), 'production, development and test give no warning');
  const stagingWarn = runtimeEnvWarnings({ NODE_ENV: 'staging' });
  assert(stagingWarn.length === 1 && stagingWarn[0].includes('treated as production'), 'an unrecognised NODE_ENV warns that it is treated as production', stagingWarn);

  console.log('\n--- PostgreSQL unreachable and no DB_MODE=memory: fail loudly ---');
  const conn = await rejects(db.checkDatabaseConnection());
  assert(conn !== null && /PostgreSQL connection failed/.test(conn) && /DB_MODE=memory/.test(conn), 'checkDatabaseConnection rejects with an actionable message', conn);
  const q1 = await rejects(db.queryWithTenant('tenant_x', 'SELECT 1', []));
  assert(q1 !== null, 'queryWithTenant throws instead of answering from memory', q1);
  const q2 = await rejects(db.queryWithTenant('tenant_x', 'SELECT 1', []));
  assert(q2 !== null, 'and still throws on the next call: there is no sticky fallback flag');
  assert((await rejects(db.upsertTenantMember('tenant_x', { userId: 'u', email: 'u@x.mil', name: 'u', role: 'VIEWER' }))) !== null, 'writes fail instead of being accepted into memory');
  assert((await rejects(db.initDb())) !== null, 'initDb rejects');
  assert((await db.getDatabaseStatus()) === 'unavailable', 'health status is "unavailable", not "healthy"');
  assert((await db.isTenantMember('u', 'tenant_x')) === false, 'membership checks fail closed (false)');
  assert((await db.getTenantRole('u', 'tenant_x')) === null, 'role lookups fail closed (null)');

  console.log('\n--- Explicit memory mode ---');
  process.env.DB_MODE = 'memory';
  assert((await db.getDatabaseStatus()) === 'memory', 'status is "memory" and says so');
  await db.upsertTenantMember('tenant_x', { userId: 'u', email: 'u@x.mil', name: 'u', role: 'VIEWER' });
  assert((await db.getTenantRole('u', 'tenant_x')) === 'VIEWER', 'the in-memory store works only when explicitly requested');
  delete process.env.DB_MODE;
  assert((await db.getDatabaseStatus()) === 'unavailable', 'and switching it off goes straight back to failing loudly');

  console.log('\n--- The real server process ---');
  const run = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '8097', DATABASE_URL: '', DB_HOST: '127.0.0.1', DB_PORT: '1', NODE_ENV: 'test', LOCAL_AUTH_SECRET: 'x'.repeat(40), AUTH_MODE: '', STORAGE_PROVIDER: '', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const noDb = run({ DB_MODE: '' });
  assert(noDb.code === 1 && /\[FATAL\]/.test(noDb.out), 'server with unreachable PostgreSQL exits 1 with a [FATAL] message', { code: noDb.code });
  assert(/PostgreSQL connection failed/.test(noDb.out), 'and the failure is the database, not a missing auth secret', noDb.out.slice(-300));
  const memProd = run({ DB_MODE: 'memory', NODE_ENV: 'production' });
  assert(memProd.code === 1 && /not allowed when NODE_ENV=production/.test(memProd.out), 'server refuses DB_MODE=memory in production (exit 1)', { code: memProd.code });
  const memStaging = run({ DB_MODE: 'memory', NODE_ENV: 'staging' });
  assert(memStaging.code === 1 && /DB_MODE=memory is not allowed when NODE_ENV=staging/.test(memStaging.out), 'server refuses DB_MODE=memory with an unrecognised NODE_ENV (exit 1, #160)', { code: memStaging.code });
  const noSecret = run({ DB_MODE: 'memory', LOCAL_AUTH_SECRET: '' });
  assert(noSecret.code === 1 && /LOCAL_AUTH_SECRET/.test(noSecret.out), 'server refuses to start without a signing secret (exit 1)', { code: noSecret.code });
  const removedMode = run({ DB_MODE: 'memory', AUTH_MODE: ['fire', 'base'].join('') });
  assert(removedMode.code === 1 && /AUTH_MODE="[a-z]+" is not supported/.test(removedMode.out), 'server refuses a removed AUTH_MODE (exit 1)', { code: removedMode.code });
  const oauthMode = run({ DB_MODE: 'memory', AUTH_MODE: 'oauth' });
  assert(oauthMode.code === 1 && /AUTH_MODE="oauth" is not supported/.test(oauthMode.out), 'server refuses AUTH_MODE=oauth (exit 1)', { code: oauthMode.code });
  const gcsStore = run({ DB_MODE: 'memory', STORAGE_PROVIDER: 'gcs' });
  assert(gcsStore.code === 1 && /STORAGE_PROVIDER="gcs" is not supported/.test(gcsStore.out), 'server refuses STORAGE_PROVIDER=gcs (exit 1)', { code: gcsStore.code });
  const s3Store = run({ DB_MODE: 'memory', STORAGE_PROVIDER: 's3' });
  assert(s3Store.code === 1 && /STORAGE_PROVIDER="s3" is not supported/.test(s3Store.out), 'server refuses STORAGE_PROVIDER=s3 (exit 1)', { code: s3Store.code });

  console.log('\n--- Source pins (#160) ---');
  const norm = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const scripts = (JSON.parse(norm('package.json')) as { scripts: Record<string, string> }).scripts;
  assert(['dev', 'dev:full', 'dev:server'].every((k) => scripts[k].includes('server/dev.ts')), 'npm run dev, dev:full and dev:server start server/dev.ts (NODE_ENV=development)');
  assert(['start', 'start:server'].every((k) => scripts[k].includes('server/index.ts') && !scripts[k].includes('server/dev.ts')), 'start and start:server still run server/index.ts, never the dev entry');
  const devEntry = norm('server/dev.ts');
  assert(devEntry.includes("process.env.NODE_ENV = 'development'") && devEntry.includes("import('./index')"), 'server/dev.ts defaults NODE_ENV to development and then loads the server');
  const mw = norm('server/middleware/authMiddleware.ts');
  assert(mw.includes('isNonProductionEnv(') && !mw.includes("NODE_ENV !== 'production'"), 'the per-request mock-token gate uses isNonProductionEnv, not a production-only test');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
