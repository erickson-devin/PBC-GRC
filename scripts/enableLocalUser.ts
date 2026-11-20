/**
 * Enables a disabled local account (the break-glass when the last platform administrator was disabled for inactivity, or any account
 * nobody left can restore through the console).
 *
 *   npm run auth:enable-user -- you@example.mil
 *
 * Run it at the server's keyboard with the same DATABASE_URL / DB_* as the server. It clears the disabled state and any lockout and
 * restarts the inactivity clock, so the account is not disabled again at once. A second factor kept by an inactivity disable still
 * works; one removed by an administrator's disable is not restored. Records an account_enabled event (actor kind cli).
 * Requires PostgreSQL.
 */
export {};

const [email] = process.argv.slice(2);

if (!email) {
  console.error('Usage: npm run auth:enable-user -- <email>');
  process.exit(2);
}

const { getDbMode, initDb, pool } = await import('../server/db');
const { findLocalUserByEmail, setLocalUserDisabled } = await import('../server/auth/localUsers');

let exitCode = 0;
try {
  if (getDbMode() === 'memory') {
    throw new Error('DB_MODE=memory has no persistent accounts to enable. Point DATABASE_URL / DB_* at PostgreSQL.');
  }
  await initDb(); // makes sure the local_users table (and its dormancy columns) exist
  const user = await findLocalUserByEmail(email);
  if (!user) {
    exitCode = 1;
    console.error(`No local user with the email ${email}.`);
  } else {
    const wasDormant = user.disabled && user.disabledReason === 'dormant';
    // The account event (account_enabled, actor kind cli, no actor id) joins the same transaction as the change.
    await setLocalUserDisabled(user.id, false, {
      actorKind: 'cli',
      actorUserId: null,
      targetUserId: user.id,
      action: 'account_enabled',
      ...(wasDormant ? { details: { reason: 'dormant' } } : {}),
    });
    console.log(`Enabled ${email}${user.disabled ? '' : ' (it was not disabled)'}; the inactivity period starts again now.`);
  }
} catch (err: unknown) {
  exitCode = 1;
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end().catch(() => undefined);
}
process.exit(exitCode);
