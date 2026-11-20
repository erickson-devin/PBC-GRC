import {
  CONTROL_POAM_CONTROL_ID_PATTERN, CONTROL_POAM_OWNER_MAX, CONTROL_POAM_PLAN_MAX, CONTROL_POAM_RESOURCES_MAX, parseControlPoamPatch,
} from '../src/data/controlPoamEdit';
import { isValidPoamDate } from '../src/data/vmPoamEdit';

/**
 * #304: the request body of PATCH /api/v1/control-poam/:controlId (parseControlPoamPatch) as a pure function. Pure test: no server, no browser.
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

const STAMP = '2026-11-01T10:00:00.000Z';
const field = (body: unknown): string | null => {
  const r = parseControlPoamPatch(body);
  return r.ok ? null : r.field;
};

console.log('--- Limits and the shared date rule ---');
assert(CONTROL_POAM_OWNER_MAX === 255 && CONTROL_POAM_RESOURCES_MAX === 2000 && CONTROL_POAM_PLAN_MAX === 4000, 'C-P01 the limits are 255, 2000 and 4000 characters');
assert(isValidPoamDate('2027-01-15') && !isValidPoamDate('2027-02-30') && !isValidPoamDate('1999-12-31') && !isValidPoamDate('2100-01-01'), 'C-P02 the date rule is the shared one (calendar date between 2000-01-01 and 2099-12-31)');

console.log('\n--- expectedUpdatedAt ---');
assert(field({ owner: 'x' }) === 'expectedUpdatedAt', 'C-P03 a missing expectedUpdatedAt is refused, naming expectedUpdatedAt');
assert(field({ expectedUpdatedAt: 'not a date', owner: 'x' }) === 'expectedUpdatedAt', 'C-P04 an unreadable expectedUpdatedAt is refused');
assert(field({ expectedUpdatedAt: 5, owner: 'x' }) === 'expectedUpdatedAt', 'C-P05 a non-string expectedUpdatedAt is refused');
{
  const r = parseControlPoamPatch({ expectedUpdatedAt: null, owner: 'IT Lead' });
  assert(r.ok && r.expectedUpdatedAt === null && r.patch.owner === 'IT Lead', 'C-P06 expectedUpdatedAt null (no entry yet) with an owner is accepted', r);
  const s = parseControlPoamPatch({ expectedUpdatedAt: STAMP, plan: 'p' });
  assert(s.ok && s.expectedUpdatedAt === STAMP, 'C-P07 a stamp is accepted and returned', s);
}

console.log('\n--- Body ---');
assert(field(null) === 'body' && field([]) === 'body' && field('x') === 'body' && field(5) === 'body', 'C-P08 a body that is not an object is refused, naming body');
assert(field({}) === 'body', 'C-P09 an empty body is refused, naming body');
assert(field({ expectedUpdatedAt: STAMP }) === 'body', 'C-P10 a body that carries nothing to change is refused, naming body');
assert(field({ expectedUpdatedAt: STAMP, status: 'MET' }) === 'status', 'C-P11 the key status is refused, naming status (the control status has its own route)');
assert(field({ expectedUpdatedAt: STAMP, weakness: 'x' }) === 'weakness' && field({ expectedUpdatedAt: STAMP, mitigation: 'x' }) === 'mitigation', 'C-P12 an unknown key is refused, naming it');
assert(field({ expectedUpdatedAt: STAMP, ['a b<script>']: 1 }) === 'a_b_script_', 'C-P13 an odd key is named in a sanitised form');

console.log('\n--- Owner ---');
assert(parseControlPoamPatch({ expectedUpdatedAt: STAMP, owner: 'a'.repeat(255) }).ok && field({ expectedUpdatedAt: STAMP, owner: 'a'.repeat(256) }) === 'owner', 'C-P14 255 owner characters are accepted, 256 refused');
assert(field({ expectedUpdatedAt: STAMP, owner: 'a\nb' }) === 'owner' && field({ expectedUpdatedAt: STAMP, owner: 'a\u0007' }) === 'owner' && field({ expectedUpdatedAt: STAMP, owner: 5 }) === 'owner', 'C-P15 an owner with a line break or control character, or a non-string, is refused');
{
  const r = parseControlPoamPatch({ expectedUpdatedAt: STAMP, owner: '  IT Lead  ' });
  const c = parseControlPoamPatch({ expectedUpdatedAt: STAMP, owner: '   ' });
  assert(r.ok && r.patch.owner === 'IT Lead' && c.ok && c.patch.owner === '', 'C-P16 the owner is trimmed; blank clears it', [r, c]);
}

console.log('\n--- Scheduled completion ---');
assert(field({ expectedUpdatedAt: STAMP, scheduledCompletion: '2027-02-30' }) === 'scheduledCompletion', 'C-P17 2027-02-30 is refused, naming scheduledCompletion');
assert(field({ expectedUpdatedAt: STAMP, scheduledCompletion: '2027-1-5' }) === 'scheduledCompletion' && field({ expectedUpdatedAt: STAMP, scheduledCompletion: 20270115 }) === 'scheduledCompletion' && field({ expectedUpdatedAt: STAMP, scheduledCompletion: '' }) === 'scheduledCompletion', 'C-P18 a malformed date, a number and an empty string are refused');
{
  const d = parseControlPoamPatch({ expectedUpdatedAt: STAMP, scheduledCompletion: '2027-01-15' });
  const n = parseControlPoamPatch({ expectedUpdatedAt: STAMP, scheduledCompletion: null });
  assert(d.ok && d.patch.scheduledCompletion === '2027-01-15' && n.ok && n.patch.scheduledCompletion === null, 'C-P19 a date is accepted; null clears it', [d, n]);
}

console.log('\n--- Required resources and plan ---');
assert(parseControlPoamPatch({ expectedUpdatedAt: STAMP, requiredResources: 'r'.repeat(2000) }).ok && field({ expectedUpdatedAt: STAMP, requiredResources: 'r'.repeat(2001) }) === 'requiredResources', 'C-P20 2000 resource characters are accepted, 2001 refused');
assert(parseControlPoamPatch({ expectedUpdatedAt: STAMP, plan: 'p'.repeat(4000) }).ok && field({ expectedUpdatedAt: STAMP, plan: 'p'.repeat(4001) }) === 'plan', 'C-P21 4000 plan characters are accepted, 4001 refused (field plan)');
{
  const r = parseControlPoamPatch({ expectedUpdatedAt: STAMP, plan: 'step 1\n\tstep 2', requiredResources: 'two\nlines' });
  assert(r.ok && r.patch.plan === 'step 1\n\tstep 2' && r.patch.requiredResources === 'two\nlines', 'C-P22 the plan and the resources may hold line breaks and tabs', r);
  assert(field({ expectedUpdatedAt: STAMP, plan: 'a\u0000b' }) === 'plan' && field({ expectedUpdatedAt: STAMP, requiredResources: 'a\u001fb' }) === 'requiredResources' && field({ expectedUpdatedAt: STAMP, plan: 7 }) === 'plan', 'C-P23 other control characters and non-strings are refused');
}

console.log('\n--- Milestones ---');
{
  const r = parseControlPoamPatch({ expectedUpdatedAt: STAMP, milestones: [{ description: ' Do it ', targetDate: '2027-01-01' }, { id: 'ms-aaaaaaaaaaaa', description: 'Done', targetDate: '2027-02-01', completed: true }] });
  assert(r.ok && r.patch.milestones?.length === 2 && r.patch.milestones[0].description === 'Do it' && r.patch.milestones[0].completed === false && r.patch.milestones[1].id === 'ms-aaaaaaaaaaaa' && r.patch.milestones[1].completed === true, 'C-P24 milestones are read: trimmed, completed defaults to false, an id is kept', r);
  assert(field({ expectedUpdatedAt: STAMP, milestones: [{ description: '', targetDate: '2027-01-01' }] }) === 'milestones' && field({ expectedUpdatedAt: STAMP, milestones: 'x' }) === 'milestones', 'C-P25 a bad milestone list is refused, naming milestones');
  const clear = parseControlPoamPatch({ expectedUpdatedAt: STAMP, milestones: [] });
  assert(clear.ok && clear.patch.milestones?.length === 0, 'C-P26 an empty list is accepted (it clears the milestones)', clear);
}

console.log('\n--- Several fields, no echo, control id pattern ---');
{
  const r = parseControlPoamPatch({ expectedUpdatedAt: STAMP, owner: 'a', scheduledCompletion: '2026-12-15', requiredResources: 'b', plan: 'c' });
  assert(r.ok && JSON.stringify(r.patch) === JSON.stringify({ owner: 'a', scheduledCompletion: '2026-12-15', requiredResources: 'b', plan: 'c' }), 'C-P27 four fields together', r);
  const bad = parseControlPoamPatch({ expectedUpdatedAt: STAMP, owner: 'SECRET-OWNER-TEXT'.repeat(30) });
  assert(!bad.ok && !JSON.stringify(bad).includes('SECRET'), 'C-P28 a refusal names the field and never echoes the value', bad);
}
assert(['AC.L1-3.1.1', 'AC-2(1)', 'SC.L2-3.13.11', 'A.1', 'x'].every((id) => CONTROL_POAM_CONTROL_ID_PATTERN.test(id)), 'C-P29 the control id pattern accepts the CMMC and NIST 800-53 ids');
assert(['', 'a b', 'a/b', 'a\nb', 'x'.repeat(65), '../x', 'a%20b'].every((id) => !CONTROL_POAM_CONTROL_ID_PATTERN.test(id)), 'C-P30 the control id pattern refuses a space, a slash, a line break, 65 characters and path or escape characters');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
