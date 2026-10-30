import React, { useMemo } from 'react';
import { CheckCircle2, Circle, ListOrdered } from 'lucide-react';
import { parseParameterTags, resolveParameters } from '../../data/frameworks/parameters';
import { parametersOfItem, parseItemNotes, setItemNote, setItemParameterValue, setOverviewNote, statementItems, type StatementItem } from '../../data/frameworks/narrativeItems';
import type { ControlParameter, FrameworkControlDefinition } from '../../types/framework';
import { OdpPanel } from './OdpPanel';

interface Props {
  control: FrameworkControlDefinition;
  notes: string;
  canEdit: boolean;
  tenantId: string;
  onNotesChange: (notes: string) => void;
  /** Called when a text field loses focus: the notes are sent to the server then rather than a moment later. */
  onNotesBlur?: () => void;
}

/** True when the control's text is a list of lettered items that an SSP answers one by one (SP 800-53 controls). */
export const hasStatementItems = (control: Pick<FrameworkControlDefinition, 'statement'>): boolean => statementItems(control.statement) !== null;

/** One line of a statement with its [Assignment: ...] / [Selection: ...] tags marked, so the blanks stand out. */
function Line({ text }: { text: string }) {
  const tags = parseParameterTags(text, 'line');
  if (tags.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let from = 0;
  tags.forEach((t, i) => {
    out.push(text.slice(from, t.start));
    out.push(
      <mark key={i} className="rounded px-1 py-0.5 bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 font-mono text-[11px]">
        {t.raw}
      </mark>
    );
    from = t.end ?? text.length;
  });
  out.push(text.slice(from));
  return <>{out}</>;
}

function ItemText({ item }: { item: StatementItem }) {
  const lines = item.text.split('\n');
  return (
    <div className="text-sm text-slate-100 leading-relaxed space-y-1">
      {lines.map((line, i) => {
        const indent = line.length - line.trimStart().length;
        return (
          <p key={i} style={{ paddingLeft: `${Math.min(indent, 8) * 0.5}rem` }} className={i === 0 ? 'font-medium' : 'text-slate-300'}>
            <Line text={line.trim()} />
          </p>
        );
      })}
    </div>
  );
}

/**
 * The SSP authoring view of a control whose text is a list of lettered items: the control text, then each item with the
 * parameters in it and a field for how the organisation meets that item. The answers are kept in the control's one narrative
 * (see data/frameworks/narrativeItems.ts), so the quick editor, exports and the assessor still see the same text; the
 * parameter rows and the "Suggest Parameter Wording" helper are the ones of the quick editor.
 */
export const SspStatementEditor: React.FC<Props> = ({ control, notes, canEdit, tenantId, onNotesChange, onNotesBlur }) => {
  const itemized = useMemo(() => statementItems(control.statement), [control.statement]);
  const params = useMemo(() => resolveParameters(control), [control]);
  const parsed = useMemo(() => parseItemNotes(notes), [notes]);
  if (!itemized) return null;
  const order = itemized.items.map((i) => i.label);
  const answered = itemized.items.filter((i) => (parsed.items[i.label] ?? '').trim() !== '').length;

  return (
    <div className="space-y-5">
      <section aria-label="Control text" className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-1.5">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Control text</h4>
        <p className="text-sm text-slate-100">{control.plainEnglishSummary}</p>
      </section>

      <section aria-label="Overview" className="space-y-1.5">
        <label htmlFor={`ssp-overview-${control.id}`} className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Overview <span className="normal-case font-normal text-slate-400">(optional: how the control works as a whole, not tied to one item)</span>
        </label>
        <textarea
          id={`ssp-overview-${control.id}`}
          rows={2}
          value={parsed.general}
          disabled={!canEdit}
          onChange={(e) => onNotesChange(setOverviewNote(notes, e.target.value, order))}
          onBlur={onNotesBlur}
          placeholder="Anything that applies to the control as a whole."
          className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/60 disabled:opacity-60"
        />
      </section>

      <section aria-label="Implementation details" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
            <ListOrdered className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" /> Implementation details
          </h4>
          <span className="text-xs text-slate-400" role="status">
            {answered} of {itemized.items.length} items documented
          </span>
        </div>
        {itemized.intro && <p className="text-sm text-slate-300">{itemized.intro}</p>}

        <ol className="space-y-3">
          {itemized.items.map((item) => {
            const itemParams: ControlParameter[] = parametersOfItem(item, params);
            const text = parsed.items[item.label] ?? '';
            const done = text.trim() !== '';
            const fieldId = `ssp-item-${control.id}-${item.label}`;
            return (
              <li key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="shrink-0 mt-0.5 font-mono text-xs font-bold px-2 py-1 rounded-lg bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">{item.label}.</span>
                  <div className="min-w-0 flex-1">
                    <ItemText item={{ ...item, text: item.text.replace(/^[a-z]\.\s+/, '') }} />
                  </div>
                  <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] ${done ? 'text-emerald-300' : 'text-slate-400'}`}>
                    {done ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> : <Circle className="w-3.5 h-3.5" aria-hidden="true" />}
                    {done ? 'Documented' : 'Not yet documented'}
                  </span>
                </div>

                {itemParams.length > 0 && (
                  <OdpPanel
                    bare
                    control={control}
                    notes={notes}
                    canEdit={canEdit}
                    tenantId={tenantId}
                    onNotesChange={onNotesChange}
                    params={itemParams}
                    placeValue={(current, p, value) => setItemParameterValue(current, item.label, p, value, order)}
                  />
                )}

                <div>
                  <label htmlFor={fieldId} className="block text-xs font-semibold text-slate-300 mb-1">
                    How is item {item.label}. met?
                  </label>
                  <textarea
                    id={fieldId}
                    rows={3}
                    value={text}
                    disabled={!canEdit}
                    onChange={(e) => onNotesChange(setItemNote(notes, item.label, e.target.value, order))}
                    onBlur={onNotesBlur}
                    placeholder="Who does what, with which tools, how often, and how it is verified."
                    className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/60 disabled:opacity-60"
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* tags and vague wording the author typed into the text above */}
      <OdpPanel control={control} notes={notes} canEdit={canEdit} tenantId={tenantId} onNotesChange={onNotesChange} narrativeOnly />
    </div>
  );
};
