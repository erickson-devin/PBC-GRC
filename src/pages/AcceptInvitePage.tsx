import React, { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import {
  ShieldCheck,
  Shield,
  Building2,
  Lock,
  Mail,
  User as UserIcon,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { useTenant } from '../context/TenantContext';
import { useAuth } from '../context/AuthContext';
import { AuthProviderType, TenantInvitation } from '../types/tenant';
import { frameworkPolicySummary } from '../data/tenantFrameworkPolicy';
import { BrandLogo } from '../components/common/BrandLogo';
import { ErrorNotice } from '../components/common/ErrorNotice';
import { errorMessage } from '../utils/errors';
import { MfaChallengeForm } from '../components/auth/MfaChallengeForm';
import { MfaEnrolmentPanel } from '../components/auth/MfaEnrolmentPanel';

interface AcceptInvitePageProps {
  onSuccessNavigate?: () => void;
  onNavigateToLogin?: () => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const AcceptInvitePage: React.FC<AcceptInvitePageProps> = ({
  onSuccessNavigate,
  onNavigateToLogin,
  onOpenLegal,
}) => {
  const {
    previewInvitation,
    claimInviteToken,
  } = useTenant();

  const {
    loginWithEmailPassword,
    registerWithInvite,
    authError,
    clearAuthError,
    mfaChallenge,
    startEnrolment,
    confirmEnrolment,
    finishMfa,
    cancelMfa,
  } = useAuth();

  // Parse token from search query or hash
  const getTokenFromUrl = (): string => {
    if (typeof window === 'undefined') return '';
    // 1. Check search query: ?token=...
    const urlParams = new URLSearchParams(window.location.search);
    const searchToken = urlParams.get('token');
    if (searchToken) return searchToken.trim();

    // 2. Check hash: #accept-invite?token=...
    const hash = window.location.hash;
    if (hash.includes('?')) {
      const hashParams = new URLSearchParams(hash.split('?')[1]);
      const hashToken = hashParams.get('token');
      if (hashToken) return hashToken.trim();
    }

    return '';
  };

  const [token, setToken] = useState<string>(getTokenFromUrl);
  // Local accounts only: the invited person sets a password on this server (must equal MIN_PASSWORD_LENGTH in server/auth/localAuth.ts)
  const minPasswordLength = 12;

  // Password registration fields
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState(false);
  // What is left to do once a second step (a code, or enrolling an authenticator) finishes: nothing more after registering, or
  // accepting the invitation when an existing account was signed in
  const [afterSecondStep, setAfterSecondStep] = useState<'registered' | 'claim' | null>(null);

  // Sync token from URL popstate / hashchange
  useEffect(() => {
    const handleUrlChange = () => {
      setToken(getTokenFromUrl());
    };
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
    };
  }, []);

  // What the server knows about the token (organisation, role, status), fetched with the token alone (it works
  // before sign-in).
  type InviteView = Pick<TenantInvitation, 'token' | 'tenantName' | 'email' | 'role' | 'status' | 'expiresAt' | 'cageCode' | 'primaryFramework' | 'enabledFrameworks'>;
  const [liveInvitation, setLiveInvitation] = useState<InviteView | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLiveInvitation(undefined);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    previewInvitation(token)
      .then((preview) => {
        if (cancelled) return;
        setLiveInvitation(preview ? { token, tenantName: preview.tenantName, email: preview.email, role: preview.role, status: preview.status, expiresAt: preview.expiresAt, primaryFramework: preview.primaryFramework, enabledFrameworks: preview.enabledFrameworks } : undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLiveInvitation(undefined);
        setPreviewError(errorMessage(err) || 'Could not check the invitation.');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, previewInvitation]);

  const invitation = liveInvitation;

  // Auto-fill full name from email if invitation is present
  useEffect(() => {
    if (invitation?.email && !fullName) {
      const suggested = invitation.email
        .split('@')[0]
        .replace('.', ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      setFullName(suggested);
    }
  }, [invitation, fullName]);

  const triggerConfetti = () => {
    try {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'],
      });
    } catch {
      // Ignore if canvas is unavailable
    }
  };

  const handleClaimSuccess = () => {
    setClaimSuccess(true);
    triggerConfetti();
    setTimeout(() => {
      if (onSuccessNavigate) {
        onSuccessNavigate();
      } else if (typeof window !== 'undefined') {
        window.location.hash = 'app';
      }
    }, 1800);
  };

  // -------------------------------------------------------------------------
  // Handle password registration
  // -------------------------------------------------------------------------
  const handlePasswordClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invitation) return;

    if (!password || password.length < minPasswordLength) {
      setClaimError(`Password must be at least ${minPasswordLength} characters long.`);
      return;
    }

    if (password !== confirmPassword) {
      setClaimError('Passwords do not match. Please verify your entry.');
      return;
    }

    setIsSubmitting(true);
    setClaimError(null);
    clearAuthError();

    const name = fullName.trim() || invitation.email.split('@')[0];
    const credentials = { name, email: invitation.email, authProvider: 'password' as AuthProviderType };

    try {
      // The server creates the account for the invited address, accepts the invitation and signs us in.
      try {
        const stage = await registerWithInvite(invitation.token, name, password);
        if (stage === 'enrol') {
          // An authenticator has to be set up before the session starts
          setPassword('');
          setConfirmPassword('');
          setAfterSecondStep('registered');
          setIsSubmitting(false);
          return;
        }
      } catch (err: unknown) {
        if ((err as { reason?: string }).reason !== 'account_exists') throw err;
        // This address already has an account: sign in with ITS password, then accept the invitation.
        const outcome = await loginWithEmailPassword(invitation.email, password);
        if (outcome === 'failed') {
          setClaimError('An account for this email already exists. Enter that account\'s password to accept the invitation.');
          setIsSubmitting(false);
          return;
        }
        setPassword('');
        setConfirmPassword('');
        if (outcome === 'mfa' || outcome === 'enrol') {
          setAfterSecondStep('claim');
          setIsSubmitting(false);
          return;
        }
        const claim = await claimInviteToken(invitation.token, credentials);
        if (!claim.success) {
          setClaimError(claim.error || 'Failed to claim invitation.');
          setIsSubmitting(false);
          return;
        }
      }
      handleClaimSuccess();
    } catch (err: unknown) {
      console.error('Password claim error:', err);
      setClaimError(errorMessage(err) || 'Could not accept the invitation.');
      setIsSubmitting(false);
    }
  };

  // The second step is finished and the person is signed in
  const handleSecondStepDone = async () => {
    if (!invitation) return;
    if (afterSecondStep === 'claim') {
      const claim = await claimInviteToken(invitation.token, { name: fullName.trim() || invitation.email.split('@')[0], email: invitation.email, authProvider: 'password' as AuthProviderType });
      if (!claim.success) {
        setClaimError(claim.error || 'Failed to claim invitation.');
        setAfterSecondStep(null);
        return;
      }
    }
    setAfterSecondStep(null);
    handleClaimSuccess();
  };

  const abandonSecondStep = () => {
    cancelMfa();
    if (afterSecondStep === 'registered') {
      // The account exists and the invitation is used up; only the sign-in is left, which asks for the authenticator again
      setClaimError('Your account was created. Sign in to finish setting up two-step verification.');
    }
    setAfterSecondStep(null);
  };

  // -------------------------------------------------------------------------
  // Check Token Validity & Error States
  // -------------------------------------------------------------------------
  if (previewLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 flex items-center justify-center font-sans" role="status" aria-live="polite">
        <span className="text-sm">Checking your invitation…</span>
      </div>
    );
  }

  let tokenError: 'MISSING' | 'NOT_FOUND' | 'EXPIRED' | 'CLAIMED' | 'REVOKED' | null = null;

  if (!token) {
    tokenError = 'MISSING';
  } else if (!invitation) {
    tokenError = 'NOT_FOUND';
  } else if (invitation.status === 'ACCEPTED') {
    tokenError = 'CLAIMED';
  } else if (invitation.status === 'REVOKED') {
    tokenError = 'REVOKED';
  } else if (invitation.status === 'EXPIRED' || new Date(invitation.expiresAt).getTime() < Date.now()) {
    tokenError = 'EXPIRED';
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between font-sans selection:bg-brand-500 selection:text-white">
      
      {/* Top Header */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-slate-900 bg-slate-950/70 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <BrandLogo size="sm" />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold text-base text-white tracking-tight">Event Horizon: Singularity</span>
              <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                ENCLAVE ONBOARDING
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-medium">
              Pitch Black Cyber • DoD Defense Industrial Base Readiness
            </p>
          </div>
        </div>

      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 py-12">
        
        {/* SUCCESS CLAIMED STATE */}
        {claimSuccess ? (
          <div className="w-full max-w-lg p-1.5 rounded-[2.5rem] bg-gradient-to-b from-emerald-500/30 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl animate-scaleUp">
            <div className="p-6 sm:p-8 rounded-[calc(2.5rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-center space-y-5">
              <div className="w-16 h-16 mx-auto rounded-3xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-xl shadow-emerald-500/20">
                <CheckCircle2 className="w-9 h-9" />
              </div>
              <div>
                <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  ENCLAVE INITIALIZED
                </span>
                <h1 className="text-2xl font-black text-white tracking-tight mt-2">
                  Welcome to {invitation?.tenantName}!
                </h1>
                <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                  Your identity has been verified and bound with role <strong className="text-emerald-300 font-bold">{invitation?.role}</strong>. Launching your compliance matrix and SSP workbench...
                </p>
              </div>
              <div className="w-8 h-8 border-3 border-brand-500/30 border-t-brand-500 rounded-full animate-spin motion-reduce:animate-none mx-auto" />
            </div>
          </div>
        ) : tokenError ? (
          /* ERROR STATES */
          <div className="w-full max-w-md p-1.5 rounded-[2.5rem] bg-gradient-to-b from-rose-500/30 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl animate-scaleUp">
            <div className="p-6 sm:p-8 rounded-[calc(2.5rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-center space-y-5">
              
              <div className="w-14 h-14 mx-auto rounded-3xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shadow-xl shadow-rose-500/10">
                <AlertTriangle className="w-7 h-7" />
              </div>

              <div>
                <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">
                  INVALID ONBOARDING LINK
                </span>
                
                <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight mt-2.5">
                  {tokenError === 'MISSING' && 'Missing Invitation Token'}
                  {tokenError === 'NOT_FOUND' && 'Invalid Invitation Token'}
                  {tokenError === 'EXPIRED' && 'Invitation Token Expired'}
                  {tokenError === 'CLAIMED' && 'Invitation Already Claimed'}
                  {tokenError === 'REVOKED' && 'Invitation Revoked'}
                </h1>

                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                  {tokenError === 'MISSING' && 'No invitation token was provided in the link. Please verify the URL received from your enclave operator.'}
                  {tokenError === 'NOT_FOUND' && 'The provided invitation token does not match any active defense enclave records. It may have been typed incorrectly or purged.'}
                  {tokenError === 'EXPIRED' && 'Defense onboarding tokens expire after 14 days to preserve zero-trust security posture. Please request a refreshed link from your administrator.'}
                  {tokenError === 'CLAIMED' && 'This invitation link has already been accepted and bound to a user account. You may sign in directly with your registered credentials.'}
                  {tokenError === 'REVOKED' && 'This invitation was revoked by the security administrator or enclave owner.'}
                </p>
                <ErrorNotice message={previewError} className="mt-3 text-left" />
              </div>

              {/* Action Buttons */}
              <div className="pt-2 space-y-2">
                {tokenError === 'CLAIMED' ? (
                  <button
                    onClick={() => {
                      if (typeof window !== 'undefined') window.location.hash = 'login';
                    }}
                    className="w-full py-2.5 px-4 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-lg shadow-brand-500/25 transition-all"
                  >
                    Proceed to Enclave Login
                  </button>
                ) : (
                  <button
                    onClick={onNavigateToLogin}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white font-semibold text-xs border border-slate-700 transition-colors"
                  >
                    Go to sign in
                  </button>
                )}

              </div>

            </div>
          </div>
        ) : (
          /* VALID INVITATION ONBOARDING FORM */
          <div className="w-full max-w-xl p-1.5 rounded-[2.5rem] bg-gradient-to-b from-brand-500/30 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl animate-scaleUp">
            <div className="p-6 sm:p-8 rounded-[calc(2.5rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 space-y-6">
              
              {/* Header Title */}
              <div className="text-center space-y-1.5">
                <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30 inline-flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-amber-300" />
                  DEFENSE ENCLAVE INVITATION
                </span>
                <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                  Claim Your CMMC Enclave
                </h1>
                <p className="text-xs text-slate-400">
                  Complete setup to activate compliance tracking and SSP narrative controls
                </p>
              </div>

              {/* Enclave Summary Card (Double-Bezel) */}
              <div className="stitch-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm font-bold text-white">{invitation?.tenantName}</span>
                  </div>
                  {invitation?.cageCode && (
                    <span className="font-mono text-xs px-2.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 font-bold border border-cyan-500/30">
                      CAGE: {invitation.cageCode}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs border-t border-slate-800/80 pt-2.5">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Assigned Role</span>
                    <span className="font-bold text-cyan-300 flex items-center gap-1 mt-0.5 font-mono text-xs">
                      <Shield className="w-3.5 h-3.5" />
                      {invitation?.role === 'TENANT_OWNER' ? 'TENANT_OWNER' : invitation?.role === 'ASSESSOR' ? 'ASSESSOR' : 'VIEWER'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Licensed Frameworks</span>
                    <span className="font-semibold text-slate-200 mt-0.5 block">
                      {frameworkPolicySummary(invitation?.primaryFramework, invitation?.enabledFrameworks).text}
                    </span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 border-t border-slate-800/80 pt-2 flex items-center justify-between">
                  <span>Designated Recipient:</span>
                  <span className="font-mono font-semibold text-white">{invitation?.email}</span>
                </div>
              </div>

              {/* Error Alert */}
              <ErrorNotice message={claimError || authError} />

              {/* Second step: a code, or setting up an authenticator */}
              {mfaChallenge?.stage === 'verify' && (
                <MfaChallengeForm onDone={() => void handleSecondStepDone()} onCancel={abandonSecondStep} />
              )}
              {mfaChallenge?.stage === 'enrol' && (
                <MfaEnrolmentPanel
                  onStart={startEnrolment}
                  onConfirm={confirmEnrolment}
                  onDone={async () => {
                    await finishMfa();
                    await handleSecondStepDone();
                  }}
                  onCancel={abandonSecondStep}
                  cancelLabel="Cancel"
                />
              )}

              {/* Set Password Form */}
              {!mfaChallenge && (
              <form onSubmit={handlePasswordClaim} className="space-y-3.5 animate-fadeIn">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1">
                    Full Name / Authorized Operator <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={e => setFullName(e.target.value)}
                      placeholder="e.g. Alex Mercer"
                      className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1">
                    Email Address (Locked to Invitation)
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      readOnly
                      value={invitation?.email || ''}
                      className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900/50 border border-slate-800 text-slate-400 rounded-xl cursor-not-allowed font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1">
                      Password (Min {minPasswordLength} chars) <span className="text-rose-400">*</span>
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="password"
                        required
                        minLength={minPasswordLength}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1">
                      Confirm Password <span className="text-rose-400">*</span>
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || !password || password !== confirmPassword}
                  className="w-full btn-primary text-xs py-3.5"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin motion-reduce:animate-none" />
                      <span>Validating Credentials & Claiming Enclave...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Claim Enclave & Access Matrix</span>
                    </>
                  )}
                </button>
              </form>
              )}

              {/* Footer Terms Notice */}
              <div className="text-center pt-2 text-[11px] text-slate-400">
                By claiming this defense enclave, you agree to the{' '}
                <button
                  type="button"
                  onClick={() => onOpenLegal?.('terms')}
                  className="text-slate-400 hover:text-white underline"
                >
                  Terms of Service
                </button>{' '}
                and{' '}
                <button
                  type="button"
                  onClick={() => onOpenLegal?.('privacy')}
                  className="text-slate-400 hover:text-white underline"
                >
                  Privacy Policy
                </button>
                .
              </div>

            </div>
          </div>
        )}

      </main>

      {/* Footer Branding */}
      <footer className="px-6 py-4 border-t border-slate-900 text-center text-xs text-slate-400">
        Pitch Black Cyber LLC • CMMC Level 1 Readiness Engine • FAR 52.204-21 Compliant
      </footer>

    </div>
  );
};
