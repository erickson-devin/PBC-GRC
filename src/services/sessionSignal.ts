/**
 * "The server ended this session" signal. The API client reports every response here; a 401 on a request whose session
 * reference (the X-PBC-Session marker) is still the stored one means the session is no longer accepted, and the app should sign out once.
 * It also carries a cross-tab end (#32): another tab of this browser signed out or signed in as someone else.
 * Pure: no React and no import from the API client (the client passes the stored reference in).
 */

type SessionListener = (token: string, reason?: string) => void;

/**
 * Why a tab's session ended without the server rejecting it: another tab of this browser signed out or signed in as someone else (#32).
 * `session_mismatch` is the one such reason the server also sends: the browser's cookie belongs to another session (#149).
 */
export type CrossTabReason = 'signed_out_elsewhere' | 'switched_elsewhere' | 'session_mismatch';

/**
 * `session_idle` (the server ended the session after a period without requests, #163) and `mfa_required` (the account's role now
 * needs two-step verification, #39) are the two the app answers with a lock screen instead of a sign-out: see isReauthReason.
 */
export type SessionEndReason = 'session_missing' | 'session_invalid' | 'session_expired' | 'session_revoked' | 'session_idle' | 'mfa_required' | CrossTabReason;

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again.';
export const SESSION_REVOKED_MESSAGE = 'Your session ended because your account was updated, for example a password change or an administrator action. Please sign in again. If you cannot sign in, contact your administrator.';

export const SESSION_IDLE_MESSAGE = 'Your session was locked after a period of inactivity. Sign in again to continue.';
export const MFA_REQUIRED_MESSAGE = 'Your role now requires two-step verification. Sign in again to continue.';

export const SIGNED_OUT_ELSEWHERE_MESSAGE = 'You signed out in another tab. Sign in again to continue.';
export const SWITCHED_ELSEWHERE_MESSAGE = 'Another account signed in from another tab of this browser, so this tab was signed out. Signing in here signs that tab out.';
export const SESSION_MISMATCH_MESSAGE = "This tab's session no longer matches the one this browser is signed in with, usually because another tab signed in. Sign in again to continue.";

/** The sign-in screen's message after the server ended a session. Unknown or missing reasons get the generic text. */
export function sessionEndedMessage(reason?: string | null): string {
  if (reason === 'session_expired') return SESSION_EXPIRED_MESSAGE;
  if (reason === 'session_revoked') return SESSION_REVOKED_MESSAGE;
  if (reason === 'session_idle') return SESSION_IDLE_MESSAGE;
  if (reason === 'mfa_required') return MFA_REQUIRED_MESSAGE;
  if (reason === 'signed_out_elsewhere') return SIGNED_OUT_ELSEWHERE_MESSAGE;
  if (reason === 'switched_elsewhere') return SWITCHED_ELSEWHERE_MESSAGE;
  if (reason === 'session_mismatch') return SESSION_MISMATCH_MESSAGE;
  return SESSION_ENDED_MESSAGE;
}

/** True for the reasons that come from another tab of this browser (or the browser's cookie) rather than from a rejected session. */
export function isCrossTabReason(reason?: string | null): reason is CrossTabReason {
  return reason === 'signed_out_elsewhere' || reason === 'switched_elsewhere' || reason === 'session_mismatch';
}

/** True for the reasons the app answers by locking the screen (the person signs in again in place) instead of signing out. */
export function isReauthReason(reason?: string | null): reason is 'session_idle' | 'mfa_required' {
  return reason === 'session_idle' || reason === 'mfa_required';
}

const listeners = new Set<SessionListener>();
const held = new Set<string>();
let lastSignalled: string | null = null;

/** The header that carries the session reference on every cookie request (a CSRF marker; the server also compares it with the session cookie's own reference and answers `session_mismatch` when they differ). */
export const SESSION_MARKER_HEADER = 'X-PBC-Session';

/** The session reference in an `X-PBC-Session` header of any HeadersInit shape, else null. */
export function sessionRefFromHeaders(h: HeadersInit | undefined): string | null {
  if (!h) return null;
  let value: string | null | undefined;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    value = h.get(SESSION_MARKER_HEADER);
  } else if (Array.isArray(h)) {
    value = h.find(([name]) => String(name).toLowerCase() === SESSION_MARKER_HEADER.toLowerCase())?.[1];
  } else {
    const record = h as Record<string, string>;
    const key = Object.keys(record).find((name) => name.toLowerCase() === SESSION_MARKER_HEADER.toLowerCase());
    value = key === undefined ? undefined : record[key];
  }
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return ref || null;
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

function emit(token: string, reason?: string | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(token, reason ?? undefined);
    } catch {
      // one failing listener must not stop the others
    }
  }
}

/** Reports one response. Signals once per rejected token, never for a held token (e.g. a password change in flight). */
export function reportResponseStatus(status: number, sentBearer: string | null | undefined, currentToken: string | null | undefined, reason?: string | null): void {
  if (!isSessionRejection(status, sentBearer, currentToken)) return;
  const token = sentBearer as string;
  if (held.has(token) || token === lastSignalled) return;
  lastSignalled = token;
  emit(token, reason);
}

/**
 * Reports that another tab ended or replaced this tab's session (#32). Once per reference, and asynchronous because it can be
 * called while a component renders. It ignores holds: nothing in this tab can be in flight for a session that is gone.
 */
export function reportCrossTabEnd(ref: string | null | undefined, reason: CrossTabReason): void {
  if (!ref) return;
  queueMicrotask(() => {
    if (ref === lastSignalled) return;
    lastSignalled = ref;
    emit(ref, reason);
  });
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
