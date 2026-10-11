import React, { useState, useEffect } from 'react';
import {
  X,
  KeyRound,
  ShieldAlert,
  Cloud,
  Smartphone,
  Activity,
  Sliders,
  Sparkles,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Layers,
  RotateCcw,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { EnclaveStackProfile } from '../../types/tenant';

interface EnclaveStackSurveyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (stack: EnclaveStackProfile) => void;
}

type WizardTab = 'identity' | 'edr' | 'cloud' | 'mdm' | 'siem' | 'odp';

const DEFAULT_ODP_PARAMS: Record<string, string> = {
  INACTIVITY_TIMEOUT: '15 minutes',
  LOCKOUT_LIMIT: '3 consecutive invalid logon attempts',
  LOCKOUT_DURATION: '30 minutes or until administrator unlock',
  AUDIT_RETENTION_PERIOD: '365 calendar days (1 year)',
  CRITICAL_PATCH_SLA: '14 calendar days',
  HIGH_PATCH_SLA: '30 calendar days',
  ACCESS_REVIEW_CADENCE: 'Quarterly (every 90 days)',
  BACKUP_CADENCE: 'Daily incremental with weekly full offsite replication',
  LOG_REVIEW_FREQUENCY: 'Weekly automated alert review with monthly manual audit',
};

interface StackOption<T extends string> {
  id: T;
  title: string;
  badge: string;
  recommended: boolean;
  desc: string;
  features: string[];
}

/** Identity helper: checks every option id against the profile's union instead of widening to string. */
function stackOptions<T extends string>(options: StackOption<T>[]): StackOption<T>[] {
  return options;
}

const DEFAULT_STACK: EnclaveStackProfile = {
  identityProvider: 'ENTRA_ID_COMMERCIAL',
  edrSolution: 'DEFENDER_FOR_ENDPOINT',
  infrastructure: 'AZURE_GOV',
  mdmSolution: 'INTUNE',
  siemSolution: 'SENTINEL',
  odpParams: DEFAULT_ODP_PARAMS,
};

export const EnclaveStackSurveyModal: React.FC<EnclaveStackSurveyModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const { currentTenant, updateStackProfile, canEdit } = useTenant();

  const [activeTab, setActiveTab] = useState<WizardTab>('identity');
  const [isSaving, setIsSaving] = useState(false);
  const [successNotice, setSuccessNotice] = useState(false);

  // Initialize from tenant's existing profile or default
  const [stack, setStack] = useState<EnclaveStackProfile>(() => {
    return {
      identityProvider: currentTenant.stackProfile?.identityProvider || DEFAULT_STACK.identityProvider,
      edrSolution: currentTenant.stackProfile?.edrSolution || DEFAULT_STACK.edrSolution,
      infrastructure: currentTenant.stackProfile?.infrastructure || DEFAULT_STACK.infrastructure,
      mdmSolution: currentTenant.stackProfile?.mdmSolution || DEFAULT_STACK.mdmSolution,
      siemSolution: currentTenant.stackProfile?.siemSolution || DEFAULT_STACK.siemSolution,
      odpParams: {
        ...DEFAULT_ODP_PARAMS,
        ...(currentTenant.stackProfile?.odpParams || {}),
      },
    };
  });

  // Keep in sync when currentTenant changes
  useEffect(() => {
    if (currentTenant.stackProfile) {
      setStack({
        identityProvider: currentTenant.stackProfile.identityProvider,
        edrSolution: currentTenant.stackProfile.edrSolution,
        infrastructure: currentTenant.stackProfile.infrastructure,
        mdmSolution: currentTenant.stackProfile.mdmSolution,
        siemSolution: currentTenant.stackProfile.siemSolution,
        odpParams: {
          ...DEFAULT_ODP_PARAMS,
          ...(currentTenant.stackProfile.odpParams || {}),
        },
      });
    }
  }, [currentTenant.id, currentTenant.stackProfile]);

  if (!isOpen) return null;

  const handleOdpChange = (key: string, value: string) => {
    setStack((prev) => ({
      ...prev,
      odpParams: {
        ...prev.odpParams,
        [key]: value,
      },
    }));
  };

  const handleResetOdpDefaults = () => {
    setStack((prev) => ({
      ...prev,
      odpParams: { ...DEFAULT_ODP_PARAMS },
    }));
  };

  const handleSaveAndCascade = async () => {
    if (!canEdit) {
      alert('Read-Only mode: You do not have permissions to modify enclave configuration.');
      return;
    }

    setIsSaving(true);
    try {
      // 1. Update TenantContext (which also updates tenant and cascades to objectives storage)
      updateStackProfile(stack);

      if (onSaved) {
        onSaved(stack);
      }

      setSuccessNotice(true);
      setTimeout(() => {
        setSuccessNotice(false);
        onClose();
      }, 1200);
    } catch (err) {
      console.error('Failed to save enclave stack:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const tabs: { id: WizardTab; label: string; icon: React.ElementType; valueLabel: string }[] = [
    {
      id: 'identity',
      label: 'Identity (IAM)',
      icon: KeyRound,
      valueLabel:
        stack.identityProvider === 'ENTRA_ID_GOV'
          ? 'Entra ID Gov'
          : stack.identityProvider === 'ENTRA_ID_COMMERCIAL'
          ? 'Entra ID Commercial'
          : stack.identityProvider === 'OKTA'
          ? 'Okta'
          : 'Active Directory',
    },
    {
      id: 'edr',
      label: 'EDR & Protection',
      icon: ShieldAlert,
      valueLabel:
        stack.edrSolution === 'CROWDSTRIKE_FALCON'
          ? 'CrowdStrike'
          : stack.edrSolution === 'DEFENDER_FOR_ENDPOINT'
          ? 'Defender Plan 2'
          : stack.edrSolution === 'SENTINELONE'
          ? 'SentinelOne'
          : 'Commercial AV',
    },
    {
      id: 'cloud',
      label: 'Cloud & Infrastructure',
      icon: Cloud,
      valueLabel:
        stack.infrastructure === 'AZURE_GOV'
          ? 'Azure Gov'
          : stack.infrastructure === 'AWS_GOVCLOUD'
          ? 'AWS GovCloud'
          : stack.infrastructure === 'HYBRID_CLOUD'
          ? 'Hybrid Cloud'
          : 'Air-Gapped RHEL',
    },
    {
      id: 'mdm',
      label: 'MDM & Fleets',
      icon: Smartphone,
      valueLabel:
        stack.mdmSolution === 'INTUNE'
          ? 'Intune'
          : stack.mdmSolution === 'JAMF'
          ? 'Jamf Pro'
          : stack.mdmSolution === 'WORKSPACE_ONE'
          ? 'Workspace ONE'
          : 'Manual GPO',
    },
    {
      id: 'siem',
      label: 'SIEM & Logging',
      icon: Activity,
      valueLabel:
        stack.siemSolution === 'SENTINEL'
          ? 'Sentinel'
          : stack.siemSolution === 'SPLUNK_GOV'
          ? 'Splunk Gov'
          : stack.siemSolution === 'ELASTIC'
          ? 'Elastic'
          : 'Syslog / Auditd',
    },
    {
      id: 'odp',
      label: 'ODP Parameters',
      icon: Sliders,
      valueLabel: `${Object.keys(stack.odpParams || {}).length} Parameters`,
    },
  ];

  const currentTabIndex = tabs.findIndex((t) => t.id === activeTab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 overflow-y-auto bg-slate-950/85 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-5xl rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="px-6 py-4 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30 shadow-inner">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Enclave Stack Survey & Objective Engine
                </h3>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800/60 font-semibold">
                  {currentTenant.name} ({currentTenant.cageCode || 'CAGE'})
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Select your defense enclave's core technologies and Organization-Defined Parameters (ODP) to cascade tool-specific narratives.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Wizard Tab Navigation */}
        <div className="px-6 bg-slate-950/50 border-b border-slate-800/80 flex items-center gap-2 overflow-x-auto shrink-0 py-2">
          {tabs.map((tab, idx) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-mono ${
                    isActive ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {idx + 1}
                </div>
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                <span className="text-[10px] text-slate-500 hidden md:inline font-mono">({tab.valueLabel})</span>
              </button>
            );
          })}
        </div>

        {/* Wizard Tab Content */}
        <div className="p-6 overflow-y-auto flex-1 min-h-[400px] bg-slate-900/60">
          {/* TAB 1: Identity Provider */}
          {activeTab === 'identity' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-cyan-400" />
                  Select Primary Identity & Authentication Provider
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Powers objective statements across Access Control (AC-2, AC-3) and Identification & Authentication (IA-2, IA-5).
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {stackOptions<EnclaveStackProfile['identityProvider']>([
                  {
                    id: 'ENTRA_ID_GOV',
                    title: 'Microsoft Entra ID (GovCloud / GCC High)',
                    badge: 'DoD IL4 / IL5',
                    recommended: true,
                    desc: 'FedRAMP High sovereign identity with FIDO2 passwordless MFA, Conditional Access, and GCC High directory synchronization.',
                    features: ['FIDO2 Phishing-Resistant MFA', 'Conditional Access Policies', 'FedRAMP High / DoD IL5'],
                  },
                  {
                    id: 'ENTRA_ID_COMMERCIAL',
                    title: 'Microsoft Entra ID (Commercial)',
                    badge: 'COMMERCIAL / M365',
                    recommended: false,
                    desc: 'Commercial Microsoft 365 / Entra ID tenant with authenticator push MFA, Single Sign-On, and cloud identity management.',
                    features: ['Microsoft Authenticator MFA', 'Enterprise Application SSO', 'Standard Azure AD P1/P2'],
                  },
                  {
                    id: 'OKTA',
                    title: 'Okta Identity Cloud',
                    badge: 'FEDRAMP MODERATE',
                    recommended: false,
                    desc: 'Enterprise cloud identity provider with Okta FastPass, adaptive risk-based authentication, and universal directory.',
                    features: ['Okta FastPass Biometrics', 'Adaptive MFA Policies', 'Cross-Platform Federation'],
                  },
                  {
                    id: 'ACTIVE_DIRECTORY',
                    title: 'On-Premises Active Directory DS',
                    badge: 'SELF-HOSTED / AIR-GAP',
                    recommended: false,
                    desc: 'Self-hosted Windows Server Active Directory domain controllers with Kerberos, LDAP, and smart card (PIV/CAC) authentication.',
                    features: ['Local Domain Controllers', 'Kerberos & PIV/CAC Smartcard', 'On-Premises Group Policy (GPO)'],
                  },
                ]).map((opt) => {
                  const isSelected = stack.identityProvider === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setStack((prev) => ({ ...prev, identityProvider: opt.id }))}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/30'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-sm font-bold text-white">{opt.title}</span>
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                              opt.recommended
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed mb-3">{opt.desc}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {opt.features.map((f, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                              {f}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2 ${
                            isSelected ? 'bg-cyan-400 text-slate-950' : 'border border-slate-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: EDR & Antivirus */}
          {activeTab === 'edr' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-cyan-400" />
                  Select Endpoint Detection & Response (EDR) Solution
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Tailors System & Information Integrity (SI-2, SI-3, SI-4) narratives with vendor-specific sensor baselines.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {stackOptions<EnclaveStackProfile['edrSolution']>([
                  {
                    id: 'DEFENDER_FOR_ENDPOINT',
                    title: 'Microsoft Defender for Endpoint (Plan 2)',
                    badge: 'FEDRAMP HIGH',
                    recommended: true,
                    desc: 'Cloud-native behavioral protection, automated threat remediation, and deep integration with Microsoft Sentinel and Intune.',
                    features: ['Automated Investigation & Response', 'Behavioral Antivirus & EDR', 'Live Response & Tamper Protection'],
                  },
                  {
                    id: 'CROWDSTRIKE_FALCON',
                    title: 'CrowdStrike Falcon (GovCloud)',
                    badge: 'DoD IL4 / FEDRAMP HIGH',
                    recommended: false,
                    desc: 'AI-native single lightweight sensor with 24/7 Falcon Complete threat hunting, host isolation, and zero-day protection.',
                    features: ['Zero-Downtime Kernel Sensor', 'OverWatch Threat Hunting', 'Network & Process Quarantine'],
                  },
                  {
                    id: 'SENTINELONE',
                    title: 'SentinelOne Singularity',
                    badge: 'FEDRAMP HIGH',
                    recommended: false,
                    desc: 'Autonomous endpoint defense engine with behavioral AI, 1-Click Rollback against ransomware, and on-agent behavioral analysis.',
                    features: ['Storyline Threat Tracking', '1-Click Remediation & Rollback', 'Disconnected Offline Agent AI'],
                  },
                  {
                    id: 'GENERIC_AV',
                    title: 'Commercial Antivirus & Host Firewall',
                    badge: 'BASELINE FCI',
                    recommended: false,
                    desc: 'Traditional signature-based antivirus protection with daily virus definition updates, host firewall, and real-time disk scanning.',
                    features: ['Daily Signature Definitions', 'Real-Time File Scanning', 'Host Perimeter Firewall'],
                  },
                ]).map((opt) => {
                  const isSelected = stack.edrSolution === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setStack((prev) => ({ ...prev, edrSolution: opt.id }))}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/30'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-sm font-bold text-white">{opt.title}</span>
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                              opt.recommended
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed mb-3">{opt.desc}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {opt.features.map((f, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                              {f}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2 ${
                            isSelected ? 'bg-cyan-400 text-slate-950' : 'border border-slate-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: Cloud & Hosting Infrastructure */}
          {activeTab === 'cloud' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-cyan-400" />
                  Select Cloud & Hosting Boundary Infrastructure
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Establishes shared responsibility inheritance and cryptographic boundaries for System & Communications Protection (SC-7, SC-8, SC-13).
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {stackOptions<EnclaveStackProfile['infrastructure']>([
                  {
                    id: 'AZURE_GOV',
                    title: 'Microsoft Azure Government (GCC High)',
                    badge: 'DoD IL4 / IL5',
                    recommended: true,
                    desc: 'US sovereign cloud meeting DoD IL4, IL5, and CJIS requirements with FedRAMP High physical and logical isolation.',
                    features: ['Conus-Only Personnel Screened', 'Azure Policy CMMC Initiatives', 'FIPS 140-3 Cryptography'],
                  },
                  {
                    id: 'AWS_GOVCLOUD',
                    title: 'AWS GovCloud (US)',
                    badge: 'DoD IL4 / IL5',
                    recommended: false,
                    desc: 'Isolated AWS region specifically designed to host sensitive data and regulated defense workloads with FedRAMP High authorization.',
                    features: ['ITAR & Export Controlled Boundaries', 'AWS Security Hub / GuardDuty', 'DoD Cloud Computing SRG IL4/5'],
                  },
                  {
                    id: 'HYBRID_CLOUD',
                    title: 'Hybrid Cloud Enclave',
                    badge: 'HYBRID BOUNDARY',
                    recommended: false,
                    desc: 'Sovereign cloud SaaS/IaaS boundary interconnected with dedicated on-premises facility hardware via IPsec VPN or DirectConnect.',
                    features: ['Dedicated Hardware Interconnect', 'Split-Tunneling Disabled', 'Zero Trust Egress Firewalls'],
                  },
                  {
                    id: 'ON_PREM_RHEL',
                    title: 'Air-Gapped / On-Premises RHEL & VMware',
                    badge: 'AIR-GAPPED / ON-PREM',
                    recommended: false,
                    desc: 'Physically separated and air-gapped facility datacenter running Red Hat Enterprise Linux 8/9 STIG baselines and VMware vSphere.',
                    features: ['Complete Network Isolation', 'OpenSCAP DISA STIG Automated', 'Physical Security Perimeter (PE)'],
                  },
                ]).map((opt) => {
                  const isSelected = stack.infrastructure === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setStack((prev) => ({ ...prev, infrastructure: opt.id }))}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/30'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-sm font-bold text-white">{opt.title}</span>
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                              opt.recommended
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed mb-3">{opt.desc}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {opt.features.map((f, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                              {f}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2 ${
                            isSelected ? 'bg-cyan-400 text-slate-950' : 'border border-slate-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 4: Mobile Device Management (MDM) */}
          {activeTab === 'mdm' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-cyan-400" />
                  Select Endpoint & Mobile Device Management (MDM)
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Enforces device enrollment, BitLocker / FileVault disk encryption, and session screen locks (AC-11, MP-5, CM-6).
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {stackOptions<EnclaveStackProfile['mdmSolution']>([
                  {
                    id: 'INTUNE',
                    title: 'Microsoft Intune',
                    badge: 'RECOMMENDED',
                    recommended: true,
                    desc: 'Enterprise endpoint management enforcing Windows BitLocker encryption (XTS-AES 256), automated OS patch rings, and remote wipe.',
                    features: ['BitLocker Hardware Key Escrow', 'Inactivity Session Lock 15min', 'Compliance Conditional Access'],
                  },
                  {
                    id: 'JAMF',
                    title: 'Jamf Pro',
                    badge: 'APPLE ENCLAVE',
                    recommended: false,
                    desc: 'Apple enterprise fleet management for macOS and iOS devices with FileVault escrow, CIS benchmark enforcement, and config profiles.',
                    features: ['FileVault 2 Key Management', 'macOS CIS Hardening Profiles', 'Automated Apple Silicon MDM'],
                  },
                  {
                    id: 'WORKSPACE_ONE',
                    title: 'VMware Workspace ONE',
                    badge: 'ENTERPRISE UEM',
                    recommended: false,
                    desc: 'Unified endpoint management across heterogeneous fleets (Windows, macOS, Linux, mobile) with automated compliance baselines.',
                    features: ['Cross-Platform Fleet Control', 'Air-Gapped Relay Support', 'Per-App VPN & Microsegmentation'],
                  },
                  {
                    id: 'MANUAL_GPO',
                    title: 'Manual Group Policy (GPO) & Hardware Locking',
                    badge: 'AIR-GAP / ON-PREM',
                    recommended: false,
                    desc: 'Traditional Active Directory Domain Group Policy Objects (GPOs), physical USB device port locking, and local administrative controls.',
                    features: ['AD GPO Security Baselines', 'USB Mass Storage Block Policies', 'Air-Gapped Fleet Custody'],
                  },
                ]).map((opt) => {
                  const isSelected = stack.mdmSolution === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setStack((prev) => ({ ...prev, mdmSolution: opt.id }))}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/30'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-sm font-bold text-white">{opt.title}</span>
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                              opt.recommended
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed mb-3">{opt.desc}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {opt.features.map((f, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                              {f}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2 ${
                            isSelected ? 'bg-cyan-400 text-slate-950' : 'border border-slate-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 5: SIEM & Centralized Logging */}
          {activeTab === 'siem' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  Select SIEM & Centralized Audit Log Server
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Establishes the centralized log ingestion, retention, and anomaly alerting repository for Audit & Accountability (AU-2, AU-3, AU-6, AU-11).
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {stackOptions<EnclaveStackProfile['siemSolution']>([
                  {
                    id: 'SENTINEL',
                    title: 'Microsoft Sentinel (Azure Gov)',
                    badge: 'RECOMMENDED',
                    recommended: true,
                    desc: 'Cloud-native SIEM and SOAR with automated incident response playbooks, 365-day cold archive retention, and CMMC compliance workbooks.',
                    features: ['Automated Threat Hunting Rules', 'Log Analytics Workspace Isolation', 'DoD CMMC Ready Workbooks'],
                  },
                  {
                    id: 'SPLUNK_GOV',
                    title: 'Splunk Cloud GovCloud',
                    badge: 'FEDRAMP HIGH',
                    recommended: false,
                    desc: 'Enterprise security information and event management in AWS GovCloud with real-time SPL search, correlation searches, and retention tiers.',
                    features: ['Splunk Enterprise Security (ES)', 'Immutable Cold Storage Buckets', 'Custom SPL Correlation Rules'],
                  },
                  {
                    id: 'ELASTIC',
                    title: 'Elastic Security (ELK Stack)',
                    badge: 'SELF-HOSTED / CLOUD',
                    recommended: false,
                    desc: 'Open-source or Elastic Cloud SIEM with Elasticsearch indexing, Logstash syslog pipelines, Kibana dashboards, and custom alert rules.',
                    features: ['Logstash Syslog Pipelines', 'Custom Lucene Threat Queries', 'On-Premises or Cloud Cluster'],
                  },
                  {
                    id: 'LOCAL_AUDITD',
                    title: 'Local Syslog / Auditd Forwarder',
                    badge: 'AIR-GAP / ON-PREM',
                    recommended: false,
                    desc: 'Encrypted syslog forwarders (rsyslog / auditd) sending logs to a dedicated, write-once immutable storage server inside the air-gap enclave.',
                    features: ['Write-Once Read-Many (WORM)', 'TLS Encrypted Syslog Stream', 'Local SHA-256 Checksums'],
                  },
                ]).map((opt) => {
                  const isSelected = stack.siemSolution === opt.id;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setStack((prev) => ({ ...prev, siemSolution: opt.id }))}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/30'
                          : 'bg-slate-850/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-sm font-bold text-white">{opt.title}</span>
                          <span
                            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                              opt.recommended
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {opt.badge}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed mb-3">{opt.desc}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {opt.features.map((f, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                              {f}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-2 ${
                            isSelected ? 'bg-cyan-400 text-slate-950' : 'border border-slate-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 6: Organization-Defined Parameters (ODP) */}
          {activeTab === 'odp' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-cyan-400" />
                    Organization-Defined Parameters (ODP)
                  </h4>
                  <p className="text-xs text-slate-400 mt-1">
                    Standardize organizational timeouts, patch SLAs, and audit retention cadences per NIST SP 800-53 Rev. 5 & 800-171.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleResetOdpDefaults}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Restore Standard DoD Defaults</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {[
                  {
                    key: 'INACTIVITY_TIMEOUT',
                    label: 'Session Inactivity Lockout',
                    controlRef: 'AC-11 / 3.1.10',
                    helper: 'Time of user inactivity before screen automatically locks with password challenge.',
                  },
                  {
                    key: 'LOCKOUT_LIMIT',
                    label: 'Invalid Logon Attempt Threshold',
                    controlRef: 'AC-7 / 3.1.8',
                    helper: 'Number of consecutive invalid logon attempts before account enters lockout.',
                  },
                  {
                    key: 'LOCKOUT_DURATION',
                    label: 'Account Lockout Duration',
                    controlRef: 'AC-7 / 3.1.8',
                    helper: 'Period an account remains locked or condition required to unlock.',
                  },
                  {
                    key: 'AUDIT_RETENTION_PERIOD',
                    label: 'Audit Log Retention SLA',
                    controlRef: 'AU-11 / 3.3.1',
                    helper: 'Time audit logs and event telemetry must be retained for forensic review.',
                  },
                  {
                    key: 'CRITICAL_PATCH_SLA',
                    label: 'Critical Vulnerability Patch SLA',
                    controlRef: 'SI-2 / 3.14.1',
                    helper: 'Maximum timeframe to test and deploy patches for Critical (CVSS 9.0+) flaws.',
                  },
                  {
                    key: 'HIGH_PATCH_SLA',
                    label: 'High Vulnerability Patch SLA',
                    controlRef: 'SI-2 / 3.14.1',
                    helper: 'Maximum timeframe to test and deploy patches for High (CVSS 7.0-8.9) flaws.',
                  },
                  {
                    key: 'ACCESS_REVIEW_CADENCE',
                    label: 'Privileged Access Review Cadence',
                    controlRef: 'AC-2 / 3.1.2',
                    helper: 'Frequency of formal role-based and administrator privilege reviews.',
                  },
                  {
                    key: 'BACKUP_CADENCE',
                    label: 'System Backup Replication Cadence',
                    controlRef: 'CP-9 / 3.8.9',
                    helper: 'Cadence of differential and full system state snapshots replicated offsite.',
                  },
                  {
                    key: 'LOG_REVIEW_FREQUENCY',
                    label: 'Audit Telemetry Review Cadence',
                    controlRef: 'AU-6 / 3.3.5',
                    helper: 'Frequency of automated alert queries and manual security lead sign-offs.',
                  },
                ].map((item) => {
                  const currentValue = stack.odpParams?.[item.key] || DEFAULT_ODP_PARAMS[item.key] || '';
                  return (
                    <div
                      key={item.key}
                      className="p-4 rounded-2xl bg-slate-850/80 border border-slate-800 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-bold text-white">{item.label}</label>
                        <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-900/60">
                          {item.controlRef}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">{item.helper}</p>
                      <input
                        type="text"
                        value={currentValue}
                        onChange={(e) => handleOdpChange(item.key, e.target.value)}
                        placeholder={`e.g. ${DEFAULT_ODP_PARAMS[item.key]}`}
                        className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700/80 text-xs text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 font-mono transition-colors"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Selected Stack Quick-Pills Ribbon */}
        <div className="px-6 py-2.5 bg-slate-950 border-t border-slate-800/80 flex items-center gap-2 overflow-x-auto text-[11px] font-mono text-slate-400 shrink-0">
          <span className="text-slate-500 font-sans font-semibold text-xs">Active Profile:</span>
          <span className="px-2 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-800/40">
            IAM: {tabs[0].valueLabel}
          </span>
          <span className="px-2 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-800/40">
            EDR: {tabs[1].valueLabel}
          </span>
          <span className="px-2 py-0.5 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40">
            Cloud: {tabs[2].valueLabel}
          </span>
          <span className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40">
            MDM: {tabs[3].valueLabel}
          </span>
          <span className="px-2 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800/40">
            SIEM: {tabs[4].valueLabel}
          </span>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-start">
            <button
              type="button"
              disabled={currentTabIndex === 0}
              onClick={() => setActiveTab(tabs[currentTabIndex - 1].id)}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white disabled:opacity-40 disabled:hover:bg-slate-800 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Previous</span>
            </button>

            {currentTabIndex < tabs.length - 1 ? (
              <button
                type="button"
                onClick={() => setActiveTab(tabs[currentTabIndex + 1].id)}
                className="px-3.5 py-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
              >
                <span>Next ({tabs[currentTabIndex + 1].label})</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            {successNotice && (
              <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5 animate-fadeIn">
                <CheckCircle2 className="w-4 h-4" />
                <span>Stack Saved & Objectives Cascaded!</span>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold transition-colors"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSaveAndCascade}
              disabled={isSaving}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-cyan-500/25 flex items-center gap-2 transition-all disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-cyan-200" />
              <span>{isSaving ? 'Cascading to Objectives...' : 'Save Stack & Cascade to All Objectives'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
