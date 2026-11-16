import fs from 'node:fs';
import path from 'node:path';
import {
  markObjectiveSaves,
  objectiveNotSavedNotice,
  objectiveSaveAnnouncement,
  objectiveSaveFailureOf,
  objectiveSaveView,
  settleObjectiveSaves,
} from '../src/data/objectiveSaveState';
import type { ObjectiveSaveEntry, ObjectiveSaveMap } from '../src/data/objectiveSaveState';

/**
 * #294: the per-objective save state: reducers, failure mapping, the line under an objective and the announcements. The pure helpers
 * only; it does not boot the server.
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

const AT = '2026-11-13T14:32:05Z';
const err = (status: number, reason?: string) => Object.assign(new Error('x'), { name: 'ApiError', status, reason });
const view = (e: ObjectiveSaveEntry | undefined, o: Partial<Parameters<typeof objectiveSaveView>[1]> = {}) =>
  objectiveSaveView(e, { serverBacked: true, canEdit: true, hasDraft: false, ...o });

console.log('--- Reducers ---');
const empty: ObjectiveSaveMap = {};
const inputs = [{ objectiveId: 'o1', status: 'MET' as const }, { objectiveId: 'o2', narrative: 'CUI-MARK' }];
const m1 = markObjectiveSaves(empty, inputs, 1);
assert(m1.o1?.state === 'saving' && m1.o2?.state === 'saving' && Object.keys(empty).length === 0, 'R1: mark sets saving and does not mutate the input');
assert(markObjectiveSaves(m1, [], 2) === m1, 'R1b: nothing to mark returns the same reference');
const stale = settleObjectiveSaves(m1, inputs, 0, { state: 'saved', at: AT });
assert(stale === m1, 'R2: a stale token is a no-op and returns the same reference');
const newer = markObjectiveSaves(m1, [{ objectiveId: 'o1', status: 'NOT_MET' as const }], 2);
const partial = settleObjectiveSaves(newer, inputs, 1, { state: 'saved', at: AT });
assert(partial.o1?.state === 'saving' && partial.o2?.state === 'saved', 'R2b: only the entries that still have the token settle');
const failed = settleObjectiveSaves(m1, inputs, 1, { state: 'failed', reason: 'unreachable' });
const f1 = failed.o1 as Extract<ObjectiveSaveEntry, { state: 'failed' }>;
const f2 = failed.o2 as Extract<ObjectiveSaveEntry, { state: 'failed' }>;
assert(f1.status === 'MET' && f1.narrative === false && f2.status === undefined && f2.narrative === true && f1.reason === 'unreachable', 'R3: failed keeps the status and whether a narrative was sent');
assert(!JSON.stringify(failed).includes('CUI-MARK'), 'R3b: the narrative text is never stored');
assert(m1.o1?.state === 'saving', 'R3c: the input map is not mutated by settle');

console.log('--- Failure mapping ---');
assert(objectiveSaveFailureOf(err(409, 'stale_write')) === 'stale', 'F1a: stale');
assert(objectiveSaveFailureOf(err(401)) === 'session', 'F1b: 401');
assert(objectiveSaveFailureOf(err(409, 'program_archived')) === 'archived', 'F1c: archived');
assert(objectiveSaveFailureOf(err(0)) === 'unreachable', 'F1d: status 0');
assert(objectiveSaveFailureOf(err(500)) === 'failed' && objectiveSaveFailureOf(null) === 'failed' && objectiveSaveFailureOf('x') === 'failed', 'F1e: anything else');
assert(
  objectiveNotSavedNotice(1) === 'An objective answer was not saved to the server. It is marked "Not saved" in its control.' &&
    objectiveNotSavedNotice(3) === '3 objective answers were not saved to the server. They are marked "Not saved" in their control.',
  'F2: the not-saved notice'
);

console.log('--- The line under an objective ---');
assert(view({ state: 'saving', token: 1 })?.text === 'Saving…' && view({ state: 'saving', token: 1 })?.tone === 'muted', 'V1: saving');
const sv = view({ state: 'saved', token: 1, at: AT }, { locale: 'en-GB', timeZone: 'UTC' });
assert(sv?.text === 'Saved at 14:32' && sv.tone === 'ok' && !sv.retry, 'V2: saved at the time', sv);
const bv = view({ state: 'saved', token: 1, at: AT }, { serverBacked: false });
assert(bv?.text === 'Saved in this browser' && bv.tone === 'ok', 'V3: browser-only');
const fail = (reason: 'failed' | 'unreachable' | 'stale' | 'archived' | 'session', status?: 'MET', narrative = false): ObjectiveSaveEntry =>
  ({ state: 'failed', token: 1, reason, status, narrative });
assert(view(fail('stale'))?.text === 'Not saved: someone else saved this objective while you were editing. Copy your text, then reload to see theirs.', 'V4a: stale');
assert(view(fail('archived'))?.text === 'Not saved: this program is archived and read-only.', 'V4b: archived');
assert(view(fail('session'))?.text === 'Not saved: your session ended. Sign in again, then repeat the change.', 'V4c: session');
assert(view(fail('failed', 'MET'))?.text === 'Not saved.' && view(fail('unreachable', 'MET'))?.text === 'Not saved: the server could not be reached.', 'V4d: failed and unreachable with a retry');
assert(view(fail('failed'))?.text === 'Not saved. Repeat the change to try again.', 'V4e: nothing to retry');
assert(view(fail('stale'))?.retry === false && view(fail('archived'))?.retry === false && view(fail('session'))?.retry === false, 'V5a: no retry for stale, archived or session');
assert(view(fail('failed', 'MET'))?.retry === true && view(fail('failed'))?.retry === false, 'V5b: a status can be retried');
assert(
  view(fail('unreachable', undefined, true), { hasDraft: true })?.retry === true && view(fail('unreachable', undefined, true), { hasDraft: false })?.retry === false,
  'V5c: a narrative can be retried only while the draft is still in the box'
);
assert(view({ state: 'saving', token: 1 }, { canEdit: false }) === null && view(undefined) === null, 'V6: a read-only role or no entry has no line');

console.log('--- Announcements ---');
const ids = [{ id: 'o1', label: 'b' }, { id: 'o2', label: 'c' }, { id: 'o3', label: 'd' }];
const saving = markObjectiveSaves(empty, [{ objectiveId: 'o1' }, { objectiveId: 'o2' }, { objectiveId: 'o3' }], 1);
const ann = (prev: ObjectiveSaveMap, next: ObjectiveSaveMap, serverBacked = true) => objectiveSaveAnnouncement(prev, next, ids, { serverBacked });
const one = settleObjectiveSaves(saving, [{ objectiveId: 'o1' }], 1, { state: 'saved', at: AT });
assert(ann(saving, one) === 'Objective [b] saved.', 'A1: one saved');
assert(ann(saving, one, false) === 'Objective [b] saved in this browser.', 'A2: one saved, browser-only');
const all = settleObjectiveSaves(saving, [{ objectiveId: 'o1' }, { objectiveId: 'o2' }, { objectiveId: 'o3' }], 1, { state: 'saved', at: AT });
assert(ann(saving, all) === '3 objectives saved.', 'A3a: several saved');
const bad = settleObjectiveSaves(saving, [{ objectiveId: 'o2' }], 1, { state: 'failed', reason: 'failed' });
assert(ann(saving, bad) === 'Objective [c] not saved.', 'A3b: one failed');
const mixed = settleObjectiveSaves(one, [{ objectiveId: 'o2' }, { objectiveId: 'o3' }], 1, { state: 'failed', reason: 'failed' });
assert(ann(one, mixed) === '2 objectives not saved.', 'A3c: failures win and are counted');
assert(ann(all, all) === '' && ann(empty, saving) === '', 'A4: nothing settled, nothing announced');

console.log('--- Source ---');
const files = ['data/statusLabels.ts', 'data/matrixView.ts', 'data/objectiveSaveState.ts', 'data/cmmcGuide/controlStatusView.ts', 'data/cmmcGuide/sspStatementView.ts'];
for (const f of files) {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf8');
  assert(!/console\./.test(src) && !/localStorage|sessionStorage/.test(src) && !/from 'react'|document\./.test(src), `P1: ${f} has no console, browser storage, React or DOM use`);
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
