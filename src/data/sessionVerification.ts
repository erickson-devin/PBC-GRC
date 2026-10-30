/**
 * Whether a stored (cached) session has been confirmed by the server since the page loaded. Pure: no React, no storage.
 *
 *   none       nothing to verify (not signed in, or the session was just created by a sign-in)
 *   verifying  a cached session whose first tenant sync has not answered yet: show a verifying screen, not the app
 *   verified   the server accepted the session
 *   offline    the server could not be reached (or timed out): the cache is shown, with a notice
 */

/** How long a reload waits for the server before showing the cached app with the offline notice. */
export const SESSION_VERIFY_TIMEOUT_MS = 8000;

/** What the tenant sync learned about the session. */
export type SyncOutcome = 'verified' | 'rejected' | 'password_change_required' | 'offline';

export type SessionCheck = 'none' | 'verifying' | 'verified' | 'offline';

export type SessionCheckEvent =
  | { type: 'sync'; outcome: SyncOutcome }
  | { type: 'timeout' }
  | { type: 'signedIn' }
  | { type: 'signedOut' };

/** A reload verifies only when a token AND a user are stored. */
export function initialSessionCheck(hasStoredToken: boolean, hasStoredUser: boolean): SessionCheck {
  return hasStoredToken && hasStoredUser ? 'verifying' : 'none';
}

/** A thrown sync error: only a 401 means the session is dead; everything else (network, 5xx, 429, other 4xx) is an outage. */
export function outcomeFromSyncError(err: unknown): SyncOutcome {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 ? 'rejected' : 'offline';
}

export function nextSessionCheck(current: SessionCheck, event: SessionCheckEvent): SessionCheck {
  if (event.type === 'signedOut') return 'none';
  if (event.type === 'signedIn') return 'verified';
  if (current === 'verifying') {
    if (event.type === 'timeout') return 'offline';
    switch (event.outcome) {
      case 'verified':
      case 'password_change_required':
        return 'verified';
      case 'rejected':
        return 'none';
      default:
        return 'offline';
    }
  }
  if (current === 'offline' && event.type === 'sync') {
    if (event.outcome === 'verified') return 'verified';
    if (event.outcome === 'rejected') return 'none';
  }
  return current;
}

/** True while the app must not render the cached session yet. */
export function shouldHoldForVerification(check: SessionCheck): boolean {
  return check === 'verifying';
}

/** The programs and team requests only go out with a session and while no forced password change is pending (they would answer 403). */
export function mayLoadServerData(hasToken: boolean, serverLoadsPaused: boolean): boolean {
  return hasToken && !serverLoadsPaused;
}
