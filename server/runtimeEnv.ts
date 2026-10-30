/**
 * Runtime environment classification (#160). Fail closed: only an explicit NODE_ENV of development or test relaxes the
 * production safeguards (DB_MODE=memory, ALLOW_DEV_MOCK_TOKENS, superuser database role). Unset, blank or any other
 * value is treated as production. Pure: no imports and no logging.
 */

const normalized = (env: NodeJS.ProcessEnv): string => (env.NODE_ENV ?? '').trim().toLowerCase();

/** True only for NODE_ENV=development or NODE_ENV=test (case-insensitive, trimmed). */
export function isNonProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = normalized(env);
  return v === 'development' || v === 'test';
}

/** For error messages: the NODE_ENV value as set, or a statement that it is not set. */
export function describeNodeEnv(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.NODE_ENV ?? '').trim();
  return v === '' ? 'NODE_ENV is not set' : `NODE_ENV=${v}`;
}

/** Warnings the server logs once at startup (the caller logs them; nothing here prints). */
export function runtimeEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.NODE_ENV ?? '').trim();
  if (raw === '') {
    return ['NODE_ENV is not set: the server runs with production safeguards (DB_MODE=memory and ALLOW_DEV_MOCK_TOKENS are refused). Set NODE_ENV=production for an installation; npm run dev sets NODE_ENV=development.'];
  }
  const v = raw.toLowerCase();
  if (v !== 'production' && v !== 'development' && v !== 'test') {
    return [`NODE_ENV="${raw}" is not production, development or test: it is treated as production.`];
  }
  return [];
}
