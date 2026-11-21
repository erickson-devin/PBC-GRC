import React, { useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { ASSIGNMENT_TEXT, decodeAssignee, encodeAssignee } from '../../data/assignments/assignmentsUiView';
import type { assigneeChip, assigneeOptions } from '../../data/assignments/assignmentsUiView';
import type { AssigneeRef, Assignment, AssignmentDuty } from '../../types/assignments';
import { useAssignControlProps } from './useAssignControlProps';

export interface AssignControlProps {
  duty: AssignmentDuty;
  /** What is assigned, for the accessible names ("AC.L2-3.1.1", "objective AC.L2-3.1.1[a]", "Roles"). */
  targetLabel: string;
  assignment: Assignment | null;
  options: ReturnType<typeof assigneeOptions>;
  chip: ReturnType<typeof assigneeChip>;
  canAssign: boolean;
  lockedReason: string | null;
  busy: boolean;
  error: string | null;
  compact?: boolean;
  showHint?: boolean;
  /** Resolves true when the change was saved. */
  onSave: (next: AssigneeRef | null) => Promise<boolean>;
}

const CHIP_TONE: Record<AssignControlProps['chip']['tone'], string> = {
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  none: 'border-dashed border-slate-700 text-slate-400',
  ok: 'border-slate-700 bg-slate-800 text-slate-200',
};

/**
 * Who holds a duty on one control, objective or SSP section: a chip, and for a Tenant Owner or Admin a native picker with an explicit Save (a closed
 * select fires `change` on every arrow key, so it never saves on change). Props only: the glue is useAssignControlProps. An assignment is a label.
 */
export const AssignControl: React.FC<AssignControlProps> = ({
  duty, targetLabel, assignment, options, chip, canAssign, lockedReason, busy, error, compact, showHint, onSave,
}) => {
  const labelId = useId();
  const selectId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [announce, setAnnounce] = useState('');
  const dutyName = duty === 'owner' ? 'owner' : 'reviewer';
  const currentValue = encodeAssignee(assignment?.assignee ?? null);

  const focusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());
  const cancel = () => {
    setEditing(false);
    focusTrigger();
  };
  const save = async () => {
    const ok = await onSave(decodeAssignee(draft));
    if (!ok) return;
    const chosen = [...options.people, ...options.teams].find((o) => o.value === draft);
    setEditing(false);
    setAnnounce(`${duty === 'owner' ? ASSIGNMENT_TEXT.owner : ASSIGNMENT_TEXT.reviewer} set to ${chosen ? chosen.label : ASSIGNMENT_TEXT.unassigned}.`);
    focusTrigger();
  };

  return (
    <div className={compact ? 'space-y-1' : 'space-y-1.5'}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span id={labelId} className="font-semibold text-slate-400">{duty === 'owner' ? ASSIGNMENT_TEXT.owner : ASSIGNMENT_TEXT.reviewer}</span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border ${CHIP_TONE[chip.tone]}`}>
          {chip.tone === 'warn' && <AlertTriangle className="w-3 h-3" aria-hidden="true" />}
          {chip.text}
          {chip.tag && <span className="font-semibold">· {chip.tag}</span>}
        </span>
        {canAssign && !editing && (
          <button
            type="button"
            ref={triggerRef}
            onClick={() => { setDraft(currentValue); setEditing(true); }}
            aria-label={`${assignment ? 'Change' : 'Assign'} ${dutyName} of ${targetLabel}`}
            className="font-semibold text-cyan-300 hover:text-cyan-200 hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            {assignment ? 'Change' : 'Assign'}
          </button>
        )}
      </div>
      {editing && (
        <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="sr-only">{`${duty === 'owner' ? 'Owner' : 'Reviewer'} of ${targetLabel}`}</label>
          <select
            id={selectId}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }}
            className="bg-slate-800/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
          >
            <option value="">Unassigned</option>
            {options.currentExtra && <option value={options.currentExtra.value} disabled>{options.currentExtra.label}</option>}
            <optgroup label="People">
              {options.people.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </optgroup>
            {options.teams.length > 0 && (
              <optgroup label="Teams">
                {options.teams.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
              </optgroup>
            )}
          </select>
          <button type="button" onClick={() => void save()} disabled={busy || draft === currentValue} className="btn-primary px-3 py-1.5 text-xs rounded-lg disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} className="px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
        </div>
      )}
      {!canAssign && lockedReason && !compact && <p className="text-[11px] text-slate-400">{lockedReason}</p>}
      {showHint && <p className="text-[11px] text-slate-400">{ASSIGNMENT_TEXT.labelOnly}</p>}
      <ErrorNotice message={error} />
      <span role="status" aria-live="polite" className="sr-only">{announce}</span>
    </div>
  );
};

/** The owner of one objective, a compact row beside its status (the hook cannot be called inside a map). */
export const ObjectiveOwner: React.FC<{ objectiveId: string; label: string }> = ({ objectiveId, label }) => {
  const props = useAssignControlProps('objective', objectiveId, 'owner', label);
  return <AssignControl {...props} compact />;
};

/** The owner of one SSP section. */
export const SectionOwner: React.FC<{ sectionId: string; label: string }> = ({ sectionId, label }) => {
  const props = useAssignControlProps('ssp_section', sectionId, 'owner', label);
  return <AssignControl {...props} showHint />;
};
