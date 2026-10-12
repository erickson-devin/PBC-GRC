import React, { useState } from 'react';
import {
  X,
  Mail,
  CheckCircle2,
  Lock,
  Copy,
  Check,
  Send,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from '../common/ErrorNotice';
import { errorMessage } from '../../utils/errors';
import { TenantInvitation } from '../../types/tenant';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { radioGroupKeyDown } from '../../utils/a11y';
interface InviteStaffModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInviteSent?: (invitation: TenantInvitation, inviteUrl: string) => void;
}

export const InviteStaffModal: React.FC<InviteStaffModalProps> = ({
  isOpen,
  onClose,
  onInviteSent,
}) => {
  const { currentTenant, inviteStaffMember } = useTenant();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ASSESSOR' | 'VIEWER'>('ASSESSOR');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const [createdResult, setCreatedResult] = useState<{
    invitation: TenantInvitation;
    inviteUrl: string;
  } | null>(null);

  if (!isOpen) return null;

  const handleReset = () => {
    setEmail('');
    setRole('ASSESSOR');
    setCreatedResult(null);
    setCopiedLink(false);
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await inviteStaffMember(currentTenant.id, email.trim().toLowerCase(), role);
      setCreatedResult(result);
      if (onInviteSent) {
        onInviteSent(result.invitation, result.inviteUrl);
      }
    } catch (err: unknown) {
      console.error('Failed to dispatch staff invitation:', err);
      // ApiError messages are user-safe: expired session, no permission, tenant not on the server yet, offline...
      setSubmitError(errorMessage(err) || 'Failed to generate the staff invitation. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!createdResult?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(createdResult.inviteUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  return (
    <DialogOverlay onClose={handleClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      {/* Double-Bezel Card */}
      <div className="w-full max-w-lg p-1.5 rounded-[2.25rem] bg-gradient-to-b from-brand-500/25 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl">
        <div className="p-6 sm:p-7 rounded-[calc(2.25rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-5">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs uppercase font-mono tracking-widest font-extrabold px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30">
                  TEAM INVITATION
                </span>
                <DialogTitle as="h3" className="text-base font-bold text-white tracking-tight mt-0.5">
                  {createdResult ? 'Staff Invitation Generated' : 'Invite Staff or Auditor'}
                </DialogTitle>
              </div>
            </div>
            <button aria-label="Close"
              onClick={handleClose}
              className="w-8 h-8 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Active Tenant Context Pill */}
          <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between text-xs">
            <span className="text-slate-400">Target Enclave:</span>
            <span className="font-bold text-white truncate max-w-xs">{currentTenant.name}</span>
          </div>

          {createdResult ? (
            /* Success View */
            <div className="space-y-4 animate-fadeIn">
              <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-left space-y-1.5">
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Invitation Created for {createdResult.invitation.email}!</span>
                </div>
                <p className="text-xs text-slate-300">
                  Role assigned: <strong className="text-white">{createdResult.invitation.role}</strong>. Share the link below with your staff member or external C3PAO auditor.
                </p>
              </div>

              {/* Shareable Link Box */}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                  Shareable Enclave Access Link
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={createdResult.inviteUrl}
                    className="w-full px-3 py-2 text-xs bg-slate-950 border border-brand-500/40 rounded-xl text-slate-200 font-mono select-all focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    onClick={handleCopy}
                    className={`px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-1.5 transition-all shrink-0 shadow-lg ${
                      copiedLink
                        ? 'bg-emerald-600 text-white shadow-emerald-500/25'
                        : 'bg-brand-600 hover:bg-brand-500 text-white shadow-brand-500/25'
                    }`}
                  >
                    {copiedLink ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-slate-400 flex items-center gap-1">
                  <Lock className="w-3 h-3 text-slate-400" />
                  Token valid for 14 days • Single-use cryptographic claim
                </p>
              </div>

              {/* Modal Actions */}
              <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => window.open(createdResult.inviteUrl, '_blank')}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-semibold border border-slate-700 flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Preview Route</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                  >
                    Invite Another
                  </button>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-5 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Invite Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              <ErrorNotice message={submitError} />
              {/* Staff / Auditor Email */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Staff / Auditor Work Email <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    placeholder="e.g. auditor@c3pao-partner.com or staff@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 font-mono transition-colors"
                  />
                </div>
              </div>

              {/* Role Selection Cards */}
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300">
                  Assigned CMMC Enclave Role <span className="text-rose-400">*</span>
                </label>

                <div role="radiogroup" aria-label="Assigned CMMC enclave role" onKeyDown={radioGroupKeyDown} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* ASSESSOR Option */}
                  <button type="button" role="radio" aria-checked={role === 'ASSESSOR'} tabIndex={role === 'ASSESSOR' ? 0 : -1}
                    onClick={() => setRole('ASSESSOR')}
                    className={`w-full text-left p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      role === 'ASSESSOR'
                        ? 'bg-blue-500/10 border-blue-500/40 ring-1 ring-blue-500/30'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-blue-400" />
                        Assessor
                      </span>
                      {role === 'ASSESSOR' && (
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                      )}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Can edit all 17 CMMC practices, draft implementation narratives, and upload/remove evidence.
                    </p>
                  </button>

                  {/* VIEWER Option */}
                  <button type="button" role="radio" aria-checked={role === 'VIEWER'} tabIndex={role === 'VIEWER' ? 0 : -1}
                    onClick={() => setRole('VIEWER')}
                    className={`w-full text-left p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      role === 'VIEWER'
                        ? 'bg-slate-700/20 border-slate-500/40 ring-1 ring-slate-500/30'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white flex items-center gap-1.5">
                        <Lock className="w-4 h-4 text-slate-400" />
                        Viewer (Auditor)
                      </span>
                      {role === 'VIEWER' && (
                        <span className="w-2 h-2 rounded-full bg-slate-400" />
                      )}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Read-only clearance for external C3PAO auditors or corporate executives. Cannot alter data.
                    </p>
                  </button>
                </div>
              </div>

              {/* Form Buttons */}
              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !email.trim()}
                  className="btn-primary px-6 py-2.5 text-xs rounded-xl flex items-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin motion-reduce:animate-none" />
                      <span>Generating Token...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Generate Invite Link</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

        </div>
      </div>
    </DialogOverlay>
  );
};
