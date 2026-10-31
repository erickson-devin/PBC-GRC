import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { User, AuthProviderType } from '../types/tenant';
import { useTenant, ANONYMOUS_USER } from './TenantContext';
import { ApiClient, ApiError, getLastRequestAt, LocalLoginResponse, MfaEnrolmentStart, MfaStage, SetupInput, SetupResult } from '../services/apiClient';
import { onSessionRejected, holdSessionSignal, releaseSessionSignal, reportResponseStatus, sessionEndedMessage, isCrossTabReason, isReauthReason, reportCrossTabEnd, type CrossTabReason } from '../services/sessionSignal';
import { pinTabSession, readStoredSession, tabSessionPin, tabSessionState } from '../services/tabSession';
import {
  ACTIVITY_KEY,
  LOCK_KEY,
  clearActivity,
  clearLock,
  needsHeartbeat,
  readActivity,
  readLock,
  recordActivity,
  runBeforeLock,
  secondsUntilLock,
  shouldLock,
  shouldWarn,
  writeLock,
} from '../services/idleLock';
import { errorMessage } from '../utils/errors';
import { buildUserProfile } from '../utils/userProfile';
import { SESSION_VERIFY_TIMEOUT_MS, initialSessionCheck, nextSessionCheck, type SessionCheck } from '../data/sessionVerification';
import { reconcileRescuedTextOnSignIn, rescueUnsavedText } from '../services/unsavedText';

/** A sign-in that is not finished: the person still has to enter a code ('verify') or enrol an authenticator ('enrol'). Lives in React state only. */
export interface MfaChallenge {
  stage: MfaStage;
  mfaToken: string;
  expiresAt: string;
  methods: string[];
}

export type LoginOutcome = 'ok' | 'mfa' | 'enrol' | 'failed';

/** Why the screen is locked: 'idle' (no input in this browser, or "Lock now"), 'session_idle' (the server ended the session for inactivity), 'mfa_required' (the role now needs two-step verification). */
export type LockReason = 'idle' | 'session_idle' | 'mfa_required';

/** What unlockWithPassword answered: 'ok' unlocked, 'mfa' a code is needed next, 'enrol' an authenticator must be set up next (see mfaChallenge), 'failed' refused, 'offline' the server could not be reached (the reason is in authError for both). */
export type UnlockOutcome = 'ok' | 'mfa' | 'enrol' | 'failed' | 'offline';

/** The idle limit used until the server's answer arrives, and when it cannot be reached (matches the server default of 15 minutes). */
const DEFAULT_IDLE_SECONDS = 15 * 60;
const IDLE_TICK_MS = 15_000;
const DIFFERENT_ACCOUNT_MESSAGE = 'That sign-in belongs to a different account, so the locked session was ended.';

interface AuthContextType {
  currentUser: User;
  sessionRef: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  /**
   * Whether the stored session was confirmed by the server since the page loaded: 'verifying' until the first tenant sync
   * answers (an 8 s limit), 'offline' when the server could not be reached (the cache is shown), 'verified' once it accepted
   * the session, 'none' when there is nothing to verify (signed out, or just signed in).
   */
  sessionCheck: SessionCheck;
  authError: string | null;
  isAuthModalOpen: boolean;
  redirectPath: string | null;
  /** The account must set a new password before anything else works (after an administrator reset, or a CLI-created account). */
  mustChangePassword: boolean;
  /** Whether the signed-in account has a second factor. */
  mfaEnrolled: boolean;
  /** Set while a sign-in waits for its second step (a code, or enrolling an authenticator); null otherwise. */
  mfaChallenge: MfaChallenge | null;
  /** Set after a recovery code was used: how many are left. The sign-in completes with finishMfa(). */
  recoveryCodesRemaining: number | null;
  /**
   * 'ok' when signed in, 'mfa' when a code is needed next, 'enrol' when an authenticator must be set up next (see mfaChallenge),
   * 'failed' when it failed (the reason is in authError).
   */
  loginWithEmailPassword: (email: string, pass: string) => Promise<LoginOutcome>;
  /** Second step of a sign-in: a 6-digit code, or a recovery code. 'recovery' means entering the app waits for finishMfa(), so the notice can be read. */
  completeMfa: (value: string, isRecoveryCode?: boolean) => Promise<'ok' | 'recovery' | 'failed'>;
  /** A new authenticator secret, for the pending sign-in's enrolment or (when signed in) the account's. Throws ApiError. */
  startEnrolment: () => Promise<MfaEnrolmentStart>;
  /** Confirms the authenticator with a code and returns the one-time recovery codes. On the sign-in path the session waits for finishMfa(). Throws ApiError. */
  confirmEnrolment: (code: string) => Promise<string[]>;
  /** Enters the app once the person has seen their recovery codes (or the recovery-code notice). */
  finishMfa: () => Promise<void>;
  /** Abandons a pending second step and returns to the password step. */
  cancelMfa: () => void;
  /** Set while the screen is locked (the app stays mounted behind the lock screen, so open work is kept); null otherwise. */
  lock: { reason: LockReason } | null;
  /** Whole seconds left before the idle lock, counting down every second during the last minute; null otherwise. */
  idleWarning: number | null;
  /**
   * Locks the screen now (the menu's "Lock now", the idle timer, or the server ending the session for inactivity / a role change). Sends typed
   * notes first for 'idle', ends the server session, keeps the app mounted. Does nothing when already locked.
   */
  lockSession: (reason: LockReason) => Promise<void>;
  /**
   * Unlocks with a fresh password sign-in as the same account. 'mfa' / 'enrol' continue through mfaChallenge, completeMfa, confirmEnrolment and
   * finishMfa. A failure sets authError (cleared first). A sign-in as another account ends the session instead and answers 'failed'.
   */
  unlockWithPassword: (password: string) => Promise<UnlockOutcome>;
  /** The "Stay signed in" button: counts as input now, clears the warning and sends a heartbeat when the server session needs one. */
  stayActive: () => void;
  /** Changes the password (with a code, when enrolled). The new session replaces the stored token and the forced-change flag clears. Throws ApiError. */
  changePassword: (currentPassword: string, newPassword: string, code?: string) => Promise<void>;
  /** Creates the account for an invitation's email and accepts it. 'ok' when signed in, 'enrol' when an authenticator must be set up first. Throws ApiError. */
  registerWithInvite: (inviteToken: string, name: string, password: string) => Promise<'ok' | 'enrol'>;
  /** First-time setup: creates the administrator, the primary tenant and the team invitations. `stage` 'enrol' means the administrator sets up an authenticator before the session starts. */
  completeSetup: (input: SetupInput) => Promise<SetupResult & { stage: 'ok' | 'enrol' }>;
  sendPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  openAuthModal: (mode?: 'signin', redirectUrl?: string) => void;
  closeAuthModal: () => void;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_USER_KEY = 'pbc_session_auth_user_v2';
// The session reference (a marker, not a credential): the session itself is an HttpOnly cookie the page cannot read.
const AUTH_SESSION_REF_KEY = 'pbc_session_ref_v3';
// Two booleans about the signed-in account (must change the password / has a second factor). No secret, code or token is ever stored here.
const AUTH_FLAGS_KEY = 'pbc_session_flags_v2';

const readStoredFlags = (): { mustChangePassword: boolean; enrolled: boolean } => {
  try {
    const raw = localStorage.getItem(AUTH_FLAGS_KEY) || '{}';
    const parsed = JSON.parse(raw) as { mustChangePassword?: unknown; enrolled?: unknown };
    return { mustChangePassword: parsed.mustChangePassword === true, enrolled: parsed.enrolled === true };
  } catch {
    return { mustChangePassword: false, enrolled: false };
  }
};

const toChallenge = (p: { stage: MfaStage; mfaToken: string; expiresAt: string; methods?: string[] }): MfaChallenge => ({
  stage: p.stage,
  mfaToken: p.mfaToken,
  expiresAt: p.expiresAt,
  methods: p.methods ?? [],
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolveTenantForEmail, syncAuthUser, resetForSignOut, setServerLoadsPaused, currentUser: tenantUser, currentTenant, tenantSync } = useTenant();

  const [currentUser, setCurrentUser] = useState<User>(() => {
    try {
      const saved = localStorage.getItem(AUTH_USER_KEY);
      if (saved) {
        return JSON.parse(saved) as User;
      }
    } catch (e) {
      console.warn('Failed to load saved user session:', e);
    }
    return tenantUser || ANONYMOUS_USER;
  });

  const [sessionRef, setSessionRef] = useState<string | null>(() => {
    // This tab pins the session it started with, so a sign-out or a different account in another tab is noticed (#32)
    const stored = readStoredSession(localStorage);
    pinTabSession(stored.ref && localStorage.getItem(AUTH_USER_KEY) ? stored.ref : null, stored.userId);
    return stored.ref;
  });
  // The session-ended listener compares against the latest session reference without re-subscribing on every change
  const latestSessionRef = useRef(sessionRef);
  latestSessionRef.current = sessionRef;
  // The unsaved-text rescue needs to know whose text it is, from inside the synchronous session-ended listener
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  // Authenticated state check
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return Boolean(localStorage.getItem(AUTH_USER_KEY) && localStorage.getItem(AUTH_SESSION_REF_KEY));
  });

  // A reload with a stored session verifies it with the server before the app shows (see data/sessionVerification.ts)
  const [sessionCheck, setSessionCheck] = useState<SessionCheck>(() => initialSessionCheck(
    Boolean(localStorage.getItem(AUTH_SESSION_REF_KEY)),
    Boolean(localStorage.getItem(AUTH_USER_KEY)),
  ));

  const [mustChangePassword, setMustChangePassword] = useState<boolean>(() => readStoredFlags().mustChangePassword);
  const [mfaEnrolled, setMfaEnrolled] = useState<boolean>(() => readStoredFlags().enrolled);
  // The pending second step lives in memory only: it is never written to browser storage.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [recoveryCodesRemaining, setRecoveryCodesRemaining] = useState<number | null>(null);
  // A session that is complete but not entered yet (the person is still reading their recovery codes). Memory only.
  const heldSession = useRef<LocalLoginResponse | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // The idle lock (#163). The app stays mounted behind the lock screen, so open work is kept. A reload while locked starts locked:
  // the stored lock record names this session's reference (an opaque marker), and the cached app must not show.
  const [lock, setLock] = useState<{ reason: LockReason } | null>(() => (
    localStorage.getItem(AUTH_USER_KEY) && readLock(localStorage, readStoredSession(localStorage).ref) ? { reason: 'idle' } : null
  ));
  const lockRef = useRef(lock);
  const lockingRef = useRef(false);
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const applyLock = useCallback((next: { reason: LockReason } | null) => {
    lockRef.current = next;
    setLock(next);
  }, []);
  const [idleWarning, setIdleWarning] = useState<number | null>(null);
  const idleWarningRef = useRef<number | null>(null);
  const showWarning = useCallback((seconds: number | null) => {
    if (idleWarningRef.current === seconds) return;
    idleWarningRef.current = seconds;
    setIdleWarning(seconds);
  }, []);
  // The server's idle limit in seconds (0 = the browser never locks by itself); the default stands until the answer arrives
  const [idleSeconds, setIdleSeconds] = useState<number>(DEFAULT_IDLE_SECONDS);
  const lastInputRef = useRef<number>(Date.now());
  const lastActivityWriteRef = useRef<number>(0);
  const lockSessionRef = useRef<(reason: LockReason) => Promise<void>>(async () => {});
  const logoutRef = useRef<() => Promise<void>>(async () => {});

  // Modals & Navigation
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [redirectPath, setRedirectPath] = useState<string | null>(null);

  // Sync user and session reference to storage
  useEffect(() => {
    // this tab writes or clears the shared keys only while the stored session is its own (#32)
    if (tabSessionState() !== 'own') return;
    if (isAuthenticated && currentUser) {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
      if (sessionRef) {
        localStorage.setItem(AUTH_SESSION_REF_KEY, sessionRef);
      }
      const flags = JSON.stringify({ mustChangePassword, enrolled: mfaEnrolled });
      localStorage.setItem(AUTH_FLAGS_KEY, flags);
    } else {
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_SESSION_REF_KEY);
      localStorage.removeItem(AUTH_FLAGS_KEY);
    }
  }, [isAuthenticated, currentUser, sessionRef, mustChangePassword, mfaEnrolled]);

  // While the forced password change is pending, the tenant provider loads no programs or team (every answer would be 403).
  // A layout effect: the flag is set before the provider's own mount effects read it. The same pause covers a locked screen (#163).
  useLayoutEffect(() => setServerLoadsPaused(isAuthenticated && (mustChangePassword || lock !== null)), [isAuthenticated, mustChangePassword, lock, setServerLoadsPaused]);

  /**
   * Helper to build and sync an app user profile from email/credentials
   */
  const handleUserSession = useCallback(async (
    email: string,
    displayName: string | null,
    provider: AuthProviderType,
    sessionRef: string,
    userId?: string,
    skipServerSync = false
  ) => {
    const { tenant, role } = resolveTenantForEmail(email);

    const userProfile: User = {
      ...buildUserProfile(
        { id: userId, email, name: displayName },
        { tenantId: tenant.id, role, organization: tenant.name, provider }
      ),
      idToken: sessionRef,
    };

    // Other tabs read who owns the session from the user record: write it before the reference, then pin this tab (#32)
    try {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(userProfile));
      localStorage.setItem(AUTH_SESSION_REF_KEY, sessionRef);
    } catch {}
    pinTabSession(sessionRef, userProfile.id);

    setCurrentUser(userProfile);
    setSessionRef(sessionRef);
    setIsAuthenticated(true);
    setAuthError(null);
    syncAuthUser(userProfile, tenant.id, { skipServerSync });
  }, [resolveTenantForEmail, syncAuthUser]);

  // Local accounts only: there is no identity provider to wait for.
  useEffect(() => {
    setLoading(false);
  }, []);

  /** Enters the app with a complete session. */
  const applySession = useCallback(async (session: LocalLoginResponse) => {
    // Text rescued from an ended session is kept only for the same person: a different one wipes it
    reconcileRescuedTextOnSignIn(session.user.id);
    setSessionCheck((c) => nextSessionCheck(c, { type: 'signedIn' }));
    // While the forced password change is pending the server answers nothing else: no tenant / programs / data sync yet
    // (changePassword runs it with the new token).
    await handleUserSession(session.user.email, session.user.name, 'password', session.sessionRef, session.user.id, session.mustChangePassword);
    setMustChangePassword(session.mustChangePassword);
    setMfaEnrolled(session.mfaEnrolled);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    setIsAuthModalOpen(false);
  }, [handleUserSession]);

  /**
   * Resumes the locked session with a fresh sign-in of the same account (#163). The new reference is stored before the old signal hold is
   * released (as in changePassword), the tab is re-pinned, the lock cleared, the server loads resumed and the user synced. A sign-in as
   * another account ends the session instead and answers false.
   */
  const resumeFromLock = useCallback(async (session: LocalLoginResponse): Promise<boolean> => {
    const previous = tabSessionPin()?.ref ?? latestSessionRef.current;
    const owner = currentUserRef.current;
    if (session.user.id && owner.id && session.user.id !== owner.id) {
      rescueUnsavedText(owner.id);
      await logoutRef.current();
      setAuthError(DIFFERENT_ACCOUNT_MESSAGE);
      return false;
    }
    setSessionCheck((c) => nextSessionCheck(c, { type: 'signedIn' }));
    // The tenant / programs / data loads read the stored reference: store the new one first, then release the old hold and pin
    try { localStorage.setItem(AUTH_SESSION_REF_KEY, session.sessionRef); } catch {}
    releaseSessionSignal(previous);
    pinTabSession(session.sessionRef, owner.id);
    clearLock(localStorage);
    applyLock(null);
    showWarning(null);
    lastInputRef.current = Date.now();
    setServerLoadsPaused(session.mustChangePassword);
    setSessionRef(session.sessionRef);
    setCurrentUser(prev => ({ ...prev, idToken: session.sessionRef }));
    setMustChangePassword(session.mustChangePassword);
    setMfaEnrolled(session.mfaEnrolled);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    setAuthError(null);
    // The roles cached so far are provisional: load the real ones now that the server accepts requests again
    syncAuthUser({ ...tenantUser, idToken: session.sessionRef }, currentTenant.id, { skipServerSync: session.mustChangePassword });
    return true;
  }, [applyLock, showWarning, setServerLoadsPaused, syncAuthUser, tenantUser, currentTenant.id]);

  /** Enters the app with a complete session: while the screen is locked it resumes the locked session instead. */
  const enterSession = useCallback(async (session: LocalLoginResponse): Promise<boolean> => {
    if (lockRef.current) return resumeFromLock(session);
    await applySession(session);
    return true;
  }, [applySession, resumeFromLock]);

  /**
   * Email & Password Sign-In against the local identity store. The password is not kept here: when a second step
   * follows, only the short-lived pending token is, in React state.
   */
  const loginWithEmailPassword = useCallback(async (email: string, pass: string): Promise<LoginOutcome> => {
    setLoading(true);
    setAuthError(null);
    try {
      const result = await ApiClient.localLogin(email, pass);
      if (result.kind === 'mfa') {
        setMfaChallenge(toChallenge(result));
        return result.stage === 'enrol' ? 'enrol' : 'mfa';
      }
      await applySession(result);
      return 'ok';
    } catch (err: unknown) {
      console.error('Email login failed:', err);
      setAuthError(errorMessage(err) || 'Authentication failed. Please verify your credentials.');
      return 'failed';
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  const completeMfa = useCallback(async (value: string, isRecoveryCode = false): Promise<'ok' | 'recovery' | 'failed'> => {
    if (!mfaChallenge || mfaChallenge.stage !== 'verify') return 'failed';
    setLoading(true);
    setAuthError(null);
    try {
      const session = await ApiClient.verifyMfa(mfaChallenge.mfaToken, isRecoveryCode ? { recoveryCode: value } : { code: value });
      if (typeof session.recoveryCodesRemaining === 'number') {
        heldSession.current = session;
        setRecoveryCodesRemaining(session.recoveryCodesRemaining);
        return 'recovery';
      }
      return (await enterSession(session)) ? 'ok' : 'failed';
    } catch (err: unknown) {
      setAuthError(errorMessage(err) || 'That code could not be checked.');
      // The sign-in step itself is dead: go back to the password step
      const reason = (err as { reason?: string }).reason;
      if (reason === 'mfa_token_invalid' || reason === 'mfa_unavailable') setMfaChallenge(null);
      return 'failed';
    } finally {
      setLoading(false);
    }
  }, [mfaChallenge, enterSession]);

  const startEnrolment = useCallback(async (): Promise<MfaEnrolmentStart> => {
    return ApiClient.startMfaEnrolment(mfaChallenge && mfaChallenge.stage === 'enrol' ? mfaChallenge.mfaToken : undefined);
  }, [mfaChallenge]);

  const confirmEnrolment = useCallback(async (code: string): Promise<string[]> => {
    const pending = mfaChallenge && mfaChallenge.stage === 'enrol' ? mfaChallenge.mfaToken : undefined;
    // From a session the server replaces the session: the old reference must not signal while its requests are still in flight
    const previous = pending ? null : (tabSessionPin()?.ref ?? latestSessionRef.current);
    holdSessionSignal(previous);
    try {
      const confirmed = await ApiClient.confirmMfaEnrolment(code, pending);
      if (confirmed.session && pending) {
        heldSession.current = confirmed.session; // entered by finishMfa(), after the recovery codes were saved
      } else if (confirmed.session) {
        // Adopt the new reference before releasing the old one, as changePassword does
        const next = confirmed.session.sessionRef;
        try { localStorage.setItem(AUTH_SESSION_REF_KEY, next); } catch {}
        releaseSessionSignal(previous);
        pinTabSession(next, currentUserRef.current.id);
        setSessionRef(next);
        setCurrentUser(prev => ({ ...prev, idToken: next }));
        setMfaEnrolled(true);
        setMustChangePassword(confirmed.session.mustChangePassword);
        syncAuthUser({ ...tenantUser, idToken: next }, currentTenant.id);
      } else {
        setMfaEnrolled(true);
      }
      return confirmed.recoveryCodes;
    } finally {
      releaseSessionSignal(previous);
    }
  }, [mfaChallenge, syncAuthUser, tenantUser, currentTenant.id]);

  const finishMfa = useCallback(async (): Promise<void> => {
    const held = heldSession.current;
    if (held) await enterSession(held);
    setRecoveryCodesRemaining(null);
  }, [enterSession]);

  const cancelMfa = useCallback(() => {
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    setAuthError(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string, code?: string): Promise<void> => {
    // The old token stops being valid the moment the password changes: its in-flight requests must not sign the person out
    const previous = sessionRef ?? ApiClient.getSessionRef();
    holdSessionSignal(previous);
    try {
      const session = await ApiClient.changePassword(currentPassword, newPassword, code, sessionRef ?? undefined);
      setSessionRef(session.sessionRef);
      setCurrentUser(prev => ({ ...prev, idToken: session.sessionRef }));
      setMustChangePassword(false);
      setMfaEnrolled(session.mfaEnrolled);
      // The tenant / programs / data loads read the stored token: store the new one first rather than wait for the effect
      try { localStorage.setItem(AUTH_SESSION_REF_KEY, session.sessionRef); } catch {}
      pinTabSession(session.sessionRef, currentUserRef.current.id);
      releaseSessionSignal(previous);
      // The roles cached so far are provisional: load the real ones now that the server accepts requests again
      syncAuthUser({ ...tenantUser, idToken: session.sessionRef }, currentTenant.id);
    } catch (err) {
      // A 401 here is a genuinely dead session (a wrong current password is a 403): report it now that the hold is lifted
      if (err instanceof ApiError && err.status === 401) {
        releaseSessionSignal(previous);
        reportResponseStatus(401, previous, ApiClient.getSessionRef());
      }
      throw err;
    } finally {
      releaseSessionSignal(previous);
    }
  }, [sessionRef, syncAuthUser, tenantUser, currentTenant.id]);

  /**
   * Onboarding by invitation: the server creates the account for the invited email, consumes the invitation
   * and returns a session (or, when an authenticator is required first, the enrolment step).
   * Errors (ApiError, with `reason` e.g. 'account_exists') propagate to the caller.
   */
  const registerWithInvite = useCallback(async (inviteToken: string, name: string, password: string): Promise<'ok' | 'enrol'> => {
    setLoading(true);
    setAuthError(null);
    try {
      const { login } = await ApiClient.registerWithInvite({ token: inviteToken, password, name: name || undefined });
      if (login.kind === 'mfa') {
        setMfaChallenge(toChallenge(login));
        return 'enrol';
      }
      await applySession(login);
      return 'ok';
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  const completeSetup = useCallback(async (input: SetupInput): Promise<SetupResult & { stage: 'ok' | 'enrol' }> => {
    setAuthError(null);
    const { login, setup } = await ApiClient.runSetup(input);
    if (login.kind === 'mfa') {
      setMfaChallenge(toChallenge(login));
      return { ...setup, stage: 'enrol' };
    }
    await applySession(login);
    return { ...setup, stage: 'ok' };
  }, [applySession]);

  /**
   * Password Reset: there is no self-service reset on this installation.
   */
  const sendPasswordReset = useCallback(async (_email: string) => {
    alert('Password resets are handled by your administrator on this on-premises installation.');
  }, []);

  /**
   * Ends this tab's session only, because another tab owns the server session and the shared storage now (it signed out or
   * signed in as someone else). Calls nothing on the server and touches no stored key. The caller rescues the unsaved text first.
   * The pin keeps its reference but loses its user, so a later sign-in of the same user elsewhere is not adopted by a signed-out tab.
   */
  const endSessionInThisTab = useCallback((reason: CrossTabReason) => {
    pinTabSession(tabSessionPin()?.ref ?? null, null);
    resetForSignOut();
    setSessionCheck((c) => nextSessionCheck(c, { type: 'signedOut' }));
    setIsAuthenticated(false);
    setSessionRef(null);
    setMustChangePassword(false);
    setMfaEnrolled(false);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    applyLock(null);
    showWarning(null);
    setLoading(false);
    setAuthError(sessionEndedMessage(reason));
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  }, [resetForSignOut, applyLock, showWarning]);

  /**
   * Sign Out
   */
  const logout = useCallback(async () => {
    // Another tab owns the session now: this tab ends only itself and never clears the server session or the shared storage (#32)
    const state = tabSessionState();
    if (isCrossTabReason(state)) {
      endSessionInThisTab(state);
      return;
    }
    pinTabSession(null);
    void ApiClient.signOut();
    resetForSignOut();
    setSessionCheck((c) => nextSessionCheck(c, { type: 'signedOut' }));
    setIsAuthenticated(false);
    setSessionRef(null);
    setMustChangePassword(false);
    setMfaEnrolled(false);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_SESSION_REF_KEY);
    localStorage.removeItem(AUTH_FLAGS_KEY);
    clearLock(localStorage);
    clearActivity(localStorage);
    applyLock(null);
    showWarning(null);
    setLoading(false);
    // Back to the login screen (the router resolves an empty hash)
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  }, [resetForSignOut, endSessionInThisTab, applyLock, showWarning]);
  logoutRef.current = logout;

  /**
   * Locks the screen (#163, #39): the server session ends, the app stays mounted behind the lock screen so open work is kept, and
   * the person signs in again in place. 'session_idle' and 'mfa_required' mean the server ended the session already: nothing to send first.
   * Another tab that already locked (its record names this session) is followed without calling the server again.
   */
  const lockSession = useCallback(async (reason: LockReason): Promise<void> => {
    const ref = tabSessionPin()?.ref ?? latestSessionRef.current;
    if (!ref || !isAuthenticatedRef.current || lockRef.current || lockingRef.current) return;
    lockingRef.current = true;
    try {
      setAuthError(null);
      showWarning(null);
      const lockedElsewhere = readLock(localStorage, ref);
      // Typed notes are sent while the session still works
      if (reason === 'idle' && !lockedElsewhere) await runBeforeLock();
      holdSessionSignal(ref);
      if (!lockedElsewhere) writeLock(localStorage, ref, Date.now());
      setServerLoadsPaused(true);
      applyLock({ reason });
      if (!lockedElsewhere && reason === 'idle') void ApiClient.signOut();
    } finally {
      lockingRef.current = false;
    }
  }, [applyLock, showWarning, setServerLoadsPaused]);
  lockSessionRef.current = lockSession;

  /**
   * Unlocks with a fresh password sign-in as the same account. The password is only passed to the sign-in call: it is never kept or logged.
   * A code or an authenticator setup may follow ('mfa' / 'enrol'); the session then resumes through completeMfa or finishMfa.
   */
  const unlockWithPassword = useCallback(async (password: string): Promise<UnlockOutcome> => {
    setAuthError(null);
    try {
      const result = await ApiClient.localLogin(currentUserRef.current.email, password);
      if (result.kind === 'mfa') {
        setMfaChallenge(toChallenge(result));
        return result.stage === 'enrol' ? 'enrol' : 'mfa';
      }
      return (await resumeFromLock(result)) ? 'ok' : 'failed';
    } catch (err: unknown) {
      setAuthError(errorMessage(err) || 'Authentication failed. Please verify your credentials.');
      return err instanceof ApiError && err.status === 0 ? 'offline' : 'failed';
    }
  }, [resumeFromLock]);

  /** "Stay signed in": input now, no warning, and a heartbeat when the server session has been quiet too long. */
  const stayActive = useCallback(() => {
    const now = Date.now();
    lastInputRef.current = now;
    lastActivityWriteRef.current = recordActivity(localStorage, now, lastActivityWriteRef.current);
    showWarning(null);
    if (needsHeartbeat(now, now, getLastRequestAt())) void ApiClient.heartbeat();
  }, [showWarning]);

  // The server stopped accepting this session (deleted / disabled account, rotated secret, expiry): sign out and say why
  useEffect(() => onSessionRejected((ref, reason) => {
    if (!ref || ref !== latestSessionRef.current) return;
    // Inactivity and a role that now needs two-step verification lock the screen: nothing is torn down, so open work stays (#163, #39)
    if (isReauthReason(reason) || readLock(localStorage, ref)) {
      void lockSession(isReauthReason(reason) ? reason : 'idle');
      return;
    }
    // Before anything is torn down: keep the unsaved text of the open editors in memory so it can be copied after sign-in
    rescueUnsavedText(currentUserRef.current.id);
    if (isCrossTabReason(reason)) {
      endSessionInThisTab(reason);
      return;
    }
    void logout();
    setAuthError(sessionEndedMessage(reason));
  }), [logout, endSessionInThisTab, lockSession]);

  // Another tab of this browser signed out or signed in as someone else, or rotated this user's reference (#32).
  // storage events fire in the other tabs only; a tab that was asleep checks when it is shown; every request checks too.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const check = () => {
      const s = tabSessionState();
      if (s === 'adopt') {
        const previous = tabSessionPin()?.ref;
        const { ref } = readStoredSession(localStorage);
        pinTabSession(ref, tabSessionPin()?.userId ?? null);
        setSessionRef(ref);
        setCurrentUser(prev => ({ ...prev, idToken: ref ?? undefined }));
        // Another tab unlocked the session with a fresh sign-in: this tab (locked too) follows it
        if (lockRef.current) {
          releaseSessionSignal(previous);
          applyLock(null);
          heldSession.current = null;
          setMfaChallenge(null);
          setRecoveryCodesRemaining(null);
          setAuthError(null);
          lastInputRef.current = Date.now();
        }
        return;
      }
      if (isCrossTabReason(s)) reportCrossTabEnd(tabSessionPin()?.ref, s);
    };
    const onStorage = (e: StorageEvent) => {
      // Another tab locked the screen: follow it without calling the server (it already ended the session)
      if ((e.key === null || e.key === LOCK_KEY) && readLock(localStorage, tabSessionPin()?.ref)) void lockSessionRef.current('idle');
      // Another tab had input: this tab is not idle either
      if (e.key === ACTIVITY_KEY && !lockRef.current) showWarning(null);
      if (e.key === null || e.key === AUTH_SESSION_REF_KEY || e.key === AUTH_USER_KEY) check();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [applyLock, showWarning]);

  // The first tenant sync of a reload answered: the stored session is confirmed, dead, or could not be checked
  useEffect(() => {
    const outcome = tenantSync.outcome;
    if (!outcome || (sessionCheck !== 'verifying' && sessionCheck !== 'offline')) return;
    if (outcome === 'password_change_required') setMustChangePassword(true);
    // A reload while locked sends nothing for the session (the API client refuses while the lock record stands): the lock
    // screen answers, not a sign-out, and the cached app stays hidden behind it
    const lockedOnReload = lockRef.current !== null;
    if (outcome === 'rejected' && isAuthenticated && !lockedOnReload) {
      // Normally the session signal has signed out already; this keeps the path complete if it did not
      rescueUnsavedText(currentUserRef.current.id);
      void logout();
      setAuthError(sessionEndedMessage());
      return;
    }
    setSessionCheck((c) => nextSessionCheck(c, { type: 'sync', outcome: outcome === 'rejected' && lockedOnReload ? 'offline' : outcome }));
  }, [tenantSync.outcome, sessionCheck, isAuthenticated, logout]);

  // The server did not answer in time: show the cached app with the offline notice (a late 401 still signs out)
  useEffect(() => {
    if (sessionCheck !== 'verifying') return;
    const timer = setTimeout(() => setSessionCheck((c) => nextSessionCheck(c, { type: 'timeout' })), SESSION_VERIFY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [sessionCheck]);

  // The idle limit is the server's (SESSION_IDLE_MINUTES), read once per sign-in; unreachable means the 15-minute default stands
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    let cancelled = false;
    ApiClient.getAuthConfig().then(
      (config) => { if (!cancelled) setIdleSeconds(config.sessionIdleSeconds); },
      () => { if (!cancelled) setIdleSeconds(DEFAULT_IDLE_SECONDS); },
    );
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // Idle lock (#163): input anywhere in the page keeps the session alive; a quiet period locks the screen after the server's idle limit.
  // The input times are kept in memory (and one shared timestamp for the other tabs): never what was typed.
  useEffect(() => {
    if (typeof window === 'undefined' || !isAuthenticated || lock !== null || idleSeconds <= 0) return undefined;
    const idleMs = idleSeconds * 1000;
    lastInputRef.current = Date.now();
    const onActivity = () => {
      const now = Date.now();
      lastInputRef.current = now;
      lastActivityWriteRef.current = recordActivity(localStorage, now, lastActivityWriteRef.current);
      // Input during the warning is a "stay signed in": send the heartbeat now rather than wait for the next tick
      if (idleWarningRef.current !== null) stayActive();
    };
    const tick = () => {
      const now = Date.now();
      const shared = readActivity(localStorage);
      if (shouldLock(now, lastInputRef.current, shared, idleMs)) {
        void lockSessionRef.current('idle');
        return;
      }
      showWarning(shouldWarn(now, lastInputRef.current, shared, idleMs) ? secondsUntilLock(now, lastInputRef.current, shared, idleMs) : null);
      if (needsHeartbeat(now, lastInputRef.current, getLastRequestAt())) void ApiClient.heartbeat();
    };
    // A tab that was asleep: the idle time may have run out meanwhile, so a wake-up is checked first and only counts as input if still unlocked
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (shouldLock(Date.now(), lastInputRef.current, readActivity(localStorage), idleMs)) {
        void lockSessionRef.current('idle');
        return;
      }
      onActivity();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((name) => window.addEventListener(name, onActivity, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(tick, IDLE_TICK_MS);
    return () => {
      events.forEach((name) => window.removeEventListener(name, onActivity, { capture: true }));
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [isAuthenticated, lock, idleSeconds, showWarning, stayActive]);

  // The warning counts down every second and locks at zero; any input clears it at once (see onActivity)
  const warningActive = idleWarning !== null;
  useEffect(() => {
    if (!warningActive || idleSeconds <= 0) return undefined;
    const idleMs = idleSeconds * 1000;
    const timer = setInterval(() => {
      const now = Date.now();
      const left = secondsUntilLock(now, lastInputRef.current, readActivity(localStorage), idleMs);
      if (left <= 0) void lockSessionRef.current('idle');
      else showWarning(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [warningActive, idleSeconds, showWarning]);

  const openAuthModal = useCallback((_mode: 'signin' = 'signin', redirectUrl?: string) => {
    if (redirectUrl) {
      setRedirectPath(redirectUrl);
    }
    setIsAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setIsAuthModalOpen(false);
    setAuthError(null);
    // Closing the dialog abandons a half-finished sign-in
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const value = useMemo(() => ({
    currentUser,
    sessionRef,
    isAuthenticated,
    loading,
    sessionCheck,
    authError,
    isAuthModalOpen,
    redirectPath,
    mustChangePassword,
    mfaEnrolled,
    mfaChallenge,
    recoveryCodesRemaining,
    loginWithEmailPassword,
    completeMfa,
    startEnrolment,
    confirmEnrolment,
    finishMfa,
    cancelMfa,
    lock,
    idleWarning,
    lockSession,
    unlockWithPassword,
    stayActive,
    changePassword,
    registerWithInvite,
    completeSetup,
    sendPasswordReset,
    logout,
    openAuthModal,
    closeAuthModal,
    clearAuthError,
  }), [
    currentUser,
    sessionRef,
    isAuthenticated,
    loading,
    sessionCheck,
    authError,
    isAuthModalOpen,
    redirectPath,
    mustChangePassword,
    mfaEnrolled,
    mfaChallenge,
    recoveryCodesRemaining,
    loginWithEmailPassword,
    completeMfa,
    startEnrolment,
    confirmEnrolment,
    finishMfa,
    cancelMfa,
    lock,
    idleWarning,
    lockSession,
    unlockWithPassword,
    stayActive,
    changePassword,
    registerWithInvite,
    completeSetup,
    sendPasswordReset,
    logout,
    openAuthModal,
    closeAuthModal,
    clearAuthError,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
