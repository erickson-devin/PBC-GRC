import fs from 'fs';
import path from 'path';
import {
  NOTES_AUTOSAVE_DELAY_MS,
  createNotesAutosave,
  createSaveChain,
  newerStamp,
  notesKey,
  type AutosaveScheduler,
  type NotesDraft,
} from '../src/data/notesAutosave';

/**
 * Debounced notes autosave (#51) and the optimistic version check's client half (#70): the pure debounce and per-key save chain, the
 * newer-stamp rule, and static checks that the editors push instead of saving per keystroke. Pure test: no server, no browser.
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

type Timer = { fn: () => void; ms: number } | null;
function fakeScheduler() {
  const q: Timer[] = [];
  const scheduler: AutosaveScheduler = {
    set: (fn, ms) => { q.push({ fn, ms }); return q.length - 1; },
    clear: (h) => { q[h as number] = null; },
  };
  return { q, scheduler };
}

const draft = (text: string, previous = '', controlId = 'AC.L2-3.1.1'): NotesDraft => ({ controlId, programId: 'p1', updatedBy: 'Ann', previous, text });
const KEY = notesKey('t1::p1', 'AC.L2-3.1.1');

function debounce() {
  console.log('\n--- Debounce ---');
  {
    const { q, scheduler } = fakeScheduler();
    const sent: Array<[string, NotesDraft]> = [];
    const auto = createNotesAutosave((k, d) => sent.push([k, d]), { scheduler });
    auto.push(KEY, draft('A1', 'start'));
    auto.push(KEY, draft('A2', 'A1'));
    auto.push(KEY, draft('A3', 'A2'));
    assert(sent.length === 0 && q[q.length - 1]?.ms === NOTES_AUTOSAVE_DELAY_MS && NOTES_AUTOSAVE_DELAY_MS === 1500 && auto.size() === 1, 'S51-01 three pushes on one key send nothing and leave one timer of 1500 ms');
    q[q.length - 1]!.fn();
    assert(sent.length === 1 && sent[0][0] === KEY && sent[0][1].text === 'A3' && sent[0][1].previous === 'start' && !auto.has(KEY), 'S51-02 the live timer sends once, with the latest text and the burst\'s first previous', sent);

    auto.push(KEY, draft('B1', 'A3'));
    auto.push(KEY, draft('B2', 'B1'));
    q[q.length - 1]!.fn();
    assert(sent.length === 2 && sent[1][1].previous === 'A3' && sent[1][1].text === 'B2', 'S51-06 after a send a new push starts a fresh burst', sent[1]);
  }
  {
    const { q, scheduler } = fakeScheduler();
    const sent: NotesDraft[] = [];
    const auto = createNotesAutosave((_k, d) => sent.push(d), { scheduler });
    auto.push(KEY, draft('x'));
    const first = auto.flush(KEY);
    const second = auto.flush(KEY);
    assert(first === true && second === false && sent.length === 1 && q[0] === null, 'S51-03 flush sends synchronously, once, and clears the timer');
    for (const t of q) if (t) t.fn();
    assert(sent.length === 1, 'S51-03 a cleared timer sends nothing');
  }
  {
    const { scheduler } = fakeScheduler();
    const sent: NotesDraft[] = [];
    const auto = createNotesAutosave((_k, d) => sent.push(d), { scheduler });
    auto.push(notesKey('t1::p1', 'AC.L2-3.1.1'), draft('a'));
    auto.push(notesKey('t1::p1', 'AC.L2-3.1.2'), draft('b', '', 'AC.L2-3.1.2'));
    assert(auto.size() === 2 && auto.flushAll() === 2 && sent.length === 2 && auto.size() === 0 && auto.flushAll() === 0, 'S51-04 flushAll sends every pending draft and returns the count');
  }
  {
    const { q, scheduler } = fakeScheduler();
    const sent: NotesDraft[] = [];
    const auto = createNotesAutosave((_k, d) => sent.push(d), { scheduler });
    auto.push(KEY, draft('a'));
    auto.cancel(KEY);
    for (const t of q) if (t) t.fn();
    assert(!auto.has(KEY) && sent.length === 0, 'S51-05 cancel drops the draft; firing the old timer sends nothing');
  }
}

async function chain() {
  console.log('\n--- Save chain ---');
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  {
    const c = createSaveChain();
    const order: string[] = [];
    let release1: () => void = () => undefined;
    let release2: () => void = () => undefined;
    const p1 = c.run('k', () => new Promise<string>((r) => { order.push('start1'); release1 = () => { order.push('end1'); r('one'); }; }));
    const p2 = c.run('k', () => new Promise<string>((r) => { order.push('start2'); release2 = () => { order.push('end2'); r('two'); }; }));
    await tick();
    const busyWhile = c.busy('k');
    const startedOnlyFirst = order.join() === 'start1';
    release1();
    await tick();
    const secondStarted = order.join() === 'start1,end1,start2';
    release2();
    const results = await Promise.all([p1, p2]);
    assert(startedOnlyFirst && secondStarted && order.join() === 'start1,end1,start2,end2' && results.join() === 'one,two', 'S51-07 two tasks on one key run in order', order);
    assert(busyWhile && !c.busy('k') && c.active() === 0, 'S51-07 busy is true while a task is pending and false after');
  }
  {
    const c = createSaveChain();
    const failing = c.run('k', () => Promise.reject(new Error('boom')));
    const next = c.run('k', async () => 'ran');
    let rejected = false;
    await failing.catch(() => { rejected = true; });
    assert(rejected && (await next) === 'ran', 'S51-08 a rejected task does not block the next one');
  }
  {
    const c = createSaveChain();
    const started: string[] = [];
    let releaseA: () => void = () => undefined;
    const a = c.run('a', () => new Promise<void>((r) => { started.push('a'); releaseA = r; }));
    const b = c.run('b', async () => { started.push('b'); });
    await b;
    const bRanWhileAPending = started.join() === 'a,b' && c.busy('a') && !c.busy('b');
    releaseA();
    await a;
    assert(bRanWhileAPending && !c.busy('a'), 'S51-09 different keys run concurrently');
  }
}

function stamps() {
  console.log('\n--- newerStamp ---');
  const t1 = '2026-10-30T00:00:00.000Z';
  const t2 = '2026-10-30T00:00:05.000Z';
  assert(newerStamp(undefined, undefined) === undefined, 'S51-10 (undefined, undefined) is undefined');
  assert(newerStamp(undefined, null) === null, 'S51-10 (undefined, null) is null');
  assert(newerStamp(t1, null) === t1 && newerStamp(null, t1) === t1, 'S51-10 a stamp beats null');
  assert(newerStamp(t1, t2) === t2 && newerStamp(t2, t1) === t2, 'S51-10 the later of two stamps wins, in either order');
  assert(newerStamp('bad', t1) === t1 && newerStamp(t1, 'bad') === t1, 'S51-10 an unparseable stamp counts as absent');
}

function sources() {
  console.log('\n--- Static checks ---');
  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));
  const assess = read('src/context/AssessmentContext.tsx');
  const body = slice(assess, 'const updateControlNotes = useCallback', '// Action: Update Control Role');
  assert(body.length > 0 && body.includes('notesAutosaveRef.current.push(') && !body.includes('saveControl('), 'S51-11 updateControlNotes pushes a draft and never saves per keystroke');
  assert(assess.includes('flushAll()') && assess.includes('visibilitychange') && assess.includes('beforeunload') && /notesAutosaveRef\.current\.has\(key\) \|\| saveChainRef\.current\.busy\(key\) \|\| staleNotesRef\.current\.has\(key\)/.test(assess), 'S51-11 the context flushes on leave / hide, warns on unload, and the live merge keeps notes being saved');
  const editors = ['src/components/dashboard/ControlCard.tsx', 'src/components/matrix/InspectDocumentModal.tsx', 'src/components/matrix/SspStatementEditor.tsx'];
  assert(editors.every((f) => read(f).includes('onBlur=')), 'S51-11 every notes editor flushes on blur');
  const module = read('src/data/notesAutosave.ts');
  assert(!/localStorage|sessionStorage|indexedDB|console\.|recordAuditEvent|fetch\(/.test(module), 'S51-11 notesAutosave.ts touches no storage, console, ledger or network');

  const lines = assess.split('\n');
  const start = assess.indexOf('sendNotesRef.current = ');
  const end = start < 0 ? -1 : assess.indexOf('\n    };\n', start);
  const inBlock = (idx: number) => start >= 0 && end > start && idx > start && idx < end;
  const at: number[] = [];
  for (let i = assess.indexOf('CONTROL_NOTES_UPDATED'); i >= 0; i = assess.indexOf('CONTROL_NOTES_UPDATED', i + 1)) at.push(i);
  assert(lines.length > 0 && at.length >= 1 && at.every(inBlock), 'S51-12 the notes ledger entry is written only when a save is sent, not per keystroke', at);
}

async function main() {
  debounce();
  await chain();
  stamps();
  sources();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
