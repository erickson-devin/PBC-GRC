import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { AssignControl } from '../assignments/AssignControl';
import type { AssignControlProps } from '../assignments/AssignControl';
import { useAssignControlProps } from '../assignments/useAssignControlProps';
import { useTenant } from '../../context/TenantContext';
import { useTeams } from '../../hooks/useTeams';
import { ASSIGNMENT_TEXT, reviewerCheckText } from '../../data/assignments/assignmentsUiView';
import { reviewerCheck } from '../../data/assignments/assignmentsView';
import { SSP_SECTIONS } from '../../data/ssp/sspSections';
import type { SspSectionId } from '../../data/ssp/sspSections';
import { roleShortLabel } from '../../data/roleView';
import type { SspSectionReview } from '../../types/sspProfile';
import type { TenantRole } from '../../types/tenant';

/** The assigned reviewer's line, presentational: the picker and the advisory check. It never disables the sign-off button. */
export const SspReviewerChipView: React.FC<{ control: AssignControlProps; check: { text: string; tone: 'none' | 'ok' | 'warn' } }> = ({ control, check }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-1.5">
    <AssignControl {...control} />
    <p className={`text-xs flex items-start gap-1.5 ${check.tone === 'warn' ? 'text-amber-200' : check.tone === 'ok' ? 'text-emerald-200' : 'text-slate-400'}`}>
      {check.tone === 'warn'
        ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
        : check.tone === 'ok'
          ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" aria-hidden="true" />
          : <Circle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-500" aria-hidden="true" />}
      <span>{check.text}</span>
    </p>
    <p className="text-[11px] text-slate-500">{ASSIGNMENT_TEXT.advisory}</p>
  </div>
);

/** The reviewer of one signable SSP section against its newest sign-off. Advisory only: the sign-off records whoever signs. */
export const SspReviewerChip: React.FC<{ sectionId: SspSectionId; latest: SspSectionReview | null }> = ({ sectionId, latest }) => {
  const title = SSP_SECTIONS.find((s) => s.id === sectionId)?.title ?? sectionId;
  const control = useAssignControlProps('ssp_section', sectionId, 'reviewer', title);
  const { currentTenant, teamMembers } = useTenant();
  const { teams } = useTeams();
  const members = teamMembers[currentTenant.id];
  const check = useMemo(() => {
    const roles = new Map<string, TenantRole>();
    for (const m of members ?? []) if (m.userId) roles.set(m.userId, m.role);
    const teamMap = new Map<string, string[]>(teams.map((t) => [t.id, t.memberIds]));
    const result = reviewerCheck(control.assignment, latest, { teams: teamMap, roles });
    const who = control.assignment?.assignee;
    const person = who && who.kind === 'user' ? (members ?? []).find((m) => m.userId === who.id) : undefined;
    const name = person ? (person.name || '').trim() || person.email : null;
    return reviewerCheckText(result, name, person ? roleShortLabel(person.role) : null);
  }, [control.assignment, latest, members, teams]);
  return <SspReviewerChipView control={control} check={check} />;
};
