/**
 * #84: the browser side of the SSP metadata move. Which cached fields upload, merge or conflict with the server copy, the debounce that
 * keeps one pending snapshot per program, and the unsaved-text report. Pure test: no server, no browser.
 */
import fs from 'fs';
import path from 'path';
import {
  SSP_METADATA_NEED_OWNER_MESSAGE,
  SSP_METADATA_STALE_MESSAGE,
  createDebouncedSave,
  hasUserSspContent,
  mergeServerSspMetadata,
  pickSspFields,
  reconcileSspMetadata,
} from '../src/data/sspMetadataSync';
import { createDefaultSspMetadata } from '../src/services/storageService';
import { unsavedSspMetadataFields } from '../src/services/unsavedText';
import type { AssessmentState } from '../src/types/cmmc';
import type { SspMetadataRecord } from '../src/types/sspMetadata';
import type { Tenant } from '../src/types/tenant';

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

const NOW = '2026-10-31T12:00:00.000Z';
const STAMP = '2026-10-30T08:00:00.000Z';
const tenant = { id: 't1', name: 'Acme', cageCode: '1ABC2', samStatus: 'ACTIVE', systemName: 'Enclave', systemOwner: 'Owner', industry: 'DIB' } as unknown as Tenant;
const defaults = createDefaultSspMetadata(tenant);
const stateWith = (over: Record<string, string>, marker?: string): AssessmentState => ({
  version: '2.0.0',
  tenantId: 't1',
  sspMetadata: { ...defaults, ...over },
  controls: {},
  evidenceIndex: [],
  lastSaved: '2026-10-30T00:00:00.000Z',
  ...(marker ? { sspMetadataMigratedAt: marker } : {}),
});
const record = (metadata: Record<string, string> | null, updatedAt: string | null = STAMP): SspMetadataRecord => ({ metadata, updatedAt, updatedBy: metadata ? 'u' : null });
const opts = (canWrite: boolean) => ({ canWrite, now: NOW, defaults });

console.log('--- reconcileSspMetadata ---');
const r1 = reconcileSspMetadata(stateWith({}, '2026-10-01T00:00:00.000Z'), record({ systemEnvironment: 'SERVER-ENV' }), opts(true));
assert(r1.outcome === 'merged' && r1.state.sspMetadata.systemEnvironment === 'SERVER-ENV' && r1.state.sspMetadataMigratedAt === '2026-10-01T00:00:00.000Z' && r1.state.sspMetadata.lastUpdated === STAMP, 'R1 with the marker set the server copy is shown and the marker is kept', r1.outcome);

const r2 = reconcileSspMetadata(stateWith({ assessmentDate: '2020-01-01' }), record(null, null), opts(true));
assert(r2.outcome === 'marked' && r2.state.sspMetadataMigratedAt === NOW && r2.upload === undefined, 'R2 a cache equal to the defaults (only the date differs) is marked with the clock', r2.outcome);

const cachedE = stateWith({ systemEnvironment: 'E' });
const r3 = reconcileSspMetadata(cachedE, record(null, null), opts(true));
assert(r3.outcome === 'upload' && JSON.stringify(r3.upload) === JSON.stringify(pickSspFields(cachedE.sspMetadata)) && r3.expected === null && r3.state.sspMetadataMigratedAt === undefined, 'R3 cache text and no server row: upload the whole cache, expected null, marker unset', r3.outcome);

const r4 = reconcileSspMetadata(cachedE, record(null, null), opts(false));
assert(r4.outcome === 'blocked' && r4.state === cachedE, 'R4 the same without write rights is blocked and the state is the input', r4.outcome);

const cachedSE = stateWith({ systemName: 'S', systemEnvironment: 'E' });
const r5 = reconcileSspMetadata(cachedSE, record({ systemName: 'S' }), opts(true));
assert(r5.outcome === 'upload' && JSON.stringify(r5.upload) === JSON.stringify({ systemName: 'S', systemEnvironment: 'E' }) && r5.expected === STAMP, 'R5 cache text only fills a field the server has empty: upload with the server stamp', r5);

const r6 = reconcileSspMetadata(stateWith({ systemEnvironment: 'E' }), record({ systemEnvironment: 'X' }), opts(true));
assert(r6.outcome === 'conflict' && JSON.stringify(r6.conflictFields) === '["systemEnvironment"]' && r6.upload === undefined, 'R6 a field set on both sides to different text is a conflict (field names only)', r6);

const r7 = reconcileSspMetadata(stateWith({ systemEnvironment: '' }), record({ systemEnvironment: 'X' }), opts(true));
assert(r7.outcome === 'marked' && r7.state.sspMetadata.systemEnvironment === 'X' && r7.state.sspMetadataMigratedAt === NOW, 'R7 an empty cache field never conflicts: the server value is taken and the marker set', r7.outcome);

const frozen = stateWith({ systemName: 'S', systemEnvironment: 'E' });
const recIn = record({ systemName: 'S' });
const before = JSON.stringify([frozen, recIn, defaults]);
reconcileSspMetadata(frozen, recIn, opts(true));
reconcileSspMetadata(frozen, recIn, opts(false));
assert(JSON.stringify([frozen, recIn, defaults]) === before, 'R8 nothing passed in is mutated');

const r9 = reconcileSspMetadata(stateWith({ version: '9.9' }), record({ version: '9.9', systemName: 'S' }), opts(true));
assert(r9.outcome === 'marked' && r9.conflictFields === undefined, 'R9 a cache field equal to the server value is not a conflict', r9.outcome);

console.log('\n--- helpers ---');
assert(!hasUserSspContent(stateWith({ assessmentDate: '1999-01-01' }).sspMetadata, defaults) && hasUserSspContent(stateWith({ cloudServiceProviders: 'C' }).sspMetadata, defaults), 'H1 hasUserSspContent ignores the date and the defaults');
const picked = pickSspFields({ ...defaults, tenantId: 't1', lastUpdated: 'x' });
assert(!('tenantId' in picked) && !('lastUpdated' in picked) && picked.systemName === 'Enclave', 'H2 pickSspFields keeps the 11 text fields only');
const merged = mergeServerSspMetadata(defaults, record({ systemName: 'Srv' }));
assert(merged.systemName === 'Srv' && merged.organizationName === defaults.organizationName && merged.tenantId === 't1' && merged.lastUpdated === STAMP && mergeServerSspMetadata(defaults, record(null, null)).systemName === defaults.systemName, 'H3 mergeServerSspMetadata lays the server fields over the defaults');
assert(!SSP_METADATA_STALE_MESSAGE.includes('"') && SSP_METADATA_STALE_MESSAGE.length > 20 && SSP_METADATA_NEED_OWNER_MESSAGE.length > 20, 'H4 the two notice texts are fixed text');

console.log('\n--- createDebouncedSave ---');
function fakeScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    timers,
    set: (fn: () => void, _ms: number) => { const id = next++; timers.set(id, fn); return id; },
    clear: (h: unknown) => { timers.delete(h as number); },
    fireAll: () => { for (const [id, fn] of Array.from(timers)) { timers.delete(id); fn(); } },
  };
}
{
  const sched = fakeScheduler();
  const sent: Array<[string, string]> = [];
  const d = createDebouncedSave<string>((k, v) => sent.push([k, v]), { delayMs: 10, scheduler: sched });
  d.push('p1', 'a'); d.push('p1', 'b'); d.push('p1', 'c');
  assert(sent.length === 0 && d.has('p1') && sched.timers.size === 1, 'D0 pushes only schedule one timer');
  sched.fireAll();
  assert(sent.length === 1 && sent[0][1] === 'c' && !d.has('p1'), 'D1 three pushes within the delay send once with the last snapshot', sent);
  d.push('p1', 'x'); d.push('p2', 'y');
  assert(d.flush('p1') === true && sent.length === 2 && sent[1][1] === 'x' && d.flush('p1') === false, 'D2 flush sends at once and only once');
  assert(d.flushAll() === 1 && sent.length === 3 && sent[2][0] === 'p2', 'D2b flushAll sends every other pending snapshot');
  d.push('p3', 'z'); d.cancel('p3'); sched.fireAll();
  assert(sent.length === 3 && !d.has('p3'), 'D3 cancel sends nothing');
}

console.log('\n--- unsavedSspMetadataFields ---');
assert(unsavedSspMetadataFields({ systemEnvironment: 'E' }, null, 'p1').length === 0, 'U1 no live copy means nothing is reported');
const u2 = unsavedSspMetadataFields({ systemEnvironment: 'E', systemName: 'S' }, { systemName: 'S' }, 'p1');
assert(u2.length === 1 && u2[0].key === 'ssp:p1:systemEnvironment' && u2[0].label === 'SSP field, systemEnvironment' && u2[0].text === 'E', 'U2 one differing field gives one entry with a field-name label', u2);
assert(unsavedSspMetadataFields({ systemEnvironment: '' }, { systemEnvironment: 'X' }, 'p1').length === 0, 'U3 an empty draft is not reported');

console.log('\n--- Source ---');
const syncSource = fs.readFileSync(path.join(process.cwd(), 'src/data/sspMetadataSync.ts'), 'utf8');
assert(!/console\.|localStorage|sessionStorage|\.setItem\(|fetch\(/.test(syncSource), 'X1 the sync module has no console, storage or network call');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
