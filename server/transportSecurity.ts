import type { NextFunction, Request, Response } from 'express';
import { isNonProductionEnv } from './runtimeEnv';
import { getOllamaConfig } from './ssp/ollama';

/**
 * Transport security (#166). The app speaks plain HTTP and relies on a TLS reverse proxy (TRUST_PROXY names it). REQUIRE_TLS=true
 * refuses every request that did not arrive over HTTPS as seen through that proxy; the startup warnings flag the two setups
 * that put CUI on the wire in clear text. Nothing here logs, and no message names a host.
 */

const blank = (v: string | undefined): boolean => (v ?? '').trim() === '';

/** REQUIRE_TLS is on for "true" or "1" (trimmed, case-insensitive). */
export function isRequireTls(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.REQUIRE_TLS ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Startup validation: a malformed REQUIRE_TLS, or REQUIRE_TLS without a trusted proxy (every request would be refused). */
export function assertRequireTlsConfig(env: NodeJS.ProcessEnv = process.env): void {
  const v = (env.REQUIRE_TLS ?? '').trim().toLowerCase();
  if (v !== '' && !['true', 'false', '1', '0'].includes(v)) {
    throw new Error('REQUIRE_TLS must be true or false');
  }
  if (isRequireTls(env) && blank(env.TRUST_PROXY)) {
    throw new Error(
      "REQUIRE_TLS=true needs TRUST_PROXY: the app speaks plain HTTP and sees HTTPS only through a trusted TLS proxy, so every request would be refused. Set TRUST_PROXY to the proxy's address (docs/GO_LIVE_CHECKLIST.md)."
    );
  }
}

const HEALTH_PATH = /^\/api\/v1\/health\/?$/i;
const API_PATH = /^\/api(\/|$)/i;
const SAFE_HOSTNAME = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i;

/**
 * Express middleware. Off, or `req.secure` (true only through a trusted proxy that sent X-Forwarded-Proto: https): next().
 * Otherwise GET/HEAD /api/v1/health stays open (the container health check), the API and every non-GET/HEAD request get a
 * 403 `tls_required`, and a page load is redirected to https:// on the same host.
 */
export function createRequireTls(env: NodeJS.ProcessEnv = process.env) {
  const on = isRequireTls(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!on || req.secure) return next();
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (readOnly && HEALTH_PATH.test(req.path)) return next();
    if (API_PATH.test(req.path) || !readOnly) {
      res.status(403).json({ error: 'HTTPS is required', code: 'tls_required' });
      return;
    }
    const host = req.hostname;
    if (typeof host !== 'string' || !SAFE_HOSTNAME.test(host)) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    res.redirect(301, `https://${host}${req.originalUrl}`);
  };
}

/** One warning: listening on every interface in production with no TLS proxy declared. */
export function transportWarnings(env: NodeJS.ProcessEnv, bindAddress: string): string[] {
  if (isNonProductionEnv(env) || !blank(env.TRUST_PROXY)) return [];
  if (bindAddress !== '0.0.0.0' && bindAddress !== '::') return [];
  return [
    'Listening on all interfaces in production without TRUST_PROXY: the app speaks plain HTTP, so passwords and session cookies cross the network unencrypted unless a TLS reverse proxy fronts it. Put one in front and set TRUST_PROXY (docs/GO_LIVE_CHECKLIST.md).',
  ];
}

/** One warning: SSP text would be sent to another machine over plain HTTP. Loopback, a bare service name and https are fine. */
export function ollamaTransportWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const cfg = getOllamaConfig(env);
  if (!cfg.enabled) return [];
  let url: URL;
  try {
    url = new URL(cfg.baseUrl);
  } catch {
    return [];
  }
  if (url.protocol === 'https:') return [];
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return [];
  if (!host.includes('.') && !host.includes(':')) return []; // a bare single label: the bundled docker service
  if (host === 'host.docker.internal') return [];
  return [
    'OLLAMA_BASE_URL points at another machine over plain HTTP: SSP text would cross the network unencrypted. Use the bundled ollama service, loopback, or an https:// URL (docs/GO_LIVE_CHECKLIST.md).',
  ];
}
