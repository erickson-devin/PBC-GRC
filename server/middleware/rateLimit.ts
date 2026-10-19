import { Request, Response, NextFunction } from 'express';

/**
 * Small in-memory fixed-window limiter, keyed by client address. It is a speed bump for unauthenticated endpoints
 * (invitation preview / accept); the real protection for those is that tokens carry 256 bits of entropy.
 * `key` overrides the bucket (default: the client address), e.g. to limit per service token. `reset()` exists for tests.
 */
export function createRateLimiter(options: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, number[]>();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = options.key ? options.key(req) : req.ip || 'unknown';
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear(); // bound memory under a spray from many addresses

    if (recent.length > options.max) {
      res.setHeader('Retry-After', String(Math.ceil(options.windowMs / 1000)));
      res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      return;
    }
    next();
  };

  return Object.assign(middleware, { reset: () => hits.clear() });
}
