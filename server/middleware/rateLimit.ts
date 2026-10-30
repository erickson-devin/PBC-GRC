import { Request, Response, NextFunction } from 'express';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Bucket key (default: the client address), e.g. per service token. */
  key?: (req: Request) => string;
  /** Clock (tests). */
  now?: () => number;
  /** At or above this many keys, a new key first sweeps expired windows (at most once per window). Default 10,000. */
  sweepAbove?: number;
  /** Hard cap: a new key past it evicts the key whose current window started first. Default 50,000. Never a full clear. */
  maxKeys?: number;
}

/**
 * Small in-memory sliding-window limiter, keyed by client address. It is a speed bump for unauthenticated endpoints
 * (invitation preview / accept, setup, VM ingest); the real protection for those is credential entropy.
 * `key` overrides the bucket (default: the client address), e.g. to limit per service token. `reset()` exists for tests.
 * Bounded memory: expired windows are swept, and past the cap the oldest window is evicted, never a full clear
 * (a spray of fresh addresses must not reset the bucket of an address that is already limited).
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const now = options.now ?? Date.now;
  const sweepAbove = options.sweepAbove ?? 10_000;
  const maxKeys = options.maxKeys ?? 50_000;
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
  // Map order = the order in which each key's current window started (a key that starts a new window moves to the end)
  const hits = new Map<string, number[]>();
  let lastSweep = -Infinity;

  function makeRoom(t: number): void {
    // Sweeping is O(keys): at most once per window, so a spray cannot make every request pay for it
    if (hits.size >= sweepAbove && t - lastSweep >= options.windowMs) {
      lastSweep = t;
      for (const [k, list] of hits) if (t - list[list.length - 1] >= options.windowMs) hits.delete(k);
    }
    while (hits.size >= maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  function hit(key: string): { limited: boolean; retryAfterSeconds: number } {
    const t = now();
    const previous = hits.get(key);
    const recent = (previous ?? []).filter((h) => t - h < options.windowMs);
    if (recent.length === 0) {
      if (previous) hits.delete(key);
      makeRoom(t);
    }
    recent.push(t);
    // Only the newest max+1 hits can decide "limited", so older ones are dropped (bounded memory per key, same answer)
    if (recent.length > options.max + 1) recent.splice(0, recent.length - options.max - 1);
    hits.set(key, recent);
    return { limited: recent.length > options.max, retryAfterSeconds };
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const result = hit(options.key ? options.key(req) : req.ip || 'unknown');
    if (result.limited) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      return;
    }
    next();
  };

  return Object.assign(middleware, { hit, reset: () => hits.clear(), size: () => hits.size });
}
