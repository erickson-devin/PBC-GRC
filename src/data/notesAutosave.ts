// Implementation notes are typed one key at a time. This module holds the pure parts of saving them: a debounce that keeps one draft
// per control (so a burst of keystrokes becomes one PUT), a per-key queue that keeps a control's saves in order, and the rule for
// which server timestamp is the newer. Nothing here touches storage, the network or the ledger, and it never logs: a draft is notes text.

export const NOTES_AUTOSAVE_DELAY_MS = 1500;

export interface AutosaveScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const browserScheduler: AutosaveScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface NotesDraft {
  controlId: string;
  programId: string | undefined;
  updatedBy: string;
  /** The text before the burst of edits began (for the ledger's before-digest). */
  previous: string;
  /** The latest text. */
  text: string;
}

/** One draft per control per program: the key joins the scope and the control id. */
export function notesKey(scope: string, controlId: string): string {
  return `${scope}::${controlId}`;
}

export interface NotesAutosave {
  push(key: string, draft: NotesDraft): void;
  /** Sends the pending draft of `key` now. True when there was one. */
  flush(key: string): boolean;
  /** Sends every pending draft now. Returns how many were sent. */
  flushAll(): number;
  /** Drops the pending draft of `key` without sending it. */
  cancel(key: string): void;
  has(key: string): boolean;
  size(): number;
}

interface Pending {
  draft: NotesDraft;
  handle: unknown;
}

export function createNotesAutosave(
  send: (key: string, draft: NotesDraft) => void,
  opts: { delayMs?: number; scheduler?: AutosaveScheduler } = {}
): NotesAutosave {
  const delayMs = opts.delayMs ?? NOTES_AUTOSAVE_DELAY_MS;
  const scheduler = opts.scheduler ?? browserScheduler;
  const pending = new Map<string, Pending>();

  const fire = (key: string): boolean => {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    scheduler.clear(entry.handle);
    send(key, entry.draft);
    return true;
  };

  return {
    push(key, draft) {
      const existing = pending.get(key);
      if (existing) scheduler.clear(existing.handle);
      // A burst keeps the text it started from and the latest of everything else
      const merged: NotesDraft = existing ? { ...draft, previous: existing.draft.previous } : draft;
      const handle = scheduler.set(() => { fire(key); }, delayMs);
      pending.set(key, { draft: merged, handle });
    },
    flush: fire,
    flushAll() {
      let sent = 0;
      for (const key of Array.from(pending.keys())) {
        if (fire(key)) sent++;
      }
      return sent;
    },
    cancel(key) {
      const entry = pending.get(key);
      if (!entry) return;
      scheduler.clear(entry.handle);
      pending.delete(key);
    },
    has: key => pending.has(key),
    size: () => pending.size,
  };
}

export interface SaveChain {
  /** Runs `task` after the earlier tasks of `key` have settled; a rejected task does not block the next. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  busy(key: string): boolean;
  /** How many keys have a save running or waiting. */
  active(): number;
}

export function createSaveChain(): SaveChain {
  const tails = new Map<string, Promise<unknown>>();
  const counts = new Map<string, number>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prior = tails.get(key) ?? Promise.resolve();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const result = prior.then(task, task);
      const done = () => {
        const left = (counts.get(key) ?? 1) - 1;
        if (left <= 0) counts.delete(key);
        else counts.set(key, left);
      };
      // Registered before the caller's own continuation, so `busy` is already false when `await run(...)` resumes
      tails.set(key, result.then(done, done));
      return result;
    },
    busy: key => counts.has(key),
    active: () => counts.size,
  };
}

export interface StampedSaveChain {
  /** Like SaveChain.run, but `send` is given the stamp to expect: the later of the last answer's `updatedAt` for `key` and `liveStamp()` at the time it runs. */
  run<T extends { updatedAt?: string | null } | null | undefined>(
    key: string,
    liveStamp: () => string | null | undefined,
    send: (expected: string | null | undefined) => Promise<T>
  ): Promise<T>;
  busy(key: string): boolean;
  /** Forgets the stamps only; saves already queued still run. */
  clear(): void;
}

export function createStampedSaveChain(): StampedSaveChain {
  const chain = createSaveChain();
  const stamps = new Map<string, string>();
  return {
    run<T extends { updatedAt?: string | null } | null | undefined>(
      key: string,
      liveStamp: () => string | null | undefined,
      send: (expected: string | null | undefined) => Promise<T>
    ): Promise<T> {
      return chain.run(key, async () => {
        // Read when this save's turn comes, after the earlier ones have answered
        const base = newerStamp(stamps.get(key), liveStamp());
        const rec = await send(base);
        // A rejected save never gets here: its stamp stays as it was
        if (rec && typeof rec.updatedAt === 'string') stamps.set(key, rec.updatedAt);
        return rec;
      });
    },
    busy: key => chain.busy(key),
    clear: () => stamps.clear(),
  };
}

const stampTime = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** The later of two server timestamps (an unparseable one counts as absent). When neither is a string: `b` unless it is undefined, else `a`. */
export function newerStamp(a: string | null | undefined, b: string | null | undefined): string | null | undefined {
  const ta = stampTime(a);
  const tb = stampTime(b);
  if (ta === null && tb === null) {
    if (typeof a !== 'string' && typeof b !== 'string') return b !== undefined ? b : a;
    return typeof b === 'string' ? b : a;
  }
  if (ta === null) return b;
  if (tb === null) return a;
  return tb >= ta ? b : a;
}
