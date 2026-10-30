/**
 * Fixed text for an invitation check that failed for a reason other than an unknown token (404 is handled as "invalid").
 * Never echoes the server's message or the token.
 */
export const INVITE_PREVIEW_UNREACHABLE = 'The server could not be reached, so the invitation was not checked. Check your connection, then try again.';
export const INVITE_PREVIEW_RATE_LIMITED = 'Too many invitation checks in a short time. Wait a minute, then try again.';
export const INVITE_PREVIEW_SERVER_ERROR = 'The server could not check the invitation right now. Try again in a few minutes. If it keeps failing, contact your administrator.';
export const INVITE_PREVIEW_FAILED = 'The invitation could not be checked. Try again, or ask your administrator for a new link.';

export function invitePreviewErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== 'number') return INVITE_PREVIEW_FAILED;
  if (status === 0) return INVITE_PREVIEW_UNREACHABLE;
  if (status === 429) return INVITE_PREVIEW_RATE_LIMITED;
  if (status >= 500) return INVITE_PREVIEW_SERVER_ERROR;
  return INVITE_PREVIEW_FAILED;
}
