import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { User, AuthProviderType } from '../types/tenant';
import { useTenant, ANONYMOUS_USER } from './TenantContext';
import { ApiClient, SetupInput, SetupResult } from '../services/apiClient';
import { errorMessage } from '../utils/errors';

interface AuthContextType {
  currentUser: User;
  idToken: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  authError: string | null;
  isAuthModalOpen: boolean;
  redirectPath: string | null;
  /** Resolves true when signed in, false when it failed (the reason is in authError). */
  loginWithEmailPassword: (email: string, pass: string) => Promise<boolean>;
  /** Creates the account for an invitation's email, accepts it and signs in. Throws ApiError. */
  registerWithInvite: (inviteToken: string, name: string, password: string) => Promise<void>;
  /** First-time setup: creates the administrator, the primary tenant and the team invitations, and signs the administrator in. */
  completeSetup: (input: SetupInput) => Promise<SetupResult>;
  sendPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  openAuthModal: (mode?: 'signin', redirectUrl?: string) => void;
  closeAuthModal: () => void;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_USER_KEY = 'pbc_session_auth_user_v2';
const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';

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
    } else {
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  }, [isAuthenticated, currentUser, idToken]);

  /**
   * Helper to build and sync an app user profile from email/credentials
   */
  const handleUserSession = useCallback(async (
    email: string,
    displayName: string | null,
    provider: AuthProviderType,
    token: string
  ) => {
    const { tenant, role } = resolveTenantForEmail(email);

    const userProfile: User = {
      id: `user-${email.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20)}`,
      name: displayName || email.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      email: email,
      organization: tenant.name,
      authProvider: provider,
      emailVerified: true,
      roles: {
        [tenant.id]: role,
      },
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

  /**
   * Email & Password Sign-In against the local identity store
   */
  const loginWithEmailPassword = useCallback(async (email: string, pass: string): Promise<boolean> => {
    setLoading(true);
    setAuthError(null);
    try {
      const session = await ApiClient.localLogin(email, pass);
      await handleUserSession(session.user.email, session.user.name, 'password', session.token);
      setIsAuthModalOpen(false);
      return true;
    } catch (err: unknown) {
      console.error('Email login failed:', err);
      setAuthError(errorMessage(err) || 'Authentication failed. Please verify your credentials.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  /**
   * Onboarding by invitation: the server creates the account for the invited email, consumes the invitation
   * and returns a session. Errors (ApiError, with `reason` e.g. 'account_exists') propagate to the caller.
   */
  const registerWithInvite = useCallback(async (inviteToken: string, name: string, password: string): Promise<void> => {
    setLoading(true);
    setAuthError(null);
    try {
      const session = await ApiClient.registerWithInvite({ token: inviteToken, password, name: name || undefined });
      await handleUserSession(session.user.email, session.user.name, 'password', session.token);
      setIsAuthModalOpen(false);
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  const completeSetup = useCallback(async (input: SetupInput): Promise<SetupResult> => {
    setAuthError(null);
    const session = await ApiClient.runSetup(input);
    await handleUserSession(session.user.email, session.user.name, 'password', session.token);
    return session;
  }, [handleUserSession]);

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
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
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
    loginWithEmailPassword,
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
    loginWithEmailPassword,
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
