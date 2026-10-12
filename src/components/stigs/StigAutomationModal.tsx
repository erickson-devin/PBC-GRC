import React, { useState, useMemo } from 'react';
import {
  X,
  Terminal,
  FileCode,
  Download,
  Check,
  Copy,
  Sparkles,
  Search,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  BookOpen,
  Filter,
  Server,
  Cloud,
  Cpu,
  Radio,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import {
  getAllStigProfiles,
  getStigProfile,
} from '../../data/stigs/stigCatalog';
import {
  generateAnsiblePlaybook,
  generatePowerShellDscScript,
  generateDisaStigChecklistXml,
  downloadFile,
} from '../../data/stigs/scriptGenerators';
import { StigProfileId, StigSeverity, StigRule } from '../../types/stig';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface StigAutomationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const StigAutomationModal: React.FC<StigAutomationModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { currentTenant, canEdit, activeFramework } = useTenant();
  const { state, frameworkControls, bulkApplyStigNarratives } = useAssessment();

  const profiles = useMemo(() => getAllStigProfiles(), []);
  const [selectedProfileId, setSelectedProfileId] = useState<StigProfileId>('WIN11_SERVER2022_STIG');
  const [severityFilter, setSeverityFilter] = useState<StigSeverity | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyMappedToActive, setOnlyMappedToActive] = useState(false);
  const [expandedRuleIds, setExpandedRuleIds] = useState<Record<string, boolean>>({});
  const [copiedSnippetId, setCopiedSnippetId] = useState<string | null>(null);
  const [activeSnippetTab, setActiveSnippetTab] = useState<Record<string, 'powershell' | 'bash' | 'ansible'>>({});
  const [notification, setNotification] = useState<string | null>(null);
  const [isConfirmingNarrativeFill, setIsConfirmingNarrativeFill] = useState(false);

  const selectedProfile = useMemo(() => {
    return getStigProfile(selectedProfileId) || profiles[0];
  }, [selectedProfileId, profiles]);

  // Set of active framework control IDs
  const activeFrameworkControlIdSet = useMemo(() => {
    return new Set(frameworkControls.map(c => c.id.toUpperCase()));
  }, [frameworkControls]);

  // Filter rules for current selected profile
  const filteredRules = useMemo(() => {
    return selectedProfile.rules.filter(rule => {
      // Severity filter
      if (severityFilter !== 'ALL' && rule.severity !== severityFilter) {
        return false;
      }

      // Filter by active framework mapping
      if (onlyMappedToActive) {
        const hasMatch = rule.mappedControlIds.some(cId =>
          activeFrameworkControlIdSet.has(cId.toUpperCase())
        );
        if (!hasMatch) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesQuery =
          rule.vulnId.toLowerCase().includes(q) ||
          rule.ruleVersion.toLowerCase().includes(q) ||
          rule.title.toLowerCase().includes(q) ||
          rule.discussion.toLowerCase().includes(q) ||
          rule.mappedControlIds.some(m => m.toLowerCase().includes(q));
        if (!matchesQuery) return false;
      }

      return true;
    });
  }, [selectedProfile, severityFilter, onlyMappedToActive, searchQuery, activeFrameworkControlIdSet]);

  // Severity counts for current profile
  const severityCounts = useMemo(() => {
    const counts = { CAT_I: 0, CAT_II: 0, CAT_III: 0, total: selectedProfile.rules.length };
    selectedProfile.rules.forEach(r => {
      if (r.severity in counts) {
        counts[r.severity]++;
      }
    });
    return counts;
  }, [selectedProfile]);

  // Mapping count for active framework
  const mappedToActiveCount = useMemo(() => {
    return selectedProfile.rules.filter(rule =>
      rule.mappedControlIds.some(cId => activeFrameworkControlIdSet.has(cId.toUpperCase()))
    ).length;
  }, [selectedProfile, activeFrameworkControlIdSet]);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3500);
  };

  const toggleExpandRule = (ruleId: string) => {
    setExpandedRuleIds(prev => ({ ...prev, [ruleId]: !prev[ruleId] }));
  };

  const handleCopySnippet = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSnippetId(id);
      setTimeout(() => setCopiedSnippetId(null), 2000);
    } catch {
      // Fallback
    }
  };

  // Export Playbook (.yml)
  const handleExportAnsible = () => {
    const yml = generateAnsiblePlaybook(selectedProfile, filteredRules, state.sspMetadata);
    const filename = `${selectedProfile.id.toLowerCase()}_hardening_playbook.yml`;
    downloadFile(filename, yml, 'text/yaml;charset=utf-8');
    showNotification(`Exported Ansible Playbook: ${filename}`);
  };

  // Export PowerShell (.ps1)
  const handleExportPowerShell = () => {
    const ps1 = generatePowerShellDscScript(selectedProfile, filteredRules, state.sspMetadata);
    const filename = `${selectedProfile.id.toLowerCase()}_hardening.ps1`;
    downloadFile(filename, ps1, 'application/x-powershell;charset=utf-8');
    showNotification(`Exported PowerShell DSC Script: ${filename}`);
  };

  // Export DISA Checklist (.ckl)
  const handleExportCkl = () => {
    const xml = generateDisaStigChecklistXml(
      selectedProfile,
      filteredRules,
      state.sspMetadata,
      state.controls
    );
    const filename = `${selectedProfile.id}_Checklist.ckl`;
    downloadFile(filename, xml, 'application/xml;charset=utf-8');
    showNotification(`Exported DISA STIG Checklist: ${filename}`);
  };

  // Apply Single Rule Narrative
  const handleApplySingleNarrative = (rule: StigRule) => {
    if (!canEdit) {
      alert('Read-only access: You do not have permission to modify controls.');
      return;
    }

    const narrativeMap: Record<string, string> = {};
    rule.mappedControlIds.forEach(cId => {
      // If control exists in framework or state
      narrativeMap[cId] = `[${rule.vulnId} / ${rule.ruleVersion}] ${rule.policyNarrative}`;
    });

    const count = bulkApplyStigNarratives(narrativeMap);
    showNotification(`Applied STIG narrative [${rule.vulnId}] to ${count} mapped control(s)!`);
  };

  // Bulk Apply All Mapped Narratives
  const handleBulkApplyNarratives = () => {
    if (!canEdit) {
      alert('Read-only access: You do not have permission to modify controls.');
      return;
    }

    const narrativeMap: Record<string, string> = {};
    // Iterate through all rules in current profile
    selectedProfile.rules.forEach(rule => {
      rule.mappedControlIds.forEach(cId => {
        // Check if control is in current active framework
        if (activeFrameworkControlIdSet.has(cId.toUpperCase())) {
          if (!narrativeMap[cId]) {
            narrativeMap[cId] = `[DISA STIG Hardening - ${rule.vulnId} / ${rule.ruleVersion}]:\n${rule.policyNarrative}`;
          } else {
            narrativeMap[cId] += `\n\n[STIG Hardening - ${rule.vulnId}]:\n${rule.policyNarrative}`;
          }
        }
      });
    });

    const count = bulkApplyStigNarratives(narrativeMap);
    setIsConfirmingNarrativeFill(false);
    showNotification(`Successfully auto-populated official policy narratives across ${count} active control(s)!`);
  };

  if (!isOpen) return null;

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn">
      {/* Outer Glow Double-Bezel Card */}
      <div className="w-full max-w-6xl p-1 rounded-3xl bg-gradient-to-b from-cyan-500/30 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
        <div className="p-5 sm:p-7 rounded-[calc(1.5rem-0.125rem)] bg-slate-950/95 border border-slate-800/90 flex flex-col max-h-[calc(94vh-0.5rem)] overflow-hidden space-y-5">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 via-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
                <Terminal className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="badge text-xs uppercase font-mono tracking-widest font-extrabold px-2 py-0.5 rounded-full bg-cyan-950/70 text-cyan-300 border border-cyan-500/40">
                    DISA STIG & CIS BENCHMARK SUITE
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    Enclave: {currentTenant.name} ({currentTenant.cageCode || 'CAGE PENDING'})
                  </span>
                </div>
                <DialogTitle as="h2" className="text-lg sm:text-xl font-extrabold text-white tracking-tight mt-0.5 flex items-center gap-2">
                  Technical Hardening Baselines & Script Export
                </DialogTitle>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all duration-200"
                title="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Toast Notification */}
          {notification && (
            <div className="p-3 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center gap-2 animate-fadeIn shrink-0">
              <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{notification}</span>
            </div>
          )}

          {/* Profile Navigation Strip */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 shrink-0 border-b border-slate-800/60">
            {profiles.map(p => {
              const isSelected = p.id === selectedProfileId;
              let Icon = Server;
              if (p.category === 'cloud') Icon = Cloud;
              if (p.category === 'tactical') Icon = Radio;
              if (p.category === 'infrastructure') Icon = Cpu;

              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedProfileId(p.id);
                    setSeverityFilter('ALL');
                    setSearchQuery('');
                  }}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all duration-200 shrink-0 ${
                    isSelected
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 shadow-md shadow-cyan-950/40 font-bold'
                      : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 hover:bg-slate-850 border border-slate-800/70'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-cyan-400' : 'text-slate-400'}`} />
                  <span>{p.shortName}</span>
                  {p.isTacticalOverlay && (
                    <span className="badge text-xs uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      Air-Gapped
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Profile Meta & Global Actions Banner */}
          <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shrink-0">
            <div className="space-y-1 max-w-2xl">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  {selectedProfile.title}
                </h3>
                <span className="badge text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {selectedProfile.version}
                </span>
                <span className="badge text-xs font-semibold px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  {selectedProfile.authority}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                {selectedProfile.description}
              </p>
              <div className="flex items-center gap-3 pt-1 text-xs text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                  CAT I: <strong className="text-slate-200">{severityCounts.CAT_I}</strong>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                  CAT II: <strong className="text-slate-200">{severityCounts.CAT_II}</strong>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                  CAT III: <strong className="text-slate-200">{severityCounts.CAT_III}</strong>
                </span>
                <span className="text-slate-400">|</span>
                <span className="text-cyan-400">
                  <strong>{mappedToActiveCount}</strong> rules mapped to active framework
                </span>
              </div>
            </div>

            {/* Global Actions */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <button
                onClick={() => setIsConfirmingNarrativeFill(true)}
                className="btn-primary flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs hover:scale-[1.02]"
                title="Populate compliant policy narratives into mapped controls"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Auto-Fill Policy Narratives</span>
              </button>

              <div className="h-6 w-px bg-slate-800 hidden sm:block" />

              <button
                onClick={handleExportAnsible}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-850 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-colors"
                title="Export Ansible Playbook (.yml)"
              >
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                <span>Ansible (.yml)</span>
              </button>

              <button
                onClick={handleExportPowerShell}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-850 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-colors"
                title="Export PowerShell DSC Script (.ps1)"
              >
                <Terminal className="w-3.5 h-3.5 text-blue-400" />
                <span>PowerShell (.ps1)</span>
              </button>

              <button
                onClick={handleExportCkl}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-850 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-colors"
                title="Export DISA STIG Checklist (.ckl XML)"
              >
                <Download className="w-3.5 h-3.5 text-emerald-400" />
                <span>DISA Checklist (.ckl)</span>
              </button>
            </div>
          </div>

          {/* Filter & Search Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search rule ID, title, V-ID, or mapped control..."
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-white placeholder-slate-400 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
              />
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <div className="flex items-center bg-slate-900 rounded-xl p-1 border border-slate-800">
                {(['ALL', 'CAT_I', 'CAT_II', 'CAT_III'] as const).map(sev => {
                  const isSelected = severityFilter === sev;
                  const label =
                    sev === 'ALL'
                      ? 'All Severities'
                      : sev === 'CAT_I'
                      ? 'CAT I (High)'
                      : sev === 'CAT_II'
                      ? 'CAT II (Medium)'
                      : 'CAT III (Low)';
                  return (
                    <button
                      key={sev}
                      onClick={() => setSeverityFilter(sev)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        isSelected
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setOnlyMappedToActive(prev => !prev)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
                  onlyMappedToActive
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                <span>Mapped to Active Framework Only</span>
              </button>
            </div>
          </div>

          {/* Rules List (Scrollable) */}
          <div className="overflow-y-auto flex-1 space-y-3 pr-1">
            {filteredRules.length === 0 ? (
              <div className="p-8 text-center rounded-2xl bg-slate-900/50 border border-slate-800 space-y-2">
                <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
                <p className="text-sm font-semibold text-white">No STIG benchmark rules found</p>
                <p className="text-xs text-slate-400">
                  Try adjusting your search query, clearing severity filters, or toggling framework mapping.
                </p>
              </div>
            ) : (
              filteredRules.map(rule => {
                const isExpanded = expandedRuleIds[rule.id] ?? false;
                const snippetTab = activeSnippetTab[rule.id] || (rule.powershellSnippet ? 'powershell' : rule.bashSnippet ? 'bash' : 'ansible');
                
                let sevBadge = (
                  <span className="badge text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40">
                    CAT III
                  </span>
                );
                if (rule.severity === 'CAT_I') {
                  sevBadge = (
                    <span className="badge text-xs font-mono font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">
                      CAT I (CRITICAL)
                    </span>
                  );
                } else if (rule.severity === 'CAT_II') {
                  sevBadge = (
                    <span className="badge text-xs font-mono font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      CAT II (MEDIUM)
                    </span>
                  );
                }

                return (
                  <div
                    key={rule.id}
                    className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 hover:border-slate-700 transition-all space-y-3"
                  >
                    {/* Rule Summary Line */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono font-bold text-cyan-400">
                            {rule.vulnId}
                          </span>
                          <span className="text-xs font-mono text-slate-400">
                            {rule.ruleVersion}
                          </span>
                          {sevBadge}
                          <span className="text-slate-400 text-xs">•</span>
                          <span className="text-xs font-mono text-slate-400">
                            {rule.id}
                          </span>
                        </div>
                        <h4 className="text-sm font-bold text-white leading-snug">
                          {rule.title}
                        </h4>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleApplySingleNarrative(rule)}
                          className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center gap-1 transition-colors"
                          title="Apply narrative to mapped controls"
                        >
                          <Sparkles className="w-3 h-3" />
                          <span className="hidden sm:inline">Apply Narrative</span>
                        </button>
                        <button
                          onClick={() => toggleExpandRule(rule.id)}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Mapped Framework Control Badges */}
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                      <span className="text-xs uppercase font-semibold tracking-wider text-slate-400 mr-1">
                        Controls:
                      </span>
                      {rule.mappedControlIds.map(cId => {
                        const isCurrentActive = activeFrameworkControlIdSet.has(cId.toUpperCase());
                        return (
                          <span
                            key={cId}
                            className={`badge text-xs font-mono px-2 py-0.5 rounded-md ${
                              isCurrentActive
                                ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 font-bold'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            }`}
                          >
                            {cId}
                          </span>
                        );
                      })}
                    </div>

                    {/* Expandable Section: Details, Check, Fix, Snippets */}
                    {isExpanded && (
                      <div className="space-y-3 pt-3 border-t border-slate-800/80 animate-fadeIn text-xs">
                        {/* Discussion */}
                        <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 space-y-1">
                          <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5 text-cyan-400" />
                            Vulnerability Discussion
                          </span>
                          <p className="text-slate-400 leading-relaxed text-xs">
                            {rule.discussion}
                          </p>
                        </div>

                        {/* Check & Fix Text Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 space-y-1">
                            <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                              <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                              Check Content (Audit Instruction)
                            </span>
                            <p className="text-slate-400 leading-relaxed text-xs font-mono whitespace-pre-wrap">
                              {rule.checkText}
                            </p>
                          </div>

                          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 space-y-1">
                            <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              Fix Text (Remediation)
                            </span>
                            <p className="text-slate-400 leading-relaxed text-xs font-mono whitespace-pre-wrap">
                              {rule.fixText}
                            </p>
                          </div>
                        </div>

                        {/* Policy Narrative Box */}
                        <div className="p-3 rounded-xl bg-indigo-950/30 border border-indigo-500/30 space-y-1">
                          <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                            Pre-Formulated Policy Implementation Narrative
                          </span>
                          <p className="text-slate-300 leading-relaxed text-xs italic">
                            "{rule.policyNarrative}"
                          </p>
                        </div>

                        {/* Automated Hardening Script Tabs */}
                        {(rule.powershellSnippet || rule.bashSnippet || rule.ansibleTaskSnippet) && (
                          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1 bg-slate-900 rounded-lg p-0.5 border border-slate-800">
                                {rule.powershellSnippet && (
                                  <button
                                    onClick={() => setActiveSnippetTab(prev => ({ ...prev, [rule.id]: 'powershell' }))}
                                    className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                                      snippetTab === 'powershell'
                                        ? 'bg-blue-600 text-white'
                                        : 'text-slate-400 hover:text-white'
                                    }`}
                                  >
                                    PowerShell
                                  </button>
                                )}
                                {rule.bashSnippet && (
                                  <button
                                    onClick={() => setActiveSnippetTab(prev => ({ ...prev, [rule.id]: 'bash' }))}
                                    className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                                      snippetTab === 'bash'
                                        ? 'bg-emerald-600 text-white'
                                        : 'text-slate-400 hover:text-white'
                                    }`}
                                  >
                                    Bash
                                  </button>
                                )}
                                {rule.ansibleTaskSnippet && (
                                  <button
                                    onClick={() => setActiveSnippetTab(prev => ({ ...prev, [rule.id]: 'ansible' }))}
                                    className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                                      snippetTab === 'ansible'
                                        ? 'bg-cyan-600 text-white'
                                        : 'text-slate-400 hover:text-white'
                                    }`}
                                  >
                                    Ansible
                                  </button>
                                )}
                              </div>

                              <button
                                onClick={() => {
                                  const text =
                                    snippetTab === 'powershell'
                                      ? rule.powershellSnippet
                                      : snippetTab === 'bash'
                                      ? rule.bashSnippet
                                      : rule.ansibleTaskSnippet;
                                  if (text) handleCopySnippet(rule.id, text);
                                }}
                                className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 font-semibold"
                              >
                                {copiedSnippetId === rule.id ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-emerald-400">Copied!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    <span>Copy Script</span>
                                  </>
                                )}
                              </button>
                            </div>

                            <pre className="p-2.5 rounded-lg bg-slate-900 border border-slate-850 font-mono text-xs text-cyan-200 overflow-x-auto whitespace-pre leading-normal">
                              {snippetTab === 'powershell' && rule.powershellSnippet}
                              {snippetTab === 'bash' && rule.bashSnippet}
                              {snippetTab === 'ansible' && rule.ansibleTaskSnippet}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Narrative Auto-Fill Confirmation Dialog */}
          {isConfirmingNarrativeFill && (
            <div className="p-4 rounded-2xl bg-cyan-950/80 border border-cyan-500/50 space-y-3 animate-fadeIn shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    Confirm Policy Narrative Auto-Population
                  </h4>
                  <p className="text-xs text-cyan-200 leading-relaxed">
                    This will inspect all {selectedProfile.rules.length} STIG rules in <strong>{selectedProfile.title}</strong> and automatically inject official, auditor-vetted implementation narratives into mapped controls for your active framework ({activeFramework}).
                  </p>
                </div>
                <button aria-label="Close"
                  onClick={() => setIsConfirmingNarrativeFill(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setIsConfirmingNarrativeFill(false)}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkApplyNarratives}
                  className="btn-primary px-4 py-1.5 rounded-xl text-xs"
                >
                  Inject Narratives ({mappedToActiveCount} Mapped Controls)
                </button>
              </div>
            </div>
          )}

          {/* Footer Bar */}
          <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 shrink-0">
            <span className="font-mono">
              Displaying {filteredRules.length} of {selectedProfile.rules.length} benchmark rules
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">
                DISA STIG Release: {selectedProfile.releaseDate}
              </span>
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 font-semibold border border-slate-800"
              >
                Close
              </button>
            </div>
          </div>

        </div>
      </div>
    </DialogOverlay>
  );
};
