import React, { useId, useMemo, useState } from 'react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useTenant } from '../../context/TenantContext';
import { useAssignments } from '../../hooks/useAssignments';
import { useTeams } from '../../hooks/useTeams';
import { ASSIGNMENT_TEXT, assigneeOptions, assignmentErrorMessage, bulkAssignPlan, bulkConfirmText, decodeAssignee } from '../../data/assignments/assignmentsUiView';
import type { TeamMember } from '../../types/tenant';

const NO_MEMBERS: TeamMember[] = [];
/** The picker starts here, so nothing is changed (least of all a removal) until a person, a team or "Unassigned" is chosen on purpose. */
const NOT_CHOSEN = '__choose';

interface BulkAssignDialogProps {
  controlIds: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}

/**
 * Assigns one owner to the controls the matrix filters currently show. A label only: it changes nobody's access. Changes are sent in batches of at most
 * 500, each all-or-nothing and each carrying the owner this screen saw, so an owner someone else just set is refused, not overwritten.
 */
export const BulkAssignDialog: React.FC<BulkAssignDialogProps> = ({ controlIds, onClose, onDone }) => {
  const selId = useId();
  const { currentTenant, teamMembers } = useTenant();
  const { status, byKey, save, reload } = useAssignments();
  const { teams } = useTeams();
  const members = teamMembers[currentTenant.id] ?? NO_MEMBERS;
  const [draft, setDraft] = useState(NOT_CHOSEN);
  const [replace, setReplace] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => assigneeOptions(members, teams, Date.now(), null), [members, teams]);
  const chosen = draft !== NOT_CHOSEN;
  const assignee = decodeAssignee(draft);
  const whoLabel = !chosen || assignee === null ? null : [...options.people, ...options.teams].find((o) => o.value === draft)?.label ?? null;
  const plan = useMemo(() => bulkAssignPlan(controlIds, byKey, assignee, replace), [controlIds, byKey, assignee, replace]);
  // How many controls already have a different owner (what the checkbox would replace)
  const otherCount = useMemo(() => (assignee ? bulkAssignPlan(controlIds, byKey, assignee, true).replacing : 0), [controlIds, byKey, assignee]);
  const n = controlIds.length;
  const ready = status === 'ready';

  const run = async () => {
    if (!chosen || plan.changing === 0 || !ready) return;
    const total = plan.changing;
    let savedCount = 0;
    setSaving(true);
    setError(null);
    try {
      for (const chunk of plan.chunks) {
        setProgress({ done: savedCount, total });
        await save(chunk);
        savedCount += chunk.length;
      }
    } catch (err: unknown) {
      setError(`Assigned ${savedCount} of ${total} controls. The rest were not saved: ${assignmentErrorMessage(err)}`);
      setProgress(null);
      setSaving(false);
      await reload();
      return;
    }
    setSaving(false);
    setProgress(null);
    onDone(assignee ? `Owner assigned to ${total} ${total === 1 ? 'control' : 'controls'}.` : `Owner removed from ${total} ${total === 1 ? 'control' : 'controls'}.`);
  };

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6 space-y-4 shadow-2xl">
        <DialogTitle as="h2" className="text-base font-bold text-white">Assign an owner to the shown controls</DialogTitle>
        <p className="text-xs text-slate-300">{n} {n === 1 ? 'control matches' : 'controls match'} the current filters.</p>
        <p className="text-[11px] text-slate-400">{ASSIGNMENT_TEXT.labelOnly}</p>
        <div>
          <label htmlFor={selId} className="block font-semibold text-slate-300 mb-1.5 text-xs">Owner</label>
          <select
            id={selId}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
          >
            <option value={NOT_CHOSEN} disabled>Choose a person or a team</option>
            <option value="">Unassigned (remove the owner)</option>
            <optgroup label="People">
              {options.people.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </optgroup>
            {options.teams.length > 0 && (
              <optgroup label="Teams">
                {options.teams.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        {assignee && (
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={saving} className="mt-0.5" />
            <span>Also replace a different existing owner ({otherCount} {otherCount === 1 ? 'control' : 'controls'})</span>
          </label>
        )}
        <p aria-live="polite" className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-200">
          {!ready ? (status === 'error' ? ASSIGNMENT_TEXT.loadFailed : ASSIGNMENT_TEXT.loading) : chosen ? bulkConfirmText(plan, whoLabel) : 'Choose who should own these controls.'}
        </p>
        {progress && <p role="status" className="text-xs text-slate-400">Saving {progress.done} of {progress.total}…</p>}
        <ErrorNotice message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={saving || !ready || !chosen || plan.changing === 0}
            className={`${chosen && assignee === null ? 'btn-danger' : 'btn-primary'} px-3.5 py-2 text-xs rounded-xl disabled:opacity-50`}
          >
            {!chosen ? 'Assign' : assignee === null ? `Remove owner from ${plan.changing}` : `Assign to ${plan.changing}`}
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};
