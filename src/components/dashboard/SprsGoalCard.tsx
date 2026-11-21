import React, { useId, useRef, useState } from 'react';
import { CheckCircle2, Lock, Target, TrendingUp } from 'lucide-react';
import type { SprsScoreResult } from '../../types/audit';
import { formatSprsScore } from '../../data/reports/sprsCompiler';
import { sprsGoalView } from '../../data/dashboard/sprsGoal';
import { GOAL_RANGE_TEXT, goalGapText, parseGoalInput, scalePosition, sprsGoalErrorMessage } from '../../data/dashboard/dashboardUiView';
import { ErrorNotice } from '../common/ErrorNotice';

interface SprsGoalCardProps {
  sprs: SprsScoreResult;
  goal: number | null;
  canEditGoal: boolean;
  lockedReason: string | null;
  onSave: (value: number | null) => Promise<void>;
}

/** The SPRS goal of a CMMC Level 2 program beside the current score (#252). No goal stored shows the default, 110. */
export const SprsGoalCard: React.FC<SprsGoalCardProps> = ({ sprs, goal, canEditGoal, lockedReason, onSave }) => {
  const uid = useId();
  const hId = `${uid}-h`;
  const formId = `${uid}-form`;
  const inputId = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const errId = `${uid}-err`;
  const editRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [announce, setAnnounce] = useState('');
  const view = sprsGoalView(sprs, goal);
  const gapText = goalGapText(view.text);

  const focusEdit = () => setTimeout(() => editRef.current?.focus(), 0);
  const startEdit = () => {
    setDraft(goal === null ? '' : String(goal));
    setFieldError(null);
    setSaveError(null);
    setAnnounce('');
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setFieldError(null);
    setSaveError(null);
    focusEdit();
  };
  const save = async () => {
    if (saving) return;
    const parsed = parseGoalInput(draft);
    if (!parsed.ok) {
      setFieldError(GOAL_RANGE_TEXT);
      return;
    }
    setFieldError(null);
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(parsed.value);
      setEditing(false);
      setAnnounce('Goal saved.');
      focusEdit();
    } catch (err) {
      setSaveError(sprsGoalErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={hId} className="stitch-card p-6 shadow-xl border-slate-800 space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 flex items-center justify-center">
          <Target className="w-4 h-4" aria-hidden="true" />
        </div>
        <div>
          <h3 id={hId} className="text-sm font-bold text-white tracking-tight">SPRS goal</h3>
          <p className="text-xs text-slate-400">The score this program is working towards (&minus;203 to 110)</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2.5">
        <div className="p-3 rounded-xl bg-slate-850/80 border border-slate-800">
          <dt className="text-xs font-mono uppercase text-slate-400">Current</dt>
          <dd className="mt-1 text-2xl font-black font-mono text-white">{formatSprsScore(sprs)}</dd>
        </div>
        <div className="p-3 rounded-xl bg-slate-850/80 border border-slate-800">
          <dt className="text-xs font-mono uppercase text-slate-400">Goal</dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black font-mono text-cyan-300">{view.goal}</span>
            {view.isDefault && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-slate-700 text-slate-400">Default</span>}
          </dd>
        </div>
      </dl>
      <p className={`text-xs flex items-center gap-1.5 ${view.gap === null ? 'text-amber-300' : view.gap > 0 ? 'text-slate-300' : 'text-emerald-300'}`}>
        {view.gap === null ? <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : view.gap > 0 ? <TrendingUp className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
        <span>{gapText}</span>
      </p>
      {view.isDefault && <p className="text-[11px] text-slate-400">No goal set: the maximum score, 110, is used.</p>}
      <div aria-hidden="true" className="relative h-2 rounded-full bg-slate-800">
        {sprs.score !== null && (
          <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-white ring-2 ring-slate-900" style={{ left: `${scalePosition(sprs.score)}%` }} />
        )}
        <span className="absolute -top-1 -translate-x-1/2 w-0.5 h-4 bg-cyan-400" style={{ left: `${scalePosition(view.goal)}%` }} />
      </div>

      {canEditGoal && !editing && (
        <button type="button" ref={editRef} aria-expanded={false} aria-controls={formId} onClick={startEdit} className="btn-secondary py-1.5 px-3 text-xs">
          Edit goal
        </button>
      )}
      {canEditGoal && editing && (
        <div id={formId} role="group" aria-labelledby={hId} className="space-y-2">
          <label htmlFor={inputId} className="block text-xs font-semibold text-slate-300 mb-1.5">Goal score</label>
          <input
            id={inputId}
            autoFocus
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={!!fieldError}
            aria-describedby={`${hintId}${fieldError ? ` ${errId}` : ''}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
            }}
            className="w-32 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
          <p id={hintId} className="text-[11px] text-slate-400">A whole number from &minus;203 to 110. Leave it empty to use the default (110).</p>
          {fieldError && <p id={errId} role="alert" className="text-xs text-rose-300">{fieldError}</p>}
          <ErrorNotice message={saveError} />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary px-3 py-1.5 text-xs">
              {saving ? 'Saving…' : 'Save goal'}
            </button>
            <button type="button" onClick={cancel} className="btn-secondary py-1.5 px-3 text-xs">Cancel</button>
          </div>
        </div>
      )}
      {!canEditGoal && <p className="text-[11px] text-slate-400">{lockedReason ?? 'Set by a Tenant Owner or Admin.'}</p>}
      <span role="status" aria-live="polite" className="sr-only">{announce}</span>
    </section>
  );
};

export default SprsGoalCard;
