import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import {
  STATE_WORD,
  journeyCurrentStep,
  journeyDisplay,
  journeyHeadlineText,
  journeyProgressText,
  journeyStepAria,
  showJourneyBar,
} from '../src/data/journey/journeyBarView';
import { JOURNEY_LABELS, JOURNEY_STEP_ORDER, type JourneyState, type JourneyStep, type JourneyStepId } from '../src/data/journey/programJourney';
import { JourneyBarView } from '../src/components/journey/ProgramJourneyBar';
import { getFrameworkTitle } from '../src/data/frameworks';

/**
 * #251: what the journey bar shows. The display rows (loading and error overrides, the text a screen reader gets, the current step), the markup of the
 * bar rendered without a browser, and the source rules (no storage, no console, the bar mounted inside the main area and only for an open program).
 */

let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

function step(id: JourneyStepId, state: JourneyState, figureText: string, over: Partial<JourneyStep> = {}): JourneyStep {
  return { id, label: JOURNEY_LABELS[id], state, optional: false, done: 0, total: 0, figureText, checks: [], target: { tab: 'rbac' }, ...over };
}

const steps = (): JourneyStep[] => [
  step('people', 'complete', '5 of 5', { checks: [{ id: 'a', label: 'An owner', done: true, severity: 'required', count: { done: 1, total: 1 } }, { id: 'b', label: 'A contact', done: false, severity: 'advisory' }] }),
  step('tools', 'in_progress', '2 of 3', { optional: true }),
  step('documents', 'not_applicable', 'Not required for this framework'),
  step('assess', 'in_progress', '4 of 10 decided, 3 Met'),
  step('ssp', 'not_started', '0 of 12'),
  step('export', 'in_progress', '2 blocking gaps'),
];

const opts = { activeTab: 'dashboard', serverBacked: true, summaryStatus: 'ready' as const, notesStatus: 'loaded', frameworkTitle: getFrameworkTitle('CMMC_L2') };

console.log('\n--- JB1: loading ---');
{
  const d = journeyDisplay(steps(), { ...opts, summaryStatus: 'loading' });
  const by = (id: string) => d.find((x) => x.id === id)!;
  assert(['people', 'tools', 'documents', 'ssp', 'export'].every((id) => by(id).state === 'loading' && by(id).figure === 'Loading…'), 'JB1 the summary steps are loading with the figure Loading…');
  assert(by('assess').state === 'in_progress' && by('assess').figure === '4 of 10 decided', 'JB1 Assess is unchanged', by('assess'));
  assert(by('assess').sub === '3 Met', 'JB1 the Met count shows beside Assess', by('assess').sub);
  assert(by('people').checksText === '', 'JB1 a loading step reads no stale checks');
  const idle = journeyDisplay(steps(), { ...opts, summaryStatus: 'idle' });
  assert(idle.find((x) => x.id === 'export')!.state === 'loading', 'JB1 idle counts as loading');
  const n = journeyDisplay(steps(), { ...opts, notesStatus: 'loading' });
  assert(n.find((x) => x.id === 'assess')!.state === 'loading', 'JB1 Assess loads while the notes load');
  assert(journeyHeadlineText(d) === 'Loading…', 'JB1 the heading says Loading… while a figure loads');
}

console.log('\n--- JB2: error and browser-only ---');
{
  const d = journeyDisplay(steps(), { ...opts, summaryStatus: 'error' });
  assert(['people', 'tools', 'documents', 'ssp', 'export'].every((id) => { const x = d.find((y) => y.id === id)!; return x.state === 'error' && x.figure === 'Not loaded'; }), 'JB2 the summary steps read Not loaded');
  assert(journeyHeadlineText(d) === 'Some steps could not be loaded', 'JB2 the heading says so');
  const b = journeyDisplay(steps(), { ...opts, serverBacked: false, summaryStatus: 'error' });
  assert(b.find((x) => x.id === 'people')!.state === 'complete' && b.find((x) => x.id === 'export')!.state === 'in_progress', 'JB2 a browser-only organization ignores the summary status');
  const ready = journeyDisplay(steps(), opts);
  assert(journeyHeadlineText(ready) === '1 of 5 steps complete', 'JB2 the count leaves out a step that does not apply', journeyHeadlineText(ready));
  assert(journeyProgressText({ complete: 3, applicable: 5 }) === '3 of 5 steps complete', 'JB2 progress text');
  const na = ready.find((x) => x.id === 'documents')!;
  assert(na.state === 'not_applicable' && na.figure === 'Not applicable', 'JB2 a step that does not apply says so instead of a figure', na);
  const un = journeyDisplay([step('tools', 'unavailable', 'Needs a server-backed organization')], { ...opts, serverBacked: false })[0];
  assert(un.figure === 'Not available', 'JB2 an unavailable step says Not available', un.figure);
}

console.log('\n--- JB3: the text a screen reader gets ---');
{
  const d = journeyDisplay(steps(), opts);
  assert(d[0].aria === '1. People: Complete, 5 of 5', 'JB3 People', d[0].aria);
  assert(d[1].aria.endsWith(', optional'), 'JB3 an optional step ends with optional', d[1].aria);
  assert(d[3].aria === '4. Assess: In progress, 4 of 10 decided, 3 Met', 'JB3 Assess carries the Met count', d[3].aria);
  assert(d[2].aria === `3. Documents: Not applicable. Not required for ${getFrameworkTitle('CMMC_L2')}`, 'JB3 not applicable gives the reason once', d[2].aria);
  const un = journeyDisplay([step('tools', 'unavailable', 'x')], { ...opts, serverBacked: false })[0];
  assert(un.aria.includes('Needs a server-backed organization'), 'JB3 unavailable gives its reason', un.aria);
  assert(d[0].checksText === 'An owner: 1 of 1. A contact: not done (advisory)', 'JB3 the checks text', d[0].checksText);
  const soc = journeyDisplay([step('documents', 'not_applicable', 'x')], { ...opts, frameworkTitle: getFrameworkTitle('SOC_2_TYPE_II') })[0];
  assert(soc.aria.includes(`Not required for ${getFrameworkTitle('SOC_2_TYPE_II')}`), 'JB3 the framework title is in the reason', soc.aria);
  const { aria: _a, ...rest } = d[0];
  assert(journeyStepAria(rest, 0) === '1. People: Complete, 5 of 5', 'JB3 journeyStepAria on its own');
  assert(Object.keys(STATE_WORD).length === 7, 'JB3 seven state words');
}

console.log('\n--- JB4 / JB5: the current step and the tabs ---');
{
  assert(journeyCurrentStep('controls') === 'assess' && journeyCurrentStep('matrix') === 'assess', 'JB4 the matrix and its legacy name are Assess');
  assert(journeyCurrentStep('rbac') === 'people' && journeyCurrentStep('tools') === 'tools' && journeyCurrentStep('documents') === 'documents' && journeyCurrentStep('ssp') === 'ssp' && journeyCurrentStep('export') === 'export', 'JB4 the other steps');
  assert(journeyCurrentStep('dashboard') === null && journeyCurrentStep('poam') === null, 'JB4 a tab that is no step has none');
  const cur = journeyDisplay(steps(), { ...opts, activeTab: 'ssp' });
  assert(cur.filter((x) => x.current).map((x) => x.id).join() === 'ssp', 'JB4 exactly one current step');
  assert(showJourneyBar('sspimport') === false && showJourneyBar('tools') === true && showJourneyBar('audit_logs') === false, 'JB5 the tabs the bar shows on');
  assert(['dashboard', 'matrix', 'controls', 'evidence', 'vault', 'ssp', 'poam', 'export', 'rbac', 'tools', 'documents'].every(showJourneyBar), 'JB5 every program tab');
}

console.log('\n--- JB6: the bar rendered ---');
{
  const view = (over: Record<string, unknown> = {}, tab = 'matrix') =>
    renderToStaticMarkup(React.createElement(JourneyBarView, { display: journeyDisplay(steps(), { ...opts, activeTab: tab }), progressText: '1 of 5 steps complete', expanded: true, onToggle: () => {}, onSelect: () => {}, summaryError: false, onRetry: () => {}, ...over }));
  const html = view();
  assert(html.includes('aria-label="Program journey"') && html.includes('<ol'), 'JB6 a labelled navigation with an ordered list');
  assert((html.match(/<li/g) ?? []).length === 6, 'JB6 six steps');
  assert((html.match(/aria-current="step"/g) ?? []).length === 1, 'JB6 one current step');
  assert(html.includes('Optional'), 'JB6 the optional badge');
  assert(html.includes('Hide steps') && html.includes('aria-expanded="true"'), 'JB6 the toggle');
  const collapsed = view({ expanded: false });
  assert(/<ol[^>]*class="[^"]*\bhidden\b/.test(collapsed) && collapsed.includes('Show steps') && collapsed.includes('aria-expanded="false"'), 'JB6 collapsed hides the list and says Show steps');
  assert(!html.includes('Try again') && view({ summaryError: true }).includes('Try again'), 'JB6 Try again only with an error');
  assert((view({}, 'dashboard').match(/aria-current/g) ?? []).length === 0, 'JB6 no current step on the dashboard');
  assert(html.includes('aria-hidden="true"') && html.includes('aria-label="1. People: Complete, 5 of 5"'), 'JB6 icons hidden, each step labelled');
  assert(JOURNEY_STEP_ORDER.length === 6, 'JB6 six step ids');
}

console.log('\n--- JB7: source rules ---');
{
  const bar = read('src', 'components', 'journey', 'ProgramJourneyBar.tsx');
  const viewSrc = read('src', 'data', 'journey', 'journeyBarView.ts');
  const app = read('src', 'App.tsx');
  for (const [n, s] of [['ProgramJourneyBar.tsx', bar], ['journeyBarView.ts', viewSrc]] as const) {
    assert(!/\b(localStorage|sessionStorage|console\.|dangerouslySetInnerHTML|alert\()/.test(s), `JB7 ${n} has no storage, console, alert or raw HTML`);
  }
  assert(!/from 'react'|\/services\/|\/context\//.test(viewSrc), 'JB7 journeyBarView.ts imports nothing from react, services or context');
  assert(app.indexOf('<ProgramJourneyBar />') > app.indexOf('id="app-main"') && app.indexOf('<ProgramJourneyBar />') < app.indexOf('{programBlocked ? <NoProgramNotice />'), 'JB7 the bar is inside the main area, before the screen');
  assert(app.includes('{!programBlocked && <ProgramJourneyBar />}'), 'JB7 the bar is never shown while the program gate holds');
  assert(/if \(!showJourneyBar\(activeTab\)\) return null;[\s\S]*JourneyBarContainer/.test(bar), 'JB7 the journey is read only while the bar shows');
  assert(bar.includes("useState(true)") && bar.includes('aria-controls={listId}'), 'JB7 expanded by default, in React state only, the toggle controls the list');
  assert(!/javascript:/.test(bar + viewSrc), 'JB7 no javascript: URL');
}

console.log('\n--- JB8: the export modal keeps its pinned prefill ---');
{
  const m = read('src', 'components', 'reports', 'ArtifactExportModal.tsx');
  // exportFormDefaults is the journey's copy of this prefill; the modal keeps its own literal lines (pinned by onPremOnly S122-4, S151-23, S199-5)
  assert(m.includes("systemEnvironment: meta.systemEnvironment || '',") && m.includes("primaryAssessor: meta.authorName || '',"), 'JB8 the export modal still prefills its own fields');
  assert(m.includes("import { getExportGaps } from '../../data/reports/exportReadiness';"), 'JB8 the pinned getExportGaps import is intact');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
