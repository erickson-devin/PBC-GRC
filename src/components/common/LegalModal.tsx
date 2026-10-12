import React, { useState } from 'react';
import {
  X,
  Shield,
  FileText,
  Lock,
  Download,
  Copy,
  Check,
  Search,
  Printer,
  ExternalLink,
} from 'lucide-react';

import { DialogOverlay } from './DialogOverlay';
export type LegalTab = 'privacy' | 'terms';

interface LegalModalProps {
  isOpen: boolean;
  initialTab?: LegalTab;
  onClose: () => void;
}

export const LegalModal: React.FC<LegalModalProps> = ({
  isOpen,
  initialTab = 'privacy',
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  // Sync initialTab when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setSearchQuery('');
    }
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const privacySections = [
    {
      title: '1. Overview & Commitment to Defense Data Protection',
      content: `Pitch Black Cyber provides cybersecurity compliance software, automated System Security Plan (SSP) authoring tools, and cryptographic evidence vault management to Defense Industrial Base (DIB) contractors, aerospace organizations, and Managed Service Providers (MSPs).

Because our customers operate under strict Department of Defense (DoD) regulatory standards—including FAR 52.204-21, DFARS 252.204-7012, NIST SP 800-171, and CMMC 2.0 Level 1—we have designed our data practices around strict tenant isolation, cryptographic verification, and minimal data collection.`,
    },
    {
      title: '2. Information We Collect',
      content: `• Customer Account & Identity Information: Contact name, corporate work email, direct phone number, organization name, CAGE Code, SAM.gov status, and in-scope user count.
• Federated Authentication Claims: OAuth identity claims transmitted during Single Sign-On (Microsoft 365 / Entra ID or Google Workspace), including user principal names and cryptographic ID tokens. We never receive or store plaintext passwords.
• Compliance Assessment & Evidence Data: System Security Plan (SSP) details, network boundary narratives, designated system owners, custom control implementation statements, and uploaded audit evidence artifacts stored in Google Cloud Storage.
• Security & Audit Logs: Timestamps of control modifications, evidence uploads, export operations, IP addresses, and diagnostic telemetry necessary for CMMC Level 1 security audit trails.`,
    },
    {
      title: '3. How We Use Your Information',
      content: `We process customer data exclusively to deliver and secure our compliance enclave services:
1. Provisioning isolated tenant enclaves in Google Cloud SQL and Google Cloud Storage.
2. Generating compliance deliverables (System Security Plans, SPRS matrices, and evidence packages).
3. Identity verification and multi-factor federated access control.
4. Providing technical support and solutions architect guidance.
5. Maintaining immutable audit logs and detecting unauthorized access.

We DO NOT sell, monetize, rent, or trade your personal or organizational data. We DO NOT use your compliance narratives or evidence files to train public artificial intelligence models.`,
    },
    {
      title: '4. Multi-Tenant Data Isolation & Security Architecture',
      content: `• Cryptographic Evidence Integrity: Every evidence file uploaded to our Google Cloud Storage enclave is hashed client-side with SHA-256 before transit. Integrity hashes are verified upon retrieval to prevent tampering.
• Tenant Partitioning: Database records are partitioned using PostgreSQL Row-Level Security (RLS) ensuring strict logical segregation between contractor enclaves.
• Encryption in Transit & at Rest: All data in transit is encrypted using TLS 1.3. All persistent data in Google Cloud Storage and Google Cloud SQL is encrypted at rest using AES-256 with customer-managed or Google-managed keys.
• Sub-processor Compliance: All cloud infrastructure hosting PBC-GRC services (Google Cloud Platform) maintains FedRAMP certifications, ISO 27001, and SOC 2 Type II compliance.`,
    },
    {
      title: '5. Third-Party Sub-processors',
      content: `• Google Cloud Platform (GCP): Cloud Run, Cloud SQL, Cloud Storage, and Cloud Identity Platform.
• Microsoft Entra ID: Federated enterprise authentication for defense contractors utilizing Microsoft 365 GCC or Commercial.
• Cloudflare: DNS routing, DDoS mitigation, and edge TLS termination.`,
    },
    {
      title: '6. Data Retention & Deletion',
      content: `• Active Subscriptions: Retained for the duration of your active license agreement to support ongoing assessment baselines and C3PAO audits.
• Upon Contract Termination: Within thirty (30) days of subscription termination or upon explicit written request, customer tenant databases and Google Cloud Storage evidence objects will be permanently purged in accordance with DoD 5220.22-M / NIST SP 800-88 sanitization guidelines.
• Customer Backups: Administrators may export a complete JSON or Markdown archive of their entire assessment state and evidence manifest at any time via the top navigation bar.`,
    },
    {
      title: '7. Contact Information',
      content: `Pitch Black Cyber, LLC
Attention: Privacy & Information Security Officer
Email: privacy@pitchblackcyber.com
Support: support@pitchblackcyber.com
Website: https://pitchblackcyber.com`,
    },
  ];

  const termsSections = [
    {
      title: '1. Acceptance of Terms',
      content: `These Terms of Service ("Agreement") constitute a legally binding agreement between Pitch Black Cyber, LLC and the organization, company, or individual ("Customer", "you", or "your") accessing or using the PBC-GRC platform, website, API, or related compliance services (collectively, the "Service").

BY ACCESSING THE SERVICE, EXECUTING AN ORDER FORM, SUBMITTING A LICENSE REQUEST, OR LOGGING IN VIA SINGLE SIGN-ON (SSO), YOU AGREE TO BE BOUND BY THIS AGREEMENT.`,
    },
    {
      title: '2. Subscription Licenses & Tiers',
      content: `PBC-GRC is licensed on a predictable, flat annual subscription model across three commercial tiers:
• Foundational Enclave ($3,500 / year flat): Grants a dedicated, isolated compliance enclave for small suppliers and commercial organizations. Includes 1 enclave boundary (Cloud SQL RLS isolation), CMMC Level 1 (17 controls) or HIPAA/SOC 2 Type II, PDF artifact exporter, SHA-256 evidence vault, single-user owner administrative seat, and standard support.
• Defense Professional ($7,000 / year flat): Designed for DoD prime & sub-contractors handling Controlled Unclassified Information (CUI). Includes full CMMC Level 2 (110 controls), NIST SP 800-53 Rev 5 baselines with tactical overlays, DISA STIG script generator (Ansible & PowerShell), dynamic NIST SP 800-18 SSP & POA&M compiler, cross-framework evidence inheritance, and 5 user seats with RBAC.
• Enterprise & Assessor Enclave ($14,000 / year flat): Designed for defense MSPs, multi-CAGE enterprise conglomerates, and C3PAO assessor networks. Includes unlimited enclave boundaries, multi-tenant administrative switcher, OpenSCAP engine & asset sensor API integration, custom baseline overlays, dedicated database isolation, and priority 24/7 defense engineering support.

Annual licenses renew automatically at the end of each twelve (12) month term unless written notice of non-renewal is provided at least thirty (30) days prior to the expiration of the current term.`,
    },
    {
      title: '3. CMMC Regulatory Disclaimer & Advisory Nature',
      content: `CRITICAL NOTICE REGARDING DEFENSE CERTIFICATIONS:
PBC-GRC is a software-as-a-service compliance documentation, readiness tracking, and System Security Plan (SSP) generation tool.
1. Not a Certified C3PAO: Pitch Black Cyber is a technology provider, not a Certified Third-Party Assessment Organization (C3PAO), nor a representative of the Department of Defense (DoD) or the Cyber AB.
2. Readiness Tool: While PBC-GRC structures your evidence, narratives, and procedures strictly in accordance with FAR 52.204-21, DFARS 252.204-7012, and CMMC 2.0 Level 1 requirements, the use of this software does not constitute an official Department of Defense assessment or guarantee certification.
3. Customer Responsibility: Customer remains solely responsible for the actual implementation, enforcement, operational verification, and accuracy of the technical security safeguards and statements documented within the platform.`,
    },
    {
      title: '4. Customer Data, Ownership & Intellectual Property',
      content: `• Customer Data Ownership: Customer retains all right, title, and interest (including all intellectual property and proprietary rights) in and to all data, System Security Plans, control narratives, organizational metadata, and evidence files uploaded or created by Customer within the Service. Pitch Black Cyber acquires no ownership rights in Customer Data.
• Platform Intellectual Property: Pitch Black Cyber retains all right, title, and interest in and to the PBC-GRC platform, software architecture, user interfaces, control mapping algorithms, documentation templates, visual designs, and logos.
• Data Portability: Customer may export its complete compliance dataset, System Security Plans, and evidence manifests in open standards (JSON and Markdown) at any time during an active subscription without penalty or proprietary lock-in.`,
    },
    {
      title: '5. Acceptable Use Policy & Defense Security Standards',
      content: `Customer agrees that it shall not, and shall not permit any authorized user to:
1. Classified Information Prohibition: Upload, transmit, or process any Classified National Security Information (Confidential, Secret, or Top Secret) within the Service. PBC-GRC is designed for Federal Contract Information (FCI) and unclassified compliance assessments.
2. Tampering & Reverse Engineering: Reverse engineer, decompile, disassemble, or attempt to derive the source code or underlying schemas of the Service.
3. Unauthorized Penetration Testing: Perform denial-of-service (DoS) attacks, automated penetration scans, or vulnerability exploitation against the production infrastructure without prior written authorization from Pitch Black Cyber.
4. Credential Security: Share user login credentials or bypass federated Single Sign-On (SSO) multi-factor authentication requirements.`,
    },
    {
      title: '6. Service Availability & Support',
      content: `• Uptime Commitment: Pitch Black Cyber utilizes enterprise Google Cloud Platform (GCP) infrastructure engineered for high availability (99.9% targeted uptime, excluding scheduled maintenance).
• Technical Support: Standard email and solutions architect support is available Monday through Friday during standard business hours via support@pitchblackcyber.com.`,
    },
    {
      title: '7. Limitation of Liability',
      content: `TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:
1. IN NO EVENT SHALL PITCH BLACK CYBER, LLC BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES (INCLUDING LOSS OF PROFITS, REVENUE, DATA, OR DEFENSE CONTRACT OPPORTUNITIES).
2. PITCH BLACK CYBER'S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT SHALL BE STRICTLY LIMITED TO THE TOTAL AMOUNT PAID BY CUSTOMER HEREUNDER FOR THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING THE INCIDENT GIVING RISE TO LIABILITY.`,
    },
    {
      title: '8. Governing Law & Dispute Resolution',
      content: `This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to its conflict of law principles. Any dispute arising out of or relating to this Agreement shall be resolved through binding arbitration administered in accordance with the American Arbitration Association (AAA) commercial arbitration rules.`,
    },
    {
      title: '9. Contact & Notices',
      content: `Pitch Black Cyber, LLC
Attention: Legal & Contracts Department
Email: legal@pitchblackcyber.com
Support: support@pitchblackcyber.com
Website: https://pitchblackcyber.com`,
    },
  ];

  const currentSections = activeTab === 'privacy' ? privacySections : termsSections;

  const filteredSections = searchQuery.trim()
    ? currentSections.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.content.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : currentSections;

  const fullText = currentSections.map((s) => `${s.title}\n\n${s.content}`).join('\n\n---\n\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const filename = activeTab === 'privacy' ? 'PBC_GRC_Privacy_Policy.txt' : 'PBC_GRC_Terms_of_Service.txt';
    const blob = new Blob([fullText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>${activeTab === 'privacy' ? 'Privacy Policy' : 'Terms of Service'} — Pitch Black Cyber</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 40px; color: #111; max-width: 800px; margin: 0 auto; }
              h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 20px; }
              h2 { font-size: 18px; margin-top: 24px; color: #1e293b; }
              p { white-space: pre-line; margin-bottom: 16px; font-size: 14px; }
              .meta { font-size: 12px; color: #64748b; margin-bottom: 30px; }
            </style>
          </head>
          <body>
            <h1>${activeTab === 'privacy' ? 'Pitch Black Cyber — Privacy Policy' : 'Pitch Black Cyber — Terms of Service'}</h1>
            <div class="meta">Effective Date: September 1, 2026 | Product: PBC-GRC (grc.pitchblackcyber.com) | Entity: Pitch Black Cyber, LLC</div>
            ${currentSections
              .map(
                (s) => `
              <h2>${s.title}</h2>
              <p>${s.content}</p>
            `
              )
              .join('')}
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 250);
    }
  };

  return (
    <DialogOverlay label="Legal documents" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-fadeIn">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-slate-800 bg-slate-950/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center text-brand-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Pitch Black Cyber Legal Center
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold">
                  Effective Sept 2026
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Defense Industrial Base compliance policies & SaaS subscription agreement
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              aria-label="Close Legal Modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Selector & Controls Bar */}
        <div className="px-6 py-3 bg-slate-900/60 border-b border-slate-800 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Document Tabs */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800 self-start">
            <button
              onClick={() => setActiveTab('privacy')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                activeTab === 'privacy'
                  ? 'bg-brand-600 text-white shadow-md shadow-brand-500/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-850'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Privacy Policy</span>
            </button>

            <button
              onClick={() => setActiveTab('terms')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                activeTab === 'terms'
                  ? 'bg-brand-600 text-white shadow-md shadow-brand-500/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-850'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Terms of Service</span>
            </button>
          </div>

          {/* Search + Action Icons */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
              <input
                type="text"
                placeholder="Search clause or policy..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
              />
            </div>

            <button
              onClick={handleCopy}
              title="Copy Document Text"
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700/80 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>

            <button
              onClick={handleDownload}
              title="Download Document"
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700/80 transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>

            <button
              onClick={handlePrint}
              title="Print Document"
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700/80 transition-colors"
            >
              <Printer className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Document Content Scroll Area */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8 space-y-6 text-slate-300 text-xs sm:text-sm leading-relaxed">
          {/* Document Header Banner */}
          <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div>
              <span className="font-bold text-white">
                {activeTab === 'privacy'
                  ? 'Pitch Black Cyber, LLC — Platform Privacy Policy'
                  : 'Pitch Black Cyber, LLC — Master Subscription Terms of Service'}
              </span>
              <p className="text-slate-400 text-xs mt-0.5">
                Governing grc.pitchblackcyber.com • Dedicated CMMC 2.0 & FAR 52.204-21 Enclaves
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 font-mono text-xs text-slate-300">
                Ver: 2026.1
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-brand-500/15 border border-brand-500/30 font-mono text-xs text-brand-300">
                Delaware, USA
              </span>
            </div>
          </div>

          {filteredSections.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              No matching sections found for "{searchQuery}".
            </div>
          ) : (
            filteredSections.map((section, idx) => (
              <section key={idx} className="space-y-2 pb-5 border-b border-slate-800/60 last:border-b-0">
                <h4 className="text-sm sm:text-base font-bold text-white tracking-tight flex items-center gap-2">
                  <span className="text-brand-400">§</span>
                  <span>{section.title}</span>
                </h4>
                <p className="text-slate-300 text-xs sm:text-sm whitespace-pre-line leading-relaxed font-normal">
                  {section.content}
                </p>
              </section>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/80 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-4">
            <span>Questions?</span>
            <a
              href="mailto:legal@pitchblackcyber.com"
              className="text-brand-400 hover:text-brand-300 font-medium flex items-center gap-1"
            >
              <span>legal@pitchblackcyber.com</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition-colors"
            >
              Close Window
            </button>
          </div>
        </div>
      </div>
    </DialogOverlay>
  );
};
