import crypto from 'crypto';
import type { CookieOptions, Request, Response } from 'express';
import { signLocalToken } from './localAuth';
import type { LocalUser } from './localUsers';

/** The session lives in an HttpOnly cookie scoped to the API; script in the page never sees the token. */
export const SESSION_COOKIE_NAME = 'pbc_session';
export const SESSION_COOKIE_PATH = '/api';
/** Request marker header the SPA sends on every API call: a cross-site form or image request cannot add it. Its value must be the cookie session's `sid` (the sessionRef). */
export const SESSION_MARKER_HEADER = 'x-pbc-session';

/** 403 body for a cookie-authenticated request that did not come from this application (CSRF defence). */
export const CSRF_REJECTED = { error: 'Forbidden: the request did not come from this application', reason: 'csrf_rejected' } as const;

export type SessionSubject = Pick<LocalUser, 'id' | 'email' | 'name' | 'tokenVersion' | 'mustChangePassword'>;

const MAX_COOKIE_VALUE_LENGTH = 4096;

/** The session token from the Cookie header, or null when there is none. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || !header) return null;
  const prefix = SESSION_COOKIE_NAME + '=';
  for (const part of header.split(';')) {
    const entry = part.trim();
    if (!entry.startsWith(prefix)) continue;
    const raw = entry.slice(prefix.length);
    if (!raw || raw.length > MAX_COOKIE_VALUE_LENGTH) return null;
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The application marker header (1 to 256 characters once trimmed), or null when it is missing, blank or too long. */
export function readSessionMarker(req: Request): string | null {
  const raw = req.headers[SESSION_MARKER_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length <= 256 ? value : null;
}

/** True when the request carries the application marker header (1 to 256 characters once trimmed). */
export function hasSessionMarker(req: Request): boolean {
  return readSessionMarker(req) !== null;
}

/** 401 body when the marker is not the session reference of the cookie it travels with (another tab replaced the session). */
export const SESSION_MISMATCH = {
  error: 'Unauthorized: this tab is not signed in to the session this browser holds',
  reason: 'session_mismatch',
} as const;

/** Constant-time check that the marker equals the cookie session's `sid`. False when either value is missing. */
export function markerMatchesSession(marker: string | null, sid: string | undefined): boolean {
  if (!marker || !sid) return false;
  const a = Buffer.from(marker, 'utf8');
  const b = Buffer.from(sid, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True when the browser says the request was initiated by another site (Sec-Fetch-Site other than same-origin / none). */
export function isCrossSiteRequest(req: Request): boolean {
  const raw = req.headers['sec-fetch-site'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return false;
  const site = value.trim().toLowerCase();
  return site !== 'same-origin' && site !== 'none';
}

/** Answers 403 csrf_rejected and returns true for a cross-site request. */
export function rejectCrossSite(req: Request, res: Response): boolean {
  if (!isCrossSiteRequest(req)) return false;
  res.status(403).json(CSRF_REJECTED);
  return true;
}

export function sessionCookieOptions(req: Request, maxAgeSeconds?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: SESSION_COOKIE_PATH,
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds * 1000 } : {}),
  };
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(req, maxAgeSeconds));
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(req));
}

/** Signs a session, sets it as the cookie and returns the body every session-issuing response shares (the token is never in the body). */
export function issueSession(req: Request, res: Response, user: SessionSubject, amr: string[], mfaEnrolled: boolean): Record<string, unknown> {
  const { token, claims } = signLocalToken({ id: user.id, email: user.email, name: user.name, tokenVersion: user.tokenVersion }, { amr });
  setSessionCookie(req, res, token, claims.exp - claims.iat);
  return {
    sessionRef: claims.sid,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    expiresIn: claims.exp - claims.iat,
    user: { id: user.id, email: user.email, name: user.name },
    mustChangePassword: user.mustChangePassword,
    mfaEnrolled,
  };
}
