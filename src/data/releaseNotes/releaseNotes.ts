/**
 * Release notes (issue #260): what changed in each release, in plain language for the people who use the platform. The data is
 * releaseNotes.json next to this file; it ships inside the image and nothing is fetched. The server counts unread notes and
 * validates the ref of "mark as read" against it, the client loads it lazily when the panel opens. Plain text only: the client
 * renders every string as a text node, so the format rejects angle brackets and control characters.
 *
 * Newest release first. A version bump in package.json needs an entry here (tests/releaseNotes.test.ts).
 */

export interface ReleaseNoteSection {
  heading: string;
  items: string[];
}

export interface ReleaseNote {
  version: string;
  date: string;
  summary: string;
  sections: ReleaseNoteSection[];
}

export interface ReleaseNotes {
  schemaVersion: 1;
  releases: ReleaseNote[];
}

export const RELEASE_NOTE_LIMITS = {
  summary: 300,
  heading: 80,
  item: 400,
  maxSections: 8,
  maxItems: 12,
} as const;

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Angle brackets and every control character (including a line break): the notes are one-line plain text. */
const FORBIDDEN_TEXT = /[<>\u0000-\u001F\u007F]/;

function fail(path: string, why: string): never {
  throw new Error(`Release notes: ${path} ${why}`);
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') return fail(path, 'must be a string');
  if (value.trim().length === 0) return fail(path, 'must not be empty');
  if (value.length > max) return fail(path, `must be at most ${max} characters`);
  if (FORBIDDEN_TEXT.test(value)) return fail(path, 'must be plain text without angle brackets, control characters or line breaks');
  return value;
}

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Orders two versions of the form major.minor.patch: negative when a is older, 0 when equal, positive when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Checks the shape and returns the notes, or throws naming the path of the first bad field. */
export function parseReleaseNotes(raw: unknown): ReleaseNotes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('(root)', 'must be an object');
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) return fail('schemaVersion', 'must be 1');
  if (!Array.isArray(root.releases) || root.releases.length === 0) return fail('releases', 'must be a non-empty array');
  const releases: ReleaseNote[] = [];
  root.releases.forEach((r: unknown, i: number) => {
    const p = `releases[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return fail(p, 'must be an object');
    const rec = r as Record<string, unknown>;
    if (typeof rec.version !== 'string' || !SEMVER.test(rec.version)) return fail(`${p}.version`, 'must look like 1.2.3');
    if (releases.some((x) => x.version === rec.version)) return fail(`${p}.version`, 'is listed twice');
    if (typeof rec.date !== 'string' || !isRealDate(rec.date)) return fail(`${p}.date`, 'must be a calendar date as YYYY-MM-DD');
    const summary = text(rec.summary, `${p}.summary`, RELEASE_NOTE_LIMITS.summary);
    if (!Array.isArray(rec.sections) || rec.sections.length < 1 || rec.sections.length > RELEASE_NOTE_LIMITS.maxSections) {
      return fail(`${p}.sections`, `must hold 1 to ${RELEASE_NOTE_LIMITS.maxSections} sections`);
    }
    const sections = rec.sections.map((s: unknown, j: number): ReleaseNoteSection => {
      const sp = `${p}.sections[${j}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(sp, 'must be an object');
      const sec = s as Record<string, unknown>;
      const heading = text(sec.heading, `${sp}.heading`, RELEASE_NOTE_LIMITS.heading);
      if (!Array.isArray(sec.items) || sec.items.length < 1 || sec.items.length > RELEASE_NOTE_LIMITS.maxItems) {
        return fail(`${sp}.items`, `must hold 1 to ${RELEASE_NOTE_LIMITS.maxItems} items`);
      }
      return { heading, items: sec.items.map((it: unknown, k: number) => text(it, `${sp}.items[${k}]`, RELEASE_NOTE_LIMITS.item)) };
    });
    releases.push({ version: rec.version, date: rec.date, summary, sections });
  });
  return { schemaVersion: 1, releases };
}

/** The versions that have notes, newest first as written. */
export function releaseVersions(notes: ReleaseNotes): string[] {
  return notes.releases.map((r) => r.version);
}

/** The badge number: the current version's notes when not yet read, plus every announcement not yet read. */
export function unreadCount(input: { currentVersion: string; readVersions: readonly string[]; announcements: ReadonlyArray<{ id: string; read: boolean }> }): number {
  const release = input.readVersions.includes(input.currentVersion) ? 0 : 1;
  return release + input.announcements.filter((a) => !a.read).length;
}
