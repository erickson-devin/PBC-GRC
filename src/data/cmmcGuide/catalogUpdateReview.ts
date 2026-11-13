/**
 * Review of the answers the CMMC Assessment Guide update set back to In progress (#287): turns the server's listing (or the record a browser-only
 * cache keeps) into rows the matrix notice and its list show, with the guide's new wording and the platform's earlier wording beside each answer.
 * Pure functions: no React, no storage, no network. Ids, statuses and guide text only; never a narrative.
 */
import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import type { AssessmentState } from '../../types/cmmc';
import { controlIdOfObjective, isObjectiveStatus, type CatalogUpdateChanges } from '../../types/controlObjectives';
import type { ControlStatusChange, ObjectiveStatusChange } from './migration';
import { cmmcDisplayId, cmmcGuideObjectiveId } from './displayId';
import { cmmcNumberOf, guideObjectives } from './guide';
import { legacyObjectives } from './objectives';

export type CatalogNoticeMode = 'hidden' | 'review' | 'done';

export interface CatalogUpdateRow {
  objectiveId: string;
  controlId: string;
  /** The control id the guide prints for the program's level. */
  controlDisplayId: string;
  /** The objective id the guide prints (a Level 1 program re-letters the three PE controls). */
  displayId: string;
  /** The guide's wording; null for an answer whose letter the guide no longer has. */
  newText: string | null;
  /** The wording the platform had before the guide, when it had this letter. */
  oldText: string | null;
  previousStatus: ObjectiveStatus;
  setTo: ObjectiveStatus;
  currentStatus: ObjectiveStatus | null;
  /** A person has set the status again since the update. */
  reviewed: boolean;
  /** The answer is kept, but the guide has no objective with its letter, so the checklist does not show it. */
  orphan: boolean;
  changedAt: string;
}

export interface CatalogUpdateSummary {
  /** Answers the update set to In progress, orphans left out. */
  answers: number;
  /** Controls those answers belong to. */
  controls: number;
  unreviewedAnswers: number;
  unreviewedControls: number;
  orphans: number;
  /** The controls with an answer still to check (what the matrix filter shows). */
  controlIds: Set<string>;
}

export const CATALOG_LIST_PAGE = 25;

const asStatus = (s: string | null | undefined, fallback: ObjectiveStatus): ObjectiveStatus => (isObjectiveStatus(s) ? s : fallback);

/** The rows for the listing: guide wording, earlier wording, whether the answer was changed since. Sorted by objective id. */
export function catalogUpdateRows(
  changes: CatalogUpdateChanges,
  framework: string,
  objectives?: Record<string, AssessmentObjective>
): CatalogUpdateRow[] {
  const rows = changes.objectives.map((c): CatalogUpdateRow => {
    const m = /^(.+)\[([a-z0-9]+)\]$/.exec(c.objectiveId);
    const letter = m ? m[2] : '';
    const number = cmmcNumberOf(c.controlId);
    const guide = number ? guideObjectives(number, framework).find((g) => g.letter === letter) : undefined;
    const old = legacyObjectives(c.controlId, framework).find((o) => o.letter === letter);
    const setTo = asStatus(c.newStatus, 'IN_PROGRESS');
    const own = objectives?.[c.objectiveId]?.status;
    const current = own ?? (isObjectiveStatus(c.currentStatus) ? c.currentStatus : null);
    return {
      objectiveId: c.objectiveId,
      controlId: c.controlId,
      controlDisplayId: cmmcDisplayId(c.controlId, framework),
      displayId: cmmcGuideObjectiveId(c.objectiveId, framework),
      newText: guide ? guide.text : null,
      oldText: old ? old.text : null,
      previousStatus: asStatus(c.oldStatus, 'NOT_STARTED'),
      setTo,
      currentStatus: current,
      reviewed: c.reviewed || (own !== undefined && own !== setTo),
      orphan: !guide,
      changedAt: c.changedAt,
    };
  });
  return rows.sort((a, b) => (a.objectiveId < b.objectiveId ? -1 : a.objectiveId > b.objectiveId ? 1 : 0));
}

export function catalogUpdateSummary(rows: CatalogUpdateRow[]): CatalogUpdateSummary {
  const listed = rows.filter((r) => !r.orphan);
  const todo = listed.filter((r) => !r.reviewed);
  return {
    answers: listed.length,
    controls: new Set(listed.map((r) => r.controlId)).size,
    unreviewedAnswers: todo.length,
    unreviewedControls: new Set(todo.map((r) => r.controlId)).size,
    orphans: rows.length - listed.length,
    controlIds: new Set(todo.map((r) => r.controlId)),
  };
}

/** The record a browser-only cache keeps (ids and statuses only), from the client migration's change lists. */
export function browserCatalogUpdate(
  changedObjectives: ObjectiveStatusChange[],
  changedControls: ControlStatusChange[],
  rev: string,
  at: string
): NonNullable<AssessmentState['catalogUpdate']> {
  return {
    rev,
    at,
    objectives: changedObjectives.map((c) => ({ objectiveId: c.id, controlId: controlIdOfObjective(c.id) ?? c.id, from: c.from, to: c.to })),
    controls: changedControls.map((c) => ({ controlId: c.id, from: c.from, to: c.to })),
  };
}

/** The browser-only record in the shape of the server's listing; `reviewed` is then derived from the answers' status now. */
export function catalogUpdateFromBrowserRecord(r: NonNullable<AssessmentState['catalogUpdate']>): CatalogUpdateChanges {
  return {
    applies: true,
    catalogRev: r.rev,
    objectives: r.objectives.map((o) => ({
      objectiveId: o.objectiveId,
      controlId: o.controlId,
      oldStatus: o.from,
      newStatus: o.to,
      currentStatus: null,
      reviewed: false,
      changedAt: r.at,
    })),
    controls: r.controls.map((c) => ({ controlId: c.controlId, oldStatus: c.from, newStatus: c.to, changedAt: r.at })),
    truncated: false,
  };
}

/** 'cmmc-ag-2.13' -> 'CMMC Assessment Guide v2.13'. */
export function catalogRevLabel(rev: string | null): string {
  const m = rev ? /^cmmc-ag-(\d+(?:\.\d+)*)$/.exec(rev) : null;
  return m ? `CMMC Assessment Guide v${m[1]}` : 'CMMC Assessment Guide';
}

const STATUS_LABELS: Record<ObjectiveStatus, string> = {
  MET: 'Met',
  NOT_MET: 'Not met',
  IN_PROGRESS: 'In progress',
  NOT_STARTED: 'Not started',
  NOT_APPLICABLE: 'Not applicable',
};

export const objectiveStatusLabel = (s: ObjectiveStatus): string => STATUS_LABELS[s] ?? s;

export const previousStatusBadge = (s: ObjectiveStatus): string => `Was ${objectiveStatusLabel(s)} before the objective update`;

export const objectiveNotInChecklist = (displayId: string): string => `Objective ${displayId} is not in this control's checklist.`;

export function catalogUpdateNoticeMode(v: {
  status: 'off' | 'loading' | 'error' | 'ready';
  summary: CatalogUpdateSummary;
  dismissed: boolean;
}): CatalogNoticeMode {
  if (v.status !== 'ready' || v.dismissed || v.summary.answers + v.summary.orphans === 0) return 'hidden';
  return v.summary.unreviewedAnswers > 0 ? 'review' : 'done';
}

export function catalogUpdateNoticeCopy(
  s: CatalogUpdateSummary,
  o: { canEdit: boolean; rev: string | null }
): { heading: string; count: string; explain: string; action: string; orphanNote: string | null; allDone: string | null } {
  const n = s.unreviewedAnswers;
  const m = s.unreviewedControls;
  return {
    heading: `The assessment objectives were updated to the ${catalogRevLabel(o.rev)}.`,
    count: `${n} ${n === 1 ? 'answer' : 'answers'} on ${m} ${m === 1 ? 'control' : 'controls'} ${n === 1 ? 'needs' : 'need'} another look.`,
    explain: 'Answers that were Met or Not applicable on an objective whose wording changed were set to In progress. Narratives and evidence were kept.',
    action: o.canEdit ? 'Check each answer against the new wording and set its status again.' : 'A Tenant Owner or MSP Admin can set the status again.',
    orphanNote:
      s.orphans === 0
        ? null
        : s.orphans === 1
          ? '1 more answer is kept for an objective the guide no longer has. It is in the list.'
          : `${s.orphans} more answers are kept for objectives the guide no longer has. They are in the list.`,
    allDone:
      s.answers === 0
        ? null
        : s.answers === 1
          ? 'The 1 answer the objective update set to In progress has been updated since.'
          : `All ${s.answers} answers the objective update set to In progress have been updated since.`,
  };
}

export function catalogUpdateOverviewText(s: CatalogUpdateSummary, o: { rev: string | null; sprs: boolean }): string {
  const n = s.answers;
  return `${n} ${n === 1 ? 'answer was' : 'answers were'} set to In progress when the assessment objectives were updated to the ${catalogRevLabel(o.rev)}. This can lower the Met count${o.sprs ? ' and the SPRS score' : ''}. Narratives and evidence were kept.`;
}

/** The answers still to check when the list opened: a row stays listed after it is reviewed, so nothing jumps under the user. */
export const toCheckSnapshot = (rows: CatalogUpdateRow[]): Set<string> => new Set(rows.filter((r) => !r.reviewed && !r.orphan).map((r) => r.objectiveId));

/** The rows the list shows in a view (orphans are listed apart). 'check' is the snapshot; 'all' is every answer the guide still has. */
export function rowsForView(rows: CatalogUpdateRow[], view: 'check' | 'all', snapshot: Set<string>): CatalogUpdateRow[] {
  const listed = rows.filter((r) => !r.orphan);
  return view === 'all' ? listed : listed.filter((r) => snapshot.has(r.objectiveId));
}

/** Rows grouped by control, controls in number order and rows by objective id. */
export function groupByControl(rows: CatalogUpdateRow[]): { controlId: string; controlDisplayId: string; rows: CatalogUpdateRow[] }[] {
  const groups = new Map<string, { controlId: string; controlDisplayId: string; rows: CatalogUpdateRow[] }>();
  for (const r of rows) {
    const g = groups.get(r.controlId) ?? { controlId: r.controlId, controlDisplayId: r.controlDisplayId, rows: [] };
    g.rows.push(r);
    groups.set(r.controlId, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.rows.sort((a, b) => (a.objectiveId < b.objectiveId ? -1 : a.objectiveId > b.objectiveId ? 1 : 0));
  return list.sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));
}

/** Where a person's dismissal of the notice is kept (browser storage): ids and a revision only, never text. */
export const catalogUpdateDismissKey = (tenantId: string, programId: string | null, rev: string, userId: string): string =>
  `${catalogUpdateKeyPrefix(tenantId)}${programId ?? 'local'}_${rev}_${userId}`;

export const catalogUpdateKeyPrefix = (tenantId: string): string => `pbc_catalog_update_reviewed_${tenantId}_`;
