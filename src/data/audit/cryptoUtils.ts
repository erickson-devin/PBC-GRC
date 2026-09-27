/**
 * Event Horizon: Singularity — Environment-Agnostic Cryptographic Utilities
 *
 * Provides a browser-safe SHA-256 implementation with zero Node.js `crypto`
 * module imports. Uses the Web Crypto API (globalThis.crypto.subtle), which is
 * available natively in:
 *  - All modern browsers (Chrome, Firefox, Safari, Edge)
 *  - Node.js 18+ (via globalThis.crypto — no import needed)
 *  - Deno, Bun, Cloudflare Workers
 *
 * Falls back to a deterministic pure-JS djb2 polynomial hash when Web Crypto
 * is unavailable (e.g. very old Node test runners, non-HTTPS localhost).
 * The fallback is clearly prefixed `sim_hash_` so it is identifiable in logs.
 */

/**
 * Computes a hex-encoded SHA-256 digest of the given UTF-8 string.
 *
 * Execution path priority:
 *  1. `globalThis.crypto.subtle` — Web Crypto API (browser & Node 18+)
 *  2. Pure-JS polynomial fallback — prefixed `sim_hash_` for traceability
 *
 * No Node.js `crypto` module is ever imported, keeping the browser bundle clean.
 */
export async function computeSha256(text: string): Promise<string> {
  // Web Crypto API: available in all modern browsers and Node.js 18+
  const subtle =
    typeof globalThis !== 'undefined' &&
    (globalThis as any).crypto?.subtle
      ? (globalThis as any).crypto.subtle
      : typeof crypto !== 'undefined' && crypto.subtle
      ? crypto.subtle
      : null;

  if (subtle && typeof TextEncoder !== 'undefined') {
    try {
      const encoded = new TextEncoder().encode(text);
      const hashBuffer = await subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fall through to pure-JS fallback on unexpected errors
    }
  }

  // Pure-JS djb2 polynomial fallback — no external dependencies
  // Clearly prefixed so callers can detect non-cryptographic hashes in logs
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (((h << 5) + h) ^ text.charCodeAt(i)) >>> 0;
  }
  return `sim_hash_${h.toString(16).padStart(8, '0')}_${text.length.toString(16).padStart(8, '0')}`;
}

/**
 * Deterministically serializes objects with recursively sorted keys.
 * Used to produce canonical, tamper-evident JSON payloads for hash chaining.
 */
export function canonicalJson(val: unknown): string {
  if (val === null || val === undefined || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + (val as unknown[]).map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(val as object).sort();
  return (
    '{' +
    keys
      .map(k => `${JSON.stringify(k)}:${canonicalJson((val as Record<string, unknown>)[k])}`)
      .join(',') +
    '}'
  );
}
