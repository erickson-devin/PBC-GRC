import { spawnSync } from 'child_process';

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
  assert((() => { try { db.assertDbModeAllowed({ DB_MODE: 'memory', NODE_ENV: 'development' } as NodeJS.ProcessEnv); return true; } catch { return false; } })(), 'memory mode is allowed outside production');

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
      env: { ...process.env, PORT: '8097', DATABASE_URL: '', DB_HOST: '127.0.0.1', DB_PORT: '1', NODE_ENV: 'test', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const noDb = run({ DB_MODE: '' });
  assert(noDb.code === 1 && /\[FATAL\]/.test(noDb.out), 'server with unreachable PostgreSQL exits 1 with a [FATAL] message', { code: noDb.code });
  const memProd = run({ DB_MODE: 'memory', NODE_ENV: 'production' });
  assert(memProd.code === 1 && /not allowed when NODE_ENV=production/.test(memProd.out), 'server refuses DB_MODE=memory in production (exit 1)', { code: memProd.code });
  const noSecret = run({ DB_MODE: 'memory', AUTH_MODE: 'local', LOCAL_AUTH_SECRET: '' });
  assert(noSecret.code === 1 && /LOCAL_AUTH_SECRET/.test(noSecret.out), 'server refuses AUTH_MODE=local without a signing secret (exit 1)', { code: noSecret.code });

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
