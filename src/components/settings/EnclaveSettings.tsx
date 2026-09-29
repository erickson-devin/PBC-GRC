import React, { useState } from 'react';
import {
  Layers,
  KeyRound,
  ShieldAlert,
  Cloud,
  Smartphone,
  Activity,
  Sliders,
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  Clock,
  RefreshCw,
  FileText,
  Download,
  Eye,
  Copy,
  Check,
  X,
  ExternalLink,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { EnclaveStackProfile } from '../../types/tenant';
import { generateFamilyPolicyDocument } from '../../data/reports/policyDocumentGenerator';

const DEFAULT_STACK: EnclaveStackProfile = {
  identityProvider: 'ENTRA_ID_COMMERCIAL',
  edrSolution: 'DEFENDER_FOR_ENDPOINT',
  infrastructure: 'AZURE_GOV',
  mdmSolution: 'INTUNE',
  siemSolution: 'SENTINEL',
  odpParams: {
    INACTIVITY_TIMEOUT: '15 minutes',
    LOCKOUT_LIMIT: '3 consecutive invalid logon attempts',
    LOCKOUT_DURATION: '30 minutes or until administrator unlock',
    AUDIT_RETENTION_PERIOD: '365 calendar days (1 year)',
    CRITICAL_PATCH_SLA: '14 calendar days',
    HIGH_PATCH_SLA: '30 calendar days',
    ACCESS_REVIEW_CADENCE: 'Quarterly (every 90 days)',
    BACKUP_CADENCE: 'Daily incremental with weekly full offsite replication',
    LOG_REVIEW_FREQUENCY: 'Weekly automated alert review with monthly manual audit',
  },
};

export const EnclaveSettings: React.FC = () => {
  const { currentTenant, setIsStackSurveyModalOpen, canEdit, setActiveFramework, activeFramework } = useTenant();
  const { setActiveTab, setSelectedControlId } = useAssessment();

  const [previewingPolicy, setPreviewingPolicy] = useState<{ code: string; title: string } | null>(null);
  const [copiedPolicy, setCopiedPolicy] = useState<boolean>(false);
  const [previewMode, setPreviewMode] = useState<'formatted' | 'raw'>('formatted');

  const stack: EnclaveStackProfile = {
    identityProvider: currentTenant.stackProfile?.identityProvider || DEFAULT_STACK.identityProvider,
    edrSolution: currentTenant.stackProfile?.edrSolution || DEFAULT_STACK.edrSolution,
    infrastructure: currentTenant.stackProfile?.infrastructure || DEFAULT_STACK.infrastructure,
    mdmSolution: currentTenant.stackProfile?.mdmSolution || DEFAULT_STACK.mdmSolution,
    siemSolution: currentTenant.stackProfile?.siemSolution || DEFAULT_STACK.siemSolution,
    odpParams: {
      ...DEFAULT_STACK.odpParams,
      ...(currentTenant.stackProfile?.odpParams || {}),
    },
  };

  const handleDownloadPolicy = (code: string, title: string) => {
    const markdown = generateFamilyPolicyDocument(currentTenant, code, title, activeFramework);
    const filename = `${code}_Family_Living_Policy_${currentTenant.cageCode || 'Enclave'}.md`;
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

  const handleCopyPolicy = (markdown: string) => {
    navigator.clipboard.writeText(markdown);
    setCopiedPolicy(true);
    setTimeout(() => setCopiedPolicy(false), 2000);
  };

  const handleInspectControl = (controlId: string) => {
    setActiveFramework('NIST_800_53_REV5');
    setActiveTab('matrix');
    setSelectedControlId(controlId);
  };

  const getIdentityDetails = (id: string) => {
    switch (id) {
      case 'ENTRA_ID_GOV':
        return {
          name: 'Microsoft Entra ID (GovCloud / GCC High)',
          badge: 'DoD IL4 / IL5',
          desc: 'FedRAMP High cloud identity with FIDO2 passwordless MFA and Conditional Access.',
        };
      case 'ENTRA_ID_COMMERCIAL':
        return {
          name: 'Microsoft Entra ID (Commercial)',
          badge: 'Commercial M365',
          desc: 'Standard commercial cloud identity with Microsoft Authenticator and Single Sign-On.',
        };
      case 'OKTA':
        return {
          name: 'Okta Identity Cloud',
          badge: 'FedRAMP Moderate',
          desc: 'Enterprise identity management with Okta FastPass and adaptive risk policies.',
        };
      case 'ACTIVE_DIRECTORY':
        return {
          name: 'On-Premises Active Directory DS',
          badge: 'Air-Gapped / Self-Hosted',
          desc: 'Windows Server Active Directory with Kerberos, LDAP, and smart card authentication.',
        };
      default:
        return { name: id, badge: 'Active IAM', desc: 'Configured identity directory.' };
    }
  };

  const getEdrDetails = (id: string) => {
    switch (id) {
      case 'DEFENDER_FOR_ENDPOINT':
        return {
          name: 'Microsoft Defender for Endpoint (Plan 2)',
          badge: 'FedRAMP High',
          desc: 'Cloud-native behavioral EDR integrated with Microsoft Defender XDR and Sentinel.',
        };
      case 'CROWDSTRIKE_FALCON':
        return {
          name: 'CrowdStrike Falcon (GovCloud)',
          badge: 'DoD IL4 / FedRAMP High',
          desc: 'AI-native single lightweight sensor with 24/7 OverWatch threat hunting and containment.',
        };
      case 'SENTINELONE':
        return {
          name: 'SentinelOne Singularity',
          badge: 'FedRAMP High',
          desc: 'Autonomous endpoint security with automated story-line rollback and on-device behavioral AI.',
        };
      case 'GENERIC_AV':
        return {
          name: 'Commercial Antivirus & Host Firewall',
          badge: 'Baseline FCI',
          desc: 'Traditional signature-based antivirus with daily definition updates and host intrusion protection.',
        };
      default:
        return { name: id, badge: 'Active EDR', desc: 'Configured endpoint protection.' };
    }
  };

  const getCloudDetails = (id: string) => {
    switch (id) {
      case 'AZURE_GOV':
        return {
          name: 'Microsoft Azure Government (GCC High)',
          badge: 'DoD IL4 / IL5',
          desc: 'US sovereign cloud meeting DoD IL4, IL5, and CJIS requirements with FedRAMP High isolation.',
        };
      case 'AWS_GOVCLOUD':
        return {
          name: 'AWS GovCloud (US)',
          badge: 'DoD IL4 / IL5',
          desc: 'Isolated AWS region designed for regulated defense workloads and ITAR compliance.',
        };
      case 'HYBRID_CLOUD':
        return {
          name: 'Hybrid Cloud Enclave',
          badge: 'Hybrid Boundary',
          desc: 'Sovereign cloud SaaS/IaaS interconnected with dedicated on-premises hardware via IPsec.',
        };
      case 'ON_PREM_RHEL':
        return {
          name: 'Air-Gapped / On-Premises RHEL & VMware',
          badge: 'Air-Gapped / On-Prem',
          desc: 'Physically separated facility datacenter running Red Hat Enterprise Linux STIG baselines.',
        };
      default:
        return { name: id, badge: 'Active Cloud', desc: 'Configured hosting infrastructure.' };
    }
  };

  const getMdmDetails = (id: string) => {
    switch (id) {
      case 'INTUNE':
        return {
          name: 'Microsoft Intune',
          badge: 'Recommended',
          desc: 'BitLocker encryption (XTS-AES 256), automated patch rings, and device compliance policies.',
        };
      case 'JAMF':
        return {
          name: 'Jamf Pro',
          badge: 'Apple Enclave',
          desc: 'macOS and iOS enterprise management with FileVault key escrow and CIS hardening profiles.',
        };
      case 'WORKSPACE_ONE':
        return {
          name: 'VMware Workspace ONE',
          badge: 'Enterprise UEM',
          desc: 'Unified endpoint management across heterogeneous Windows, macOS, and mobile fleets.',
        };
      case 'MANUAL_GPO':
        return {
          name: 'Manual Group Policy (GPO) & Port Locking',
          badge: 'Air-Gap / On-Prem',
          desc: 'Active Directory GPO security baselines, USB device port locking, and custody logs.',
        };
      default:
        return { name: id, badge: 'Active MDM', desc: 'Configured device management.' };
    }
  };

  const getSiemDetails = (id: string) => {
    switch (id) {
      case 'SENTINEL':
        return {
          name: 'Microsoft Sentinel (Azure Gov)',
          badge: 'Recommended',
          desc: 'Cloud-native SIEM with automated threat detection rules, CMMC workbooks, and cold archives.',
        };
      case 'SPLUNK_GOV':
        return {
          name: 'Splunk Cloud GovCloud',
          badge: 'FedRAMP High',
          desc: 'Centralized log ingestion, real-time analytics, and compliance correlation in AWS GovCloud.',
        };
      case 'ELASTIC':
        return {
          name: 'Elastic Security (ELK Stack)',
          badge: 'Self-Hosted / Cloud',
          desc: 'Open-source or Elastic Cloud SIEM with Elasticsearch indexing and Kibana dashboards.',
        };
      case 'LOCAL_AUDITD':
        return {
          name: 'Local Syslog / Auditd Forwarder',
          badge: 'Air-Gap / On-Prem',
          desc: 'Encrypted syslog forwarders sending logs to an immutable write-once storage server.',
        };
      default:
        return { name: id, badge: 'Active SIEM', desc: 'Configured central logging repository.' };
    }
  };

  const identityInfo = getIdentityDetails(stack.identityProvider);
  const edrInfo = getEdrDetails(stack.edrSolution);
  const cloudInfo = getCloudDetails(stack.infrastructure);
  const mdmInfo = getMdmDetails(stack.mdmSolution);
  const siemInfo = getSiemDetails(stack.siemSolution);

  const odpList = [
    { key: 'INACTIVITY_TIMEOUT', label: 'Session Inactivity Lock', control: 'AC-11 / 3.1.10' },
    { key: 'LOCKOUT_LIMIT', label: 'Invalid Logon Attempt Threshold', control: 'AC-7 / 3.1.8' },
    { key: 'LOCKOUT_DURATION', label: 'Account Lockout Duration', control: 'AC-7 / 3.1.8' },
    { key: 'AUDIT_RETENTION_PERIOD', label: 'Audit Log Retention SLA', control: 'AU-11 / 3.3.1' },
    { key: 'CRITICAL_PATCH_SLA', label: 'Critical Vulnerability Patch SLA', control: 'SI-2 / 3.14.1' },
    { key: 'HIGH_PATCH_SLA', label: 'High Vulnerability Patch SLA', control: 'SI-2 / 3.14.1' },
    { key: 'ACCESS_REVIEW_CADENCE', label: 'Privileged Access Review Cadence', control: 'AC-2 / 3.1.2' },
    { key: 'BACKUP_CADENCE', label: 'System Backup Replication Cadence', control: 'CP-9 / 3.8.9' },
    { key: 'LOG_REVIEW_FREQUENCY', label: 'Audit Telemetry Review Cadence', control: 'AU-6 / 3.3.5' },
  ];

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-white tracking-tight">Enclave Boundary & Tech Stack Configuration</h2>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold">
              {currentTenant.name} ({currentTenant.cageCode || 'CAGE'})
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Define your technical architecture and Organization-Defined Parameters (ODPs) to automatically power living policies and cascade tailored implementation narratives.
          </p>
        </div>

        {/* Prominent Configure Stack Wizard Trigger */}
        <button
          onClick={() => setIsStackSurveyModalOpen(true)}
          disabled={!canEdit}
          className="px-5 py-2.5 rounded-2xl bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-cyan-500/25 flex items-center gap-2 transition-all shrink-0 self-start md:self-auto disabled:opacity-50"
        >
          <Sparkles className="w-4 h-4 text-cyan-200" />
          <span>Configure Enclave Stack & ODP Wizard</span>
        </button>
      </div>

      {/* Main Card: Active Enclave Technology Stack */}
      <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Active Enclave Technology Stack</h3>
              <p className="text-xs text-slate-400">Core architectural components managing the {currentTenant.systemName} boundary</p>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ACTIVE ENCLAVE PROFILE
          </span>
        </div>

        {/* 5 Technical Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 1. Identity */}
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  <KeyRound className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Identity (IAM)</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold">
                {identityInfo.badge}
              </span>
            </div>
            <h4 className="text-sm font-bold text-white pt-1">{identityInfo.name}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{identityInfo.desc}</p>
          </div>

          {/* 2. EDR */}
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  <ShieldAlert className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">EDR & Antivirus</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-semibold">
                {edrInfo.badge}
              </span>
            </div>
            <h4 className="text-sm font-bold text-white pt-1">{edrInfo.name}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{edrInfo.desc}</p>
          </div>

          {/* 3. Cloud */}
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30">
                  <Cloud className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Cloud Boundary</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800 font-semibold">
                {cloudInfo.badge}
              </span>
            </div>
            <h4 className="text-sm font-bold text-white pt-1">{cloudInfo.name}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{cloudInfo.desc}</p>
          </div>

          {/* 4. MDM */}
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <Smartphone className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">MDM & Fleets</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-semibold">
                {mdmInfo.badge}
              </span>
            </div>
            <h4 className="text-sm font-bold text-white pt-1">{mdmInfo.name}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{mdmInfo.desc}</p>
          </div>

          {/* 5. SIEM */}
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/30">
                  <Activity className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">SIEM & Logging</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 font-semibold">
                {siemInfo.badge}
              </span>
            </div>
            <h4 className="text-sm font-bold text-white pt-1">{siemInfo.name}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{siemInfo.desc}</p>
          </div>

          {/* 6. Quick Action Card */}
          <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-950/40 via-slate-900 to-indigo-950/40 border border-cyan-500/30 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold text-cyan-200 uppercase tracking-wider">Automated Cascading</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Updating your tech stack automatically cascades tool-specific narratives into assessment objectives and re-compiles family living policies.
              </p>
            </div>
            <button
              onClick={() => setIsStackSurveyModalOpen(true)}
              disabled={!canEdit}
              className="mt-3 w-full py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Modify Stack Profile</span>
            </button>
          </div>
        </div>
      </div>

      {/* Secondary Card: Organization-Defined Parameters (ODP Baselines) */}
      <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Organization-Defined Parameters (ODPs)</h3>
              <p className="text-xs text-slate-400">Standardized operational SLAs and threshold baselines per NIST SP 800-53B / 800-171A</p>
            </div>
          </div>

          <button
            onClick={() => setIsStackSurveyModalOpen(true)}
            disabled={!canEdit}
            className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-400" />
            <span>Edit ODP Parameters</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {odpList.map((item) => {
            const val = stack.odpParams?.[item.key] || DEFAULT_STACK.odpParams?.[item.key] || 'Not Defined';
            return (
              <div key={item.key} className="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-slate-400">{item.label}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-900/60">
                    {item.control}
                  </span>
                </div>
                <div className="text-xs font-mono font-bold text-white">{val}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tertiary Card: Compiled Enclave Living Policies (Access Control, IA, SI, AU, CM, SC) */}
      <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-cyan-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <FileText className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">Compiled Enclave Living Policies</h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 font-bold">
                  AUTO-GENERATED
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Authoritative compliance policies compiled dynamically from your active technology stack, CAGE code, and ODP SLAs.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => handleDownloadPolicy('AC', 'Access Control Policy')}
              className="px-3.5 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 hover:text-cyan-200 text-xs font-semibold flex items-center gap-1.5 border border-cyan-500/30 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Access Control (.md)</span>
            </button>
            <button
              onClick={() => setActiveTab('policies')}
              className="px-3.5 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 hover:text-indigo-200 text-xs font-semibold flex items-center gap-1.5 border border-indigo-500/40 transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Browse All 20 Living Policies &rarr;</span>
            </button>
          </div>
        </div>

        {/* Living Policies Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              code: 'AC',
              name: 'Access Control Policy & Procedures',
              controlId: 'AC-1',
              mapping: 'NIST SP 800-53 AC-1 / NIST SP 800-171 3.1',
              desc: 'Authorizes accounts, inactive session locks, multi-factor enforcement, and remote access boundaries.',
              tags: [identityInfo.name, `Lockout: ${stack.odpParams?.LOCKOUT_LIMIT || '3 attempts'}`, `Inactivity: ${stack.odpParams?.INACTIVITY_TIMEOUT || '15 min'}`],
            },
            {
              code: 'IA',
              name: 'Identification & Authentication Policy',
              controlId: 'IA-1',
              mapping: 'NIST SP 800-53 IA-1 / NIST SP 800-171 3.5',
              desc: 'Governs identity lifecycle, phishing-resistant MFA standards, credential rotation, and identifier reuse.',
              tags: [identityInfo.name, 'FIDO2 / WebAuthn MFA', 'Zero Trust IAM'],
            },
            {
              code: 'SI',
              name: 'System & Information Integrity Policy',
              controlId: 'SI-1',
              mapping: 'NIST SP 800-53 SI-1 / NIST SP 800-171 3.14',
              desc: 'Mandates flaw remediation SLAs, automated malware detection, endpoint telemetry, and firmware verification.',
              tags: [edrInfo.name, `Critical: ${stack.odpParams?.CRITICAL_PATCH_SLA || '14 days'}`, `High: ${stack.odpParams?.HIGH_PATCH_SLA || '30 days'}`],
            },
            {
              code: 'AU',
              name: 'Audit & Accountability Policy',
              controlId: 'AU-1',
              mapping: 'NIST SP 800-53 AU-1 / NIST SP 800-171 3.3',
              desc: 'Establishes central log ingestion, immutable retention periods, log review frequency, and timestamp synchronization.',
              tags: [siemInfo.name, `Retention: ${stack.odpParams?.AUDIT_RETENTION_PERIOD || '365 days'}`, `Review: ${stack.odpParams?.LOG_REVIEW_FREQUENCY || 'Weekly'}`],
            },
            {
              code: 'CM',
              name: 'Configuration Management Policy',
              controlId: 'CM-1',
              mapping: 'NIST SP 800-53 CM-1 / NIST SP 800-171 3.4',
              desc: 'Enforces hardened system baselines, change control approval gates, physical port lockdowns, and software restrictions.',
              tags: [mdmInfo.name, cloudInfo.name, 'Automated Drift Remediation'],
            },
            {
              code: 'SC',
              name: 'System & Communications Protection Policy',
              controlId: 'SC-1',
              mapping: 'NIST SP 800-53 SC-1 / NIST SP 800-171 3.13',
              desc: 'Regulates cryptographic perimeter boundaries, FIPS 140 validated encryption, split-tunneling bans, and subnets.',
              tags: [cloudInfo.name, 'TLS 1.3 / IPsec IKEv2', 'FIPS 140 Validation'],
            },
          ].map((policy) => (
            <div
              key={policy.code}
              className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between gap-3 group"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-8 h-8 rounded-xl bg-cyan-500/10 text-cyan-300 font-mono font-bold text-xs flex items-center justify-center border border-cyan-500/30">
                      {policy.code}
                    </span>
                    <div>
                      <h4 className="text-sm font-bold text-white group-hover:text-cyan-300 transition-colors">
                        {policy.name}
                      </h4>
                      <span className="text-[10px] font-mono text-slate-400">{policy.mapping}</span>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">{policy.desc}</p>

                <div className="flex flex-wrap gap-1.5 pt-1">
                  {policy.tags.map((t, i) => (
                    <span
                      key={i}
                      className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                <button
                  onClick={() => setPreviewingPolicy({ code: policy.code, title: policy.name })}
                  className="flex-1 py-1.5 px-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>View Policy</span>
                </button>

                <button
                  onClick={() => handleDownloadPolicy(policy.code, policy.name)}
                  title="Download Markdown Document"
                  className="py-1.5 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">.MD</span>
                </button>

                <button
                  onClick={() => handleInspectControl(policy.controlId)}
                  title="Inspect control in NIST SP 800-53 Matrix"
                  className="py-1.5 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-indigo-200 border border-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{policy.controlId}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quaternary Card: Enclave Scope & Boundary Authorization Metadata */}
      <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">System Boundary & Authorization Metadata</h3>
            <p className="text-xs text-slate-400">Formal boundary scoping statement and authorizing official custody</p>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-2">
          <span className="text-xs font-bold text-slate-300">Authorized Boundary Scope:</span>
          <p className="text-xs text-slate-300 leading-relaxed font-mono bg-slate-900 p-3 rounded-xl border border-slate-800">
            {currentTenant.systemBoundaryScope ||
              `The boundary for ${currentTenant.name} includes all corporate Microsoft 365 / Google Cloud tenant services, identity infrastructure, corporate managed endpoints, internal facility network, and Next-Generation Boundary Firewalls used for processing, storing, or transmitting Federal Contract Information (FCI) or CUI.`}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Authorizing Official</span>
            <span className="text-white font-bold">{currentTenant.systemOwner}</span>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">CAGE Code</span>
            <span className="text-white font-bold">{currentTenant.cageCode || 'N/A'}</span>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">SAM.gov Registration</span>
            <span className="text-emerald-400 font-bold">{currentTenant.samStatus}</span>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">License Tier</span>
            <span className="text-cyan-300 font-bold">{currentTenant.licenseTier || 'DEFENSE_PRO'}</span>
          </div>
        </div>
      </div>

      {/* Interactive Policy Document Reader Modal */}
      {previewingPolicy && (() => {
        const markdown = generateFamilyPolicyDocument(currentTenant, previewingPolicy.code, previewingPolicy.title, activeFramework);
        return (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
            <div className="w-full max-w-4xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-fadeIn">
              {/* Modal Header */}
              <div className="p-5 border-b border-slate-800 flex items-center justify-between gap-4 bg-slate-950/60 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-cyan-500/20 text-cyan-300 flex items-center justify-center border border-cyan-500/30">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <span>{previewingPolicy.title}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold">
                        {previewingPolicy.code} Living Document
                      </span>
                    </h3>
                    <p className="text-xs text-slate-400">
                      Compiled for {currentTenant.name} (CAGE: {currentTenant.cageCode || 'N/A'})
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* View Mode Toggle */}
                  <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
                    <button
                      onClick={() => setPreviewMode('formatted')}
                      className={`px-3 py-1 rounded-lg transition-colors font-semibold ${
                        previewMode === 'formatted'
                          ? 'bg-cyan-500 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Formatted
                    </button>
                    <button
                      onClick={() => setPreviewMode('raw')}
                      className={`px-3 py-1 rounded-lg transition-colors font-semibold ${
                        previewMode === 'raw'
                          ? 'bg-cyan-500 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Raw Markdown
                    </button>
                  </div>

                  <button
                    onClick={() => handleCopyPolicy(markdown)}
                    className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                    title="Copy Markdown to Clipboard"
                  >
                    {copiedPolicy ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>

                  <button
                    onClick={() => handleDownloadPolicy(previewingPolicy.code, previewingPolicy.title)}
                    className="p-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 transition-colors"
                    title="Download Markdown File"
                  >
                    <Download className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => setPreviewingPolicy(null)}
                    className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700 transition-colors ml-1"
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-6 bg-slate-950/40 space-y-4 font-sans text-slate-200 text-sm">
                {previewMode === 'raw' ? (
                  <pre className="p-4 rounded-2xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap leading-relaxed select-all">
                    {markdown}
                  </pre>
                ) : (
                  <div className="space-y-4 max-w-3xl mx-auto">
                    {markdown.split('\n\n').map((block, idx) => {
                      const trimmed = block.trim();
                      if (trimmed.startsWith('# ')) {
                        return (
                          <h1 key={idx} className="text-xl font-bold text-white border-b border-slate-800 pb-2 pt-2">
                            {trimmed.replace('# ', '')}
                          </h1>
                        );
                      }
                      if (trimmed.startsWith('## ')) {
                        return (
                          <h2 key={idx} className="text-base font-bold text-cyan-300 border-b border-slate-800/60 pb-1 pt-3">
                            {trimmed.replace('## ', '')}
                          </h2>
                        );
                      }
                      if (trimmed.startsWith('### ')) {
                        return (
                          <h3 key={idx} className="text-sm font-bold text-indigo-300 pt-2">
                            {trimmed.replace('### ', '')}
                          </h3>
                        );
                      }
                      if (trimmed.startsWith('> ')) {
                        return (
                          <blockquote
                            key={idx}
                            className="p-3 rounded-xl bg-indigo-950/30 border-l-4 border-indigo-500 text-xs text-indigo-200 leading-relaxed font-mono"
                          >
                            {trimmed.replace(/> /g, '')}
                          </blockquote>
                        );
                      }
                      if (trimmed.startsWith('|')) {
                        const rows = trimmed.split('\n').filter((r) => !r.includes('---'));
                        return (
                          <div key={idx} className="overflow-x-auto my-3">
                            <table className="w-full text-xs text-left border-collapse border border-slate-800 rounded-xl overflow-hidden">
                              <tbody>
                                {rows.map((row, rIdx) => {
                                  const cols = row
                                    .split('|')
                                    .filter((_, i, arr) => i > 0 && i < arr.length - 1)
                                    .map((c) => c.trim());
                                  const isHeader = rIdx === 0;
                                  return (
                                    <tr
                                      key={rIdx}
                                      className={
                                        isHeader
                                          ? 'bg-slate-900 text-cyan-300 font-bold border-b border-slate-800'
                                          : 'border-b border-slate-800/60 hover:bg-slate-900/50'
                                      }
                                    >
                                      {cols.map((col, cIdx) => (
                                        <td key={cIdx} className="p-2.5 font-mono text-[11px]">
                                          {col}
                                        </td>
                                      ))}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      }
                      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                        const items = trimmed.split('\n');
                        return (
                          <ul key={idx} className="list-disc pl-5 space-y-1 text-xs text-slate-300 leading-relaxed">
                            {items.map((item, iIdx) => (
                              <li key={iIdx}>{item.replace(/^[-*]\s+/, '')}</li>
                            ))}
                          </ul>
                        );
                      }
                      return (
                        <p key={idx} className="text-xs text-slate-300 leading-relaxed">
                          {trimmed}
                        </p>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between gap-4 shrink-0">
                <span className="text-[11px] font-mono text-slate-500">
                  SHA-256 Hash Generated dynamically &middot; NIST SP 800-53 Rev. 5 / NIST SP 800-171A
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setPreviewingPolicy(null);
                      handleInspectControl(previewingPolicy.code === 'AC' ? 'AC-1' : `${previewingPolicy.code}-1`);
                    }}
                    className="px-4 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-bold flex items-center gap-1.5 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Inspect Control in Matrix</span>
                  </button>
                  <button
                    onClick={() => setPreviewingPolicy(null)}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default EnclaveSettings;
