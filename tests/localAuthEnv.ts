/**
 * Import AFTER './testEnv' and BEFORE '../server/index' in tests that exercise air-gapped local authentication.
 * The cost factor is lowered only so the suite is fast; production defaults to 12.
 */
process.env.AUTH_MODE = 'local';
process.env.LOCAL_AUTH_SECRET = 'test-only-secret-0123456789abcdef-0123456789abcdef';
process.env.LOCAL_AUTH_BCRYPT_COST = '4';
export {};
