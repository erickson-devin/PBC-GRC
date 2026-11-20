import fs from 'fs';
import path from 'path';
import { createSearchController, searchErrorOf, SEARCH_DEBOUNCE_MS, type SearchState } from '../src/data/search/searchController';
import {
  clearProgramSummaries,
  getProgramSummaryEntry,
  invalidateProgramSummary,
  reloadProgramSummary,
  subscribeProgramSummary,
  watchProgramSummary,
} from '../src/services/programSummaryService';
import { notifyInventoryChanged } from '../src/services/inventoryService';
import { notifyDocumentsChanged } from '../src/services/documentService';
import type { SearchKind, SearchResponse } from '../src/types/search';

/**
 * Client logic of the experience features (#251 to #254): the search controller (debounce, stale answers, fixed error codes, no text kept), the
 * program summary store (one request shared by every screen, refreshed when the register or documents change) and source checks on the hooks
 * (no browser storage, no console, no audit ledger, the shared stores). Pure test: no server, no browser; the timers and the fetch are stubs.
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
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const group = (kind: SearchKind, n: number, truncated: boolean): SearchResponse['groups'][number] => ({
  kind,
  truncated,
  results: Array.from({ length: n }, (_, i) => ({ kind, id: `${kind}-${i}`, title: 't', subtitle: '', field: 'title', snippet: null, nav: { screen: 'asset', assetId: `a${i}` } as const })),
});

async function searchTests() {
  console.log('\n--- search controller ---');
  type Pending = { body: { q: string; kinds?: SearchKind[]; perKind?: number }; resolve: (r: SearchResponse) => void; reject: (e: unknown) => void };
  const setup = () => {
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextTimer = 1;
    const pending: Pending[] = [];
    const states: SearchState[] = [];
    const controller = createSearchController({
      run: (body) => new Promise<SearchResponse>((resolve, reject) => pending.push({ body, resolve, reject })),
      onState: (s) => states.push(s),
      debounceMs: 40,
      setTimer: (fn, ms) => {
        const id = nextTimer++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
    });
    const fire = () => {
      const all = [...timers.values()];
      timers.clear();
      all.forEach((t) => t.fn());
    };
    return { controller, timers, pending, states, fire, last: () => states[states.length - 1] };
  };
  const answer = (groups: SearchResponse['groups']): SearchResponse => ({ programId: 'p1', groups });

  assert(SEARCH_DEBOUNCE_MS === 250, 'SC1 the default pause is 250 ms');

  let s = setup();
  s.controller.search('a');
  s.controller.search('   ');
  s.controller.search('a\u0007b');
  assert(s.timers.size === 0 && s.pending.length === 0 && s.last().status === 'idle' && s.last().response === null, 'SC2 text under the minimum, blank or with a control character sends nothing and clears');

  s = setup();
  s.controller.search('ac');
  s.controller.search('acc');
  s.controller.search('  acce ');
  assert(s.timers.size === 1 && [...s.timers.values()][0].ms === 40 && s.pending.length === 0 && s.last().status === 'loading', 'SC3 a burst of typing leaves one pending timer with the injected delay and sends nothing yet');
  s.fire();
  assert(s.pending.length === 1 && s.pending[0].body.q === 'acce' && Object.keys(s.pending[0].body).join() === 'q', 'SC4 after the pause one request goes, with the trimmed last text and nothing else');
  s.pending[0].resolve(answer([group('control', 2, false)]));
  await tick();
  assert(s.last().status === 'ready' && s.last().response?.groups[0].results.length === 2 && s.last().error === null, 'SC5 the answer is shown');

  s = setup();
  s.controller.search('abc');
  s.fire();
  s.controller.search('abd');
  s.fire();
  s.pending[1].resolve(answer([group('asset', 1, false)]));
  await tick();
  s.pending[0].resolve(answer([group('control', 5, false)]));
  await tick();
  assert(s.last().status === 'ready' && s.last().response?.groups[0].kind === 'asset', 'SC6 an answer to an older query that arrives later is ignored');

  s = setup();
  s.controller.search('abc');
  s.fire();
  s.controller.search('abd'); // typed, its timer not fired yet: the request for "abc" is already stale
  s.pending[0].resolve(answer([group('control', 5, false)]));
  await tick();
  assert(s.last().status === 'loading' && s.last().response === null, 'SC7 an answer that arrives while newer text waits for its pause is ignored', s.last());

  s = setup();
  s.controller.search('abc');
  s.fire();
  s.controller.clear();
  s.pending[0].resolve(answer([group('control', 5, false)]));
  await tick();
  assert(s.last().status === 'idle' && s.last().response === null, 'SC8 clear drops the results and a late answer is ignored');
  s.controller.search('abc');
  s.controller.clear();
  assert(s.timers.size === 0, 'SC8a clear cancels the pause');

  for (const [status, code] of [[429, 'too_many'], [400, 'invalid'], [500, 'failed'], [0, 'failed'], [undefined, 'failed']] as const) {
    s = setup();
    s.controller.search('abc');
    s.fire();
    s.pending[0].reject(Object.assign(new Error('secret text from the server: abc'), { status }));
    await tick();
    assert(s.last().status === 'error' && s.last().error === code && s.last().response === null && !JSON.stringify(s.last()).includes('secret'), `SC9 status ${String(status)} gives the fixed code ${code} and keeps no server text`, s.last());
  }
  assert(searchErrorOf(null) === 'failed' && searchErrorOf('x') === 'failed', 'SC9a searchErrorOf never throws');

  s = setup();
  s.controller.search('abc');
  s.fire();
  s.pending[0].resolve(answer([group('control', 8, true), group('asset', 2, false)]));
  await tick();
  s.controller.loadMore('asset');
  assert(s.pending.length === 1, 'SC10 loadMore does nothing for a group that is not cut off');
  s.controller.loadMore('control');
  assert(s.pending.length === 2 && JSON.stringify(s.pending[1].body) === '{"q":"abc","kinds":["control"],"perKind":25}', 'SC10a loadMore asks again for that group only, with the largest page', s.pending[1]?.body);
  s.pending[1].resolve(answer([group('control', 20, true)]));
  await tick();
  const merged = s.last().response?.groups;
  assert(s.last().status === 'ready' && merged?.length === 2 && merged[0].results.length === 20 && merged[1].kind === 'asset' && merged[1].results.length === 2, 'SC10b the new page replaces that group and the others stay', merged?.map((g) => g.results.length));
  s.controller.clear();
  s.controller.loadMore('control');
  assert(s.pending.length === 2, 'SC10c loadMore after clear sends nothing (the query was forgotten)');

  s = setup();
  s.controller.search('abc');
  s.fire();
  s.pending[0].resolve(answer([group('control', 8, true)]));
  await tick();
  s.controller.loadMore('control');
  s.pending[1].reject(Object.assign(new Error('x'), { status: 429 }));
  await tick();
  assert(s.last().status === 'error' && s.last().error === 'too_many' && s.last().response?.groups.length === 1, 'SC10d a failed loadMore keeps the results already shown');
}

// ----------------------------------------------------------------------------------------------- program summary store

type Call = { url: string; method: string; programId: string | undefined };
const calls: Call[] = [];
let respond: (programId: string) => { status: number; body: unknown } = (programId) => ({ status: 200, body: summaryOf(programId) });
let hold: Promise<void> | null = null;
function summaryOf(programId: string, owners = 1) {
  return { programId, generatedAt: '2026-11-20T00:00:00.000Z', people: { ownerLevelMembers: owners, primaryContactSet: true }, inventory: { supported: true }, documents: null, reviews: { reviewed: 0, total: 3 }, poam: { openCount: 0 } };
}

async function summaryTests() {
  console.log('\n--- program summary store ---');
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined }, configurable: true, writable: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const programId = headers['x-program-id'];
    calls.push({ url: String(input), method: String(init?.method), programId });
    if (hold) await hold;
    const r = respond(programId ?? '');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  }) as typeof fetch;
  try {
    let notified = 0;
    const off = subscribeProgramSummary(() => { notified++; });

    assert(getProgramSummaryEntry('t1', 'p1').status === 'loading' && getProgramSummaryEntry('t1', 'p1').summary === null, 'PS1 an unknown program reads as loading with no summary');
    const stopA = watchProgramSummary('t1', 'p1');
    const stopB = watchProgramSummary('t1', 'p1');
    await tick();
    assert(calls.length === 1 && calls[0].url === '/api/v1/program-summary' && calls[0].method === 'GET' && calls[0].programId === 'p1', 'PS2 two screens watching one program cost one request', calls);
    assert(getProgramSummaryEntry('t1', 'p1').status === 'ready' && getProgramSummaryEntry('t1', 'p1').summary?.people.ownerLevelMembers === 1 && notified >= 1, 'PS3 the answer is shared and listeners are told');
    const before = getProgramSummaryEntry('t1', 'p1');
    assert(getProgramSummaryEntry('t1', 'p1') === before, 'PS3a the entry is a stable snapshot until it changes');

    respond = (id) => ({ status: 200, body: summaryOf(id, 2) });
    notifyInventoryChanged('t1', 'tools');
    await tick();
    assert(calls.length === 2 && getProgramSummaryEntry('t1', 'p1').summary?.people.ownerLevelMembers === 2, 'PS4 a register change refetches a program a screen is showing');
    notifyDocumentsChanged('t1', 'program', 'p1');
    await tick();
    assert(calls.length === 3, 'PS5 a change to the program\'s documents refetches it');
    notifyDocumentsChanged('t1', 'program', 'p2');
    notifyInventoryChanged('other', 'tools');
    await tick();
    assert(calls.length === 3, 'PS6 another program\'s or organization\'s change refetches nothing');

    invalidateProgramSummary('t1', 'p1');
    await tick();
    assert(calls.length === 4, 'PS7 the explicit invalidate refetches');

    // A change while a request is on its way: the answer is shown, then fetched again
    let release: () => void = () => undefined;
    hold = new Promise<void>((r) => { release = r; });
    invalidateProgramSummary('t1', 'p1');
    await tick();
    invalidateProgramSummary('t1', 'p1');
    hold = null;
    release();
    await tick();
    await tick();
    assert(calls.length === 6, 'PS8 an invalidate during a request leads to one more request after it, not a lost update', calls.length);

    stopA();
    stopB();
    invalidateProgramSummary('t1', 'p1');
    await tick();
    assert(calls.length === 6, 'PS9 with no screen watching, an invalidate only marks it out of date');
    const stopC = watchProgramSummary('t1', 'p1');
    await tick();
    assert(calls.length === 7, 'PS9a the next screen to watch it fetches again');

    respond = () => ({ status: 500, body: { error: 'x' } });
    await reloadProgramSummary('t1', 'p1');
    const failed = getProgramSummaryEntry('t1', 'p1');
    assert(failed.status === 'error' && failed.summary?.people.ownerLevelMembers === 2, 'PS10 a failed refresh is an error and the last good summary stays');
    respond = (id) => ({ status: 200, body: summaryOf(id, 5) });
    await reloadProgramSummary('t1', 'p1');
    assert(getProgramSummaryEntry('t1', 'p1').status === 'ready' && getProgramSummaryEntry('t1', 'p1').summary?.people.ownerLevelMembers === 5, 'PS10a reload recovers');

    respond = () => ({ status: 200, body: summaryOf('someone-else') });
    const stopD = watchProgramSummary('t1', 'p3');
    await tick();
    assert(getProgramSummaryEntry('t1', 'p3').status === 'error' && getProgramSummaryEntry('t1', 'p3').summary === null, 'PS11 a summary for another program than the one asked is refused');

    stopC();
    stopD();
    off();
    clearProgramSummaries();
    assert(getProgramSummaryEntry('t1', 'p1').status === 'loading', 'PS12 clear forgets every summary');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ----------------------------------------------------------------------------------------------- hooks (source checks)

function sourceTests() {
  console.log('\n--- hooks and store: source checks ---');
  const root = process.cwd();
  const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');
  const files = [
    'src/hooks/useProgramSummary.ts',
    'src/hooks/useProgramJourney.ts',
    'src/hooks/useAssignments.ts',
    'src/hooks/useTeams.ts',
    'src/hooks/useResponsibilities.ts',
    'src/hooks/useGlobalSearch.ts',
    'src/services/programSummaryService.ts',
    'src/data/search/searchController.ts',
  ];
  for (const f of files) {
    const src = read(f);
    assert(!/localStorage|sessionStorage|caches\.|indexedDB|recordAuditEvent|dangerouslySetInnerHTML|console\./.test(src), `SRC1 ${f} uses no browser storage, audit ledger, console or raw HTML`);
  }
  for (const f of files.filter((n) => n.includes('src/hooks/') && !n.includes('Journey'))) {
    assert(/Boolean\(currentTenant\.serverBacked\)/.test(read(f)) && /unsupported/.test(read(f)), `SRC2 ${f} treats a browser-only organization as unsupported`);
  }
  const search = read('src/hooks/useGlobalSearch.ts');
  assert(/createSearchController/.test(search) && /controller\?\.clear\(\)/.test(search) && /\[controller\]/.test(search) && !/setTimeout/.test(search), 'SRC3 useGlobalSearch uses the controller and clears it on a scope switch or unmount');
  const ctl = read('src/data/search/searchController.ts');
  assert(/normalizeQuery/.test(ctl) && /SEARCH_PER_KIND_MAX/.test(ctl) && /mine !== seq/.test(ctl), 'SRC3a the controller uses the shared query rule and ignores stale answers');
  const asg = read('src/hooks/useAssignments.ts');
  assert(
    /const entries = new Map<string, Entry>\(\)/.test(asg) && /useSyncExternalStore/.test(asg) && /export const assignmentKey/.test(asg) && /export function invalidateAssignments/.test(asg) && /validateAssignmentBatch/.test(asg) && /chains\.get\(scope\)/.test(asg) && /stale_write/.test(asg),
    'SRC4 useAssignments is a module-level shared store with serialized, validated, all-or-nothing saves and a reload on a stale write'
  );
  const teams = read('src/hooks/useTeams.ts');
  assert(/useSyncExternalStore/.test(teams) && /invalidateAssignments/.test(teams) && /expectedUpdatedAt/.test(teams) && /force/.test(teams), 'SRC5 useTeams is a shared store, sends the stamp and refreshes the assignments after a forced delete');
  const sum = read('src/hooks/useProgramSummary.ts');
  assert(/watchProgramSummary/.test(sum) && /invalidateProgramSummary/.test(sum) && /activeTab/.test(sum) && /teamMembers/.test(sum), 'SRC6 useProgramSummary refetches on a member-list or tab change');
  const svc = read('src/services/programSummaryService.ts');
  assert(/subscribeInventory\(/.test(svc) && /subscribeDocuments\(/.test(svc) && /export function invalidateProgramSummary/.test(svc), 'SRC7 the summary store follows the inventory and document changes and has an explicit invalidate');
  const journey = read('src/hooks/useProgramJourney.ts');
  assert(/computeJourney\(/.test(journey) && /computeSspCompleteness\(/.test(journey) && /getExportGaps\(/.test(journey) && /exportFormDefaults\(/.test(journey) && /useProgramSummary\(\)/.test(journey) && /useSspProfile\(\)/.test(journey), 'SRC8 useProgramJourney composes the summary with the client\'s own data through computeJourney');
  const resp = read('src/hooks/useResponsibilities.ts');
  assert(/latest\.current/.test(resp) && /getResponsibilities\(tenantId/.test(resp) && !/programId/.test(resp), 'SRC9 useResponsibilities is tenant-wide and ignores stale answers');
}

async function main() {
  await searchTests();
  await summaryTests();
  sourceTests();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
