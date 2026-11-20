import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { VM_POAM_DATE_MAX, VM_POAM_DATE_MIN } from '../../data/poamDates';
import {
  MILESTONE_COPY, POAM_MILESTONES_MAX, POAM_MILESTONE_DESCRIPTION_MAX, milestoneLabel, milestoneRemovedText, moveMilestone, newMilestoneDraft,
  nextNewMilestoneNumber, printedMilestoneLine, type MilestoneDraft, type MilestoneRowError,
} from '../../data/reports/poamMilestoneForm';
import { SMALL_BUTTON } from './PoamGroupPanel';

export interface PoamMilestonesEditorProps {
  value: readonly MilestoneDraft[];
  onChange: (next: MilestoneDraft[]) => void;
  /** The save is running: the controls are disabled. */
  disabled?: boolean;
  /** The entry is locked or the person cannot edit: the list is shown as text. */
  readOnly?: boolean;
  /** Per row, shown only after the first save attempt (the caller passes {} before). */
  errors?: Record<number, MilestoneRowError>;
  /** Unique id prefix of the dialog (several dialogs never share ids). */
  idBase: string;
}

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';
const iconButton = 'p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The milestones of a POA&M entry (#304): an ordered list the person adds to, reorders with buttons (the printed numbering is the list order),
 * and removes from. The text lives in the parent's React state only (never logged or stored); texts name a milestone by its number.
 * Focus rules: Add focuses the new row; Remove moves focus to the next row (else the previous, else Add); a move button that hits the end of
 * the list hands focus to its opposite.
 */
export const PoamMilestonesEditor: React.FC<PoamMilestonesEditorProps> = ({ value, onChange, disabled = false, readOnly = false, errors = {}, idBase }) => {
  const [announcement, setAnnouncement] = useState('');
  const pendingFocus = useRef<string | null>(null);
  const fieldId = (key: string, part: string): string => `${idBase}-ms-${key}-${part}`;
  const atLimit = value.length >= POAM_MILESTONES_MAX;
  const limitId = `${idBase}-ms-limit`;
  const legendId = `${idBase}-ms-legend`;

  // After the commit that changed the rows: focus the element that was asked for (by id), else nothing
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }, [value]);

  const update = (index: number, patch: Partial<MilestoneDraft>) => onChange(value.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  const add = () => {
    if (atLimit || disabled) return;
    const draft = newMilestoneDraft(nextNewMilestoneNumber(value));
    pendingFocus.current = fieldId(draft.key, 'description');
    onChange([...value, draft]);
  };

  const remove = (index: number) => {
    const next = value.filter((_, i) => i !== index);
    // The row that takes its place (the next one), else the previous, else the Add button
    const target = next[index] ?? next[index - 1];
    pendingFocus.current = target ? fieldId(target.key, 'description') : `${idBase}-ms-add`;
    setAnnouncement(milestoneRemovedText(index));
    onChange(next);
  };

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    const atEnd = to < 0 || to >= value.length;
    if (atEnd) return;
    const key = value[index].key;
    // The moved row's button keeps focus; when it is now at the end its button is disabled, so focus goes to the opposite move button
    const nowAtEnd = dir === -1 ? to === 0 : to === value.length - 1;
    pendingFocus.current = fieldId(key, nowAtEnd ? (dir === -1 ? 'down' : 'up') : (dir === -1 ? 'up' : 'down'));
    setAnnouncement(`${milestoneLabel(index)} moved to ${milestoneLabel(to)}.`);
    onChange(moveMilestone(value, index, dir));
  };

  if (readOnly) {
    return (
      <div className="space-y-1.5">
        <p id={legendId} className="text-xs font-medium text-slate-300">Milestones</p>
        {value.length === 0 ? (
          <p className="text-xs text-slate-300">{MILESTONE_COPY.empty}</p>
        ) : (
          <ol aria-labelledby={legendId} className="space-y-1 text-xs text-slate-200 list-none p-0 m-0">
            {value.map((d, i) => <li key={d.key} className="break-words">{printedMilestoneLine(d, i)}</li>)}
          </ol>
        )}
      </div>
    );
  }

  return (
    <fieldset className="space-y-2 min-w-0">
      <legend className="block text-xs font-medium text-slate-300 mb-1">Milestones</legend>
      <p className="text-xs text-slate-400">{MILESTONE_COPY.hint}</p>
      {value.length === 0 && <p className="text-xs text-slate-300">{MILESTONE_COPY.empty}</p>}
      {value.length > 0 && (
        <ol className="space-y-3 list-none p-0 m-0">
          {value.map((d, i) => {
            const label = milestoneLabel(i);
            const err = errors[i];
            const descId = fieldId(d.key, 'description');
            const dateId = fieldId(d.key, 'date');
            const doneId = fieldId(d.key, 'completed');
            return (
              <li key={d.key} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold text-amber-300">{label}</span>
                  {d.completed && <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">{MILESTONE_COPY.completedBadge}</span>}
                </div>
                <div>
                  <label htmlFor={descId} className="block text-xs font-medium text-slate-300 mb-1">{label} description</label>
                  <input
                    id={descId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={POAM_MILESTONE_DESCRIPTION_MAX}
                    disabled={disabled}
                    value={d.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    aria-invalid={err?.description ? true : undefined}
                    aria-describedby={err?.description ? `${descId}-error` : undefined}
                    className={inputClass}
                  />
                  {err?.description && <p id={`${descId}-error`} className="mt-1 text-xs text-rose-300">{err.description}</p>}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor={dateId} className="block text-xs font-medium text-slate-300 mb-1">{label} target date</label>
                    <input
                      id={dateId}
                      type="date"
                      min={VM_POAM_DATE_MIN}
                      max={VM_POAM_DATE_MAX}
                      disabled={disabled}
                      value={d.targetDate}
                      onChange={(e) => update(i, { targetDate: e.target.value })}
                      aria-invalid={err?.targetDate ? true : undefined}
                      aria-describedby={err?.targetDate ? `${dateId}-error` : undefined}
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                  <label htmlFor={doneId} className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer pb-2">
                    <input id={doneId} type="checkbox" disabled={disabled} checked={d.completed} onChange={(e) => update(i, { completed: e.target.checked })} className="h-3.5 w-3.5" />
                    {label} completed
                  </label>
                  <div className="flex items-center gap-1.5 ml-auto pb-1">
                    <button id={fieldId(d.key, 'up')} type="button" aria-label={`Move ${label} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)} className={iconButton}>
                      <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button id={fieldId(d.key, 'down')} type="button" aria-label={`Move ${label} down`} disabled={disabled || i === value.length - 1} onClick={() => move(i, 1)} className={iconButton}>
                      <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => remove(i)} className={iconButton}>
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {err?.targetDate && <p id={`${dateId}-error`} className="text-xs text-rose-300">{err.targetDate}</p>}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          id={`${idBase}-ms-add`}
          type="button"
          onClick={add}
          disabled={disabled || atLimit}
          aria-describedby={atLimit ? limitId : undefined}
          className={`${SMALL_BUTTON} inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed`}
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          Add a milestone
        </button>
        {atLimit && (
          <p id={limitId} className="flex items-center gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {MILESTONE_COPY.limit}
          </p>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    </fieldset>
  );
};
