// The program journey (#251): six steps (People, Tools, Documents, Assess, SSP, Export), each defined once on top of the rules that already exist.
// This file adds no rule of its own: SSP items come from the completeness registry (sspCompleteness.ts, with the register and document inputs), the
// tool items from inventoryCompletenessItems, the document figure from the expected-documents checklist counts the summary carries, and the export
// gaps from getExportGaps. A step that does not apply to the framework, or needs a server-backed organization, says so instead of showing a figure.
// Pure: types and the rules above only; it touches no clock, storage or console output.

import type { ExportGap } from '../reports/exportReadiness';
import type { SspCompleteness } from '../ssp/sspCompleteness';
import { SSP_SIGNABLE_SECTION_IDS, type SspSectionId } from '../ssp/sspSections';
import { inventoryCompletenessItems } from '../inventory/sspInventory';
import type { ProgramSummary } from '../../types/programSummary';

export type JourneyStepId = 'people' | 'tools' | 'documents' | 'assess' | 'ssp' | 'export';
export type JourneyState = 'complete' | 'in_progress' | 'not_started' | 'not_applicable' | 'unavailable';

export interface JourneyCheck {
  id: string;
  label: string;
  done: boolean;
  severity: 'required' | 'advisory';
  count?: { done: number; total: number };
}

export interface JourneyTarget {
  tab: 'rbac' | 'tools' | 'documents' | 'matrix' | 'ssp' | 'export';
  sspSection?: SspSectionId;
}

export interface JourneyStep {
  id: JourneyStepId;
  label: string;
  state: JourneyState;
  /** Every item of the step is advisory (SOC 2 and HIPAA tools): the step never blocks. */
  optional: boolean;
  done: number;
  total: number;
  /** The figure as text, e.g. "3 of 5"; for a step that does not apply or is unavailable, the reason instead. */
  figureText: string;
  checks: JourneyCheck[];
  target: JourneyTarget;
  /** Set for not_applicable and unavailable. */
  reason?: string;
}

export interface JourneyInput {
  framework: string;
  /** False for a browser-only organization: Tools and Documents are unavailable, and there is no sign-off or primary contact check. */
  serverBacked: boolean;
  /** Members at owner level whose access has not ended. */
  members: { ownerLevel: number };
  summary: ProgramSummary | null;
  /** Computed by the caller with the inventory and documents inputs of `summary`. */
  ssp: SspCompleteness;
  assess: { total: number; met: number; inProgress: number; notMet: number; objectives: { answered: number; total: number } | null };
  /** getExportGaps(...) of the framework's default document type. */
  exportGaps: ExportGap[];
  /** getSspGaps(...) for CMMC Level 2, else null. Only the entries about the SSP requirement count (the identity fields are already export gaps). */
  sprsGate: string[] | null;
}

export const JOURNEY_STEP_ORDER: readonly JourneyStepId[] = ['people', 'tools', 'documents', 'assess', 'ssp', 'export'];

export const JOURNEY_LABELS: Record<JourneyStepId, string> = {
  people: 'People',
  tools: 'Tools',
  documents: 'Documents',
  assess: 'Assess',
  ssp: 'SSP',
  export: 'Export',
};

export const JOURNEY_UNAVAILABLE_TEXT = 'Needs a server-backed organization';
export const JOURNEY_NOT_APPLICABLE_TEXT = 'Not required for this framework';

const TARGETS: Record<JourneyStepId, JourneyTarget> = {
  people: { tab: 'rbac' },
  tools: { tab: 'tools' },
  documents: { tab: 'documents' },
  assess: { tab: 'matrix' },
  ssp: { tab: 'ssp' },
  export: { tab: 'export' },
};

const ofText = (done: number, total: number): string => `${done} of ${total}`;

function base(id: JourneyStepId): Pick<JourneyStep, 'id' | 'label' | 'target' | 'checks' | 'optional' | 'done' | 'total'> {
  return { id, label: JOURNEY_LABELS[id], target: TARGETS[id], checks: [], optional: false, done: 0, total: 0 };
}

function unavailable(id: JourneyStepId): JourneyStep {
  return { ...base(id), state: 'unavailable', figureText: JOURNEY_UNAVAILABLE_TEXT, reason: JOURNEY_UNAVAILABLE_TEXT };
}

function notApplicable(id: JourneyStepId): JourneyStep {
  return { ...base(id), state: 'not_applicable', figureText: JOURNEY_NOT_APPLICABLE_TEXT, reason: JOURNEY_NOT_APPLICABLE_TEXT };
}

/** The identity fields of getSspGaps ("... is empty in the SSP") are export gaps already; what is left is the SSP requirement itself. */
export function sspControlGate(gaps: readonly string[] | null | undefined): string[] {
  return (gaps ?? []).filter((g) => !/ is empty in the SSP$/.test(g));
}

function peopleStep(i: JourneyInput): JourneyStep {
  const roles = i.ssp.sections.find((s) => s.sectionId === 'roles');
  const checks: JourneyCheck[] = [{ id: 'owner_member', label: 'At least one owner-level member with current access', done: i.members.ownerLevel >= 1, severity: 'required' }];
  if (i.serverBacked && i.summary && i.summary.people.primaryContactSet !== null) {
    checks.push({ id: 'primary_contact', label: 'A primary contact is set', done: i.summary.people.primaryContactSet === true, severity: 'required' });
  }
  if (roles && roles.available && roles.requiredTotal > 0) {
    const done = roles.requiredTotal - roles.requiredMissing;
    checks.push({ id: 'ssp_roles', label: 'The SSP roles that are required are filled in', done: roles.requiredMissing === 0, severity: 'required', count: { done, total: roles.requiredTotal } });
  }
  const met = checks.filter((c) => c.done).length;
  const state: JourneyState = met === checks.length ? 'complete' : met === 0 ? 'not_started' : 'in_progress';
  return { ...base('people'), state, done: met, total: checks.length, figureText: ofText(met, checks.length), checks };
}

function toolsStep(i: JourneyInput): JourneyStep {
  if (!i.serverBacked || !i.summary || !i.summary.inventory.supported) return unavailable('tools');
  const inv = i.summary.inventory;
  const items = inventoryCompletenessItems(i.framework, inv);
  const optional = items.every((it) => it.severity === 'advisory');
  const inScope = inv.tools.filter((t) => t.assetCategory !== 'OUT_OF_SCOPE');
  const total = inScope.length;
  const done = inScope.filter((t) => t.endUsers !== null && t.privilegedUsers !== null).length;
  const requiredMissing = items.filter((it) => it.severity === 'required' && it.missing).length;
  const state: JourneyState = total === 0 ? 'not_started' : requiredMissing === 0 ? 'complete' : 'in_progress';
  const checks: JourneyCheck[] = [
    { id: 'boundary_tools', label: 'At least one tool or service in the system boundary', done: total > 0, severity: optional ? 'advisory' : 'required' },
    { id: 'user_counts', label: 'End user and privileged user counts recorded', done: total > 0 && done === total, severity: 'advisory', count: { done, total } },
  ];
  return { ...base('tools'), state, optional, done, total, figureText: total === 0 ? 'No tools yet' : ofText(done, total), checks };
}

function documentsStep(i: JourneyInput): JourneyStep {
  if (!i.serverBacked || !i.summary) return unavailable('documents');
  const docs = i.summary.documents;
  if (!docs || !docs.supported || !docs.expected || docs.expected.total === 0) return notApplicable('documents');
  const { present, total } = docs.expected;
  const state: JourneyState = present >= total ? 'complete' : present === 0 && docs.approvedCount === 0 ? 'not_started' : 'in_progress';
  const checks: JourneyCheck[] = [
    { id: 'expected', label: 'Expected documents present', done: present >= total, severity: 'required', count: { done: present, total } },
  ];
  if (docs.recommendedTotal > 0) {
    checks.push({ id: 'recommended', label: 'Recommended documents present', done: docs.recommendedPresent >= docs.recommendedTotal, severity: 'advisory', count: { done: docs.recommendedPresent, total: docs.recommendedTotal } });
  }
  return { ...base('documents'), state, done: present, total, figureText: ofText(present, total), checks };
}

function assessStep(i: JourneyInput): JourneyStep {
  const a = i.assess;
  const decided = a.met + a.notMet;
  const state: JourneyState = a.total > 0 && decided === a.total ? 'complete' : decided === 0 && a.inProgress === 0 ? 'not_started' : 'in_progress';
  const checks: JourneyCheck[] = [{ id: 'decided', label: 'Every control is decided (Met or Not met)', done: a.total > 0 && decided === a.total, severity: 'required', count: { done: decided, total: a.total } }];
  if (a.objectives) {
    checks.push({ id: 'objectives', label: 'Objectives answered', done: a.objectives.total > 0 && a.objectives.answered === a.objectives.total, severity: 'advisory', count: { done: a.objectives.answered, total: a.objectives.total } });
  }
  return { ...base('assess'), state, done: decided, total: a.total, figureText: `${ofText(decided, a.total)} decided, ${a.met} Met`, checks };
}

function sspStep(i: JourneyInput): JourneyStep {
  const total = i.ssp.sections.reduce((n, s) => n + s.requiredTotal, 0);
  const done = total - i.ssp.requiredMissing;
  const state: JourneyState = i.ssp.requiredMissing === 0 ? 'complete' : done === 0 ? 'not_started' : 'in_progress';
  const checks: JourneyCheck[] = i.ssp.sections
    .filter((s) => s.available && s.requiredTotal > 0)
    .map((s) => ({ id: `section:${s.sectionId}`, label: `${s.number} ${s.title}`, done: s.requiredMissing === 0, severity: 'required' as const, count: { done: s.requiredTotal - s.requiredMissing, total: s.requiredTotal } }));
  // Advisory (decision B2): a sign-off is for write roles only and per section
  if (i.serverBacked && i.summary) {
    const r = i.summary.reviews;
    checks.push({ id: 'reviews', label: 'Signable sections reviewed', done: r.total > 0 && r.reviewed >= r.total, severity: 'advisory', count: { done: r.reviewed, total: r.total || SSP_SIGNABLE_SECTION_IDS.length } });
  }
  const first = firstIncompleteSspSection(i.ssp);
  return { ...base('ssp'), state, done, total, figureText: ofText(done, total), checks, target: first ? { tab: 'ssp', sspSection: first } : { tab: 'ssp' } };
}

function exportStep(i: JourneyInput): JourneyStep {
  const blocking = i.exportGaps.filter((g) => !g.advisory).length + sspControlGate(i.sprsGate).length;
  const checks: JourneyCheck[] = [{ id: 'blocking_gaps', label: 'No blocking gap in the export', done: blocking === 0, severity: 'required', count: { done: blocking === 0 ? 1 : 0, total: 1 } }];
  return {
    ...base('export'),
    state: blocking === 0 ? 'complete' : 'in_progress',
    done: blocking,
    total: blocking,
    figureText: blocking === 0 ? 'Ready' : blocking === 1 ? '1 blocking gap' : `${blocking} blocking gaps`,
    checks,
  };
}

/** Always the six steps, in order. For Export, `done` and `total` both hold the number of blocking gaps (0 = ready). */
export function computeJourney(input: JourneyInput): JourneyStep[] {
  return [peopleStep(input), toolsStep(input), documentsStep(input), assessStep(input), sspStep(input), exportStep(input)];
}

/** Steps complete out of the steps that apply (not_applicable and unavailable ones are left out of both). */
export function journeyProgress(steps: JourneyStep[]): { complete: number; applicable: number } {
  const applicable = steps.filter((s) => s.state !== 'not_applicable' && s.state !== 'unavailable');
  return { complete: applicable.filter((s) => s.state === 'complete').length, applicable: applicable.length };
}

/** The first section (display order) that is available and still lacks a required item; null when none does. */
export function firstIncompleteSspSection(ssp: SspCompleteness): SspSectionId | null {
  return ssp.sections.find((s) => s.available && s.requiredMissing > 0)?.sectionId ?? null;
}
