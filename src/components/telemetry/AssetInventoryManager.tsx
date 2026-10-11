import React, { useState, useEffect, useRef } from 'react';
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
import {
  getEnclaveAssets,
  addEnclaveAsset,
  updateEnclaveAsset,
  deleteEnclaveAsset,
  importAssetsFromCsv,
  confirmDiscoveredAsset,
} from '../../data/telemetry/assetRegistry';
import { useTenant } from '../../context/TenantContext';
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
  const [assets, setAssets] = useState<EnclaveAsset[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedOs, setSelectedOs] = useState<string>('ALL');
  
  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<EnclaveAsset | null>(null);
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [isAccretionModalOpen, setIsAccretionModalOpen] = useState(false);
  const [classifyingAsset, setClassifyingAsset] = useState<EnclaveAsset | null>(null);
  const [csvContent, setCsvContent] = useState('');
  const [notification, setNotification] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reloadAssets = () => {
    const list = getEnclaveAssets(currentTenant.id);
    setAssets(list);
  };

  useEffect(() => {
    reloadAssets();
  }, [currentTenant.id]);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 4000);
  };

  // CRUD Handlers
  const handleSaveAsset = (assetData: Omit<EnclaveAsset, 'id'>) => {
    if (editingAsset) {
      updateEnclaveAsset(editingAsset.id, assetData, currentTenant.id);
      showNotification(`✓ Endpoint ${assetData.hostName} updated.`);
    } else {
      addEnclaveAsset(currentTenant.id, assetData);
      showNotification(`✓ Endpoint ${assetData.hostName} registered to enclave.`);
    }
    setEditingAsset(null);
    reloadAssets();
  };

  const handleDeleteAsset = (asset: EnclaveAsset) => {
    if (confirm(`Remove ${asset.hostName} (${asset.ipAddress}) from enclave inventory?`)) {
      deleteEnclaveAsset(asset.id, currentTenant.id);
      showNotification(`Removed endpoint ${asset.hostName}.`);
      reloadAssets();
    }
  };

  const handleImportCsv = () => {
    if (!csvContent.trim()) return;
    try {
      const imported = importAssetsFromCsv(currentTenant.id, csvContent);
      showNotification(`✓ Successfully imported ${imported.length} endpoints from CSV.`);
      setCsvContent('');
      setIsCsvModalOpen(false);
      reloadAssets();
    } catch (err) {
      console.error('CSV import failed:', err);
      alert('Failed to parse CSV. Please verify column formatting.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setCsvContent(content);
        setIsCsvModalOpen(true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleClassifyAsset = (asset: EnclaveAsset, category: CmmcAssetCategory) => {
    confirmDiscoveredAsset(currentTenant.id, asset.id, category);
    showNotification(`✓ ${asset.hostName} confirmed as ${category.replace('_', ' ')}.`);
    setClassifyingAsset(null);
    reloadAssets();
  };

  const handleAccretionDiscoveryComplete = (result: AccretionIngestResult) => {
    showNotification(`✓ Accretion Ingest: ${result.newDiscoveredCount} new rogue endpoints discovered, ${result.updatedExistingCount} updated.`);
    reloadAssets();
  };

  // Unconfirmed Discovered Assets
  const unconfirmedAssets = assets.filter(a => a.discoveryStatus === 'UNCONFIRMED_DISCOVERY');

  // Filtered Assets
  const filteredAssets = assets.filter(a => {
    const matchesSearch =
      a.hostName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.ipAddress.includes(searchQuery) ||
      a.notes.toLowerCase().includes(searchQuery.toLowerCase()) ||
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
  const totalCount = assets.length;
  const cuiAssetsCount = assets.filter(a => a.cmmcAssetCategory === 'CUI_ASSET').length;
  const securityProtectionCount = assets.filter(a => a.cmmcAssetCategory === 'SECURITY_PROTECTION').length;
  const scoredAssets = assets.filter(a => a.complianceScore !== null);
  const avgComplianceScore = scoredAssets.length > 0
    ? Math.round(scoredAssets.reduce((sum, a) => sum + (a.complianceScore || 0), 0) / scoredAssets.length)
    : 100;

  // OS Badge styling helper
  const renderOsBadge = (os: string) => {
    switch (os) {
      case 'rhel9':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/15 text-red-300 border border-red-500/30">RHEL 9</span>;
      case 'rhel8':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/15 text-red-300 border border-red-500/30">RHEL 8</span>;
      case 'ubuntu2204':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">Ubuntu 22</span>;
      case 'win2022':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30">Win 2022</span>;
      case 'win11':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">Win 11</span>;
      case 'cisco_ios':
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Cisco IOS</span>;
      default:
        return <span className="badge px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">{os}</span>;
    }
  };

  // Origin Badge helper
  const renderOriginBadge = (origin?: AssetSourceOrigin) => {
    switch (origin) {
      case 'ACCRETION_DISCOVERY':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/40">
            <Radio className="w-2.5 h-2.5 text-cyan-400" />
            <span>ACCRETION DISCOVERY</span>
          </span>
        );
      case 'PHOTON_AGENT':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-violet-500/15 text-violet-300 border border-violet-500/40">
            <Zap className="w-2.5 h-2.5 text-violet-400" />
            <span>PHOTON AGENT</span>
          </span>
        );
      case 'CSV_IMPORT':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/40">
            <FileSpreadsheet className="w-2.5 h-2.5 text-indigo-400" />
            <span>CSV IMPORT</span>
          </span>
        );
      case 'MANUAL_ENTRY':
      default:
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
            <span>MANUAL ADMIN</span>
          </span>
        );
    }
  };

  // CMMC Category Pill helper
  const renderCategoryPill = (cat: CmmcAssetCategory) => {
    switch (cat) {
      case 'CUI_ASSET':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
            <Database className="w-3 h-3 text-cyan-400" />
            <span>CUI Asset</span>
          </span>
        );
      case 'SECURITY_PROTECTION':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/15 text-violet-300 border border-violet-500/30">
            <Lock className="w-3 h-3 text-violet-400" />
            <span>Security Protection (SPA)</span>
          </span>
        );
      case 'CONTRACTOR_RISK':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            <span>Contractor Risk</span>
          </span>
        );
      case 'OUT_OF_SCOPE':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">
            <span>Out of Scope</span>
          </span>
        );
    }
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

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="file"
            ref={fileInputRef}
            accept=".csv,text/csv"
            onChange={handleFileUpload}
            className="hidden"
          />

          <button
            onClick={() => setIsAccretionModalOpen(true)}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-950/70 to-indigo-950/70 hover:from-cyan-900/70 hover:to-indigo-900/70 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm shadow-cyan-950/40"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>Accretion Sensor API</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Upload className="w-3.5 h-3.5 text-indigo-400" />
            <span>Import CSV</span>
          </button>

          <button
            onClick={() => {
              setEditingAsset(null);
              setIsAddModalOpen(true);
            }}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold text-xs shadow-md transition-all flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Single Host</span>
          </button>
        </div>
      </div>

      {/* ─── Unconfirmed Discovered Asset High-Priority Banner ─── */}
      {unconfirmedAssets.length > 0 && (
        <div
          onClick={() => setSelectedCategory(selectedCategory === 'UNCONFIRMED' ? 'ALL' : 'UNCONFIRMED')}
          className="rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-slate-900 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg shadow-amber-950/30 cursor-pointer hover:border-amber-400 transition-all animate-fadeIn"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-400 animate-pulse" />
            </div>
            <div>
              <p className="text-xs font-bold text-amber-200">
                ⚠️ Accretion discovered {unconfirmedAssets.length} new {unconfirmedAssets.length === 1 ? 'endpoint' : 'endpoints'}. Click to review and assign CMMC scope categories.
              </p>
              <p className="text-[11px] text-amber-300/80 mt-0.5">
                Passive sensor detected active network MAC addresses in enclave subnet. Assign CUI Asset or Security Protection status to enforce STIG baseline.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="px-3 py-1.5 rounded-lg bg-amber-500/25 text-amber-200 font-bold text-xs border border-amber-500/40 hover:bg-amber-500/35 transition-colors">
              {selectedCategory === 'UNCONFIRMED' ? 'Showing Discovered (Click to Reset)' : `Review Discovered (${unconfirmedAssets.length})`}
            </span>
          </div>
        </div>
      )}

      {/* Notification Banner */}
      {notification && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* ─── Summary Statistics Header ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Total Enclave Fleet</span>
            <Server className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-white mt-1.5">{totalCount}</p>
          <span className="text-[10px] text-slate-400">Endpoints registered</span>
        </div>

        <div className="rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-300">CUI Assets</span>
            <Database className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-cyan-300 mt-1.5">{cuiAssetsCount}</p>
          <span className="text-[10px] text-cyan-400/70">CMMC Scope Primary</span>
        </div>

        <div className="rounded-xl border border-violet-500/20 bg-violet-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-violet-300">Security Protection (SPA)</span>
            <Lock className="w-4 h-4 text-violet-400" />
          </div>
          <p className="text-2xl font-black text-violet-300 mt-1.5">{securityProtectionCount}</p>
          <span className="text-[10px] text-violet-400/70">Firewall, DC & SIEM</span>
        </div>

        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-300">Fleet Health</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-black text-emerald-400 mt-1.5">{avgComplianceScore}%</p>
          <span className="text-[10px] text-emerald-400/70">STIG Pass Average</span>
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
            placeholder="Search by Hostname, IP, MAC, or administrative notes..."
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>

        {/* Category Filter */}
        <div className="relative w-full sm:w-52">
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-8"
          >
            <option value="ALL">All CMMC Scopes</option>
            {unconfirmedAssets.length > 0 && (
              <option value="UNCONFIRMED">⚠️ Unconfirmed Discovered ({unconfirmedAssets.length})</option>
            )}
            <option value="CUI_ASSET">CUI Assets Only</option>
            <option value="SECURITY_PROTECTION">Security Protection (SPA)</option>
            <option value="CONTRACTOR_RISK">Contractor Risk</option>
            <option value="OUT_OF_SCOPE">Out of Scope</option>
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
            {filteredAssets.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  No enclave assets match your active filters.
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
                              <span className="badge px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                                UNCONFIRMED
                              </span>
                            )}
                          </div>
                          {asset.notes && (
                            <p className="text-[10px] text-slate-400 truncate max-w-xs mt-0.5">
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
                      <div className="font-mono text-[10px] text-slate-400">
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
                            <div className="flex flex-col gap-1 p-2 rounded-xl bg-slate-900 border border-amber-500/50 shadow-xl z-20 absolute top-0 left-0 min-w-[190px]">
                              <span className="text-[10px] font-bold text-amber-300 pb-1 border-b border-slate-800">
                                Assign CMMC Scope:
                              </span>
                              <button
                                onClick={() => handleClassifyAsset(asset, 'CUI_ASSET')}
                                className="text-left px-2 py-1 rounded hover:bg-cyan-950 text-cyan-300 text-[10px] font-medium"
                              >
                                • CUI Asset (In-Scope)
                              </button>
                              <button
                                onClick={() => handleClassifyAsset(asset, 'SECURITY_PROTECTION')}
                                className="text-left px-2 py-1 rounded hover:bg-violet-950 text-violet-300 text-[10px] font-medium"
                              >
                                • Security Protection (SPA)
                              </button>
                              <button
                                onClick={() => handleClassifyAsset(asset, 'CONTRACTOR_RISK')}
                                className="text-left px-2 py-1 rounded hover:bg-amber-950 text-amber-300 text-[10px] font-medium"
                              >
                                • Contractor Risk Asset
                              </button>
                              <button
                                onClick={() => handleClassifyAsset(asset, 'OUT_OF_SCOPE')}
                                className="text-left px-2 py-1 rounded hover:bg-slate-800 text-slate-400 text-[10px] font-medium"
                              >
                                • Out of Scope
                              </button>
                              <button
                                onClick={() => setClassifyingAsset(null)}
                                className="text-center text-[10px] text-slate-400 hover:text-white pt-1"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              {renderCategoryPill(asset.cmmcAssetCategory)}
                              <button
                                onClick={() => setClassifyingAsset(asset)}
                                className="px-2 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] font-bold transition-colors flex items-center gap-1 shrink-0"
                                title="Click to assign permanent CMMC scoping category"
                              >
                                <ShieldCheck className="w-3 h-3 text-amber-400" />
                                <span>Classify</span>
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        renderCategoryPill(asset.cmmcAssetCategory)
                      )}
                    </td>

                    {/* Last Scan Date */}
                    <td className="py-3 px-3 text-slate-400 font-mono text-[11px]">
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
                        <span className="text-slate-600">Never Scanned</span>
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
                        <span className="text-[10px] font-mono text-slate-400">Unscored</span>
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
                          className="px-2 py-1 rounded-lg bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold text-[11px] transition-all flex items-center gap-1 shadow-sm"
                          title="Run automated Photon SCAP Scan on this endpoint"
                        >
                          <Play className="w-3 h-3" />
                          <span>Scan</span>
                        </button>

                        {/* Edit Button */}
                        <button
                          onClick={() => {
                            setEditingAsset(asset);
                            setIsAddModalOpen(true);
                          }}
                          className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                          title="Edit endpoint metadata"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete Button */}
                        <button
                          onClick={() => handleDeleteAsset(asset)}
                          className="p-1 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 hover:border-rose-500/40 transition-colors"
                          title="Remove endpoint"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
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
      />

      {/* ─── CSV Bulk Import Modal ─── */}
      {isCsvModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="absolute inset-0" onClick={() => setIsCsvModalOpen(false)} />

          <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">Bulk CSV Endpoint Onboarding</h3>
              </div>
              <button
                onClick={() => setIsCsvModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Paste or inspect your CSV records below. Header line expected:
              <br />
              <code className="text-cyan-400 font-mono text-[11px]">
                hostName,ipAddress,osProfile,cmmcAssetCategory,macAddress,notes
              </code>
            </p>

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
                  onClick={handleImportCsv}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-bold text-xs transition-all shadow-md"
                >
                  Import Endpoints
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Accretion Ingestion & Simulation Modal ─── */}
      <AccretionIntegrationModal
        isOpen={isAccretionModalOpen}
        onClose={() => setIsAccretionModalOpen(false)}
        tenantId={currentTenant.id}
        onDiscoveryComplete={handleAccretionDiscoveryComplete}
      />

    </div>
  );
};
