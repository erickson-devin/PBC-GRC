import { useCallback, useMemo, useState } from 'react';
import { useTenant } from '../../context/TenantContext';
import { assignmentKey, useAssignments } from '../../hooks/useAssignments';
import { useTeams } from '../../hooks/useTeams';
import { ASSIGNMENT_TEXT, assigneeChip, assigneeOptions, assignmentErrorMessage } from '../../data/assignments/assignmentsUiView';
import type { AssigneeRef, AssignmentDuty, AssignmentTargetKind } from '../../types/assignments';
import type { TeamMember } from '../../types/tenant';
import type { AssignControlProps } from './AssignControl';

const NO_MEMBERS: TeamMember[] = [];

/**
 * The props of one AssignControl: who holds the duty on this item, the people and teams that can be chosen, and the save. A label only: whether
 * the control offers a change depends on the write role, never on who is named. Call it at the top level of a component (it holds hooks).
 */
export function useAssignControlProps(targetKind: AssignmentTargetKind, targetId: string, duty: AssignmentDuty, targetLabel: string): AssignControlProps {
  const { currentTenant, teamMembers, canEdit, activeProgram } = useTenant();
  const assignments = useAssignments();
  const { teams } = useTeams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignment = assignments.byKey.get(assignmentKey({ targetKind, targetId, duty })) ?? null;
  const members = teamMembers[currentTenant.id] ?? NO_MEMBERS;
  const archived = Boolean(activeProgram?.archived);
  const ready = assignments.supported && assignments.status === 'ready';
  const canAssign = canEdit && ready && !archived;
  const lockedReason = !assignments.supported
    ? ASSIGNMENT_TEXT.browserOnly
    : archived
      ? ASSIGNMENT_TEXT.archived
      : !canEdit
        ? ASSIGNMENT_TEXT.readOnly
        : assignments.status === 'error'
          ? ASSIGNMENT_TEXT.loadFailed
          : null;

  const current = assignment?.assignee ?? null;
  // The time is read when the member list or assignment changes: only used to mark an access date that has passed
  const options = useMemo(() => assigneeOptions(members, teams, Date.now(), current), [members, teams, current]);
  const chip = useMemo(
    () => (assignments.status === 'loading' ? { text: ASSIGNMENT_TEXT.loading, tag: null, tone: 'none' as const } : assigneeChip(assignment, members, teams)),
    [assignments.status, assignment, members, teams]
  );

  const { save } = assignments;
  const onSave = useCallback(
    async (next: AssigneeRef | null): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await save([{ targetKind, targetId, duty, assignee: next, expectedAssignee: current }]);
        return true;
      } catch (err: unknown) {
        setError(assignmentErrorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [save, targetKind, targetId, duty, current]
  );

  return { duty, targetLabel, assignment, options, chip, canAssign, lockedReason, busy, error, onSave };
}
