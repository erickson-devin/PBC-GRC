import React from 'react';
import {
  ShieldCheck,
  KeyRound,
  HardDriveDownload,
  Building2,
  Network,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { DOMAINS } from '../../data/cmmcLevel1Controls';
import { DomainCode } from '../../types/cmmc';
import { useAssessment } from '../../context/AssessmentContext';

const DOMAIN_ICONS: Record<DomainCode, React.ComponentType<{ className?: string }>> = {
  AC: ShieldCheck,
  IA: KeyRound,
  MP: HardDriveDownload,
  PE: Building2,
  SC: Network,
  SI: CheckCircle2,
};

export const DomainCards: React.FC = () => {
  const { metrics, setSelectedDomainFilter, setActiveTab } = useAssessment();

  const handleDomainClick = (code: DomainCode) => {
    setSelectedDomainFilter(code);
    setActiveTab('controls');
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {(Object.keys(DOMAINS) as DomainCode[]).map((code) => {
        const domain = DOMAINS[code];
        const stats = metrics.domainStats[code];
        const Icon = DOMAIN_ICONS[code];
        const isComplete = stats.met === stats.total;

        return (
          <div
            key={code}
            onClick={() => handleDomainClick(code)}
            className="group relative bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 transition-all duration-200 cursor-pointer shadow-lg hover:shadow-brand-500/5 hover:-translate-y-0.5 flex flex-col justify-between"
          >
            {/* Header */}
            <div>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105"
                    style={{
                      backgroundColor: `${domain.color}15`,
                      color: domain.color,
                      border: `1px solid ${domain.color}30`,
                    }}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-400">
                      {code} Domain
                    </span>
                    <h4 className="text-base font-bold text-white group-hover:text-brand-300 transition-colors">
                      {domain.name}
                    </h4>
                  </div>
                </div>

                {isComplete ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <CheckCircle2 className="w-3 h-3" /> Met
                  </span>
                ) : (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                    {stats.met} of {stats.total} Met
                  </span>
                )}
              </div>

              <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed mb-4">
                {domain.description}
              </p>
            </div>

            {/* Bottom Progress & Jump */}
            <div className="space-y-3 pt-3 border-t border-slate-800/80">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Domain Completion</span>
                <span className="font-bold text-white font-mono">{stats.percentage}%</span>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden flex">
                <div
                  className="bg-emerald-500 transition-all duration-500"
                  style={{ width: `${(stats.met / stats.total) * 100}%` }}
                  title={`${stats.met} Met`}
                />
                <div
                  className="bg-amber-500 transition-all duration-500"
                  style={{ width: `${(stats.inProgress / stats.total) * 100}%` }}
                  title={`${stats.inProgress} In Progress`}
                />
                <div
                  className="bg-rose-500 transition-all duration-500"
                  style={{ width: `${(stats.notMet / stats.total) * 100}%` }}
                  title={`${stats.notMet} Not Met`}
                />
              </div>

              <div className="flex items-center justify-between pt-1 text-xs text-brand-400 group-hover:text-brand-300 font-medium">
                <span>View {domain.totalControls} Controls</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
