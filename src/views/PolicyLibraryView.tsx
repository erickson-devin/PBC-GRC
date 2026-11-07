import React, { useState, useMemo, useEffect } from 'react';
import {
  Sparkles,
  Download,
  Copy,
  Check,
  RefreshCw,
  Search,
  BookOpen,
  Layers,
  KeyRound,
  ShieldAlert,
  Cloud,
  Smartphone,
  Activity,
  Sliders,
  CheckCircle2,
  Scroll,
} from 'lucide-react';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { MarkdownPreview } from '../components/common/MarkdownPreview';
import { useTenant } from '../context/TenantContext';
import { PolicyControlReferenceDialog } from '../components/matrix/PolicyControlReferenceDialog';
import { generateFamilyPolicyDocument } from '../data/reports/policyDocumentGenerator';
import { useFipsModules } from '../hooks/useFipsModules';

import { copyToClipboard } from '../utils/clipboard';
import { stackValueLabel, type StackKey } from '../data/stackDraftView';
export interface PolicyFamilyItem {
  code: string;
  name: string;
  description: string;
  controlId: string;
  primaryTech: string;
}

export const NIST_800_53_FAMILIES: PolicyFamilyItem[] = [
  {
    code: 'AC',
    name: 'Access Control',
    description: 'Account management, least privilege, session lockout, and boundary enforcement.',
    controlId: 'AC-1',
    primaryTech: 'Identity / IAM',
  },
  {
    code: 'AT',
    name: 'Awareness and Training',
    description: 'Security awareness training, insider threat awareness, and role-based training.',
    controlId: 'AT-1',
    primaryTech: 'HR / LMS',
  },
  {
    code: 'AU',
    name: 'Audit and Accountability',
    description: 'Audit log generation, centralized ingestion, timestamp synchronization, and review.',
    controlId: 'AU-1',
    primaryTech: 'SIEM / Syslog',
  },
  {
    code: 'CA',
    name: 'Assessment, Authorization, and Monitoring',
    description: 'Continuous monitoring, security assessments, and plan of action & milestones.',
    controlId: 'CA-1',
    primaryTech: 'GRC Engine',
  },
  {
    code: 'CM',
    name: 'Configuration Management',
    description: 'Baseline configurations, change control approval gates, and software whitelisting.',
    controlId: 'CM-1',
    primaryTech: 'MDM / Intune',
  },
  {
    code: 'CP',
    name: 'Contingency Planning',
    description: 'Disaster recovery, backup replication cadence, and contingency plan testing.',
    controlId: 'CP-1',
    primaryTech: 'Cloud Backup',
  },
  {
    code: 'IA',
    name: 'Identification and Authentication',
    description: 'Phishing-resistant MFA, FIDO2/WebAuthn, credential rotation, and identifier lifecycle.',
    controlId: 'IA-1',
    primaryTech: 'Entra ID / Okta',
  },
  {
    code: 'IR',
    name: 'Incident Response',
    description: 'Incident handling, DFIR coordination, DoD cyber incident reporting, and triage.',
    controlId: 'IR-1',
    primaryTech: 'EDR / DFIR',
  },
  {
    code: 'MA',
    name: 'Maintenance',
    description: 'System maintenance tools, remote maintenance verification, and inspection.',
    controlId: 'MA-1',
    primaryTech: 'GPO / IT Ops',
  },
  {
    code: 'MP',
    name: 'Media Protection',
    description: 'Removable media restrictions, cryptographic sanitization, and media custody logs.',
    controlId: 'MP-1',
    primaryTech: 'USB Lock / Intune',
  },
  {
    code: 'PE',
    name: 'Physical and Environmental Protection',
    description: 'Physical perimeter access, visitor logs, and facility power/environmental safeguards.',
    controlId: 'PE-1',
    primaryTech: 'Badging / CCTV',
  },
  {
    code: 'PL',
    name: 'Planning',
    description: 'System security plan maintenance, boundary architecture, and rules of behavior.',
    controlId: 'PL-1',
    primaryTech: 'SSP Builder',
  },
  {
    code: 'PM',
    name: 'Program Management',
    description: 'Enterprise information security governance, risk management, and resourcing.',
    controlId: 'PM-1',
    primaryTech: 'C-Suite Exec',
  },
  {
    code: 'PS',
    name: 'Personnel Security',
    description: 'Personnel screening, background investigations, transfers, and terminations.',
    controlId: 'PS-1',
    primaryTech: 'HR System',
  },
  {
    code: 'PT',
    name: 'PII Processing and Transparency',
    description: 'Privacy impact assessments, consent banners, and PII authority monitoring.',
    controlId: 'PT-1',
    primaryTech: 'Privacy Engine',
  },
  {
    code: 'RA',
    name: 'Risk Assessment',
    description: 'Vulnerability scanning cadence, threat intelligence ingestion, and CVE triage.',
    controlId: 'RA-1',
    primaryTech: 'EDR / Scanner',
  },
  {
    code: 'SA',
    name: 'System and Services Acquisition',
    description: 'FedRAMP High/DoD IL4 service vetting, contract clauses, and developer testing.',
    controlId: 'SA-1',
    primaryTech: 'Procurement',
  },
  {
    code: 'SC',
    name: 'System and Communications Protection',
    description: 'Boundary isolation, FIPS 140-3 cryptography, split-tunneling bans, and subnets.',
    controlId: 'SC-1',
    primaryTech: 'NGFW / Cloud',
  },
  {
    code: 'SI',
    name: 'System and Information Integrity',
    description: 'Flaw remediation SLAs, automated malware detection, endpoint telemetry, and alerts.',
    controlId: 'SI-1',
    primaryTech: 'Defender / EDR',
  },
  {
    code: 'SR',
    name: 'Supply Chain Risk Management',
    description: 'Component provenance, hardware counterfeit prevention, and vendor scrutiny.',
    controlId: 'SR-1',
    primaryTech: 'C-SCRM Plan',
  },
];

const CMMC_L1_FAMILIES = ['AC', 'IA', 'MP', 'PE', 'SC', 'SI'];
const CMMC_L2_FAMILIES = ['AC', 'AT', 'AU', 'CA', 'CM', 'IA', 'IR', 'MA', 'MP', 'PE', 'PS', 'RA', 'SC', 'SI'];

const PolicyLibraryViewContent: React.FC = () => {
  const { currentTenant, setIsStackSurveyModalOpen, canEdit, activeFramework } = useTenant();
  const cryptoModules = useFipsModules();
  const [referenceControlId, setReferenceControlId] = useState<string | null>(null);

  const activeFamilies = useMemo(() => {
    const norm = (activeFramework || '').toUpperCase();
    if (norm === 'CMMC_L1' || norm === 'CMMC-L1') {
      return NIST_800_53_FAMILIES.filter((f) => CMMC_L1_FAMILIES.includes(f.code));
    }
    if (norm === 'CMMC_L2' || norm === 'CMMC-L2') {
      return NIST_800_53_FAMILIES.filter((f) => CMMC_L2_FAMILIES.includes(f.code));
    }
    return NIST_800_53_FAMILIES;
  }, [activeFramework]);

  const [selectedFamilyCode, setSelectedFamilyCode] = useState<string>('AC');

  // Keep selectedFamilyCode aligned with active families
  useEffect(() => {
    if (!activeFamilies.some((f) => f.code === selectedFamilyCode) && activeFamilies.length > 0) {
      setSelectedFamilyCode(activeFamilies[0].code);
    }
  }, [activeFamilies, selectedFamilyCode]);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [recompileNotice, setRecompileNotice] = useState<boolean>(false);
  const [recompileCount, setRecompileCount] = useState<number>(0);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  const stack = currentTenant.stackProfile;

  const selectedFamily = useMemo(() => {
    return (
      activeFamilies.find((f) => f.code === selectedFamilyCode) || activeFamilies[0] || NIST_800_53_FAMILIES[0]
    );
  }, [activeFamilies, selectedFamilyCode]);

  // Generate living policy markdown on the fly
  const markdown = useMemo(() => {
    return generateFamilyPolicyDocument(
      currentTenant,
      selectedFamily.code,
      `${selectedFamily.name} Policy`,
      activeFramework,
      cryptoModules
    );
  }, [currentTenant, selectedFamily, activeFramework, recompileCount, cryptoModules]);

  const filteredFamilies = useMemo(() => {
    if (!searchQuery.trim()) return activeFamilies;
    const q = searchQuery.toLowerCase();
    return activeFamilies.filter(
      (f) =>
        f.code.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.primaryTech.toLowerCase().includes(q)
    );
  }, [activeFamilies, searchQuery]);

  const handleCopy = () => {
    copyToClipboard(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => {
    const filename = `${selectedFamily.code}_Family_Living_Policy_${currentTenant.cageCode || 'Enclave'}.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleRecompile = () => {
    setRecompileCount((c) => c + 1);
    setRecompileNotice(true);
    setTimeout(() => setRecompileNotice(false), 2500);
  };

  const formatTechName = (key: StackKey, val?: string) =>
    stackValueLabel(key, val, stack?.customLabels) ?? 'Not set';

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* ── Page Header & Enclave Tech Stack Banner ── */}
      <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[22rem] space-y-1">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30">
                <Scroll className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight flex flex-wrap items-center gap-2">
                  <span>Living Policy Library</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 font-bold">
                    {activeFamilies.length} FAMILIES
                  </span>
                </h1>
                <p className="text-xs text-slate-400">
                  Authoritative compliance policies compiled dynamically for{' '}
                  <strong className="text-cyan-300">
                    {activeFramework === 'CMMC_L1'
                      ? 'DoD CMMC 2.0 Level 1 / FAR 52.204-21'
                      : activeFramework === 'CMMC_L2'
                      ? 'DoD CMMC 2.0 Level 2 / NIST SP 800-171'
                      : 'NIST SP 800-53 Rev. 5 (Federal RMF)'}
                  </strong>{' '}
                  and your active defense enclave architecture.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 max-w-full">
            <button
              type="button"
              onClick={() => setIsStackSurveyModalOpen(true)}
              disabled={!canEdit}
              title={canEdit ? undefined : 'Read-only: only an editor can change the enclave stack.'}
              className="btn-primary px-5 py-2.5 rounded-2xl text-xs flex items-center gap-2 shrink-0 max-w-full text-left"
            >
              <Sparkles className="w-4 h-4 text-cyan-200" aria-hidden="true" />
              <span>Configure Enclave Stack & ODP Wizard</span>
            </button>
          </div>
        </div>

        {/* Enclave Architecture & ODP Summary Strip */}
        <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-400 border-b border-slate-800/60 pb-2">
            <span className="flex items-center gap-2 text-cyan-300">
              <Layers className="w-4 h-4" aria-hidden="true" />
              <span>Active Enclave Architectural Profile</span>
            </span>
            <span className="font-mono text-xs text-slate-400">
              CAGE: <strong className="text-white">{currentTenant.cageCode || 'N/A'}</strong> &middot;{' '}
              Boundary: <strong className="text-white">{currentTenant.systemName}</strong>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <KeyRound className="w-3 h-3 text-cyan-400" /> Identity (IAM)
              </span>
              {stack?.identityProvider ? (
                <span className="font-mono font-bold text-white text-xs truncate block mt-0.5">
                  {formatTechName('identityProvider', stack.identityProvider)}
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic block mt-0.5">Not set</span>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3 text-indigo-400" /> EDR / XDR
              </span>
              {stack?.edrSolution ? (
                <span className="font-mono font-bold text-white text-xs truncate block mt-0.5">
                  {formatTechName('edrSolution', stack.edrSolution)}
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic block mt-0.5">Not set</span>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <Cloud className="w-3 h-3 text-blue-400" /> Cloud Boundary
              </span>
              {stack?.infrastructure ? (
                <span className="font-mono font-bold text-white text-xs truncate block mt-0.5">
                  {formatTechName('infrastructure', stack.infrastructure)}
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic block mt-0.5">Not set</span>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <Smartphone className="w-3 h-3 text-emerald-400" /> MDM / Fleets
              </span>
              {stack?.mdmSolution ? (
                <span className="font-mono font-bold text-white text-xs truncate block mt-0.5">
                  {formatTechName('mdmSolution', stack.mdmSolution)}
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic block mt-0.5">Not set</span>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <Activity className="w-3 h-3 text-purple-400" /> SIEM / Logs
              </span>
              {stack?.siemSolution ? (
                <span className="font-mono font-bold text-white text-xs truncate block mt-0.5">
                  {formatTechName('siemSolution', stack.siemSolution)}
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic block mt-0.5">Not set</span>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <Sliders className="w-3 h-3 text-amber-400" /> Inactivity Lock
              </span>
              <span className="font-mono font-bold text-amber-300 text-xs truncate block mt-0.5">
                {stack?.odpParams?.INACTIVITY_TIMEOUT || 'Not set'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Two-Column Layout (Family Selector & Document Viewer) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: 20 Policy Families List */}
        <div className="lg:col-span-4 p-4 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <span>Control Families</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                {filteredFamilies.length}/{activeFamilies.length}
              </span>
            </h2>
          </div>

          {/* Search Box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search families, controls, tech..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          {/* Family List Items */}
          <div className="space-y-1.5 max-h-[700px] overflow-y-auto pr-1">
            {filteredFamilies.map((fam) => {
              const isSelected = fam.code === selectedFamilyCode;
              return (
                <button
                  key={fam.code}
                  onClick={() => setSelectedFamilyCode(fam.code)}
                  className={`w-full text-left p-3 rounded-2xl transition-all border flex items-start gap-3 ${
                    isSelected
                      ? 'bg-cyan-500/10 border-cyan-500/50 shadow-md shadow-cyan-500/10 text-white'
                      : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700 text-slate-300 hover:text-white'
                  }`}
                >
                  <span
                    className={`w-8 h-8 rounded-xl font-mono font-bold text-xs flex items-center justify-center shrink-0 border ${
                      isSelected
                        ? 'bg-cyan-500 text-white border-cyan-400'
                        : 'bg-slate-900 text-cyan-400 border-slate-800'
                    }`}
                  >
                    {fam.code}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <h4 className="text-xs font-bold truncate">{fam.name}</h4>
                      <span className="text-xs font-mono text-slate-400 shrink-0">
                        {fam.controlId}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">
                      {fam.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Column: Compiled Policy Viewer */}
        <div className="lg:col-span-8 p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-4">
          {/* Header of Viewer */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2.5 py-1 rounded-xl bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 font-mono font-bold text-xs">
                  {selectedFamily.code} FAMILY
                </span>
                <h2 className="text-base font-bold text-white">{selectedFamily.name} Policy</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Framework Authority:{' '}
                <strong className="text-cyan-300">
                  {activeFramework === 'CMMC_L1'
                    ? 'DoD CMMC 2.0 Level 1 / FAR 52.204-21'
                    : activeFramework === 'CMMC_L2'
                    ? 'DoD CMMC 2.0 Level 2 / NIST SP 800-171 Rev. 2'
                    : 'NIST SP 800-53 Rev. 5 Risk Management Framework'}
                </strong>
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Formatted / Raw Toggle */}
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
                <button
                  type="button"
                  aria-pressed={viewMode === 'formatted'}
                  onClick={() => setViewMode('formatted')}
                  className={`px-3 py-1 rounded-lg transition-colors font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                    viewMode === 'formatted'
                      ? 'bg-cyan-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Formatted
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'raw'}
                  onClick={() => setViewMode('raw')}
                  className={`px-3 py-1 rounded-lg transition-colors font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                    viewMode === 'raw'
                      ? 'bg-cyan-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Raw Markdown
                </button>
              </div>

              {/* Re-Compile */}
              <button
                type="button"
                onClick={handleRecompile}
                aria-label="Re-Compile from Enclave Stack"
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                title="Re-Compile from Enclave Stack"
              >
                <RefreshCw className={`w-4 h-4 ${recompileNotice ? 'animate-spin motion-reduce:animate-none text-cyan-400' : ''}`} />
              </button>

              {/* Copy */}
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy Markdown to Clipboard"
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                title="Copy Markdown to Clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>

              {/* Export */}
              <button
                type="button"
                onClick={handleExport}
                aria-label="Download Markdown Document"
                className="px-3.5 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                title="Download Markdown Document"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export .MD</span>
              </button>

              {/* SP 800-53 reference (read-only, never switches the program) */}
              <button
                type="button"
                onClick={() => setReferenceControlId(selectedFamily.controlId)}
                aria-haspopup="dialog"
                aria-label={`View SP 800-53 ${selectedFamily.controlId} reference`}
                className="px-3 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                title={`View SP 800-53 ${selectedFamily.controlId} reference (read-only)`}
              >
                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{selectedFamily.controlId}</span>
              </button>
            </div>
          </div>

          {/* Recompile Notice */}
          {recompileNotice && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Policy document re-compiled from active enclave stack and ODP configurations.</span>
            </div>
          )}

          {/* Document Content */}
          <div className="p-6 rounded-2xl bg-slate-950/60 border border-slate-800 min-h-[500px] overflow-y-auto max-h-[750px]">
            {viewMode === 'raw' ? (
              <pre className="font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap select-all">
                {markdown}
              </pre>
            ) : (
              <MarkdownPreview markdown={markdown} headingOffset={2} className="space-y-4 max-w-3xl mx-auto" />
            )}
          </div>
        </div>
      </div>
      {referenceControlId && <PolicyControlReferenceDialog controlId={referenceControlId} onClose={() => setReferenceControlId(null)} />}
    </div>
  );
};

export const PolicyLibraryView: React.FC = () => {
  const { activeFramework } = useTenant();
  return (
    <ErrorBoundary name="Policy Library" variant="panel" resetKeys={[activeFramework]}>
      <PolicyLibraryViewContent />
    </ErrorBoundary>
  );
};

export default PolicyLibraryView;
