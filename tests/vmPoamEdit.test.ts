import {
  VM_POAM_DATE_MAX, VM_POAM_DATE_MIN, VM_POAM_MITIGATION_MAX, VM_POAM_OWNER_MAX, isValidPoamDate, parseVmPoamPatch, planVmPoamStatus, vmPoamFindingOpenInEpisode,
} from '../src/data/vmPoamEdit';
import { VM_POAM_STATUSES } from '../src/types/vm';
import type { VmPoamStatus } from '../src/types/vm';

/**
 * #297: the request body of PATCH .../vm/poam/:itemId (parseVmPoamPatch) and the status rules (planVmPoamStatus) as pure functions.
 * Pure test: no server, no browser.
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
  const r = parseVmPoamPatch(body);
  return r.ok ? null : r.field;
};

console.log('--- Limits ---');
assert(VM_POAM_OWNER_MAX === 255 && VM_POAM_MITIGATION_MAX === 4000 && VM_POAM_DATE_MIN === '2000-01-01' && VM_POAM_DATE_MAX === '2099-12-31', 'E-P01 the limits are 255, 4000 and 2000-01-01 to 2099-12-31');

console.log('\n--- Owner ---');
assert(parseVmPoamPatch({ expectedUpdatedAt: STAMP, owner: 'a'.repeat(255) }).ok, 'E-P02 an owner of 255 characters is accepted');
assert(field({ expectedUpdatedAt: STAMP, owner: 'a'.repeat(256) }) === 'owner', 'E-P03 an owner of 256 characters is refused, naming owner');
assert(field({ expectedUpdatedAt: STAMP, owner: 'a\u0007' }) === 'owner', 'E-P04 an owner with a control character is refused');
assert(field({ expectedUpdatedAt: STAMP, owner: 'a\nb' }) === 'owner', 'E-P05 an owner with a line break is refused');
assert(field({ expectedUpdatedAt: STAMP, owner: 5 }) === 'owner', 'E-P06 a non-string owner is refused');
{
  const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, owner: '  IT Lead  ' });
  assert(r.ok && r.patch.owner === 'IT Lead', 'E-P07 the owner is trimmed', r);
  const e = parseVmPoamPatch({ expectedUpdatedAt: STAMP, owner: '   ' });
  assert(e.ok && e.patch.owner === '', 'E-P08 a blank owner clears it (empty string)', e);
}

console.log('\n--- Mitigation ---');
assert(parseVmPoamPatch({ expectedUpdatedAt: STAMP, mitigation: 'a'.repeat(4000) }).ok, 'E-P09 a mitigation of 4000 characters is accepted');
assert(field({ expectedUpdatedAt: STAMP, mitigation: 'a'.repeat(4001) }) === 'mitigation', 'E-P10 a mitigation of 4001 characters is refused, naming mitigation');
{
  const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, mitigation: 'a\nb\tc' });
  assert(r.ok && r.patch.mitigation === 'a\nb\tc', 'E-P11 line feed and tab are allowed in a mitigation', r);
}
assert(field({ expectedUpdatedAt: STAMP, mitigation: '\u0000' }) === 'mitigation', 'E-P12 a NUL in a mitigation is refused');
assert(field({ expectedUpdatedAt: STAMP, mitigation: 'a\u007f' }) === 'mitigation', 'E-P13 DEL in a mitigation is refused');
assert(field({ expectedUpdatedAt: STAMP, mitigation: null }) === 'mitigation', 'E-P14 a null mitigation is refused (an empty string clears it)');

console.log('\n--- Scheduled completion ---');
for (const ok of ['2028-02-29', '2000-01-01', '2099-12-31', '2026-12-15']) {
  const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, scheduledCompletion: ok });
  assert(r.ok && r.patch.scheduledCompletion === ok, `E-P15 ${ok} is accepted`, r);
}
for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '1999-12-31', '2100-01-01', 20261215, '', '2026-12-15T00:00:00Z', undefined]) {
  assert(field({ expectedUpdatedAt: STAMP, scheduledCompletion: bad }) === 'scheduledCompletion', `E-P16 ${JSON.stringify(bad)} is refused, naming scheduledCompletion`);
}
{
  const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, scheduledCompletion: null });
  assert(r.ok && r.patch.scheduledCompletion === null, 'E-P17 null clears the date', r);
  assert(isValidPoamDate('2026-12-15') && !isValidPoamDate('2026-02-30') && !isValidPoamDate(null), 'E-P18 isValidPoamDate');
}

console.log('\n--- Status ---');
assert(field({ expectedUpdatedAt: STAMP, status: 'open' }) === 'status', 'E-P19 a lower-case status is refused');
assert(field({ expectedUpdatedAt: STAMP, status: 'DONE' }) === 'status', 'E-P20 an unknown status is refused');
assert(VM_POAM_STATUSES.every((s) => { const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, status: s }); return r.ok && r.patch.status === s; }), 'E-P21 every VM_POAM_STATUSES value is accepted');

console.log('\n--- Body ---');
assert(field({ expectedUpdatedAt: STAMP }) === 'body', 'E-P22 nothing to change -> body');
assert(field(null) === 'body' && field([]) === 'body' && field('x') === 'body' && field(undefined) === 'body', 'E-P23 a body that is not an object -> body');
assert(field({ foo: 1, expectedUpdatedAt: STAMP, owner: 'x' }) === 'foo', 'E-P24 an unknown key is named');
assert(field({ owner: 'x' }) === 'expectedUpdatedAt' && field({ owner: 'x', expectedUpdatedAt: null }) === 'expectedUpdatedAt', 'E-P25 a missing or null expectedUpdatedAt is refused');
assert(field({ owner: 'x', expectedUpdatedAt: 'yesterday' }) === 'expectedUpdatedAt' && field({ owner: 'x', expectedUpdatedAt: 5 }) === 'expectedUpdatedAt', 'E-P26 an expectedUpdatedAt that is not a timestamp is refused');
{
  const r = parseVmPoamPatch({ expectedUpdatedAt: STAMP, owner: 'a', mitigation: 'b', scheduledCompletion: '2026-12-15', status: 'IN_PROGRESS' });
  assert(r.ok && r.expectedUpdatedAt === STAMP && JSON.stringify(r.patch) === JSON.stringify({ owner: 'a', mitigation: 'b', scheduledCompletion: '2026-12-15', status: 'IN_PROGRESS' }), 'E-P27 all four fields together', r);
}
{
  const secret = 'OWNER-SECRET-TEXT';
  const refusals = [parseVmPoamPatch({ expectedUpdatedAt: STAMP, owner: secret + 'x'.repeat(300) }), parseVmPoamPatch({ expectedUpdatedAt: STAMP, scheduledCompletion: secret })];
  assert(refusals.every((r) => !r.ok && !JSON.stringify(r).includes(secret)), 'E-P28 a refusal names the field and never the value');
}

console.log('\n--- Status transitions ---');
const MIT = 'Patch the host';
let table = 0;
let tableOk = true;
for (const from of VM_POAM_STATUSES) {
  for (const to of VM_POAM_STATUSES) {
    for (const open of [false, true]) {
      table++;
      const r = planVmPoamStatus({ status: from, findingOpenInEpisode: open }, to, MIT);
      const expectBlocked = to === 'COMPLETED' && from !== 'COMPLETED' && open;
      const expectReopen = (from === 'COMPLETED' || from === 'RISK_ACCEPTED') && (to === 'OPEN' || to === 'IN_PROGRESS');
      const good = expectBlocked ? !r.ok && r.code === 'finding_still_open' : r.ok && r.reopen === expectReopen;
      if (!good) { tableOk = false; console.error('    mismatch', from, to, open, JSON.stringify(r)); }
    }
  }
}
assert(table === 32 && tableOk, 'E-T01 every from / to pair with the finding open and not open', { table });
{
  const blocked = planVmPoamStatus({ status: 'OPEN', findingOpenInEpisode: true }, 'COMPLETED', MIT);
  assert(!blocked.ok && blocked.code === 'finding_still_open', 'E-T02 OPEN -> COMPLETED while the finding is open -> finding_still_open', blocked);
  const done = planVmPoamStatus({ status: 'IN_PROGRESS', findingOpenInEpisode: false }, 'COMPLETED', '');
  assert(done.ok && !done.reopen, 'E-T03 IN_PROGRESS -> COMPLETED with the finding resolved needs no mitigation', done);
  const noMit = planVmPoamStatus({ status: 'OPEN', findingOpenInEpisode: true }, 'RISK_ACCEPTED', '');
  assert(!noMit.ok && noMit.code === 'mitigation_required', 'E-T04 RISK_ACCEPTED with an empty mitigation -> mitigation_required', noMit);
  const blank = planVmPoamStatus({ status: 'OPEN', findingOpenInEpisode: false }, 'RISK_ACCEPTED', '   ');
  assert(!blank.ok && blank.code === 'mitigation_required', 'E-T05 a blank mitigation counts as empty', blank);
  const accepted = planVmPoamStatus({ status: 'OPEN', findingOpenInEpisode: true }, 'RISK_ACCEPTED', MIT);
  assert(accepted.ok && !accepted.reopen, 'E-T06 RISK_ACCEPTED with a mitigation is allowed even while the finding is open', accepted);
  const stay = planVmPoamStatus({ status: 'RISK_ACCEPTED', findingOpenInEpisode: true }, 'RISK_ACCEPTED', '');
  assert(!stay.ok && stay.code === 'mitigation_required', 'E-T07 a RISK_ACCEPTED item cannot end with an empty mitigation', stay);
  const reopen = planVmPoamStatus({ status: 'COMPLETED', findingOpenInEpisode: true }, 'OPEN', '');
  assert(reopen.ok && reopen.reopen, 'E-T08 COMPLETED -> OPEN is a reopen', reopen);
  const progress = planVmPoamStatus({ status: 'OPEN', findingOpenInEpisode: true }, 'IN_PROGRESS', '');
  assert(progress.ok && !progress.reopen, 'E-T09 OPEN -> IN_PROGRESS is not a reopen', progress);
  const same = planVmPoamStatus({ status: 'COMPLETED', findingOpenInEpisode: true }, 'COMPLETED', '');
  assert(same.ok && !same.reopen, 'E-T10 an unchanged COMPLETED status is never refused', same);
  const statuses: VmPoamStatus[] = ['OPEN', 'IN_PROGRESS'];
  assert(statuses.every((s) => planVmPoamStatus({ status: 'RISK_ACCEPTED', findingOpenInEpisode: false }, s, '').ok), 'E-T11 RISK_ACCEPTED -> OPEN / IN_PROGRESS is allowed');
}

console.log('\n--- Finding open in the item episode ---');
{
  const F0 = '2026-10-01T00:00:00.000Z';
  const F1 = '2026-10-20T00:00:00.000Z';
  const item = (episode: string | null, createdAt: string) => ({ findingFirstSeenAt: episode, createdAt });
  assert(vmPoamFindingOpenInEpisode(item(F0, F1), { status: 'OPEN', firstSeenAt: F0 }), 'E-F01 open finding, same episode -> true');
  assert(!vmPoamFindingOpenInEpisode(item(F0, F1), { status: 'OPEN', firstSeenAt: F1 }), 'E-F02 open finding that came back later (new episode) -> false');
  assert(!vmPoamFindingOpenInEpisode(item(F0, F1), { status: 'RESOLVED', firstSeenAt: F0 }), 'E-F03 resolved finding -> false');
  assert(!vmPoamFindingOpenInEpisode(item(F0, F1), { status: 'RISK_ACCEPTED', firstSeenAt: F0 }) && !vmPoamFindingOpenInEpisode(item(F0, F1), { status: 'FALSE_POSITIVE', firstSeenAt: F0 }), 'E-F04 decided finding -> false');
  assert(!vmPoamFindingOpenInEpisode(item(F0, F1), null), 'E-F05 deleted finding -> false');
  assert(vmPoamFindingOpenInEpisode(item(null, F1), { status: 'OPEN', firstSeenAt: F0 }), 'E-F06 legacy item created after first seen, finding open -> true');
  assert(!vmPoamFindingOpenInEpisode(item(null, F0), { status: 'OPEN', firstSeenAt: F1 }), 'E-F07 legacy item created before the episode began -> false');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
