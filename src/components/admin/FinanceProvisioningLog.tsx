import React, { useState, useMemo } from 'react';
import {
  Receipt,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  Copy,
  Check,
  ShieldCheck,
  CreditCard,
  DollarSign,
  PlusCircle,
  AlertCircle,
} from 'lucide-react';
import { Tenant, TenantInvitation } from '../../types/tenant';

interface FinanceProvisioningLogProps {
  tenants: Tenant[];
  invitations: TenantInvitation[];
  onOpenNewTenantModal: () => void;
  onEnterEnclave?: (tenantId: string) => void;
}

export const FinanceProvisioningLog: React.FC<FinanceProvisioningLogProps> = ({
  tenants,
  invitations,
  onOpenNewTenantModal,
  onEnterEnclave,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [filterTier, setFilterTier] = useState<'ALL' | 'single-org' | 'msp-assessor'>('ALL');
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'ACCEPTED' | 'PENDING'>('ALL');

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  // Compile provisioning records by correlating tenants and their onboarding invitations
  const records = useMemo(() => {
    return tenants.map((tenant) => {
      // Find onboarding invitation for this tenant
      const onboardingInvite = invitations.find(
        (inv) => inv.tenantId === tenant.id && inv.type === 'TENANT_ONBOARDING'
      ) || invitations.find((inv) => inv.tenantId === tenant.id);

      const licenseTier = tenant.licenseTier || onboardingInvite?.licenseTier || 'single-org';
      const provisionedDate = tenant.createdAt || onboardingInvite?.createdAt || new Date().toISOString();
      const provisionedBy = onboardingInvite?.invitedBy || 'devin@pitchblackcyber.com';
      const inviteStatus = onboardingInvite?.status || 'ACCEPTED';
      const ownerEmail = onboardingInvite?.email || tenant.systemOwner || 'ciso@client.org';
      const inviteToken = onboardingInvite?.token;
      const inviteUrl = inviteToken
        ? `${window.location.origin}/accept-invite?token=${encodeURIComponent(inviteToken)}`
        : null;

      const annualPrice = licenseTier === 'msp-assessor' ? 1500 : 1000;

      return {
        tenantId: tenant.id,
        clientName: tenant.name,
        systemName: tenant.systemName,
        cageCode: tenant.cageCode,
        licenseTier,
        annualPrice,
        provisionedDate,
        provisionedBy,
        inviteStatus,
        ownerEmail,
        inviteUrl,
        isDemo: tenant.isDemo,
      };
    });
  }, [tenants, invitations]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    return records.filter((rec) => {
      if (filterTier !== 'ALL' && rec.licenseTier !== filterTier) return false;
      if (filterStatus !== 'ALL' && rec.inviteStatus !== filterStatus) return false;
      return true;
    });
  }, [records, filterTier, filterStatus]);

  // KPI Calculations
  const stats = useMemo(() => {
    const totalEnclaves = records.length;
    const totalArr = records.reduce((acc, r) => acc + r.annualPrice, 0);
    const pendingClaims = records.filter((r) => r.inviteStatus === 'PENDING').length;
    const singleOrgCount = records.filter((r) => r.licenseTier === 'single-org').length;
    const mspCount = records.filter((r) => r.licenseTier === 'msp-assessor').length;

    return { totalEnclaves, totalArr, pendingClaims, singleOrgCount, mspCount };
  }, [records]);

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return isoStr;
    }
  };

  return (
    <div className="stitch-card p-6 space-y-6">
      {/* Header & Action */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-cyan-950/70 border border-cyan-500/30 text-[10px] font-mono font-extrabold uppercase tracking-widest text-cyan-300">
            <Receipt className="w-3 h-3 text-cyan-400" />
            <span>FINANCE & MANUAL PROVISIONING PIPELINE</span>
          </div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 mt-1">
            <DollarSign className="w-5 h-5 text-emerald-400" />
            <span>Finance & Manual Provisioning Pipeline</span>
          </h2>
          <p className="text-xs text-slate-400">
            Track enclaves provisioned manually for clients managed via internal finance billing. No public credit card checkout required.
          </p>
        </div>

        <button
          onClick={onOpenNewTenantModal}
          className="btn-primary text-xs px-4 py-2.5 flex items-center gap-2 shrink-0 shadow-lg"
        >
          <PlusCircle className="w-4 h-4" />
          <span>Provision Client Enclave (Finance Bill)</span>
        </button>
      </div>

      {/* KPI Metrics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Provisioned Enclaves</div>
          <div className="text-xl font-black text-white mt-1">{stats.totalEnclaves}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Isolated Google Cloud SQL RLS</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400">Annual Invoiced ARR</div>
          <div className="text-xl font-black text-emerald-400 mt-1">
            ${stats.totalArr.toLocaleString('en-US')}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Flat defense licensing</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-400">Pending Claims</div>
          <div className="text-xl font-black text-amber-400 mt-1">{stats.pendingClaims}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Awaiting contractor login</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400">Primary Operator</div>
          <div className="text-xs font-mono font-bold text-cyan-300 mt-1.5 truncate">
            devin@pitchblackcyber.com
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Authorized Provisioner</div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Tier:</span>
          <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800 text-xs">
            <button
              onClick={() => setFilterTier('ALL')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterTier === 'ALL' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              All ({records.length})
            </button>
            <button
              onClick={() => setFilterTier('single-org')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterTier === 'single-org' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              $1,000 Single Org ({stats.singleOrgCount})
            </button>
            <button
              onClick={() => setFilterTier('msp-assessor')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterTier === 'msp-assessor' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              $1,500 MSP Assessor ({stats.mspCount})
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Claim Status:</span>
          <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800 text-xs">
            <button
              onClick={() => setFilterStatus('ALL')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterStatus === 'ALL' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilterStatus('ACCEPTED')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterStatus === 'ACCEPTED' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Active / Claimed
            </button>
            <button
              onClick={() => setFilterStatus('PENDING')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                filterStatus === 'PENDING' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Pending Invite
            </button>
          </div>
        </div>
      </div>

      {/* Audit Table */}
      <div className="border border-slate-800 rounded-xl overflow-x-auto bg-slate-950/60 shadow-inner">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-slate-900/90 text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-slate-800">
            <tr>
              <th className="py-3 px-4">Date Provisioned</th>
              <th className="py-3 px-4">Client Name & Boundary</th>
              <th className="py-3 px-4">License Tier</th>
              <th className="py-3 px-4">Provisioned By</th>
              <th className="py-3 px-4">Invite Status</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-sans">
            {filteredRecords.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-slate-500">
                  No finance provisioning records matching selected filters.
                </td>
              </tr>
            ) : (
              filteredRecords.map((rec) => {
                return (
                  <tr
                    key={rec.tenantId}
                    className="even:bg-slate-900/30 hover:bg-slate-800/40 transition-colors"
                  >
                    {/* Date Provisioned */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5 text-slate-500" />
                        <span className="font-mono text-slate-200">{formatDate(rec.provisionedDate)}</span>
                      </div>
                    </td>

                    {/* Client Name & Boundary */}
                    <td className="py-3.5 px-4">
                      <div className="space-y-0.5">
                        <div className="font-semibold text-white flex items-center gap-1.5">
                          <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                          <span>{rec.clientName}</span>
                          {rec.isDemo && (
                            <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-mono">
                              SANDBOX
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                          <span className="font-mono text-cyan-400">CAGE: {rec.cageCode}</span>
                          <span>•</span>
                          <span className="truncate max-w-[200px]">{rec.systemName}</span>
                        </div>
                      </div>
                    </td>

                    {/* License Tier */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {rec.licenseTier === 'msp-assessor' ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-950/60 text-indigo-300 border border-indigo-500/30 font-mono text-[11px] font-semibold">
                          <CreditCard className="w-3 h-3 text-indigo-400" />
                          $1,500/yr (MSP Assessor)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-500/30 font-mono text-[11px] font-semibold">
                          <CreditCard className="w-3 h-3 text-emerald-400" />
                          $1,000/yr (Single Org)
                        </span>
                      )}
                    </td>

                    {/* Provisioned By */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
                        <ShieldCheck className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="text-cyan-300 font-medium">{rec.provisionedBy}</span>
                      </div>
                      <div className="text-[10px] text-slate-500 pl-5">Internal Finance Billing</div>
                    </td>

                    {/* Invite Status */}
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {rec.inviteStatus === 'ACCEPTED' ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium text-[11px]">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          Active / Claimed
                        </span>
                      ) : rec.inviteStatus === 'PENDING' ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium text-[11px]">
                          <Clock className="w-3 h-3 text-amber-400" />
                          Pending Claim
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium text-[11px]">
                          <AlertCircle className="w-3 h-3 text-rose-400" />
                          {rec.inviteStatus}
                        </span>
                      )}
                      <div className="text-[10px] text-slate-500 mt-0.5 font-mono truncate max-w-[140px]">
                        {rec.ownerEmail}
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        {rec.inviteUrl && rec.inviteStatus === 'PENDING' && (
                          <button
                            onClick={() => handleCopy(rec.inviteUrl!, rec.tenantId)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                            title="Copy Onboarding Link"
                          >
                            {copiedId === rec.tenantId ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {onEnterEnclave && (
                          <button
                            onClick={() => onEnterEnclave(rec.tenantId)}
                            className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1"
                            title="Enter Enclave Boundary"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
