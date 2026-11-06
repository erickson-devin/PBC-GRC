import React, { useMemo } from 'react';
import {
  BookOpen,
  Shield,
  AlertTriangle,
  Lock,
  Layers,
  Sparkles,
  Scale,
  ClipboardList,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { guideFor, fillGuideText, type GuideIcon, type GuideTone } from '../../data/guidance/frameworkGuides';
import { guidanceDomainSummary } from '../../data/guidance/guidanceDomains';
import { getSprsPointDeduction, SPRS_MAX_SCORE, SPRS_MIN_SCORE } from '../../data/reports/sprsCompiler';

const ICONS: Record<GuideIcon, React.ComponentType<{ className?: string }>> = {
  alert: AlertTriangle,
  shield: Shield,
  lock: Lock,
  layers: Layers,
  scale: Scale,
  clipboard: ClipboardList,
  sparkles: Sparkles,
};

const TONE_CHIP: Record<GuideTone, string> = {
  amber: 'bg-amber-500/15 text-amber-400',
  brand: 'bg-brand-500/15 text-brand-400',
  emerald: 'bg-emerald-500/15 text-emerald-400',
  sky: 'bg-sky-500/15 text-sky-400',
  violet: 'bg-violet-500/15 text-violet-400',
  rose: 'bg-rose-500/15 text-rose-400',
};

const TONE_TEXT: Record<GuideTone, string> = {
  amber: 'text-amber-400',
  brand: 'text-brand-400',
  emerald: 'text-emerald-400',
  sky: 'text-sky-400',
  violet: 'text-violet-400',
  rose: 'text-rose-400',
};

/** Renders **bold** pairs as <strong>; everything else stays plain text (never HTML). */
function renderInline(text: string): React.ReactNode[] {
  return text.split('**').map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>));
}

export const AssessmentGuidanceView: React.FC = () => {
  const { setSelectedDomainFilter, setActiveTab, frameworkControls } = useAssessment();
  const { activeFramework, activeProgram } = useTenant();

  const guide = guideFor(activeFramework, activeProgram?.baseline);
  const domains = useMemo(() => guidanceDomainSummary(activeFramework, frameworkControls), [activeFramework, frameworkControls]);

  const values = useMemo(() => {
    let five = 0;
    let three = 0;
    let one = 0;
    for (const c of frameworkControls) {
      const points = getSprsPointDeduction(c.id);
      if (points === 5) five++;
      else if (points === 3) three++;
      else if (points === 1) one++;
    }
    return {
      controls: frameworkControls.length,
      domains: domains.length,
      sprsMax: SPRS_MAX_SCORE,
      sprsMin: SPRS_MIN_SCORE,
      five,
      three,
      one,
    };
  }, [frameworkControls, domains.length]);

  const fill = (text: string) => renderInline(fillGuideText(text, values));

  return (
    <div className="space-y-8 animate-fadeIn max-w-5xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5 flex-wrap">
          <BookOpen className="w-6 h-6 text-brand-400" />
          {guide.title}
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
            {activeProgram?.name ?? 'Default program'} · {frameworkLabel(activeFramework)}
          </span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">{guide.subtitle}</p>
        {guide.approval.status === 'DRAFT' && (
          <p className="text-xs text-slate-400 mt-1">Draft guidance, not yet reviewed. Check it against the official sources listed at the end.</p>
        )}
      </div>

      {/* Critical Rules Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {guide.rules.map((rule) => {
          const Icon = ICONS[rule.icon];
          return (
            <div key={rule.id} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${TONE_CHIP[rule.tone]}`}>
                <Icon className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-white">{rule.title}</h3>
              <p className="text-xs text-slate-300 leading-relaxed">{fill(rule.body)}</p>
            </div>
          );
        })}
      </div>

      {/* Domains */}
      {domains.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-xl">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Layers className="w-5 h-5 text-brand-400" />
            {guide.domainsHeading(domains.length)}
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {domains.map((d) => (
              <div
                key={d.code}
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
                      {d.code} • {d.name}
                    </span>
                    <span className="text-xs font-mono text-slate-400">
                      {d.count} {d.count === 1 ? guide.domainUnit[0] : guide.domainUnit[1]}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">{d.description}</p>
                </div>

                <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-400 font-mono">
                    {guide.showDomainIds && (
                      <>
                        {d.ids.map((id) => (guide.key === 'CMMC_L1' ? id.replace('.L1-', '-') : id)).join(', ')}
                        {d.more > 0 && ` +${d.more} more`}
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={`View ${d.name} controls`}
                    onClick={() => {
                      setSelectedDomainFilter(d.code);
                      setActiveTab('controls');
                    }}
                    className="text-brand-400 hover:text-brand-300 font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 shrink-0"
                  >
                    View Controls →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sections (scoping, obligations, capabilities, RMF steps ...) */}
      {guide.sections.map((section) => {
        const SectionIcon = ICONS[section.icon];
        return (
          <div key={section.id} className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-4 shadow-xl">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <SectionIcon className="w-5 h-5 text-brand-400" />
              {section.heading}
            </h3>
            {section.intro && <p className="text-xs text-slate-300 leading-relaxed">{fill(section.intro)}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
              {section.cards.map((card) => (
                <div key={card.id} className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                  <span className={`font-bold block ${TONE_TEXT[card.tone]}`}>{card.title}</span>
                  <p className="text-slate-300">{fill(card.body)}</p>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Sources */}
      {guide.sources.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-3 shadow-xl">
          <h3 className="text-lg font-bold text-white">Sources</h3>
          <ul className="list-disc pl-5 space-y-1 text-xs text-slate-300">
            {guide.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
