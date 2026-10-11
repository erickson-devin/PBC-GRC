/**
 * Import this module FIRST in any test that boots the Express server (`import './testEnv'`).
 * ES imports execute in order, so these values are set before `server/index` reads them.
 *  - PORT must match the port the HTTP helpers in the tests target.
 *  - DATABASE_URL / DB_HOST are overridden so these tests can NEVER touch a real database, even if a developer's
 *    .env points at one: the server falls back to its in-memory, RLS-emulating store. (dotenv never overrides a
 *    variable that is already set, so setting it here wins.)
 *  - NODE_ENV must not be 'production': tests authenticate with dev-only mock tokens,
 *    which the auth middleware deliberately rejects in production.
 */
process.env.PORT = '8080';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DB_HOST = '/nonexistent-test-socket';
export {};
