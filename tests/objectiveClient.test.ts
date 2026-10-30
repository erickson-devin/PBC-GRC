import fs from 'fs';
import path from 'path';

// Browser storage stub: StorageService reads localStorage at call time (installed before any save below)
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  configurable: true,
  writable: true,
});

import { ApiClient, ApiError } from '../src/services/apiClient';
import { coalesceSaveFailure, controlSaveFailureMessage, isStaleWriteError, revertFailedControlFields, staleWriteMessage } from '../src/data/controlSave';
import {
  applyImportResult,
  cascadeFill,
  chunkItems,
  mergeServerObjectives,
  objectivesToUpload,
  pruneResolvedReviews,
  reconcileObjectives,
  registryLettersForControl,
  resolveConflict,
  stackCascadeFill,
} from '../src/data/objectiveSync';
import { StorageService } from '../src/services/storageService';
import type { AssessmentState, ControlState } from '../src/types/cmmc';
import type { AssessmentObjective } from '../src/types/assessment';
import type { ObjectiveRecord } from '../src/types/controlObjectives';
import type { EnclaveStackProfile } from '../src/types/tenant';

/**
 * Client side of the server-held objectives: what is uploaded, what the import result does to the cache, how the server's records are
 * merged (and when), the conflict choices, the stack cascade, the apiClient methods against a stubbed fetch, and static checks on the
 * contexts. Pure test: no server, no browser.
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

const NOW = '2026-10-28T12:00:00.000Z';
const CACHED = 'CACHED-NARRATIVE-TEXT';
const SERVER = 'SERVER-NARRATIVE-TEXT';

const objective = (id: string, over: Partial<AssessmentObjective> = {}): AssessmentObjective => {
  const m = /^(.+)\[([a-z0-9]+)\]$/.exec(id)!;
  return {
    id,
    controlId: m[1],
    letter: m[2],
    text: 'determination',
    status: 'NOT_STARTED',
    prefilledTemplate: 'template',
    implementationNarrative: '',
    linkedEvidenceIds: [],
    isAutoVerifiedByTelemetry: false,
    ...over,
  };
};
const record = (id: string, over: Partial<ObjectiveRecord> = {}): ObjectiveRecord => ({
  objectiveId: id,
  controlId: /^(.+)\[/.exec(id)![1],
  status: 'NOT_STARTED',
  narrative: '',
  linkedEvidenceIds: [],
  updatedBy: 'Server User',
  updatedAt: NOW,
  ...over,
});
const stateWith = (objectives: Record<string, AssessmentObjective>, over: Partial<AssessmentState> = {}): AssessmentState => ({
  version: '2.0.0',
  tenantId: 't1',
  sspMetadata: { tenantId: 't1' } as AssessmentState['sspMetadata'],
  controls: {},
  evidenceIndex: [],
  lastSaved: 'x',
  objectives,
  ...over,
});

console.log('\n--- Upload selection ---');
{
  const sel = objectivesToUpload({
    'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]'),
    'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { implementationNarrative: '   ' }),
    'AC.L2-3.1.1[c]': objective('AC.L2-3.1.1[c]', { implementationNarrative: CACHED }),
    'AC.L2-3.1.1[d]': objective('AC.L2-3.1.1[d]', { status: 'MET' }),
    'AC.L2-3.1.1[e]': objective('AC.L2-3.1.1[e]', { linkedEvidenceIds: ['ev-1'] }),
  });
  const ids = sel.items.map((i) => i.objectiveId);
  assert(JSON.stringify(ids) === JSON.stringify(['AC.L2-3.1.1[c]', 'AC.L2-3.1.1[d]', 'AC.L2-3.1.1[e]']), 'U1 untouched NOT_STARTED entries (empty or blank narrative) are not uploaded; a narrative, a status or evidence is', ids);
  const c = sel.items[0];
  assert(c.controlId === 'AC.L2-3.1.1' && c.status === 'NOT_STARTED' && c.narrative === CACHED && Array.isArray(c.linkedEvidenceIds), 'U2 an item carries the control id, status, narrative and evidence links');

  const orphan = objectivesToUpload(
    { '3.1.1[a]': objective('3.1.1[a]', { implementationNarrative: CACHED }), 'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { implementationNarrative: CACHED }) },
    (controlId) => controlId.startsWith('AC.')
  );
  assert(orphan.items.length === 1 && orphan.skipped === 1 && orphan.unsendable.length === 0, 'U3 an entry of a control no framework knows (an orphaned cascade key) is dropped, not uploaded', orphan);

  const tooLong = objectivesToUpload({ 'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { implementationNarrative: 'x'.repeat(20001) }), 'bad id': objective('AC.L2-3.1.1[b]', { implementationNarrative: CACHED }) });
  assert(tooLong.items.length === 0 && tooLong.unsendable.length === 2, 'U4 a narrative the server would refuse (too long, malformed id) is never sent and is put under review instead of being lost', tooLong);
  assert(objectivesToUpload(undefined).items.length === 0 && chunkItems([1, 2, 3, 4, 5], 2).length === 3 && chunkItems([], 2).length === 0, 'U5 no objectives, nothing to upload; chunkItems splits by size');
}

console.log('\n--- Import result ---');
{
  const state = stateWith({
    'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { implementationNarrative: CACHED, status: 'MET' }),
    'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { implementationNarrative: CACHED }),
    'AC.L2-3.1.1[c]': objective('AC.L2-3.1.1[c]', { implementationNarrative: CACHED }),
  });
  const frozen = JSON.stringify(state);
  const next = applyImportResult(
    state,
    [
      { objectiveId: 'AC.L2-3.1.1[a]', result: 'created' },
      { objectiveId: 'AC.L2-3.1.1[b]', result: 'unchanged' },
      { objectiveId: 'AC.L2-3.1.1[c]', result: 'conflict' },
    ],
    NOW
  );
  assert(next.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === '' && next.objectives!['AC.L2-3.1.1[b]'].implementationNarrative === '', 'I1 created and unchanged ids lose their cached narrative');
  assert(next.objectives!['AC.L2-3.1.1[a]'].status === 'MET', 'I2 the status stays in the cache (offline reading)');
  assert(next.objectives!['AC.L2-3.1.1[c]'].implementationNarrative === CACHED && JSON.stringify(next.objectivesPendingReview) === JSON.stringify(['AC.L2-3.1.1[c]']), 'I3 a conflict keeps its cached narrative and goes under review');
  assert(next.objectivesMigratedAt === NOW, 'I4 the marker is set (even with conflicts)');
  assert(JSON.stringify(state) === frozen, 'I5 the input state is not mutated');
  const withUnsendable = applyImportResult(state, [], NOW, ['AC.L2-3.1.1[b]']);
  assert(JSON.stringify(withUnsendable.objectivesPendingReview) === JSON.stringify(['AC.L2-3.1.1[b]']) && withUnsendable.objectives!['AC.L2-3.1.1[b]'].implementationNarrative === CACHED, 'I6 an unsendable id keeps its narrative and goes under review');

  // Saved through the real cache writer: the marker is what makes the cache drop narratives
  StorageService.saveAssessment('t1', next);
  const saved = store.get('pbc_cmmc_assessment_v3_t1') ?? '';
  const parsed = JSON.parse(saved) as AssessmentState;
  assert(saved.split(CACHED).length === 2 && parsed.objectives!['AC.L2-3.1.1[c]'].implementationNarrative === CACHED && parsed.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === undefined && parsed.objectivesMigratedAt === NOW, 'I7 saveAssessment of the migrated state keeps only the pending id\'s narrative');
}

console.log('\n--- Conflicts that are not about the narrative ---');
{
  const id = 'AC.L2-3.1.1[a]';
  const run = (cachedNarrative: string, cachedStatus: AssessmentObjective['status'], server: ObjectiveRecord) =>
    applyImportResult(stateWith({ [id]: objective(id, { implementationNarrative: cachedNarrative, status: cachedStatus }) }), [{ objectiveId: id, result: 'conflict' }], NOW, [], { [id]: server });
  const empty = run('', 'IN_PROGRESS', record(id, { narrative: SERVER, status: 'MET' }));
  assert(!empty.objectivesPendingReview && empty.objectives![id].implementationNarrative === '' && empty.objectivesMigratedAt === NOW, 'N1 a conflict with an EMPTY cached narrative is not put under review; the server\'s values win');
  const statusOnly = run(SERVER, 'IN_PROGRESS', record(id, { narrative: SERVER, status: 'MET' }));
  assert(!statusOnly.objectivesPendingReview && statusOnly.objectives![id].implementationNarrative === '', 'N2 a conflict that differs only in status is not put under review');
  const sameText = run(SERVER, 'MET', record(id, { narrative: SERVER, status: 'MET', linkedEvidenceIds: ['ev'] }));
  assert(!sameText.objectivesPendingReview, 'N3 a conflict with the same narrative text (evidence links differ) is not put under review');
  const real = run(CACHED, 'MET', record(id, { narrative: SERVER, status: 'MET' }));
  assert(JSON.stringify(real.objectivesPendingReview) === JSON.stringify([id]) && real.objectives![id].implementationNarrative === CACHED, 'N4 a real text conflict (non-empty cached text that differs) goes under review with its text kept');
  const blank = run('   ', 'MET', record(id, { narrative: SERVER }));
  assert(!blank.objectivesPendingReview, 'N5 a whitespace-only cached narrative counts as empty');

  const stale = stateWith(
    { [id]: objective(id, { implementationNarrative: '' }), 'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { implementationNarrative: SERVER }), 'AC.L2-3.1.1[c]': objective('AC.L2-3.1.1[c]', { implementationNarrative: CACHED }) },
    { objectivesMigratedAt: NOW, objectivesPendingReview: [id, 'AC.L2-3.1.1[b]', 'AC.L2-3.1.1[c]'] }
  );
  const healed = pruneResolvedReviews(stale, { [id]: record(id, { narrative: SERVER }), 'AC.L2-3.1.1[b]': record('AC.L2-3.1.1[b]', { narrative: SERVER }), 'AC.L2-3.1.1[c]': record('AC.L2-3.1.1[c]', { narrative: SERVER }) });
  assert(JSON.stringify(healed.objectivesPendingReview) === JSON.stringify(['AC.L2-3.1.1[c]']) && healed.objectives!['AC.L2-3.1.1[b]'].implementationNarrative === '', 'N6 an existing review list is pruned: empty or equal-to-server entries leave it, a real difference stays');
  const items = objectivesToUpload({ [id]: objective(id, { status: 'IN_PROGRESS' }) }).items;
  assert(items.length === 1 && items[0].narrative === '', 'N7 a status-only entry still goes to the (insert-only) import with an empty narrative');
}

console.log('\n--- Merge and marker ordering ---');
{
  const live: Record<string, ObjectiveRecord> = {
    'AC.L2-3.1.1[a]': record('AC.L2-3.1.1[a]', { status: 'MET', narrative: SERVER, linkedEvidenceIds: ['ev-9'] }),
    'AC.L2-3.1.1[z]': record('AC.L2-3.1.1[z]', { status: 'IN_PROGRESS', narrative: SERVER }),
  };
  const cached = {
    'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { status: 'NOT_MET', implementationNarrative: CACHED, linkedEvidenceIds: ['old'], text: 'kept text' }),
    'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { status: 'MET', implementationNarrative: 'mine' }),
  };
  const merged = mergeServerObjectives(cached, live);
  assert(merged['AC.L2-3.1.1[a]'].status === 'MET' && merged['AC.L2-3.1.1[a]'].implementationNarrative === SERVER && JSON.stringify(merged['AC.L2-3.1.1[a]'].linkedEvidenceIds) === JSON.stringify(['ev-9']), 'M1 the server is authoritative for status, narrative and evidence of every id it returns');
  assert(merged['AC.L2-3.1.1[a]'].text === 'kept text' && merged['AC.L2-3.1.1[b]'].implementationNarrative === 'mine', 'M2 catalog fields and objectives the server does not return stay as they are');
  assert(merged['AC.L2-3.1.1[z]']?.implementationNarrative === SERVER && merged['AC.L2-3.1.1[z]'].letter === 'z', 'M3 an id the cache lacks is created from the server\'s record');
  const seeded = mergeServerObjectives({}, live, { seedFor: (id) => objective(id, { text: 'catalog text', isAutoVerifiedByTelemetry: true }) });
  assert(seeded['AC.L2-3.1.1[z]'].text === 'catalog text' && seeded['AC.L2-3.1.1[z]'].isAutoVerifiedByTelemetry === true && seeded['AC.L2-3.1.1[z]'].status === 'IN_PROGRESS', 'M4 the catalog objective is the base the server\'s record is laid over');
  const pending = mergeServerObjectives(cached, live, { pending: ['AC.L2-3.1.1[a]'] });
  assert(pending['AC.L2-3.1.1[a]'].implementationNarrative === CACHED && pending['AC.L2-3.1.1[a]'].status === 'MET', 'M5 an id under review keeps its cached narrative while the server decides the rest');
  assert(cached['AC.L2-3.1.1[a]'].implementationNarrative === CACHED, 'M6 merging does not mutate the cache');

  const opts = { canWrite: true, now: NOW };
  // Nothing to upload: the marker is set together with the first merge
  const clean = reconcileObjectives(stateWith({ 'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]') }), live, opts);
  assert(clean.outcome === 'marked' && clean.state.objectivesMigratedAt === NOW && clean.state.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === SERVER, 'R1 nothing to upload: the marker is set in the same step as the first merge of server narratives');
  StorageService.saveAssessment('t1', clean.state);
  assert(!(store.get('pbc_cmmc_assessment_v3_t1') ?? '').includes(SERVER), 'R2 so the saved cache never holds the server\'s narrative text');
  const viewerClean = reconcileObjectives(stateWith({}), live, { canWrite: false, now: NOW });
  assert(viewerClean.outcome === 'marked' && viewerClean.state.objectivesMigratedAt === NOW, 'R3 a viewer with nothing cached gets the marker too');

  // Cached narratives not on the server: nothing is merged (the cache is their only copy) until they are uploaded
  const dirty = stateWith({ 'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { implementationNarrative: CACHED }) });
  const owner = reconcileObjectives(dirty, live, opts);
  assert(owner.outcome === 'upload' && owner.state === dirty && !owner.state.objectivesMigratedAt && !('AC.L2-3.1.1[a]' in owner.state.objectives!), 'R4 a writer with cached narratives uploads first: no marker, and the server\'s narratives are not merged yet');
  const viewer = reconcileObjectives(dirty, live, { canWrite: false, now: NOW });
  assert(viewer.outcome === 'blocked' && viewer.state === dirty && !viewer.state.objectivesMigratedAt, 'R5 a viewer with cached narratives is blocked: no upload, no marker, no merge');
  const done = reconcileObjectives(applyImportResult(dirty, [{ objectiveId: 'AC.L2-3.1.1[b]', result: 'created' }], NOW), live, opts);
  assert(done.outcome === 'merged' && done.state.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === SERVER, 'R6 once the marker is set the server\'s records are merged');
  const withPending = reconcileObjectives(stateWith({ 'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { implementationNarrative: CACHED }) }, { objectivesMigratedAt: NOW, objectivesPendingReview: ['AC.L2-3.1.1[a]'] }), live, opts);
  assert(withPending.state.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === CACHED, 'R7 a merge after the upload keeps the narrative of an id under review');
}

console.log('\n--- Conflict resolution ---');
{
  const base = stateWith(
    { 'AC.L2-3.1.1[a]': objective('AC.L2-3.1.1[a]', { implementationNarrative: CACHED }), 'AC.L2-3.1.1[b]': objective('AC.L2-3.1.1[b]', { implementationNarrative: 'other' }) },
    { objectivesMigratedAt: NOW, objectivesPendingReview: ['AC.L2-3.1.1[a]', 'AC.L2-3.1.1[b]'] }
  );
  const server = resolveConflict(base, 'AC.L2-3.1.1[a]', 'server', SERVER);
  assert(JSON.stringify(server.objectivesPendingReview) === JSON.stringify(['AC.L2-3.1.1[b]']) && server.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === SERVER, 'C1 "Keep the server\'s text" shows the server\'s text and removes the id from the review list');
  const browser = resolveConflict(base, 'AC.L2-3.1.1[a]', 'browser', SERVER);
  assert(JSON.stringify(browser.objectivesPendingReview) === JSON.stringify(['AC.L2-3.1.1[b]']) && browser.objectives!['AC.L2-3.1.1[a]'].implementationNarrative === CACHED, 'C2 "Use this browser\'s text" keeps the text (saved to the server by the caller) and removes the id from the review list');
  const last = resolveConflict(server, 'AC.L2-3.1.1[b]', 'server', 'x');
  assert(!('objectivesPendingReview' in last), 'C3 the last resolved id removes the review list');
  StorageService.saveAssessment('t1', last);
  assert(!(store.get('pbc_cmmc_assessment_v3_t1') ?? '').includes(SERVER) && !(store.get('pbc_cmmc_assessment_v3_t1') ?? '').includes(CACHED), 'C4 once resolved, the next save strips the narrative from the cache');
  assert(base.objectivesPendingReview!.length === 2, 'C5 resolveConflict does not mutate its input');
}

console.log('\n--- Stack cascade ---');
{
  const lettersFor = (controlId: string) => (controlId === 'AC.L2-3.1.1' ? ['a', 'b'] : controlId === 'AC.L2-3.1.2' ? ['a'] : []);
  const current: Record<string, string> = { 'AC.L2-3.1.1[a]': 'USER TEXT', 'AC.L2-3.1.1[b]': '   ' };
  const out = cascadeFill(['AC.L2-3.1.1', 'AC.L2-3.1.2'], lettersFor, (id) => current[id] ?? '', (c, l) => `generated ${c} ${l}`);
  assert(out.map((i) => i.objectiveId).join(',') === 'AC.L2-3.1.1[b],AC.L2-3.1.2[a]', 'G1 a non-empty narrative is never overwritten (blank counts as empty)', out);
  const only = cascadeFill(['AC.L2-3.1.2'], lettersFor, () => '', (c, l) => `g ${c} ${l}`);
  assert(only.length === 1 && only[0].objectiveId === 'AC.L2-3.1.2[a]' && only[0].controlId === 'AC.L2-3.1.2' && only[0].narrative === 'g AC.L2-3.1.2 a' && only[0].status === undefined, 'G2 only the objectives of the given controls are produced, with the narrative only (status and evidence untouched)');
  assert(cascadeFill(['AC.L2-3.1.1'], lettersFor, () => '', () => '').length === 0, 'G3 an empty generated text is not sent');
  assert(JSON.stringify(registryLettersForControl('AC.L2-3.1.1')) === JSON.stringify(registryLettersForControl('3.1.1')) && registryLettersForControl('AC.L2-3.1.1').length > 1 && registryLettersForControl('XX.L9-9.9.9').length === 0, 'G4 the 171A registry resolves an L2 control id to its letters, and nothing for an unknown control');
  const profile = { identityProvider: 'Microsoft Entra ID' } as unknown as EnclaveStackProfile;
  const real = stackCascadeFill(['AC.L2-3.1.1', 'XX.L9-9.9.9'], profile, () => '');
  assert(real.length === registryLettersForControl('AC.L2-3.1.1').length && real.every((i) => /^AC\.L2-3\.1\.1\[[a-z]\]$/.test(i.objectiveId) && (i.narrative ?? '').length > 0), 'G5 stackCascadeFill produces ids of the given framework controls only, in the same id form the checklist uses', real.map((i) => i.objectiveId));
}

console.log('\n--- apiClient against a stubbed fetch ---');
type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
function stub(status: number, body: unknown) {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
}
const headerOf = (c: Call, name: string): string | undefined => (c.init.headers as Record<string, string> | undefined)?.[name];

async function api() {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined },
    configurable: true,
    writable: true,
  });
  try {
    stub(200, { objectives: [record('AC.L2-3.1.1[a]')] });
    const list = await ApiClient.getObjectives('t1', undefined, 'p1');
    assert(calls[0].url === '/api/v1/objectives' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1' && list.length === 1, 'A1 getObjectives is GET /api/v1/objectives with x-program-id', calls[0].url);
    await ApiClient.getObjectives('t1', 'AC.L2-3.1.1', null);
    assert(calls[1].url === '/api/v1/objectives?controlId=AC.L2-3.1.1' && headerOf(calls[1], 'x-program-id') === undefined, 'A2 the control filter is a query parameter; a null program sends no x-program-id', calls[1].url);

    stub(200, { objective: record('AC.L2-3.1.1[a]', { narrative: 'n' }), changed: true });
    const put = await ApiClient.putObjective('t1', { objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1', narrative: 'n' }, 'p1');
    const putBody = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert(calls[0].url === '/api/v1/objectives/AC.L2-3.1.1%5Ba%5D' && calls[0].init.method === 'PUT' && headerOf(calls[0], 'x-program-id') === 'p1' && putBody.narrative === 'n' && putBody.controlId === 'AC.L2-3.1.1' && !('objectiveId' in putBody) && put.changed === true, 'A3 putObjective is PUT /objectives/:id (encoded) with the fields as the body', { url: calls[0].url, putBody });

    stub(200, { total: 2, changed: 1 });
    await ApiClient.putObjectivesBulk('t1', [{ objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1', status: 'MET' }], 'p1');
    assert(calls[0].url === '/api/v1/objectives' && calls[0].init.method === 'PUT' && headerOf(calls[0], 'x-program-id') === 'p1' && Array.isArray((JSON.parse(String(calls[0].init.body)) as { objectives: unknown[] }).objectives), 'A4 putObjectivesBulk is PUT /objectives with { objectives }');

    stub(200, { results: [{ objectiveId: 'AC.L2-3.1.1[a]', result: 'created' }] });
    const imp = await ApiClient.importObjectives('t1', [{ objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1' }], 'p1');
    assert(calls[0].url === '/api/v1/objectives/import' && calls[0].init.method === 'POST' && headerOf(calls[0], 'x-program-id') === 'p1' && imp[0].result === 'created', 'A5 importObjectives is POST /objectives/import and returns the per-id results');

    stub(200, { events: [{ id: 'e1' }] });
    const hist = await ApiClient.getObjectiveHistory('t1', 'AC.L2-3.1.1[a]', 'p1');
    assert(calls[0].url === '/api/v1/objectives/AC.L2-3.1.1%5Ba%5D/history' && headerOf(calls[0], 'x-program-id') === 'p1' && hist.length === 1, 'A6 getObjectiveHistory reads the history of the encoded id');

    stub(403, { error: 'Read-only role' });
    let refused = '';
    try {
      await ApiClient.putObjective('t1', { objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1', narrative: 'n' }, 'p1');
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    assert(refused.length > 0, 'A7 a refused write rejects, so the UI can show it', refused);

    // updateControl: a refusal keeps its status and the server's message, so the UI can tell the user the edit was not saved
    const failure = async (): Promise<unknown> => {
      try {
        await ApiClient.updateControl('t1', 'AC.L2-3.1.1', { status: 'MET' }, 'p1');
        return null;
      } catch (err) {
        return err;
      }
    };
    const ARCHIVED = 'This program is archived: it can be read but not changed';
    stub(409, { error: ARCHIVED, code: 'program_archived' });
    const archived = await failure();
    assert(archived instanceof ApiError && archived.status === 409 && archived.message === ARCHIVED, 'A8 updateControl on an archived program rejects with ApiError 409 and the server\'s message', archived);
    stub(403, { error: 'Read-only role' });
    const forbidden = await failure();
    assert(forbidden instanceof ApiError && forbidden.status === 403, 'A9 updateControl refused with 403 rejects with ApiError 403', forbidden);
    calls.length = 0;
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const unreachable = await failure();
    assert(unreachable instanceof ApiError && unreachable.status === 0 && unreachable.message === 'Cannot reach the server. Check your connection and try again.', 'A10 updateControl with the server unreachable rejects with ApiError 0', unreachable);
    stub(200, { control: { id: 'AC.L2-3.1.1', status: 'MET' } });
    const saved = await ApiClient.updateControl('t1', 'AC.L2-3.1.1', { status: 'MET' }, 'p1');
    assert(calls[0].init.method === 'PUT' && calls[0].url.endsWith('/api/v1/controls/AC.L2-3.1.1') && headerOf(calls[0], 'x-program-id') === 'p1' && saved.status === 'MET', 'A11 a saved control resolves with the server\'s control (PUT, x-program-id)', calls[0].url);

    // Optimistic version check (#70): the stamp the browser last saw travels with the write
    const STAMP = '2026-10-30T00:00:00.000Z';
    const bodyOf = () => JSON.parse(String(calls[calls.length - 1].init.body)) as Record<string, unknown>;
    stub(200, { control: { id: 'AC.L2-3.1.1', status: 'MET' } });
    await ApiClient.updateControl('t1', 'AC.L2-3.1.1', { implementationNotes: 'n', expectedUpdatedAt: STAMP }, 'p1');
    assert(bodyOf().expectedUpdatedAt === STAMP && bodyOf().implementationNotes === 'n', 'S70-C01 updateControl sends expectedUpdatedAt in the body', bodyOf());
    await ApiClient.updateControl('t1', 'AC.L2-3.1.1', { implementationNotes: 'n' }, 'p1');
    assert(!('expectedUpdatedAt' in bodyOf()), 'S70-C01 without it the body has no expectedUpdatedAt key', bodyOf());
    await ApiClient.updateControl('t1', 'AC.L2-3.1.1', { implementationNotes: 'n', expectedUpdatedAt: null }, 'p1');
    assert(String(calls[calls.length - 1].init.body).includes('"expectedUpdatedAt":null'), 'S70-C01 a null stamp is sent as null (no stored row expected)', calls[calls.length - 1].init.body);

    stub(409, { error: 'x', code: 'stale_write', current: { updatedAt: null, updatedBy: null } });
    const stale = await failure();
    assert(stale instanceof ApiError && stale.status === 409 && stale.reason === 'stale_write' && isStaleWriteError(stale), 'S70-C02 a 409 stale_write is an ApiError with reason stale_write', stale);
    stub(409, { error: ARCHIVED, code: 'program_archived' });
    const archivedAgain = await failure();
    assert(!isStaleWriteError(archivedAgain) && !isStaleWriteError(new Error('x')) && !isStaleWriteError(null), 'S70-C02 other 409s and plain errors are not stale writes', archivedAgain);

    stub(200, { objective: record('AC.L2-3.1.1[a]'), changed: true });
    await ApiClient.putObjective('t1', { objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1', narrative: 'n', expectedUpdatedAt: STAMP }, 'p1');
    assert(bodyOf().expectedUpdatedAt === STAMP && !('objectiveId' in bodyOf()) && bodyOf().narrative === 'n', 'S70-C04 putObjective sends expectedUpdatedAt and still keeps objectiveId out of the body', bodyOf());
  } finally {
    globalThis.fetch = realFetch;
  }
}

function controlSaveFailures() {
  console.log('\n--- Control save failures ---');
  const SECRET = 'SECRET-CUI-TEXT';
  const ctl = (over: Partial<ControlState> = {}): ControlState => ({
    id: 'AC.L2-3.1.1',
    tenantId: 't1',
    status: 'NOT_STARTED',
    implementationNotes: '',
    responsibleRole: 'IT / Security Lead',
    lastUpdated: NOW,
    tags: [],
    ...over,
  });

  assert(controlSaveFailureMessage('AC.L2-3.1.1', { status: 'MET' }, new ApiError(401, 'Session expired')) === null, 'F1 a 401 needs no notice (the session signal signs the user out)');
  const texts: Array<[string, unknown, string]> = [
    ['unreachable', new ApiError(0, 'Cannot reach the server. Check your connection and try again.'), 'Cannot reach the server'],
    ['409', new ApiError(409, 'This program is archived: it can be read but not changed'), 'This program is archived'],
    ['403', new ApiError(403, 'Read-only role'), 'Read-only role'],
    ['plain', new Error('boom'), 'boom'],
  ];
  for (const [name, err, expected] of texts) {
    const msg = controlSaveFailureMessage('AC.L2-3.1.1', { status: 'MET' }, err);
    assert(msg !== null && msg.includes(expected) && msg.includes('AC.L2-3.1.1') && msg.includes('was not saved'), `F2 the notice for ${name} carries the error text and the control id`, msg);
  }
  assert(controlSaveFailureMessage('AC.L2-3.1.1', { status: 'MET' }, {}) === 'The change to the status of AC.L2-3.1.1 was not saved: unknown error', 'F3 an error without a message reads "unknown error"');
  const both = controlSaveFailureMessage('AC.L2-3.1.1', { implementationNotes: SECRET, status: 'MET', updatedBy: 'Ann' }, new ApiError(500, 'Server error')) ?? '';
  assert(both.includes('status and implementation notes') && !both.includes(SECRET) && !both.includes('MET') && !both.includes('Ann'), 'F4 the notice names the fields, never a value (the notes may contain CUI)', both);
  assert((controlSaveFailureMessage('AC.L2-3.1.1', { responsibleRole: 'CISO' }, new Error('x')) ?? '').includes('responsible role'), 'F5 a role change is called the responsible role');

  const staleErr = Object.assign(new ApiError(409, 'raw server text'), { reason: 'stale_write' });
  const staleMsg = controlSaveFailureMessage('AC.L2-3.1.1', { implementationNotes: SECRET }, staleErr) ?? '';
  assert(staleMsg === staleWriteMessage('control', 'AC.L2-3.1.1') && !staleMsg.includes(SECRET), 'S70-C03 a stale write reads the fixed notice for the control and never the text');

  const local = ctl({ status: 'MET', responsibleRole: 'CISO', implementationNotes: SECRET });
  const server = ctl({ status: 'IN_PROGRESS', responsibleRole: 'IT / Security Lead', implementationNotes: 'server notes' });
  const reverted = revertFailedControlFields(local, server, { status: 'MET', updatedBy: 'Ann' });
  assert(reverted.status === 'IN_PROGRESS' && reverted.responsibleRole === 'CISO' && reverted.implementationNotes === SECRET && reverted !== local, 'F6 a refused status goes back to the server\'s; the rest is untouched');
  assert(revertFailedControlFields(local, server, { status: 'NOT_MET' }) === local, 'F7 a newer local edit wins: nothing is reverted (same reference)');
  assert(revertFailedControlFields(local, undefined, { status: 'MET' }) === local, 'F8 without a server copy nothing is reverted (same reference)');
  assert(revertFailedControlFields(local, server, { implementationNotes: SECRET }) === local, 'F9 notes are never reverted: the text stays on screen');
  const roleBack = revertFailedControlFields(local, server, { responsibleRole: 'CISO' });
  assert(roleBack.responsibleRole === 'IT / Security Lead' && roleBack.status === 'MET', 'F10 a refused role goes back to the server\'s');

  const first = coalesceSaveFailure(null, 'one');
  const second = coalesceSaveFailure(first, 'two');
  assert(first.count === 1 && second.count === 2 && second.message === 'two' && coalesceSaveFailure(undefined, 'x').count === 1, 'F11 failures coalesce: the newest message and a count');

  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));
  const assess = read('src/context/AssessmentContext.tsx');
  const tenant = read('src/context/TenantContext.tsx');
  const live = slice(tenant, 'const updateLiveControl = useCallback', 'const reloadLiveObjectives = useCallback');
  assert(live.length > 0 && !/catch/.test(live) && !/return null/.test(live) && /Promise<ControlState>/.test(live), 'F12 updateLiveControl rejects: no catch, no null result');
  assert((assess.match(/updateLiveControl\(/g) ?? []).length === 1, 'F13 AssessmentContext calls updateLiveControl once, inside saveControl');
  const save = slice(assess, 'const saveControl = useCallback', '// Action: Update Control Status');
  assert(/await updateLiveControl\(/.test(save) && /currentTenant\.serverBacked/.test(save) && /revertFailedControlFields\(/.test(save) && /coalesceSaveFailure\(/.test(save) && !/alert\(/.test(save) && !/console\./.test(save) && !/recordAuditEvent/.test(save), 'F14 saveControl sends for server tenants only, reverts, coalesces the notice, and neither alerts, logs nor audits');
  const update = slice(read('src/services/apiClient.ts'), 'async updateControl(', '\n  },');
  assert(/apiErrorFromResponse\(res\.status/.test(update) && !/throw new Error/.test(update), 'F15 apiClient.updateControl throws an ApiError');
  const banner = read('src/components/common/BrowserOnlyNotesBanner.tsx');
  assert(/controlSaveError/.test(banner) && /role="alert"/.test(banner) && /dismissControlSaveError/.test(banner), 'F16 the banner shows the control save notice as an alert with a Dismiss button');
  const status = slice(assess, 'const updateControlStatus = useCallback', '// Action: Update Control Notes');
  const role = slice(assess, 'const updateControlRole = useCallback', '// Action: Apply Starter Template');
  assert(/!notesEditable/.test(status) && /!notesEditable/.test(role), 'F17 status and role changes are refused when the notes are not editable (offline / not loaded)');
  const loop = slice(assess, 'const IMPORT_PUT_CAP', 'return true;');
  assert(/saveControl\(id, update\)/.test(loop) && /'unreachable'\) break/.test(loop) && /controls to the server/.test(loop), 'F18 the import stops sending when the server is unreachable and reports how many controls were saved');
}

async function main() {
  await api();
  controlSaveFailures();

  console.log('\n--- Static checks ---');
  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const assess = read('src/context/AssessmentContext.tsx');
  const tenant = read('src/context/TenantContext.tsx');
  const sync = read('src/data/objectiveSync.ts');
  const dialog = read('src/components/matrix/ObjectiveReviewDialog.tsx');
  const banner = read('src/components/common/BrowserOnlyNotesBanner.tsx');
  const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));

  const writers = ['updateObjectiveStatus', 'updateObjectiveNarrative', 'applyObjectivePrefilledNarrative', 'applyAllObjectiveTemplatesForControl', 'linkEvidenceToObjective'];
  const bodies = writers.map((name, i) => slice(assess, `const ${name} = useCallback`, i + 1 < writers.length ? `const ${writers[i + 1]} = useCallback` : '// Action: Update SSP Metadata'));
  assert(bodies.every((b) => /objectiveWriteBlocked\(/.test(b) && /saveObjectives\(/.test(b)), 'S1 every objective writer is refused when notes are not editable and saves through saveObjectives');
  const helper = slice(assess, 'const saveObjectives = useCallback', 'const objectivePendingReview');
  assert(/updateLiveObjective\(/.test(helper) && /updateLiveObjectivesBulk\(/.test(helper) && /currentTenant\.serverBacked/.test(helper) && /alert\(/.test(helper) && /revertObjectives\(/.test(helper), 'S2 saveObjectives calls the server functions for server-backed tenants only, reports a failure and rolls the screen back');
  assert(/const objectiveWriteBlocked[\s\S]*?!canEdit[\s\S]*?!notesEditable[\s\S]*?NOTES_NOT_EDITABLE_MESSAGE/.test(assess), 'S3 the write gate checks the role and notesEditable (offline / loading / read-only)');
  assert(/updateLiveObjectivesBulk\(objectiveUploads\)/.test(assess) && /objectivesToUpload\(imported\.objectives/.test(assess), 'S4 importAssessmentJSON sends the imported objectives through the bulk write (chunked by the tenant context)');
  assert(/chunkItems\(items, MAX_OBJECTIVE_BULK\)/.test(tenant) && /chunkItems\(items, MAX_OBJECTIVE_IMPORT\)/.test(tenant) && /MAX_OBJECTIVE_BULK = 500/.test(read('src/types/controlObjectives.ts')), 'S5 the tenant context chunks bulk writes by 500 and imports by 5000');
  assert(/ApiClient\.getObjectives\(targetTenantId, undefined, programId\)/.test(tenant) && /setLiveObjectives\(objectivesMap\);\s+setLiveScopeKey\(scope\);/.test(tenant) && /isCurrentResponse\(seq, liveSeq\.current\)\) return;\s+const controlsMap/.test(tenant), 'S6 the objectives load in refreshLiveData\'s Promise.all, behind the same stale-response guard, for the same scope key');
  const clears = (tenant.match(/setLiveObjectives\(null\)/g) ?? []).length;
  const controlClears = (tenant.match(/setLiveControls\(null\)/g) ?? []).length;
  assert(clears === controlClears && clears >= 3, 'S7 every place that clears the live controls clears the live objectives', { clears, controlClears });
  assert(/liveObjectives && liveScopeKey !== programScope|!liveObjectives \|\| liveScopeKey !== programScope \|\| stateScope !== programScope/.test(assess) && /programScopeKey\(prev\.tenantId, prev\.programId\) !== programScope \? prev/.test(assess), 'S8 the merge needs the live scope to be the scope on screen and the state to be of that scope');
  const effect = slice(assess, 'const reconcileOptions', 'A browser-only tenant');
  assert(effect.indexOf("outcome === 'merged' || outcome === 'marked'") > 0 && effect.indexOf('importLiveObjectives(') > effect.indexOf("outcome === 'merged' || outcome === 'marked'"), 'S9 the effect merges only after the marker decision, and uploads (never merges) while cached narratives are pending');
  assert(/catch \{\s+\/\/ network or server failure: keep everything, retry on the next load/.test(assess) && !/catch[^{]*\{[^}]*applyImportResult/.test(effect), 'S10 a failed upload changes nothing (no marker, no stripping)');
  assert(/OBJECTIVE_NARRATIVE_UPDATED/.test(assess) && /describeNotesForLedger\(previous\)/.test(assess) && /OBJECTIVE_NARRATIVE_UPDATED/.test(read('src/types/audit.ts')), 'S11 narrative edits are recorded in the ledger as a digest, under their own action type');
  assert(/role = 'dialog'/.test(read('src/components/common/DialogOverlay.tsx')) && /role=\{role\}/.test(read('src/components/common/DialogOverlay.tsx')) && /<DialogOverlay[\s>]/.test(dialog) && /<DialogTitle[\s>]/.test(dialog) && !/dangerouslySetInnerHTML/.test(dialog) && /Use this browser&apos;s text/.test(dialog) && /Keep the server&apos;s text/.test(dialog) && /<ObjectiveReviewDialog \/>/.test(banner), 'S12 the review dialog is a labelled DialogOverlay, shows both texts as plain text with the two choices, and is mounted by the banner');
  assert(/This browser holds objective narratives that are not on the server yet\. Ask a tenant owner to open this organization in this browser to move them\./.test(sync) && /objectivesNeedOwner/.test(banner) && /objective narratives exist only in this browser/.test(banner), 'S13 the viewer notice and the browser-only banner mention objective narratives');
  const move = slice(tenant, 'const migrateTenantToServer = useCallback', 'const migrateLocalTenantToServer = useCallback');
  assert(/importObjectives\(created\.id/.test(move) && /objectivesFailed/.test(move) && /if \(objectivesFailed === 0\)/.test(move) && move.indexOf('importObjectives') > move.indexOf('updateControl'), 'S14 moving a tenant to the server imports its objectives after the controls, counts failures and marks the cache only on success');

  const resolver = slice(assess, 'const resolveObjectiveConflict = useCallback', 'const updateObjectiveStatus = useCallback');
  assert(/updateLiveObjective\(objectiveId, controlId, \{ narrative: browserText \}\)/.test(resolver) && /browserText\.trim\(\) === ''/.test(resolver) && /disabled=\{busy \|\| browserText\.trim\(\) === ''\}/.test(dialog), 'S18 "use this browser\'s text" sends only the narrative, and is refused (and disabled) when the browser text is empty');
  assert(/pruneResolvedReviews\(prev, liveObjectives\)/.test(assess) && /applyImportResult\(prev, results, new Date\(\)\.toISOString\(\), selection\.unsendable, records\)/.test(assess), 'S19 the review list is pruned when the live records load, and the import result is compared with the server\'s records');

  const secretVars = /\b(narrative|narratives|implementationNarrative|browserText|serverText|cached)\b/;
  const consoleLines = (src: string) => src.split('\n').filter((l) => /console\.(log|warn|error|info|debug)\(/.test(l));
  const offending = [['objectiveSync.ts', sync], ['ObjectiveReviewDialog.tsx', dialog], ['AssessmentContext.tsx', assess], ['apiClient.ts', read('src/services/apiClient.ts')]]
    .flatMap(([name, src]) => consoleLines(src).filter((l) => secretVars.test(l)).map((l) => `${name}: ${l.trim()}`));
  const cascadeWarn = consoleLines(slice(tenant, 'const updateStackProfile = useCallback', 'const suspendTenant = useCallback'));
  assert(offending.length === 0 && cascadeWarn.every((l) => /errorMessage\(e\)\);?$/.test(l.trim())), 'S15 no console line in the objective code mentions a narrative variable', offending);
  assert(!/\.setItem\(|localStorage/.test(sync), 'S16 objectiveSync.ts writes no browser storage');

  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:objective-client'] === 'tsx tests/objectiveClient.test.ts' && pkg.scripts['test:all'].includes('tsx tests/programClient.test.ts && tsx tests/objectiveClient.test.ts'), 'S17 test:objective-client exists and runs in test:all right after programClient');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
