import React, { useMemo, useState } from 'react';
import {
  Search,
  Filter,
  Shield,
  Layers,
  HelpCircle,
  LayoutGrid,
  List,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  ChevronRight,
  Paperclip,
  FileEdit,
  Radio,
} from 'lucide-react';
import { ControlStatus } from '../../types/cmmc';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';
import { ControlCard } from './ControlCard';

interface AssessmentMatrixProps {
  onSelectControl?: (controlId: string) => void;
}

export const AssessmentMatrix: React.FC<AssessmentMatrixProps> = ({ onSelectControl }) => {
  const {
    frameworkControls,
    state,
    metrics,
    selectedDomainFilter,
    setSelectedDomainFilter,
    selectedStatusFilter,
    setSelectedStatusFilter,
    searchQuery,
    setSearchQuery,
    setSelectedControlId,
  } = useAssessment();

  const {
    currentTenant,
    activeFramework,
    activeBaselineTier,
    activeOverlayFilters,
    toggleNonNetworkedOverlay,
  } = useTenant();

  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');

  const currentFrameworkDef = useMemo(() => {
    return FRAMEWORK_REGISTRY[activeFramework] || FRAMEWORK_REGISTRY.CMMC_L1;
  }, [activeFramework]);

  // Available domain families for the active framework
  const availableDomains = useMemo(() => {
    return Object.values(currentFrameworkDef.domains || {});
  }, [currentFrameworkDef]);

  // Filtered Controls
  const filteredControls = useMemo(() => {
    return frameworkControls.filter((ctrl) => {
      // Domain filter
      if (selectedDomainFilter !== 'ALL' && ctrl.domain !== selectedDomainFilter) {
        return false;
      }

      // Status filter
      const ctrlState = state.controls[ctrl.id];
      const status = ctrlState?.status || 'NOT_STARTED';
      if (selectedStatusFilter !== 'ALL' && status !== selectedStatusFilter) {
        return false;
      }

      // Search query
      if (searchQuery.trim() !== '') {
        const query = searchQuery.toLowerCase();
        const matchesId = ctrl.id.toLowerCase().includes(query);
        const matchesTitle = ctrl.title.toLowerCase().includes(query);
        const refText = (ctrl.authorityReference || (ctrl as any).farReference || '').toLowerCase();
        const matchesRef = refText.includes(query);
        const matchesSummary = (ctrl.plainEnglishSummary || '').toLowerCase().includes(query);
        const matchesNotes = (ctrlState?.implementationNotes || '').toLowerCase().includes(query);
        if (!matchesId && !matchesTitle && !matchesRef && !matchesSummary && !matchesNotes) {
          return false;
        }
      }

      return true;
    });
  }, [frameworkControls, selectedDomainFilter, selectedStatusFilter, searchQuery, state.controls]);

  const handleControlClick = (id: string) => {
    if (onSelectControl) {
      onSelectControl(id);
    } else {
      setSelectedControlId(id);
    }
  };

  // Subtitle progress posture
  const getPostureSubtitle = () => {
    switch (activeFramework) {
      case 'CMMC_L1':
        return 'Zero Allowable POA&Ms for CMMC Level 1 FCI Safeguards';
      case 'CMMC_L2':
        return '110 Requirements • Controlled Unclassified Information (CUI) • DoD SPRS Assessment';
      case 'NIST_800_53_REV5':
        return `NIST SP 800-53 Baseline: ${activeBaselineTier} • FedRAMP / FISMA Authorization`;
      case 'SOC_2_TYPE_II':
        return 'AICPA Trust Services Criteria (Security, Availability, Confidentiality) • Type II Attestation';
      case 'HIPAA_SECURITY':
        return 'HHS OCR 45 CFR Part 164 Subpart C • Administrative, Physical & Technical Safeguards';
      default:
        return 'Multi-Framework Baseline Posture';
    }
  };

  const totalControlsCount = frameworkControls.length;

  return (
    <div className="space-y-6 animate-fadeIn">
      
      {/* Top Header & Framework Target Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-cyan-950/60 text-cyan-300 border border-cyan-500/30 mb-1.5">
            <Sparkles className="w-3 h-3 text-cyan-400" />
            <span>{currentFrameworkDef.authority.toUpperCase()} COMPLIANCE MATRIX</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight flex items-center gap-2.5">
            <Shield className="w-7 h-7 text-cyan-400" />
            <span>{currentFrameworkDef.name}</span>
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-3xl">
            {currentFrameworkDef.description}
          </p>
        </div>

        {/* Status Pill & View Toggles */}
        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          <div className="text-xs text-slate-300 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-xl font-mono shadow-sm">
            Showing <strong className="text-cyan-300 font-bold">{filteredControls.length}</strong> of {totalControlsCount} controls
          </div>

          <div className="flex items-center p-1 bg-slate-900/80 border border-slate-800 rounded-xl">
            <button
              onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded-lg transition-colors ${
                viewMode === 'cards'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="Expanded Cards View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-lg transition-colors ${
                viewMode === 'table'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="Compact Table Matrix"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Tactical Non-Networked Overlay Indicator Banner */}
      {activeOverlayFilters.nonNetworkedOnly && (
        <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between gap-4 text-xs text-amber-300 animate-fadeIn">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
              <Radio className="w-4 h-4 text-amber-400 animate-pulse" />
            </div>
            <div>
              <p className="font-bold text-white flex items-center gap-2">
                <span>Tactical Non-Networked / Air-Gapped Overlay Active</span>
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">Filtered</span>
              </p>
              <p className="text-[11px] text-amber-200/80 mt-0.5">
                Boundary- and network-dependent controls (e.g. SC-7, SC-8, AC-17, AC-18) are excluded from active audit scope for standalone tactical enclaves.
              </p>
            </div>
          </div>
          <button
            onClick={toggleNonNetworkedOverlay}
            className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 font-semibold text-[11px] transition-colors shrink-0"
          >
            Reset Overlay
          </button>
        </div>
      )}

      {/* Progress & Baseline Mini-Bar */}
      <div className="stitch-card p-4 space-y-2">
        <div className="flex items-center justify-between text-xs font-medium">
          <span className="text-slate-400">
            Enclave Progress: <strong className="text-white">{currentTenant.name}</strong> • <span className="text-brand-300">{currentFrameworkDef.shortName}</span>
          </span>
          <span className="font-mono text-cyan-300 font-bold">
            {metrics.metCount} / {totalControlsCount} Controls Met ({metrics.completionPercentage}%)
          </span>
        </div>

        <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden flex shadow-inner border border-slate-800">
          <div
            className="bg-emerald-500 transition-all duration-500"
            style={{ width: `${totalControlsCount > 0 ? (metrics.metCount / totalControlsCount) * 100 : 0}%` }}
            title={`${metrics.metCount} Met`}
          />
          <div
            className="bg-amber-500 transition-all duration-500"
            style={{ width: `${totalControlsCount > 0 ? (metrics.inProgressCount / totalControlsCount) * 100 : 0}%` }}
            title={`${metrics.inProgressCount} In Progress`}
          />
          <div
            className="bg-rose-500 transition-all duration-500"
            style={{ width: `${totalControlsCount > 0 ? (metrics.notMetCount / totalControlsCount) * 100 : 0}%` }}
            title={`${metrics.notMetCount} Not Met`}
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Met ({metrics.metCount})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> In Progress ({metrics.inProgressCount})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-600" /> Not Started ({metrics.notStartedCount})
            </span>
            {metrics.notMetCount > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500" /> Not Met ({metrics.notMetCount})
              </span>
            )}
          </div>
          <span className="font-mono text-slate-400">
            {getPostureSubtitle()}
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="stitch-card p-4 sm:p-5 space-y-4">
        {/* Search Input */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${currentFrameworkDef.shortName} by control ID (e.g. ${frameworkControls[0]?.id || 'AC-2'}), title, authority reference, or keywords...`}
            className="w-full pl-10 pr-16 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-none text-xs sm:text-sm text-white placeholder-slate-500 transition-all duration-200"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Filter Chips: Domain & Status */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 pt-3 border-t border-slate-800/80">
          
          {/* Domain / Family Selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 mr-1 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-cyan-400" /> Family/Domain:
            </span>
            <button
              onClick={() => setSelectedDomainFilter('ALL')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                selectedDomainFilter === 'ALL'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                  : 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              All ({totalControlsCount})
            </button>
            {availableDomains.map((domain) => {
              const isSelected = selectedDomainFilter === domain.code;
              const count = frameworkControls.filter((c) => c.domain === domain.code).length;
              if (count === 0 && !isSelected) return null;
              return (
                <button
                  key={domain.code}
                  onClick={() => setSelectedDomainFilter(domain.code)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    isSelected
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
                  }`}
                >
                  {domain.code} ({count})
                </button>
              );
            })}
          </div>

          {/* Status Selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 mr-1 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5 text-cyan-400" /> Status:
            </span>
            {(
              [
                { id: 'ALL', label: 'All' },
                { id: 'MET', label: 'Met' },
                { id: 'IN_PROGRESS', label: 'In Progress' },
                { id: 'NOT_STARTED', label: 'Not Started' },
                { id: 'NOT_MET', label: 'Not Met' },
              ] as { id: ControlStatus | 'ALL'; label: string }[]
            ).map((item) => {
              const isSelected = selectedStatusFilter === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedStatusFilter(item.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    isSelected
                      ? 'bg-slate-200 text-slate-900 font-bold shadow-sm'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

        </div>
      </div>

      {/* Controls Display: Cards View vs Table View */}
      {filteredControls.length === 0 ? (
        <div className="stitch-card text-center py-16 p-8 space-y-3">
          <HelpCircle className="w-10 h-10 text-slate-500 mx-auto" />
          <h3 className="text-base font-bold text-white">No controls match your filter criteria</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Try clearing your search query or switching family and status filters.
          </p>
          <button
            onClick={() => {
              setSelectedDomainFilter('ALL');
              setSelectedStatusFilter('ALL');
              setSearchQuery('');
            }}
            className="btn-secondary text-xs px-3.5 py-2 mt-2"
          >
            Reset Filters
          </button>
        </div>
      ) : viewMode === 'cards' ? (
        /* Cards View using ControlCard component */
        <div className="grid grid-cols-1 gap-4">
          {filteredControls.map((ctrl) => {
            const domainInfo = currentFrameworkDef.domains[ctrl.domain] || {
              code: ctrl.domain,
              name: ctrl.domainName || ctrl.domain,
              description: '',
              totalControls: 0,
              iconName: 'Shield',
              color: '#06b6d4',
            };
            return (
              <ControlCard
                key={ctrl.id}
                control={ctrl}
                domainInfo={domainInfo}
                onOpenDetailModal={() => handleControlClick(ctrl.id)}
              />
            );
          })}
        </div>
      ) : (
        /* High-Density Matrix Table View */
        <div className="overflow-x-auto rounded-xl border border-slate-800 stitch-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-mono font-semibold text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3.5 px-4">Control ID</th>
                <th className="py-3.5 px-4">Title & Authority Reference</th>
                <th className="py-3.5 px-4">Family / Domain</th>
                <th className="py-3.5 px-4">Audit Status</th>
                <th className="py-3.5 px-4">Equivalencies</th>
                <th className="py-3.5 px-4">Evidence</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {filteredControls.map((ctrl) => {
                const ctrlState = state.controls[ctrl.id];
                const status = ctrlState?.status || 'NOT_STARTED';
                const domainInfo = currentFrameworkDef.domains[ctrl.domain] || {
                  code: ctrl.domain,
                  name: ctrl.domainName || ctrl.domain,
                  color: '#06b6d4',
                };
                const evidenceList = state.evidenceIndex.filter((e) => e.controlId === ctrl.id);
                const evidenceCount = evidenceList.length;
                const hasInheritedEvidence = evidenceList.some(
                  (e) => (e.syncStatus as any) === 'inherited' || (e.description && e.description.startsWith('[Inherited'))
                );
                const hasNotes = Boolean(ctrlState?.implementationNotes && ctrlState.implementationNotes.trim().length > 0);
                const authorityRef = ctrl.authorityReference || (ctrl as any).farReference || 'Baseline';
                const mappings = ctrl.mappings || [];

                return (
                  <tr
                    key={ctrl.id}
                    className="hover:bg-slate-800/50 transition-colors even:bg-slate-950/30 odd:bg-transparent"
                  >
                    {/* Control ID in Bold Monospace */}
                    <td className="py-3 px-4">
                      <span className="font-mono font-bold text-xs px-2.5 py-1 rounded bg-cyan-950/50 text-cyan-300 border border-cyan-500/30">
                        {ctrl.id}
                      </span>
                    </td>

                    {/* Title & Authority Reference */}
                    <td className="py-3 px-4 max-w-sm">
                      <div 
                        onClick={() => handleControlClick(ctrl.id)}
                        className="font-bold text-white hover:text-cyan-300 cursor-pointer transition-colors truncate"
                      >
                        {ctrl.title}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                        {authorityRef}
                      </div>
                    </td>

                    {/* Domain */}
                    <td className="py-3 px-4">
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded"
                        style={{
                          backgroundColor: `${domainInfo.color}15`,
                          color: domainInfo.color,
                          border: `1px solid ${domainInfo.color}30`,
                        }}
                      >
                        {domainInfo.name}
                      </span>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3 px-4">
                      {status === 'MET' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" /> MET
                        </span>
                      ) : status === 'NOT_MET' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-rose-500/15 text-rose-300 border border-rose-500/30">
                          <AlertTriangle className="w-3 h-3 text-rose-400" /> NOT_MET
                        </span>
                      ) : status === 'IN_PROGRESS' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          <Clock className="w-3 h-3 text-amber-400" /> IN_PROGRESS
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-slate-800 text-slate-400 border border-slate-700">
                          <HelpCircle className="w-3 h-3 text-slate-400" /> NOT_STARTED
                        </span>
                      )}
                    </td>

                    {/* Cross-Framework Mappings */}
                    <td className="py-3 px-4">
                      {mappings.length > 0 ? (
                        <div className="flex items-center gap-1 flex-wrap max-w-[180px]">
                          {mappings.slice(0, 2).map((m, idx) => (
                            <span
                              key={idx}
                              title={`${m.targetFramework}: ${m.targetTitle || m.targetControlId}`}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-500/30"
                            >
                              {m.targetControlId}
                            </span>
                          ))}
                          {mappings.length > 2 && (
                            <span className="text-[10px] text-slate-500 font-mono">+{mappings.length - 2}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-600 font-mono">—</span>
                      )}
                    </td>

                    {/* Evidence & Narrative */}
                    <td className="py-3 px-4 text-[11px]">
                      <div className="flex items-center gap-2 text-slate-400">
                        <span className={`flex items-center gap-1 ${hasNotes ? 'text-emerald-400' : 'text-slate-500'}`}>
                          <FileEdit className="w-3 h-3" />
                          {hasNotes ? 'Drafted' : 'None'}
                        </span>
                        <span>•</span>
                        <span className={`flex items-center gap-1 ${evidenceCount > 0 ? 'text-cyan-400' : 'text-slate-500'}`}>
                          <Paperclip className="w-3 h-3" />
                          {evidenceCount}
                          {hasInheritedEvidence && (
                            <span className="text-[9px] font-mono text-amber-300 bg-amber-500/20 border border-amber-500/30 px-1 rounded ml-1">
                              Inherited
                            </span>
                          )}
                        </span>
                      </div>
                    </td>

                    {/* Action */}
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleControlClick(ctrl.id)}
                        className="btn-primary text-xs px-2.5 py-1"
                      >
                        <span>Document</span>
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
};

export default AssessmentMatrix;
