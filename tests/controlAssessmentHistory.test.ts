import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeDocx } from './sspFixtures';
import { server } from '../server/index';
import { __drainVmWorkerForTests } from '../server/vm/worker';
import { recordReceivedRun } from '../server/vm/store';
import { __resetVmSnapshotLimiterForTests } from '../server/vm/snapshotWriter';
import { stopVmScheduler } from '../server/vm/scheduler';
import { VM_NOTES_BEGIN, VM_NOTES_END } from '../server/vm/snapshot';
import { buildControlAssessmentEvent, notesDigest } from '../server/controlAssessments';

/**
 * Control-assessment history over HTTP: the PUT /controls semantics (a field left out keeps its value, an empty string clears the
 * notes), the SSP commit keeping the vulnerability-management block, and GET /controls/:controlId/history (who, what changed, the
 * SHA-256 and length of the notes, never their text). Runs against the in-memory store with a throw-away vault (see ./vmEnv).
 * Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const SI = 'SI.L1-3.14.1';
const AC = 'AC.L1-3.1.1';
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

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

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (tenant) h['x-tenant-id'] = tenant;
  if (program) h['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

async function upload(token: string, tenant: string, data: Buffer, framework: string) {
  const form = new FormData();
  form.append('framework', framework);
  form.append('file', new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }), 'plan.docx');
  const res = await fetch(`${BASE}/tenants/${tenant}/ssp-imports`, { method: 'POST', headers: { 'x-tenant-id': tenant, Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

async function waitReady(token: string, tenant: string, jobId: string): Promise<Json> {
  for (let i = 0; i < 100; i++) {
    const job = (await call('GET', `/tenants/${tenant}/ssp-imports/${jobId}`, token, tenant)).body?.job as Json;
    if (job && ['READY_FOR_REVIEW', 'FAILED', 'COMMITTED'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const count = (s: string, needle: string) => s.split(needle).length - 1;
const blockOf = (notes: string) => {
  const b = notes.indexOf(VM_NOTES_BEGIN);
  const e = notes.indexOf(VM_NOTES_END);
  return b >= 0 && e > b ? notes.slice(b, e + VM_NOTES_END.length) : '';
};

async function shutdown(code: number) {
  process.exitCode = code;
  stopVmScheduler();
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

let runCounter = 0;
const dummyRun = (label: string) => {
  runCounter += 1;
  return {
    id: `run_hist_${runCounter}_${crypto.randomBytes(3).toString('hex')}`,
    kind: 'WAZUH' as const,
    label,
    collectedAt: null,
    exporterName: 'hist-test',
    exporterVersion: '1',
    hostCount: 0,
    findingCount: 0,
    rawPath: path.join(VM_TEST_VAULT, 'tenants', 'none', 'vm', 'runs', `dummy_${runCounter}.json`),
    rawSha256: crypto.randomBytes(32).toString('hex'),
    rawBytes: 0,
  };
};

const sspLines = (extra = '') => [
  'System Security Plan - History Org' + extra,
  '1. SYSTEM AND INFORMATION INTEGRITY',
  'SI.L1-3.14.1 Flaw Remediation',
  'Flaws are identified, reported and corrected in a timely manner through monthly patching and quarterly vulnerability scans by the IT lead.',
  '2. ACCESS CONTROL',
  'AC.L1-3.1.1 Authorized Access Control',
  'Access to systems is limited to authorized users with MFA, and accounts are reviewed quarterly by the IT lead.',
];

function pureTests() {
  console.log('--- E01-E05: the pure helpers ---');
  const d0 = notesDigest('');
  const d1 = notesDigest('abc');
  assert(d0.sha256 === SHA_EMPTY && d0.length === 0 && d1.sha256 === SHA_ABC && d1.length === 3, 'E01 notesDigest: SHA-256 and length of "" and "abc"', [d0, d1]);
  const who = { source: 'human' as const, actor: 'A', userId: 'u1' };
  const after = { status: 'MET', notes: 'abc', role: 'CISO', updatedAt: null };
  const first = buildControlAssessmentEvent('t', SI, null, after, who);
  assert(first.oldStatus === null && first.oldRole === null && first.oldNotesSha256 === null && first.oldNotesLength === null && first.notesChanged === true && first.newNotesSha256 === SHA_ABC && first.newNotesLength === 3, 'E02 a new row: old values null, notesChanged true', first);
  const noop = buildControlAssessmentEvent('t', SI, { ...after, status: 'NOT_MET' }, after, who);
  assert(noop.notesChanged === false && noop.oldStatus === 'NOT_MET' && noop.newStatus === 'MET' && noop.oldNotesSha256 === noop.newNotesSha256, 'E03 identical notes: notesChanged false', noop);
  const long = buildControlAssessmentEvent('t', SI, null, after, { source: 'vm-snapshot', actor: 'x'.repeat(400), userId: 'y'.repeat(200) });
  assert(long.actor.length === 255 && long.actorUserId?.length === 128, 'E04 actor is cut to 255 and the user id to 128', [long.actor.length, long.actorUserId?.length]);
  let threw = false;
  try { buildControlAssessmentEvent('t', SI, null, after, { source: 'robot' as never, actor: 'A', userId: null }); } catch { threw = true; }
  assert(threw && JSON.stringify(first).includes('abc') === false, 'E05 an unknown source throws, and an event never carries the notes text', first);
}

async function run() {
  pureTests();
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n--- Setup: users, tenants, a source ---');
  process.env.PLATFORM_ADMIN_EMAILS = 'u_hist_admin@test.mil';
  const owner1 = person('u_hist_o1');
  const viewer = person('u_hist_v');
  const owner2 = person('u_hist_o2');
  const owner3 = person('u_hist_o3');
  const admin = person('u_hist_admin');
  const mkTenant = async (who: string, name: string, extra: Record<string, unknown> = {}) =>
    (await call('POST', '/tenants', who, undefined, { name, ...extra })).body?.tenant?.id as string;
  const T1 = await mkTenant(owner1, 'Hist T1');
  const T2 = await mkTenant(owner2, 'Hist T2');
  const T3 = await mkTenant(owner3, 'Hist T3');
  const T4 = await mkTenant(admin, 'Hist T4', { primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] });
  assert(Boolean(T1 && T2 && T3 && T4) && new Set([T1, T2, T3, T4]).size === 4, 'four tenants created (T1-T3 Level 1, T4 Level 2 by an administrator)', { T1, T2, T3, T4 });
  await call('POST', `/tenants/${T1}/members`, owner1, T1, { userId: 'u_hist_v', email: 'u_hist_v@test.mil', role: 'VIEWER' });
  await recordReceivedRun(T1, dummyRun('hist-t1'));
  await recordReceivedRun(T4, dummyRun('hist-t4'));

  const controlsOf = async (tenant: string, who: string, framework = 'CMMC_L1') => ((await call('GET', `/controls?framework=${framework}`, who, tenant)).body?.controls ?? []) as Json[];
  const controlOf = async (tenant: string, who: string, id: string, framework = 'CMMC_L1') => (await controlsOf(tenant, who, framework)).find((c) => c.id === id) as Json;
  const put = (tenant: string, who: string, id: string, body: unknown) => call('PUT', `/controls/${id}`, who, tenant, body);
  const history = async (tenant: string, who: string, id: string, query = '') => call('GET', `/controls/${id}/history${query}`, who, tenant);
  const eventsOf = async (tenant: string, who: string, id: string) => ((await history(tenant, who, id)).body?.events ?? []) as Json[];
  const snapshot = (tenant: string, who: string) => { __resetVmSnapshotLimiterForTests(); return call('POST', `/tenants/${tenant}/vm/snapshot`, who, tenant); };
  const stage = async (who: string, tenant: string, lines: string[], framework = 'CMMC_L1') => {
    const up = await upload(who, tenant, await makeDocx(lines), framework);
    const jobId = up.body?.job?.id as string;
    const job = jobId ? await waitReady(who, tenant, jobId) : null;
    const items = jobId ? (((await call('GET', `/tenants/${tenant}/ssp-imports/${jobId}/staged`, who, tenant)).body?.staged ?? []) as Json[]) : [];
    return { up, jobId, job, items };
  };
  const review = (who: string, tenant: string, jobId: string, id: string, body: unknown) => call('PATCH', `/tenants/${tenant}/ssp-imports/${jobId}/staged/${id}`, who, tenant, body);
  const commit = (who: string, tenant: string, jobId: string) => call('POST', `/tenants/${tenant}/ssp-imports/${jobId}/commit`, who, tenant, {});

  console.log('\n--- P01-P09: PUT /controls semantics ---');
  const p01 = await put(T1, owner1, SI, { status: 'IN_PROGRESS', implementationNotes: 'Human notes one.' });
  const c1 = await controlOf(T1, owner1, SI);
  assert(p01.status === 200 && c1?.status === 'IN_PROGRESS' && c1?.implementationNotes === 'Human notes one.' && c1?.responsibleRole === 'IT / Security Lead', 'P01 the first PUT of a control writes status and notes; the role takes its default', [p01.body, c1]);
  const p02 = await put(T1, owner1, SI, { status: 'MET' });
  const c2 = await controlOf(T1, owner1, SI);
  assert(p02.status === 200 && c2?.status === 'MET' && c2?.implementationNotes === 'Human notes one.', 'P02 a status-only PUT keeps the notes', c2);
  const p03 = await put(T1, owner1, SI, { implementationNotes: 'Changed text.' });
  const c3 = await controlOf(T1, owner1, SI);
  assert(p03.status === 200 && c3?.status === 'MET' && c3?.implementationNotes === 'Changed text.', 'P03 a notes-only PUT keeps the status', c3);
  const p04 = await put(T1, owner1, SI, { responsibleRole: 'CISO' });
  const c4 = await controlOf(T1, owner1, SI);
  assert(p04.status === 200 && c4?.responsibleRole === 'CISO' && c4?.status === 'MET' && c4?.implementationNotes === 'Changed text.', 'P04 a role-only PUT keeps status and notes', c4);
  const p05 = await put(T1, owner1, SI, { status: null, implementationNotes: null, responsibleRole: null });
  const c5 = await controlOf(T1, owner1, SI);
  assert(p05.status === 200 && c5?.status === 'MET' && c5?.implementationNotes === 'Changed text.' && c5?.responsibleRole === 'CISO', 'P05 null for every field keeps everything', c5);
  const p06 = await put(T1, owner1, SI, { status: '', responsibleRole: '', implementationNotes: 'Human notes two.', updatedBy: 'Someone Else' });
  const c6 = await controlOf(T1, owner1, SI);
  assert(p06.status === 200 && c6?.status === 'MET' && c6?.responsibleRole === 'CISO' && c6?.implementationNotes === 'Human notes two.' && c6?.updatedBy === 'Someone Else', 'P06 an empty status or role keeps it; the body updatedBy still shows in the control', c6);
  const p07 = await put(T1, owner1, SI, { implementationNotes: '' });
  const c7 = await controlOf(T1, owner1, SI);
  assert(p07.status === 200 && c7?.implementationNotes === '' && c7?.status === 'MET', 'P07 an empty string clears the notes only', c7);

  const bad = [
    await put(T1, owner1, SI, { status: 'BOGUS' }),
    await put(T1, owner1, SI, { implementationNotes: 5 }),
    await put(T1, owner1, SI, { responsibleRole: 7 }),
  ];
  const c8 = await controlOf(T1, owner1, SI);
  assert(
    bad[0].status === 400 && String(bad[0].body?.error).startsWith('Invalid status: BOGUS. Must be one of:') && bad[1].status === 400 && bad[1].body?.error === 'implementationNotes must be text' && bad[2].status === 400 && bad[2].body?.error === 'responsibleRole must be text' && c8?.status === 'MET' && c8?.implementationNotes === '',
    'P08 a bad status, notes or role is refused (400) and nothing changes',
    bad.map((b) => b.body),
  );

  console.log('\n--- H01-H03, H05-H10: the history of SI.L1-3.14.1 ---');
  const h1 = await history(T1, owner1, SI);
  const ev1 = (h1.body?.events ?? []) as Json[];
  assert(h1.status === 200 && h1.body?.tenantId === T1 && h1.body?.controlId === SI && h1.body?.totalCount === 7 && ev1.length === 7, 'H01 seven events after P01-P07 (the refused P08 wrote none)', [h1.status, h1.body?.totalCount]);
  const times = ev1.map((e) => Date.parse(e.createdAt));
  assert(times.every((t, i) => i === 0 || times[i - 1] >= t) && ev1.every((e) => e.source === 'human'), 'H01 newest first, all from a human', ev1.map((e) => e.createdAt));
  assert(ev1[6].oldStatus === null && ev1[6].oldRole === null && ev1[6].oldNotesSha256 === null && ev1[6].newStatus === 'IN_PROGRESS' && ev1[6].notesChanged === true, 'H01 the oldest event (P01) has no old values', ev1[6]);
  assert(ev1[5].oldStatus === 'IN_PROGRESS' && ev1[5].newStatus === 'MET' && ev1[5].notesChanged === false, 'H02 P02: IN_PROGRESS to MET, notes unchanged', ev1[5]);
  assert(ev1[0].notesChanged === true && ev1[0].newNotesLength === 0 && ev1[0].newNotesSha256 === SHA_EMPTY, 'H02 P07: notes changed, new length 0', ev1[0]);
  assert(ev1[1].actor === 'u_hist_o1' && ev1[1].actorUserId === 'u_hist_o1' && ev1[1].actor !== 'Someone Else', 'H03 the actor of the PUT that sent updatedBy "Someone Else" is the signed-in user', ev1[1]);
  assert(ev1[2].notesChanged === false && ev1[2].oldStatus === 'MET' && ev1[2].newStatus === 'MET', 'H01 the all-null PUT (P05) is recorded as a no-op', ev1[2]);

  const p09 = await put(T1, owner1, SI, { implementationNotes: 'Human.' });
  const p09b = await put(T2, owner2, 'AC.L1-3.1.2', { implementationNotes: 'T2 only.' });
  const t2c = await controlOf(T2, owner2, 'AC.L1-3.1.2');
  const t2ev = await eventsOf(T2, owner2, 'AC.L1-3.1.2');
  assert(p09.status === 200 && p09b.status === 200 && t2c?.status === 'NOT_STARTED' && t2c?.responsibleRole === 'IT / Security Lead' && t2c?.implementationNotes === 'T2 only.', 'P09 notes-only PUT on a control never written: status and role take their defaults', t2c);
  assert(t2ev.length === 1 && t2ev[0].oldStatus === null && t2ev[0].newStatus === 'NOT_STARTED' && t2ev[0].actor === 'u_hist_o2', 'P09 and it records one event with no old status', t2ev);

  console.log('\n--- H04, S01-S04: a snapshot, then an SSP commit ---');
  const snap = await snapshot(T1, owner1);
  const cSnap = await controlOf(T1, owner1, SI);
  const notesSnap = String(cSnap?.implementationNotes);
  assert(snap.status === 201 && cSnap?.status === 'MET', 'a snapshot is taken on T1 (201) and the status stays MET', [snap.status, snap.body]);
  assert(notesSnap.startsWith('Human.') && count(notesSnap, VM_NOTES_BEGIN) === 1 && count(notesSnap, VM_NOTES_END) === 1, 'P10 after the snapshot: one begin marker and the notes start with "Human."', notesSnap);
  const block1 = blockOf(notesSnap);

  const st1 = await stage(owner1, T1, sspLines(), 'CMMC_L1');
  const siItem = st1.items.find((i) => i.controlId === SI) as Json;
  const acItem = st1.items.find((i) => i.controlId === AC) as Json;
  assert(st1.up.status === 202 && st1.job?.status === 'READY_FOR_REVIEW' && Boolean(siItem) && Boolean(acItem), 'S01 setup: the document stages both SI.L1-3.14.1 and AC.L1-3.1.1', [st1.up.status, st1.job?.status, st1.items.map((i) => i.controlId)]);
  await review(owner1, T1, st1.jobId, siItem.id, { reviewState: 'ACCEPTED' });
  await review(owner1, T1, st1.jobId, acItem.id, { reviewState: 'ACCEPTED' });
  const cm1 = await commit(owner1, T1, st1.jobId);
  assert(cm1.status === 200 && cm1.body?.committed?.length === 2 && cm1.body?.conflicts?.length === 0, 'S02 both accepted suggestions commit', cm1.body);
  const siAfter = await controlOf(T1, owner1, SI);
  const acAfter = await controlOf(T1, owner1, AC);
  assert(siAfter?.implementationNotes === `${siItem.suggestedNotes}\n\n${block1}` && count(siAfter?.implementationNotes, VM_NOTES_BEGIN) === 1 && siAfter?.status === 'MET', 'S03 SI.L1-3.14.1 gets the document text, then the snapshot block once; status stays MET', siAfter?.implementationNotes);
  assert(acAfter?.implementationNotes === acItem.suggestedNotes && !String(acAfter?.implementationNotes).includes(VM_NOTES_BEGIN), 'S04 AC.L1-3.1.1 (not a snapshot control) gets exactly the document text', acAfter?.implementationNotes);

  const ev4 = await eventsOf(T1, owner1, SI);
  assert(same(ev4.slice(0, 3).map((e) => e.source), ['ssp-commit', 'vm-snapshot', 'human']), 'H04 the SI history starts ssp-commit, vm-snapshot, human', ev4.slice(0, 3).map((e) => e.source));
  const snapEv = ev4[1];
  assert(
    snapEv.oldStatus === 'MET' && snapEv.newStatus === 'MET' && snapEv.notesChanged === true && ((snapEv.actor === 'system:vm-snapshot' && snapEv.actorUserId === null) || (snapEv.actor === 'u_hist_o1' && snapEv.actorUserId === 'u_hist_o1')),
    'H04 the snapshot event: status MET to MET, notes changed, actor the system or the user who triggered it',
    snapEv,
  );
  assert(ev4[0].actor === 'u_hist_o1' && ev4[0].actorUserId === 'u_hist_o1' && ev4[0].oldStatus === ev4[0].newStatus && ev4[0].notesChanged === true, 'H04 the ssp-commit event names the reviewer; the status is unchanged', ev4[0]);

  console.log('\n--- S05-S06: a tenant never snapshotted ---');
  const t3seed = await controlsOf(T3, owner3);
  const st3 = await stage(owner3, T3, sspLines(), 'CMMC_L1');
  const si3 = st3.items.find((i) => i.controlId === SI) as Json;
  assert(t3seed.length === 17 && Boolean(si3), 'S05 setup: T3 has its seeded controls and the document stages SI.L1-3.14.1', [t3seed.length, st3.items.map((i) => i.controlId)]);
  await review(owner3, T3, st3.jobId, si3.id, { reviewState: 'ACCEPTED' });
  const cm3 = await commit(owner3, T3, st3.jobId);
  const si3c = await controlOf(T3, owner3, SI);
  assert(cm3.body?.committed?.length === 1 && si3c?.implementationNotes === si3.suggestedNotes && !String(si3c?.implementationNotes).includes(VM_NOTES_BEGIN), 'S05 no snapshot: the notes are exactly the document text, no block', si3c?.implementationNotes);

  const st3b = await stage(owner3, T3, sspLines(' (second)'), 'CMMC_L1');
  const si3b = st3b.items.find((i) => i.controlId === SI) as Json;
  await review(owner3, T3, st3b.jobId, si3b.id, { reviewState: 'EDITED', editedNotes: `Text\n\n${VM_NOTES_BEGIN}\nforged\n${VM_NOTES_END}` });
  const cm3b = await commit(owner3, T3, st3b.jobId);
  const si3d = await controlOf(T3, owner3, SI);
  assert(cm3b.body?.committed?.length === 1 && si3d?.implementationNotes === 'Text', 'S06 a block forged in the edited notes is stripped', [cm3b.body, si3d?.implementationNotes]);

  console.log('\n--- S07: staged, then a snapshot ---');
  const st7 = await stage(owner1, T1, sspLines(' (third)'), 'CMMC_L1');
  const si7 = st7.items.find((i) => i.controlId === SI) as Json;
  const ac7 = st7.items.find((i) => i.controlId === AC) as Json;
  assert(Boolean(si7) && Boolean(ac7), 'S07 setup: both controls staged again', st7.items.map((i) => i.controlId));
  await review(owner1, T1, st7.jobId, si7.id, { reviewState: 'ACCEPTED' });
  await review(owner1, T1, st7.jobId, ac7.id, { reviewState: 'ACCEPTED' });
  const snap2 = await snapshot(T1, owner1);
  const sscBefore = (await eventsOf(T1, owner1, SI)).filter((e) => e.source === 'ssp-commit').length;
  const cm7 = await commit(owner1, T1, st7.jobId);
  const sscAfterConflict = (await eventsOf(T1, owner1, SI)).filter((e) => e.source === 'ssp-commit').length;
  assert(snap2.status === 201 && cm7.status === 200 && cm7.body?.conflicts?.length === 1 && cm7.body.conflicts[0] === si7.id, 'S07 the snapshot changed SI after staging: one conflict, nothing overwritten', [snap2.status, cm7.body]);
  assert(sscAfterConflict === sscBefore, 'H11 the conflicting commit added no ssp-commit event to SI', [sscBefore, sscAfterConflict]);
  const block2 = blockOf(String((await controlOf(T1, owner1, SI))?.implementationNotes));
  await review(owner1, T1, st7.jobId, si7.id, { reviewState: 'EDITED', editedNotes: 'Re-reviewed.' });
  const cm7b = await commit(owner1, T1, st7.jobId);
  const si7c = await controlOf(T1, owner1, SI);
  assert(cm7b.body?.committed?.length === 1 && Boolean(block2) && si7c?.implementationNotes === `Re-reviewed.\n\n${block2}` && count(si7c?.implementationNotes, VM_NOTES_BEGIN) === 1, 'S07 re-reviewed, it commits: the new text, then the one current block', si7c?.implementationNotes);

  console.log('\n--- S08-S09: Level 2 and the program ---');
  const snap4 = await snapshot(T4, admin);
  const st8 = await stage(admin, T4, sspLines(), 'CMMC_L1');
  const si8 = st8.items.find((i) => i.controlId === SI) as Json;
  assert(snap4.status === 201 && Boolean(si8), 'S08 setup: a Level 2 tenant has a snapshot and stages SI.L1-3.14.1 against CMMC_L1', [snap4.status, st8.up.status, st8.items.map((i) => i.controlId)]);
  const before8 = blockOf(String((await controlOf(T4, admin, SI, 'CMMC_L2'))?.implementationNotes));
  await review(admin, T4, st8.jobId, si8.id, { reviewState: 'ACCEPTED' });
  const cm8 = await commit(admin, T4, st8.jobId);
  const after8 = String((await controlOf(T4, admin, SI, 'CMMC_L2'))?.implementationNotes);
  assert(cm8.body?.committed?.length === 1 && Boolean(before8) && after8 === `${si8.suggestedNotes}\n\n${before8}`, 'S08 a Level 2 tenant committing against CMMC_L1 keeps the block', after8);
  const up9 = await upload(owner1, T1, await makeDocx(sspLines()), 'CMMC_L2');
  assert(up9.status === 403 && up9.body?.code === 'framework_not_enabled', 'S09 a Level 1 tenant uploading against CMMC_L2 -> 403 framework_not_enabled', up9);

  console.log('\n--- H05-H10: reading the history ---');
  const all = await eventsOf(T1, owner1, SI);
  assert(all.length >= 10 && all.length < 50, 'H05 setup: the SI history holds more than a few events', all.length);
  const l1 = (await history(T1, owner1, SI, '?limit=1')).body;
  const lAbc = (await history(T1, owner1, SI, '?limit=abc')).body;
  const l0 = (await history(T1, owner1, SI, '?limit=0')).body;
  assert(l1?.events?.length === 1 && l1.events[0].id === all[0].id && lAbc?.events?.length === all.length && l0?.events?.length === 1, 'H05 limit 1 gives one event; abc falls back to the default; 0 is clamped to 1', [l1?.events?.length, lAbc?.events?.length, l0?.events?.length]);

  const vGet = await history(T1, viewer, SI);
  const vPut = await put(T1, viewer, SI, { status: 'NOT_MET' });
  assert(vGet.status === 200 && vGet.body?.events?.length === all.length && vPut.status === 403, 'H06 a VIEWER reads the history (200) but cannot PUT (403)', [vGet.status, vPut.status]);

  const iso = await history(T2, owner2, SI);
  const cross = await history(T1, owner2, SI);
  assert(iso.status === 200 && same(iso.body?.events, []) && cross.status === 403, 'H07 tenant T2 sees none of T1\'s SI history (200 []); asking for T1 as a T2 owner -> 403', [iso.status, cross.status]);

  const seeded = await controlsOf(T3, owner3);
  const seedHist = await history(T3, owner3, 'IA.L1-3.5.1');
  assert(seeded.some((c) => c.id === 'IA.L1-3.5.1') && seedHist.status === 200 && same(seedHist.body?.events, []), 'H08 a seeded control has no history', seedHist.body);

  const ra = await history(T1, owner1, 'RA.L2-3.11.2');
  assert(ra.status === 403 && ra.body?.code === 'framework_not_enabled', 'H09 the history of a Level 2 control on a Level 1 tenant -> 403 framework_not_enabled', ra.body);

  const raw = (await history(T1, owner1, SI)).text;
  assert(!raw.includes('Human notes') && !raw.includes('Changed text') && !raw.includes('Re-reviewed') && !raw.includes('Flaws are identified') && !raw.includes(VM_NOTES_BEGIN), 'H10 the response carries no notes text', raw.slice(0, 200));

  console.log('\n--- H12: the history belongs to a program ---');
  const PE = 'PE.L1-3.10.1';
  const progB = await call('POST', `/tenants/${T1}/programs`, owner1, T1, { name: 'History Boundary B', frameworkId: 'CMMC_L1' });
  const B = progB.body?.program?.id as string;
  const putIn = (program: string | undefined, notes: string) => call('PUT', `/controls/${PE}`, owner1, T1, { implementationNotes: notes }, program);
  const eventsIn = async (program: string | undefined) => ((await call('GET', `/controls/${PE}/history`, owner1, T1, undefined, program)).body?.events ?? []) as Json[];
  assert(progB.status === 201 && Boolean(B), 'H12 setup: a second program B in T1', progB.body);
  const putA = await putIn(undefined, 'Written in the default program.');
  const inA = await eventsIn(undefined);
  const inB = await eventsIn(B);
  assert(putA.status === 200 && inA.length === 1 && inB.length === 0, 'H12 an event written in the default program A is absent from B\'s history', [putA.status, inA.length, inB.length]);
  const putB = await putIn(B, 'Written in program B.');
  const inA2 = await eventsIn(undefined);
  const inB2 = await eventsIn(B);
  assert(putB.status === 200 && inA2.length === 1 && inB2.length === 1 && inB2[0].oldStatus === null && inA2[0].id !== inB2[0].id, 'H12 a write in B records its own first event (no old values) and adds none to A', [inA2.length, inB2.length, inB2[0]]);
  assert(!(await call('GET', `/controls/${PE}/history`, owner1, T1, undefined, B)).text.includes('Written in'), 'H12 and the history of B carries no notes text either');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
