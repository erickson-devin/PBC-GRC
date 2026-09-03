import React, { useState } from 'react';
import {
  X,
  Users,
  Shield,
  CheckCircle2,
  Lock,
  Plus,
  Copy,
  Check,
  RotateCw,
  Trash2,
  Search,
  Info,
} from 'lucide-react';
import { useTenant, buildInviteUrl } from '../../context/TenantContext';
import { TenantRole } from '../../types/tenant';
import { InviteStaffModal } from './InviteStaffModal';

interface TeamSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TeamSettingsModal: React.FC<TeamSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    currentTenant,
    currentUser,
    canManageTenant,
    getTenantMembers,
    updateMemberRole,
    removeMember,
    revokeInvitation,
    resendInvitation,
    invitations,
  } = useTenant();

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [showRoleInfo, setShowRoleInfo] = useState(false);


  if (!isOpen) return null;

  const members = getTenantMembers(currentTenant.id);

  // Filter members by search
  const filteredMembers = members.filter(m =>
    m.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCopyInvite = async (token: string, memberId: string) => {
    const inviteUrl = buildInviteUrl(token);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedTokenId(memberId);
      setTimeout(() => setCopiedTokenId(null), 2000);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  const handleResend = async (token: string) => {
    const targetInvite = invitations.find(i => i.token === token);
    if (targetInvite) {
      const res = await resendInvitation(targetInvite.id);
      await navigator.clipboard.writeText(res.inviteUrl);
      alert(`Invitation renewed for 14 days! Link copied to clipboard.`);
    }
  };

  const handleRevoke = (token: string, email: string) => {
    const targetInvite = invitations.find(i => i.token === token);
    if (targetInvite && confirm(`Revoke pending invitation for ${email}?`)) {
      revokeInvitation(targetInvite.id);
    }
  };

  const handleRemoveActiveMember = (memberId: string, memberEmail: string) => {
    if (memberEmail.toLowerCase() === currentUser.email.toLowerCase()) {
      alert('You cannot remove yourself from this defense enclave.');
      return;
    }
    if (confirm(`Remove member "${memberEmail}" from ${currentTenant.name}? They will lose access immediately.`)) {
      removeMember(currentTenant.id, memberId);
    }
  };

  const getRoleBadge = (role: TenantRole) => {
    switch (role) {
      case 'TENANT_OWNER':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <Shield className="w-3 h-3" /> Tenant Owner
          </span>
        );
      case 'ASSESSOR':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
            <CheckCircle2 className="w-3 h-3" /> Assessor
          </span>
        );
      case 'VIEWER':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-500/20 text-slate-300 border border-slate-500/30">
            <Lock className="w-3 h-3" /> Viewer (C3PAO)
          </span>
        );
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn">
        {/* Double-Bezel Card */}
        <div className="w-full max-w-3xl p-1.5 rounded-[2.25rem] bg-gradient-to-b from-brand-500/25 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[92vh] flex flex-col">
          <div className="p-5 sm:p-7 rounded-[calc(2.25rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 flex flex-col max-h-[calc(92vh-0.75rem)] overflow-y-auto space-y-5">
            
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30">
                      RBAC ENCLAVE SETTINGS
                    </span>
                    <span className="text-xs text-slate-400 font-mono">
                      {currentTenant.cageCode ? `CAGE: ${currentTenant.cageCode}` : 'PENDING'}
                    </span>
                  </div>
                  <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight mt-0.5">
                    Team & Role Permissions — {currentTenant.name}
                  </h2>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowRoleInfo(prev => !prev)}
                  className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors"
                  title="View CMMC Role Matrix"
                >
                  <Info className="w-4 h-4 text-brand-400" />
                </button>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Role Capabilities Matrix Accordion */}
            {showRoleInfo && (
              <div className="p-4 rounded-2xl bg-slate-900/90 border border-brand-500/30 space-y-3 text-xs animate-fadeIn">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-brand-400" />
                    CMMC Level 1 Role-Based Access Control (RBAC) Architecture
                  </span>
                  <button
                    onClick={() => setShowRoleInfo(false)}
                    className="text-[11px] text-slate-400 hover:text-white"
                  >
                    Hide
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl bg-slate-950/70 border border-purple-500/20 space-y-1">
                    <span className="font-bold text-purple-300 text-xs flex items-center gap-1">
                      <Shield className="w-3.5 h-3.5" /> TENANT_OWNER
                    </span>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Full control over enclave boundaries, team member invitations, role reassignments, and SSP exports.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950/70 border border-blue-500/20 space-y-1">
                    <span className="font-bold text-blue-300 text-xs flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> ASSESSOR
                    </span>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Can edit all 17 CMMC controls, draft implementation statements, upload and delete SHA-256 evidence.
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-700/40 space-y-1">
                    <span className="font-bold text-slate-300 text-xs flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5" /> VIEWER
                    </span>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Read-only clearance for third-party C3PAO auditors or corporate stakeholders. Cannot edit practices.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Actions Bar: Search + Invite Button */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search team members by name or email..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                />
              </div>

              {canManageTenant && (
                <button
                  onClick={() => setIsInviteModalOpen(true)}
                  className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md shadow-brand-500/20 flex items-center justify-center gap-1.5 transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Invite Staff / Auditor</span>
                </button>
              )}
            </div>

            {/* Members Table */}
            <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Member Name & Email</th>
                    <th className="py-3 px-4">Enclave Role</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-sans">
                  {filteredMembers.map(member => {
                    const isSelf = member.email.toLowerCase() === currentUser.email.toLowerCase();
                    const isPending = member.status === 'PENDING_INVITE';

                    return (
                      <tr key={member.id} className="hover:bg-slate-900/40 transition-colors">
                        {/* Member Identity */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm">
                              {member.name ? member.name.charAt(0).toUpperCase() : member.email.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-white truncate">{member.name || member.email.split('@')[0]}</span>
                                {isSelf && (
                                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-brand-500/20 text-brand-300 border border-brand-500/30">
                                    You
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] font-mono text-slate-400 truncate">{member.email}</p>
                            </div>
                          </div>
                        </td>

                        {/* Role Badge & Role Changer */}
                        <td className="py-3 px-4">
                          {canManageTenant && !isSelf && !isPending ? (
                            <div className="relative inline-block">
                              <select
                                value={member.role}
                                onChange={e => updateMemberRole(currentTenant.id, member.id, e.target.value as TenantRole)}
                                className="text-[10px] font-bold rounded-lg px-2.5 py-1 bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-brand-500 cursor-pointer"
                              >
                                <option value="TENANT_OWNER">Tenant Owner</option>
                                <option value="ASSESSOR">Assessor</option>
                                <option value="VIEWER">Viewer (Auditor)</option>
                              </select>
                            </div>
                          ) : (
                            getRoleBadge(member.role)
                          )}
                        </td>

                        {/* Status */}
                        <td className="py-3 px-4">
                          {isPending ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                              Pending Invite
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              Active
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {isPending && member.invitationToken && (
                              <>
                                <button
                                  onClick={() => handleCopyInvite(member.invitationToken!, member.id)}
                                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 text-[11px] transition-colors"
                                  title="Copy Invite Link"
                                >
                                  {copiedTokenId === member.id ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                                <button
                                  onClick={() => handleResend(member.invitationToken!)}
                                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 text-[11px] transition-colors"
                                  title="Resend / Refresh Link"
                                >
                                  <RotateCw className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleRevoke(member.invitationToken!, member.email)}
                                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 text-[11px] transition-colors"
                                  title="Revoke Invite"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}

                            {!isPending && canManageTenant && !isSelf && (
                              <button
                                onClick={() => handleRemoveActiveMember(member.id, member.email)}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 text-[11px] transition-colors"
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
                <div className="p-6 text-center text-xs text-slate-500">
                  No matching members found in this enclave.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
              <span className="text-[11px] text-slate-500">
                Seat allocation: <strong className="text-slate-300">{members.length} members</strong> bound to {currentTenant.name}
              </span>
              <button
                onClick={onClose}
                className="px-5 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
              >
                Close
              </button>
            </div>

          </div>
        </div>
      </div>

      {/* Invite Staff Child Modal */}
      <InviteStaffModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
      />
    </>
  );
};
