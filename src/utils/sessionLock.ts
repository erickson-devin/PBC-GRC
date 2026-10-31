import type { LockReason } from '../context/AuthContext';

/** Read by assistive technology when the idle warning appears (#163). */
export const IDLE_WARNING_ANNOUNCEMENT = 'This session locks in about one minute because there has been no activity. Press any key or choose Stay signed in to keep working.';
export const ENROL_REQUIRED_TEXT = 'Owners and administrators must use two-step verification on this installation. Set it up to continue.';
export const OWNER_MFA_NOTICE = 'Owners must use two-step verification on this installation. After the organization is created, the screen locks and asks for your password, then for a code from an authenticator app (or to set one up). Nothing you entered here is lost.';

/** Seconds as m:ss; anything that is not a finite number shows 0:00. */
export function formatCountdown(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function lockHeading(reason: LockReason): string {
  return reason === 'mfa_required' ? 'Two-step verification required' : 'Session locked';
}

export function lockReasonText(reason: LockReason): string {
  if (reason === 'session_idle') return 'The server ended this session after a period without activity. Your open work is still here: enter your password to continue.';
  if (reason === 'mfa_required') return 'Your role now requires two-step verification, for example because you created an organization or became its owner. Enter your password, then the code from your authenticator app. If you have not set one up yet, you will do that next. Your open work is still here.';
  return 'This session locked after a period without activity, or because Lock now was chosen in this browser. Your open work is still here: enter your password to continue.';
}

/** What the sign-out confirmation says about text that has not been saved to the server. */
export function signOutWarning(count: number): string {
  if (count <= 0) return 'You will go back to the sign-in page. No unsaved text was found in the open editors.';
  const one = count === 1;
  return `${count} unsaved field${one ? '' : 's'} in the open editors ${one ? 'has' : 'have'} not been saved to the server. If you sign out, ${one ? 'it is' : 'they are'} kept in this tab's memory only, and you can copy ${one ? 'it' : 'them'} after you sign in again as the same user. Reloading the page, or another person signing in, deletes ${one ? 'it' : 'them'}.`;
}

/** The owner notice shows for a person without two-step verification while the installation enforces it for owners. */
export function showOwnerMfaNotice(mode: string | null, enrolled: boolean): boolean {
  return !enrolled && (mode === 'privileged' || mode === 'all');
}
