import fs from 'fs';
import path from 'path';
import {
  LOCK_KEY,
  ACTIVITY_KEY,
  clearLock,
  isTabLocked,
  needsHeartbeat,
  parseIdleSeconds,
  readActivity,
  readLock,
  recordActivity,
  registerBeforeLock,
  runBeforeLock,
  secondsUntilLock,
  shouldLock,
  shouldWarn,
  waitForUnlock,
  writeLock,
} from '../src/services/idleLock';
import { pinTabSession, resetTabSession } from '../src/services/tabSession';

/**
 * The browser idle lock (#163): when the screen locks, the lock record other tabs read, the activity record and the hooks that
 * run before a lock. Pure test: no server, no browser (a Map-backed localStorage).
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

const store = new Map<string, string>();
let setCount = 0;
const storage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    setCount++;
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
};
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });

(async () => {
  const t = 1_800_000_000_000;
  const IDLE = 900_000;

  console.log('--- shouldLock / shouldWarn / needsHeartbeat ---');
  assert(shouldLock(t, t - 900_001, 0, IDLE) === true, 'I163-1 locks just past the idle limit');
  assert(shouldLock(t, t - 900_000, 0, IDLE) === false, 'I163-1 exactly at the limit does not lock');
  assert(shouldLock(t, t - 2e6, t - 10_000, IDLE) === false, 'I163-1 recent input in another tab keeps it unlocked');
  assert(shouldLock(t, t - 2e6, 0, 0) === false && shouldLock(t, 0, 0, 0) === false, 'I163-1 a limit of 0 never locks');
  assert(shouldWarn(t, t - 840_001, 0, IDLE) === true && shouldWarn(t, t - 839_000, 0, IDLE) === false, 'the warning starts one minute before the lock');
  assert(shouldWarn(t, t - 900_001, 0, IDLE) === false && shouldWarn(t, t - 2e6, 0, 0) === false, 'no warning once due, or when the lock is off');
  assert(secondsUntilLock(t, t - 870_000, 0, IDLE) === 30 && secondsUntilLock(t, t - 2e6, 0, IDLE) === 0 && secondsUntilLock(t, t, 0, 0) === 0, 'secondsUntilLock counts whole seconds down to 0');
  assert(needsHeartbeat(t, t - 30_000, t - 300_001) === true, 'I163-2 a heartbeat is due after 5 minutes without a request while working');
  assert(needsHeartbeat(t, t - 120_000, t - 400_000) === false, 'I163-2 no heartbeat when the person stopped working');
  assert(needsHeartbeat(t, t - 30_000, t - 60_000) === false, 'I163-2 no heartbeat after a recent request');

  console.log('\n--- The lock record ---');
  writeLock(storage, 'refA', t);
  assert(readLock(storage, 'refA') === true && readLock(storage, 'refB') === false, 'I163-3 a lock record belongs to its own session reference only');
  assert(readLock(storage, null) === false && readLock(storage, '') === false, 'no pinned reference is never locked');
  const stored = JSON.parse(store.get(LOCK_KEY) as string) as Record<string, unknown>;
  assert(Object.keys(stored).sort().join(',') === 'at,ref' && stored.ref === 'refA' && stored.at === t, 'I163-7 the stored lock holds exactly ref and at');
  clearLock(storage);
  assert(readLock(storage, 'refA') === false && !store.has(LOCK_KEY), 'I163-3 after clearLock it is not locked');
  store.set(LOCK_KEY, 'not json');
  assert(readLock(storage, 'refA') === false, 'a malformed lock record is not a lock');
  store.set(LOCK_KEY, '{"ref":7}');
  assert(readLock(storage, 'refA') === false, 'a lock record with a non-string reference is not a lock');
  store.clear();

  console.log('\n--- The activity record ---');
  setCount = 0;
  let written = recordActivity(storage, t, 0);
  written = recordActivity(storage, t + 5_000, written);
  written = recordActivity(storage, t + 14_999, written);
  assert(setCount === 1 && written === t, 'I163-4 input within 15 s of the last write does not write again', { setCount, written });
  written = recordActivity(storage, t + 15_000, written);
  assert(setCount === 2 && written === t + 15_000 && readActivity(storage) === t + 15_000, 'the next write happens after 15 s');
  store.clear();
  assert(readActivity(storage) === 0, 'no activity record reads as 0');
  store.set(ACTIVITY_KEY, 'abc');
  assert(readActivity(storage) === 0, 'a malformed activity record reads as 0');
  store.clear();

  console.log('\n--- parseIdleSeconds ---');
  assert(parseIdleSeconds(900) === 900 && parseIdleSeconds(0) === 0 && parseIdleSeconds(90.7) === 90, 'whole non-negative numbers pass');
  assert([-1, '900', null, undefined, NaN, Infinity, {}].every((v) => parseIdleSeconds(v) === 0), 'anything else is 0 (no client lock)');

  console.log('\n--- Hooks before the lock ---');
  let ran = 0;
  registerBeforeLock('quick', async () => {
    ran++;
  });
  registerBeforeLock('stuck', () => new Promise<void>(() => {}));
  const started = Date.now();
  await runBeforeLock(10);
  assert(Date.now() - started < 1000 && ran === 1, 'I163-5 runBeforeLock returns within its timeout although one hook never resolves', { ms: Date.now() - started, ran });
  const off = registerBeforeLock('quick', async () => {
    throw new Error('boom');
  });
  await runBeforeLock(10);
  off();
  assert(true, 'a throwing hook does not stop the lock');

  console.log('\n--- isTabLocked / waitForUnlock ---');
  resetTabSession();
  assert(isTabLocked() === false, 'no pinned session is not locked');
  pinTabSession('refA', 'u1');
  assert(isTabLocked() === false && (await Promise.race([waitForUnlock().then(() => 'done'), new Promise((r) => setTimeout(() => r('slow'), 200))])) === 'done', 'waitForUnlock resolves at once when not locked');
  writeLock(storage, 'refA', t);
  assert(isTabLocked() === true, 'the pinned session is locked while its record stands');
  let resolved = false;
  const waiting = waitForUnlock().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert(resolved === false, 'waitForUnlock waits while locked');
  clearLock(storage);
  await Promise.race([waiting, new Promise((r) => setTimeout(r, 3000))]);
  assert(resolved === true, 'waitForUnlock resolves within a second of the lock being cleared');
  resetTabSession();

  console.log('\n--- Source pins ---');
  const root = process.cwd();
  const src = fs.readFileSync(path.join(root, 'src/services/idleLock.ts'), 'utf8').replace(/\r\n/g, '\n');
  const tabSrc = fs.readFileSync(path.join(root, 'src/services/tabSession.ts'), 'utf8');
  assert(!src.includes('console.') && !/password/i.test(src), 'I163-6 idleLock.ts neither logs nor mentions a password');
  assert(!tabSrc.includes('setItem'), 'I163-6 tabSession.ts still never writes storage');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
