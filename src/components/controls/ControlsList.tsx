import React, { useMemo } from 'react';
import {
  Search,
  Filter,
  Paperclip,
  ChevronRight,
  FileEdit,
  Shield,
  Layers,
  HelpCircle,
} from 'lucide-react';
import { CMMC_LEVEL_1_CONTROLS, DOMAINS } from '../../data/cmmcLevel1Controls';
import { ControlStatus, DomainCode } from '../../types/cmmc';
import { useAssessment } from '../../context/AssessmentContext';

export const ControlsList: React.FC = () => {
  const {
    state,
    selectedDomainFilter,
    setSelectedDomainFilter,
    selectedStatusFilter,
    setSelectedStatusFilter,
    searchQuery,
    setSearchQuery,
    setSelectedControlId,
    updateControlStatus,
  } = useAssessment();

  // Filtered Controls
  const filteredControls = useMemo(() => {
    return CMMC_LEVEL_1_CONTROLS.filter((ctrl) => {
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
        const matchesFar = ctrl.farReference.toLowerCase().includes(query);
        const matchesSummary = ctrl.plainEnglishSummary.toLowerCase().includes(query);
        const matchesNotes = (ctrlState?.implementationNotes || '').toLowerCase().includes(query);
        if (!matchesId && !matchesTitle && !matchesFar && !matchesSummary && !matchesNotes) {
          return false;
        }
      }

      return true;
    });
  }, [selectedDomainFilter, selectedStatusFilter, searchQuery, state.controls]);

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Controls Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Shield className="w-6 h-6 text-brand-400" />
            CMMC Level 1 Controls Matrix
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Evaluate, document, and attach audit evidence for all 17 FAR 52.204-21 compliance practices.
          </p>
        </div>
        <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl self-start sm:self-auto">
          Showing <span className="font-bold text-white font-mono">{filteredControls.length}</span> of 17 controls
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-4 shadow-lg">
        {/* Search Input */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by control ID, title, FAR reference, or keywords..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 focus:border-brand-500 focus:outline-none text-sm text-white placeholder-slate-500 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white"
            >
              Clear
            </button>
          )}
        </div>

        {/* Filter Chips: Domain & Status */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 pt-2 border-t border-slate-800/80">
          
          {/* Domain Selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 mr-1 flex items-center gap-1">
              <Layers className="w-3 h-3" /> Domain:
            </span>
            <button
              onClick={() => setSelectedDomainFilter('ALL')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                selectedDomainFilter === 'ALL'
                  ? 'bg-brand-600 text-white shadow-sm shadow-brand-500/20'
                  : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              All (17)
            </button>
            {(Object.keys(DOMAINS) as DomainCode[]).map((code) => {
              const d = DOMAINS[code];
              const isSelected = selectedDomainFilter === code;
              return (
                <button
                  key={code}
                  onClick={() => setSelectedDomainFilter(code)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    isSelected
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {code} ({d.totalControls})
                </button>
              );
            })}
          </div>

          {/* Status Selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 mr-1 flex items-center gap-1">
              <Filter className="w-3 h-3" /> Status:
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
                      ? 'bg-slate-200 text-slate-900 font-bold'
                      : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

        </div>
      </div>

      {/* Controls Grid */}
      {filteredControls.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/40 border border-slate-800/80 rounded-2xl p-8 space-y-3">
          <HelpCircle className="w-10 h-10 text-slate-500 mx-auto" />
          <h3 className="text-base font-bold text-white">No controls match your filter criteria</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Try adjusting your search query, domain selection, or status filters above.
          </p>
          <button
            onClick={() => {
              setSelectedDomainFilter('ALL');
              setSelectedStatusFilter('ALL');
              setSearchQuery('');
            }}
            className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5">
          {filteredControls.map((ctrl) => {
            const ctrlState = state.controls[ctrl.id];
            const status = ctrlState?.status || 'NOT_STARTED';
            const evidenceCount = state.evidenceIndex.filter((e) => e.controlId === ctrl.id).length;
            const hasNotes = Boolean(ctrlState?.implementationNotes && ctrlState.implementationNotes.trim().length > 0);
            const domainInfo = DOMAINS[ctrl.domain];

            return (
              <div
                key={ctrl.id}
                className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800/90 hover:border-slate-700 rounded-2xl p-4 sm:p-5 transition-all shadow-md hover:shadow-lg flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 group"
              >
                {/* Left Info */}
                <div className="space-y-2 max-w-3xl">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {/* Control ID */}
                    <span className="font-mono font-bold text-sm px-2.5 py-0.5 rounded-lg bg-brand-500/15 text-brand-300 border border-brand-500/30">
                      {ctrl.id}
                    </span>

                    {/* Domain Tag */}
                    <span
                      className="text-xs font-semibold px-2.5 py-0.5 rounded-md"
                      style={{
                        backgroundColor: `${domainInfo.color}15`,
                        color: domainInfo.color,
                        border: `1px solid ${domainInfo.color}30`,
                      }}
                    >
                      {domainInfo.name}
                    </span>

                    {/* FAR Reference */}
                    <span className="text-[11px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700">
                      {ctrl.farReference}
                    </span>
                  </div>

                  {/* Title & Plain English */}
                  <div>
                    <h3 className="text-base font-bold text-white group-hover:text-brand-300 transition-colors">
                      {ctrl.title}
                    </h3>
                    <p className="text-xs text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                      {ctrl.plainEnglishSummary}
                    </p>
                  </div>

                  {/* Metadata Row: Evidence & Notes Status */}
                  <div className="flex items-center gap-4 text-xs pt-1">
                    <span className={`flex items-center gap-1.5 font-medium ${
                      hasNotes ? 'text-emerald-400' : 'text-slate-500'
                    }`}>
                      <FileEdit className="w-3.5 h-3.5" />
                      {hasNotes ? 'Documented' : 'No narrative yet'}
                    </span>

                    <span className={`flex items-center gap-1.5 font-medium ${
                      evidenceCount > 0 ? 'text-brand-400' : 'text-slate-500'
                    }`}>
                      <Paperclip className="w-3.5 h-3.5" />
                      {evidenceCount} {evidenceCount === 1 ? 'Evidence File' : 'Evidence Files'}
                    </span>
                  </div>
                </div>

                {/* Right Actions: Quick Status Switcher & Inspect Button */}
                <div className="flex items-center gap-3 w-full lg:w-auto justify-between lg:justify-end pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-800/80 shrink-0">
                  
                  {/* Status Dropdown */}
                  <div className="relative">
                    <select
                      value={status}
                      onChange={(e) => updateControlStatus(ctrl.id, e.target.value as ControlStatus)}
                      className={`text-xs font-semibold rounded-xl px-3 py-2 border appearance-none pr-8 cursor-pointer focus:outline-none transition-colors ${
                        status === 'MET'
                          ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40'
                          : status === 'IN_PROGRESS'
                          ? 'bg-amber-950/60 text-amber-300 border-amber-500/40'
                          : status === 'NOT_MET'
                          ? 'bg-rose-950/60 text-rose-300 border-rose-500/40'
                          : 'bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                    >
                      <option value="NOT_STARTED" className="bg-slate-900 text-slate-300">Not Started</option>
                      <option value="IN_PROGRESS" className="bg-slate-900 text-amber-400">In Progress</option>
                      <option value="MET" className="bg-slate-900 text-emerald-400">Met (Compliant)</option>
                      <option value="NOT_MET" className="bg-slate-900 text-rose-400">Not Met</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                      <ChevronRight className="w-3 h-3 rotate-90" />
                    </div>
                  </div>

                  {/* Inspect & Edit Modal Trigger */}
                  <button
                    onClick={() => setSelectedControlId(ctrl.id)}
                    className="px-3.5 py-2 rounded-xl bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white border border-brand-500/30 hover:border-brand-500 font-semibold text-xs transition-all flex items-center gap-1.5"
                  >
                    <span>Inspect & Document</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>

                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
