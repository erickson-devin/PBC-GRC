import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, Undo2, SlidersHorizontal, Loader2 } from 'lucide-react';
import { ApiClient } from '../../services/apiClient';
import { findVagueWording, isParameterOpen, parameterValue, parseParameterTags, replaceSentence, replaceTag, resolveParameters, setParameterValue } from '../../data/frameworks/parameters';
import type { ControlParameter, FrameworkControlDefinition } from '../../types/framework';
import type { AiAssistStatus, WordingSuggestionRequest, WordingSuggestions } from '../../types/aiAssist';

interface Props {
  control: FrameworkControlDefinition;
  notes: string;
  canEdit: boolean;
  tenantId: string;
  onNotesChange: (notes: string) => void;
  /**
   * Show only these statement parameters (the ones of one SSP item) instead of all of the control's. The narrative's own tags and
   * its vague wording are then left to the panel that has no `params`.
   */
  params?: ControlParameter[];
  /** Only the narrative's own tags and vague wording (the SSP item editor shows the parameters beside each item). */
  narrativeOnly?: boolean;
  /** Where a new "Parameter: label = value" line goes (default: the end of the narrative). */
  placeValue?: (notes: string, p: ControlParameter, value: string) => string;
  /** No frame and heading: the panel sits inside something that has its own. */
  bare?: boolean;
}

// One status request per tenant for all panels on the page (an SSP with twelve items would otherwise ask twelve times)
const statusCache = new Map<string, Promise<AiAssistStatus>>();
function loadStatus(tenantId: string): Promise<AiAssistStatus> {
  let p = statusCache.get(tenantId);
  if (!p) {
    p = ApiClient.aiAssistStatus(tenantId).catch((): AiAssistStatus => ({ enabled: false, available: false, model: '', canUse: false, reason: 'The AI helper status could not be read.' }));
    statusCache.set(tenantId, p);
    setTimeout(() => statusCache.delete(tenantId), 30_000); // the model may be started or stopped meanwhile
  }
  return p;
}

type Suggestion = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; result: WordingSuggestions };

/**
 * Organization-defined parameters of a control, shown under the implementation narrative: the blanks an assessor expects to see
 * filled in with explicit values, and any vague wording ("reviewed periodically") in the narrative. A person can type a value,
 * use the baseline, or ask the local model to suggest wording. Suggestions are only ever applied by a click, as an ordinary
 * edit of the narrative that can be undone; nothing is saved by this panel.
 */
/** The sentence of the narrative that holds a tag, the tag marked <<like this>> (what the model is told about where the blank sits). */
function tagSentence(notes: string, p: ControlParameter): string | undefined {
  if (p.start === undefined || p.end === undefined) return undefined;
  const from = Math.max(notes.lastIndexOf('.', p.start - 1), notes.lastIndexOf('\n', p.start - 1)) + 1;
  const stop = notes.slice(p.end).search(/[.\n]/);
  const to = stop === -1 ? notes.length : p.end + stop + 1;
  return (notes.slice(from, p.start) + `<<${p.prompt}>>` + notes.slice(p.end, to)).replace(/\s+/g, ' ').trim();
}

export const OdpPanel: React.FC<Props> = ({ control, notes, canEdit, tenantId, onNotesChange, params, narrativeOnly, placeValue, bare }) => {
  const catalogParams = useMemo(() => (narrativeOnly ? [] : params ?? resolveParameters(control)), [control, params, narrativeOnly]);
  const scoped = params !== undefined;
  const tagParams = useMemo(() => (scoped ? [] : parseParameterTags(notes, `${control.id}:notes`, 'NOTES')), [notes, control.id, scoped]);
  const vague = useMemo(() => (scoped ? [] : findVagueWording(notes)), [notes, scoped]);
  const [status, setStatus] = useState<AiAssistStatus | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const [expanded, setExpanded] = useState(true);

  const hasAnything = catalogParams.length + tagParams.length + vague.length > 0;

  useEffect(() => {
    if (!canEdit || !hasAnything || status) return;
    let alive = true;
    loadStatus(tenantId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [canEdit, hasAnything, status, tenantId]);

  if (!hasAnything) return null;

  const apply = (next: string) => {
    if (next === notes) return false;
    setUndo({ before: notes, after: next });
    onNotesChange(next);
    return true;
  };
  const setValue = (p: ControlParameter, value: string) => {
    apply(p.source === 'NOTES' ? replaceTag(notes, p, value) : (placeValue ?? setParameterValue)(notes, p, value));
  };

  const ask = async (key: string, body: WordingSuggestionRequest) => {
    setSuggestions((s) => ({ ...s, [key]: { state: 'loading' } }));
    try {
      const result = await ApiClient.suggestParameterWording(tenantId, body);
      setSuggestions((s) => ({ ...s, [key]: { state: 'done', result } }));
    } catch (e) {
      setSuggestions((s) => ({ ...s, [key]: { state: 'error', message: e instanceof Error ? e.message : 'The AI helper failed.' } }));
    }
  };

  const aiReady = canEdit && status?.available && status.canUse;
  const aiHint = !canEdit ? undefined : !status ? 'Checking the AI helper…' : !status.available ? status.reason ?? 'The AI helper is not available.' : !status.canUse ? 'Your role cannot use the AI helper.' : undefined;

  const suggestionList = (key: string, onUse: (text: string) => void, useLabel: string) => {
    const s = suggestions[key];
    if (!s) return null;
    if (s.state === 'loading')
      return (
        <p className="flex items-center gap-1.5 text-xs text-slate-300" role="status">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Asking the local model…
        </p>
      );
    if (s.state === 'error') return <p className="text-xs text-rose-300" role="alert">{s.message}</p>;
    if (s.result.options.length === 0)
      return <p className="text-xs text-amber-300" role="status">The model gave no usable wording{s.result.rejected ? ` (${s.result.rejected} answer${s.result.rejected === 1 ? '' : 's'} failed the checks)` : ''}. Write it yourself or try again.</p>;
    return (
      <ul className="space-y-1.5" aria-label="Suggested wording">
        {s.result.options.map((o) => (
          <li key={o.text} className="flex items-start justify-between gap-3 rounded-lg bg-slate-800/70 border border-slate-700 p-2">
            <div className="min-w-0 text-xs">
              <p className="text-slate-100 break-words">{o.text}</p>
              {o.note && <p className="text-slate-400 mt-0.5">{o.note}</p>}
            </div>
            <button type="button" onClick={() => onUse(o.text)} className="shrink-0 px-2 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs font-semibold hover:bg-cyan-500/25">
              {useLabel}
            </button>
          </li>
        ))}
        <li className="text-[11px] text-slate-500 list-none">AI suggestion from {s.result.model}: check it before using it. Nothing is saved until you save the narrative.</li>
      </ul>
    );
  };

  const suggestButton = (key: string, body: WordingSuggestionRequest) => (
    <button
      type="button"
      disabled={!aiReady || suggestions[key]?.state === 'loading'}
      title={aiHint}
      onClick={() => ask(key, body)}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-200 text-xs font-semibold hover:bg-violet-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> Suggest Parameter Wording
    </button>
  );

  const paramRow = (p: ControlParameter) => {
    const open = isParameterOpen(p, notes);
    const current = parameterValue(p, notes);
    const draft = drafts[p.id] ?? current ?? '';
    const key = `p:${p.id}`;
    const body: WordingSuggestionRequest =
      p.source === 'NOTES'
        ? { controlId: control.id, parameter: { kind: p.kind, label: p.label, prompt: p.prompt, choices: p.choices, selectionMode: p.selectionMode }, context: tagSentence(notes, p) }
        : { controlId: control.id, parameterId: p.id };
    return (
      <li key={p.id} className="rounded-xl bg-slate-900/70 border border-slate-700/70 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-slate-100 break-words">{p.label}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-slate-300">{p.kind === 'SELECTION' ? 'Selection' : 'Assignment'}</span>
            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${open ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'}`}>{open ? 'Open' : 'Set'}</span>
          </div>
          {canEdit && suggestButton(key, body)}
        </div>
        {p.kind === 'SELECTION' && p.choices?.length ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${p.label} choices`}>
            {p.choices.map((c) => (
              <button key={c} type="button" disabled={!canEdit || /\[\s*(assignment|selection)/i.test(c)} onClick={() => setValue(p, c)} className="px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-xs text-slate-100 hover:border-cyan-400 disabled:opacity-50">
                {c}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`Value for ${p.label}`}
              disabled={!canEdit}
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && canEdit && draft.trim() && (e.preventDefault(), setValue(p, draft))}
              placeholder={p.defaultValue ? `e.g. ${p.defaultValue}` : 'An explicit value, e.g. every 90 days'}
              className="flex-1 min-w-[12rem] px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 focus:border-cyan-400 text-xs text-slate-100 placeholder-slate-500"
            />
            <button type="button" disabled={!canEdit || !draft.trim()} onClick={() => setValue(p, draft)} className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs font-semibold hover:bg-cyan-500/25 disabled:opacity-50">
              Set
            </button>
            {p.defaultValue && open && canEdit && (
              <button type="button" onClick={() => setValue(p, p.defaultValue!)} className="px-2 py-1.5 rounded-lg border border-slate-600 text-xs text-slate-200 hover:border-cyan-400">
                Use baseline ({p.defaultValue})
              </button>
            )}
          </div>
        )}
        {suggestionList(key, (text) => { setValue(p, text); setDrafts((d) => ({ ...d, [p.id]: text })); }, p.source === 'NOTES' ? 'Fill in tag' : 'Use value')}
      </li>
    );
  };

  return (
    <section aria-label="Organization-defined parameters" className={bare ? 'space-y-2' : 'rounded-xl border border-slate-700/80 bg-slate-950/40 p-3 space-y-3'}>
      <div className={`flex items-center justify-between gap-2 ${bare && !(undo && notes === undo.after) ? 'hidden' : ''}`}>
        <h4 className={`flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300 ${bare ? 'sr-only' : ''}`}>
          <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" /> Organization-defined parameters
        </h4>
        <div className="flex items-center gap-2">
          {undo && notes === undo.after && canEdit && (
            <button type="button" onClick={() => { onNotesChange(undo.before); setUndo(null); }} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-600 text-xs text-slate-200 hover:border-cyan-400">
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Undo
            </button>
          )}
          {!bare && (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="text-xs text-slate-400 hover:text-slate-200">
              {expanded ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>
      {(expanded || bare) && (
        <>
          {!bare && <p className="text-xs text-slate-400">An assessor must be able to test every value. Fill in the blanks below with explicit values. {aiHint && <span className="text-slate-500">{aiHint}</span>}</p>}
          {(catalogParams.length > 0 || tagParams.length > 0) && <ul className="space-y-2">{[...catalogParams, ...tagParams].map(paramRow)}</ul>}
          {vague.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-amber-300">Vague wording in the narrative</p>
              <ul className="space-y-2">
                {vague.map((v) => {
                  const key = `s:${v.start}:${v.sentence}`;
                  return (
                    <li key={key} className="rounded-xl bg-slate-900/70 border border-amber-500/30 p-3 space-y-2">
                      <p className="text-xs text-slate-100 break-words">“{v.sentence}”</p>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-slate-400">Hard to test: {v.terms.join(', ')}</span>
                        {canEdit && suggestButton(key, { controlId: control.id, sentence: v.sentence })}
                      </div>
                      {suggestionList(key, (text) => { if (!apply(replaceSentence(notes, v, text))) setSuggestions((s) => ({ ...s, [key]: { state: 'error', message: 'The narrative changed since. Ask again.' } })); }, 'Replace in narrative')}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
};
