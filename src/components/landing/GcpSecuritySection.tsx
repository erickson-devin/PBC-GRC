import React from 'react';
import { 
  Cloud, 
  Database, 
  ShieldCheck, 
  Key, 
  Fingerprint
} from 'lucide-react';

export const GcpSecuritySection: React.FC = () => {
  const pillars = [
    {
      icon: Database,
      title: 'Cloud SQL & Tenant RLS',
      desc: 'Strict PostgreSQL Row-Level Security (RLS) policies enforce multi-tenant cryptographic barriers, ensuring complete isolation across contractor enclaves.',
    },
    {
      icon: Fingerprint,
      title: 'SHA-256 GCS Evidence Vault',
      desc: 'Evidence files are hashed client-side via the Web Crypto API and pushed directly to GCS using 15-minute time-bound cryptographic presigned URLs.',
    },
    {
      icon: Key,
      title: 'Least-Privilege IAM SA',
      desc: 'The dedicated cmmc-evidence-signer service account holds strictly scoped bucket permissions with uniform bucket-level access enforced.',
    },
    {
      icon: ShieldCheck,
      title: 'Enterprise M365 & Google SSO',
      desc: 'Federated SAML 2.0 and OpenID Connect (OIDC) identity support for Microsoft 365 GCC High and Google Workspace security environments.',
    },
  ];

  return (
    <section id="security" className="py-24 bg-slate-950/70 border-t border-slate-900 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Section Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-500/10 border border-brand-500/20 text-xs font-semibold text-brand-300">
            <Cloud className="w-3.5 h-3.5 text-brand-400" />
            Zero-Trust Cloud Infrastructure
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            DoD-Grade Cloud Architecture
          </h2>
          <p className="text-base sm:text-lg text-slate-300">
            Built from the ground up on Google Cloud Platform to satisfy strict CMMC DFARS 252.204-7012 and NIST SP 800-171 data security requirements.
          </p>
        </div>

        {/* 4 Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {pillars.map((p, idx) => {
            const Icon = p.icon;
            return (
              <div 
                key={idx}
                className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all space-y-3"
              >
                <div className="w-10 h-10 rounded-xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center text-brand-400">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white">{p.title}</h3>
                <p className="text-xs text-slate-300 leading-relaxed">{p.desc}</p>
              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
};
