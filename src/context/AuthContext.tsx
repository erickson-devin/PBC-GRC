import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { User, AuthProviderType } from '../types/tenant';
import { useTenant, ANONYMOUS_USER } from './TenantContext';
import { ApiClient, LocalLoginResponse, MfaEnrolmentStart, MfaStage, SetupInput, SetupResult } from '../services/apiClient';
import { errorMessage } from '../utils/errors';
import { buildUserProfile } from '../utils/userProfile';

/** A sign-in that is not finished: the person still has to enter a code ('verify') or enrol an authenticator ('enrol'). Lives in React state only. */
export interface MfaChallenge {
  stage: MfaStage;
  mfaToken: string;
  expiresAt: string;
  methods: string[];
}

export type LoginOutcome = 'ok' | 'mfa' | 'enrol' | 'failed';

interface AuthContextType {
  currentUser: User;
  idToken: string | null;
  isAuthenticated: boolean;
  loading: boolean;
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
const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';
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
  const { resolveTenantForEmail, syncAuthUser, currentUser: tenantUser } = useTenant();

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

  const [idToken, setIdToken] = useState<string | null>(() => {
    return localStorage.getItem(AUTH_TOKEN_KEY) || null;
  });

  // Authenticated state check
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    const saved = localStorage.getItem(AUTH_USER_KEY);
    return Boolean(saved);
  });

  const [mustChangePassword, setMustChangePassword] = useState<boolean>(() => readStoredFlags().mustChangePassword);
  const [mfaEnrolled, setMfaEnrolled] = useState<boolean>(() => readStoredFlags().enrolled);
  // The pending second step lives in memory only: it is never written to browser storage.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [recoveryCodesRemaining, setRecoveryCodesRemaining] = useState<number | null>(null);
  // A session that is complete but not entered yet (the person is still reading their recovery codes). Memory only.
  const heldSession = useRef<LocalLoginResponse | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Modals & Navigation
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [redirectPath, setRedirectPath] = useState<string | null>(null);

  // Sync user and token to storage
  useEffect(() => {
    if (isAuthenticated && currentUser) {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
      if (idToken) {
        localStorage.setItem(AUTH_TOKEN_KEY, idToken);
      }
      const flags = JSON.stringify({ mustChangePassword, enrolled: mfaEnrolled });
      localStorage.setItem(AUTH_FLAGS_KEY, flags);
    } else {
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_FLAGS_KEY);
    }
  }, [isAuthenticated, currentUser, idToken, mustChangePassword, mfaEnrolled]);

  /**
   * Helper to build and sync an app user profile from email/credentials
   */
  const handleUserSession = useCallback(async (
    email: string,
    displayName: string | null,
    provider: AuthProviderType,
    token: string,
    userId?: string
  ) => {
    const { tenant, role } = resolveTenantForEmail(email);

    const userProfile: User = {
      ...buildUserProfile(
        { id: userId, email, name: displayName },
        { tenantId: tenant.id, role, organization: tenant.name, provider }
      ),
      idToken: token,
    };

    setCurrentUser(userProfile);
    setIdToken(token);
    setIsAuthenticated(true);
    setAuthError(null);
    syncAuthUser(userProfile, tenant.id);
  }, [resolveTenantForEmail, syncAuthUser]);

  // Local accounts only: there is no identity provider to wait for.
  useEffect(() => {
    setLoading(false);
  }, []);

  /** Enters the app with a complete session. */
  const applySession = useCallback(async (session: LocalLoginResponse) => {
    await handleUserSession(session.user.email, session.user.name, 'password', session.token, session.user.id);
    setMustChangePassword(session.mustChangePassword);
    setMfaEnrolled(session.mfaEnrolled);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    setIsAuthModalOpen(false);
  }, [handleUserSession]);

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
      await applySession(session);
      return 'ok';
    } catch (err: unknown) {
      setAuthError(errorMessage(err) || 'That code could not be checked.');
      // The sign-in step itself is dead: go back to the password step
      const reason = (err as { reason?: string }).reason;
      if (reason === 'mfa_token_invalid' || reason === 'mfa_unavailable') setMfaChallenge(null);
      return 'failed';
    } finally {
      setLoading(false);
    }
  }, [mfaChallenge, applySession]);

  const startEnrolment = useCallback(async (): Promise<MfaEnrolmentStart> => {
    return ApiClient.startMfaEnrolment(mfaChallenge && mfaChallenge.stage === 'enrol' ? mfaChallenge.mfaToken : undefined);
  }, [mfaChallenge]);

  const confirmEnrolment = useCallback(async (code: string): Promise<string[]> => {
    const confirmed = await ApiClient.confirmMfaEnrolment(code, mfaChallenge && mfaChallenge.stage === 'enrol' ? mfaChallenge.mfaToken : undefined);
    if (confirmed.session) {
      heldSession.current = confirmed.session; // entered by finishMfa(), after the recovery codes were saved
    } else {
      setMfaEnrolled(true);
    }
    return confirmed.recoveryCodes;
  }, [mfaChallenge]);

  const finishMfa = useCallback(async (): Promise<void> => {
    const held = heldSession.current;
    if (held) await applySession(held);
    setRecoveryCodesRemaining(null);
  }, [applySession]);

  const cancelMfa = useCallback(() => {
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    setAuthError(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string, code?: string): Promise<void> => {
    const session = await ApiClient.changePassword(currentPassword, newPassword, code, idToken ?? undefined);
    setIdToken(session.token);
    setCurrentUser(prev => ({ ...prev, idToken: session.token }));
    setMustChangePassword(false);
    setMfaEnrolled(session.mfaEnrolled);
  }, [idToken]);

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
   * Sign Out
   */
  const logout = useCallback(async () => {
    setIsAuthenticated(false);
    setIdToken(null);
    setMustChangePassword(false);
    setMfaEnrolled(false);
    heldSession.current = null;
    setMfaChallenge(null);
    setRecoveryCodesRemaining(null);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_FLAGS_KEY);
    setLoading(false);
    // Back to the login screen (the router resolves an empty hash)
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  }, []);

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
    idToken,
    isAuthenticated,
    loading,
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
    idToken,
    isAuthenticated,
    loading,
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
