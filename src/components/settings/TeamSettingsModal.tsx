import React, { useState } from 'react';
import {
  X,
  Users,
  Shield,
  Lock,
  Plus,
  Copy,
  Check,
  RotateCw,
  Trash2,
  Search,
  Info,
  Save,
  Clock,
  UserCog,
  CalendarClock,
  Star,
} from 'lucide-react';
import { useTenant, buildInviteUrl } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { TenantRole, type TeamMember } from '../../types/tenant';
import { ComplianceFramework } from '../../types/framework';
import { InviteStaffModal } from './InviteStaffModal';
import { ErrorNotice } from '../common/ErrorNotice';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';
import { RoleBadge } from '../common/RoleBadge';
import { ROLE_LABELS } from '../../utils/roles';
import {
  ROLE_DESCRIPTIONS,
  ROLE_TEXT,
  matrixRoles,
  roleChangeConfirmText,
  roleChangeNeedsConfirm,
  teamActionErrorMessage,
  teamIntroNote,
  teamRowView,
  type TeamOp,
} from '../../data/roleView';
import {
  DORMANCY_TEXT,
  blockedMemberRows,
  memberAccountBadge,
  memberSignInText,
  restoreCodeReady,
  restoreErrorMessage,
  restoreRefreshesTeam,
  restoreSuccessText,
  showLastSignInColumn,
  teamDormancyPolicyText,
  type BlockedMemberRow,
} from '../../data/dormancyView';
import {
  MEMBERSHIP_TEXT,
  US_PERSON_FILTERS,
  AFFILIATION_LABELS,
  US_PERSON_LABELS,
  US_PERSON_CHIPS,
  showMembershipDetails,
  hasMembershipFacts,
  usPersonCounts,
  filterByUsPerson,
  usPersonFilterLabel,
  teamEmptyText,
  expiryView,
  memberIsExpired,
  expiredSummaryText,
  memberEditView,
  profileDraftFrom,
  profilePatchFrom,
  draftProblem,
  patchSummaryText,
  primaryContactHelp,
  usPersonRecordedText,
  ownerPromotionExpiryNote,
  expiryPreviewText,
  addDaysUtc,
  maxExpiryDate,
  memberProfileErrorMessage,
  memberProfileRefreshesTeam,
  profileSavedText,
  type UsPersonFilter,
  type MemberProfileDraft,
} from '../../data/membershipView';
import { utcToday } from '../../utils/memberProfile';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyText } from '../../utils/clipboard';
import { enclaveSaveErrorMessage } from '../../utils/enclaveEdit';

// Chip colours for an access end date (#258) and the shared chip shape
const EXPIRY_CHIP_CLASS = { none: '', active: 'bg-slate-800 text-slate-300 border-slate-700', soon: 'bg-amber-500/15 text-amber-300 border-amber-500/30', expired: 'bg-rose-500/15 text-rose-300 border-rose-500/30' } as const;
const CHIP = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold border';

interface TeamSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** When true, renders inline without modal overlay (for embedded tab views) */
  embedded?: boolean;
}

const ALL_FRAMEWORKS: { id: ComplianceFramework; label: string; shortName: string; authority: string; count: number }[] = [
  { id: 'CMMC_L1', label: 'CMMC 2.0 Level 1 (Foundational)', shortName: 'CMMC Level 1', authority: 'FAR 52.204-21', count: 17 },
  { id: 'CMMC_L2', label: 'CMMC 2.0 Level 2 (Advanced)', shortName: 'CMMC Level 2', authority: 'DFARS 252.204-7012', count: 110 },
  { id: 'NIST_800_53_REV5', label: 'NIST SP 800-53 Rev 5', shortName: 'NIST SP 800-53', authority: 'Federal Baselines (Low/Mod)', count: 220 },
  { id: 'SOC_2_TYPE_II', label: 'AICPA SOC 2 Type II', shortName: 'SOC 2 Type II', authority: 'Trust Services Criteria (CC1–CC9)', count: 61 },
  { id: 'HIPAA_SECURITY', label: 'HIPAA Security Rule', shortName: 'HIPAA Security', authority: '45 CFR Part 164 Subpart C', count: 42 },
];

export const TeamSettingsModal: React.FC<TeamSettingsModalProps> = ({
  isOpen,
  onClose,
  embedded = false,
}) => {
  const {
    currentTenant,
    currentUser,
    currentRole,
    isSuperAdmin,
    canManageTenant,
    getTenantMembers,
    updateMemberRole,
    removeMember,
    revokeInvitation,
    resendInvitation,
    invitations,
    updateTenantFrameworkScope,
    refreshTeam,
    teamError,
    restoreDormantMember,
    updateMemberProfile,
    teamDormantDays,
  } = useTenant();
  const { mfaEnrolled, sessionCheck } = useAuth();

  const [activeModalTab, setActiveModalTab] = useState<'team' | 'scope'>('team');
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  // A link the browser refused to copy, shown in a read-only field so it can be copied by hand
  const [copyFailedUrl, setCopyFailedUrl] = useState<string | null>(null);
  const copyFallbackRef = React.useRef<HTMLInputElement>(null);
  const [showRoleInfo, setShowRoleInfo] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Destructive actions are confirmed inline (no blocking confirm() dialogs)
  const [pendingAction, setPendingAction] = useState<{
    type: 'revoke' | 'remove' | 'role';
    id: string;
    label: string;
    from?: TenantRole;
    to?: TenantRole;
  } | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  // Restoring a member the inactivity check blocked (#257): the owner's own authenticator code is the step-up
  const [restoreTarget, setRestoreTarget] = useState<BlockedMemberRow | null>(null);
  const [restoreCode, setRestoreCode] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Member access details (#258, #259): the US-person filter, and the member being edited with its draft
  const [usFilter, setUsFilter] = useState<UsPersonFilter>('all');
  const [editTarget, setEditTarget] = useState<TeamMember | null>(null);
  const [editDraft, setEditDraft] = useState<MemberProfileDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const uid = React.useId();
  // Focus: the result region takes it when the control that was used is gone (a removal, a revoke)
  const resultRef = React.useRef<HTMLDivElement>(null);
  const pendingCancelRef = React.useRef<HTMLButtonElement>(null);
  const pendingTriggerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (pendingAction) pendingCancelRef.current?.focus();
  }, [pendingAction]);
  const refocus = () =>
    requestAnimationFrame(() => {
      const t = pendingTriggerRef.current;
      (t && t.isConnected ? t : resultRef.current)?.focus();
    });
  const cancelPending = () => {
    setPendingAction(null);
    refocus();
  };

  // A server-backed tenant's team lives on the server: load it whenever this screen is opened
  React.useEffect(() => {
    if (isOpen) {
      setNotice(null);
      setActionError(null);
      setScopeError(null);
      setPendingAction(null);
      setRestoreTarget(null);
      setUsFilter('all');
      setEditTarget(null);
      setEditDraft(null);
      setCopyFailedUrl(null);
      void refreshTeam(currentTenant.id);
    }
  }, [isOpen, currentTenant.id, refreshTeam]);

  // Invitations are issued by the server, so a browser-only tenant has to be moved there first
  const isBrowserOnlyTenant = !currentTenant.serverBacked;

  // Framework Scope Local State
  const [primaryFramework, setPrimaryFramework] = useState<ComplianceFramework>(
    currentTenant.primaryFramework || 'CMMC_L1'
  );
  const [enabledFrameworks, setEnabledFrameworks] = useState<ComplianceFramework[]>(
    currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0
      ? currentTenant.enabledFrameworks
      : [currentTenant.primaryFramework || 'CMMC_L1']
  );
  const [isSavingScope, setIsSavingScope] = useState(false);
  const [scopeSavedMessage, setScopeSavedMessage] = useState(false);

  React.useEffect(() => {
    if (isOpen) {
      setPrimaryFramework(currentTenant.primaryFramework || 'CMMC_L1');
      setEnabledFrameworks(
        currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0
          ? currentTenant.enabledFrameworks
          : [currentTenant.primaryFramework || 'CMMC_L1']
      );
      setScopeSavedMessage(false);
    }
  }, [isOpen, currentTenant.id, currentTenant.primaryFramework, currentTenant.enabledFrameworks]);

  // Put the cursor in the fallback field with the link selected, ready for Ctrl+C
  React.useEffect(() => {
    if (copyFailedUrl) {
      copyFallbackRef.current?.focus();
      copyFallbackRef.current?.select();
    }
  }, [copyFailedUrl]);

  const members = getTenantMembers(currentTenant.id);
  const showSignIn = showLastSignInColumn(canManageTenant, !isBrowserOnlyTenant);
  const blockedRows = showSignIn ? blockedMemberRows(members, currentRole, currentUser.email) : [];
  const dormantDays = teamDormantDays[currentTenant.id] ?? null;
  const nowMs = Date.now();
  const offline = sessionCheck === 'offline';
  const showMembership = showMembershipDetails(canManageTenant, !isBrowserOnlyTenant, members);
  const usCounts = usPersonCounts(members);
  const expiredCount = showMembership ? members.filter(m => hasMembershipFacts(m) && memberIsExpired(m, nowMs)).length : 0;
  const isSelfMember = (m: TeamMember) => m.email.toLowerCase() === currentUser.email.toLowerCase();
  const editView = editTarget ? memberEditView({ actor: currentRole, memberRole: editTarget.role, isSelf: isSelfMember(editTarget), isPending: false, serverBacked: !isBrowserOnlyTenant, hasFacts: hasMembershipFacts(editTarget) }) : null;
  const editPatch = editTarget && editDraft && editView ? profilePatchFrom(editTarget, editDraft, editView) : {};

  const openRestore = (row: BlockedMemberRow) => { setRestoreError(null); setRestoreCode(''); setRestoreTarget(row); };
  const closeRestore = () => { setRestoreTarget(null); setRestoreCode(''); setRestoreError(null); };
  const runRestore = async () => {
    if (!restoreTarget || restoreBusy) return;
    if (!restoreCodeReady(restoreCode)) { setRestoreError(DORMANCY_TEXT.codeFormat); return; }
    const target = restoreTarget;
    setRestoreBusy(true); setRestoreError(null);
    try {
      await restoreDormantMember(currentTenant.id, target.userId, restoreCode);
      closeRestore(); setActionError(null); setNotice(restoreSuccessText(target.email));
      requestAnimationFrame(() => resultRef.current?.focus()); // the Restore button is gone once the row leaves the section
    } catch (err: unknown) {
      setRestoreError(restoreErrorMessage(err));
      if (restoreRefreshesTeam(err)) void refreshTeam(currentTenant.id);
    } finally { setRestoreBusy(false); setRestoreCode(''); }
  };

  const openEdit = (m: TeamMember) => { setEditError(null); setEditDraft(profileDraftFrom(m)); setEditTarget(m); };
  const closeEdit = () => { setEditTarget(null); setEditDraft(null); setEditError(null); };
  const setDraft = (p: Partial<MemberProfileDraft>) => setEditDraft(d => (d ? { ...d, ...p } : d));
  const runEdit = async () => {
    if (!editTarget || !editDraft || !editView || editBusy) return;
    const problem = draftProblem(editTarget, editDraft, editView, Date.now());
    if (problem) { setEditError(problem); return; }
    const patch = profilePatchFrom(editTarget, editDraft, editView);
    if (Object.keys(patch).length === 0) { closeEdit(); return; }
    setEditBusy(true); setEditError(null);
    try {
      await updateMemberProfile(currentTenant.id, editTarget.id, patch);
      const email = editTarget.email; closeEdit(); setActionError(null); setNotice(profileSavedText(email));
    } catch (err: unknown) {
      setEditError(memberProfileErrorMessage(err));
      if (memberProfileRefreshesTeam(err)) void refreshTeam(currentTenant.id);
    } finally { setEditBusy(false); }
  };

  // Filter members by search, then by US-person status (#259)
  const filteredMembers = filterByUsPerson(members.filter(m =>
    m.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.role.toLowerCase().includes(searchQuery.toLowerCase()) ||
    ROLE_LABELS[m.role].toLowerCase().includes(searchQuery.toLowerCase())
  ), showMembership ? usFilter : 'all');

  const handleCopyInvite = async (token: string, memberId: string) => {
    const inviteUrl = buildInviteUrl(token);
    setCopyFailedUrl(null);
    if (await copyText(inviteUrl)) {
      setCopiedTokenId(memberId);
      setTimeout(() => setCopiedTokenId(null), 2000);
    } else {
      setCopyFailedUrl(inviteUrl);
    }
  };

  /** Runs a team action with a busy flag and a visible error (a failed call must never be silent). */
  const runAction = async (action: () => Promise<void>, success?: string, op: TeamOp = 'member'): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      return true;
    } catch (err: unknown) {
      // The server's role refusals are mapped to one plain sentence; other messages are user-safe as they are
      setActionError(teamActionErrorMessage(err, currentRole, op, 'That did not work. Please try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // The invitation behind a pending row. Server invitations are identified by id (the server keeps only a token hash);
  // legacy browser-only ones by their token.
  const inviteIdFor = (member: { invitationId?: string; invitationToken?: string }): string | undefined =>
    member.invitationId ?? invitations.find(i => i.token === member.invitationToken)?.id;

  // Resending issues a NEW link (the old one stops working) and restarts the expiry clock
  const handleResend = (invitationId: string) =>
    runAction(async () => {
      const res = await resendInvitation(invitationId);
      setCopyFailedUrl(null);
      if (await copyText(res.inviteUrl)) {
        setNotice('New invitation link created and copied to the clipboard. The previous link no longer works.');
      } else {
        setNotice('New invitation link created. The previous link no longer works.');
        setCopyFailedUrl(res.inviteUrl);
      }
    }, undefined, 'invite');

  const askRevoke = (invitationId: string, email: string) => {
    pendingTriggerRef.current = document.activeElement as HTMLElement | null;
    setPendingAction({ type: 'revoke', id: invitationId, label: email });
  };

  const askRemove = (memberId: string, memberEmail: string) => {
    if (memberEmail.toLowerCase() === currentUser.email.toLowerCase()) {
      setActionError('You cannot remove yourself from this defense enclave.');
      return;
    }
    pendingTriggerRef.current = document.activeElement as HTMLElement | null;
    setPendingAction({ type: 'remove', id: memberId, label: memberEmail });
  };

  const confirmPending = async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    if (action.type === 'role') {
      await runAction(
        () => updateMemberRole(currentTenant.id, action.id, action.to!),
        `${action.label} now has the ${ROLE_LABELS[action.to!]} role.`,
        'member'
      );
    } else if (action.type === 'revoke') {
      await runAction(() => revokeInvitation(action.id), 'Invitation revoked.', 'invite');
    } else {
      await runAction(() => removeMember(currentTenant.id, action.id), 'Member removed. They have lost access.', 'member');
    }
    refocus();
  };

  // Only a platform administrator can change the licensed frameworks (the server refuses everyone else)
  const canEditScope = isSuperAdmin;

  const handlePrimaryChange = (fw: ComplianceFramework) => {
    setPrimaryFramework(fw);
    if (!enabledFrameworks.includes(fw)) {
      setEnabledFrameworks([...enabledFrameworks, fw]);
    }
  };

  const handleToggleFramework = (fw: ComplianceFramework) => {
    if (fw === primaryFramework) return;
    if (enabledFrameworks.includes(fw)) {
      setEnabledFrameworks(enabledFrameworks.filter(f => f !== fw));
    } else {
      setEnabledFrameworks([...enabledFrameworks, fw]);
    }
  };

  const handleSaveScope = async () => {
    setIsSavingScope(true);
    setScopeError(null);
    try {
      await updateTenantFrameworkScope(currentTenant.id, enabledFrameworks, primaryFramework);
      setScopeSavedMessage(true);
      setTimeout(() => setScopeSavedMessage(false), 3000);
    } catch (err) {
      setScopeError(enclaveSaveErrorMessage(err));
    } finally {
      setIsSavingScope(false);
    }
  };

  const handleModalClose = () => {
    if (typeof window !== 'undefined' && (window.location.hash.includes('team') || window.location.hash.includes('settings'))) {
      window.history.replaceState(null, '', window.location.pathname + (window.location.search || ''));
    }
    onClose();
  };

  if (!embedded && !isOpen) return null;

  // ── Shared inner content (used by both modal and embedded mode) ──
  const innerContent = (
    <div className={embedded ? 'space-y-5' : 'p-5 sm:p-7 rounded-[calc(1rem-0.125rem)] bg-slate-950/95 border border-slate-800/90 flex flex-col max-h-[calc(92vh-0.5rem)] overflow-y-auto space-y-5'}>
            
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="badge text-xs uppercase font-mono tracking-widest font-extrabold px-2 py-0.5 rounded-full bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                      RBAC ENCLAVE SETTINGS
                    </span>
                    <span className="text-xs text-slate-400 font-mono">
                      {currentTenant.cageCode ? `CAGE: ${currentTenant.cageCode}` : 'PENDING'}
                    </span>
                  </div>
                  <DialogTitle as="h2" className="text-base sm:text-lg font-extrabold text-white tracking-tight mt-0.5">
                    Team & Role Permissions — {currentTenant.name}
                  </DialogTitle>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRoleInfo(prev => !prev)}
                  aria-expanded={showRoleInfo}
                  aria-controls={`${uid}-roles`}
                  aria-label="What each role can do"
                  className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all duration-200 hover:scale-105 active:scale-95"
                  title="What each role can do"
                >
                  <Info className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={handleModalClose}
                  className="modal-close-trigger"
                  aria-label="Close"
                  title="Close modal"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Navigation Tabs */}
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3 shrink-0">
              <button
                type="button"
                onClick={() => setActiveModalTab('team')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  activeModalTab === 'team'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>Team & Role Access ({members.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveModalTab('scope')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  activeModalTab === 'scope'
                    ? 'bg-brand-500/20 text-brand-300 border border-brand-500/40 shadow-sm'
                    : 'bg-slate-900/60 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <Shield className="w-3.5 h-3.5" />
                <span>Compliance Scope & Modules</span>
                <span className="badge text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                  {enabledFrameworks.length}
                </span>
              </button>
            </div>

            {/* Role Capabilities Matrix Accordion */}
            {showRoleInfo && (
              <div id={`${uid}-roles`} className="p-4 rounded-2xl bg-slate-900/90 border border-brand-500/30 space-y-3 text-xs animate-fadeIn">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h3 className="font-bold text-white flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-brand-400" aria-hidden="true" />
                    {ROLE_TEXT.matrixTitle}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowRoleInfo(false)}
                    className="text-xs text-slate-400 hover:text-white"
                  >
                    Hide
                  </button>
                </div>

                <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {matrixRoles(currentRole, members.map(m => m.role)).map(r => (
                    <li key={r} className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
                      <RoleBadge role={r} />
                      <p className="text-xs text-slate-300 leading-relaxed">{ROLE_DESCRIPTIONS[r].can}</p>
                      {ROLE_DESCRIPTIONS[r].cannot && (
                        <p className="text-xs text-slate-400 leading-relaxed">{ROLE_DESCRIPTIONS[r].cannot}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Tab 1: Team & RBAC Permissions */}
            {activeModalTab === 'team' && (
              <div className="space-y-4 animate-fadeIn">
                {/* Actions Bar: Search + Invite Button */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search team members by name or email..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                    />
                  </div>

                  {canManageTenant && (
                    <button
                      onClick={() => setIsInviteModalOpen(true)}
                      disabled={isBrowserOnlyTenant}
                      title={isBrowserOnlyTenant ? 'Move this tenant to the server first' : undefined}
                      className="btn-primary text-xs px-4 py-2 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Invite Staff / Auditor</span>
                    </button>
                  )}
                </div>

                {showMembership && (
                  <fieldset className="space-y-1.5">
                    <legend className="text-xs font-semibold text-slate-400 mb-1.5">{MEMBERSHIP_TEXT.usPersonFilterLegend}</legend>
                    <div className="flex flex-wrap items-center gap-2">
                      {US_PERSON_FILTERS.map(f => (
                        <label key={f} className={`inline-flex items-center px-3 py-1 rounded-xl border text-xs font-semibold cursor-pointer transition-colors focus-within:ring-1 focus-within:ring-cyan-400 ${usFilter === f ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white'}`}>
                          <input type="radio" name={`${uid}-us-filter`} value={f} checked={usFilter === f} onChange={() => setUsFilter(f)} className="sr-only" />
                          <span>{usPersonFilterLabel(f, usCounts)}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-slate-400">{MEMBERSHIP_TEXT.usPersonFilterHint}</p>
                  </fieldset>
                )}

                {isBrowserOnlyTenant && <LegacyTenantNotice tenant={currentTenant} variant="inline" />}
                {teamIntroNote(currentRole, canManageTenant) && (
                  <p role="note" className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">
                    {teamIntroNote(currentRole, canManageTenant)}
                  </p>
                )}
                {showMembership && expiredCount > 0 && (
                  <p role="note" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">{expiredSummaryText(expiredCount)}</p>
                )}
                <div ref={resultRef} tabIndex={-1} className="space-y-2 focus:outline-none">
                  <ErrorNotice message={actionError || teamError} />
                  {notice && (
                    <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">{notice}</div>
                  )}
                </div>
                {copyFailedUrl && (
                  <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                    <p role="alert">The link could not be copied. Select and copy it from the field.</p>
                    <div className="flex items-center gap-2">
                      <label htmlFor="team-invite-link-fallback" className="sr-only">Invitation link</label>
                      <input
                        id="team-invite-link-fallback"
                        ref={copyFallbackRef}
                        type="text"
                        readOnly
                        value={copyFailedUrl}
                        onFocus={e => e.currentTarget.select()}
                        className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-cyan-300 select-all focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
                      />
                      <button type="button" onClick={() => setCopyFailedUrl(null)} className="px-3 py-1.5 font-semibold text-slate-300 hover:text-white shrink-0">Dismiss</button>
                    </div>
                  </div>
                )}
                {pendingAction && (
                  <div
                    role="alertdialog"
                    aria-labelledby={`${uid}-pending`}
                    className={`flex flex-col gap-2 rounded-xl border p-3 text-xs sm:flex-row sm:items-center sm:justify-between ${
                      pendingAction.type === 'role'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                        : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                    }`}
                  >
                    <span id={`${uid}-pending`}>
                      {pendingAction.type === 'revoke'
                        ? `Revoke the pending invitation for ${pendingAction.label}?`
                        : pendingAction.type === 'role'
                        ? `${roleChangeConfirmText(pendingAction.label, pendingAction.from!, pendingAction.to!)}${ownerPromotionExpiryNote(pendingAction.to!, members.find(m => m.id === pendingAction.id)?.accessExpiresOn) ?? ''}`
                        : `Remove ${pendingAction.label} from ${currentTenant.name}? They will lose access immediately.`}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <button type="button" ref={pendingCancelRef} onClick={cancelPending} className="px-3 py-1.5 font-semibold text-slate-300 hover:text-white">Cancel</button>
                      <button type="button" onClick={() => void confirmPending()} className="btn-danger rounded-lg px-3 py-1.5">
                        {pendingAction.type === 'revoke'
                          ? 'Revoke'
                          : pendingAction.type === 'role'
                          ? pendingAction.to === 'TENANT_OWNER' ? 'Make Tenant Owner' : 'Change Role'
                          : 'Remove'}
                      </button>
                    </span>
                  </div>
                )}
                {blockedRows.length > 0 && (
                  <section aria-labelledby={`${uid}-blocked`} className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                    <div>
                      <h3 id={`${uid}-blocked`} className="text-xs font-bold text-amber-200 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" /><span>{DORMANCY_TEXT.sectionTitle} ({blockedRows.length})</span></h3>
                      <p className="text-xs text-slate-400 mt-1">{teamDormancyPolicyText(dormantDays)}{currentRole === 'TENANT_ADMIN' ? ` ${DORMANCY_TEXT.adminCannotRestore}` : ''}</p>
                    </div>
                    <ul className="divide-y divide-slate-800/80">
                      {blockedRows.map(b => (
                        <li key={b.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-slate-200 truncate">{b.email}</p>
                            <p className="text-xs text-slate-400">Last sign-in: {b.lastSignIn} · Blocked: {b.blockedOn}</p>
                          </div>
                          {b.canRestore
                            ? <button type="button" disabled={busy} onClick={() => openRestore(b)} aria-label={`Restore ${b.email}`} className="btn-secondary text-xs px-3 py-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">{DORMANCY_TEXT.restoreButton}</button>
                            : <span className="text-xs text-slate-400">{b.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Members Table */}
                <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
                      <tr>
                        <th className="py-3 px-4">Member Name & Email</th>
                        <th className="py-3 px-4">Enclave Role</th>
                        <th className="py-3 px-4">Status</th>
                        {showSignIn && <th className="py-3 px-4 hidden md:table-cell">Last sign-in</th>}
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80 font-sans">
                      {filteredMembers.map(member => {
                        const isSelf = member.email.toLowerCase() === currentUser.email.toLowerCase();
                        const isPending = member.status === 'PENDING_INVITE';
                        const accountBadge = memberAccountBadge(member);
                        const row = teamRowView({
                          actor: currentRole,
                          canManageTenant,
                          isSelf,
                          isPending,
                          memberRole: member.role,
                          hasInvitation: Boolean(inviteIdFor(member)),
                        });
                        const hasFacts = showMembership && hasMembershipFacts(member);
                        const exp = expiryView(member.accessExpiresOn, nowMs);
                        const expired = hasFacts && memberIsExpired(member, nowMs);
                        const edit = memberEditView({ actor: currentRole, memberRole: member.role, isSelf, isPending, serverBacked: !isBrowserOnlyTenant, hasFacts });

                        return (
                          <tr
                            key={member.id}
                            className="even:bg-slate-950/40 odd:bg-slate-900/20 hover:bg-slate-800/60 transition-colors duration-150"
                          >
                            {/* Member Identity */}
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm">
                                  {member.name ? member.name.charAt(0).toUpperCase() : member.email.charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-bold text-white truncate">{member.name || member.email.split('@')[0]}</span>
                                    {isSelf && (
                                      <span className="badge text-xs font-mono px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                                        You
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs font-mono text-slate-400 truncate">{member.email}</p>
                                  {showSignIn && <p className="md:hidden text-xs text-slate-400">Last sign-in: {memberSignInText(member)}</p>}
                                  {(member.primaryContact || hasFacts) && (
                                    <div className="mt-1 flex flex-wrap items-center gap-1">
                                      {member.primaryContact && <span className={`${CHIP} bg-brand-500/15 text-brand-200 border-brand-500/30`}><Star className="w-3 h-3" aria-hidden="true" />{MEMBERSHIP_TEXT.primaryBadge}</span>}
                                      {hasFacts && exp.chip && <span className={`${CHIP} ${EXPIRY_CHIP_CLASS[exp.state]}`}><CalendarClock className="w-3 h-3" aria-hidden="true" />{exp.chip}</span>}
                                      {hasFacts && member.affiliation && <span className={`${CHIP} bg-slate-800 text-slate-300 border-slate-700`}>{AFFILIATION_LABELS[member.affiliation]}</span>}
                                      {hasFacts && <span className={`${CHIP} bg-slate-800 text-slate-300 border-slate-700`}>{US_PERSON_CHIPS[member.usPerson ?? 'NOT_RECORDED']}</span>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>

                            {/* Role Badge & Role Changer */}
                            <td className="py-3 px-4">
                              {row.control === 'select' ? (
                                <div className="relative inline-block">
                                  {/* Not disabled while busy: a disabled select drops keyboard focus. The controlled value restores the old role if a change is refused or waits for confirmation. */}
                                  <select
                                    value={member.role}
                                    aria-label={`Role of ${member.name || member.email}`}
                                    aria-disabled={busy || undefined}
                                    onChange={e => {
                                      const next = e.target.value as TenantRole;
                                      const el = e.currentTarget;
                                      if (busy || next === member.role) return;
                                      if (roleChangeNeedsConfirm(member.role, next)) {
                                        pendingTriggerRef.current = el;
                                        setPendingAction({ type: 'role', id: member.id, label: member.email, from: member.role, to: next });
                                        return;
                                      }
                                      void runAction(
                                        () => updateMemberRole(currentTenant.id, member.id, next),
                                        `${member.email} now has the ${ROLE_LABELS[next]} role.`,
                                        'member'
                                      ).then(() => requestAnimationFrame(() => { if (!el.isConnected) resultRef.current?.focus(); }));
                                    }}
                                    className="text-xs font-bold rounded-lg px-2.5 py-1 bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 cursor-pointer transition-colors"
                                  >
                                    {row.options.map(r => (
                                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                                    ))}
                                  </select>
                                </div>
                              ) : (
                                <RoleBadge role={member.role} />
                              )}
                            </td>

                            {/* Status */}
                            <td className="py-3 px-4">
                              {isPending ? (
                                <span className="badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none" />
                                  Pending Invite
                                </span>
                              ) : expired ? (
                                <span className="badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400" aria-hidden="true" />
                                  {MEMBERSHIP_TEXT.expiredBadge}
                                </span>
                              ) : accountBadge ? (
                                <span className={`badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${accountBadge.tone === 'amber' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-rose-500/15 text-rose-300 border-rose-500/30'}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${accountBadge.tone === 'amber' ? 'bg-amber-400' : 'bg-rose-400'}`} />
                                  {accountBadge.label}
                                </span>
                              ) : (
                                <span className="badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                  Active
                                </span>
                              )}
                            </td>
                            {showSignIn && <td className="py-3 px-4 hidden md:table-cell text-slate-300 whitespace-nowrap">{memberSignInText(member)}</td>}

                            {/* Actions */}
                            <td className="py-3 px-4 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                {row.note && <span className="text-xs text-slate-400">{row.note}</span>}
                                {row.inviteActions && (
                                  <>
                                    {member.invitationToken && (
                                    <button
                                      type="button"
                                      onClick={() => handleCopyInvite(member.invitationToken!, member.id)}
                                      className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 text-xs transition-all"
                                      title="Copy Invite Link"
                                      aria-label={copiedTokenId === member.id ? 'Invitation link copied' : 'Copy invitation link'}
                                    >
                                      {copiedTokenId === member.id ? (
                                        <Check aria-hidden="true" className="w-3.5 h-3.5 text-emerald-400" />
                                      ) : (
                                        <Copy aria-hidden="true" className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={busy}
                                      aria-label={`Resend the invitation to ${member.email}`}
                                      onClick={() => handleResend(inviteIdFor(member)!)}
                                      className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 text-xs transition-all"
                                      title="Resend: issue a new link"
                                    >
                                      <RotateCw className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      aria-label={`Revoke the invitation for ${member.email}`}
                                      onClick={() => askRevoke(inviteIdFor(member)!, member.email)}
                                      className="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 hover:scale-105 active:scale-95 text-xs transition-all"
                                      title="Revoke Invite"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}

                                {edit.canEdit && (
                                  <button type="button" disabled={busy || offline} onClick={() => openEdit(member)}
                                    aria-label={`Edit access details for ${member.email}`} title={offline ? MEMBERSHIP_TEXT.offlineTitle : MEMBERSHIP_TEXT.editButtonTitle}
                                    className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                                    <UserCog className="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                )}

                                {row.remove && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Remove ${member.email}`}
                                    onClick={() => askRemove(member.id, member.email)}
                                    className="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 hover:scale-105 active:scale-95 text-xs transition-all"
                                    title="Remove Member"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {filteredMembers.length === 0 && (
                    <div className="p-6 text-center text-xs text-slate-400">
                      {teamEmptyText(showMembership ? usFilter : 'all')}
                    </div>
                  )}
                </div>

                {/* Team Footer */}
                <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Seat allocation: <strong className="text-slate-300">{members.length} members</strong> bound to {currentTenant.name}
                  </span>
                  <button
                    onClick={handleModalClose}
                    className="btn-secondary text-xs px-5 py-2"
                  >
                    Close
                  </button>
                </div>

                {/* Restore a member the inactivity check blocked (#257) */}
                {restoreTarget && (
                  <DialogOverlay onClose={restoreBusy ? undefined : closeRestore} className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
                    <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-amber-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
                      <form onSubmit={(e) => { e.preventDefault(); void runRestore(); }} className="max-h-[calc(94vh-0.75rem)] overflow-y-auto p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-4 text-xs">
                        <DialogTitle as="h3" className="text-base font-bold text-white">{DORMANCY_TEXT.restoreTitle}</DialogTitle>
                        <p className="text-slate-300 leading-relaxed"><strong className="text-white font-mono">{restoreTarget.email}</strong> {DORMANCY_TEXT.restoreLead}</p>
                        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-slate-300">
                          <dt className="text-slate-400">Last sign-in</dt><dd>{restoreTarget.lastSignIn}</dd>
                          <dt className="text-slate-400">Blocked</dt><dd>{restoreTarget.blockedOn}</dd>
                        </dl>
                        <p className="text-slate-400 leading-relaxed">{DORMANCY_TEXT.restoreBody}</p>
                        {mfaEnrolled ? (
                          <div>
                            <label htmlFor="team-restore-code" className="block text-xs font-semibold text-slate-300 mb-1">{DORMANCY_TEXT.codeLabel}</label>
                            <input id="team-restore-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={restoreCode}
                              onChange={(e) => setRestoreCode(e.target.value.replace(/\D/g, ''))} aria-describedby="team-restore-code-help" aria-invalid={restoreError ? true : undefined}
                              className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white font-mono tracking-widest focus:outline-none focus:border-brand-500" />
                            <p id="team-restore-code-help" className="mt-1 text-slate-400">{DORMANCY_TEXT.codeHelp}</p>
                          </div>
                        ) : <p className="text-amber-300 leading-relaxed">{DORMANCY_TEXT.ownerNeedsMfa}</p>}
                        <ErrorNotice message={restoreError} />
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={closeRestore} disabled={restoreBusy} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">Cancel</button>
                          <button type="submit" disabled={restoreBusy || !mfaEnrolled || !restoreCodeReady(restoreCode)} className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold">{restoreBusy ? DORMANCY_TEXT.restoreBusy : DORMANCY_TEXT.restoreButton}</button>
                        </div>
                      </form>
                    </div>
                  </DialogOverlay>
                )}

                {/* Access details of one member (#258, #259) */}
                {editTarget && editDraft && editView && (
                  <DialogOverlay onClose={editBusy ? undefined : closeEdit} className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
                    <div className="w-full max-w-lg p-1.5 rounded-[2rem] bg-gradient-to-b from-cyan-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
                      <form noValidate onSubmit={(e) => { e.preventDefault(); void runEdit(); }} className="max-h-[calc(94vh-0.75rem)] overflow-y-auto p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-4 text-xs">
                        <DialogTitle as="h3" className="text-base font-bold text-white">{MEMBERSHIP_TEXT.editTitle}</DialogTitle>
                        <p className="text-slate-300 break-words"><strong className="text-white">{editTarget.name}</strong> <span className="font-mono text-slate-400">{editTarget.email}</span></p>
                        <fieldset disabled={editBusy} className="space-y-4">
                          <legend className="sr-only">{`Access details for ${editTarget.email}`}</legend>
                          {/* 1. Access end date */}
                          <fieldset className="space-y-2">
                            <legend className="text-xs font-semibold text-slate-300">{MEMBERSHIP_TEXT.expiryLegend}</legend>
                            {editView.expiry === 'edit' ? (<>
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                                <label className="inline-flex items-center gap-2 text-slate-300"><input type="radio" name={`${uid}-exp`} checked={!editDraft.hasExpiry} onChange={() => setDraft({ hasExpiry: false })} className="h-4 w-4 border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />{MEMBERSHIP_TEXT.noEndDate}</label>
                                <label className="inline-flex items-center gap-2 text-slate-300"><input type="radio" name={`${uid}-exp`} checked={editDraft.hasExpiry} onChange={() => setDraft({ hasExpiry: true })} className="h-4 w-4 border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />{MEMBERSHIP_TEXT.endsOnDate}</label>
                              </div>
                              {editDraft.hasExpiry && (
                                <div className="space-y-1.5">
                                  <label htmlFor={`${uid}-exp-date`} className="block text-xs font-semibold text-slate-300">{MEMBERSHIP_TEXT.lastDayLabel}</label>
                                  <input id={`${uid}-exp-date`} type="date" min={utcToday(nowMs)} max={maxExpiryDate(nowMs)} value={editDraft.expiresOn}
                                    onChange={(e) => setDraft({ expiresOn: e.target.value })} aria-describedby={`${uid}-exp-preview ${uid}-exp-help`} aria-invalid={editError ? true : undefined}
                                    className="w-full sm:w-56 px-3 py-2 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all" />
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-slate-400">{MEMBERSHIP_TEXT.quickLabel}</span>
                                    {([['30 days', 30], ['90 days', 90], ['1 year', 365]] as const).map(([label, n]) => (
                                      <button key={label} type="button" onClick={() => setDraft({ expiresOn: addDaysUtc(utcToday(nowMs), n) })} className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 hover:text-white text-xs font-mono border border-slate-700 transition-colors">{label}</button>
                                    ))}
                                  </div>
                                  <p id={`${uid}-exp-preview`} aria-live="polite" className="text-slate-300">{expiryPreviewText(editDraft.expiresOn)}</p>
                                </div>
                              )}
                              <p id={`${uid}-exp-help`} className="text-slate-400 leading-relaxed">{MEMBERSHIP_TEXT.expiryHelp}</p>
                              {memberIsExpired(editTarget, nowMs) && <p className="text-amber-300">{MEMBERSHIP_TEXT.expiredRestoreHint}</p>}
                            </>) : (
                              <p className="text-slate-400">{editView.expiry === 'owner_never' ? MEMBERSHIP_TEXT.ownerNeverExpires : MEMBERSHIP_TEXT.selfExpiry}</p>
                            )}
                          </fieldset>
                          {/* 2. Affiliation */}
                          <div>
                            <label htmlFor={`${uid}-aff`} className="block text-xs font-semibold text-slate-300 mb-1">{MEMBERSHIP_TEXT.affiliationLabel}</label>
                            <select id={`${uid}-aff`} value={editDraft.affiliation} onChange={(e) => setDraft({ affiliation: e.target.value as MemberProfileDraft['affiliation'] })} aria-describedby={`${uid}-aff-help`}
                              className="w-full sm:w-72 px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400">
                              <option value="">{US_PERSON_LABELS.NOT_RECORDED}</option>
                              <option value="EMPLOYEE">{AFFILIATION_LABELS.EMPLOYEE}</option>
                              <option value="CONTRACTOR">{AFFILIATION_LABELS.CONTRACTOR}</option>
                              <option value="ESP">{AFFILIATION_LABELS.ESP}</option>
                            </select>
                            <p id={`${uid}-aff-help`} className="mt-1 text-slate-400">{MEMBERSHIP_TEXT.affiliationHelp}</p>
                          </div>
                          {/* 3. US-person status (owner level only) */}
                          {editView.usPerson !== 'hidden' && (
                            <fieldset className="space-y-2">
                              <legend className="text-xs font-semibold text-slate-300">{MEMBERSHIP_TEXT.usPersonLegend}</legend>
                              {editView.usPerson === 'edit' && (
                                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
                                  {([['US_PERSON', US_PERSON_LABELS.US_PERSON], ['OTHER', US_PERSON_LABELS.OTHER], ['', US_PERSON_LABELS.NOT_RECORDED]] as const).map(([v, label]) => (
                                    <label key={label} className="inline-flex items-center gap-2 text-slate-300"><input type="radio" name={`${uid}-us`} checked={editDraft.usPerson === v} onChange={() => setDraft({ usPerson: v })} className="h-4 w-4 border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />{label}</label>
                                  ))}
                                </div>
                              )}
                              <p className="text-slate-400 leading-relaxed">{editView.usPerson === 'self' ? MEMBERSHIP_TEXT.usPersonSelf : MEMBERSHIP_TEXT.usPersonHelp}</p>
                              {usPersonRecordedText(editTarget.usPersonRecordedAt) && <p className="text-slate-400">{usPersonRecordedText(editTarget.usPersonRecordedAt)}</p>}
                            </fieldset>
                          )}
                          {/* 4. Primary contact (owner level only) */}
                          {editView.primaryContact && (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <input type="checkbox" id={`${uid}-pc`} checked={editDraft.primaryContact} onChange={(e) => setDraft({ primaryContact: e.target.checked })} aria-describedby={`${uid}-pc-help`} className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />
                                <label htmlFor={`${uid}-pc`} className="text-xs font-semibold text-slate-300">{MEMBERSHIP_TEXT.primaryContactLabel}</label>
                              </div>
                              <p id={`${uid}-pc-help`} className="text-slate-400">{primaryContactHelp(members, editTarget.id, editDraft.primaryContact)}</p>
                            </div>
                          )}
                        </fieldset>
                        <p aria-live="polite" className="text-slate-300">{patchSummaryText(editPatch)}</p>
                        {offline && <p className="text-amber-300">{MEMBERSHIP_TEXT.offlineSave}</p>}
                        <ErrorNotice message={editError} />
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={closeEdit} disabled={editBusy} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">{MEMBERSHIP_TEXT.cancel}</button>
                          <button type="submit" disabled={editBusy || offline || Object.keys(editPatch).length === 0} className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold">{editBusy ? MEMBERSHIP_TEXT.saveBusy : MEMBERSHIP_TEXT.saveButton}</button>
                        </div>
                      </form>
                    </div>
                  </DialogOverlay>
                )}
              </div>
            )}

            {/* Tab 2: Compliance Scope & Multi-Audit Modules */}
            {activeModalTab === 'scope' && (
              <div className="space-y-5 animate-fadeIn">
                {/* Scope Explainer Card */}
                <div className="p-4 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-brand-950/20 border border-slate-800/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-white font-bold text-xs">
                      <Shield className="w-4 h-4 text-brand-400" />
                      <span>Enclave Compliance Scope & Multi-Audit Modules</span>
                    </div>
                    <span className="badge text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                      {currentTenant.name}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Configure which regulatory frameworks and baselines are activated for this defense enclave. Controls, assessments, and SSP artifacts in the header are scoped strictly to these enabled frameworks.
                  </p>
                </div>

                {/* Primary Baseline Selector */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80 space-y-2.5">
                  <div>
                    <label className="block text-xs font-bold text-slate-200 uppercase tracking-wider mb-1">
                      Primary Enclave Baseline
                    </label>
                    <p className="text-xs text-slate-400">
                      Default framework loaded when team members access this enclave.
                    </p>
                  </div>

                  <select
                    value={primaryFramework}
                    disabled={!canEditScope}
                    onChange={e => handlePrimaryChange(e.target.value as ComplianceFramework)}
                    className="w-full px-3.5 py-2.5 text-xs bg-slate-950 border border-slate-700/80 rounded-xl text-white focus:outline-none focus:border-brand-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {ALL_FRAMEWORKS.map(fw => (
                      <option key={fw.id} value={fw.id}>
                        {fw.label} ({fw.authority} — {fw.count} controls)
                      </option>
                    ))}
                  </select>
                </div>

                {/* Multi-Framework Module Toggles */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="block text-xs font-bold text-slate-200 uppercase tracking-wider">
                        Active Compliance Modules
                      </label>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Enable multi-audit compliance to cross-assess controls across standards.
                      </p>
                    </div>
                    <span className="badge text-xs font-mono px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30">
                      {enabledFrameworks.length} Selected
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                    {ALL_FRAMEWORKS.map(fw => {
                      const isPrimary = fw.id === primaryFramework;
                      const isChecked = enabledFrameworks.includes(fw.id);
                      return (
                        <label
                          key={fw.id}
                          className={`flex items-start gap-3 p-3 rounded-xl border text-xs transition-all ${
                            !canEditScope
                              ? 'cursor-default'
                              : 'cursor-pointer'
                          } ${
                            isPrimary
                              ? 'bg-brand-500/10 border-brand-500/40 text-brand-100'
                              : isChecked
                              ? 'bg-slate-800/90 border-slate-600 text-white'
                              : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isPrimary || !canEditScope}
                            onChange={() => handleToggleFramework(fw.id)}
                            className="mt-0.5 rounded border-slate-700 text-brand-500 focus:ring-0 focus:ring-offset-0 bg-slate-900 cursor-pointer disabled:cursor-not-allowed"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-bold text-xs truncate">{fw.shortName}</span>
                              {isPrimary ? (
                                <span className="badge text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-brand-500/30 text-brand-300 border border-brand-500/40 shrink-0">
                                  PRIMARY
                                </span>
                              ) : isChecked ? (
                                <span className="badge text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0">
                                  ACTIVE
                                </span>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5 truncate">
                              {fw.authority}
                            </div>
                            <div className="text-xs text-slate-400 font-mono mt-1">
                              {fw.count} baseline controls
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <ErrorNotice message={scopeError} />

                {/* Save Section / Permissions Notice */}
                <div className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
                  {!canEditScope ? (
                    <div className="text-xs text-amber-400/90 flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>{ROLE_TEXT.scopePlatformOnly}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {scopeSavedMessage && (
                        <div role="status" className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium animate-fadeIn">
                          <Check className="w-3.5 h-3.5" />
                          <span>Enclave framework scope saved!</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <button
                      type="button"
                      onClick={handleModalClose}
                      className="btn-secondary text-xs px-4 py-2"
                    >
                      Close
                    </button>
                    {canEditScope && (
                      <button
                        type="button"
                        onClick={handleSaveScope}
                        disabled={isSavingScope}
                        className="btn-primary text-xs px-5 py-2 flex items-center gap-1.5"
                      >
                        {isSavingScope ? (
                          <>
                            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin motion-reduce:animate-none" />
                            <span>Saving Scope...</span>
                          </>
                        ) : (
                          <>
                            <Save className="w-3.5 h-3.5" />
                            <span>Save Enclave Scope</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>
  );

  // ── Embedded mode: render inline without modal chrome ──
  if (embedded) {
    return (
      <>
        {innerContent}
        <InviteStaffModal
          isOpen={isInviteModalOpen}
          onClose={() => setIsInviteModalOpen(false)}
        />
      </>
    );
  }

  // ── Modal mode: wrapped in fixed overlay ──
  return (
    <>
      <DialogOverlay onClose={handleModalClose}
        onClick={handleModalClose}
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
      >
        <div
          onClick={e => e.stopPropagation()}
          className="w-full max-w-3xl p-1 rounded-2xl bg-gradient-to-b from-cyan-500/25 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[92vh] flex flex-col"
        >
          {innerContent}
        </div>
      </DialogOverlay>

      <InviteStaffModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
      />
    </>
  );
};
