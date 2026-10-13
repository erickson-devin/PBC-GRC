import React, { useState } from 'react';
import { X, FileText, Copy, Check, Download, ArrowRight, ShieldCheck } from 'lucide-react';
import { CMMC_LEVEL_1_CONTROLS } from '../../data/cmmcLevel1Controls';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyToClipboard } from '../../utils/clipboard';
interface SampleSspModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEnterApp: () => void;
}

export const SampleSspModal: React.FC<SampleSspModalProps> = ({ isOpen, onClose, onEnterApp }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const sampleMarkdown = `# SYSTEM SECURITY PLAN (SSP) - CMMC LEVEL 1 / FAR 52.204-21
**Document Version:** 1.0.0
**Organization:** Vanguard Defense Systems LLC
**CAGE Code:** 8K3R1 | **SAM.gov Status:** Active
**System Name:** Defense Contracting Information Network (DCIN)
**System Owner:** Alex Mercer, CMMC CCA
**Assessment Date:** ${new Date().toISOString().split('T')[0]}
**Cloud Storage (GCS) Enclave:** gs://pbc-grc-evidence-prod/tenants/tenant-vanguard-01/

## 1. System Scope & Boundary Description
The boundary for Vanguard Defense Systems LLC includes all corporate Microsoft 365 / Google Cloud tenant services, identity infrastructure, corporate managed endpoints (Windows 11 Enterprise laptops), internal facility network (VLAN 10), and Next-Generation Boundary Firewalls used for processing, storing, or transmitting Federal Contract Information (FCI).

## 2. Operating Environment & Cloud Service Providers (CSPs)
- **Environment:** Hybrid Cloud: SaaS / Cloud Identity + Corporate Facility On-Premises Network.
- **Authorized CSPs:** Microsoft 365, Google Cloud Platform (Cloud Storage / Cloud SQL), Cloudflare (DNS/DDoS).

## 3. 17 CMMC Level 1 Security Requirements Matrix (FAR 52.204-21)

${CMMC_LEVEL_1_CONTROLS.map(c => `### ${c.id}: ${c.title}
- **FAR Reference:** ${c.farReference}
- **Domain:** ${c.domain} - ${c.plainEnglishSummary}
- **Evaluation Status:** MET
- **Implementation Statement:** ${c.starterTemplates[0]?.narrative || 'Documented and verified.'}
`).join('\n')}`;

  const handleCopy = () => {
    copyToClipboard(sampleMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownload = () => {
    const blob = new Blob([sampleMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SAMPLE_CMMC_L1_SSP_Vanguard_Defense.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto bg-slate-950/80 backdrop-blur-md">
      <div 
        className="relative w-full max-w-4xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        
        {/* Modal Header */}
        <div className="px-6 py-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-500/20 text-brand-400 flex items-center justify-center border border-brand-500/30">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <DialogTitle as="h3" className="text-base font-bold text-white">Sample System Security Plan (SSP)</DialogTitle>
              <p className="text-xs text-slate-400">NIST SP 800-171 / FAR 52.204-21 Pre-compiled Template</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy Markdown'}</span>
            </button>

            <button
              onClick={handleDownload}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download .MD</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-6 overflow-y-auto font-mono text-xs text-slate-300 space-y-4 bg-slate-950/90 leading-relaxed">
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="text-brand-400 font-bold text-sm">SYSTEM SECURITY PLAN (SSP) - CMMC LEVEL 1</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300 pt-2 border-t border-slate-800">
              <div><strong>Organization:</strong> Apex Defense Solutions, LLC</div>
              <div><strong>CAGE Code:</strong> 9X7B4 (SAM.gov Active)</div>
              <div><strong>System Boundary:</strong> Corporate Operations Enclave (COE)</div>
              <div><strong>GCS Vault:</strong> gs://pbc-grc-evidence-prod/tenants/tenant-apex-01/</div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-white font-bold text-xs uppercase tracking-wider text-slate-400">17 Security Requirements Matrix:</h4>
            {CMMC_LEVEL_1_CONTROLS.map(ctrl => (
              <div key={ctrl.id} className="p-3 rounded-lg bg-slate-900/60 border border-slate-800/80 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-brand-400 font-bold">{ctrl.id}: {ctrl.title}</span>
                  <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-bold">MET</span>
                </div>
                <div className="text-xs text-slate-400">{ctrl.farReference} • {ctrl.domain}</div>
                <p className="text-xs text-slate-300 pt-1 border-t border-slate-800/50">
                  {ctrl.starterTemplates[0]?.narrative || 'Control requirements fully satisfied with corporate policy and cloud configuration.'}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Modal Footer CTA */}
        <div className="px-6 py-4 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Customize this SSP with your own organization details in the live app.</span>
          </div>
          <button
            onClick={() => { onClose(); onEnterApp(); }}
            className="btn-primary w-full sm:w-auto px-5 py-2.5 rounded-full font-semibold text-xs flex items-center justify-center gap-2"
          >
            <span>Open in Assessment Platform</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

      </div>
    </DialogOverlay>
  );
};
