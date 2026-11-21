import React, { useState, useMemo, useEffect, useId } from 'react';
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
  FilePlus2,
  LibraryBig,
} from 'lucide-react';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { MarkdownPreview } from '../components/common/MarkdownPreview';
import { ErrorNotice } from '../components/common/ErrorNotice';
import { useTenant } from '../context/TenantContext';
import { useAssessment } from '../context/AssessmentContext';
import { useDocumentRegister } from '../hooks/useDocumentRegister';
import { generatedSeedKey } from '../data/documents/generatedDrafts';
import { statusChip, documentErrorMessage, DOCUMENT_UI_TEXT } from '../data/documents/documentUiView';
import { requestDocumentFocus } from '../components/documents/documentFocus';
import { withEffectiveStack } from '../data/effectiveStackProfile';
import { PolicyControlReferenceDialog } from '../components/matrix/PolicyControlReferenceDialog';
import { generateFamilyPolicyDocument } from '../data/reports/policyDocumentGenerator';
import { useFipsModules } from '../hooks/useFipsModules';

import { copyText, COPY_FAILED_MESSAGE } from '../utils/clipboard';
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
// NIST SP 800-171 Rev. 3 has 17 families, keyed by the family number its requirements carry as `domain` ('03.01'): the 14 CMMC Level 2 families plus PL, SA and SR.
// The policy generator picks a family's requirements by that domain, so the library keys them the same way; the SP 800-53 policy control stays the reference.
const NIST_171_R3_FAMILIES: { code: string; letter: string; title: string }[] = [
  { code: '03.01', letter: 'AC', title: 'Access Control' },
  { code: '03.02', letter: 'AT', title: 'Awareness and Training' },
  { code: '03.03', letter: 'AU', title: 'Audit and Accountability' },
  { code: '03.04', letter: 'CM', title: 'Configuration Management' },
  { code: '03.05', letter: 'IA', title: 'Identification and Authentication' },
  { code: '03.06', letter: 'IR', title: 'Incident Response' },
  { code: '03.07', letter: 'MA', title: 'Maintenance' },
  { code: '03.08', letter: 'MP', title: 'Media Protection' },
  { code: '03.09', letter: 'PS', title: 'Personnel Security' },
  { code: '03.10', letter: 'PE', title: 'Physical Protection' },
  { code: '03.11', letter: 'RA', title: 'Risk Assessment' },
  { code: '03.12', letter: 'CA', title: 'Security Assessment and Monitoring' },
  { code: '03.13', letter: 'SC', title: 'System and Communications Protection' },
  { code: '03.14', letter: 'SI', title: 'System and Information Integrity' },
  { code: '03.15', letter: 'PL', title: 'Planning' },
  { code: '03.16', letter: 'SA', title: 'System and Services Acquisition' },
  { code: '03.17', letter: 'SR', title: 'Supply Chain Risk Management' },
];

const PolicyLibraryViewContent: React.FC = () => {
  const { currentTenant, setIsStackSurveyModalOpen, canEdit, activeFramework, activeProgram } = useTenant();
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
    if (norm === 'NIST_800_171_R3') {
      return NIST_171_R3_FAMILIES.flatMap((r3) => {
        const base = NIST_800_53_FAMILIES.find((f) => f.code === r3.letter);
        return base ? [{ ...base, code: r3.code, name: r3.title }] : [];
      });
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
  const [copyFailed, setCopyFailed] = useState(false);
  const [recompileNotice, setRecompileNotice] = useState<boolean>(false);
  const [recompileCount, setRecompileCount] = useState<number>(0);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  // #230: the active program's stack profile, else the organization's
  const stackTenant = useMemo(() => withEffectiveStack(currentTenant, activeProgram), [currentTenant, activeProgram]);
  const stack = stackTenant.stackProfile;

  const selectedFamily = useMemo(() => {
    return (
      activeFamilies.find((f) => f.code === selectedFamilyCode) || activeFamilies[0] || NIST_800_53_FAMILIES[0]
    );
  }, [activeFamilies, selectedFamilyCode]);

  // Register as draft: a DRAFT row in the Document Register whose text stays rendered live from the generator (nothing generated is stored)
  const { setActiveTab } = useAssessment();
  const reg = useDocumentRegister();
  const registerHintId = useId();
  const [registering, setRegistering] = useState(false);
  const [registerMsg, setRegisterMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const seedKey = generatedSeedKey(activeFramework, selectedFamily.code);
  const registered = reg.documents.find((d) => d.seedKey === seedKey && d.status !== 'RETIRED') ?? null;
  useEffect(() => {
    setRegisterMsg(null);
  }, [seedKey]);
  const handleRegister = async () => {
    setRegistering(true);
    setRegisterMsg(null);
    try {
      await reg.create({ kind: 'POLICY', title: `${selectedFamily.name} Policy`, origin: 'GENERATED', seedKey });
      setRegisterMsg({ ok: true, text: DOCUMENT_UI_TEXT.registeredDraft });
    } catch (err: unknown) {
      if ((err as { reason?: unknown })?.reason === 'duplicate_seed') {
        await reg.reload();
        setRegisterMsg({ ok: true, text: 'This policy is already in the Document Register.' });
      } else {
        setRegisterMsg({ ok: false, text: documentErrorMessage(err, 'register') });
      }
    } finally {
      setRegistering(false);
    }
  };
  const openRegister = (id: string) => {
    requestDocumentFocus(id);
    setActiveTab('documents');
  };

  // Generate living policy markdown on the fly
  const markdown = useMemo(() => {
    return generateFamilyPolicyDocument(
      stackTenant,
      selectedFamily.code,
      `${selectedFamily.name} Policy`,
      activeFramework,
      cryptoModules
    );
  }, [stackTenant, selectedFamily, activeFramework, recompileCount, cryptoModules]);

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
    void copyText(markdown).then((ok) => {
      setCopyFailed(!ok);
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
                      : activeFramework === 'NIST_800_171_R3'
                      ? 'NIST SP 800-171 Rev. 3'
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
                    className={`w-8 h-8 rounded-xl font-mono font-bold ${fam.code.length > 2 ? 'text-[10px]' : 'text-xs'} flex items-center justify-center shrink-0 border ${
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
                    : activeFramework === 'NIST_800_171_R3'
                    ? 'NIST SP 800-171 Rev. 3'
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
              <span role="status" aria-live="polite" className={copyFailed ? 'text-xs text-amber-300' : 'sr-only'}>{copyFailed ? COPY_FAILED_MESSAGE : ''}</span>

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

              {/* Register the generated policy as a draft in the Document Register */}
              {reg.supported && registered && (
                <span className="inline-flex items-center gap-1.5">
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${registered.status === 'APPROVED' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/15 border-amber-500/30 text-amber-300'}`}>{`In the register: ${statusChip(registered).text}`}</span>
                  <button type="button" onClick={() => openRegister(registered.id)} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                    <LibraryBig className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open in Document Register</span>
                  </button>
                </span>
              )}
              {reg.supported && canEdit && !registered && activeFramework !== 'NIST_800_171_R3' && (
                <button
                  type="button"
                  onClick={() => void handleRegister()}
                  disabled={registering || reg.status !== 'ready'}
                  aria-describedby={registerHintId}
                  className="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border border-dashed border-amber-500/50 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                >
                  <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{registering ? 'Registering…' : 'Register as draft'}</span>
                </button>
              )}

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
          {reg.supported && canEdit && !registered && activeFramework !== 'NIST_800_171_R3' && (
            <p id={registerHintId} className="text-[11px] text-slate-400">Adds a draft entry to the Document Register. The text is not stored: it is rendered from the generator until a person uploads the reviewed copy and approves it.</p>
          )}
          {registerMsg && (registerMsg.ok ? <p role="status" className="text-xs text-emerald-300">{registerMsg.text}</p> : <ErrorNotice message={registerMsg.text} />)}

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
