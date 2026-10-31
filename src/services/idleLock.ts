/**
 * The browser's idle lock (#163): the rules for when the screen locks, the lock record other tabs read, and the hooks that run before it.
 * Pure: no React, no import from the API client. The lock record holds only the opaque session reference (a marker, not a
 * credential) and a timestamp; nothing typed by the person, no secret and no log line ever passes through here.
 */
import { tabSessionPin } from './tabSession';

/** localStorage key of the lock record (JSON { ref, at }): while it names a tab's pinned session, that tab is locked. */
export const LOCK_KEY = 'pbc_session_lock_v1';
/** localStorage key of the last input anywhere in this browser (epoch ms), so a busy tab keeps the idle clock of the others running. */
export const ACTIVITY_KEY = 'pbc_last_activity_v1';

/** The warning appears this long before the lock. */
export const IDLE_WARNING_MS = 60_000;
/** The shared activity record is written at most this often. */
export const ACTIVITY_WRITE_INTERVAL_MS = 15_000;
/** While the person is working, a request goes out at least this often so the server's own idle clock does not run out. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const RECENT_INPUT_MS = 60_000;

type LockStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** True once there has been no input (here or in another tab) for longer than the idle limit. A limit of 0 never locks. */
export function shouldLock(nowMs: number, lastLocalInputMs: number, lastSharedInputMs: number, idleMs: number): boolean {
  return idleMs > 0 && nowMs - Math.max(lastLocalInputMs, lastSharedInputMs) > idleMs;
}

/** True in the last `warnMs` before the lock (and not yet locked). */
export function shouldWarn(nowMs: number, lastLocalInputMs: number, lastSharedInputMs: number, idleMs: number, warnMs = IDLE_WARNING_MS): boolean {
  if (!(idleMs > 0)) return false;
  const idleFor = nowMs - Math.max(lastLocalInputMs, lastSharedInputMs);
  return idleFor > Math.max(0, idleMs - warnMs) && idleFor <= idleMs;
}

/** Whole seconds left before the lock (0 when due or when the lock is off). */
export function secondsUntilLock(nowMs: number, lastLocalInputMs: number, lastSharedInputMs: number, idleMs: number): number {
  if (!(idleMs > 0)) return 0;
  const idleFor = nowMs - Math.max(lastLocalInputMs, lastSharedInputMs);
  return Math.max(0, Math.ceil((idleMs - idleFor) / 1000));
}

/** True while the person is still working (input in the last minute) and no request has gone out for the heartbeat interval. */
export function needsHeartbeat(nowMs: number, lastInputMs: number, lastRequestMs: number, intervalMs = HEARTBEAT_INTERVAL_MS): boolean {
  return nowMs - lastInputMs <= RECENT_INPUT_MS && nowMs - lastRequestMs > intervalMs;
}

/** True when the stored lock record belongs to `pinnedRef`. Anything missing or malformed is not a lock. */
export function readLock(storage: Pick<Storage, 'getItem'>, pinnedRef: string | null | undefined): boolean {
  if (!pinnedRef) return false;
  try {
    const raw = storage.getItem(LOCK_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ref?: unknown } | null;
    return typeof parsed?.ref === 'string' && parsed.ref === pinnedRef;
  } catch {
    return false;
  }
}

/** Stores the lock record for a session reference. */
export function writeLock(storage: Pick<Storage, 'setItem'>, ref: string, nowMs: number): void {
  try {
    storage.setItem(LOCK_KEY, JSON.stringify({ ref, at: nowMs }));
  } catch {
    // storage full or blocked: this tab is still locked in memory
  }
}

export function clearLock(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(LOCK_KEY);
  } catch {
    // nothing to clear
  }
}

/** The last input time other tabs recorded (0 when none). */
export function readActivity(storage: Pick<Storage, 'getItem'>): number {
  try {
    const n = Number(storage.getItem(ACTIVITY_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Records input for the other tabs, at most every 15 s. Returns the time of the last write (the caller passes it back next time). */
export function recordActivity(storage: Pick<Storage, 'setItem'>, nowMs: number, lastWrittenMs: number): number {
  if (nowMs - lastWrittenMs < ACTIVITY_WRITE_INTERVAL_MS) return lastWrittenMs;
  try {
    storage.setItem(ACTIVITY_KEY, String(nowMs));
  } catch {
    // storage full or blocked: the other tabs just do not see this input
  }
  return nowMs;
}

export function clearActivity(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(ACTIVITY_KEY);
  } catch {
    // nothing to clear
  }
}

/** The idle limit the server announced, in whole seconds; anything that is not a non-negative number means no client lock. */
export function parseIdleSeconds(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

const beforeLock = new Map<string, () => Promise<void>>();

/** Registers work that must finish before the screen locks (e.g. sending typed notes). Returns the unregister function. */
export function registerBeforeLock(id: string, fn: () => Promise<void>): () => void {
  beforeLock.set(id, fn);
  return () => {
    if (beforeLock.get(id) === fn) beforeLock.delete(id);
  };
}

/** Runs every registered hook and waits for them, but never longer than the timeout; a failing hook never blocks the lock. */
export async function runBeforeLock(timeoutMs = 3000): Promise<void> {
  const hooks = [...beforeLock.values()];
  if (hooks.length === 0) return;
  const work = Promise.allSettled(hooks.map(async (fn) => fn())).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function browserStorage(): LockStorage | null {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/** True while this tab's pinned session is locked (here or in another tab of the browser). */
export function isTabLocked(): boolean {
  const storage = browserStorage();
  return storage !== null && readLock(storage, tabSessionPin()?.ref ?? null);
}

/**
 * Resolves at once when this tab's session is not locked; otherwise when the lock is gone (the storage event, or a 1 s check).
 * For code that must not count requests refused during a lock as failures (e.g. onboarding after creating an organization).
 */
export function waitForUnlock(): Promise<void> {
  if (!isTabLocked()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      resolve();
    };
    const check = () => {
      if (!isTabLocked()) done();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LOCK_KEY) check();
    };
    const timer = setInterval(check, 1000);
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  });
}
