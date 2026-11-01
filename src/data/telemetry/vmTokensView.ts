import type { VmServiceToken } from '../../types/vm';

/**
 * VM service tokens screen (#190): the pure helpers and copy of VmServiceTokensSection. Type imports only: no react, no storage, no logging.
 * The server limits (name 1-255 characters, 1-730 days, 10 active tokens per organization) are mirrored here and pinned against server/vm/tokens.ts.
 */

/** The screen always sends an expiry; the API alone would default to 365 days. */
export const VM_TOKEN_DEFAULT_DAYS = 90;
export const VM_TOKEN_MIN_DAYS = 1;
export const VM_TOKEN_MAX_DAYS = 730;
export const VM_TOKEN_NAME_MAX = 255;
export const VM_TOKEN_ACTIVE_LIMIT = 10;

export type VmTokenState = 'active' | 'revoked' | 'expired';

export const VM_TOKENS_COPY = {
  heading: 'VM service tokens',
  intro: 'A service token lets a scanner or the exporter push scan results for this organization, and nothing else.',
  notOwner: 'Only a Tenant Owner or MSP Admin can create or revoke service tokens.',
  browserOnly: 'Service tokens need a server-backed organization: this one is kept in this browser only.',
  loading: 'Loading service tokens…',
  loadError: 'The service tokens could not be loaded.',
  empty: 'No service tokens yet. Create one for each scanner or exporter that pushes results.',
  formHeading: 'New service token',
  nameLabel: 'Token name',
  nameHelp: 'What will use it, for example "Exporter on the scan host". Owners and admins of this organization can see the name.',
  nameRequired: 'Enter a token name.',
  nameTooLong: 'Use at most 255 characters.',
  nameControl: 'Remove line breaks and other control characters.',
  daysLabel: 'Expires after (days)',
  daysHelp: '1 to 730 days (default 90). Create a new token before this one expires.',
  daysError: 'Enter a whole number of days from 1 to 730.',
  create: 'Create token',
  creating: 'Creating…',
  oneTimeHeading: 'Copy the new token now',
  tokenFieldLabel: 'New service token',
  oneTimeWarning: 'This is the only time the token is shown: the server keeps only a hash of it. Closing this window, pressing "I have stored the token", switching organization, reloading or signing out removes it for good; if it is lost, revoke it and create a new one. Store it in the exporter\'s environment file (readable only by its service account, mode 0600), never on a command line, in a ticket or in email.',
  copy: 'Copy token',
  copiedShort: 'Copied',
  copied: 'Copied to the clipboard.',
  copyFailed: 'The browser blocked copying. The token is selected in the field: copy it with Ctrl+C (Cmd+C on a Mac).',
  done: 'I have stored the token',
  prefixSr: 'Starts with',
  neverUsed: 'Never',
  revoke: 'Revoke',
  confirmRevoke: 'Revoke token',
  revoking: 'Revoking…',
  cancel: 'Cancel',
  insecure: 'Service tokens can only be created over HTTPS. Open this app through its HTTPS address (the TLS reverse proxy) and try again.',
  limit: 'This organization already has 10 active service tokens. Revoke one it no longer uses, then create the new one.',
  forbidden: 'Only a Tenant Owner or MSP Admin can manage service tokens.',
  notFound: 'That token no longer exists. The list has been reloaded.',
  unreachable: 'The server could not be reached. Check the connection and try again.',
  failed: 'The request was not completed. Try again.',
} as const;

/** The name as sent to the server: trimmed. */
export const normalizeTokenName = (raw: string): string => raw.trim();

/** Why a token name is refused (the server rule: 1-255 characters after trimming, no control characters), or null when it is fine. */
export function tokenNameError(raw: string): string | null {
  const name = normalizeTokenName(raw);
  if (!name) return VM_TOKENS_COPY.nameRequired;
  if (name.length > VM_TOKEN_NAME_MAX) return VM_TOKENS_COPY.nameTooLong;
  if (/[\u0000-\u001f\u007f]/.test(name)) return VM_TOKENS_COPY.nameControl;
  return null;
}

/** A whole number of days from 1 to 730, or null. */
export function parseExpiryDays(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days >= VM_TOKEN_MIN_DAYS && days <= VM_TOKEN_MAX_DAYS ? days : null;
}

/** Revoked wins over expired. */
export function tokenState(token: Pick<VmServiceToken, 'revokedAt' | 'expiresAt'>, now: number): VmTokenState {
  if (token.revokedAt) return 'revoked';
  const expires = Date.parse(token.expiresAt);
  return Number.isFinite(expires) && expires <= now ? 'expired' : 'active';
}

export function tokenStateLabel(state: VmTokenState): string {
  return state === 'active' ? 'Active' : state === 'expired' ? 'Expired' : 'Revoked';
}

export const countActiveTokens = (tokens: Array<Pick<VmServiceToken, 'revokedAt' | 'expiresAt'>>, now: number): number =>
  tokens.filter((t) => tokenState(t, now) === 'active').length;

export function activeTokenCaption(active: number): string {
  if (active <= 0) return `No active tokens. An organization can have ${VM_TOKEN_ACTIVE_LIMIT}.`;
  const noun = active === 1 ? 'token' : 'tokens';
  const base = `${active} active ${noun} of the ${VM_TOKEN_ACTIVE_LIMIT} allowed`;
  return active >= VM_TOKEN_ACTIVE_LIMIT ? `${base}: revoke one before creating another.` : `${base}.`;
}

/** The non-secret display prefix, for telling tokens apart. */
export const tokenPrefixLabel = (prefix: string): string => `${prefix}…`;

export const revokeConfirmText = (name: string, prefix: string): string =>
  `Revoke "${name}" (${tokenPrefixLabel(prefix)})? Anything that pushes with it is refused from now on. This cannot be undone.`;

export const revokedMessage = (name: string): string => `"${name}" revoked. Anything that pushes with it is now refused.`;

export const newTokenFor = (name: string): string => `Token for "${name}"`;

export const createdByLabel = (createdBy: string): string => `by ${createdBy}`;

const errorParts = (err: unknown): { status: number; reason: string; message: string } => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown; message?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : -1,
    reason: typeof e.reason === 'string' ? e.reason : '',
    message: typeof e.message === 'string' ? e.message : '',
  };
};

/** The message for a failed create or revoke. The server's own text is shown only for a 400 (its validation message); never the token. */
export function vmTokenErrorMessage(err: unknown): string {
  const { status, reason, message } = errorParts(err);
  if (status === 403 && message === 'vm_insecure_transport') return VM_TOKENS_COPY.insecure;
  if (reason === 'limit') return VM_TOKENS_COPY.limit;
  if (status === 403) return VM_TOKENS_COPY.forbidden;
  if (status === 404) return VM_TOKENS_COPY.notFound;
  if (status === 0) return VM_TOKENS_COPY.unreachable;
  if (status === 400 && message) return message;
  return VM_TOKENS_COPY.failed;
}

/** The message for a failed list load. */
export function vmTokenLoadErrorMessage(err: unknown): string {
  const { status } = errorParts(err);
  if (status === 403) return VM_TOKENS_COPY.forbidden;
  if (status === 0) return VM_TOKENS_COPY.unreachable;
  return VM_TOKENS_COPY.loadError;
}
