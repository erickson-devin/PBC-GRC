/**
 * Helpers for the tenant's free-text `systemOwner` field (shown in the SSP).
 * Pure functions: nothing here invents an address or touches the server.
 */

/**
 * Pull an email out of "Alex <a@x.test>", "Alex (a@x.test)" or a bare email.
 * Returns '' when the candidate is not an email (e.g. "Alex (CISO)").
 */
export function extractOwnerEmail(systemOwner: string | undefined): string {
  const raw = (systemOwner || '').trim();
  const match = raw.match(/<([^>]+)>|\(([^)]+)\)/);
  const candidate = (match ? (match[1] || match[2]) : raw).trim();
  return candidate.includes('@') && !/\s/.test(candidate) ? candidate : '';
}

/** Pre-fill for the owner contact field: the extracted email, otherwise empty. */
export function initialOwnerEmail(t: { systemOwner?: string }): string {
  return extractOwnerEmail(t.systemOwner);
}

/** True only when the user typed a non-empty value that differs from the pre-fill (trimmed, case-insensitive). */
export function ownerEmailChanged(initial: string, next: string): boolean {
  const n = next.trim();
  return n !== '' && n.toLowerCase() !== initial.trim().toLowerCase();
}
