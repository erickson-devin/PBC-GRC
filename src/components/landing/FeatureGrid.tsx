import React from 'react';
import { 
  ShieldCheck, 
  Database, 
  Layers, 
  FileCheck, 
  CheckCircle2, 
  Zap,
} from 'lucide-react';

interface FeatureGridProps {
  onSelectFeature?: (featureId: string) => void;
  onEnterApp?: () => void;
}

export const FeatureGrid: React.FC<FeatureGridProps> = () => {
  const features = [
    {
      id: 'controls-engine',
      icon: ShieldCheck,
      badge: 'FAR 52.204-21 & NIST SP 800-171',
      title: '17/17 Dynamic Control Coverage',
      description: 'Instant SPRS scoring across all 15 Federal Acquisition Regulation (FAR) clauses and 17 CMMC Level 1 controls. Real-time validation for C3PAO and self-assessment submissions.',
      highlight: '100% SPRS score calculation in real time',
      accentColor: 'from-brand-500 to-cyan-500',
    },
    {
      id: 'gcs-vault',
      icon: Database,
      badge: 'Zero-Tamper Audit Defense',
      title: 'Immutable Evidence Vault',
      description: 'Direct Google Cloud Storage (GCS) integration with client-side SHA-256 cryptographic hashing. Ensures evidence artifacts are verifiable, timestamped, and tamper-resistant.',
      highlight: 'Subtle WebCrypto SHA-256 validation',
      accentColor: 'from-purple-500 to-indigo-500',
    },
    {
      id: 'msp-multitenant',
      icon: Layers,
      badge: 'Enterprise MSP Ready',
      title: 'Multi-Tenant MSP Isolation',
      description: 'Instant context-switching between defense contractor client organizations. Strict logical enclave isolation, tenant-specific evidence buckets, and fine-grained RBAC roles.',
      highlight: 'Switch between client enclaves in milliseconds',
      accentColor: 'from-emerald-500 to-teal-500',
    },
    {
      id: 'ssp-generator',
      icon: FileCheck,
      badge: '1-Click Export Engine',
      title: 'Automated SSP Generator',
      description: 'Battle-tested starter templates tailored for Microsoft 365, Azure AD, on-premise hardware, and Google Cloud environments. Export submission-ready PDF and Markdown with 1 click.',
      highlight: 'Includes official CMMC L1 system boundary scopes',
      accentColor: 'from-amber-500 to-orange-500',
    },
  ];

  return (
    <section id="features" className="py-24 relative overflow-hidden">
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Section Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-semibold text-brand-300">
            <Zap className="w-3.5 h-3.5 text-brand-400" />
            Core Platform Capabilities
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Engineered Specifically for Defense Contractors & MSPs
          </h2>
          <p className="text-base sm:text-lg text-slate-300">
            Everything your organization needs to prepare, verify, and maintain CMMC Level 1 compliance without complex spreadsheets or manual audits.
          </p>
        </div>

        {/* Bento-style 4-Card Grid with Double Bezel Architecture */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
          {features.map((feat) => {
            const Icon = feat.icon;
            return (
              <div 
                key={feat.id}
                className="group relative p-2 rounded-[2rem] bg-gradient-to-b from-slate-800/40 via-slate-900/30 to-slate-950/60 ring-1 ring-slate-800/80 hover:ring-brand-500/40 shadow-xl transition-all duration-300"
              >
                {/* Inner Core Card */}
                <div className="h-full p-6 sm:p-8 rounded-[calc(2rem-0.5rem)] bg-slate-950/90 border border-slate-800/60 flex flex-col justify-between space-y-6">
                  
                  <div className="space-y-4">
                    {/* Top Icon & Badge Row */}
                    <div className="flex items-center justify-between">
                      <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${feat.accentColor} flex items-center justify-center shadow-lg shadow-black/40 ring-1 ring-white/20 group-hover:scale-105 transition-transform duration-300`}>
                        <Icon className="w-6 h-6 text-white" />
                      </div>
                      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-300">
                        {feat.badge}
                      </span>
                    </div>

                    {/* Title */}
                    <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight group-hover:text-brand-300 transition-colors">
                      {feat.title}
                    </h3>

                    {/* Description */}
                    <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                      {feat.description}
                    </p>
                  </div>

                  {/* Bottom Highlight Pill */}
                  <div className="pt-4 border-t border-slate-900 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{feat.highlight}</span>
                    </div>
                  </div>

                </div>
              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
};
