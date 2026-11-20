import React, { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Circle, Clock } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useResponsibilities } from '../../hooks/useResponsibilities';
import { useTeams } from '../../hooks/useTeams';
import { ErrorNotice } from '../common/ErrorNotice';
import { ASSIGNMENT_TEXT } from '../../data/assignments/assignmentsUiView';
import { groupResponsibilities, responsibilityIsOpen } from '../../data/assignments/assignmentsView';
import { getFrameworkControls } from '../../data/frameworks';
import { cmmcDisplayId, cmmcGuideObjectiveId } from '../../data/cmmcGuide/displayId';
import { SSP_SECTIONS } from '../../data/ssp/sspSections';
import type { SspSectionId } from '../../data/ssp/sspSections';
import { statusDisplayLabel } from '../../data/statusLabels';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { controlIdOfObjective } from '../../types/controlObjectives';
import { MAX_RESPONSIBILITY_ITEMS } from '../../types/assignments';
import type { ObjectiveStatus } from '../../types/assessment';
import type { AssignmentTargetKind, ResponsibilityItem } from '../../types/assignments';

const STATUS_CLASS: Record<string, string> = {
  MET: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  NOT_MET: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  IN_PROGRESS: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  NOT_STARTED: 'bg-slate-800 text-slate-300 border-slate-700',
  NOT_APPLICABLE: 'bg-slate-800 text-slate-300 border-slate-700',
};
const STATUS_ICON: Record<string, React.ElementType> = { MET: CheckCircle2, NOT_MET: AlertTriangle, IN_PROGRESS: Clock, NOT_STARTED: Circle, NOT_APPLICABLE: Ban };
const KIND_HEADING: Record<AssignmentTargetKind, string> = { control: 'Controls', objective: 'Objectives', ssp_section: 'SSP sections' };
const KIND_ORDER: AssignmentTargetKind[] = ['control', 'objective', 'ssp_section'];
const TAG_CLASS = 'text-[10px] px-1.5 py-0.5 rounded border';

type PendingOpen = { programId: string; item: ResponsibilityItem };

/**
 * "My responsibilities" and "Team responsibilities" (#253): what is assigned to you directly or through a team, and what is assigned to one team, across
 * the organization's programs. A label list: it grants nothing. A row opens its control, objective or SSP section, switching program first when needed;
 * a row of an archived program cannot be opened.
 */
export const ResponsibilitiesView: React.FC = () => {
  const { canEdit, activeProgram, switchProgram } = useTenant();
  const { setSelectedControlId, setActiveTab, openControlAtObjective, openSspSection } = useAssessment();
  const { teams } = useTeams();
  const [view, setView] = useState<'me' | 'team'>('me');
  const [teamId, setTeamId] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  const [pending, setPending] = useState<PendingOpen | null>(null);
  const [switchFailed, setSwitchFailed] = useState(false);
  const archivedNoteId = useId();
  const headingId = useId();

  // A team view needs a team: the first one until another is chosen (or when the chosen one was deleted)
  const effectiveTeamId = view === 'team' ? (teams.some((t) => t.id === teamId) ? teamId : teams[0]?.id ?? '') : '';
  const effectiveView = view === 'team' && teams.length > 0 ? 'team' : 'me';
  const { supported, status, data, reload } = useResponsibilities({ view: effectiveView, teamId: effectiveTeamId || undefined, includeArchived });

  // Titles of the controls per framework, built once per framework the response mentions
  const titles = useMemo(() => {
    const byFramework = new Map<string, Map<string, string>>();
    for (const p of data?.programs ?? []) {
      if (byFramework.has(p.frameworkId)) continue;
      byFramework.set(p.frameworkId, new Map(getFrameworkControls(p.frameworkId).map((c) => [c.id, c.title])));
    }
    return byFramework;
  }, [data]);

  const open = (item: ResponsibilityItem): void => {
    if (item.targetKind === 'control') {
      setSelectedControlId(item.targetId);
      setActiveTab('matrix');
    } else if (item.targetKind === 'objective') {
      const controlId = controlIdOfObjective(item.targetId);
      if (!controlId) return;
      openControlAtObjective(controlId, item.targetId);
      setActiveTab('matrix');
    } else {
      openSspSection(item.targetId as SspSectionId);
    }
  };

  // Another program: switch first. The context clears what was selected when the program changes, so the row opens on the next tick, after that reset.
  useEffect(() => {
    if (!pending || activeProgram?.id !== pending.programId) return undefined;
    const timer = window.setTimeout(() => {
      open(pending.item);
      setPending(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pending, activeProgram?.id]);

  const activate = (programId: string, archived: boolean, item: ResponsibilityItem): void => {
    if (archived) return;
    setSwitchFailed(false);
    if (programId === activeProgram?.id) {
      open(item);
      return;
    }
    if (!switchProgram(programId)) {
      setSwitchFailed(true);
      return;
    }
    setPending({ programId, item });
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const grouped = new Map(groupResponsibilities(data).map((g) => [g.programId, g]));
    return data.programs
      .filter((p) => grouped.has(p.programId))
      .map((p) => {
        const g = grouped.get(p.programId)!;
        const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, g.byKind[k].filter((i) => !openOnly || responsibilityIsOpen(i))])) as Record<AssignmentTargetKind, ResponsibilityItem[]>;
        return { program: p, byKind, shown: KIND_ORDER.reduce((n, k) => n + byKind[k].length, 0), total: p.items.length };
      });
  }, [data, openOnly]);
  const shownTotal = groups.reduce((n, g) => n + g.shown, 0);
  const anyArchivedShown = groups.some((g) => g.program.archived && g.shown > 0);
  const isTeamView = effectiveView === 'team';
  const heading = isTeamView ? 'Team responsibilities' : 'My responsibilities';

  const rowText = (frameworkId: string, item: ResponsibilityItem): { id: string; title: string } => {
    if (item.targetKind === 'ssp_section') {
      const section = SSP_SECTIONS.find((s) => s.id === item.targetId);
      return { id: section?.number ?? '', title: section?.title ?? 'SSP section' };
    }
    if (item.targetKind === 'control') return { id: cmmcDisplayId(item.targetId, frameworkId), title: titles.get(frameworkId)?.get(item.targetId) ?? '' };
    const controlId = controlIdOfObjective(item.targetId);
    return { id: cmmcGuideObjectiveId(item.targetId, frameworkId), title: (controlId && titles.get(frameworkId)?.get(controlId)) || '' };
  };

  if (!supported) {
    return (
      <div className="space-y-3 animate-fadeIn">
        <h2 id={headingId} className="text-2xl font-black text-white tracking-tight">My responsibilities</h2>
        <p className="text-sm text-slate-400">{ASSIGNMENT_TEXT.browserOnly}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fadeIn">
      <div>
        <h2 id={headingId} className="text-2xl font-black text-white tracking-tight">{heading}</h2>
        <p className="text-xs text-slate-400 mt-1">
          {isTeamView
            ? 'What is assigned to this team across this organization\'s programs.'
            : 'What is assigned to you, directly or through a team, across this organization\'s programs.'}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">{ASSIGNMENT_TEXT.labelOnly}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        {teams.length > 0 && (
          <>
            <div role="group" aria-label="Whose responsibilities" className="flex items-center p-1 bg-slate-900/80 border border-slate-800 rounded-xl">
              {(['me', 'team'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                    view === v ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' : 'border-transparent text-slate-400 hover:text-white'
                  }`}
                >
                  {v === 'me' ? 'Mine' : 'A team'}
                </button>
              ))}
            </div>
            {view === 'team' && (
              <label className="flex items-center gap-2">
                <span className="font-semibold">Team</span>
                <select
                  value={effectiveTeamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="bg-slate-800/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
                >
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Include archived programs
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open items only
        </label>
      </div>

      {status === 'loading' && <p role="status" className="text-xs text-slate-400">Loading your responsibilities…</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message="Responsibilities could not be loaded." />
          <button type="button" onClick={() => void reload()} className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold">
            Try again
          </button>
        </div>
      )}
      {switchFailed && <ErrorNotice message="That program could not be opened." />}

      {status === 'ready' && data && (
        <>
          {data.truncated && <p className="text-xs text-amber-200">Showing the first {MAX_RESPONSIBILITY_ITEMS.toLocaleString('en-US')} items.</p>}
          {shownTotal === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300 space-y-1">
              {groups.length > 0 ? (
                <p>Nothing open is assigned. Clear "Open items only" to see completed items.</p>
              ) : (
                <>
                  <p>{isTeamView ? 'Nothing is assigned to this team yet.' : 'Nothing is assigned to you yet.'}</p>
                  {canEdit && <p className="text-xs text-slate-400">Assign owners from a control, an objective or an SSP section.</p>}
                </>
              )}
            </div>
          ) : (
            groups.filter((g) => g.shown > 0).map(({ program, byKind }) => {
              const sectionId = `${headingId}-${program.programId}`;
              const current = program.programId === activeProgram?.id;
              return (
                <section key={program.programId} aria-labelledby={sectionId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id={sectionId} className="text-sm font-bold text-white">
                      {program.name} <span className="font-normal text-slate-400">· {frameworkLabel(program.frameworkId)}</span>
                    </h3>
                    {current && <span className={`${TAG_CLASS} border-cyan-500/40 text-cyan-200`}>Current program</span>}
                    {program.archived && <span className={`${TAG_CLASS} border-slate-600 text-slate-300`}>Archived</span>}
                  </div>
                  {KIND_ORDER.filter((k) => byKind[k].length > 0).map((k) => (
                    <div key={k} className="space-y-1">
                      <h4 className="text-xs font-semibold text-slate-400">{KIND_HEADING[k]} ({byKind[k].length})</h4>
                      <ul className="divide-y divide-slate-800">
                        {byKind[k].map((item) => {
                          const text = rowText(program.frameworkId, item);
                          const StatusIcon = item.status ? STATUS_ICON[item.status] ?? Circle : null;
                          return (
                            <li key={`${item.targetKind}|${item.targetId}|${item.duty}`}>
                              <button
                                type="button"
                                onClick={() => activate(program.programId, program.archived, item)}
                                aria-disabled={program.archived || undefined}
                                aria-describedby={program.archived ? archivedNoteId : undefined}
                                className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                              >
                                <span className="font-mono text-xs font-bold text-cyan-400">{text.id}</span>
                                <span className="text-xs text-slate-200 truncate">{text.title}</span>
                                {item.status && StatusIcon && (
                                  <span className={`inline-flex items-center gap-1 ${TAG_CLASS} ${STATUS_CLASS[item.status] ?? STATUS_CLASS.NOT_STARTED}`}>
                                    <StatusIcon className="w-3 h-3" aria-hidden="true" />
                                    {statusDisplayLabel(item.status as ObjectiveStatus)}
                                  </span>
                                )}
                                {item.targetKind === 'ssp_section' && item.duty === 'reviewer' && (
                                  <span className={`${TAG_CLASS} ${item.reviewed ? 'border-emerald-500/30 text-emerald-300' : 'border-slate-700 text-slate-300'}`}>
                                    {item.reviewed ? 'Signed off' : 'Not signed off'}
                                  </span>
                                )}
                                <span className={`${TAG_CLASS} border-slate-700 text-slate-300`}>{item.duty === 'owner' ? 'Owner' : 'Reviewer'}</span>
                                {item.via === 'team' && <span className="text-[11px] text-slate-400">via {teams.find((t) => t.id === item.teamId)?.name ?? 'a team'}</span>}
                                {!current && !program.archived && <span className="text-[11px] text-slate-400">Opens {program.name}</span>}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </section>
              );
            })
          )}
          {anyArchivedShown && <p id={archivedNoteId} className="text-xs text-slate-400">Archived: restore the program to open it.</p>}
        </>
      )}
    </div>
  );
};
