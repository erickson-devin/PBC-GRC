import fs from 'fs';
import path from 'path';
import { poamTargetSummary, poamTargetText, formatPoamDate } from '../src/data/dashboard/poamTarget';
import { SPRS_DEFAULT_GOAL, sprsGoalView, validateSprsGoal } from '../src/data/dashboard/sprsGoal';
import { domainChartRows, domainChartSummary } from '../src/data/dashboard/domainChart';
import { computeDomainStats } from '../src/data/frameworks/domainStats';

/**
 * #252: the pure parts of the compliance dashboard. The POA&M target date (the latest date among the open entries, with the undated ones counted),
 * the SPRS goal and the per-domain chart rows with their text alternative.
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

console.log('\n--- D1: the POA&M target summary ---');
{
  const s = poamTargetSummary(
    [
      { status: 'NOT_MET', scheduledCompletion: '2027-01-31' },
      { status: 'MET', scheduledCompletion: '2028-01-01' },
      { status: 'NOT_STARTED', scheduledCompletion: null },
    ],
    { open: 2, dated: 1, latest: '2027-05-01', overdue: 0 },
    '2027-02-01'
  );
  assert(JSON.stringify(s) === JSON.stringify({ openCount: 4, datedCount: 2, undatedCount: 2, latestDate: '2027-05-01', latestSource: 'vulnerability', overdueCount: 1 }), 'D1 open controls and items, the Met control left out, the latest date from the vulnerability item', s);
  const tie = poamTargetSummary([{ status: 'NOT_MET', scheduledCompletion: '2027-05-01' }], { open: 1, dated: 1, latest: '2027-05-01', overdue: 0 }, '2027-01-01');
  assert(tie.latestSource === 'control', 'D1 a tie goes to the control');
  const ctl = poamTargetSummary([{ status: 'IN_PROGRESS', scheduledCompletion: '2027-09-01' }], { open: 0, dated: 0, latest: null, overdue: 0 }, '2027-01-01');
  assert(ctl.latestDate === '2027-09-01' && ctl.latestSource === 'control' && ctl.undatedCount === 0, 'D1 a control date alone');
}

console.log('\n--- D2: nothing open ---');
{
  const s = poamTargetSummary([{ status: 'MET', scheduledCompletion: '2030-01-01' }], { open: 0, dated: 0, latest: null, overdue: 0 }, '2027-01-01');
  assert(s.openCount === 0 && s.latestDate === null && s.latestSource === null && s.overdueCount === 0, 'D2 a Met control with a date does not count', s);
  const t = poamTargetText(s);
  assert(t.headline === 'No open POA&M entries' && t.detail === '', 'D2 headline for no open entries', t);
}

console.log('\n--- D3: the undated entries are never hidden ---');
{
  const s = poamTargetSummary(
    [{ status: 'NOT_MET', scheduledCompletion: '2027-01-31' }, { status: 'NOT_STARTED', scheduledCompletion: null }, { status: 'NOT_STARTED', scheduledCompletion: null }],
    { open: 0, dated: 0, latest: null, overdue: 0 },
    '2027-01-01'
  );
  const t = poamTargetText(s);
  assert(t.headline === 'Target completion: 31 Jan 2027 (latest due date of open entries)', 'D3 the headline names the date and what it is', t.headline);
  assert(t.detail === '1 of 3 open entries are dated; 2 have no date', 'D3 the detail counts the undated', t.detail);
  const none = poamTargetText(poamTargetSummary([{ status: 'NOT_STARTED', scheduledCompletion: null }, { status: 'NOT_MET', scheduledCompletion: null }], { open: 0, dated: 0, latest: null, overdue: 0 }, '2027-01-01'));
  assert(none.headline.includes('No open entry has a date') && none.headline.includes('2 open entries') && !/\d{4}/.test(none.headline), 'D3 every entry undated: no date is shown', none.headline);
  const one = poamTargetText(poamTargetSummary([{ status: 'NOT_STARTED', scheduledCompletion: null }], { open: 0, dated: 0, latest: null, overdue: 0 }, '2027-01-01'));
  assert(one.headline.includes('1 open entry)') && one.detail.includes('1 has no date'), 'D3 singular wording', one);
  assert(formatPoamDate('2027-06-30') === '30 Jun 2027' && formatPoamDate('2027-13-01') === '2027-13-01' && formatPoamDate('soon') === 'soon', 'D3 date formatting');
}

console.log('\n--- D4: validateSprsGoal ---');
{
  const ok = (v: unknown) => validateSprsGoal(v).ok === true;
  assert(ok(110) && ok(-203) && ok(0) && ok(88), 'D4 whole numbers in the SPRS range are accepted');
  const n = validateSprsGoal(null);
  assert(n.ok === true && n.value === null, 'D4 null is accepted and clears the goal');
  assert(!ok(111) && !ok(-204) && !ok(1.5) && !ok('90') && !ok(NaN) && !ok(undefined) && !ok(Infinity) && !ok({}), 'D4 out of range, fractional, text, NaN and undefined are refused');
  const v = validateSprsGoal(88);
  assert(v.ok === true && v.value === 88, 'D4 the value comes back');
}

console.log('\n--- D5: the goal view ---');
{
  assert(SPRS_DEFAULT_GOAL === 110, 'D5 the default goal is 110');
  const d = sprsGoalView({ score: 88, scoreStatus: 'SCORED' }, null);
  assert(d.goal === 110 && d.isDefault === true && d.gap === 22 && d.text.includes('(default)') && d.text.includes('22 points to goal'), 'D5 no stored goal shows 110 as the default', d);
  const a = sprsGoalView({ score: 88, scoreStatus: 'SCORED' }, 70);
  assert(a.goal === 70 && a.isDefault === false && a.gap === -18 && a.text.includes('above') && !a.text.includes('(default)'), 'D5 above the goal', a);
  const n = sprsGoalView({ score: null, scoreStatus: 'NOT_SCORED' }, null);
  assert(n.gap === null && n.text.includes('Not scored'), 'D5 not scored gives no gap', n);
  assert(sprsGoalView({ score: 70, scoreStatus: 'SCORED' }, 70).text.includes('goal reached'), 'D5 goal reached');
  assert(sprsGoalView({ score: 109, scoreStatus: 'SCORED' }, null).text.includes('1 point to goal'), 'D5 singular point');
}

console.log('\n--- D6: the domain chart rows ---');
{
  const stats = computeDomainStats(
    [{ id: 'a', domain: 'AC' }, { id: 'b', domain: 'AC' }, { id: 'c', domain: 'AC' }, { id: 'd', domain: 'IA' }],
    { a: { status: 'MET' }, b: { status: 'IN_PROGRESS' } },
    ['AC', 'IA', 'PE']
  );
  const rows = domainChartRows(stats, { AC: { name: 'Access Control' }, IA: { name: 'Identification' }, PE: { name: 'Physical' } });
  assert(rows.map((r) => r.code).join(',') === 'AC,IA,PE', 'D6 rows follow the registry order');
  const ac = rows[0];
  assert(ac.segments.map((s) => s.count).join(',') === '1,1,0,1' && ac.segments.reduce((n, s) => n + s.pct, 0) === 100, 'D6 AC counts and percentages sum to 100', ac.segments);
  assert(ac.segments.map((s) => s.status).join(',') === 'MET,IN_PROGRESS,NOT_MET,NOT_STARTED', 'D6 statuses in a fixed order');
  assert(ac.text === 'AC: 1 met, 1 in progress, 0 not met, 1 not started, of 3', 'D6 AC text alternative', ac.text);
  assert(rows[2].text === 'PE: no controls' && rows[2].segments.length === 0 && rows[2].total === 0, 'D6 a domain with no controls', rows[2]);
  assert(rows[0].name === 'Access Control', 'D6 the registry name');
  const odd = domainChartRows({ X: { total: 7, met: 1, inProgress: 1, notMet: 1, notStarted: 4, percentage: 14 } }, {});
  assert(odd.length === 1 && odd[0].name === 'X' && odd[0].segments.reduce((n, s) => n + s.pct, 0) === 100, 'D6 a domain missing from the registry follows, with its code as name; 7 splits to 100', odd[0]?.segments);
  const s = domainChartSummary(rows);
  assert(s === 'Control status across 2 domains: 1 of 4 controls Met; 0 domains are fully Met.', 'D6 summary sentence', s);
  assert(domainChartSummary([]) === 'No controls in any domain.', 'D6 summary without controls');
}

console.log('\n--- D7: the modules are pure ---');
{
  for (const f of ['poamTarget', 'sprsGoal', 'domainChart']) {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'dashboard', `${f}.ts`), 'utf8');
    assert(!/\b(localStorage|sessionStorage|console\.|fetch\(|Date\.now|new Date|from 'react')/.test(src), `D7 ${f} has no storage, console, network, clock or React`);
  }
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
