import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnsavedTextEntries, UnsavedTextSummary, isAiDraftEntry, unsavedFieldCount } from '../src/components/auth/UnsavedTextPanel';
import {
  canRevealRescued,
  collectUnsavedText,
  discardRescuedText,
  formatRescuedText,
  getRescuedText,
  reconcileRescuedTextOnSignIn,
  registerUnsavedTextProvider,
  rescueUnsavedText,
  resetUnsavedText,
  subscribeRescuedText,
  unsavedControlNotes,
  unsavedObjectiveDrafts,
  unsavedProgramFields,
  unsavedSspImportDrafts,
  type UnsavedTextEntry,
} from '../src/services/unsavedText';

/**
 * Unsaved text kept in memory when a session ends: the registry, the rescue store and who may see it, the diff helpers, and
 * the wiring in the source (nothing writes it anywhere). Pure test: no server, no browser.
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

const entry = (key: string, text: string, label = `Label ${key}`): UnsavedTextEntry => ({ key, label, text });

console.log('--- Registry ---');
resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('control:AC.L1-b.1.1:notes', 'abc', 'Implementation notes, AC.L1-b.1.1')]);
let got = collectUnsavedText();
assert(got.length === 1 && got[0].text === 'abc', 'one provider, one entry');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', '   ')]);
assert(collectUnsavedText().length === 0, 'whitespace-only text is dropped');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'first')]);
registerUnsavedTextProvider('b', () => [entry('k', 'second')]);
got = collectUnsavedText();
assert(got.length === 1 && got[0].text === 'first', 'the same key from two providers keeps the first');

resetUnsavedText();
registerUnsavedTextProvider('bad', () => { throw new Error('boom'); });
registerUnsavedTextProvider('good', () => [entry('k', 'ok')]);
assert(collectUnsavedText().length === 1, 'a provider that throws is skipped');

resetUnsavedText();
const off = registerUnsavedTextProvider('a', () => [entry('k', 'x')]);
off();
assert(collectUnsavedText().length === 0, 'an unregistered provider reports nothing');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k1', 'x')]);
registerUnsavedTextProvider('a', () => [entry('k2', 'y')]);
got = collectUnsavedText();
assert(got.length === 1 && got[0].key === 'k2', 'registering the same id twice replaces the first');

resetUnsavedText();
const stale = registerUnsavedTextProvider('a', () => [entry('k1', 'x')]);
registerUnsavedTextProvider('a', () => [entry('k2', 'y')]);
stale();
assert(collectUnsavedText().length === 1, 'the stale unregister does not remove the replacement');

console.log('\n--- Rescue ---');
resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'one')]);
let count = rescueUnsavedText('u1');
let store = getRescuedText();
assert(count === 1 && store?.entries.length === 1 && store.ownerUserId === 'u1', 'a rescue returns the count and stores the entries for the owner', { count, store });
const snapshot = getRescuedText();
assert(getRescuedText() === snapshot, 'the snapshot is the same object until it changes');

resetUnsavedText();
count = rescueUnsavedText('u1');
assert(count === 0 && getRescuedText() === null, 'nothing to rescue returns 0 and leaves the store empty');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'one')]);
rescueUnsavedText('u1');
registerUnsavedTextProvider('a', () => [entry('k', 'two')]);
rescueUnsavedText('u1');
store = getRescuedText();
assert(store?.entries.length === 1 && store.entries[0].text === 'two', 'the same key rescued twice keeps one entry with the newest text', store);

registerUnsavedTextProvider('a', () => []);
assert(rescueUnsavedText('u1') === 0 && getRescuedText()?.entries.length === 1, 'a rescue that finds nothing leaves the earlier text alone');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'one')]);
let calls = 0;
subscribeRescuedText(() => { calls++; });
rescueUnsavedText('u1');
assert(calls === 1, 'a subscriber is called once per rescue');
discardRescuedText();
assert(calls === 2 && getRescuedText() === null, 'and once per discard, which empties the store');
discardRescuedText();
assert(calls === 2, 'discarding an empty store notifies nobody');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'one')]);
rescueUnsavedText('u1');
reconcileRescuedTextOnSignIn('u1');
assert(getRescuedText() !== null, 'the same user signing in keeps the text');
reconcileRescuedTextOnSignIn('u2');
assert(getRescuedText() === null, 'a different user signing in wipes it');

resetUnsavedText();
registerUnsavedTextProvider('a', () => [entry('k', 'one')]);
rescueUnsavedText('u1');
const r = getRescuedText();
assert(canRevealRescued(r, false, 'u1') === false, 'not revealed while signed out');
assert(canRevealRescued(r, true, 'u1') === true, 'revealed to the owner once signed in');
assert(canRevealRescued(r, true, 'u2') === false, 'not revealed to someone else');
assert(canRevealRescued(null, true, 'u1') === false, 'nothing to reveal');
assert(canRevealRescued(r, true, null) === false, 'not revealed without a user id');

console.log('\n--- formatRescuedText ---');
assert(formatRescuedText([{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }]) === 'A\n\nx\n\n---\n\nB\n\ny', 'two fields are separated by a rule');
assert(formatRescuedText([{ label: 'A', text: 'x' }]) === 'A\n\nx', 'one field has no rule');

console.log('\n--- unsavedControlNotes ---');
const controls = { C1: { implementationNotes: 'new' }, C2: { implementationNotes: 'same' }, C3: { implementationNotes: '' } };
const live = { C1: { implementationNotes: 'old' }, C2: { implementationNotes: 'same' }, C3: { implementationNotes: 'x' } };
let diff = unsavedControlNotes(controls, live);
assert(diff.length === 1 && diff[0].key === 'control:C1:notes' && diff[0].label === 'Implementation notes, C1', 'only the changed, non-empty note is unsaved', diff);
assert(unsavedControlNotes(controls, null).length === 0, 'without live data nothing is reported');
diff = unsavedControlNotes({ C4: { implementationNotes: 'n' } }, {});
assert(diff.length === 1 && diff[0].key === 'control:C4:notes', 'a control the server does not have counts as unsaved');

console.log('\n--- unsavedObjectiveDrafts ---');
diff = unsavedObjectiveDrafts({ o1: 'd1', o2: 'same', o3: '' }, { o1: 's1', o2: 'same', o3: 'x' });
assert(diff.length === 1 && diff[0].label === 'Objective narrative, o1', 'only the changed, non-empty draft is unsaved', diff);

console.log('\n--- unsavedSspImportDrafts ---');
const staged = [{ id: 's1', controlId: 'AC.L2-3.1.1', editedNotes: null, suggestedNotes: 'sugg' }];
diff = unsavedSspImportDrafts({ s1: 'edited' }, staged);
assert(diff.length === 1 && diff[0].label.includes('AC.L2-3.1.1'), 'an edited draft is unsaved and labelled with the control id', diff);
assert(unsavedSspImportDrafts({ s1: 'sugg' }, staged).length === 0, 'a draft equal to the suggestion is not an edit');
assert(unsavedSspImportDrafts({ s1: 'sugg' }, [{ ...staged[0], editedNotes: 'saved edit' }]).length === 1, 'a draft differing from the saved edit is unsaved');

console.log('\n--- unsavedProgramFields ---');
diff = unsavedProgramFields({ description: 'd', boundarySummary: '' }, { description: '', boundarySummary: '' }, 'p1');
assert(diff.length === 1 && diff[0].label === 'Program description, p1', 'a changed description is unsaved', diff);
diff = unsavedProgramFields({ description: 'd', boundarySummary: 'b' }, {}, null);
assert(diff.length === 2 && diff.every((d) => d.label.includes('(new program)')), 'a new program labels both fields (new program)', diff);
assert(unsavedProgramFields({ description: 'd', boundarySummary: 'b' }, { description: 'd', boundarySummary: 'b' }, 'p1').length === 0, 'unchanged fields are not unsaved');

console.log('\n--- Labels never carry the text ---');
const MARK = 'CUI-MARK-77';
const allEntries = [
  ...unsavedControlNotes({ C1: { implementationNotes: MARK } }, {}),
  ...unsavedObjectiveDrafts({ o1: MARK }, {}),
  ...unsavedSspImportDrafts({ s1: MARK }, staged),
  ...unsavedProgramFields({ description: MARK, boundarySummary: MARK }, {}, 'p1'),
  ...unsavedProgramFields({ description: MARK, boundarySummary: MARK }, {}, null),
];
assert(allEntries.length === 7 && allEntries.every((e) => e.text === MARK && !e.label.includes(MARK) && !e.key.includes(MARK)), 'no label or key contains the text', allEntries.map((e) => e.label));

console.log('\n--- Static checks ---');
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const FORBIDDEN = /localStorage|sessionStorage|indexedDB|idb-keyval|console\.|recordAuditEvent|auditLogger|fetch\(/;
for (const file of ['src/services/unsavedText.ts', 'src/hooks/useUnsavedTextProvider.ts']) {
  assert(!FORBIDDEN.test(read(file)), `${file} never touches storage, the console, the ledger or the network`);
}
const auth = read('src/context/AuthContext.tsx');
const listener = auth.slice(auth.indexOf('onSessionRejected('), auth.indexOf('The first tenant sync of a reload answered'));
assert(listener.indexOf('rescueUnsavedText(') !== -1 && listener.indexOf('rescueUnsavedText(') < listener.indexOf('void logout()'), 'the session-ended listener rescues before it signs out');
const applyBody = auth.slice(auth.indexOf('const applySession = useCallback'), auth.indexOf('const loginWithEmailPassword'));
assert(applyBody.includes('reconcileRescuedTextOnSignIn('), 'applySession reconciles the rescued text with the signing-in user');
const logoutBody = auth.slice(auth.indexOf('const logout = useCallback'), auth.indexOf('const openAuthModal'));
assert(logoutBody.indexOf('rescueUnsavedText(') < logoutBody.indexOf('void logout()'), 'the rescue is inside the listener, ahead of its logout call');
for (const file of [
  'src/components/matrix/ObjectiveChecklist.tsx',
  'src/components/sspImport/SspImportView.tsx',
  'src/components/programs/ProgramFormModal.tsx',
  'src/components/settings/EnclaveSettings.tsx',
  'src/context/AssessmentContext.tsx',
]) {
  assert(read(file).includes('useUnsavedTextProvider('), `${file} reports its unsaved text`);
}
// A save updates the local copy before the server answers: the draft must be compared with the server's text, or a save cut off
// by the session ending would count as saved (found in the browser check)
assert(
  /currentTenant\.serverBacked \? serverObjectiveNarrative\(o\.id\) : o\.implementationNarrative/.test(read('src/components/matrix/ObjectiveChecklist.tsx')),
  'ObjectiveChecklist compares a draft with the server-confirmed narrative (a save cut off by the session end still counts as unsaved)'
);
const assessment = read('src/context/AssessmentContext.tsx');
const saveBody = assessment.slice(assessment.indexOf('const saveObjectives = useCallback'), assessment.indexOf('// Review of a conflict the one-time upload found'));
assert(saveBody.indexOf('401') !== -1 && saveBody.indexOf('401') < saveBody.indexOf('alert('), 'saveObjectives checks for a 401 before it alerts');

console.log('\n--- The screens ---');
const E1 = entry('control:AC.L1-b.1.1:notes', 'CUI-MARK-77', 'Implementation notes, AC.L1-b.1.1');
const E2 = entry('sspimport:s1', 'AI-TEXT-9', 'SSP import edit, AC.L2-3.1.1');
const noop = () => undefined;
const summary = (entries: UnsavedTextEntry[], revealed: boolean, expanded = true) =>
  renderToStaticMarkup(React.createElement(UnsavedTextSummary, { entries, revealed, expanded, onToggleExpanded: noop, onReview: noop, onDiscard: noop }));
const entriesHtml = (entries: UnsavedTextEntry[], copiedKey: string | null = null) =>
  renderToStaticMarkup(React.createElement(UnsavedTextEntries, { entries, copiedKey, onCopy: noop, fieldRef: noop }));

assert(unsavedFieldCount(1) === '1 unsaved field' && unsavedFieldCount(3) === '3 unsaved fields' && unsavedFieldCount(0) === '0 unsaved fields', 'U2-1 field count wording');
assert(isAiDraftEntry(E2) && !isAiDraftEntry(E1) && !isAiDraftEntry({ label: 'Objective narrative, 3.1.1[a]' }), 'U2-2 only SSP import edits are marked as AI drafts');

const before = summary([E1], false);
assert(
  ['Implementation notes, AC.L1-b.1.1', 'Unsaved text was kept (1)', 'Sign in again as the same user', 'Discard'].every((s) => before.includes(s)),
  'U2-3 the pre-reveal summary shows the label, the explanation and Discard'
);
assert(!before.includes('CUI-MARK-77') && !before.includes('<textarea') && !before.includes('Review and copy'), 'U2-3 the pre-reveal summary never carries the text');

const after = summary([E1, E2], true);
assert(['Review and copy', 'Unsaved text from your last session (2)', 'AI draft: '].every((s) => after.includes(s)), 'U2-4 the revealed summary offers the review and marks the AI draft');
assert(!after.includes('CUI-MARK-77') && !after.includes('AI-TEXT-9'), 'U2-4 the revealed summary still never carries the text');

const collapsed = summary([E1], false, false);
assert(collapsed.includes('aria-expanded="false"') && /hidden=""/.test(collapsed) && collapsed.includes('Discard'), 'U2-5 collapsed: details hidden, Discard stays');

const fieldsHtml = entriesHtml([E1, E2]);
assert(fieldsHtml.includes('CUI-MARK-77') && fieldsHtml.includes('AI-TEXT-9'), 'U2-6 the entries show the text');
assert((fieldsHtml.match(/<textarea/g) || []).length === 2 && (fieldsHtml.match(/readonly/gi) || []).length >= 2, 'U2-6 one read-only textarea per entry');
assert(/autocomplete="off"/i.test(fieldsHtml) && !/\sname="/.test(fieldsHtml), 'U2-6 autocomplete off, no field name');
assert((fieldsHtml.match(/AI draft, not reviewed/g) || []).length === 1, 'U2-6 the AI warning appears once');
assert((fieldsHtml.match(/<label for="/g) || []).length === 2, 'U2-6 every field has a label');

const copiedHtml = entriesHtml([E1], E1.key);
assert(copiedHtml.includes('>Copied<') && copiedHtml.includes('aria-label="Copied Implementation notes, AC.L1-b.1.1"'), 'U2-7 copied feedback');

const escaped = entriesHtml([entry('k', '<script>x</script>', 'Label k')]);
assert(escaped.includes('&lt;script&gt;') && !escaped.includes('<script>'), 'U2-8 the text is escaped');

const bannerSrc = read('src/components/auth/UnsavedTextBanner.tsx');
const panelSrc = read('src/components/auth/UnsavedTextPanel.tsx');
for (const [name, src] of [['UnsavedTextBanner.tsx', bannerSrc], ['UnsavedTextPanel.tsx', panelSrc]] as const) {
  assert(!/localStorage|sessionStorage|indexedDB|idb-keyval|console\.|recordAuditEvent|auditLogger|fetch\(|dangerouslySetInnerHTML/.test(src), `U2-9 ${name} touches no storage, console, ledger or network`);
}
const discardBody = bannerSrc.slice(bannerSrc.indexOf('const discard = () =>'), bannerSrc.indexOf('return ('));
assert(bannerSrc.split('discardRescuedText()').length === 2 && discardBody.includes('discardRescuedText()'), 'U2-10 discardRescuedText() is called once, inside discard');
const copyBody = bannerSrc.slice(bannerSrc.indexOf('const copy = ('), bannerSrc.indexOf('copyToClipboard(text)') + 'copyToClipboard('.length);
assert(copyBody.length > 0 && !copyBody.includes('await'), 'U2-10 copyToClipboard is the first call of the click path (no await before it)');
assert(
  ['role="alertdialog"', 'z-[60]', 'autoFocus', 'formatRescuedText(entries)', 'useSyncExternalStore(subscribeRescuedText, getRescuedText, getRescuedText)'].every((s) => bannerSrc.includes(s)),
  'U2-10 the banner has the confirmation dialog, copy-all and the stable store subscription'
);

const appSrc = read('src/App.tsx');
assert(appSrc.split('<UnsavedTextBanner />').length === 3, 'U2-11 App mounts the banner twice');
assert(appSrc.lastIndexOf('<UnsavedTextBanner />') > appSrc.indexOf('<EnclaveStackSurveyModal'), 'U2-11 the second banner is outside every route conditional');
assert(appSrc.indexOf('<UnsavedTextBanner />') > appSrc.indexOf('if (isAuthenticated && mustChangePassword)') && appSrc.indexOf('<UnsavedTextBanner />') < appSrc.indexOf('return (\n    <>\n      {/* 0a.'), 'U2-11 the first banner is in the password-change branch');

const loginSrc = read('src/components/auth/LoginPage.tsx');
assert(/\{authError && \(\s*<div role="alert"/.test(loginSrc) && loginSrc.includes('aria-label="Dismiss this message"'), 'U2-12 the session-ended message is an alert with a named dismiss button');
assert(
  ['autoFocus', 'aria-describedby={authError ? alertId : undefined}', 'htmlFor={emailId}', 'htmlFor={passwordId}', 'onClick={dismissError}', 'aria-label="Dismiss this message"'].every((s) => loginSrc.includes(s)),
  'U2-13 the sign-in page labels its fields, focuses the email and links the alert'
);

const modalSrc = read('src/components/auth/AuthModal.tsx');
assert(
  /\{authError && \(\s*<div role="alert"/.test(modalSrc) && modalSrc.includes('aria-label="Dismiss this message"') && modalSrc.includes('htmlFor={emailId}'),
  'U2-14 the sign-in modal error is an alert with a named dismiss button and a labelled email field'
);
assert(
  modalSrc.indexOf('const alertId = useId();') > -1 && modalSrc.indexOf('const alertId = useId();') < modalSrc.indexOf('if (!isAuthModalOpen) return null;'),
  'U2-15 the sign-in modal declares its hooks before the early return'
);

const inviteSrc = read('src/pages/AcceptInvitePage.tsx');
assert(
  inviteSrc.includes('<ErrorNotice message={claimError || authError} />') && inviteSrc.includes('<ErrorNotice message={previewError}') && !inviteSrc.includes('{previewError && <span'),
  'U2-16 the invitation page shows its errors through ErrorNotice'
);
assert(read('src/components/common/ErrorNotice.tsx').includes('role="alert"'), 'U2-17 ErrorNotice is an alert');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
