/**
 * Import this module FIRST in any test that boots the Express server (`import './testEnv'`).
 * ES imports execute in order, so these values are set before `server/index` reads them.
 *  - PORT must match the port the HTTP helpers in the tests target.
 *  - NODE_ENV must not be 'production': tests authenticate with dev-only mock tokens,
 *    which the auth middleware deliberately rejects in production.
 */
process.env.PORT = '8080';
process.env.NODE_ENV = 'test';
export {};
