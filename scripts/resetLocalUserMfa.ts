/**
 * Removes a local user's second factor and recovery codes (the recovery path when someone has lost both their
 * authenticator and their recovery codes, or when the last platform administrator is locked out).
 *
 *   npm run auth:reset-mfa -- you@example.mil
 *
 * Run it at the server's keyboard with the same DATABASE_URL / DB_* as the server. It also ends the person's sessions and
 * clears a lockout; at their next sign-in they enrol a new factor (when MFA_REQUIRED asks for one). Requires PostgreSQL.
 */
export {};

const [email] = process.argv.slice(2);

if (!email) {
  console.error('Usage: npm run auth:reset-mfa -- <email>');
  process.exit(2);
}

const { getDbMode, initDb, pool } = await import('../server/db');
const { resetLocalUserMfa } = await import('../server/auth/localUsers');

let exitCode = 0;
try {
  if (getDbMode() === 'memory') {
    throw new Error('DB_MODE=memory has no persistent accounts to reset. Point DATABASE_URL / DB_* at PostgreSQL.');
  }
  await initDb(); // makes sure the local_users table (and its factor columns) exist
  // The account event (mfa_reset, actor kind cli, no actor id) joins the same transaction as the reset.
  const result = await resetLocalUserMfa(email, { actorKind: 'cli', actorUserId: null, action: 'mfa_reset' });
  if (!result.found) {
    exitCode = 1;
    console.error(`No local user with the email ${email}.`);
  } else {
    console.log(`Removed the second factor and recovery codes for ${email}; their sessions are signed out.`);
  }
} catch (err: unknown) {
  exitCode = 1;
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(exitCode);
