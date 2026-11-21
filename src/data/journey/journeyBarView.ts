// What the program journey bar shows (#251): one display row per step, with the loading and error overrides, the text read out by a screen reader and
// the tab a step is the current one for. The rules of the steps are in programJourney.ts; this file only words them. Pure: types and those rules only.

import { JOURNEY_UNAVAILABLE_TEXT, type JourneyState, type JourneyStep, type JourneyStepId } from './programJourney';

export type SummaryStatus = 'idle' | 'loading' | 'ready' | 'error';
export type DisplayState = JourneyState | 'loading' | 'error';

export interface JourneyStepDisplay {
  id: JourneyStepId;
  label: string;
  state: DisplayState;
  figure: string;
  sub: string | null;
  optional: boolean;
  current: boolean;
  aria: string;
  checksText: string;
  step: JourneyStep;
}

/** The tabs of one program: the bar shows on these and never on an account-wide screen. */
export const JOURNEY_TABS: ReadonlySet<string> = new Set(['dashboard', 'matrix', 'controls', 'evidence', 'vault', 'ssp', 'poam', 'export', 'rbac', 'tools', 'documents']);

/** The steps that read the server's summary: they cannot show a figure until it is loaded. */
export const SUMMARY_DEPENDENT: ReadonlySet<JourneyStepId> = new Set<JourneyStepId>(['people', 'tools', 'documents', 'ssp', 'export']);

export const STATE_WORD: Record<DisplayState, string> = {
  complete: 'Complete',
  in_progress: 'In progress',
  not_started: 'Not started',
  not_applicable: 'Not applicable',
  unavailable: 'Not available',
  loading: 'Loading',
  error: 'Not loaded',
};

export function showJourneyBar(tab: string): boolean {
  return JOURNEY_TABS.has(tab);
}

/** The step a tab belongs to (shown as the current one); null for a tab that is none of them. */
export function journeyCurrentStep(tab: string): JourneyStepId | null {
  switch (tab) {
    case 'rbac': return 'people';
    case 'tools': return 'tools';
    case 'documents': return 'documents';
    case 'matrix':
    case 'controls': return 'assess';
    case 'ssp': return 'ssp';
    case 'export': return 'export';
    default: return null;
  }
}

export function journeyProgressText(p: { complete: number; applicable: number }): string {
  return `${p.complete} of ${p.applicable} ${p.applicable === 1 ? 'step' : 'steps'} complete`;
}

/** The heading's count: while a figure is still loading or could not be loaded, it says so instead of a count that would read too low. */
export function journeyHeadlineText(display: Pick<JourneyStepDisplay, 'state'>[]): string {
  if (display.some((d) => d.state === 'loading')) return 'Loading…';
  if (display.some((d) => d.state === 'error')) return 'Some steps could not be loaded';
  const applicable = display.filter((d) => d.state !== 'not_applicable' && d.state !== 'unavailable');
  return journeyProgressText({ complete: applicable.filter((d) => d.state === 'complete').length, applicable: applicable.length });
}

function reasonOf(state: DisplayState, frameworkTitle: string): string | null {
  if (state === 'not_applicable') return `Not required for ${frameworkTitle}`;
  if (state === 'unavailable') return JOURNEY_UNAVAILABLE_TEXT;
  return null;
}

export function journeyStepAria(d: Omit<JourneyStepDisplay, 'aria'>, index: number, frameworkTitle = ''): string {
  const word = STATE_WORD[d.state];
  const reason = reasonOf(d.state, frameworkTitle);
  const parts = [`${index + 1}. ${d.label}: ${word}`];
  if (d.figure && d.figure !== word) parts[0] += `, ${d.figure}`;
  if (d.sub) parts[0] += `, ${d.sub}`;
  if (d.optional) parts[0] += ', optional';
  if (reason) parts[0] += `. ${reason}`;
  return parts[0];
}

function checksTextOf(step: JourneyStep): string {
  return step.checks
    .map((c) => `${c.label}: ${c.count ? `${c.count.done} of ${c.count.total}` : c.done ? 'done' : 'not done'}${c.severity === 'advisory' ? ' (advisory)' : ''}`)
    .join('. ');
}

/** "3 of 5 decided, 2 Met" is the Assess figure: split it into the figure and the Met count shown beside it. Any other text stays whole. */
function splitAssess(text: string): { figure: string; sub: string | null } {
  const m = /^(.*?),\s*(\d+ Met)$/.exec(text);
  return m ? { figure: m[1], sub: m[2] } : { figure: text, sub: null };
}

export function journeyDisplay(
  steps: JourneyStep[],
  o: { activeTab: string; serverBacked: boolean; summaryStatus: SummaryStatus; notesStatus: string; frameworkTitle: string }
): JourneyStepDisplay[] {
  const current = journeyCurrentStep(o.activeTab);
  const summaryPending = o.serverBacked && (o.summaryStatus === 'loading' || o.summaryStatus === 'idle');
  const summaryFailed = o.serverBacked && o.summaryStatus === 'error';
  return steps.map((step, i) => {
    let state: DisplayState = step.state;
    let figure = step.figureText;
    let sub: string | null = null;
    if (step.id === 'assess') {
      const s = splitAssess(step.figureText);
      figure = s.figure;
      sub = s.sub;
    }
    if (SUMMARY_DEPENDENT.has(step.id) && summaryPending) {
      state = 'loading';
      figure = 'Loading…';
      sub = null;
    } else if (SUMMARY_DEPENDENT.has(step.id) && summaryFailed) {
      state = 'error';
      figure = 'Not loaded';
      sub = null;
    } else if (step.id === 'assess' && o.notesStatus === 'loading') {
      state = 'loading';
      figure = 'Loading…';
      sub = null;
    } else if (step.state === 'not_applicable' || step.state === 'unavailable') {
      figure = STATE_WORD[step.state];
      sub = null;
    }
    const partial = { id: step.id, label: step.label, state, figure, sub, optional: step.optional, current: current === step.id, checksText: state === 'loading' || state === 'error' ? '' : checksTextOf(step), step };
    return { ...partial, aria: journeyStepAria(partial, i, o.frameworkTitle) };
  });
}
