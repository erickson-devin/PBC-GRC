import fs from 'fs';
import path from 'path';
import releaseNotesFile from '../src/data/releaseNotes/releaseNotes.json';
import { RELEASE_NOTE_LIMITS, compareVersions, parseReleaseNotes, releaseVersions, unreadCount } from '../src/data/releaseNotes/releaseNotes';

/**
 * Release notes (issue #260), no server: the shipped file is valid, the newest entry is the current package.json version (a version bump
 * without notes fails here), the text is plain, and the helpers behave. The notes for a release are written in the release change.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const throws = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const root = process.cwd();
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;

console.log('--- R1 to R4: the shipped notes ---');
let notes: ReturnType<typeof parseReleaseNotes> | null = null;
const parseError = throws(() => {
  notes = parseReleaseNotes(releaseNotesFile);
});
assert(parseError === null && notes !== null, 'R1: releaseNotes.json parses with no error', parseError);
const releases = (notes as ReturnType<typeof parseReleaseNotes> | null)?.releases ?? [];
assert(releases[0]?.version === pkgVersion, 'R2: releases[0].version is the package.json version (a version bump needs notes)', [releases[0]?.version, pkgVersion]);
const versions = releaseVersions({ schemaVersion: 1, releases });
assert(new Set(versions).size === versions.length && versions.every((v, i) => i === 0 || compareVersions(versions[i - 1], v) > 0), 'R3: versions are unique and strictly newest first', versions);
const strings: string[] = [];
for (const r of releases) {
  strings.push(r.version, r.date, r.summary);
  for (const s of r.sections) strings.push(s.heading, ...s.items);
}
assert(strings.length > 0 && strings.every((s) => !/[<>\u0000-\u001f\u007f]/.test(s)), 'R4: no string holds an angle bracket, a control character or a line break');

console.log('\n--- R5 to R7: the helpers ---');
assert(compareVersions('0.10.0', '0.9.9') > 0 && compareVersions('1.0.0', '0.99.99') > 0 && compareVersions('0.5.0', '0.5.0') === 0 && compareVersions('0.5.1', '0.6.0') < 0, 'R5: compareVersions compares numerically, not as text');
assert(unreadCount({ currentVersion: '0.5.0', readVersions: [], announcements: [{ id: 'a', read: false }] }) === 2, 'R6: unread = the unread current notes + every unread announcement (2)');
assert(
  unreadCount({ currentVersion: '0.5.0', readVersions: ['0.5.0'], announcements: [{ id: 'a', read: false }] }) === 1 &&
    unreadCount({ currentVersion: '0.5.0', readVersions: ['0.4.0'], announcements: [{ id: 'a', read: true }] }) === 1 &&
    unreadCount({ currentVersion: '0.5.0', readVersions: ['0.5.0'], announcements: [{ id: 'a', read: true }] }) === 0,
  'R6: reading the notes or the announcement lowers the count; an older version read does not count'
);

const good = { version: '1.0.0', date: '2027-01-01', summary: 's', sections: [{ heading: 'h', items: ['i'] }] };
const withRelease = (patch: Record<string, unknown>) => ({ schemaVersion: 1, releases: [{ ...good, ...patch }] });
assert(parseReleaseNotes({ schemaVersion: 1, releases: [good] }).releases.length === 1, 'R7: a minimal valid file parses');
const bad: Array<[string, unknown, string]> = [
  ['a two-part version', withRelease({ version: '1.0' }), 'releases[0].version'],
  ['an impossible date', withRelease({ date: '2027-02-30' }), 'releases[0].date'],
  ['a summary over the limit', withRelease({ summary: 'x'.repeat(RELEASE_NOTE_LIMITS.summary + 1) }), 'releases[0].summary'],
  ['an angle bracket', withRelease({ sections: [{ heading: 'h', items: ['a <b> c'] }] }), 'releases[0].sections[0].items[0]'],
  ['a line break', withRelease({ sections: [{ heading: 'h\nx', items: ['i'] }] }), 'releases[0].sections[0].heading'],
  ['no sections', withRelease({ sections: [] }), 'releases[0].sections'],
  ['an empty item list', withRelease({ sections: [{ heading: 'h', items: [] }] }), 'releases[0].sections[0].items'],
  ['13 items', withRelease({ sections: [{ heading: 'h', items: Array.from({ length: 13 }, () => 'i') }] }), 'releases[0].sections[0].items'],
  ['9 sections', withRelease({ sections: Array.from({ length: 9 }, () => ({ heading: 'h', items: ['i'] })) }), 'releases[0].sections'],
  ['a duplicate version', { schemaVersion: 1, releases: [good, good] }, 'releases[1].version'],
  ['schemaVersion 2', { schemaVersion: 2, releases: [good] }, 'schemaVersion'],
  ['no releases', { schemaVersion: 1, releases: [] }, 'releases'],
];
for (const [name, value, where] of bad) {
  const msg = throws(() => parseReleaseNotes(value));
  assert(msg !== null && msg.includes(where), `R7: ${name} throws and names ${where}`, msg);
}
assert(throws(() => parseReleaseNotes(null)) !== null && throws(() => parseReleaseNotes('x')) !== null, 'R7: a non-object throws');

console.log('\n--- R8: source checks ---');
const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), out);
    else out.push(path.join(dir, e.name));
  }
  return out;
};
const clientFiles = walk(path.join(root, 'src', 'components')).filter((f) => /(WhatsNew|AnnouncementsSection)/.test(path.basename(f)));
assert(clientFiles.every((f) => !fs.readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML')), 'R8: no WhatsNew or AnnouncementsSection component uses dangerouslySetInnerHTML', clientFiles.map((f) => path.basename(f)));
const server = fs.readFileSync(path.join(root, 'server', 'routes', 'notices.ts'), 'utf8');
assert(!/\bfetch\(|https?:\/\//.test(server.replace(/\/\*[\s\S]*?\*\//g, '')), 'R8: the notices route fetches nothing (the notes ship in the image)');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
