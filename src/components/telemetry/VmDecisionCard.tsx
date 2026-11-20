import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { SMALL_BUTTON } from '../reports/PoamGroupPanel';
import type { TenantRole } from '../../types/tenant';
import type { VmDecision } from '../../types/vmRemediation';
import {
  DECISION_KIND_LABEL,
  DECISION_STATE_BADGE,
  DECISION_STATE_LABEL,
  REMEDIATION_COPY as C,
  decisionActionError,
  decisionActions,
  decisionConfirmText,
  decisionDoneText,
  expiryText,
  justificationView,
} from '../../data/telemetry/vmRemediationView';
import type { VmDecisionAction } from '../../data/telemetry/vmRemediationView';

export interface VmDecisionCardProps {
  decision: VmDecision;
  ctx: { vulnId: string; assetName: string | null };
  /** Names the finding (CVE and host) in the heading: the queue lists decisions of many findings, the per-finding dialog does not. */
  showFinding: boolean;
  role: TenantRole | null;
  nowMs: number;
  /** Runs the action; rejects with the ApiError. */
  onAct: (a: VmDecisionAction) => Promise<void>;
  onDone: (text: string) => void;
  onReloadNeeded: () => void;
  onRequestNew?: () => void;
}

const ACTION_LABEL: Record<VmDecisionAction, string> = { approve: C.approve, reject: C.reject, withdraw: C.withdraw, revoke: C.revoke };
const DANGER_BUTTON = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 hover:bg-rose-900/50 disabled:opacity-60';
const BRAND_BUTTON = 'px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5';

/**
 * One risk decision: who asked, until when, who approved, its justification (hidden for a Viewer) and the actions the caller's role allows, each behind an
 * inline confirmation. The justification and the CVE are rendered as text only and are never put in an aria-label, a log or storage.
 */
export const VmDecisionCard: React.FC<VmDecisionCardProps> = ({ decision, ctx, showFinding, role, nowMs, onAct, onDone, onReloadNeeded, onRequestNew }) => {
  const uid = useId();
  const [confirming, setConfirming] = useState<VmDecisionAction | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const buttons = useRef<Partial<Record<VmDecisionAction, HTMLButtonElement | null>>>({});

  const acts = decisionActions(decision, role);
  const jv = justificationView(decision);
  const selfId = `${uid}-self`;
  const textId = `${uid}-text`;

  const cancel = (a: VmDecisionAction) => {
    setConfirming(null);
    requestAnimationFrame(() => buttons.current[a]?.focus());
  };

  const run = async (a: VmDecisionAction) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await onAct(a);
      if (!mounted.current) return;
      setConfirming(null);
      onDone(decisionDoneText(a, decision, ctx));
    } catch (err: unknown) {
      if (!mounted.current) return;
      const f = decisionActionError(a, err);
      if (f.kind === 'session') return; // the session rescue handles it
      setError(f.text);
      setConfirming(null);
      if (f.reload) onReloadNeeded();
    } finally {
      if (mounted.current) setWorking(false);
    }
  };

  const open = (a: VmDecisionAction) => {
    setError(null);
    setConfirming(a);
  };

  const actionButton = (a: VmDecisionAction, className: string, disabled = false, describedBy?: string) => (
    <button
      key={a}
      ref={(el) => { buttons.current[a] = el; }}
      type="button"
      onClick={() => open(a)}
      disabled={disabled || working}
      aria-describedby={describedBy}
      className={className}
    >
      {ACTION_LABEL[a]}
    </button>
  );

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white break-words">
          {showFinding && <><span className="font-mono">{ctx.vulnId}</span> on {ctx.assetName ?? 'an asset no longer recorded'} · </>}
          {DECISION_KIND_LABEL[decision.kind]}
        </p>
        <span className={`badge px-2 py-0.5 rounded-full text-xs font-bold border ${DECISION_STATE_BADGE[decision.state]}`}>{DECISION_STATE_LABEL[decision.state]}</span>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1">
        <div>
          <dt className="text-slate-400">{C.requested}</dt>
          <dd className="text-slate-200 break-words">{decision.requestedBy}, {decision.requestedAt.slice(0, 10)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Expiry</dt>
          <dd className="text-slate-200">{expiryText(decision.expiresAt, nowMs)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">{C.approved}</dt>
          <dd className="text-slate-200 break-words">{decision.approvedBy && decision.approvedAt ? `${decision.approvedBy}, ${decision.approvedAt.slice(0, 10)}` : C.notYet}</dd>
        </div>
      </dl>

      {jv.kind === 'text' ? (
        <div className="space-y-1.5">
          <button type="button" onClick={() => setShowText((v) => !v)} aria-expanded={showText} aria-controls={textId} className={SMALL_BUTTON}>
            {showText ? C.hideJustification : C.showJustification}
          </button>
          {showText && (
            <div
              id={textId}
              tabIndex={0}
              role="region"
              aria-label="Justification"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950/60 border border-slate-800 p-2 text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              {jv.text}
            </div>
          )}
        </div>
      ) : (
        <p className="text-slate-400">{jv.text}</p>
      )}

      {(acts.approve || acts.reject || acts.withdraw || acts.revoke || onRequestNew) && (
        <div className="flex flex-wrap items-center gap-2">
          {acts.approve === 'ok' && actionButton('approve', BRAND_BUTTON)}
          {acts.approve === 'self' && actionButton('approve', BRAND_BUTTON, true, selfId)}
          {acts.reject && actionButton('reject', DANGER_BUTTON)}
          {acts.revoke && actionButton('revoke', DANGER_BUTTON)}
          {acts.withdraw && actionButton('withdraw', SMALL_BUTTON)}
          {onRequestNew && <button type="button" onClick={onRequestNew} className={SMALL_BUTTON}>{C.requestNew}</button>}
        </div>
      )}
      {acts.approve === 'self' && <p id={selfId} className="text-slate-400">{C.selfApprove}</p>}

      {confirming && (
        <div
          role="group"
          aria-labelledby={`${uid}-confirm`}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !working) {
              e.preventDefault();
              e.stopPropagation();
              cancel(confirming);
            }
          }}
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2.5"
        >
          <p id={`${uid}-confirm`} className="text-amber-100">{decisionConfirmText(confirming, decision, ctx)}</p>
          <div className="flex items-center justify-end gap-2">
            <button type="button" autoFocus onClick={() => cancel(confirming)} disabled={working} className="px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
            <button
              type="button"
              onClick={() => { void run(confirming); }}
              disabled={working}
              className={confirming === 'approve' ? BRAND_BUTTON : DANGER_BUTTON}
            >
              {working && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {ACTION_LABEL[confirming]}
            </button>
          </div>
        </div>
      )}

      <ErrorNotice message={error} />
    </li>
  );
};
