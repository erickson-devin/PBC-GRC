/**
 * Import this module FIRST in any test that boots the Express server (`import './testEnv'`).
 * ES imports execute in order, so these values are set before `server/index` reads them.
 *  - PORT must match the port the HTTP helpers in the tests target.
 *  - DB_MODE=memory is the explicit opt-in to the in-memory, RLS-emulating store (the server no longer falls back
 *    silently). DATABASE_URL is cleared too, so these tests can NEVER touch a real database, even if a developer's
 *    .env points at one. (dotenv never overrides a variable that is already set, so setting it here wins.)
 *  - Local accounts are the only auth mode and startup asserts the configuration, so AUTH_MODE, LOCAL_AUTH_SECRET and
 *    STORAGE_PROVIDER are SET (never deleted): dotenv would refill a deleted value from a developer's .env.
 *  - NODE_ENV must not be 'production', and ALLOW_DEV_MOCK_TOKENS=true is what lets tests authenticate with dev-only
 *    mock tokens, which the auth middleware rejects in production or whenever the flag is absent.
 */
process.env.PORT = '8080';
process.env.NODE_ENV = 'test';
process.env.DB_MODE = 'memory';
process.env.DATABASE_URL = '';
process.env.AUTH_MODE = 'local';
process.env.LOCAL_AUTH_SECRET = 'test-only-secret-0123456789abcdef-0123456789abcdef';
process.env.STORAGE_PROVIDER = 'local';
process.env.ALLOW_DEV_MOCK_TOKENS = 'true';
// The suites that are not about MFA stay on the password-only login path whatever the default is; tests/mfa.test.ts switches it per section.
process.env.MFA_REQUIRED = 'off';
export {};
