import crypto from 'crypto';

/**
 * Pure TOTP (RFC 6238) / HOTP (RFC 4226) core: no environment, no I/O, no clock of its own (the caller passes `nowMs`).
 * Also the recovery-code generator and normalizer. Secrets are never logged here.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer, opts: { padding?: boolean } = {}): string {
  const padding = opts.padding ?? true;
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  if (padding) while (out.length % 8 !== 0) out += '=';
  return out;
}

/** Case-insensitive; ignores spaces and '='; throws on any other character. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number, period: number = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

export function generateTotp(secret: Buffer, nowMs: number, opts: { period?: number; digits?: number } = {}): string {
  return hotp(secret, totpStep(nowMs, opts.period), opts.digits);
}

export type VerifyTotpResult = { ok: true; step: number } | { ok: false; reason: 'malformed' | 'mismatch' | 'replayed' };

/**
 * Checks a user-supplied code against steps now-window..now+window. Every candidate is compared in constant time with
 * no early exit. A match at or below `lastUsedStep` is a replay.
 */
export function verifyTotp(
  secret: Buffer,
  code: unknown,
  opts: { nowMs: number; lastUsedStep: number | null; window?: number; period?: number; digits?: number }
): VerifyTotpResult {
  const digits = opts.digits ?? TOTP_DIGITS;
  if (typeof code !== 'string') return { ok: false, reason: 'malformed' };
  const cleaned = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return { ok: false, reason: 'malformed' };

  const window = opts.window ?? TOTP_WINDOW;
  const current = totpStep(opts.nowMs, opts.period);
  const given = Buffer.from(cleaned, 'utf8');
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const candidate = Buffer.from(hotp(secret, step, digits), 'utf8');
    if (crypto.timingSafeEqual(candidate, given) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (opts.lastUsedStep !== null && matched <= opts.lastUsedStep) return { ok: false, reason: 'replayed' };
  return { ok: true, step: matched };
}

export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(TOTP_SECRET_BYTES);
}

export function buildOtpauthUri(i: { issuer: string; accountName: string; secretBase32: string }): string {
  if (i.issuer.includes(':')) throw new Error('The issuer must not contain a colon');
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(i.issuer)}:${enc(i.accountName)}?secret=${i.secretBase32}&issuer=${enc(i.issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

// ----------------------------------------------------------------------------- recovery codes

/** Crockford base32: 32 symbols, no I, L, O or U, so a code read aloud or off paper is hard to mistype. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_SYMBOLS = 10;

function randomRecoveryCode(): string {
  const bytes = crypto.randomBytes(RECOVERY_SYMBOLS);
  // 32 divides 256, so masking the low five bits is unbiased.
  const symbols = Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31]).join('');
  return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
}

/** `count` unique codes formatted XXXXX-XXXXX. */
export function generateRecoveryCodes(count = 8): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(randomRecoveryCode());
  return [...codes];
}

/** Uppercases, maps I/L to 1 and O to 0, strips hyphens and whitespace; returns the 10-symbol string or null. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[-\s]/g, '');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(s) ? s : null;
}
