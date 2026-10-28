/**
 * "The server ended this session" signal. The API client reports every response here; a 401 on the bearer that is still the
 * stored session token means the account, token or secret is no longer accepted, and the app should sign out once.
 * Pure: no React and no import from the API client (the client passes the stored token in).
 */

type SessionListener = (token: string) => void;

const listeners = new Set<SessionListener>();
const held = new Set<string>();
let lastSignalled: string | null = null;

/** The token in an `Authorization: Bearer <token>` header of any HeadersInit shape, else null. */
export function bearerFromHeaders(h: HeadersInit | undefined): string | null {
  if (!h) return null;
  let value: string | null | undefined;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    value = h.get('Authorization');
  } else if (Array.isArray(h)) {
    value = h.find(([name]) => String(name).toLowerCase() === 'authorization')?.[1];
  } else {
    const record = h as Record<string, string>;
    value = record['Authorization'] ?? record['authorization'];
  }
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

/** True only for a 401 on a request that carried a session bearer which is still the stored token. */
export function isSessionRejection(status: number, sentBearer: string | null | undefined, currentToken: string | null | undefined): boolean {
  return status === 401 && !!sentBearer && sentBearer === currentToken;
}

/** Subscribes to session rejections; returns the unsubscribe function. */
export function onSessionRejected(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reports one response. Signals once per rejected token, never for a held token (e.g. a password change in flight). */
export function reportResponseStatus(status: number, sentBearer: string | null | undefined, currentToken: string | null | undefined): void {
  if (!isSessionRejection(status, sentBearer, currentToken)) return;
  const token = sentBearer as string;
  if (held.has(token) || token === lastSignalled) return;
  lastSignalled = token;
  for (const listener of [...listeners]) {
    try {
      listener(token);
    } catch {
      // one failing listener must not stop the others
    }
  }
}

/** Suppresses signals for this token until released. */
export function holdSessionSignal(token: string | null | undefined): void {
  if (token) held.add(token);
}

/** Ends a hold started by holdSessionSignal. */
export function releaseSessionSignal(token: string | null | undefined): void {
  if (token) held.delete(token);
}

/** Clears all state (tests only). */
export function resetSessionSignal(): void {
  listeners.clear();
  held.clear();
  lastSignalled = null;
}
