import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  Auth,
  GoogleAuthProvider,
  OAuthProvider,
  ActionCodeSettings,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
} from 'firebase/auth';

/**
 * Google Cloud Identity Platform / Firebase Configuration
 * Reads from Vite environment variables with graceful fallback for dev & demo sandbox
 */
const rawApiKey = import.meta.env.VITE_FIREBASE_API_KEY || import.meta.env.VITE_GCP_API_KEY || 'AIzaSyASoVVDgl1wiUY2arQWd8wSnwkZtusv4_g';
const hasRealKey = Boolean(rawApiKey && !rawApiKey.includes('ExampleApiKey') && rawApiKey.length > 20);

const firebaseConfig = {
  apiKey: hasRealKey ? rawApiKey : 'AIzaSyASoVVDgl1wiUY2arQWd8wSnwkZtusv4_g',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'grc-tool-507203.firebaseapp.com',
  projectId: import.meta.env.VITE_GCP_PROJECT_ID || import.meta.env.VITE_FIREBASE_PROJECT_ID || 'grc-tool-507203',
  storageBucket: import.meta.env.VITE_GCS_BUCKET_NAME || 'grc-tool-507203.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '1024090841200',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:1024090841200:web:grc-tool-507203',
};

export const isFirebaseConfigured = hasRealKey;

// Singleton Firebase App
let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;

try {
  appInstance = !getApps().length
    ? initializeApp(firebaseConfig)
    : getApp();

  if (hasRealKey) {
    authInstance = getAuth(appInstance);
  }
} catch (err) {
  console.warn('Firebase initialization notice: Running in resilient defense sandbox mode.', err);
}

export const app = appInstance;
export const auth = authInstance as Auth;

// ----------------------------------------------------------------------
// 1. OAuth Provider: Microsoft 365 / Microsoft Entra ID
// ----------------------------------------------------------------------
export const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.addScope('openid');
microsoftProvider.addScope('profile');
microsoftProvider.addScope('email');
microsoftProvider.addScope('User.Read');
microsoftProvider.setCustomParameters({
  prompt: 'select_account',
  tenant: 'common', // Multi-tenant Entra ID (works for all defense contractor organizations)
});

// ----------------------------------------------------------------------
// 2. OAuth Provider: Google Workspace / Cloud Identity
// ----------------------------------------------------------------------
export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('openid');
googleProvider.addScope('profile');
googleProvider.addScope('email');
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

// ----------------------------------------------------------------------
// 3. Passwordless Magic Links (Email Sign-In for Defense Assessors)
// ----------------------------------------------------------------------
export const getActionCodeSettings = (redirectUrl?: string): ActionCodeSettings => {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://grc.pitchblackcyber.com';
  const target = redirectUrl ? encodeURIComponent(redirectUrl) : '';
  const url = `${origin}/login?magicLink=true${target ? `&redirectUrl=${target}` : ''}`;

  return {
    url,
    handleCodeInApp: true,
  };
};

export const sendMagicLinkEmail = async (email: string, redirectUrl?: string): Promise<void> => {
  if (auth && isFirebaseConfigured) {
    const settings = getActionCodeSettings(redirectUrl);
    await sendSignInLinkToEmail(auth, email, settings);
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('pbc_email_for_sign_in', email);
  }
};

export const checkIsSignInWithEmailLink = (url: string = window.location.href): boolean => {
  if (!auth || !isFirebaseConfigured) {
    return url.includes('magicLink=true');
  }
  try {
    return isSignInWithEmailLink(auth, url);
  } catch {
    return url.includes('magicLink=true');
  }
};

export const completeMagicLinkSignIn = async (email: string, url: string = window.location.href) => {
  if (!auth || !isFirebaseConfigured) {
    return {
      user: {
        uid: `magic-${email.replace(/[^a-zA-Z0-9]/g, '-')}`,
        email,
        displayName: 'Assessor ' + email.split('@')[0],
        emailVerified: true,
        photoURL: null,
        getIdToken: async () => `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify({ sub: email, email, iss: 'https://securetoken.google.com/grc-tool-507203', exp: Math.floor(Date.now() / 1000) + 3600 }))}.mock_magic_link_token`,
      } as any,
    };
  }
  return await signInWithEmailLink(auth, email, url);
};

export const signOutFirebase = async (): Promise<void> => {
  if (auth && isFirebaseConfigured) {
    await signOut(auth);
  }
};
