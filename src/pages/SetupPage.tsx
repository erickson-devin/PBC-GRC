import React, { useId, useMemo, useState } from 'react';
import { Building2, CheckCircle2, Copy, KeyRound, Mail, ShieldCheck, Users } from 'lucide-react';
import { BrandLogo } from '../components/common/BrandLogo';
import { useAuth } from '../context/AuthContext';
import type { SetupResult } from '../services/apiClient';
import { copyToClipboard } from '../utils/clipboard';
import { errorMessage } from '../utils/errors';
import { MfaEnrolmentPanel } from '../components/auth/MfaEnrolmentPanel';
import type { TenantRole } from '../types/tenant';

interface SetupPageProps {
  /** The setup token is only asked for when the server was started with SETUP_TOKEN. */
  tokenRequired?: boolean;
  /** Called when the administrator leaves the wizard for the application (after seeing the invitation links). */
  onFinished: () => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

const MIN_PASSWORD_LENGTH = 12;
const MAX_INVITES = 50;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const INVITE_ROLES: Array<{ value: Exclude<TenantRole, 'MSP_ADMIN'>; label: string }> = [
  { value: 'ASSESSOR', label: 'Assessor: can work on controls and evidence' },
  { value: 'VIEWER', label: 'Viewer: read-only' },
  { value: 'TENANT_OWNER', label: 'Owner: full control of the tenant' },
];

const inputClass =
  'w-full px-3 py-2.5 text-sm bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-400/60';

/** Teammate addresses may be separated by new lines, commas, semicolons or spaces. */
export function parseInviteList(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_PATTERN.test(e)) invalid.push(part.trim());
    else if (!emails.includes(e)) emails.push(e);
  }
  return { emails, invalid };
}

export const SetupPage: React.FC<SetupPageProps> = ({ tokenRequired = false, onFinished, onOpenLegal }) => {
  const { completeSetup, mfaChallenge, startEnrolment, confirmEnrolment, finishMfa } = useAuth();
  const ids = { company: useId(), name: useId(), email: useId(), pw: useId(), pw2: useId(), invites: useId(), role: useId(), token: useId(), err: useId() };

  const [companyName, setCompanyName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteText, setInviteText] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<TenantRole, 'MSP_ADMIN'>>('ASSESSOR');
  const [setupToken, setSetupToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const parsed = useMemo(() => parseInviteList(inviteText), [inviteText]);
  const adminEmail = email.trim().toLowerCase();
  const teammates = parsed.emails.filter((e) => e !== adminEmail);

  const validate = (): string | null => {
    if (!companyName.trim()) return 'Enter your company name.';
    if (!EMAIL_PATTERN.test(email.trim())) return 'Enter a valid email address for the administrator account.';
    if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password !== confirm) return 'The passwords do not match.';
    if (parsed.invalid.length) return `"${parsed.invalid[0]}" is not a valid email address in the team list.`;
    if (teammates.length > MAX_INVITES) return `Invite at most ${MAX_INVITES} teammates now; you can add more later.`;
    if (tokenRequired && !setupToken.trim()) return 'Enter the setup token shown in the server log.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      setResult(
        await completeSetup({
          companyName: companyName.trim(),
          adminName: adminName.trim() || undefined,
          email: email.trim(),
          password,
          invites: teammates,
          inviteRole,
          setupToken: tokenRequired ? setupToken.trim() : undefined,
        })
      );
      setPassword('');
      setConfirm('');
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Setup failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const linkFor = (token: string) => `${window.location.origin}/invite?token=${encodeURIComponent(token)}`;
  const copy = async (key: string, text: string) => {
    try {
      await copyToClipboard(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setError('Could not copy automatically. Select the text and copy it manually.');
    }
  };

  const label = 'block text-xs font-semibold text-slate-300 mb-1.5';
  const hint = 'text-xs text-slate-400 mt-1';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-brand-500 selection:text-white relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-brand-600/10 blur-3xl pointer-events-none rounded-full" />

      <header className="px-6 py-4 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md flex items-center justify-between z-10">
        <div className="text-left flex items-center gap-2.5">
          <BrandLogo size="sm" />
          <div>
            <span className="font-extrabold text-sm text-white tracking-tight">Event Horizon: Singularity</span>
            <span className="text-xs text-cyan-400 block font-mono">Pitch Black Cyber</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-6 z-10">
        <div className="w-full max-w-xl p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
            {!result ? (
              <form onSubmit={handleSubmit} noValidate aria-describedby={error ? ids.err : undefined} className="space-y-5">
                <div className="text-center space-y-2">
                  <div className="flex justify-center mb-2">
                    <BrandLogo size="lg" showText={false} />
                  </div>
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-xs font-bold uppercase tracking-widest text-cyan-300">
                    <ShieldCheck className="w-3 h-3 text-cyan-400" aria-hidden="true" />
                    First-time setup
                  </div>
                  <h1 className="text-2xl font-black text-white tracking-tight">Welcome to Event Horizon: Singularity</h1>
                  <p className="text-sm text-slate-400">Get started with your compliance journey.</p>
                </div>

                {error && (
                  <div id={ids.err} role="alert" className="p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs">
                    {error}
                  </div>
                )}

                <fieldset className="space-y-3">
                  <legend className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-cyan-300 mb-1">
                    <Building2 className="w-3.5 h-3.5" aria-hidden="true" /> Your organization
                  </legend>
                  <div>
                    <label htmlFor={ids.company} className={label}>Company name</label>
                    <input id={ids.company} className={inputClass} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Defense LLC" maxLength={200} autoComplete="organization" autoFocus />
                    <p className={hint}>Creates your first tenant, the workspace for your assessment program.</p>
                  </div>
                </fieldset>

                <fieldset className="space-y-3">
                  <legend className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-cyan-300 mb-1">
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Application owner
                  </legend>
                  <div>
                    <label htmlFor={ids.name} className={label}>Your name <span className="text-slate-500 font-normal">(optional)</span></label>
                    <input id={ids.name} className={inputClass} value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Ada Admin" maxLength={255} autoComplete="name" />
                  </div>
                  <div>
                    <label htmlFor={ids.email} className={label}>Email</label>
                    <input id={ids.email} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={ids.pw} className={label}>Password</label>
                      <input id={ids.pw} type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby={`${ids.pw}-hint`} />
                    </div>
                    <div>
                      <label htmlFor={ids.pw2} className={label}>Confirm password</label>
                      <input id={ids.pw2} type="password" className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                    </div>
                  </div>
                  <p id={`${ids.pw}-hint`} className={hint}>
                    At least {MIN_PASSWORD_LENGTH} characters; a passphrase works well. This account is the platform administrator and owns the tenant.
                  </p>
                </fieldset>

                <fieldset className="space-y-3">
                  <legend className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-cyan-300 mb-1">
                    <Users className="w-3.5 h-3.5" aria-hidden="true" /> Invite your team <span className="text-slate-500 font-normal normal-case tracking-normal">(optional)</span>
                  </legend>
                  <div>
                    <label htmlFor={ids.invites} className={label}>Email addresses</label>
                    <textarea id={ids.invites} rows={3} className={`${inputClass} resize-y`} value={inviteText} onChange={(e) => setInviteText(e.target.value)} placeholder={'one@company.com\ntwo@company.com'} spellCheck={false} aria-describedby={`${ids.invites}-hint`} />
                    <p id={`${ids.invites}-hint`} className={hint}>
                      One per line, or separated by commas.
                      {teammates.length > 0 && ` ${teammates.length} invitation${teammates.length === 1 ? '' : 's'} will be created.`}
                      {parsed.invalid.length > 0 && <span className="text-amber-300"> “{parsed.invalid[0]}” is not a valid address.</span>}
                    </p>
                  </div>
                  {teammates.length > 0 && (
                    <div>
                      <label htmlFor={ids.role} className={label}>Their role</label>
                      <select id={ids.role} className={inputClass} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Exclude<TenantRole, 'MSP_ADMIN'>)}>
                        {INVITE_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </fieldset>

                {tokenRequired && (
                  <div>
                    <label htmlFor={ids.token} className={label}>Setup token</label>
                    <input id={ids.token} className={`${inputClass} font-mono`} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" spellCheck={false} />
                    <p className={hint}>This server was started with a SETUP_TOKEN. Use the value from its environment.</p>
                  </div>
                )}

                <button type="submit" disabled={submitting} className="btn-base btn-primary w-full py-3 text-sm">
                  {submitting ? 'Setting up…' : 'Create my enclave'}
                </button>
                <p className="text-xs text-slate-500 text-center">Setup can only be run once. After this, this page no longer exists.</p>
              </form>
            ) : (
              mfaChallenge?.stage === 'enrol' ? (
              <div className="space-y-5">
                <div className="text-center space-y-2">
                  <div className="flex justify-center">
                    <ShieldCheck className="w-10 h-10 text-cyan-400" aria-hidden="true" />
                  </div>
                  <h1 className="text-2xl font-black text-white tracking-tight">Secure your administrator account</h1>
                  <p className="text-sm text-slate-400">
                    <strong className="text-slate-200">{result.tenant.name}</strong> is ready. Set up two-step verification for{' '}
                    <strong className="text-slate-200">{result.user.email}</strong> before you continue; your team&rsquo;s invitation links follow.
                  </p>
                </div>
                <MfaEnrolmentPanel onStart={startEnrolment} onConfirm={confirmEnrolment} onDone={finishMfa} />
              </div>
              ) : (
              <div className="space-y-5">
                <div className="text-center space-y-2">
                  <div className="flex justify-center">
                    <CheckCircle2 className="w-10 h-10 text-emerald-400" aria-hidden="true" />
                  </div>
                  <h1 className="text-2xl font-black text-white tracking-tight">You&rsquo;re all set</h1>
                  <p className="text-sm text-slate-400">
                    <strong className="text-slate-200">{result.tenant.name}</strong> is ready and you are signed in as{' '}
                    <strong className="text-slate-200">{result.user.email}</strong>. Setup is now closed.
                  </p>
                </div>

                {error && (
                  <div role="alert" className="p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs">{error}</div>
                )}

                {result.invites.length > 0 && (
                  <section aria-labelledby="setup-invites-heading" className="space-y-3">
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                      <Mail className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span id="setup-invites-heading">
                        This server does not send email. Copy each link and give it to its owner; <strong>the links are shown only now</strong> (you can issue new ones later under Team settings).
                      </span>
                    </div>
                    <ul className="space-y-2">
                      {result.invites.map((inv) => (
                        <li key={inv.email} className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-slate-200 truncate">{inv.email}</span>
                            {inv.token ? (
                              <button type="button" onClick={() => copy(inv.email, linkFor(inv.token!))} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
                                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                                {copied === inv.email ? 'Copied' : 'Copy link'}
                              </button>
                            ) : (
                              <span className="text-xs text-rose-300 shrink-0">Not created: {inv.error}</span>
                            )}
                          </div>
                          {inv.token && (
                            <input readOnly aria-label={`Invitation link for ${inv.email}`} value={linkFor(inv.token)} onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full px-2 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-300" />
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <button type="button" onClick={onFinished} className="btn-base btn-primary w-full py-3 text-sm">
                  Open my dashboard
                </button>
              </div>
              )
            )}
          </div>
        </div>
      </main>

      <footer className="px-6 py-4 text-center text-xs text-slate-400 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-3 max-w-5xl mx-auto w-full">
        <span>© {new Date().getFullYear()} Pitch Black Cyber LLC</span>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <button type="button" onClick={() => onOpenLegal?.('privacy')} className="hover:text-white transition-colors hover:underline">Privacy Policy</button>
          <span aria-hidden="true">•</span>
          <button type="button" onClick={() => onOpenLegal?.('terms')} className="hover:text-white transition-colors hover:underline">Terms of Service</button>
        </div>
      </footer>
    </div>
  );
};
