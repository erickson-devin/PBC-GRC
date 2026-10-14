import React, { useId, useMemo, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, AlertTriangle, Clock, CircleDashed, ChevronDown, ChevronUp, Paperclip } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { CMMC_LEVEL_2_CONTROLS } from '../../data/frameworks/cmmcLevel2Controls';
import { crosswalkFor171, crosswalkFor53, requirementNumberOf } from '../../data/frameworks/nist80053/crosswalk';
import type { ControlStatus } from '../../types/cmmc';
import type { ComplianceFramework } from '../../types/framework';

interface Props {
  controlId: string;
}

interface Counterpart {
  id: string;
  title: string;
  framework: ComplianceFramework;
  /** Frameworks in which a program records this control. */
  enabledIn: ComplianceFramework[];
  badge?: string;
  detail?: string;
}

const CMMC_TITLES = new Map(CMMC_LEVEL_2_CONTROLS.map((c) => [c.id, c.title]));

const STATUS: Record<ControlStatus, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  MET: { label: 'Met', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  IN_PROGRESS: { label: 'In progress', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: Clock },
  NOT_MET: { label: 'Not met', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30', Icon: AlertTriangle },
  NOT_STARTED: { label: 'Not started', cls: 'bg-slate-700/40 text-slate-300 border-slate-600/50', Icon: CircleDashed },
};

const excerpt = (text: string, max = 160) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The crosswalk between SP 800-171 / CMMC and SP 800-53 Rev. 5 for one control. A counterpart that is part of this program shows
 * what is recorded for it (status, an excerpt of its implementation notes, how much evidence is attached), so notes and evidence
 * written under one framework are visible from the other. Read-only: nothing is copied and nothing is saved here. A counterpart
 * outside the program is a plain reference.
 */
export const CrosswalkPanel: React.FC<Props> = ({ controlId }) => {
  const { state } = useAssessment();
  const { currentTenant } = useTenant();
  const [open, setOpen] = useState(true);
  const headingId = useId();
  const listId = useId();

  const enabled = useMemo<Set<string>>(() => {
    const list = currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0 ? currentTenant.enabledFrameworks : [currentTenant.primaryFramework || 'CMMC_L1'];
    return new Set<string>(list);
  }, [currentTenant.enabledFrameworks, currentTenant.primaryFramework]);

  const view = useMemo(() => {
    if (requirementNumberOf(controlId)) {
      const items: Counterpart[] = crosswalkFor171(controlId).map((c) => ({
        id: c.control,
        title: c.title,
        framework: 'NIST_800_53_REV5',
        enabledIn: enabled.has('NIST_800_53_REV5') ? ['NIST_800_53_REV5'] : [],
        badge: c.kind === 'ENHANCEMENT' ? 'Enhancement' : 'Base',
        detail: [c.parent ? `Enhancement of ${c.parent}` : '', c.rev4 ? `Rev. 4 ${c.rev4} carried to Rev. 5 through NIST's withdrawn-control link` : ''].filter(Boolean).join('. '),
      }));
      return { heading: 'SP 800-53 Rev. 5 counterparts', intro: 'Appendix D relates this requirement to these controls (only the part of each that the requirement addresses).', items };
    }
    const { direct, viaParent } = crosswalkFor53(controlId);
    const items: Counterpart[] = [];
    const push = (cmmcId: string, requirement: string, via?: string) => {
      const l1 = /\.L1-/.test(cmmcId);
      const inProgram = enabled.has('CMMC_L2') || (l1 && enabled.has('CMMC_L1'));
      items.push({
        id: cmmcId,
        title: CMMC_TITLES.get(cmmcId) ?? `SP 800-171 ${requirement}`,
        framework: 'CMMC_L2',
        enabledIn: inProgram ? ['CMMC_L2'] : [],
        badge: `SP 800-171 ${requirement}`,
        detail: via ? `Through its base control ${via}` : '',
      });
    };
    for (const d of direct) for (const id of d.cmmcIds) push(id, d.requirement);
    for (const v of viaParent) for (const id of v.cmmcIds) push(id, v.requirement, v.parent);
    return { heading: 'SP 800-171 / CMMC counterparts', intro: 'These SP 800-171 requirements map to this control.', items };
  }, [controlId, enabled]);

  const trackedIds = useMemo(() => new Set(view.items.filter((i) => i.enabledIn.length > 0).map((i) => i.id)), [view]);

  const evidenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (trackedIds.size === 0) return counts;
    for (const e of state.evidenceIndex) {
      if (trackedIds.has(e.controlId)) counts.set(e.controlId, (counts.get(e.controlId) ?? 0) + 1);
    }
    return counts;
  }, [state.evidenceIndex, trackedIds]);

  if (view.items.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-slate-700/70 bg-slate-950/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <span id={headingId} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
          <ArrowLeftRight className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
          <span>
            Crosswalk: {view.heading} ({view.items.length})
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" aria-hidden="true" /> : <ChevronDown className="w-4 h-4 text-slate-400" aria-hidden="true" />}
      </button>
      {open && (
        <div id={listId} className="px-3.5 pb-3 space-y-2">
          <p className="text-xs text-slate-400">{view.intro} Read-only: notes and evidence are shown here, never copied.</p>
          <ul className="space-y-2">
            {view.items.map((item) => {
              const tracked = item.enabledIn.length > 0;
              const ctrl = tracked ? state.controls[item.id] : undefined;
              const status = STATUS[ctrl?.status ?? 'NOT_STARTED'];
              const notes = ctrl?.implementationNotes ?? '';
              const evidence = evidenceCounts.get(item.id) ?? 0;
              return (
                <li key={`${item.id}`} className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-cyan-300">{item.id}</span>
                    {item.badge && <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">{item.badge}</span>}
                    <span className="text-xs text-slate-200">{item.title}</span>
                  </div>
                  {item.detail && <p className="text-xs text-slate-400">{item.detail}</p>}
                  {tracked ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-mono font-semibold ${status.cls}`}>
                          <status.Icon className="w-3 h-3" aria-hidden="true" />
                          {status.label}
                        </span>
                        <span className="inline-flex items-center gap-1 text-slate-300">
                          <Paperclip className="w-3 h-3 text-cyan-400" aria-hidden="true" />
                          {evidence} evidence {evidence === 1 ? 'item' : 'items'}
                        </span>
                      </div>
                      <p className={`text-xs leading-relaxed ${notes.trim() ? 'text-slate-300' : 'text-slate-500 italic'}`}>
                        {notes.trim() ? excerpt(notes) : 'No implementation notes recorded.'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">Reference only: not part of this program.</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
};

export default CrosswalkPanel;
