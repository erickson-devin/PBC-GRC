import React from 'react';
import {
  BookOpen,
  Shield,
  AlertTriangle,
  Lock,
  Layers,
  Sparkles,
} from 'lucide-react';
import { DOMAINS, CMMC_LEVEL_1_CONTROLS } from '../../data/cmmcLevel1Controls';
import { DomainCode } from '../../types/cmmc';
import { useAssessment } from '../../context/AssessmentContext';

export const AssessmentGuidanceView: React.FC = () => {
  const { setSelectedDomainFilter, setActiveTab } = useAssessment();

  return (
    <div className="space-y-8 animate-fadeIn max-w-5xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
          <BookOpen className="w-6 h-6 text-brand-400" />
          CMMC Level 1 & FAR 52.204-21 Practitioner Guide
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Essential regulatory frameworks, assessment scoping rules, and SPRS reporting standards for defense contractors.
        </p>
      </div>

      {/* Critical Rules Accordion / Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Rule 1: Zero POA&Ms */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Zero POA&M Rule</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Under CMMC 2.0 Level 1, <strong>Plans of Action & Milestones (POA&Ms) are NOT permitted</strong>. All 17 controls must be completely implemented and evaluated as <strong className="text-emerald-400">MET</strong> before an organization can claim Level 1 compliance.
          </p>
        </div>

        {/* Rule 2: Annual Self-Assessment */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-400 flex items-center justify-center">
            <Shield className="w-5 h-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Annual Self-Attestation</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            CMMC Level 1 requires an <strong>annual self-assessment</strong> and executive affirmation entered into the Supplier Performance Risk System (SPRS) signed by a senior corporate official (C-Suite).
          </p>
        </div>

        {/* Rule 3: FCI vs CUI */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
            <Lock className="w-5 h-5" />
          </div>
          <h3 className="text-sm font-bold text-white">FCI Protection Scope</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Level 1 safeguards <strong>Federal Contract Information (FCI)</strong>—information not intended for public release, provided by or generated for the Government under a contract. (Controlled Unclassified Information requires Level 2).
          </p>
        </div>
      </div>

      {/* Deep-Dive Sections */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-xl">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <Layers className="w-5 h-5 text-brand-400" />
          The 6 Level 1 Security Domains Explained
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(Object.keys(DOMAINS) as DomainCode[]).map((code) => {
            const d = DOMAINS[code];
            const controlsInDomain = CMMC_LEVEL_1_CONTROLS.filter((c) => c.domain === code);

            return (
              <div
                key={code}
                className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-3 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded"
                      style={{
                        backgroundColor: `${d.color}20`,
                        color: d.color,
                        border: `1px solid ${d.color}40`,
                      }}
                    >
                      {code} • {d.name}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">
                      {d.totalControls} {d.totalControls === 1 ? 'Practice' : 'Practices'}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">{d.description}</p>
                </div>

                <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs">
                  <span className="text-slate-400 font-mono">
                    {controlsInDomain.map((c) => c.id.replace('.L1-', '-')).join(', ')}
                  </span>
                  <button
                    onClick={() => {
                      setSelectedDomainFilter(code);
                      setActiveTab('controls');
                    }}
                    className="text-brand-400 hover:text-brand-300 font-semibold"
                  >
                    View Controls →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Small Business Blueprint */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-4 shadow-xl">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-brand-400" />
          Recommended Small Business Compliance Stack
        </h3>
        <p className="text-xs text-slate-300 leading-relaxed">
          For small contractors looking for the most cost-effective and auditor-proven stack to satisfy all 17 practices:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-brand-400 block">Identity & Access</span>
            <p className="text-slate-300">Microsoft Entra ID + Number-matching MFA for 100% of accounts. Role-Based Access Control.</p>
          </div>

          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-purple-400 block">Endpoint & EDR</span>
            <p className="text-slate-300">Microsoft Defender for Business (EDR) + Intune automated patch update rings.</p>
          </div>

          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-emerald-400 block">Disk Encryption & Media</span>
            <p className="text-slate-300">Windows BitLocker (AES-256) centrally enforced + DIN P-4 paper shredder.</p>
          </div>

          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-amber-400 block">Perimeter Security</span>
            <p className="text-slate-300">Next-Gen Firewall with default-deny inbound rules + isolated Guest Wi-Fi VLAN.</p>
          </div>

          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-sky-400 block">Physical Access</span>
            <p className="text-slate-300">Locked IT network cabinet + Reception Visitor Sign-In/Out logbook and escort protocol.</p>
          </div>

          <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
            <span className="font-bold text-pink-400 block">Public Information</span>
            <p className="text-slate-300">Formal pre-publication review process for marketing and public web posts.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
