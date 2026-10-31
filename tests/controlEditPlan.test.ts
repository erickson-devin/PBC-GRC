import fs from 'fs';
import path from 'path';
import { applyControlNext, planControlRole, planControlStatus, planStarterTemplate } from '../src/utils/controlEditPlan';
import type { AssessmentState, ControlState } from '../src/types/cmmc';

/**
 * What a control edit does is worked out before anything is set, sent or recorded (#181): the plans are pure, and the three edit
 * callbacks make their ledger entry and server save once, outside the state updater. Pure test: no server, no browser.
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

const TS = '2026-10-30T00:00:00.000Z';
const ctx = { tenantId: 't1', updatedBy: 'Ann', timestamp: TS };
const existing = (over: Partial<ControlState> = {}): ControlState => ({
  id: 'X',
  tenantId: 't1',
  status: 'NOT_STARTED',
  implementationNotes: 'Old',
  responsibleRole: 'R',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  tags: ['k'],
  ...over,
});

console.log('--- planStarterTemplate ---');
{
  const p = planStarterTemplate({}, 'AC.L1-3.1.1', 'T', ctx);
  assert(JSON.stringify(p.next) === JSON.stringify({ id: 'AC.L1-3.1.1', tenantId: 't1', status: 'IN_PROGRESS', implementationNotes: 'T', responsibleRole: 'IT / Security Lead', lastUpdated: TS, tags: [], updatedBy: 'Ann' }), 'S181-1 a fresh control gets the template, IN_PROGRESS and the default role', p.next);
  assert(JSON.stringify(p.serverUpdate) === '{"implementationNotes":"T","updatedBy":"Ann","status":"IN_PROGRESS"}', 'S181-1 the server update carries the notes, the editor and the status', p.serverUpdate);
  assert(JSON.stringify(p.auditNewState) === JSON.stringify({ status: 'IN_PROGRESS', templateLength: 1 }), 'S181-1 the ledger entry records the length, never the text', p.auditNewState);

  const kept = planStarterTemplate({ X: existing({ status: 'MET' }) }, 'X', 'T', ctx);
  assert(kept.next.status === 'MET' && kept.next.implementationNotes === 'T' && kept.next.responsibleRole === 'R' && kept.next.tags.join() === 'k' && !('status' in kept.serverUpdate), 'S181-2 a started control keeps its status, role and tags, and sends no status', kept);

  const input = { X: existing() };
  const before = JSON.stringify(input);
  const a = planStarterTemplate(input, 'X', 'T', ctx);
  const b = planStarterTemplate(input, 'X', 'T', ctx);
  assert(JSON.stringify(input) === before && JSON.stringify(a) === JSON.stringify(b), 'S181-3 planning does not touch its input and gives the same plan twice');
}

console.log('\n--- planControlStatus and planControlRole ---');
{
  const s = planControlStatus({}, 'X', 'MET', undefined, ctx);
  assert(s.previousStatus === 'NOT_STARTED' && s.next.status === 'MET', 'S181-4 a fresh control was NOT_STARTED', s);
  const fa = [{ assetId: 'a' }] as unknown as NonNullable<ControlState['failingAssets']>;
  const keep = planControlStatus({ X: existing({ failingAssets: fa }) }, 'X', 'MET', undefined, ctx);
  const clear = planControlStatus({ X: existing({ failingAssets: fa }) }, 'X', 'MET', [], ctx);
  assert(keep.next.failingAssets === fa && Array.isArray(clear.next.failingAssets) && clear.next.failingAssets.length === 0, 'S181-4 failing assets are kept when not passed and replaced when passed');
  const r = planControlRole({ X: existing({ responsibleRole: 'R' }) }, 'X', 'New', ctx);
  assert(r.previousRole === 'R' && r.next.responsibleRole === 'New' && r.next.updatedBy === 'Ann', 'S181-5 the role plan reports the previous role and sets the new one', r);
}

console.log('\n--- applyControlNext ---');
{
  const prev = { version: '2.0.0', tenantId: 't1', controls: { Y: existing({ id: 'Y' }) } } as unknown as AssessmentState;
  const before = JSON.stringify(prev);
  const next = existing();
  const one = applyControlNext(prev, 'X', next);
  const two = applyControlNext(prev, 'X', next);
  assert(JSON.stringify(one) === JSON.stringify(two) && JSON.stringify(prev) === before && one.controls.X === next && one.controls.Y === prev.controls.Y, 'S181-6 applying twice gives the same state and leaves the old one alone');
}

console.log('\n--- Source ---');
{
  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));
  const assess = read('src/context/AssessmentContext.tsx');
  const bodies: Array<[string, string]> = [
    ['updateControlStatus', slice(assess, 'const updateControlStatus = useCallback', '// Notes go to the server a moment')],
    ['updateControlRole', slice(assess, 'const updateControlRole = useCallback', '// Action: Apply Starter Template')],
    ['applyStarterTemplate', slice(assess, 'const applyStarterTemplate = useCallback', '// Action: Bulk Apply STIG')],
  ];
  for (const [name, body] of bodies) {
    const setAt = body.indexOf('setState(');
    const before = body.slice(0, setAt);
    const after = body.slice(setAt);
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    assert(body.length > 0 && setAt > 0 && count(before, 'recordAuditEvent(') === 1 && count(before, 'saveControl(') === 1 && !after.includes('recordAuditEvent(') && !after.includes('saveControl(') && !after.includes('setTimeout(') && !body.includes('let sent') && body.includes('stateRef.current.controls'), `S181-7 ${name} records and saves once, before and outside the state updater`);
  }
  const plan = read('src/utils/controlEditPlan.ts');
  assert(!plan.includes('console.') && !plan.includes('recordAuditEvent') && !plan.includes('localStorage'), 'S181-8 the plan module is pure: no console, ledger or storage');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
