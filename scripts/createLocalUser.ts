/**
 * Creates a local (air-gapped) user account.
 *
 *   LOCAL_USER_PASSWORD='a long passphrase' npm run auth:create-user -- you@example.mil "Your Name"
 *
 * The password comes from the environment (never a command-line argument, so it stays out of shell history and
 * process listings). Requires PostgreSQL: accounts created in DB_MODE=memory would vanish on restart.
 */
export {};

const [email, ...nameParts] = process.argv.slice(2);
const password = process.env.LOCAL_USER_PASSWORD ?? '';

if (!email || !password) {
  console.error('Usage: LOCAL_USER_PASSWORD=... npm run auth:create-user -- <email> ["Full Name"]');
  process.exit(2);
}

const { getDbMode, initDb, pool } = await import('../server/db');
const { createLocalUser, LocalUserExistsError } = await import('../server/auth/localUsers');

let exitCode = 0;
try {
  if (getDbMode() === 'memory') {
    throw new Error('DB_MODE=memory would not persist this account. Point DATABASE_URL / DB_* at PostgreSQL.');
  }
  await initDb(); // makes sure the local_users table exists
  // A credential an operator typed is temporary: the person must change it before anything else works.
  const user = await createLocalUser({ email, name: nameParts.join(' '), password }, { mustChangePassword: true });
  console.log(`Created local user ${user.email} (${user.id}). They must change the temporary credential at their first sign-in.`);
} catch (err: unknown) {
  exitCode = 1;
  console.error(err instanceof LocalUserExistsError ? err.message : `Failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(exitCode);
