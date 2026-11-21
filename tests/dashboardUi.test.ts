import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import {
  GOAL_RANGE_TEXT,
  goalGapText,
  heroBarLabel,
  overdueText,
  parseGoalInput,
  poamSourceText,
  scalePosition,
  sprsGoalErrorMessage,
  undatedText,
  utcToday,
} from '../src/data/dashboard/dashboardUiView';
import { domainChartRows, domainChartSummary } from '../src/data/dashboard/domainChart';
import { sprsGoalView } from '../src/data/dashboard/sprsGoal';
import { computeDomainStats } from '../src/data/frameworks/domainStats';
import { SprsGoalCard } from '../src/components/dashboard/SprsGoalCard';
import { PoamTargetCard } from '../src/components/dashboard/PoamTargetCard';
import { DomainStatusChart } from '../src/components/dashboard/DomainStatusChart';
import type { SprsScoreResult } from '../src/types/audit';
import type { PoamTargetSummary } from '../src/types/programSummary';

/**
 * #252: the goal and deadline cards and the status-per-domain chart. The field parsing and the texts, the three components rendered without a
 * browser, and the source rules (no storage, console or raw HTML; the screen keeps its existing pins).
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

console.log('\n--- DU1: parseGoalInput ---');
{
  const v = (s: string) => parseGoalInput(s);
  assert(JSON.stringify(v('')) === JSON.stringify({ ok: true, value: null }) && JSON.stringify(v('   ')) === JSON.stringify({ ok: true, value: null }), 'DU1 empty means no goal');
  assert(JSON.stringify(v('88')) === JSON.stringify({ ok: true, value: 88 }), 'DU1 88');
  assert(JSON.stringify(v('-203')) === JSON.stringify({ ok: true, value: -203 }), 'DU1 -203');
  assert(JSON.stringify(v('−50')) === JSON.stringify({ ok: true, value: -50 }), 'DU1 a typed minus sign');
  assert(JSON.stringify(v(' 12 ')) === JSON.stringify({ ok: true, value: 12 }), 'DU1 spaces around');
  assert(JSON.stringify(v('110')) === JSON.stringify({ ok: true, value: 110 }), 'DU1 110');
  for (const bad of ['111', '1.5', '1e2', 'abc', '-204', '1 2', '+5', '1000']) assert(v(bad).ok === false, `DU1 ${JSON.stringify(bad)} is refused`);
}

console.log('\n--- DU2: sprsGoalErrorMessage ---');
{
  const a = sprsGoalErrorMessage({ status: 400, reason: 'invalid_sprs_goal' });
  const b = sprsGoalErrorMessage({ status: 409, reason: 'program_archived' });
  const c = sprsGoalErrorMessage({ status: 403 });
  const d = sprsGoalErrorMessage(new Error('MARK'));
  assert(a === 'Enter a whole number from −203 to 110.' && a === GOAL_RANGE_TEXT, 'DU2 invalid goal', a);
  assert(b === 'This program is archived. Restore it to change the goal.', 'DU2 archived', b);
  assert(c === 'Only a Tenant Owner or Admin can change the goal.', 'DU2 403', c);
  assert(d === 'The goal was not saved. Try again.', 'DU2 anything else', d);
  assert(![a, b, c, d].some((x) => x.includes('MARK')), 'DU2 nothing is echoed');
  assert(sprsGoalErrorMessage(null) === d && sprsGoalErrorMessage('x') === d, 'DU2 a non-object error');
}

console.log('\n--- DU3 / DU4: counts and scale ---');
{
  assert(undatedText(1) === '1 entry has no date' && undatedText(3) === '3 entries have no date', 'DU3 undated text');
  assert(overdueText(2) === '2 overdue', 'DU3 overdue text');
  assert(poamSourceText('control') === "Latest date is on a control's POA&M entry" && poamSourceText('vulnerability') === 'Latest date is on a vulnerability POA&M item' && poamSourceText(null) === null, 'DU3 source text');
  assert(scalePosition(-203) === 0 && scalePosition(110) === 100 && scalePosition(0) === (203 / 313) * 100, 'DU4 scale ends and zero');
  assert(scalePosition(500) === 100 && scalePosition(-500) === 0, 'DU4 clamped');
  assert(utcToday(Date.UTC(2027, 5, 30, 23, 59, 59)) === '2027-06-30', 'DU4 the UTC day');
  assert(heroBarLabel({ met: 1, inProgress: 2, notMet: 3, notStarted: 4, total: 10 }) === '1 met, 2 in progress, 3 not met, 4 not started, of 10 controls', 'DU4 hero bar label');
  const scored = sprsGoalView({ score: 88, scoreStatus: 'SCORED' }, null);
  assert(goalGapText(scored.text) === '22 points to goal', 'DU4 the goal line without its lead', goalGapText(scored.text));
  assert(goalGapText(sprsGoalView({ score: null, scoreStatus: 'NOT_SCORED' }, 90).text) === 'Not scored: SSP required', 'DU4 not scored');
}

const sprs = (over: Partial<SprsScoreResult> = {}): SprsScoreResult => ({
  score: 88, scoreStatus: 'SCORED', sspGaps: [], maxScore: 110, totalControls: 110, metCount: 100, inProgressCount: 5, notMetCount: 3, notStartedCount: 2,
  totalDeductions: 22, deductionsByWeight: { fivePoint: [], threePoint: [], onePoint: [] }, completionPercentage: 90, ...over,
} as SprsScoreResult);

console.log('\n--- DU5: SprsGoalCard ---');
{
  const card = (p: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SprsGoalCard, { sprs: sprs(), goal: 100, canEditGoal: true, lockedReason: null, onSave: async () => {}, ...p }));
  const ro = card({ canEditGoal: false });
  assert(!ro.includes('Edit goal') && ro.includes('Set by a Tenant Owner or Admin.'), 'DU5 read-only: no Edit, the reason');
  assert(card({ canEditGoal: false, lockedReason: 'This program is archived. Restore it to change the goal.' }).includes('This program is archived.'), 'DU5 a given reason shows');
  const def = card({ goal: null });
  assert(def.includes('Default') && def.includes('No goal set'), 'DU5 the default is marked', def.slice(0, 80));
  assert(card({ sprs: sprs({ score: null, scoreStatus: 'NOT_SCORED' }) }).includes('Not scored'), 'DU5 not scored');
  const ed = card({});
  assert(ed.includes('Edit goal') && ed.includes('aria-expanded="false"') && ed.includes('12 points to goal'), 'DU5 an editor sees Edit goal and the gap', ed);
  assert(ed.includes('role="status"') && ed.includes('aria-labelledby'), 'DU5 a labelled section with a status region');
  assert(ed.includes('<dl') && ed.includes('<dt'), 'DU5 current and goal as a description list');
}

console.log('\n--- DU6: PoamTargetCard ---');
{
  const sum = (over: Partial<PoamTargetSummary> = {}): PoamTargetSummary => ({ openCount: 5, datedCount: 2, undatedCount: 3, latestDate: '2027-06-30', latestSource: 'control', overdueCount: 2, ...over });
  const card = (p: Record<string, unknown>) => renderToStaticMarkup(React.createElement(PoamTargetCard, { status: 'ready', summary: sum(), poamPermitted: true, frameworkTitle: 'SOC 2', onOpenPoam: () => {}, onRetry: () => {}, ...p }));
  assert(card({ status: 'loading', summary: null }).includes('role="status"'), 'DU6 loading');
  const err = card({ status: 'error', summary: null });
  assert(err.includes('role="alert"') && err.includes('Try again') && err.includes('POA&amp;M dates could not be loaded.'), 'DU6 error with Try again');
  const ok = card({});
  assert(ok.includes('3 entries have no date') && ok.includes('2 overdue'), 'DU6 undated and overdue counts', ok);
  assert(ok.includes('30 Jun 2027') && ok.includes('Open POA&amp;M'), 'DU6 the date and the open button');
  assert(ok.includes("Latest date is on a control&#x27;s POA&amp;M entry"), 'DU6 the source line');
  const none = card({ summary: sum({ latestDate: null, latestSource: null, datedCount: 0, undatedCount: 5, overdueCount: 0 }) });
  assert(!/\d{1,2} [A-Z][a-z]{2} \d{4}/.test(none) && none.includes('5 entries have no date'), 'DU6 no date is ever shown when none is set', none);
  assert(card({ summary: sum({ openCount: 0, datedCount: 0, undatedCount: 0, latestDate: null, latestSource: null, overdueCount: 0 }) }).includes('No open POA&amp;M entries'), 'DU6 empty');
  const denied = card({ poamPermitted: false });
  assert(denied.includes('POA&amp;M not permitted') && !denied.includes('Open POA&amp;M'), 'DU6 not permitted: the headline and no Open button');
  assert(card({ status: 'local' }).includes('this organization keeps its data in this browser only'), 'DU6 browser-only note');
}

console.log('\n--- DU7: DomainStatusChart ---');
{
  const controls = [
    { id: 'a1', domain: 'AC' }, { id: 'a2', domain: 'AC' }, { id: 'a3', domain: 'AC' }, { id: 'a4', domain: 'AC' },
    { id: 's1', domain: 'SC' },
  ];
  const states = { a1: { status: 'MET' as const }, a2: { status: 'IN_PROGRESS' as const }, a3: { status: 'NOT_MET' as const }, s1: { status: 'MET' as const } };
  const rows = domainChartRows(computeDomainStats(controls, states), { AC: { name: 'Access Control' }, PE: { name: 'Physical Protection' }, SC: { name: 'System Protection' } });
  const html = renderToStaticMarkup(React.createElement(DomainStatusChart, { rows, summary: domainChartSummary(rows), onOpenDomain: () => {} }));
  for (const needle of ['<figure', '<figcaption', '<table', '<caption', 'scope="col"', 'scope="row"', '<details', 'Show as table']) assert(html.includes(needle), `DU7 contains ${needle}`);
  const ac = rows.find((r) => r.code === 'AC')!;
  assert(html.includes(`aria-label="Access Control: ${ac.text}. Show these controls in the matrix"`), 'DU7 the AC button carries the row text', ac.text);
  const peAt = html.indexOf('Physical Protection');
  const pe = html.slice(html.lastIndexOf('<li', peAt), html.indexOf('</li>', peAt));
  assert(html.includes('No controls in this program') && !pe.includes('<button'), 'DU7 a domain without controls is no button', pe);
  assert(['Met', 'In progress', 'Not met', 'Not started'].every((l) => html.includes(l)), 'DU7 the status labels the app uses');
  assert(html.includes('repeating-linear-gradient'), 'DU7 patterns as well as colour');
  assert(html.includes('Inheritance breakdown') && html.includes('is not available yet'), 'DU7 the inheritance note');
  assert(html.includes('1/4 met') && html.includes('1/1 met'), 'DU7 the met counts');
}

console.log('\n--- DU8: source rules ---');
{
  const co = read('src', 'components', 'dashboard', 'ComplianceOverview.tsx');
  assert(co.includes('<SprsGoalCard') && co.includes('<PoamTargetCard') && co.includes('<DomainStatusChart'), 'DU8 the dashboard mounts the three');
  assert(co.indexOf('<DomainStatusChart') < co.indexOf('<DomainCards />'), 'DU8 the chart comes before the domain cards');
  assert(co.includes('role="img" aria-label={heroBarLabel('), 'DU8 the hero bar has a text alternative');
  assert(co.includes("const showSprs = activeFramework === 'CMMC_L2'") && co.includes('useStorageConfig(currentTenant)'), 'DU8 the existing pins are intact');
  assert(co.includes('{sprsResult && (') && co.includes('canEditGoal={serverBacked && canManagePrograms && !!activeProgram && !activeProgram.archived}'), 'DU8 the goal is for a CMMC Level 2 score and for write roles on an open program');
  const files: [string, string][] = [
    ['SprsGoalCard.tsx', read('src', 'components', 'dashboard', 'SprsGoalCard.tsx')],
    ['PoamTargetCard.tsx', read('src', 'components', 'dashboard', 'PoamTargetCard.tsx')],
    ['DomainStatusChart.tsx', read('src', 'components', 'dashboard', 'DomainStatusChart.tsx')],
    ['dashboardUiView.ts', read('src', 'data', 'dashboard', 'dashboardUiView.ts')],
  ];
  for (const [n, s] of files) assert(!/\b(localStorage|sessionStorage|console\.|dangerouslySetInnerHTML|alert\()/.test(s) && !/javascript:/.test(s), `DU8 ${n} has no storage, console, alert or raw HTML`);
  assert(!/from 'react'|\/services\/|\/context\//.test(files[3][1]), 'DU8 dashboardUiView.ts imports nothing from react, services or context');
  assert(!/<form/.test(files[0][1]) && files[0][1].includes("e.key === 'Escape'") && files[0][1].includes('e.preventDefault()'), 'DU8 the goal editor is no form and Escape only cancels it');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
