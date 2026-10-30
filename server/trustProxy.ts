import type { NextFunction, Request, Response } from 'express';

/**
 * Parses the TRUST_PROXY environment variable for `app.set('trust proxy', value)`.
 *
 * Express honours X-Forwarded-* headers (client address, protocol) only from the addresses named here. A boolean or a hop
 * count would let a client that reaches the app port directly forge those headers, so both are refused: name the proxy.
 * Accepts an IP, a CIDR, a comma-separated list of them, or a proxy-addr subnet name such as `loopback`. Express / proxy-addr
 * validates the entries themselves.
 */
export function parseTrustProxy(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (/^(true|false)$/i.test(value) || /^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY must be the proxy address (IP, CIDR or comma-separated list), not a boolean or hop count');
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).join(',');
}

/**
 * Express middleware that warns once when requests carry X-Forwarded-For but TRUST_PROXY is unset: every client behind
 * the proxy then shares the proxy's address, and so one sign-in throttle bucket. The header value is never printed.
 */
export function createForwardedForWarning(warn: (message: string) => void = console.warn) {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined && !req.app.get('trust proxy')) {
      warned = true;
      warn(
        "[Proxy] Requests carry X-Forwarded-For but TRUST_PROXY is unset: every client behind the proxy shares one address for the sign-in throttle. Set TRUST_PROXY to the proxy's address (docs/ON_PREM_DATABASE.md)."
      );
    }
    next();
  };
}
