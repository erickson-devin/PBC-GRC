/**
 * "The server ended this session" signal. The API client reports every response here; a 401 on the bearer that is still the
 * stored session token means the account, token or secret is no longer accepted, and the app should sign out once.
 * Pure: no React and no import from the API client (the client passes the stored token in).
 */

type SessionListener = (token: string, reason?: string) => void;

export type SessionEndReason = 'session_missing' | 'session_invalid' | 'session_expired' | 'session_revoked';

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again.';
export const SESSION_REVOKED_MESSAGE = 'Your session ended because your account was updated, for example a password change or an administrator action. Please sign in again. If you cannot sign in, contact your administrator.';

/** The sign-in screen's message after the server ended a session. Unknown or missing reasons get the generic text. */
export function sessionEndedMessage(reason?: string | null): string {
  if (reason === 'session_expired') return SESSION_EXPIRED_MESSAGE;
  if (reason === 'session_revoked') return SESSION_REVOKED_MESSAGE;
  return SESSION_ENDED_MESSAGE;
}

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
export function reportResponseStatus(status: number, sentBearer: string | null | undefined, currentToken: string | null | undefined, reason?: string | null): void {
  if (!isSessionRejection(status, sentBearer, currentToken)) return;
  const token = sentBearer as string;
  if (held.has(token) || token === lastSignalled) return;
  lastSignalled = token;
  for (const listener of [...listeners]) {
    try {
      listener(token, reason ?? undefined);
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
