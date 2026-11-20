import React, { useId, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { CATEGORY_INFO } from '../../data/telemetry/assetScope';
import { DEPLOYMENT_LABELS, INVENTORY_UI_TEXT, TOOL_TYPE_LABELS, batchResultText, toolErrorMessage } from '../../data/inventory/inventoryUiView';
import type { ToolInputWithSeed } from '../../data/inventory/inventorySchema';
import type { ToolBatchResult, ToolInput } from '../../types/inventory';

interface SurveySeedDialogProps {
  candidates: (ToolInput & { seedKey: string })[];
  /** Where the answers come from, e.g. "From the program's survey answers". */
  sourceLabel: string;
  onBatch: (items: ToolInputWithSeed[]) => Promise<ToolBatchResult>;
  /** Everything was added: the text for the panel's notification. */
  onDone: (text: string) => void;
  onClose: () => void;
}

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** Review of the tools the technology survey suggests. All are ticked; nothing is written until Add. */
export const SurveySeedDialog: React.FC<SurveySeedDialogProps> = ({ candidates, sourceLabel, onBatch, onDone, onClose }) => {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(candidates.map((c) => c.seedKey)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const uid = useId();

  const chosen = candidates.filter((c) => ticked.has(c.seedKey));
  const n = chosen.length;
  const locked = saving || result !== null;

  const submit = async (): Promise<void> => {
    if (locked || n === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await onBatch(chosen);
      const text = batchResultText(res.created.length, res.skipped);
      if (res.skipped.length === 0) onDone(text);
      else {
        setResult(text);
        setSaving(false);
        setTimeout(() => doneRef.current?.focus(), 0);
      }
    } catch (err: unknown) {
      setError(toolErrorMessage(err, 'batch'));
      setSaving(false);
    }
  };

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Sparkles className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">Suggestions from your technology survey</DialogTitle>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-1 text-xs">
          <p className="text-slate-300">{INVENTORY_UI_TEXT.surveyDialogIntro}</p>
          <p className="text-slate-400">{sourceLabel}</p>
        </div>

        <ErrorNotice message={error} />

        <fieldset className="space-y-1.5 text-xs">
          <legend className="sr-only">Suggested tools</legend>
          {candidates.map((c) => {
            const cid = `${uid}-${c.seedKey}`;
            return (
              <div key={c.seedKey} className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                <input
                  id={cid}
                  type="checkbox"
                  checked={ticked.has(c.seedKey)}
                  disabled={locked}
                  onChange={(e) =>
                    setTicked((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(c.seedKey);
                      else next.delete(c.seedKey);
                      return next;
                    })
                  }
                  className="mt-0.5 accent-cyan-500"
                />
                <label htmlFor={cid} className="flex-1 cursor-pointer">
                  <span className="font-semibold text-white">{c.name}</span>
                  <span className="block text-slate-400">
                    {[
                      c.toolType ? TOOL_TYPE_LABELS[c.toolType] : 'Type not set',
                      c.deployment ? DEPLOYMENT_LABELS[c.deployment] : 'Deployment not set',
                      CATEGORY_INFO.SECURITY_PROTECTION.label,
                    ].join(' · ')}
                  </span>
                </label>
              </div>
            );
          })}
        </fieldset>

        {result && <p role="status" className="text-xs text-emerald-300">{result}</p>}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
          {result ? (
            <button type="button" ref={doneRef} onClick={onClose} className="btn-primary px-3 py-1.5 rounded-xl text-xs">Done</button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>Cancel</button>
              <button type="button" onClick={() => void submit()} disabled={saving || n === 0} className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">
                {saving ? 'Adding…' : `Add ${n} ${n === 1 ? 'tool' : 'tools'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </DialogOverlay>
  );
};

export default SurveySeedDialog;
