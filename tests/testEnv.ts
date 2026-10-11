/**
 * Import this module FIRST in any test that boots the Express server (`import './testEnv'`).
 * ES imports execute in order, so these values are set before `server/index` reads them.
 *  - PORT must match the port the HTTP helpers in the tests target.
 *  - DB_MODE=memory is the explicit opt-in to the in-memory, RLS-emulating store (the server no longer falls back
 *    silently). DATABASE_URL is cleared too, so these tests can NEVER touch a real database, even if a developer's
 *    .env points at one. (dotenv never overrides a variable that is already set, so setting it here wins.)
 *  - AUTH_MODE is reset to the default; tests of local auth opt in via ./localAuthEnv.
 *  - NODE_ENV must not be 'production': tests authenticate with dev-only mock tokens,
 *    which the auth middleware deliberately rejects in production.
 */
process.env.PORT = '8080';
process.env.NODE_ENV = 'test';
process.env.DB_MODE = 'memory';
process.env.DATABASE_URL = '';
delete process.env.AUTH_MODE;
export {};
