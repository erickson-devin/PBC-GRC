import React, { useState, useEffect, useId } from 'react';
import {
  X,
  Mail,
  Building2,
  Calendar,
  Sparkles,
  CheckCircle2,
  Clock,
  CalendarPlus,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from '../common/ErrorNotice';
import { Tenant, TenantInvitation, TenantRole } from '../../types/tenant';
import { ROLE_LABELS } from '../../utils/roles';
import { radioGroupKeyDown } from '../../utils/a11y';
import { MEMBER_ROLE_ORDER, ROLE_OPTION_HINTS, teamActionErrorMessage } from '../../data/roleView';
import { ROLE_STYLES } from '../common/RoleBadge';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface EditInvitationModalProps {
  isOpen: boolean;
  onClose: () => void;
  invitation: TenantInvitation | null;
  tenants: Tenant[];
  onSaved?: (updated: TenantInvitation) => void;
}

export const EditInvitationModal: React.FC<EditInvitationModalProps> = ({
  isOpen,
  onClose,
  invitation,
  tenants,
  onSaved,
}) => {
  const { updateInvitation, extendInvitationExpiration } = useTenant();
  const uid = useId();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [role, setRole] = useState<TenantRole>('ASSESSOR');
  const [expiresDate, setExpiresDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);

  useEffect(() => {
    if (invitation) {
      setEmail(invitation.email || '');
      setTenantId(invitation.tenantId || (tenants[0]?.id || ''));
      setRole(invitation.role || 'ASSESSOR');
      try {
        const d = new Date(invitation.expiresAt);
        if (!isNaN(d.getTime())) {
          setExpiresDate(d.toISOString().split('T')[0]);
        } else {
          setExpiresDate(new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]);
        }
      } catch {
        setExpiresDate(new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]);
      }
      setShowSuccessToast(false);
    }
  }, [invitation, tenants, isOpen]);

  if (!isOpen || !invitation) return null;

  const handleQuickExtend = (days: number) => {
    try {
      const current = new Date(expiresDate);
      const base = !isNaN(current.getTime()) && current.getTime() > Date.now()
        ? current.getTime()
        : Date.now();
      const nextDate = new Date(base + days * 86400000).toISOString().split('T')[0];
      setExpiresDate(nextDate);
    } catch {
      const nextDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
      setExpiresDate(nextDate);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !tenantId) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const newExpiresAt = new Date(`${expiresDate}T23:59:59.999Z`).toISOString();
      const targetTenant = tenants.find(t => t.id === tenantId);

      const updates: Partial<TenantInvitation> = {
        email: email.trim().toLowerCase(),
        tenantId,
        tenantName: targetTenant?.name || invitation.tenantName,
        systemName: targetTenant?.systemName || invitation.systemName,
        cageCode: targetTenant?.cageCode || invitation.cageCode,
        role,
        expiresAt: newExpiresAt,
      };

      // Server-issued invitations: role and email are edited via PATCH. A later expiry is applied with "extend"
      // (the link stays the same); shortening an expiry is not supported.
      await updateInvitation(invitation.id, updates);
      if (invitation.serverBacked) {
        const extraDays = Math.ceil((new Date(newExpiresAt).getTime() - new Date(invitation.expiresAt).getTime()) / 86400000);
        if (extraDays > 0 && extraDays <= 30) await extendInvitationExpiration(invitation.id, extraDays);
      }
      setShowSuccessToast(true);

      if (onSaved) {
        onSaved({
          ...invitation,
          ...updates,
        } as TenantInvitation);
      }

      setTimeout(() => {
        setIsSubmitting(false);
        onClose();
      }, 700);
    } catch (err: unknown) {
      setSubmitError(teamActionErrorMessage(err, null, 'invite', 'Could not update the invitation.'));
      setIsSubmitting(false);
    }
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-xl my-auto p-1.5 rounded-[2rem] bg-gradient-to-b from-slate-800/60 via-slate-900/40 to-slate-950 ring-1 ring-slate-700/60 shadow-2xl shadow-cyan-950/20 animate-scaleUp">
        <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-left space-y-6">
          
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <DialogTitle as="h2" className="text-lg sm:text-xl font-black text-white tracking-tight">
                  Edit Staff / Tenant Invitation
                </DialogTitle>
                <p className="text-xs text-slate-400">
                  Modify recipient, assigned boundary, role permissions, or token expiration
                </p>
              </div>
            </div>

            <button aria-label="Close"
              onClick={onClose}
              disabled={isSubmitting}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            
            {/* Recipient Email */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Recipient Email Address *
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="e.g. auditor@c3pao.org"
                  className="w-full pl-9 pr-3 py-2.5 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all font-medium"
                />
              </div>
            </div>

            {/* Target Enclave Boundary */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center justify-between">
                <span>Assigned Defense Enclave *</span>
                <span className="text-xs text-slate-400 font-mono">Isolated database boundary</span>
              </label>
              <div className="relative">
                <Building2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <select
                  value={tenantId}
                  onChange={e => setTenantId(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 text-xs font-semibold bg-slate-900/90 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                >
                  {tenants.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.cageCode || 'PENDING'}) • {t.systemName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Target Role Selector */}
            <div className="space-y-2">
              <span id={`${uid}-role`} className="block text-xs font-bold uppercase tracking-wider text-slate-300">
                Enclave Access Role & Permissions *
              </span>

              <div role="radiogroup" aria-labelledby={`${uid}-role`} onKeyDown={radioGroupKeyDown} className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {MEMBER_ROLE_ORDER.filter(r => r !== 'MSP_ADMIN' || invitation.role === 'MSP_ADMIN').map(r => {
                  const selected = role === r;
                  const { Icon, iconText, cardSelected } = ROLE_STYLES[r];
                  return (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setRole(r)}
                      className={`p-3 rounded-xl border text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                        selected
                          ? `${cardSelected} text-white`
                          : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200 mb-1">
                        <Icon className={`w-3.5 h-3.5 ${iconText}`} aria-hidden="true" />
                        <span>{ROLE_LABELS[r]}</span>
                      </div>
                      <p className="text-xs text-slate-400 line-clamp-2">
                        {ROLE_OPTION_HINTS[r]}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Expiration Date & Extension */}
            <div className="space-y-2 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>Token Expiration Date *</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleQuickExtend(7)}
                    className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-white text-xs font-mono border border-slate-700 flex items-center gap-1 transition-colors"
                  >
                    <CalendarPlus className="w-2.5 h-2.5" /> +7 Days
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickExtend(14)}
                    className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 hover:text-white text-xs font-mono border border-slate-700 flex items-center gap-1 transition-colors"
                  >
                    <CalendarPlus className="w-2.5 h-2.5" /> +14 Days
                  </button>
                </div>
              </div>

              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  required
                  value={expiresDate}
                  onChange={e => setExpiresDate(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                />
              </div>
            </div>

            <ErrorNotice message={submitError} />

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-850 border border-slate-800 rounded-xl transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary text-xs px-5 py-2.5 flex items-center gap-2 font-bold shadow-lg shadow-cyan-500/20"
              >
                {showSuccessToast ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 animate-bounce motion-reduce:animate-none" />
                    <span>Invitation Updated!</span>
                  </>
                ) : isSubmitting ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin motion-reduce:animate-none" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Save Invitation Changes</span>
                  </>
                )}
              </button>
            </div>

          </form>

        </div>
      </div>
    </DialogOverlay>
  );
};
