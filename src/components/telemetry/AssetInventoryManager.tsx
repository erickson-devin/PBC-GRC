import React, { useState, useRef } from 'react';
import {
  Server,
  Monitor,
  Plus,
  Upload,
  Search,
  CheckCircle2,
  AlertTriangle,
  Play,
  Edit2,
  Trash2,
  FileSpreadsheet,
  X,
  Database,
  Lock,
  Cpu,
  ChevronDown,
  Radio,
  Zap,
  ShieldCheck,
} from 'lucide-react';
import {
  EnclaveAsset,
  CmmcAssetCategory,
  AssetSourceOrigin,
  AccretionIngestResult,
} from '../../types/telemetry';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import { describeFipsModule } from '../../data/telemetry/fipsValidation';
import { useEnclaveAssets } from '../../hooks/useEnclaveAssets';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from '../common/ErrorNotice';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';
import { errorMessage } from '../../utils/errors';
import { AddAssetModal } from './AddAssetModal';
import { AccretionIntegrationModal } from './AccretionIntegrationModal';

interface AssetInventoryManagerProps {
  onTriggerScan?: (asset: EnclaveAsset) => void;
  onSelectAsset?: (asset: EnclaveAsset) => void;
  selectedHost?: string;
}

export const AssetInventoryManager: React.FC<AssetInventoryManagerProps> = ({
  onTriggerScan,
  onSelectAsset,
  selectedHost,
}) => {
  const { currentTenant } = useTenant();
  // The inventory comes from the server for live tenants (the local store only backs the demo sandbox and tenants that
  // have not been moved to the server yet). Only a TENANT_OWNER / MSP_ADMIN can change it.
  const { assets, summary, loading, error: loadError, reload, backend, canEdit } = useEnclaveAssets();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedOs, setSelectedOs] = useState<string>('ALL');

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<EnclaveAsset | null>(null);
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [isAccretionModalOpen, setIsAccretionModalOpen] = useState(false);
  const [classifyingAsset, setClassifyingAsset] = useState<EnclaveAsset | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EnclaveAsset | null>(null);
  const [csvContent, setCsvContent] = useState('');
  const [csvIssues, setCsvIssues] = useState<string[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 4000);
  };

  /** Runs a change, shows its failure inline (never an alert), and refreshes through the shared subscription. */
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (err: unknown) {
      setActionError(errorMessage(err) || 'That change could not be saved.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // CRUD Handlers (the modal shows the error when a save fails, and stays open)
  const handleSaveAsset = async (assetData: Omit<EnclaveAsset, 'id'>) => {
    if (editingAsset) {
      // Only what the form owns: scan results and discovery data may have changed on the server since it opened
      const { hostName, ipAddress, macAddress, osProfile, cmmcAssetCategory, status, notes, owner } = assetData;
      const { fipsValidationStatus, fipsCertificateNumber, fipsModuleName, fipsStandard } = assetData;
      await backend.update(editingAsset.id, {
        hostName, ipAddress, macAddress, osProfile, cmmcAssetCategory, status, notes, owner,
        fipsValidationStatus, fipsCertificateNumber, fipsModuleName, fipsStandard,
      });
      showNotification(`✓ Asset ${assetData.hostName} updated.`);
    } else {
      await backend.create(assetData);
      showNotification(`✓ Asset ${assetData.hostName} registered to the enclave boundary.`);
    }
    setEditingAsset(null);
  };

  const handleDeleteAsset = async (asset: EnclaveAsset) => {
    const ok = await run(() => backend.remove(asset.id));
    setPendingDelete(null);
    if (ok) showNotification(`Removed asset ${asset.hostName}.`);
  };

  const handleImportCsv = async () => {
    if (!csvContent.trim()) return;
    setCsvIssues([]);
    await run(async () => {
      const { imported, skipped } = await backend.importCsv(csvContent);
      if (skipped.length > 0) setCsvIssues(skipped);
      if (imported > 0) showNotification(`✓ Imported ${imported} asset${imported === 1 ? '' : 's'} from CSV.` + (skipped.length > 0 ? ` ${skipped.length} row${skipped.length === 1 ? '' : 's'} skipped.` : ''));
      if (skipped.length === 0) {
        setCsvContent('');
        setIsCsvModalOpen(false);
      }
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setCsvContent(content);
        setCsvIssues([]);
        setIsCsvModalOpen(true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleClassifyAsset = async (asset: EnclaveAsset, category: CmmcAssetCategory) => {
    const ok = await run(async () => {
      await backend.classify(asset.id, category);
    });
    setClassifyingAsset(null);
    if (ok) showNotification(`✓ ${asset.hostName} confirmed as ${CATEGORY_INFO[category].label}.`);
  };

  const handleAccretionDiscoveryComplete = (result: AccretionIngestResult) => {
    showNotification(`✓ Accretion Ingest: ${result.newDiscoveredCount} new endpoints discovered, ${result.updatedExistingCount} updated.`);
    void reload();
  };

  // Unconfirmed Discovered Assets
  const unconfirmedAssets = assets.filter(a => a.discoveryStatus === 'UNCONFIRMED_DISCOVERY');

  // Filtered Assets
  const filteredAssets = assets.filter(a => {
    const matchesSearch =
      a.hostName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.ipAddress.includes(searchQuery) ||
      a.notes.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (a.owner ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (a.macAddress && a.macAddress.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesCategory =
      selectedCategory === 'ALL'
        ? true
        : selectedCategory === 'UNCONFIRMED'
        ? a.discoveryStatus === 'UNCONFIRMED_DISCOVERY'
        : a.cmmcAssetCategory === selectedCategory;

    const matchesOs = selectedOs === 'ALL' || a.osProfile === selectedOs;

    return matchesSearch && matchesCategory && matchesOs;
  });

  // Summary Metrics
  const totalCount = summary.total;
  const scoredAssets = assets.filter(a => a.complianceScore !== null);
  const avgComplianceScore = scoredAssets.length > 0
    ? Math.round(scoredAssets.reduce((sum, a) => sum + (a.complianceScore || 0), 0) / scoredAssets.length)
    : null; // nothing scanned yet: there is no average to show (never a flattering 100%)

  // OS Badge styling helper
  const renderOsBadge = (os: string) => {
    switch (os) {
      case 'rhel9':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-red-500/15 text-red-300 border border-red-500/30">RHEL 9</span>;
      case 'rhel8':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-red-500/15 text-red-300 border border-red-500/30">RHEL 8</span>;
      case 'ubuntu2204':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">Ubuntu 22</span>;
      case 'win2022':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30">Win 2022</span>;
      case 'win11':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">Win 11</span>;
      case 'cisco_ios':
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Cisco IOS</span>;
      default:
        return <span className="badge px-2 py-0.5 rounded text-xs font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">{os}</span>;
    }
  };

  // Origin Badge helper
  const renderOriginBadge = (origin?: AssetSourceOrigin) => {
    switch (origin) {
      case 'ACCRETION_DISCOVERY':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/40">
            <Radio className="w-2.5 h-2.5 text-cyan-400" />
            <span>ACCRETION DISCOVERY</span>
          </span>
        );
      case 'PHOTON_AGENT':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-violet-500/15 text-violet-300 border border-violet-500/40">
            <Zap className="w-2.5 h-2.5 text-violet-400" />
            <span>PHOTON AGENT</span>
          </span>
        );
      case 'CSV_IMPORT':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/40">
            <FileSpreadsheet className="w-2.5 h-2.5 text-indigo-400" />
            <span>CSV IMPORT</span>
          </span>
        );
      case 'MANUAL_ENTRY':
      default:
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
            <span>MANUAL ADMIN</span>
          </span>
        );
    }
  };

  // CMMC category styling. The label is always the full, explicit name from CATEGORY_INFO (e.g. CRMA is spelled out).
  const CATEGORY_STYLE: Record<CmmcAssetCategory, { pill: string; icon: string; text: string; hover: string; card: string; Icon: React.ElementType }> = {
    CUI_ASSET: { pill: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30', icon: 'text-cyan-400', text: 'text-cyan-300', hover: 'hover:bg-cyan-950', card: 'border-cyan-500/20 bg-cyan-950/20', Icon: Database },
    SECURITY_PROTECTION: { pill: 'bg-violet-500/15 text-violet-300 border-violet-500/30', icon: 'text-violet-400', text: 'text-violet-300', hover: 'hover:bg-violet-950', card: 'border-violet-500/20 bg-violet-950/20', Icon: Lock },
    CONTRACTOR_RISK: { pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: 'text-amber-400', text: 'text-amber-300', hover: 'hover:bg-amber-950', card: 'border-amber-500/20 bg-amber-950/20', Icon: AlertTriangle },
    SPECIALIZED_ASSET: { pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', icon: 'text-emerald-400', text: 'text-emerald-300', hover: 'hover:bg-emerald-950', card: 'border-emerald-500/20 bg-emerald-950/20', Icon: Cpu },
    OUT_OF_SCOPE: { pill: 'bg-slate-800 text-slate-400 border-slate-700', icon: 'text-slate-400', text: 'text-slate-300', hover: 'hover:bg-slate-800', card: 'border-slate-700 bg-slate-900/60', Icon: Server },
  };

  const renderCategoryPill = (cat: CmmcAssetCategory) => {
    const style = CATEGORY_STYLE[cat];
    return (
      <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${style.pill}`}>
        <style.Icon className={`w-3 h-3 ${style.icon}`} />
        <span>{CATEGORY_INFO[cat].label}</span>
      </span>
    );
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      
      {/* ─── Header & Top Actions ─── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
              <Server className="w-4 h-4" />
            </div>
            <span>Enclave Asset & Hardware Inventory Manager</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Registered enclave endpoints, CMMC 2.0 scoping categorizations, and DISA STIG telemetry linkage.
          </p>
        </div>

        {/* Action Buttons (changes are limited to Tenant Owners / MSP Admins; everyone else gets a read-only view) */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="file"
            ref={fileInputRef}
            accept=".csv,text/csv"
            onChange={handleFileUpload}
            className="hidden"
          />

          {canEdit && (<button
            onClick={() => setIsAccretionModalOpen(true)}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-950/70 to-indigo-950/70 hover:from-cyan-900/70 hover:to-indigo-900/70 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm shadow-cyan-950/40"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>Accretion Sensor API</span>
          </button>)}

          {canEdit && (<button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Upload className="w-3.5 h-3.5 text-indigo-400" />
            <span>Import CSV</span>
          </button>)}

          {canEdit && (<button
            onClick={() => {
              setEditingAsset(null);
              setIsAddModalOpen(true);
            }}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold text-xs shadow-md transition-all flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Asset</span>
          </button>)}
        </div>
      </div>

      {/* Browser-only tenant: its assets live in this browser until it is moved to the server. The notice also stays to confirm the move. */}
      {canEdit && <LegacyTenantNotice tenant={currentTenant} variant="inline" />}

      {!canEdit && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
          <Lock className="w-4 h-4 text-slate-400 shrink-0" />
          <span>Read-only: only a Tenant Owner or MSP Admin can change the asset inventory and the CMMC scoping.</span>
        </div>
      )}

      <ErrorNotice message={actionError} />
      {loadError && (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={loadError} className="flex-1" />
          <button onClick={() => void reload()} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
        </div>
      )}

      {/* ─── Unconfirmed Discovered Asset High-Priority Banner ─── */}
      {unconfirmedAssets.length > 0 && (
        <button type="button"
          onClick={() => setSelectedCategory(selectedCategory === 'UNCONFIRMED' ? 'ALL' : 'UNCONFIRMED')}
          className="w-full text-left rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-slate-900 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg shadow-amber-950/30 cursor-pointer hover:border-amber-400 transition-all animate-fadeIn"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-400 animate-pulse" />
            </div>
            <div>
              <p className="text-xs font-bold text-amber-200">
                Accretion discovered {unconfirmedAssets.length} new {unconfirmedAssets.length === 1 ? 'endpoint' : 'endpoints'}. Click to review and assign CMMC scope categories.
              </p>
              <p className="text-xs text-amber-300/80 mt-0.5">
                Passive sensor detected active network MAC addresses in the enclave subnet. Until an administrator assigns a CMMC category they are excluded from the SSP boundary counts.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="px-3 py-1.5 rounded-lg bg-amber-500/25 text-amber-200 font-bold text-xs border border-amber-500/40 hover:bg-amber-500/35 transition-colors">
              {selectedCategory === 'UNCONFIRMED' ? 'Showing Discovered (Click to Reset)' : `Review Discovered (${unconfirmedAssets.length})`}
            </span>
          </div>
        </button>
      )}

      {/* Notification Banner */}
      {notification && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* ─── Summary Statistics Header: the boundary, by CMMC category ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">In-Scope Assets</span>
            <Server className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-white mt-1.5">{summary.inScope}</p>
          <span className="text-xs text-slate-400">{totalCount} registered{summary.unconfirmed > 0 ? `, ${summary.unconfirmed} unclassified` : ''}</span>
        </div>

        {CMMC_ASSET_CATEGORIES.filter(c => c !== 'OUT_OF_SCOPE').map(cat => {
          const style = CATEGORY_STYLE[cat];
          return (
            <div key={cat} className={`rounded-xl border p-4 ${style.card}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold ${style.text}`}>{CATEGORY_INFO[cat].label}</span>
                <style.Icon className={`w-4 h-4 shrink-0 ${style.icon}`} />
              </div>
              <p className={`text-2xl font-black mt-1.5 ${style.text}`}>{summary.byCategory[cat]}</p>
              <span className="text-xs text-slate-400">{CATEGORY_INFO[cat].short}</span>
            </div>
          );
        })}

        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-300">Fleet Health</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-black text-emerald-400 mt-1.5">{avgComplianceScore === null ? '—' : `${avgComplianceScore}%`}</p>
          <span className="text-xs text-emerald-400/70">{avgComplianceScore === null ? 'No scans yet' : 'STIG Pass Average'}</span>
        </div>
      </div>

      {/* ─── Search & Category / OS Filter Toolbar ─── */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 w-full">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by name, IP, MAC, owner, or notes..."
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>

        {/* Category Filter */}
        <div className="relative w-full sm:w-72">
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-8"
          >
            <option value="ALL">All CMMC categories</option>
            {unconfirmedAssets.length > 0 && (
              <option value="UNCONFIRMED">Unconfirmed Discovered ({unconfirmedAssets.length})</option>
            )}
            {CMMC_ASSET_CATEGORIES.map(cat => (
              <option key={cat} value={cat}>{CATEGORY_INFO[cat].label}</option>
            ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        {/* OS Profile Filter */}
        <div className="relative w-full sm:w-40">
          <select
            value={selectedOs}
            onChange={e => setSelectedOs(e.target.value)}
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-8"
          >
            <option value="ALL">All OS Profiles</option>
            <option value="rhel9">RHEL 9</option>
            <option value="rhel8">RHEL 8</option>
            <option value="ubuntu2204">Ubuntu 22.04</option>
            <option value="win2022">Windows Server</option>
            <option value="win11">Windows 11</option>
            <option value="cisco_ios">Cisco IOS</option>
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
      </div>

      {/* ─── Inventory Asset Table ─── */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
              <th className="py-2.5 px-3">Endpoint / Hostname</th>
              <th className="py-2.5 px-3">IP Address</th>
              <th className="py-2.5 px-3">OS Platform</th>
              <th className="py-2.5 px-3">CMMC Scope Category</th>
              <th className="py-2.5 px-3">Last STIG Scan</th>
              <th className="py-2.5 px-3">Compliance Score</th>
              <th className="py-2.5 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400" role="status">
                  Loading the asset inventory…
                </td>
              </tr>
            ) : filteredAssets.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  {assets.length === 0
                    ? 'No assets registered yet. Add the systems that make up your CMMC assessment boundary and give each its category.'
                    : 'No enclave assets match your active filters.'}
                </td>
              </tr>
            ) : (
              filteredAssets.map(asset => {
                const isSelected = selectedHost === asset.hostName;

                return (
                  <tr
                    key={asset.id}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      isSelected ? 'bg-cyan-950/20' : ''
                    }`}
                  >
                    {/* Hostname & Origin Badge */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2.5">
                        {asset.osProfile === 'win2022' ? (
                          <Server className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        ) : asset.hostName.includes('WS') ? (
                          <Monitor className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        )}
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-bold text-white text-xs">
                              {asset.hostName}
                            </span>
                            {renderOriginBadge(asset.sourceOrigin)}
                            {asset.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && (
                              <span className="badge px-1.5 py-0.5 rounded text-xs font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                                UNCONFIRMED
                              </span>
                            )}
                          </div>
                          {asset.owner && (
                            <p className="text-xs text-slate-300 mt-0.5">Owner: {asset.owner}</p>
                          )}
                          {asset.fipsValidationStatus === 'VALIDATED' && asset.fipsCertificateNumber && (
                            <p className="text-xs text-emerald-300 mt-0.5" data-testid="fips-badge">
                              {describeFipsModule({ standard: asset.fipsStandard ?? null, certificateNumber: asset.fipsCertificateNumber, moduleName: asset.fipsModuleName ?? null })}
                            </p>
                          )}
                          {asset.fipsValidationStatus === 'PENDING' && (
                            <p className="text-xs text-amber-300 mt-0.5">FIPS validation pending</p>
                          )}
                          {asset.notes && (
                            <p className="text-xs text-slate-400 truncate max-w-xs mt-0.5">
                              {asset.notes}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* IP & MAC */}
                    <td className="py-3 px-3">
                      <div className="font-mono text-slate-200 text-xs">
                        {asset.ipAddress}
                      </div>
                      <div className="font-mono text-xs text-slate-400">
                        {asset.macAddress}
                      </div>
                    </td>

                    {/* OS Platform Badge */}
                    <td className="py-3 px-3">
                      {renderOsBadge(asset.osProfile)}
                    </td>

                    {/* CMMC Scope Category & Quick Classify */}
                    <td className="py-3 px-3">
                      {asset.discoveryStatus === 'UNCONFIRMED_DISCOVERY' ? (
                        <div className="relative">
                          {classifyingAsset?.id === asset.id ? (
                            <div className="flex flex-col gap-1 p-2 rounded-xl bg-slate-900 border border-amber-500/50 shadow-xl z-20 absolute top-0 left-0 min-w-[260px]">
                              <span className="text-xs font-bold text-amber-300 pb-1 border-b border-slate-800">
                                Assign CMMC category:
                              </span>
                              {CMMC_ASSET_CATEGORIES.map(cat => (
                                <button
                                  key={cat}
                                  disabled={busy}
                                  onClick={() => void handleClassifyAsset(asset, cat)}
                                  className={`text-left px-2 py-1 rounded ${CATEGORY_STYLE[cat].hover} ${CATEGORY_STYLE[cat].text} text-xs font-medium disabled:opacity-50`}
                                  title={CATEGORY_INFO[cat].description}
                                >
                                  • {CATEGORY_INFO[cat].label}
                                </button>
                              ))}
                              <button
                                onClick={() => setClassifyingAsset(null)}
                                className="text-center text-xs text-slate-400 hover:text-white pt-1"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              {renderCategoryPill(asset.cmmcAssetCategory)}
                              {canEdit && (<button
                                onClick={() => setClassifyingAsset(asset)}
                                className="px-2 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-colors flex items-center gap-1 shrink-0"
                                title="Click to assign permanent CMMC scoping category"
                              >
                                <ShieldCheck className="w-3 h-3 text-amber-400" />
                                <span>Classify</span>
                              </button>)}
                            </div>
                          )}
                        </div>
                      ) : (
                        renderCategoryPill(asset.cmmcAssetCategory)
                      )}
                    </td>

                    {/* Last Scan Date */}
                    <td className="py-3 px-3 text-slate-400 font-mono text-xs">
                      {asset.lastScannedAt ? (
                        <span>
                          {new Date(asset.lastScannedAt).toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      ) : (
                        <span className="text-slate-400">Never Scanned</span>
                      )}
                    </td>

                    {/* Compliance Score */}
                    <td className="py-3 px-3">
                      {asset.complianceScore !== null ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-slate-800 h-2 rounded-full overflow-hidden shrink-0">
                            <div
                              className={`h-full rounded-full transition-all ${
                                asset.complianceScore === 100
                                  ? 'bg-emerald-400'
                                  : asset.complianceScore >= 80
                                  ? 'bg-cyan-400'
                                  : 'bg-rose-500'
                              }`}
                              style={{ width: `${asset.complianceScore}%` }}
                            />
                          </div>
                          <span className="font-mono font-bold text-white text-xs">
                            {asset.complianceScore}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs font-mono text-slate-400">Unscored</span>
                      )}
                    </td>

                    {/* Actions Menu */}
                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Run Photon Scan Button */}
                        <button
                          onClick={() => {
                            if (onTriggerScan) {
                              onTriggerScan(asset);
                            } else if (onSelectAsset) {
                              onSelectAsset(asset);
                            }
                          }}
                          className="px-2 py-1 rounded-lg bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold text-xs transition-all flex items-center gap-1 shadow-sm"
                          title="Run automated Photon SCAP Scan on this endpoint"
                        >
                          <Play className="w-3 h-3" />
                          <span>Scan</span>
                        </button>

                        {canEdit && pendingDelete?.id === asset.id ? (
                          <div className="flex items-center gap-1.5" role="group" aria-label={`Confirm removing ${asset.hostName}`}>
                            <span className="text-xs text-rose-300">Remove {asset.hostName}?</span>
                            <button
                              disabled={busy}
                              onClick={() => void handleDeleteAsset(asset)}
                              className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs disabled:opacity-50"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setPendingDelete(null)}
                              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs border border-slate-700"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          canEdit && (
                            <>
                              {/* Edit Button */}
                              <button
                                onClick={() => {
                                  setEditingAsset(asset);
                                  setIsAddModalOpen(true);
                                }}
                                className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                                title="Edit asset"
                                aria-label={`Edit ${asset.hostName}`}
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>

                              {/* Delete Button */}
                              <button
                                onClick={() => setPendingDelete(asset)}
                                className="p-1 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 hover:border-rose-500/40 transition-colors"
                                title="Remove asset"
                                aria-label={`Remove ${asset.hostName}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )
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

      {/* ─── Add / Edit Modal ─── */}
      <AddAssetModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingAsset(null);
        }}
        onSave={handleSaveAsset}
        initialAsset={editingAsset}
        tenantId={currentTenant.id}
      />

      {/* ─── Accretion Webhook & API Key Modal ─── */}
      <AccretionIntegrationModal
        isOpen={isAccretionModalOpen}
        onClose={() => setIsAccretionModalOpen(false)}
        onDiscoveryComplete={handleAccretionDiscoveryComplete}
        tenantId={currentTenant.id}
        backend={backend}
      />

      {/* ─── CSV Bulk Import Modal ─── */}
      {isCsvModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div aria-hidden="true" className="absolute inset-0" onClick={() => setIsCsvModalOpen(false)} />

          <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">Bulk CSV Endpoint Onboarding</h3>
              </div>
              <button aria-label="Close"
                onClick={() => setIsCsvModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Paste or inspect your CSV records below. Header line expected:
              <br />
              <code className="text-cyan-400 font-mono text-xs">
                hostName,ipAddress,osProfile,cmmcAssetCategory,macAddress,notes,owner
              </code>
            </p>

            <ErrorNotice message={actionError} />
            {csvIssues.length > 0 && (
              <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1 max-h-32 overflow-y-auto">
                <p className="font-semibold">{csvIssues.length} row{csvIssues.length === 1 ? ' was' : 's were'} not imported:</p>
                {csvIssues.map((issue, i) => (
                  <p key={i}>{issue}</p>
                ))}
              </div>
            )}

            <textarea
              rows={8}
              value={csvContent}
              onChange={e => setCsvContent(e.target.value)}
              placeholder={`WS-FIN-01,10.0.50.41,win11,CUI_ASSET,00:50:56:A1:01,Finance processing workstation\nNODE-STORAGE-01,10.0.50.60,rhel9,CUI_ASSET,52:54:00:88:22,Encrypted backup storage cluster`}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => {
                  setCsvContent(`hostName,ipAddress,osProfile,cmmcAssetCategory,macAddress,notes
WS-FIN-01,10.0.50.41,win11,CUI_ASSET,00:50:56:A1:01,Finance CUI processing workstation
NODE-STORAGE-01,10.0.50.60,rhel9,CUI_ASSET,52:54:00:88:22,Encrypted backup storage cluster
BASTION-01,10.0.50.10,ubuntu2204,SECURITY_PROTECTION,00:50:56:B2:11,SSH jump host for administrative enclave`);
                }}
                className="text-xs text-cyan-400 hover:underline"
              >
                Load Sample CSV Template
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsCsvModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleImportCsv()}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-bold text-xs transition-all shadow-md disabled:opacity-50"
                >
                  Import Endpoints
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


    </div>
  );
};
