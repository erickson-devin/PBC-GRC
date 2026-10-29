import React, { useState, useRef, useId, useMemo } from 'react';
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
  Archive,
  Info,
  PlusCircle,
  MinusCircle,
} from 'lucide-react';
import {
  EnclaveAsset,
  CmmcAssetCategory,
  AssetSourceOrigin,
  AccretionIngestResult,
} from '../../types/telemetry';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES, summarizeScope } from '../../data/telemetry/assetScope';
import { describeFipsModule } from '../../data/telemetry/fipsValidation';
import { useEnclaveAssets } from '../../hooks/useEnclaveAssets';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from '../common/ErrorNotice';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';
import { errorMessage } from '../../utils/errors';
import { FailedMoveAssetsNotice } from './FailedMoveAssetsNotice';
import { AddAssetModal } from './AddAssetModal';
import { AccretionIntegrationModal } from './AccretionIntegrationModal';
import { ConfirmBoundaryChangeDialog } from './ConfirmBoundaryChangeDialog';
import { useProgramAssets } from '../../hooks/useProgramAssets';
import { boundaryAssets, membershipLabels } from '../../data/programAssets';
import { BoundaryChangePlan, BoundaryFilter, boundaryBlockMessage, boundaryEditBlock, boundaryErrorMessage, emptyTableMessage, matchesBoundaryFilter, planBoundaryChange, rowChangeNeedsConfirm, summaryCaption } from '../../data/boundaryView';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
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
  const { currentTenant, activeProgram, programs, programsStatus } = useTenant();
  // The inventory comes from the server (the local store only backs tenants that have not been moved to the server yet). Only a TENANT_OWNER / MSP_ADMIN can change it.
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

  // Boundary membership (issue #26): which assets the active program declares. Server-backed tenants only: a browser-only tenant has no programs.
  const boundary = useProgramAssets();
  const showBoundary = programsStatus !== 'unsupported';
  const [boundaryFilterChoice, setBoundaryFilter] = useState<BoundaryFilter>('ALL');
  const [pendingBoundary, setPendingBoundary] = useState<BoundaryChangePlan | null>(null);
  const boundaryReasonId = useId();
  const boundaryFilterRef = useRef<HTMLSelectElement>(null);
  const programName = activeProgram?.name ?? 'This program';
  const boundaryReady = showBoundary && activeProgram !== null && boundary.status === 'ready';
  // The filter applies only while the boundary is known; otherwise the whole inventory is shown
  const boundaryFilter: BoundaryFilter = boundaryReady ? boundaryFilterChoice : 'ALL';
  const boundaryBlock = boundaryEditBlock({ supported: showBoundary, canEdit, hasActiveProgram: activeProgram !== null, archived: Boolean(activeProgram?.archived), status: boundary.status });
  const columnCount = showBoundary ? 8 : 7;

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
      showNotification(showBoundary && boundary.declared ? `✓ Asset ${assetData.hostName} registered to the inventory. It is not in ${programName} until you add it.` : `✓ Asset ${assetData.hostName} registered to the inventory.`);
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

  /** One PATCH with the delta; the hook reloads the memberships (and tells the SSP export). */
  const applyBoundaryChange = async (plan: BoundaryChangePlan): Promise<void> => {
    if (plan.direction === 'add') await boundary.add(plan.ids);
    else await boundary.remove(plan.ids);
  };

  const announceBoundaryChange = (plan: BoundaryChangePlan) => {
    const what = plan.ids.length === 1 && plan.sampleNames.length === 1 ? plan.sampleNames[0] : `${plan.ids.length} assets`;
    showNotification(plan.direction === 'add' ? `✓ ${what} added to ${programName}.` : `✓ ${what} removed from ${programName}.`);
    // A row hidden by the In / Not-in filter, or a bulk button now disabled, cannot keep focus: move it to the filter
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) boundaryFilterRef.current?.focus();
    });
  };

  const handleRowBoundaryToggle = async (asset: EnclaveAsset, add: boolean) => {
    if (boundaryBlock !== null || busy) return;
    const plan = planBoundaryChange([asset], boundary.activeIds, add ? 'add' : 'remove', assets.length);
    if (plan.ids.length === 0) return;
    if (rowChangeNeedsConfirm(plan.direction, plan.membersBefore)) {
      setPendingBoundary(plan);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await applyBoundaryChange(plan);
      announceBoundaryChange(plan);
    } catch (err: unknown) {
      setActionError(boundaryErrorMessage(err));
    } finally {
      setBusy(false);
    }
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

    const matchesBoundary = matchesBoundaryFilter(a.id, boundaryFilter, boundary.activeIds);

    return matchesSearch && matchesCategory && matchesOs && matchesBoundary;
  });

  // The cards show the whole inventory, or the active program's SSP boundary under "In {program}" (D2: an undeclared program's boundary is the whole inventory)
  const cardAssets = useMemo(
    () => (boundaryFilter === 'IN' ? boundaryAssets(assets, [...boundary.activeIds], boundary.declared) : assets),
    [boundaryFilter, assets, boundary.activeIds, boundary.declared]
  );
  const cardSummary = useMemo(() => (cardAssets === assets ? summary : summarizeScope(cardAssets)), [cardAssets, assets, summary]);
  const totalCount = cardSummary.total;
  const scoredAssets = cardAssets.filter(a => a.complianceScore !== null);
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
      case 'AGENT_REPORT':
        return (
          <span className="badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-violet-500/15 text-violet-300 border border-violet-500/40">
            <Zap className="w-2.5 h-2.5 text-violet-400" />
            <span>AGENT REPORT</span>
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

  // The programs whose boundary declares this asset; archived ones are marked, the active program's chip is highlighted
  const renderProgramChips = (asset: EnclaveAsset) => {
    if (boundary.status === 'loading') return <span className="text-xs text-slate-400">Loading…</span>;
    if (boundary.status !== 'ready') return <span className="text-xs text-slate-400">—</span>;
    const labels = membershipLabels(asset.id, boundary.memberships, programs);
    if (labels.length === 0) return <span className="text-xs text-slate-400">No program</span>;
    const hidden = labels.slice(3);
    const hiddenText = hidden.map(l => `${l.name}${l.archived ? ' (archived)' : ''}`).join(', ');
    return (
      <ul className="flex flex-wrap gap-1" aria-label={`Programs that declare ${asset.hostName}`}>
        {labels.slice(0, 3).map(l => (
          <li key={l.id}>
            <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${
              l.archived ? 'bg-slate-900 text-slate-400 border-dashed border-slate-600'
              : l.id === activeProgram?.id ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
              : 'bg-slate-800 text-slate-300 border-slate-700'}`}>
              {l.archived && <Archive className="w-2.5 h-2.5" aria-hidden="true" />}
              <span className="truncate max-w-[9rem]" title={l.name}>{l.name}</span>
              {l.archived && <span>(archived)</span>}
            </span>
          </li>
        ))}
        {hidden.length > 0 && (
          <li>
            <span className="badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-slate-800 text-slate-400 border-slate-700" title={hiddenText}>
              +{hidden.length} more<span className="sr-only">: {hiddenText}</span>
            </span>
          </li>
        )}
      </ul>
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
            className="btn-accent px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse motion-reduce:animate-none" />
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
            className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Asset</span>
          </button>)}
        </div>
      </div>

      {/* Browser-only tenant: its assets live in this browser until it is moved to the server. The notice also stays to confirm the move. */}
      {canEdit && <LegacyTenantNotice tenant={currentTenant} variant="inline" />}

      {/* Assets that did not reach the server during that move: retry them here */}
      {canEdit && <FailedMoveAssetsNotice />}

      {!canEdit && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
          <Lock className="w-4 h-4 text-slate-400 shrink-0" />
          <span>Read-only: only a Tenant Owner or MSP Admin can change the asset inventory, the CMMC scoping{showBoundary ? ' and which assets a program declares' : ''}.</span>
        </div>
      )}

      <ErrorNotice message={actionError} />
      {loadError && (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={loadError} className="flex-1" />
          <button onClick={() => void reload()} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
        </div>
      )}

      {showBoundary && boundary.status === 'error' && (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message="The program boundaries could not be loaded, so membership is not shown and cannot be changed. The inventory itself is unaffected." className="flex-1" />
          <button type="button" onClick={() => void boundary.reload()} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
        </div>
      )}

      {boundaryReady && activeProgram && !boundary.declared && (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <strong className="text-amber-100">{activeProgram.name}</strong> has not declared its assets: its SSP boundary uses the whole inventory.
            {canEdit ? ' Tick "In this boundary" on the assets it covers, or filter the list and use "Add shown to boundary".' : ' A Tenant Owner or MSP Admin can declare them.'}
          </p>
        </div>
      )}

      {/* ─── Unconfirmed Discovered Asset High-Priority Banner ─── */}
      {unconfirmedAssets.length > 0 && (
        <button type="button" aria-pressed={selectedCategory === 'UNCONFIRMED'}
          onClick={() => setSelectedCategory(selectedCategory === 'UNCONFIRMED' ? 'ALL' : 'UNCONFIRMED')}
          className="w-full text-left rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-slate-900 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg shadow-amber-950/30 cursor-pointer hover:border-amber-400 transition-all animate-fadeIn"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-400 animate-pulse motion-reduce:animate-none" />
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

      <p role="status" className="sr-only">{notification ?? ''}</p>

      {showBoundary && <p className="text-xs text-slate-400" aria-live="polite">{summaryCaption({ filter: boundaryFilter, programName, declared: boundary.declared, members: boundary.activeIds.size, inventoryTotal: summary.total })}</p>}

      {/* ─── Summary Statistics Header: the boundary, by CMMC category ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">In-Scope Assets</span>
            <Server className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-white mt-1.5">{cardSummary.inScope}</p>
          <span className="text-xs text-slate-400">{totalCount} {boundaryFilter === 'IN' ? 'in this boundary' : 'registered'}{cardSummary.unconfirmed > 0 ? `, ${cardSummary.unconfirmed} unclassified` : ''}</span>
        </div>

        {CMMC_ASSET_CATEGORIES.filter(c => c !== 'OUT_OF_SCOPE').map(cat => {
          const style = CATEGORY_STYLE[cat];
          return (
            <div key={cat} className={`rounded-xl border p-4 ${style.card}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold ${style.text}`}>{CATEGORY_INFO[cat].label}</span>
                <style.Icon className={`w-4 h-4 shrink-0 ${style.icon}`} />
              </div>
              <p className={`text-2xl font-black mt-1.5 ${style.text}`}>{cardSummary.byCategory[cat]}</p>
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
      <div className="flex flex-col sm:flex-row sm:flex-wrap xl:flex-nowrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 w-full sm:min-w-[14rem]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            aria-label="Search assets"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by name, IP, MAC, owner, or notes..."
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>

        {/* Category Filter */}
        <div className="relative w-full sm:w-72">
          <select
            aria-label="CMMC category filter"
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
            aria-label="OS profile filter"
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

        {/* Boundary Filter: the active program's declared assets (server-backed tenants only) */}
        {showBoundary && (
          <div className="relative w-full sm:w-56">
            <select
              ref={boundaryFilterRef}
              aria-label="Boundary filter"
              value={boundaryFilter}
              disabled={!boundaryReady}
              onChange={e => setBoundaryFilter(e.target.value as BoundaryFilter)}
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-8 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="ALL">All assets (tenant inventory)</option>
              <option value="IN">{`In ${programName}`}</option>
              <option value="NOT_IN">{`Not in ${programName}`}</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        )}
      </div>

      {showBoundary && canEdit && (() => {
        const addPlan = planBoundaryChange(filteredAssets, boundary.activeIds, 'add', assets.length);
        const removePlan = planBoundaryChange(filteredAssets, boundary.activeIds, 'remove', assets.length);
        const blocked = boundaryBlock !== null || busy;
        return (
          <div role="group" aria-label={`Boundary of ${programName}`} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="flex-1 text-xs text-slate-300">
              {boundaryBlock
                ? <span id={boundaryReasonId}>{boundaryBlockMessage(boundaryBlock, programName)}</span>
                : <>Changes apply to <strong className="text-white">{programName}</strong> for everyone who works in it. "Shown" means the assets your filters list.</>}
            </p>
            <button type="button" onClick={() => setPendingBoundary(addPlan)} disabled={blocked || addPlan.ids.length === 0}
              aria-describedby={boundaryBlock ? boundaryReasonId : undefined}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30">
              <PlusCircle className="w-3.5 h-3.5" aria-hidden="true" />
              Add shown to boundary ({addPlan.ids.length})
            </button>
            <button type="button" onClick={() => setPendingBoundary(removePlan)} disabled={blocked || removePlan.ids.length === 0}
              aria-describedby={boundaryBlock ? boundaryReasonId : undefined}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700">
              <MinusCircle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              Remove shown from boundary ({removePlan.ids.length})
            </button>
          </div>
        );
      })()}

      {/* ─── Inventory Asset Table ─── */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
        <table aria-busy={busy || undefined} className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
              <th className="py-2.5 px-3">Endpoint / Hostname</th>
              <th className="py-2.5 px-3">IP Address</th>
              <th className="py-2.5 px-3">OS Platform</th>
              <th className="py-2.5 px-3">CMMC Scope Category</th>
              <th className="py-2.5 px-3">Last STIG Scan</th>
              <th className="py-2.5 px-3">Compliance Score</th>
              {showBoundary && <th className="py-2.5 px-3">Programs</th>}
              <th className="py-2.5 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading ? (
              <tr>
                <td colSpan={columnCount} className="py-8 text-center text-slate-400" role="status">
                  Loading the asset inventory…
                </td>
              </tr>
            ) : filteredAssets.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="py-8 text-center text-slate-400">
                  {emptyTableMessage({ assetCount: assets.length, filter: boundaryFilter, programName, declared: boundary.declared })}
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
                              <span className="badge px-1.5 py-0.5 rounded text-xs font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse motion-reduce:animate-none">
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

                    {/* Programs: the boundaries that declare this asset, and the toggle for the active program */}
                    {showBoundary && (
                      <td className="py-3 px-3 min-w-[11rem]">
                        <div className="space-y-1.5">
                          {canEdit && activeProgram && boundary.status === 'ready' && (
                            <label className={`inline-flex items-center gap-1.5 text-xs font-semibold ${boundaryBlock ? 'text-slate-400 cursor-not-allowed' : 'text-slate-200 cursor-pointer'}`}>
                              <input
                                type="checkbox"
                                checked={boundary.activeIds.has(asset.id)}
                                disabled={boundaryBlock !== null || !canEdit || Boolean(activeProgram?.archived)}
                                aria-describedby={boundaryBlock ? boundaryReasonId : undefined}
                                onChange={e => void handleRowBoundaryToggle(asset, e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
                              />
                              <span>In this boundary<span className="sr-only"> ({asset.hostName})</span></span>
                            </label>
                          )}
                          {renderProgramChips(asset)}
                        </div>
                      </td>
                    )}

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
                          className="btn-primary px-2 py-1 rounded-lg text-xs flex items-center gap-1"
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
                              className="btn-danger px-2 py-1 rounded-lg text-xs"
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
        <DialogOverlay onClose={() => setIsCsvModalOpen(false)} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div aria-hidden="true" className="absolute inset-0" onClick={() => setIsCsvModalOpen(false)} />

          <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
                <DialogTitle as="h3" className="text-base font-bold text-white">Bulk CSV Endpoint Onboarding</DialogTitle>
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
                  className="btn-primary px-4 py-2 rounded-xl text-xs"
                >
                  Import Endpoints
                </button>
              </div>
            </div>
          </div>
        </DialogOverlay>
      )}

      {/* ─── Boundary change confirmation (bulk, or a change that declares the first / removes the last asset) ─── */}
      {pendingBoundary && activeProgram && (
        <ConfirmBoundaryChangeDialog
          plan={pendingBoundary}
          programName={activeProgram.name}
          onConfirm={() => applyBoundaryChange(pendingBoundary)}
          onClose={() => setPendingBoundary(null)}
          onSaved={announceBoundaryChange}
        />
      )}

    </div>
  );
};
