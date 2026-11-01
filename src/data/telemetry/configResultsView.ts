/**
 * Configuration results (#103): the fixed copy and the pure rules of ConfigurationResultsView.tsx, kept here so they can be tested
 * without React. Exporter-provided strings (benchmark, profile, scanner and rule titles) never pass through these helpers: the view
 * renders them as text nodes. Asset ids come from the server; names come from the asset inventory. No storage, no console.
 */
import type { ControlStatus } from '../../types/cmmc';
import type { VmConfigResult, VmConfigScan, VmConfigSuggestion, VmConfigSuggestionValue } from '../../types/vm';

export const EXPORTER_XCCDF_COMMAND = 'pbc-vm-exporter --source xccdf --input <file>';

export const CONFIG_RESULTS_COPY = {
  intro: 'Configuration scan results (XCCDF and ARF) received by this server, and the control statuses they suggest. Scans cover the whole organization; suggestions follow the active program.',
  browserOnly: 'Configuration results need a server-backed organization. This organization is stored only in this browser, so no scan results can be received for it.',
  loading: 'Loading configuration results…',
  unavailable: 'Configuration results could not be loaded from the server. No control has been changed.',
  noData: 'No results loaded.',
  noResults: 'No configuration scan results have been received yet.',
  noResultsHint: 'Push XCCDF or ARF result files with the exporter:',
  noProfile: 'No profile',
  assetNamesUnavailable: 'The asset inventory could not be loaded, so asset names are not shown.',
  rulesLoading: 'Loading failing rules…',
  rulesUnavailable: 'The failing rules of this scan could not be loaded.',
  suggestionNotice: 'These are suggestions worked out from the latest scan results, not recorded statuses. Nothing here changes a control until a Tenant Owner or MSP Admin chooses Apply and confirms it; that decision is saved under their name in the control history.',
  notApplied: 'Suggestion, not applied',
  suggestionsLoading: 'Loading suggestions…',
  suggestionsUnavailable: 'Suggestions could not be loaded from the server. No control has been changed.',
  programLoading: 'Loading the active program…',
  programUnavailable: 'The programs could not be loaded, so no suggestions are shown.',
  readOnly: 'Read-only: only a Tenant Owner or MSP Admin can record a control status. The suggestions are shown for information.',
  notLoaded: 'The controls of this program are not loaded from the server yet, so a status cannot be recorded right now.',
} as const;

/** How a person's Apply ended (AssessmentContext.decideControlStatus). */
export type ControlDecisionOutcome = 'saved' | 'stale' | 'archived' | 'failed' | 'unreachable' | 'read_only' | 'not_loaded';
/** Why a row offers no Apply (null: it does). Checked in this order. */
export type ApplyBlock = 'review' | 'matches' | 'read_only' | 'archived' | 'not_loaded';

export const UNKNOWN_ASSET = 'Unknown asset';

export function statusLabel(s: ControlStatus): string {
  return s.replace(/_/g, ' ');
}

export function suggestionLabel(v: VmConfigSuggestionValue): string {
  if (v === 'MET') return 'Suggests MET';
  if (v === 'NOT_MET') return 'Suggests NOT MET';
  return 'Needs review';
}

export function suggestionStatus(v: VmConfigSuggestionValue): ControlStatus | null {
  return v === 'REVIEW' ? null : v;
}

export function applyBlock(a: {
  suggestion: VmConfigSuggestionValue;
  currentStatus: ControlStatus;
  canEdit: boolean;
  archived: boolean;
  controlsLoaded: boolean;
}): ApplyBlock | null {
  const next = suggestionStatus(a.suggestion);
  if (next === null) return 'review';
  if (next === a.currentStatus) return 'matches';
  if (!a.canEdit) return 'read_only';
  if (a.archived) return 'archived';
  if (!a.controlsLoaded) return 'not_loaded';
  return null;
}

export function archivedMessage(name: string): string {
  return `${name} is archived: its controls are read-only, so no suggestion can be applied.`;
}

export function applyConfirmText(id: string, current: ControlStatus, next: ControlStatus): string {
  return `Record ${id} as ${statusLabel(next)}? It is ${statusLabel(current)} now. This is your decision: it is saved under your name in the control history. The scan result is only a suggestion.`;
}

export function applyResultMessage(outcome: ControlDecisionOutcome, id: string, status: ControlStatus): string {
  switch (outcome) {
    case 'saved': return `${id} recorded as ${statusLabel(status)}.`;
    case 'stale': return `Someone else changed ${id} after this page loaded it, so nothing was saved. Reload to see the current status, then decide again.`;
    case 'archived': return `${id} was not saved: this program is archived and its controls are read-only.`;
    case 'unreachable': return `The server could not be reached, so ${id} was not saved.`;
    case 'failed': return `${id} was not saved. Try again, or set the status in the control matrix.`;
    case 'read_only': return `${id} was not saved: only a Tenant Owner or MSP Admin can record a control status.`;
    default: return `${id} was not saved: the controls are not loaded from the server yet.`;
  }
}

export function countSummary(a: VmConfigSuggestion['assets']): string {
  const base = `${a.failing} failing, ${a.passing} passing, ${a.error} with errors; ${a.evaluated} of ${a.inScope} in-scope ${a.inScope === 1 ? 'asset' : 'assets'} evaluated`;
  const n = a.unconfirmed;
  return n > 0 ? `${base}; ${n} unclassified ${n === 1 ? 'asset' : 'assets'} included` : base;
}

export function ruleSummary(r: VmConfigSuggestion['rules']): string {
  return `${r.failing} of ${r.mapped} mapped ${r.mapped === 1 ? 'rule' : 'rules'} failing`;
}

export function groupResultCounts(counts: Partial<Record<VmConfigResult, number>>): { pass: number; fail: number; error: number; other: number } {
  const n = (k: VmConfigResult): number => counts[k] ?? 0;
  return {
    pass: n('pass') + n('fixed'),
    fail: n('fail'),
    error: n('error') + n('unknown'),
    other: n('notapplicable') + n('notchecked') + n('notselected') + n('informational'),
  };
}

export function assetLabel(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? UNKNOWN_ASSET;
}

export function failingAssetNames(ids: readonly string[], names: ReadonlyMap<string, string>, max = 5): { shown: string[]; more: number } {
  return { shown: ids.slice(0, max).map((id) => assetLabel(id, names)), more: Math.max(0, ids.length - max) };
}

const SUGGESTION_ORDER: Record<VmConfigSuggestionValue, number> = { NOT_MET: 0, REVIEW: 1, MET: 2 };

export function sortSuggestions(list: readonly VmConfigSuggestion[]): VmConfigSuggestion[] {
  return [...list].sort((a, b) => SUGGESTION_ORDER[a.suggestion] - SUGGESTION_ORDER[b.suggestion] || a.controlId.localeCompare(b.controlId, 'en', { numeric: true }));
}

export function splitByProgramControls(list: readonly VmConfigSuggestion[], ids: ReadonlySet<string>): { shown: VmConfigSuggestion[]; outside: number } {
  const shown = list.filter((s) => ids.has(s.controlId));
  return { shown, outside: list.length - shown.length };
}

export function outsideNote(n: number): string {
  if (n <= 0) return '';
  return `${n} ${n === 1 ? 'suggestion is' : 'suggestions are'} for controls outside this program's baseline and ${n === 1 ? 'is' : 'are'} not shown.`;
}

export function sortScanRows(scans: readonly VmConfigScan[], names: ReadonlyMap<string, string>): VmConfigScan[] {
  return [...scans].sort((a, b) =>
    assetLabel(a.assetId, names).localeCompare(assetLabel(b.assetId, names), 'en', { numeric: true })
    || (a.benchmarkTitle || a.benchmarkId).localeCompare(b.benchmarkTitle || b.benchmarkId, 'en', { numeric: true })
    || b.scannedAt.localeCompare(a.scannedAt));
}

export function boundaryCaption(b: { declared: boolean; inScope: number; evaluated: number }, name: string): string {
  const noun = b.inScope === 1 ? 'asset has' : 'assets have';
  return b.declared
    ? `${name} boundary: ${b.evaluated} of ${b.inScope} in-scope ${noun} configuration results.`
    : `${name} has not declared its assets, so suggestions use the whole inventory: ${b.evaluated} of ${b.inScope} in-scope ${noun} configuration results.`;
}

export function unsupportedMessage(fw: string): string {
  return `Configuration rules are not mapped to ${fw} controls, so this program gets no suggestions. Suggestions are available for CMMC Level 1, CMMC Level 2 and NIST SP 800-53 programs. The scan results above are still shown.`;
}

export function noSuggestionsMessage(): string {
  return 'None of the latest results map to a control of this program, so there are no suggestions.';
}

export function unmappedNote(n: number): string {
  if (n <= 0) return '';
  return `${n} ${n === 1 ? 'rule' : 'rules'} in the latest scans ${n === 1 ? 'is' : 'are'} not mapped to a control yet and ${n === 1 ? 'does' : 'do'} not count toward any suggestion.`;
}

export function shownCaption(shown: number, total: number, noun: string): string {
  return total <= shown ? '' : `Showing ${shown} of ${total} ${noun}.`;
}
