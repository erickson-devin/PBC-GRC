/**
 * One-time cleanup of the session JWT that earlier versions kept in browser storage (the session is now an HttpOnly cookie).
 * Pure: takes the storage in. Never logs; unreadable values are left alone.
 */

const LEGACY_TOKEN_KEY = 'pbc_session_id_token_v2';
const USER_RECORD_KEYS = ['pbc_session_auth_user_v2', 'pbc_active_user_v4'];
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Removes the stored legacy session token and any JWT-shaped `idToken` inside the stored user records. Returns how many things changed. */
export function scrubLegacySessionToken(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): number {
  let changed = 0;
  if (storage.getItem(LEGACY_TOKEN_KEY) !== null) {
    storage.removeItem(LEGACY_TOKEN_KEY);
    changed++;
  }
  for (const key of USER_RECORD_KEYS) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.idToken !== 'string' || !JWT_SHAPE.test(record.idToken)) continue;
    delete record.idToken;
    storage.setItem(key, JSON.stringify(record));
    changed++;
  }
  return changed;
}
