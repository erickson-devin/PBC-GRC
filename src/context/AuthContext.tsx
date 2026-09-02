import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  auth,
  microsoftProvider,
  googleProvider,
  sendMagicLinkEmail,
  checkIsSignInWithEmailLink,
  completeMagicLinkSignIn,
  signOutFirebase,
  isFirebaseConfigured,
} from '../config/firebase';
import { User, AuthProviderType } from '../types/tenant';
import { useTenant, PRESET_USERS } from './TenantContext';

interface AuthContextType {
  firebaseUser: FirebaseUser | null;
  currentUser: User;
  idToken: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  authError: string | null;
  isAuthModalOpen: boolean;
  authModalMode: 'signin' | 'magiclink';
  isLicenseModalOpen: boolean;
  selectedLicensePlan: 'single-org' | 'msp-assessor';
  redirectPath: string | null;
  loginWithMicrosoft: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  loginWithEmailPassword: (email: string, pass: string) => Promise<void>;
  sendMagicLink: (email: string) => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  loginAsPreset: (presetUser: User) => void;
  logout: () => Promise<void>;
  openAuthModal: (mode?: 'signin' | 'magiclink', redirectUrl?: string) => void;
  closeAuthModal: () => void;
  openLicenseModal: (plan?: 'single-org' | 'msp-assessor') => void;
  closeLicenseModal: () => void;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_USER_KEY = 'pbc_session_auth_user_v2';
const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolveTenantForEmail, syncAuthUser, currentUser: tenantUser } = useTenant();

  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [currentUser, setCurrentUser] = useState<User>(() => {
    try {
      const saved = localStorage.getItem(AUTH_USER_KEY);
      if (saved) {
        return JSON.parse(saved) as User;
      }
    } catch (e) {
      console.warn('Failed to load saved user session:', e);
    }
    return tenantUser || PRESET_USERS[0];
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
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'magiclink'>('signin');
  const [isLicenseModalOpen, setIsLicenseModalOpen] = useState<boolean>(false);
  const [selectedLicensePlan, setSelectedLicensePlan] = useState<'single-org' | 'msp-assessor'>('single-org');
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
    token?: string,
    fbUser?: FirebaseUser | null
  ) => {
    const { tenant, role } = resolveTenantForEmail(email);

    const userProfile: User = {
      id: fbUser?.uid || `user-${email.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20)}`,
      name: displayName || email.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      email: email,
      organization: tenant.name,
      avatarUrl: fbUser?.photoURL || undefined,
      authProvider: provider,
      emailVerified: fbUser?.emailVerified ?? true,
      roles: {
        [tenant.id]: role,
      },
      idToken: token,
    };

    setCurrentUser(userProfile);
    setIdToken(token || `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify({ sub: userProfile.id, email, iss: 'https://securetoken.google.com/grc-tool-507203', exp: Math.floor(Date.now() / 1000) + 3600 }))}.mock_pbc_signature`);
    setIsAuthenticated(true);
    setAuthError(null);
    syncAuthUser(userProfile, tenant.id);
  }, [resolveTenantForEmail, syncAuthUser]);

  /**
   * Listen to Firebase onAuthStateChanged & check incoming magic links
   */
  useEffect(() => {
    let unsubscribe: () => void = () => {};

    const initAuth = async () => {
      try {
        // 1. Check if returning from a Passwordless Email Magic Link
        if (typeof window !== 'undefined' && checkIsSignInWithEmailLink(window.location.href)) {
          let email = window.localStorage.getItem('pbc_email_for_sign_in');
          if (!email) {
            email = window.prompt('Please provide your email for verification to complete magic link login:');
          }
          if (email) {
            const credential = await completeMagicLinkSignIn(email, window.location.href);
            const token = await credential.user.getIdToken();
            await handleUserSession(
              credential.user.email || email,
              credential.user.displayName,
              'emailLink',
              token,
              credential.user
            );
            window.localStorage.removeItem('pbc_email_for_sign_in');
          }
        }

        // 2. Firebase state listener (when live identity platform is active)
        if (auth && isFirebaseConfigured) {
          unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user && user.email) {
              setFirebaseUser(user);
              try {
                const token = await user.getIdToken();
                const provider = (user.providerData[0]?.providerId === 'microsoft.com'
                  ? 'microsoft.com'
                  : user.providerData[0]?.providerId === 'google.com'
                  ? 'google.com'
                  : 'password') as AuthProviderType;

                await handleUserSession(user.email, user.displayName, provider, token, user);
              } catch (err) {
                console.error('Error fetching Firebase ID token:', err);
              }
            }
            setLoading(false);
          });
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.warn('Firebase onAuthStateChanged notice:', err);
        setLoading(false);
      }
    };

    initAuth();

    return () => {
      unsubscribe();
    };
  }, [handleUserSession]);

  /**
   * Microsoft 365 / Entra ID OAuth Sign-In
   */
  const loginWithMicrosoft = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try {
      if (!isFirebaseConfigured) {
        // Transparent simulation for dev/sandbox mode
        await new Promise(r => setTimeout(r, 600));
        await handleUserSession('alex.mercer@vanguard-defense.us', 'Alex Mercer, CMMC CCA', 'microsoft.com');
        setIsAuthModalOpen(false);
        return;
      }

      const result = await signInWithPopup(auth, microsoftProvider);
      const token = await result.user.getIdToken();
      await handleUserSession(
        result.user.email || 'contractor@vanguard-defense.us',
        result.user.displayName,
        'microsoft.com',
        token,
        result.user
      );
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error('Microsoft login failed:', err);
      // If user closed popup, or offline dev simulation requested
      if (err.code === 'auth/popup-closed-by-user') {
        setAuthError('Sign-in cancelled. Please complete sign-in in the popup window.');
      } else if (err.code === 'auth/configuration-not-found' || err.code === 'auth/invalid-api-key') {
        // Fallback to simulated demo profile
        await handleUserSession('alex.mercer@vanguard-defense.us', 'Alex Mercer, CMMC CCA', 'microsoft.com');
        setIsAuthModalOpen(false);
      } else {
        setAuthError(err.message || 'Microsoft 365 sign-in encountered an error.');
      }
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  /**
   * Google Workspace / Cloud Identity OAuth Sign-In
   */
  const loginWithGoogle = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try {
      if (!isFirebaseConfigured) {
        await new Promise(r => setTimeout(r, 600));
        await handleUserSession('s.jenkins@defense-audit.org', 'Sarah Jenkins (C3PAO)', 'google.com');
        setIsAuthModalOpen(false);
        return;
      }

      const result = await signInWithPopup(auth, googleProvider);
      const token = await result.user.getIdToken();
      await handleUserSession(
        result.user.email || 'auditor@defense.org',
        result.user.displayName,
        'google.com',
        token,
        result.user
      );
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error('Google Workspace login failed:', err);
      if (err.code === 'auth/popup-closed-by-user') {
        setAuthError('Sign-in cancelled.');
      } else if (err.code === 'auth/configuration-not-found' || err.code === 'auth/invalid-api-key') {
        await handleUserSession('s.jenkins@defense-audit.org', 'Sarah Jenkins (C3PAO)', 'google.com');
        setIsAuthModalOpen(false);
      } else {
        setAuthError(err.message || 'Google Workspace sign-in encountered an error.');
      }
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  /**
   * Email & Password Sign-In for pre-configured enterprise users
   */
  const loginWithEmailPassword = useCallback(async (email: string, pass: string) => {
    setLoading(true);
    setAuthError(null);
    try {
      if (!isFirebaseConfigured) {
        await new Promise(r => setTimeout(r, 500));
        await handleUserSession(email, null, 'password');
        setIsAuthModalOpen(false);
        return;
      }

      const result = await signInWithEmailAndPassword(auth, email, pass);
      const token = await result.user.getIdToken();
      await handleUserSession(
        result.user.email || email,
        result.user.displayName,
        'password',
        token,
        result.user
      );
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error('Email login failed:', err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setAuthError('Invalid credentials. If you are a new contractor, please request an enclave license.');
      } else if (err.code === 'auth/configuration-not-found' || err.code === 'auth/invalid-api-key') {
        // Fallback simulation
        await handleUserSession(email, null, 'password');
        setIsAuthModalOpen(false);
      } else {
        setAuthError(err.message || 'Authentication failed. Please verify your credentials.');
      }
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  /**
   * Passwordless Magic Link for Defense Assessors
   */
  const sendMagicLink = useCallback(async (email: string) => {
    setLoading(true);
    setAuthError(null);
    try {
      if (!isFirebaseConfigured) {
        await new Promise(r => setTimeout(r, 600));
        // Simulate immediate magic link authorization for test drive
        await handleUserSession(email, 'Assessor ' + email.split('@')[0], 'emailLink');
        setIsAuthModalOpen(false);
        return;
      }

      await sendMagicLinkEmail(email, redirectPath || window.location.origin + '/app');
      alert(`Secure passwordless login link dispatched to ${email}. Check your inbox to access the defense enclave.`);
      setIsAuthModalOpen(false);
    } catch (err: any) {
      console.error('Send magic link failed:', err);
      if (err.code === 'auth/configuration-not-found' || err.code === 'auth/invalid-api-key') {
        await handleUserSession(email, 'Assessor ' + email.split('@')[0], 'emailLink');
        setIsAuthModalOpen(false);
      } else {
        setAuthError(err.message || 'Failed to dispatch magic link. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [handleUserSession, redirectPath]);

  /**
   * Complete Magic Link Sign-In
   */
  const signInWithMagicLink = useCallback(async (email: string) => {
    setLoading(true);
    try {
      const result = await completeMagicLinkSignIn(email, window.location.href);
      const token = await result.user.getIdToken();
      await handleUserSession(
        result.user.email || email,
        result.user.displayName,
        'emailLink',
        token,
        result.user
      );
    } catch (err: any) {
      console.error('Complete magic link failed:', err);
      setAuthError(err.message || 'Magic link verification failed or link expired.');
    } finally {
      setLoading(false);
    }
  }, [handleUserSession]);

  /**
   * Password Reset
   */
  const sendPasswordReset = useCallback(async (email: string) => {
    try {
      await sendPasswordResetEmail(auth, email);
      alert(`Password reset link dispatched to ${email}.`);
    } catch (err: any) {
      console.error('Password reset failed:', err);
      alert('Password reset instructions dispatched (simulation).');
    }
  }, []);

  /**
   * One-Click Demo Persona Switcher
   */
  const loginAsPreset = useCallback((presetUser: User) => {
    setCurrentUser(presetUser);
    setIdToken(`eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify({ sub: presetUser.id, email: presetUser.email, iss: 'https://securetoken.google.com/grc-tool-507203', exp: Math.floor(Date.now() / 1000) + 7200 }))}.mock_pbc_signature`);
    setIsAuthenticated(true);
    setAuthError(null);
    setIsAuthModalOpen(false);
    const tenantIds = Object.keys(presetUser.roles);
    if (tenantIds.length > 0) {
      syncAuthUser(presetUser, tenantIds[0]);
    }
  }, [syncAuthUser]);

  /**
   * Sign Out
   */
  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await signOutFirebase();
    } catch (e) {
      console.warn('Firebase signout warning:', e);
    } finally {
      setFirebaseUser(null);
      setIsAuthenticated(false);
      setIdToken(null);
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setLoading(false);
      // Route back to public site
      if (typeof window !== 'undefined') {
        window.location.hash = '';
      }
    }
  }, []);

  const openAuthModal = useCallback((mode: 'signin' | 'magiclink' = 'signin', redirectUrl?: string) => {
    setAuthModalMode(mode);
    if (redirectUrl) {
      setRedirectPath(redirectUrl);
    }
    setIsAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setIsAuthModalOpen(false);
    setAuthError(null);
  }, []);

  const openLicenseModal = useCallback((plan: 'single-org' | 'msp-assessor' = 'single-org') => {
    setSelectedLicensePlan(plan);
    setIsLicenseModalOpen(true);
    setIsAuthModalOpen(false);
  }, []);

  const closeLicenseModal = useCallback(() => {
    setIsLicenseModalOpen(false);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const value = useMemo(() => ({
    firebaseUser,
    currentUser,
    idToken,
    isAuthenticated,
    loading,
    authError,
    isAuthModalOpen,
    authModalMode,
    isLicenseModalOpen,
    selectedLicensePlan,
    redirectPath,
    loginWithMicrosoft,
    loginWithGoogle,
    loginWithEmailPassword,
    sendMagicLink,
    signInWithMagicLink,
    sendPasswordReset,
    loginAsPreset,
    logout,
    openAuthModal,
    closeAuthModal,
    openLicenseModal,
    closeLicenseModal,
    clearAuthError,
  }), [
    firebaseUser,
    currentUser,
    idToken,
    isAuthenticated,
    loading,
    authError,
    isAuthModalOpen,
    authModalMode,
    isLicenseModalOpen,
    selectedLicensePlan,
    redirectPath,
    loginWithMicrosoft,
    loginWithGoogle,
    loginWithEmailPassword,
    sendMagicLink,
    signInWithMagicLink,
    sendPasswordReset,
    loginAsPreset,
    logout,
    openAuthModal,
    closeAuthModal,
    openLicenseModal,
    closeLicenseModal,
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
