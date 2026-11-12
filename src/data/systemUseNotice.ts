/**
 * System use notification (issue #256, NIST 800-171 3.1.9 / 800-53 AC-8): the text shown before sign-in, and what people must
 * acknowledge. One platform-wide notice, edited by a platform administrator. Pure and shared: the server imports it for the default text,
 * the limit and the text check; the browser for the parse, the gate view and the editor check. The text is public by design (it is
 * shown before anyone signs in): it is still never logged, and account events carry only its version.
 */

/** The longest notice a platform administrator can save, in characters (the database CHECK says the same). */
export const SYSTEM_USE_NOTICE_MAX = 4000;

/** Default wording for a contractor-operated system. Line breaks are `\n`; the browser renders it as plain text. */
export const DEFAULT_SYSTEM_USE_NOTICE = [
  'You are accessing an information system that may store, process or transmit Controlled Unclassified Information (CUI) and Federal Contract Information (FCI). It is provided for authorized use only.',
  '',
  'By using this system (which includes any device attached to it), you consent to the following conditions:',
  '- The operator routinely monitors, intercepts and records activity on this system for purposes including security monitoring, network operations and defense, incident response, personnel misconduct and law enforcement investigations.',
  '- At any time, the operator may inspect and seize data stored on this system.',
  '- Communications using, or data stored on, this system are not private, are subject to routine monitoring, interception and search, and may be disclosed or used for any authorized purpose.',
  "- This system includes security measures (for example, authentication and access controls) to protect the operator's and the U.S. Government's interests, not for your personal benefit or privacy.",
  '- Unauthorized use may result in disciplinary action and civil and criminal penalties.',
].join('\n');

/** What the public endpoint returns. `version` is 0 until a platform administrator first saves the notice, then counts up on every save. */
export interface SystemUseNotice {
  enabled: boolean;
  text: string;
  version: number;
}

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A well-formed public notice, or null. An enabled notice with blank text shows the default text. */
export function parseSystemUseNotice(data: unknown): SystemUseNotice | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { enabled, text, version } = data as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || typeof text !== 'string' || !isVersion(version)) return null;
  return { enabled, text: enabled && text.trim() === '' ? DEFAULT_SYSTEM_USE_NOTICE : text, version };
}

export type NoticeLoad = { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; notice: SystemUseNotice };
export type NoticeGateView = 'loading' | 'failed' | 'notice' | 'form';

/** What the sign-in gate shows. Fails closed: nothing but the notice, a loading state or the failure until the notice is known and acknowledged. */
export function noticeGateView(load: NoticeLoad, ackVersion: number | null): NoticeGateView {
  if (load.kind === 'loading') return 'loading';
  if (load.kind === 'failed') return 'failed';
  if (!load.notice.enabled) return 'form';
  return ackVersion !== null && ackVersion === load.notice.version ? 'form' : 'notice';
}

export const SYSTEM_USE_NOTICE_LOAD_FAILED =
  'The system use notice could not be loaded, so sign-in is not available yet. Check the connection to the server and try again.';

/** Control characters other than a line break and a tab (C0 and DEL). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/** The text as stored: line breaks normalised to `\n`, surrounding whitespace removed. */
export function normalizeNoticeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Why a notice text cannot be saved, or null. Used by the server (the rule) and by the editor (the early message). */
export function noticeTextProblem(text: string): string | null {
  const normalized = normalizeNoticeText(text);
  if (normalized.length === 0) return 'Enter the notice text, or turn the notice off.';
  if (normalized.length > SYSTEM_USE_NOTICE_MAX) return `The notice can be at most ${SYSTEM_USE_NOTICE_MAX} characters.`;
  if (CONTROL_CHARS.test(normalized)) return 'The notice text contains control characters.';
  return null;
}

/** The editor's check: the server stores a text (1 to `maxLength` characters) whether the notice is on or off. */
export function validateNoticeDraft(_enabled: boolean, text: string, maxLength: number = SYSTEM_USE_NOTICE_MAX): string | null {
  if (normalizeNoticeText(text).length > maxLength) return `The notice can be at most ${maxLength} characters.`;
  return noticeTextProblem(text);
}
