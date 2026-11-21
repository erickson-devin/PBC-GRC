import type { ControlStatus } from '../../types/cmmc';
import type { Program } from '../../types/program';
import type {
  FrameworkCopyItem,
  FrameworkCopyRun,
  FrameworkCopySuggestions,
  FrameworkCopySummary,
  R3ChangeType,
  R3Relation,
  R3StatusSuggestion,
  R3SuggestedStatus,
} from '../../types/frameworkCopy';
import { statusDisplayLabel } from '../statusLabels';
import { cmmcDisplayId } from '../cmmcGuide/displayId';

/**
 * The words and decisions of the "Copy from Rev. 2" screens (#255), as pure functions so a test can pin them. Every sentence is fixed copy:
 * nothing here takes notes, narratives, file names or an error's own message, only ids, counts and statuses.
 */

export const R3_FRAMEWORK = 'NIST_800_171_R3';

export type CopyIncludeKey = 'notes' | 'objectives' | 'evidence' | 'tools' | 'documents';
export type CopyInclude = Record<CopyIncludeKey, boolean>;
export const INCLUDE_KEYS: readonly CopyIncludeKey[] = ['notes', 'objectives', 'evidence', 'tools', 'documents'];
export const DEFAULT_INCLUDE: CopyInclude = { notes: true, objectives: true, evidence: true, tools: true, documents: true };

export const INCLUDE_COPY: Record<CopyIncludeKey, { label: string; hint: string }> = {
  notes: { label: 'Implementation notes', hint: 'Appended under a dated "Copied from NIST SP 800-171 Rev. 2" header. Existing text is kept.' },
  objectives: { label: 'Objective narratives', hint: 'Each Rev. 2 objective narrative is appended to the control notes. Rev. 3 objectives are not filled in.' },
  evidence: { label: 'Evidence files', hint: 'A separate copy of each file (at most 200 files or 1 GiB per copy). Inherited and vulnerability-snapshot files are skipped.' },
  tools: { label: 'Tool links', hint: 'Links from the Tools and Services register to the control.' },
  documents: { label: 'Document links', hint: 'Links from the Document Register to the control.' },
};

export type CopyRelation = R3Relation;
export type CopyChangeType = R3ChangeType;
export type Rev2Suggested = R3SuggestedStatus;

export function isR3ControlId(id: string): boolean {
  return /^03\.\d{2}\.\d{2}$/.test(id ?? '');
}

export function relationLabel(r: CopyRelation): string {
  switch (r) {
    case 'SAME': return 'Same requirement';
    case 'INCORPORATED_INTO': return 'Merged into this requirement';
    default: return 'Addressed by this requirement';
  }
}

export function changeTypeLabel(c: CopyChangeType | undefined, newOdp?: boolean): string | null {
  const base = c === 'NO_SIGNIFICANT_CHANGE' ? 'No significant change' : c === 'MINOR_CHANGE' ? 'Minor change' : c === 'SIGNIFICANT_CHANGE' ? 'Significant change' : null;
  if (newOdp) return base ? `${base} · new parameter` : 'New parameter';
  return base;
}

export type CopyEntryState = 'hidden' | 'browser_only' | 'archived' | 'read_only' | 'not_loaded' | 'ready';

export function copyEntryState(a: { framework: string; serverBacked: boolean; hasProgram: boolean; archived: boolean; canEdit: boolean; notesEditable: boolean }): CopyEntryState {
  if (a.framework !== R3_FRAMEWORK) return 'hidden';
  if (a.serverBacked && !a.hasProgram) return 'hidden';
  if (!a.serverBacked) return 'browser_only';
  if (a.archived) return 'archived';
  if (!a.canEdit) return 'read_only';
  if (!a.notesEditable) return 'not_loaded';
  return 'ready';
}

export const COPY_ENTRY_TEXT = {
  intro: 'Moving from Rev. 2? Copy notes, objective narratives, evidence and tool and document links from a CMMC Level 2 or Level 1 program. Copied text is appended under a dated header for you to review; nothing is overwritten and no status is set.',
  browserOnly: 'Copy from Rev. 2 needs an organization stored on the server.',
  notLoaded: "Available once this program's controls are loaded from the server.",
  historyLoading: 'Loading the copy history…',
  historyFailed: 'The copy history could not be loaded.',
};

const SOURCE_FRAMEWORKS = ['CMMC_L2', 'CMMC_L1'];

export function eligibleSources(
  programs: readonly Pick<Program, 'id' | 'name' | 'framework' | 'archived'>[],
  targetId: string | null,
  enabled: readonly string[]
): { id: string; label: string }[] {
  return programs
    .filter((p) => p.id !== targetId && SOURCE_FRAMEWORKS.includes(p.framework) && enabled.includes(p.framework))
    .sort((a, b) =>
      SOURCE_FRAMEWORKS.indexOf(a.framework) - SOURCE_FRAMEWORKS.indexOf(b.framework)
      || Number(a.archived) - Number(b.archived)
      || a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, label: `${p.name} (${p.framework === 'CMMC_L2' ? 'CMMC Level 2' : 'CMMC Level 1'}${p.archived ? ', archived' : ''})` }));
}

export function includeValid(i: CopyInclude): boolean {
  return INCLUDE_KEYS.some((k) => i[k]);
}

export function itemHasSomethingToCopy(item: FrameworkCopyItem, include: CopyInclude): boolean {
  return (include.notes && item.notes.count > 0)
    || (include.objectives && item.objectives.count > 0)
    || (include.evidence && item.evidence.count > 0)
    || (include.tools && item.tools > 0)
    || (include.documents && item.documents > 0);
}

export function filterPreviewRows(
  items: readonly FrameworkCopyItem[],
  o: { onlyWithCopy: boolean; query: string; include: CopyInclude }
): FrameworkCopyItem[] {
  const q = o.query.trim().toLowerCase();
  return items
    .filter((it) => !o.onlyWithCopy || itemHasSomethingToCopy(it, o.include))
    .filter((it) =>
      !q
      || it.targetControlId.toLowerCase().includes(q)
      || it.sources.some((s) => s.controlId.toLowerCase().includes(q) || cmmcDisplayId(s.controlId, 'CMMC_L2').toLowerCase().includes(q)))
    .sort((a, b) => a.targetControlId.localeCompare(b.targetControlId, undefined, { numeric: true }));
}

export interface CopyTotals {
  controls: number;
  notes: number;
  objectives: number;
  evidence: number;
  evidenceBytes: number;
  evidenceUnavailable: number;
  tools: number;
  documents: number;
  alreadyCopied: number;
  changedSinceCopy: number;
}

export function copyTotals(items: readonly FrameworkCopyItem[], include: CopyInclude): CopyTotals {
  const t: CopyTotals = { controls: 0, notes: 0, objectives: 0, evidence: 0, evidenceBytes: 0, evidenceUnavailable: 0, tools: 0, documents: 0, alreadyCopied: 0, changedSinceCopy: 0 };
  for (const it of items) {
    if (itemHasSomethingToCopy(it, include)) t.controls += 1;
    if (include.notes) t.notes += it.notes.count;
    if (include.objectives) t.objectives += it.objectives.count;
    if (include.evidence) {
      t.evidence += it.evidence.count;
      t.evidenceBytes += it.evidence.bytes;
      t.evidenceUnavailable += it.evidence.unavailable;
    }
    if (include.tools) t.tools += it.tools;
    if (include.documents) t.documents += it.documents;
    t.alreadyCopied += it.alreadyCopied;
    t.changedSinceCopy += it.changedSinceCopy;
  }
  return t;
}

/** `total` is the number of Rev. 3 controls the preview lists (the ones with something pending). */
export function rowsShownText(shown: number, total: number): string {
  if (shown === 0) return 'No Rev. 3 control has anything to copy with these settings.';
  if (shown === total) return `Showing all ${total} Rev. 3 ${total === 1 ? 'control' : 'controls'} with Rev. 2 content.`;
  return `Showing ${shown} of ${total} Rev. 3 controls with Rev. 2 content.`;
}

export function formatCopyBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? String(r) : r.toFixed(1)} ${units[i]}`;
}

export function previewAnnouncement(t: CopyTotals, total: number): string {
  return `Preview ready: ${t.controls} of ${total} Rev. 3 controls have something to copy.`;
}

export function confirmLines(a: { totals: CopyTotals; include: CopyInclude; targetName: string; sourceName: string }): string[] {
  const { totals: t, include: inc } = a;
  const lines = [`Append to ${t.controls} Rev. 3 ${t.controls === 1 ? 'control' : 'controls'} of "${a.targetName}" from "${a.sourceName}".`];
  if (inc.notes && t.notes > 0) lines.push(`Notes: ${t.notes} ${t.notes === 1 ? 'block' : 'blocks'}`);
  if (inc.objectives && t.objectives > 0) lines.push(`Objective narratives: ${t.objectives}`);
  if (inc.evidence && t.evidence > 0) lines.push(`Evidence files: ${t.evidence} (${formatCopyBytes(t.evidenceBytes)})`);
  if (inc.tools && t.tools > 0) lines.push(`Tool links: ${t.tools}`);
  if (inc.documents && t.documents > 0) lines.push(`Document links: ${t.documents}`);
  lines.push('Existing text is never changed or removed: copied text is added after it under a dated header. Nothing is copied twice.');
  lines.push('Statuses are not changed. Suggested statuses from Rev. 2 appear on the controls afterwards, for you to decide.');
  lines.push('Each change is recorded in the control history under your name.');
  return lines;
}

export function confirmButtonLabel(n: number): string {
  return `Append to ${n} ${n === 1 ? 'control' : 'controls'}`;
}

export function summaryHeadline(s: FrameworkCopySummary): string {
  const nothing = s.notesAppended === 0 && s.objectivesAppended === 0 && s.evidenceCopied === 0 && s.toolLinksAdded === 0 && s.documentLinksAdded === 0;
  if (nothing) return 'Nothing new to copy: everything in this selection was copied before.';
  const n = s.controls.length;
  return `Copied into ${n} ${n === 1 ? 'control' : 'controls'}.`;
}

export function summaryRows(s: FrameworkCopySummary): { key: string; label: string; value: number; tone: 'normal' | 'warn'; note?: string }[] {
  const row = (key: string, label: string, value: number, note?: string) =>
    ({ key, label, value, tone: (note && value > 0 ? 'warn' : 'normal') as 'normal' | 'warn', ...(note && value > 0 ? { note } : {}) });
  return [
    row('notesAppended', 'Notes appended', s.notesAppended),
    row('objectivesAppended', 'Objective narratives appended', s.objectivesAppended),
    row('evidenceCopied', 'Evidence files copied', s.evidenceCopied),
    row('evidenceUnavailable', 'Evidence files not available', s.evidenceUnavailable, 'Missing in the Rev. 2 program, or the file no longer matches its recorded hash. Attach these by hand.'),
    row('toolLinksAdded', 'Tool links added', s.toolLinksAdded),
    row('toolLinksSkipped', 'Tool links skipped', s.toolLinksSkipped, "The tool is outside this program's declared boundary."),
    row('documentLinksAdded', 'Document links added', s.documentLinksAdded),
    row('documentLinksSkipped', 'Document links skipped', s.documentLinksSkipped ?? 0, 'The Document Register refused the link for this program. Link these by hand.'),
    row('alreadyCopied', 'Already copied before (skipped)', s.alreadyCopied),
  ];
}

export type CopyErrorKind = 'stale' | 'in_progress' | 'too_large' | 'archived' | 'not_enabled' | 'source_gone' | 'bad_source' | 'bad_target' | 'forbidden' | 'unreachable' | 'failed';
export type CopyErrorAction = 'preview_again' | 'clear_evidence' | 'refresh_programs' | 'retry' | null;

export function copyErrorView(err: unknown, phase: 'preview' | 'commit'): { kind: CopyErrorKind; message: string; action: CopyErrorAction } {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: unknown; reason?: unknown };
  const status = typeof e.status === 'number' ? e.status : -1;
  const reason = typeof e.reason === 'string' ? e.reason : '';
  const v = (kind: CopyErrorKind, message: string, action: CopyErrorAction) => ({ kind, message, action });
  switch (reason) {
    case 'copy_plan_stale': return v('stale', 'The Rev. 2 program or this program changed after the preview. Nothing was copied. Preview again.', 'preview_again');
    case 'copy_in_progress': return v('in_progress', 'A copy into this program is already running. Wait for it to finish, then preview again.', 'preview_again');
    case 'copy_too_large': return v('too_large', TOO_LARGE_TEXT, 'clear_evidence');
    case 'program_archived': return v('archived', 'This program is archived and read-only. Restore it on the Programs page to copy into it.', null);
    case 'framework_not_enabled': return v('not_enabled', "The chosen program's framework is no longer licensed for this organization. Ask a platform administrator.", null);
    case 'program_not_found': return v('source_gone', 'The chosen program no longer exists. The list of programs has been refreshed.', 'refresh_programs');
    case 'invalid_copy_source': return v('bad_source', 'Choose a CMMC Level 2 or Level 1 program other than this one.', null);
    case 'invalid_copy_target': return v('bad_target', 'This program is not a NIST SP 800-171 Rev. 3 program, so nothing can be copied into it.', null);
    default: break;
  }
  if (status === 413) return v('too_large', TOO_LARGE_TEXT, 'clear_evidence');
  if (status === 404) return v('source_gone', 'The chosen program no longer exists. The list of programs has been refreshed.', 'refresh_programs');
  if (status === 403) return v('forbidden', 'Only a Tenant Owner or Admin can copy from Rev. 2. Nothing was copied.', null);
  if (status === 0) {
    return phase === 'preview'
      ? v('unreachable', 'The server could not be reached, so the preview could not be made.', 'retry')
      : v('unreachable', 'The server could not be reached. The copy may not have run: preview again to see what is still to copy.', 'preview_again');
  }
  return phase === 'preview'
    ? v('failed', 'The preview could not be made. Try again.', 'retry')
    : v('failed', 'The copy did not finish. Preview again to see what is still to copy: nothing is ever copied twice.', 'preview_again');
}

/** The sentence for a preview or a commit that is over the evidence limits. */
export const TOO_LARGE_TEXT = 'This copy has more than 200 evidence files or more than 1 GiB of evidence. Nothing was copied. Clear Evidence files to copy the rest, then attach those files by hand.';

export function lastRunLine(run: FrameworkCopyRun | undefined, programName: (id: string) => string | null): string | null {
  if (!run) return null;
  const name = programName(run.sourceProgramId);
  const from = name ? `"${name}"` : 'a program that no longer exists';
  const controls = run.summary && Array.isArray(run.summary.controls) ? run.summary.controls.length : null;
  const tail = controls === null ? '' : `: ${controls} ${controls === 1 ? 'control' : 'controls'} changed`;
  return `Last copied from ${from} on ${String(run.createdAt).slice(0, 10)} by ${run.actor}${tail}.`;
}

export function suggestionIndex(data: FrameworkCopySuggestions | null, catalogIds: ReadonlySet<string>): Map<string, R3StatusSuggestion> {
  const out = new Map<string, R3StatusSuggestion>();
  if (!data || data.applies === false) return out;
  for (const s of data.suggestions) if (catalogIds.has(s.controlId)) out.set(s.controlId, s);
  return out;
}

export function chipSuggestion(index: ReadonlyMap<string, R3StatusSuggestion>, controlId: string, current: ControlStatus, statusLoaded: boolean): Rev2Suggested | null {
  const s = index.get(controlId);
  if (!s || !s.suggested || !statusLoaded) return null;
  return s.suggested === current ? null : s.suggested;
}

export function chipText(s: Rev2Suggested): string {
  return `Rev. 2 suggests ${statusDisplayLabel(s)}`;
}

export function suggestionHeading(s: Rev2Suggested): string {
  return `Suggested from Rev. 2: ${statusDisplayLabel(s)}`;
}

export function suggestionReasonText(s: R3StatusSuggestion): string {
  const code = s.reasonCode ?? (s.suggested === 'NOT_MET' ? 'any_not_met' : s.suggested === 'MET' ? 'all_met_unchanged' : 'partial');
  switch (code) {
    case 'any_not_met': {
      const ids = s.sources.filter((x) => x.status === 'NOT_MET').map((x) => cmmcDisplayId(x.controlId, 'CMMC_L2'));
      return `At least one Rev. 2 source is Not met (${ids.join(', ')}).`;
    }
    case 'all_met_unchanged': return 'Every Rev. 2 source is Met and NIST rates the change to this requirement as not significant.';
    case 'all_met_changed': return 'Every Rev. 2 source is Met, but this requirement changed in Rev. 3 or its change is not rated, so it needs a fresh review.';
    default: return 'Some Rev. 2 sources are Met or In progress and none is Not met.';
  }
}

export function suggestionSourceLine(programName: string | null): string {
  const where = programName ? `"${programName}"` : 'the Rev. 2 program';
  return `Statuses recorded in ${where} (Rev. 2). A suggestion only: the Rev. 3 requirement may ask for more. Nothing is set until you choose it.`;
}

export type SuggestionBlock = 'matches' | 'read_only' | 'archived' | 'not_loaded';

export function suggestionSetBlock(a: { suggested: Rev2Suggested; current: ControlStatus; canEdit: boolean; archived: boolean; statusLoaded: boolean }): SuggestionBlock | null {
  if (a.suggested === a.current) return 'matches';
  if (!a.canEdit) return 'read_only';
  if (a.archived) return 'archived';
  if (!a.statusLoaded) return 'not_loaded';
  return null;
}

export const SUGGESTION_BLOCK_TEXT: Record<Exclude<SuggestionBlock, 'matches'>, string> = {
  read_only: 'Only a Tenant Owner or Admin can record a status. The suggestion is shown for information.',
  archived: "This program is archived: its controls are read-only.",
  not_loaded: 'The controls are not loaded from the server yet, so a status cannot be recorded right now.',
};

export function suggestionConfirmText(id: string, current: ControlStatus, next: Rev2Suggested): string {
  return `Record ${id} as ${statusDisplayLabel(next)}? It is ${statusDisplayLabel(current)} now. This is your decision: it is saved under your name in the control history. The Rev. 2 status is only a suggestion.`;
}

export interface R2Source { cmmcId: string; relation: CopyRelation; changeType?: CopyChangeType; newOdp?: boolean }

export function rev2CounterpartsView(
  sources: readonly R2Source[],
  recorded: ReadonlyMap<string, ControlStatus> | null,
  programName: string | null
): {
  heading: string;
  intro: string;
  empty: string | null;
  items: { cmmcId: string; badge: string; detail: string | null; recordedLine: string | null; recordedStatus: ControlStatus | null }[];
} {
  return {
    heading: 'Rev. 2 counterparts',
    intro: 'NIST SP 800-171 Rev. 3 carries these Rev. 2 requirements (CMMC Level 2 practices) into this requirement. Read-only: nothing is copied from here.',
    empty: sources.length === 0 ? 'No Rev. 2 counterpart: this requirement is new in Rev. 3.' : null,
    items: sources.map((s) => {
      const status = recorded?.get(s.cmmcId) ?? null;
      return {
        cmmcId: s.cmmcId,
        badge: relationLabel(s.relation),
        detail: changeTypeLabel(s.changeType, s.newOdp),
        recordedLine: status ? `${statusDisplayLabel(status)} in ${programName ? `"${programName}"` : 'the Rev. 2 program'} (Rev. 2)` : 'Reference only: the Rev. 2 status shows here after a Copy from Rev. 2.',
        recordedStatus: status,
      };
    }),
  };
}
