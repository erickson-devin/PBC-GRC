import './testEnv';
import { createHash } from 'node:crypto';
import { server } from '../server/index';
import { readObjectives } from '../server/controlObjectives';

/**
 * Assessment objectives over HTTP (800-171A / 800-53A objective records: status, narrative, evidence links), program-scoped: the read and
 * write endpoints, the role and archive rules, the no-oracle 404 for another tenant's program, validation, the history (a SHA-256 and a
 * length, never the narrative text), keep-semantics and no-op writes, the all-or-nothing bulk, the insert-only browser import, the delete
 * and the clone of a program. Runs against the in-memory store. Boots the server on port 8080: run it alone.
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

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const CTRL = 'AC.L2-3.1.3';
const OBJ = 'AC.L2-3.1.3[a]';
const enc = encodeURIComponent;

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_ob_admin@test.mil';
  const owner = person('u_ob_admin'); // a platform administrator, and the TENANT_OWNER of both tenants they create
  const viewer = person('u_ob_viewer');

  console.log('--- Setup: two tenants licensed for CMMC Level 2 and NIST SP 800-53 ---');
  const mk = async (name: string) =>
    (await call('POST', '/tenants', owner, undefined, { name, primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const T = await mk('Objectives T');
  const T2 = await mk('Objectives T2');
  assert(Boolean(T) && Boolean(T2) && T !== T2, 'two tenants created', { T, T2 });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ob_viewer', email: 'u_ob_viewer@test.mil', role: 'VIEWER' });
  const newProgram = async (tenant: string, name: string, body: Json = {}) => {
    const r = await call('POST', `/tenants/${tenant}/programs`, owner, tenant, { name, frameworkId: 'CMMC_L2', ...body });
    return { id: r.body?.program?.id as string, status: r.status, body: r.body };
  };
  const A = (await newProgram(T, 'Obj A')).id;
  const B = (await newProgram(T, 'Obj B')).id;
  const list = async (program: string, query = '', who = owner, tenant = T) => call('GET', `/objectives${query}`, who, tenant, undefined, program);
  const put = (program: string, objectiveId: string, body: Json, who = owner, tenant = T) => call('PUT', `/objectives/${enc(objectiveId)}`, who, tenant, body, program);
  const history = async (program: string, objectiveId: string) => ((await call('GET', `/objectives/${enc(objectiveId)}/history`, owner, T, undefined, program)).body?.events ?? []) as Json[];
  const find = (r: { body: Json | null }, objectiveId: string) => ((r.body?.objectives ?? []) as Json[]).find((o) => o.objectiveId === objectiveId);

  console.log('\n--- 1-4: scoping, roles, archive ---');
  const p1 = await put(A, OBJ, { controlId: CTRL, narrative: 'X', status: 'MET' });
  const inA = find(await list(A), OBJ);
  const inB = find(await list(B), OBJ);
  assert(p1.status === 200 && p1.body?.objective?.narrative === 'X' && p1.body.objective.status === 'MET', '1 PUT an objective in program A -> 200 with the stored record', p1.body);
  assert(inA?.narrative === 'X' && inA?.status === 'MET' && inA?.controlId === CTRL && Array.isArray(inA?.linkedEvidenceIds) && inA?.linkedEvidenceIds.length === 0 && typeof inA?.updatedAt === 'string' && inB === undefined, '1 it is listed in A (record shape) and absent from B', [inA, inB]);
  const byControl = await list(A, `?controlId=${CTRL}`);
  const byOther = await list(A, '?controlId=AC.L2-3.1.4');
  assert((byControl.body?.objectives ?? []).length === 1 && (byOther.body?.objectives ?? []).length === 0, '1 GET ?controlId= filters by control');

  const foreignGet = await call('GET', '/objectives', owner, T2, undefined, A);
  const foreignPut = await call('PUT', `/objectives/${enc(OBJ)}`, owner, T2, { controlId: CTRL, narrative: 'Intruder' }, A);
  assert(foreignGet.status === 404 && foreignGet.body?.code === 'program_not_found' && foreignPut.status === 404 && foreignPut.body?.code === 'program_not_found', '2 another tenant\'s token with program A\'s id -> 404 program_not_found (read and write)', [foreignGet.body, foreignPut.body]);
  assert(find(await list(A), OBJ)?.narrative === 'X', '2 and A\'s record is unchanged');

  const viewerPut = await put(A, OBJ, { controlId: CTRL, narrative: 'V' }, viewer);
  const viewerGet = await list(A, '', viewer);
  const viewerImport = await call('POST', '/objectives/import', viewer, T, { objectives: [{ objectiveId: 'AC.L2-3.1.4[a]', controlId: 'AC.L2-3.1.4' }] }, A);
  assert(viewerPut.status === 403 && viewerImport.status === 403 && viewerGet.status === 200 && find(viewerGet, OBJ)?.narrative === 'X', '3 a VIEWER: PUT and import -> 403, GET -> 200', [viewerPut.status, viewerImport.status, viewerGet.status]);

  const ARCH = (await newProgram(T, 'Obj Archived')).id;
  await put(ARCH, OBJ, { controlId: CTRL, narrative: 'Kept' });
  await call('POST', `/tenants/${T}/programs/${ARCH}/archive`, owner, T);
  const archPut = await put(ARCH, OBJ, { controlId: CTRL, narrative: 'More' });
  const archGet = await list(ARCH);
  assert(archPut.status === 409 && archPut.body?.code === 'program_archived' && archGet.status === 200 && find(archGet, OBJ)?.narrative === 'Kept', '4 an archived program: PUT -> 409 program_archived, GET -> 200 with the data', [archPut.body, archGet.status]);

  console.log('\n--- 5: validation ---');
  const P5 = (await newProgram(T, 'Obj Validation')).id;
  const badStatus = await put(P5, OBJ, { controlId: CTRL, status: 'DONE' });
  const noLetter = await put(P5, CTRL, { controlId: CTRL, narrative: 'x' });
  const mismatch = await put(P5, OBJ, { controlId: 'AC.L2-3.1.4', narrative: 'x' });
  const tooLong = await put(P5, OBJ, { controlId: CTRL, narrative: 'a'.repeat(20001) });
  const badEvidence = await put(P5, OBJ, { controlId: CTRL, linkedEvidenceIds: ['has space'] });
  const tooMany = await put(P5, OBJ, { controlId: CTRL, linkedEvidenceIds: Array.from({ length: 51 }, (_, i) => `e${i}`) });
  assert(badStatus.status === 400 && /status/.test(String(badStatus.body?.error)), '5 status DONE -> 400', badStatus.body);
  assert(noLetter.status === 400 && mismatch.status === 400, '5 an id without the [letter] part, and a controlId that does not match -> 400', [noLetter.body, mismatch.body]);
  assert(tooLong.status === 400 && !JSON.stringify(tooLong.body).includes('aaaa'), '5 a 20001-character narrative -> 400, and the text is not echoed', tooLong.body);
  assert(badEvidence.status === 400 && tooMany.status === 400, '5 an invalid evidence id, and more than 50 evidence links -> 400', [badEvidence.body, tooMany.body]);
  const maxOk = await put(P5, OBJ, { controlId: CTRL, narrative: 'a'.repeat(20000) });
  assert(maxOk.status === 200 && (await list(P5)).body?.objectives.length === 1, '5 a 20000-character narrative is accepted, and none of the refused writes stored a row');

  console.log('\n--- 6-8, 13: history, no-op writes, keep-semantics, actor ---');
  const events1 = await history(A, OBJ);
  const historyResponse = await call('GET', `/objectives/${enc(OBJ)}/history`, owner, T, undefined, A);
  assert(events1.length === 1 && events1[0].newNarrativeSha256 === sha('X') && events1[0].newNarrativeLength === 1 && events1[0].oldNarrativeSha256 === null && events1[0].newStatus === 'MET' && events1[0].source === 'human', '6 one event: the SHA-256 and length of the narrative, source human', events1);
  assert(!JSON.stringify(historyResponse.body).includes('X'), '6 the serialized history response never contains the narrative text', historyResponse.body);
  const secret = 'Top secret CUI narrative';
  await put(A, 'AC.L2-3.1.4[a]', { controlId: 'AC.L2-3.1.4', narrative: secret });
  const secretHistory = await call('GET', `/objectives/${enc('AC.L2-3.1.4[a]')}/history`, owner, T, undefined, A);
  assert(secretHistory.status === 200 && !JSON.stringify(secretHistory.body).includes('secret') && secretHistory.body?.events[0].newNarrativeLength === secret.length, '6 a longer narrative is not in the history either (length only)');

  const again = await put(A, OBJ, { controlId: CTRL, narrative: 'X', status: 'MET' });
  assert(again.status === 200 && again.body?.changed === false && (await history(A, OBJ)).length === 1, '7 an identical re-PUT -> 200 and no new event', again.body);

  const keepStatus = await put(A, OBJ, { controlId: CTRL, status: 'NOT_MET' });
  const kept = find(await list(A), OBJ);
  assert(keepStatus.status === 200 && kept?.status === 'NOT_MET' && kept?.narrative === 'X', '8 PUT {status} alone keeps the narrative', kept);
  const ev8 = await history(A, OBJ);
  assert(ev8.length === 2 && ev8[0].narrativeChanged === false && ev8[0].oldStatus === 'MET' && ev8[0].newStatus === 'NOT_MET', '8 and the event records the status change with narrativeChanged false', ev8[0]);
  const cleared = await put(A, OBJ, { controlId: CTRL, narrative: '' });
  assert(cleared.status === 200 && find(await list(A), OBJ)?.narrative === '' && find(await list(A), OBJ)?.status === 'NOT_MET', '8 an empty narrative clears it (the status is kept)');
  const withEvidence = await put(A, OBJ, { controlId: CTRL, linkedEvidenceIds: ['ev_1', 'ev_2', 'ev_1'] });
  const keepEvidence = await put(A, OBJ, { controlId: CTRL, status: 'MET' });
  const evidenceNow = find(await list(A), OBJ);
  assert(withEvidence.status === 200 && keepEvidence.status === 200 && evidenceNow?.linkedEvidenceIds.length === 2 && evidenceNow.linkedEvidenceIds.includes('ev_1') && evidenceNow.linkedEvidenceIds.includes('ev_2'), '8 evidence links are stored (deduplicated) and kept when a PUT leaves them out', evidenceNow);

  const P13 = (await newProgram(T, 'Obj Actor')).id;
  await put(P13, OBJ, { controlId: CTRL, narrative: 'Y', actor: 'Mallory', updatedBy: 'Mallory', actorUserId: 'mallory', source: 'clone' });
  const ev13 = await history(P13, OBJ);
  assert(ev13.length === 1 && ev13[0].actor === 'u_ob_admin' && ev13[0].actorUserId === 'u_ob_admin' && ev13[0].source === 'human' && find(await list(P13), OBJ)?.updatedBy === 'u_ob_admin', '13 the actor, user id and source come from the token, never the body', ev13);

  console.log('\n--- 9: bulk ---');
  const P9 = (await newProgram(T, 'Obj Bulk')).id;
  const five = ['a', 'b', 'c', 'd', 'e'].map((l) => ({ objectiveId: `AC.L2-3.1.1[${l}]`, controlId: 'AC.L2-3.1.1', narrative: `Bulk ${l}`, status: 'IN_PROGRESS' }));
  const bulk = await call('PUT', '/objectives', owner, T, { objectives: five }, P9);
  const bulkList = (await list(P9)).body?.objectives ?? [];
  let bulkEvents = 0;
  for (const o of five) bulkEvents += (await history(P9, o.objectiveId)).length;
  assert(bulk.status === 200 && bulk.body?.total === 5 && bulk.body?.changed === 5 && bulkList.length === 5 && bulkEvents === 5, '9 a bulk of 5 -> 5 rows and 5 events', [bulk.body, bulkList.length, bulkEvents]);
  const P9b = (await newProgram(T, 'Obj Bulk Invalid')).id;
  const bad = [...five.slice(0, 2), { objectiveId: 'AC.L2-3.1.1[f]', controlId: 'AC.L2-3.1.1', status: 'DONE' }, five[3]];
  const bulkBad = await call('PUT', '/objectives', owner, T, { objectives: bad }, P9b);
  assert(bulkBad.status === 400 && /objectives\[2\]/.test(String(bulkBad.body?.error)) && ((await list(P9b)).body?.objectives ?? []).length === 0, '9 a bulk with one invalid item -> 400 naming the item, and 0 rows are written', bulkBad.body);
  const bulkEmpty = await call('PUT', '/objectives', owner, T, { objectives: [] }, P9b);
  const bulkMany = await call('PUT', '/objectives', owner, T, { objectives: Array.from({ length: 501 }, (_, i) => ({ objectiveId: `AC.L2-3.1.1[n${i}]`, controlId: 'AC.L2-3.1.1' })) }, P9b);
  assert(bulkEmpty.status === 400 && bulkMany.status === 400 && ((await list(P9b)).body?.objectives ?? []).length === 0, '9 an empty bulk and a bulk of 501 -> 400');

  console.log('\n--- 10: browser import ---');
  const P10 = (await newProgram(T, 'Obj Import')).id;
  const imp = ['a', 'b', 'c'].map((l) => ({ objectiveId: `AC.L2-3.1.2[${l}]`, controlId: 'AC.L2-3.1.2', narrative: `Local ${l}`, status: 'MET' }));
  const imp1 = await call('POST', '/objectives/import', owner, T, { objectives: imp }, P10);
  assert(imp1.status === 200 && imp1.body?.results.length === 3 && imp1.body.results.every((r: Json, i: number) => r.result === 'created' && r.objectiveId === imp[i].objectiveId), '10 import into an empty program: every id is created', imp1.body);
  const impEvents = await history(P10, imp[0].objectiveId);
  assert(impEvents.length === 1 && impEvents[0].source === 'browser-import' && impEvents[0].newNarrativeSha256 === sha('Local a'), '10 and each creation records a browser-import event', impEvents);
  const imp2 = await call('POST', '/objectives/import', owner, T, { objectives: imp }, P10);
  assert(imp2.status === 200 && imp2.body?.results.every((r: Json) => r.result === 'unchanged') && (await history(P10, imp[0].objectiveId)).length === 1, '10 the same import again: every id is unchanged, no new event', imp2.body);
  const imp3 = await call('POST', '/objectives/import', owner, T, { objectives: [{ ...imp[0], narrative: 'Different local text' }, { objectiveId: 'AC.L2-3.1.2[d]', controlId: 'AC.L2-3.1.2', narrative: 'New' }] }, P10);
  const afterImp = await list(P10);
  assert(imp3.body?.results[0].result === 'conflict' && imp3.body?.results[1].result === 'created', '10 different text for an existing id is a conflict, a new id is created in the same request', imp3.body);
  assert(find(afterImp, imp[0].objectiveId)?.narrative === 'Local a' && (await history(P10, imp[0].objectiveId)).length === 1, '10 and the server\'s text is unchanged, with no event for the conflict');
  const impBadStatus = await call('POST', '/objectives/import', owner, T, { objectives: [{ ...imp[1], status: 'DONE' }] }, P10);
  assert(impBadStatus.status === 400, '10 an invalid item in an import -> 400');

  console.log('\n--- 11: deleting a program ---');
  const P11 = (await newProgram(T, 'Obj Delete')).id;
  await put(P11, OBJ, { controlId: CTRL, narrative: 'Gone' });
  assert((await readObjectives({ tenantId: T, programId: P11 })).length === 1, '11 the program holds an objective');
  const del = await call('DELETE', `/tenants/${T}/programs/${P11}`, owner, T);
  assert(del.status === 204 && (await readObjectives({ tenantId: T, programId: P11 })).length === 0, '11 deleting the program removes its objectives', del.status);
  assert((await readObjectives({ tenantId: '', programId: P11 })).length === 0 && (await readObjectives({ tenantId: T, programId: '' })).length === 0, '11 a scope without a tenant or a program reads nothing (memory mode fails closed)');

  console.log('\n--- 12: NIST SP 800-53 ---');
  const NIST = (await newProgram(T, 'Obj NIST', { frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE' })).id;
  const nistPut = await put(NIST, 'AC-2[a01]', { controlId: 'AC-2', narrative: 'Accounts are managed.', status: 'IN_PROGRESS' });
  assert(nistPut.status === 200 && find(await list(NIST), 'AC-2[a01]')?.narrative === 'Accounts are managed.' && find(await list(A), 'AC-2[a01]') === undefined, '12 a NIST SP 800-53 program takes AC-2[a01] (and A does not see it)', nistPut.body);

  console.log('\n--- 14: cloning a program ---');
  const CL_SRC = (await newProgram(T, 'Obj Clone Source')).id;
  await put(CL_SRC, OBJ, { controlId: CTRL, narrative: 'Cloned narrative', status: 'MET', linkedEvidenceIds: ['ev_clone'] });
  await put(CL_SRC, 'AC.L2-3.1.4[a]', { controlId: 'AC.L2-3.1.4', status: 'MET' }); // no narrative: nothing to copy
  const clone = await newProgram(T, 'Obj Clone', { seed: { cloneFrom: CL_SRC } });
  const cloned = find(await list(clone.id), OBJ);
  assert(clone.status === 201 && cloned?.narrative === 'Cloned narrative' && cloned?.status === 'NOT_STARTED' && cloned?.linkedEvidenceIds.length === 0, '14 a clone of the same framework copies the narrative with the status NOT_STARTED and no evidence links', [clone.body, cloned]);
  assert(find(await list(clone.id), 'AC.L2-3.1.4[a]') === undefined, '14 an objective with no narrative is not copied');
  const cloneEvents = await history(clone.id, OBJ);
  assert(cloneEvents.length === 1 && cloneEvents[0].source === 'clone' && cloneEvents[0].actorUserId === 'u_ob_admin' && cloneEvents[0].newNarrativeSha256 === sha('Cloned narrative') && cloneEvents[0].newStatus === 'NOT_STARTED', '14 the copied row records one clone event under the requesting user', cloneEvents);
  const source = find(await list(CL_SRC), OBJ);
  assert(source?.status === 'MET' && source?.narrative === 'Cloned narrative' && source?.linkedEvidenceIds[0] === 'ev_clone', '14 and cloning left the source untouched');
  const otherFw = await newProgram(T, 'Obj Clone NIST', { frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', seed: { cloneFrom: CL_SRC } });
  assert(otherFw.status === 201 && ((await list(otherFw.id)).body?.objectives ?? []).length === 0, '14 a clone into another framework copies no objectives', otherFw.body);

  console.log('\n--- 15: version check (expectedUpdatedAt) ---');
  const P15 = (await newProgram(T, 'Obj Version')).id;
  const o1r = await put(P15, OBJ, { controlId: CTRL, narrative: 'N1' });
  const o1 = o1r.body?.objective?.updatedAt as string;
  assert(o1r.status === 200 && typeof o1 === 'string' && !Number.isNaN(Date.parse(o1)), 'S70-O1 the PUT response carries the stored updatedAt (a string, no longer null)', o1r.body);
  const o2r = await put(P15, OBJ, { controlId: CTRL, narrative: 'N2', expectedUpdatedAt: o1 });
  const o2 = o2r.body?.objective?.updatedAt as string;
  assert(o2r.status === 200 && Date.parse(o2) > Date.parse(o1), 'S70-O2 a PUT with the loaded updatedAt succeeds and the new updatedAt is later', [o1, o2r.body]);
  const o3r = await put(P15, OBJ, { controlId: CTRL, narrative: 'N3', expectedUpdatedAt: o1 });
  assert(
    o3r.status === 409 && o3r.body?.code === 'stale_write' && o3r.body?.current?.updatedAt === o2 && find(await list(P15), OBJ)?.narrative === 'N2' && (await history(P15, OBJ)).length === 2 && !JSON.stringify(o3r.body).includes('N2') && !JSON.stringify(o3r.body).includes('N3'),
    'S70-O3 a stale updatedAt -> 409 stale_write naming the stored stamp; the narrative and the history are unchanged and the body carries no text',
    o3r.body,
  );
  const o4r = await put(P15, OBJ, { controlId: CTRL, narrative: 'N2', expectedUpdatedAt: o1 });
  assert(o4r.status === 200 && o4r.body?.changed === false, 'S70-O4 a stale updatedAt on a write that changes nothing is still 200 changed:false', o4r.body);
  const NEWOBJ = 'AC.L2-3.1.4[a]';
  const o5a = await put(P15, NEWOBJ, { controlId: 'AC.L2-3.1.4', narrative: 'First', expectedUpdatedAt: null });
  const o5b = await put(P15, NEWOBJ, { controlId: 'AC.L2-3.1.4', narrative: 'Second', expectedUpdatedAt: null });
  assert(o5a.status === 200 && o5b.status === 409 && o5b.body?.code === 'stale_write', 'S70-O5 expectedUpdatedAt null on an objective never written -> 200 the first time, 409 the second', [o5a.status, o5b.status]);
  const o6r = await put(P15, OBJ, { controlId: CTRL, narrative: 'N6', expectedUpdatedAt: 'x' });
  assert(o6r.status === 400 && o6r.body?.error === 'expectedUpdatedAt must be a timestamp or null' && find(await list(P15), OBJ)?.narrative === 'N2', 'S70-O6 a value that is not a timestamp or null -> 400; nothing is written', o6r.body);
  const o7r = await call('PUT', '/objectives', owner, T, { objectives: [{ objectiveId: OBJ, controlId: CTRL, narrative: 'N7', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }] }, P15);
  assert(o7r.status === 200 && o7r.body?.changed === 1 && find(await list(P15), OBJ)?.narrative === 'N7', 'S70-O7 the bulk PUT ignores expectedUpdatedAt (no version check)', o7r.body);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
