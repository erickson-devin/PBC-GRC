import React, { useId, useRef, useState } from 'react';
import { CalendarClock, ClipboardCheck } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { VmDecisionCard } from './VmDecisionCard';
import type { VmDecisionsLoad } from '../../hooks/useVmDecisions';
import type { TenantRole } from '../../types/tenant';
import type { VmDecision } from '../../types/vmRemediation';
import { REMEDIATION_COPY as C, loadErrorText } from '../../data/telemetry/vmRemediationView';
import type { VmDecisionAction } from '../../data/telemetry/vmRemediationView';

export interface VmDecisionsSectionProps {
  kind: 'pending' | 'expiring';
  load: VmDecisionsLoad;
  role: TenantRole | null;
  nowMs: number;
  onRetry: () => void;
  onAct: (id: string, a: VmDecisionAction) => Promise<unknown>;
  /** Called after an action succeeded or found the list stale: the caller reloads its lists. */
  onChanged: () => void;
  /** Offered on the re-review list to the write roles. */
  onRequestNew?: (d: VmDecision) => void;
}

const RETRY_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** The approvals queue (requests waiting for approval) or the re-review list (decisions in force that expire within 30 days). */
export const VmDecisionsSection: React.FC<VmDecisionsSectionProps> = ({ kind, load, role, nowMs, onRetry, onAct, onChanged, onRequestNew }) => {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [announce, setAnnounce] = useState('');
  const pending = kind === 'pending';
  const Icon = pending ? ClipboardCheck : CalendarClock;
  const count = load.status === 'ready' ? load.decisions.length : null;

  const done = (text: string) => {
    setAnnounce(text);
    onChanged();
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="space-y-2 text-xs pt-4 border-t border-slate-800">
      <h3
        id={`${uid}-h`}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-bold text-white flex items-center gap-1.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <Icon className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
        {pending ? C.pendingHeading(count) : C.reviewHeading}
      </h3>
      <p className="text-slate-400">{pending ? C.pendingIntro : C.reviewIntro}</p>

      {load.status === 'idle' || load.status === 'loading' ? (
        <p role="status" className="text-slate-400">{C.decisionsLoading}</p>
      ) : load.status === 'error' ? (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={loadErrorText('decisions', load.offline)} className="flex-1" />
          <button type="button" aria-label="Retry loading the decisions" onClick={onRetry} className={RETRY_CLASS}>{C.retry}</button>
        </div>
      ) : load.status === 'ready' ? (
        load.decisions.length === 0 ? (
          <p className="text-slate-400">{pending ? C.pendingEmpty : C.reviewEmpty}</p>
        ) : (
          <>
            <ul className="space-y-2">
              {load.decisions.map((d) => (
                <VmDecisionCard
                  key={d.id}
                  decision={d}
                  ctx={{ vulnId: d.vulnId ?? '', assetName: d.assetName ?? null }}
                  showFinding
                  role={role}
                  nowMs={nowMs}
                  onAct={async (a) => { await onAct(d.id, a); }}
                  onDone={done}
                  onReloadNeeded={onChanged}
                  onRequestNew={onRequestNew && d.findingId ? () => onRequestNew(d) : undefined}
                />
              ))}
            </ul>
            {load.decisions.length >= 500 && <p className="text-slate-400">{C.decisionsCap}</p>}
          </>
        )
      ) : null}
      <p role="status" aria-live="polite" className="text-emerald-300">{announce}</p>
    </section>
  );
};
