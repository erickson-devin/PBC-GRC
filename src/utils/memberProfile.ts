/**
 * Membership profile fields (issues #258, #259): an access expiry date, an affiliation, an optional US person flag and a primary
 * contact. Pure helpers shared by the server and the client; they take the time as an argument and never read the clock.
 *
 * An expiry is a calendar DATE. Access lasts until the END of that day in UTC (allowed while now < the next UTC midnight); the
 * server's local time is never used. A malformed stored value counts as expired (fail closed).
 */

/** EMPLOYEE, CONTRACTOR, ESP (external service provider). */
export const AFFILIATIONS = ['EMPLOYEE', 'CONTRACTOR', 'ESP'] as const;
export type Affiliation = (typeof AFFILIATIONS)[number];

/** A null value means "not recorded". Recorded by an owner only, never self-declared. */
export const US_PERSON_VALUES = ['US_PERSON', 'OTHER'] as const;
export type UsPerson = (typeof US_PERSON_VALUES)[number];

/** The furthest an expiry date may lie from today (about ten years). */
export const MAX_EXPIRY_DAYS = 3653;

const DAY_MS = 86_400_000;

export function isAffiliation(v: unknown): v is Affiliation {
  return typeof v === 'string' && (AFFILIATIONS as readonly string[]).includes(v);
}

export function isUsPerson(v: unknown): v is UsPerson {
  return typeof v === 'string' && (US_PERSON_VALUES as readonly string[]).includes(v);
}

/** 'YYYY-MM-DD' naming a real calendar day (a Date.UTC round trip), else null. */
export function parseExpiryDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps years 0 to 99 to 1900 to 1999, so the round trip also rejects those.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return v;
}

/** The first instant after the expiry day (next UTC midnight), or null when the value is malformed. */
export function accessEndsAtMs(expiresOn: string): number | null {
  const ok = parseExpiryDate(expiresOn);
  if (ok === null) return null;
  const [y, m, d] = ok.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1);
}

/** No expiry (null or undefined) never expires; a malformed value is expired; otherwise expired from the next UTC midnight. */
export function membershipExpired(expiresOn: string | null | undefined, nowMs: number): boolean {
  if (expiresOn === null || expiresOn === undefined) return false;
  const ends = accessEndsAtMs(expiresOn);
  return ends === null || nowMs >= ends;
}

/** Today in UTC as 'YYYY-MM-DD'. */
export function utcToday(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Validates a NEW expiry date: a real date, not before today (UTC), and at most MAX_EXPIRY_DAYS ahead. Today itself is allowed. */
export function checkNewExpiry(v: string, nowMs: number): null | 'invalid_request' | 'expiry_in_past' | 'expiry_too_far' {
  const ok = parseExpiryDate(v);
  if (ok === null) return 'invalid_request';
  const dayMs = Date.parse(`${ok}T00:00:00.000Z`);
  const todayMs = Date.parse(`${utcToday(nowMs)}T00:00:00.000Z`);
  if (dayMs < todayMs) return 'expiry_in_past';
  if (dayMs - todayMs > MAX_EXPIRY_DAYS * DAY_MS) return 'expiry_too_far';
  return null;
}
