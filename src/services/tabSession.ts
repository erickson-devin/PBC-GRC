/**
 * Which browser session this tab belongs to (#32). The session reference and the user record live in localStorage, shared by
 * every tab of the browser; another tab can sign out or sign in as someone else underneath this one. This tab pins the
 * reference (and user) it signed in with and compares it with the stored ones.
 * Pure: it only reads storage (never writes), logs nothing and makes no request.
 */
import type { CrossTabReason } from './sessionSignal';

const REF_KEY = 'pbc_session_ref_v3';
const USER_KEY = 'pbc_session_auth_user_v2';

/** 'own' = the stored session is this tab's; 'adopt' = same user, the reference was rotated elsewhere; else the session ended. */
export type TabSessionState = 'own' | 'adopt' | CrossTabReason;

export interface TabSessionPin {
  ref: string;
  userId: string | null;
}

let pin: TabSessionPin | null = null;

/** Pins the session this tab signed in with; a missing reference clears the pin. */
export function pinTabSession(ref: string | null | undefined, userId?: string | null): void {
  pin = ref ? { ref, userId: userId || null } : null;
}

export function tabSessionPin(): TabSessionPin | null {
  return pin;
}

/** The stored session reference and the id of the stored user record (null for anything missing or malformed). */
export function readStoredSession(storage?: Pick<Storage, 'getItem'>): { ref: string | null; userId: string | null } {
  try {
    const store = storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
    if (!store) return { ref: null, userId: null };
    const ref = store.getItem(REF_KEY) || null;
    let userId: string | null = null;
    const raw = store.getItem(USER_KEY);
    if (raw) {
      try {
        const id = (JSON.parse(raw) as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id) userId = id;
      } catch {
        // a user record that is not JSON has no id
      }
    }
    return { ref, userId };
  } catch {
    return { ref: null, userId: null };
  }
}

/** Compares the pinned session with the stored one. */
export function crossTabChange(pinned: TabSessionPin | null, storedRef: string | null, storedUserId: string | null): TabSessionState {
  if (!pinned) return 'own';
  if (!storedRef) return 'signed_out_elsewhere';
  if (pinned.userId && storedUserId && storedUserId !== pinned.userId) return 'switched_elsewhere';
  if (storedRef === pinned.ref) return 'own';
  if (pinned.userId && storedUserId === pinned.userId) return 'adopt';
  return 'switched_elsewhere';
}

export function tabSessionState(storage?: Pick<Storage, 'getItem'>): TabSessionState {
  const stored = readStoredSession(storage);
  return crossTabChange(pin, stored.ref, stored.userId);
}

/** True while the stored session is this tab's (or the same user's, rotated elsewhere): the tab may write the shared keys. */
export function tabOwnsStoredSession(storage?: Pick<Storage, 'getItem'>): boolean {
  const state = tabSessionState(storage);
  return state === 'own' || state === 'adopt';
}

/** Clears the pin (tests only). */
export function resetTabSession(): void {
  pin = null;
}
