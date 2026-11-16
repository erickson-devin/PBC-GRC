import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetMismatchNotice } from '../src/components/dashboard/MetMismatchNotice';
import { metMismatchNoticeCopy } from '../src/data/cmmcGuide/controlStatusView';

/**
 * #292 / #293 / #294: the screens that show a status (control dialog, objective checklist, control matrix and card, import and move
 * results, SSP page and exports) read the one display label, refuse Met with open objectives in words, and keep the accessibility
 * hooks. Source pins on the components plus a static render of the Met-mismatch notice. Pure: it does not boot the server.
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

const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const modal = src('src/components/matrix/InspectDocumentModal.tsx');
const checklist = src('src/components/matrix/ObjectiveChecklist.tsx');
const matrix = src('src/components/dashboard/AssessmentMatrix.tsx');
const card = src('src/components/dashboard/ControlCard.tsx');
const noticeSrc = src('src/components/dashboard/MetMismatchNotice.tsx');
const header = src('src/components/layout/Header.tsx');
const legacy = src('src/components/common/LegacyTenantNotice.tsx');
const sspPage = src('src/components/ssp/SSPBuilder.tsx');
const storage = src('src/services/storageService.ts');

console.log('--- Control dialog ---');
assert(
  modal.includes('aria-pressed={isSelected}') && modal.includes('aria-disabled={blocked || undefined}') && modal.includes('controlHeaderView(')
    && modal.includes('composeImplementationStatement(') && modal.includes('sspStatementLabel('),
  'M1 the status buttons expose pressed and disabled state, and the header and the SSP tab use the shared helpers'
);
assert(modal.includes('aria-describedby={notesNotSavedReason ? notesNotSavedId : undefined}'), 'M2 the notes box keeps its not-saved description');
assert(!modal.includes('Compiled SSP Implementation Narrative'), 'M3 the old SSP tab label is gone');
const previewSlice = modal.slice(modal.indexOf('What the SSP prints'), modal.indexOf('</section>', modal.indexOf('What the SSP prints')));
assert(previewSlice.length > 0 && !previewSlice.includes('aria-live') && !previewSlice.includes('dangerouslySetInnerHTML'), 'M4 the SSP preview is plain text and is not a live region');
assert(
  modal.includes('const blocked = s.id === \'MET\' && header.metRefusal !== null && !isSelected;')
    && modal.includes('if (blocked) { announce(header.metRefusal ?? \'\'); return; }')
    && modal.includes('if (storedStatus === next) return;'),
  'M5 a refused Met changes nothing and announces the reason; choosing the recorded status again does nothing'
);
assert(modal.includes('aria-describedby={s.id === \'MET\' && header.metRefusal ?'), 'M6 the Met button points at its reason');
assert(
  modal.includes('Set to {statusDisplayLabel(header.note.fixTo)}') && modal.includes('header.note.fixTo && statusEditable && !activeProgram?.archived'),
  'M7 the "Set to <status>" action names the status, needs a write role and is hidden for an archived program'
);
assert(modal.includes('statusButtonRefs.current.get(to)?.focus()'), 'M8 after "Set to" the focus moves to the status button, because the note disappears');
assert(
  modal.includes('const statusEditable = canEdit && notesEditable;') && modal.includes('{statusDisplayLabel(storedStatus)}'),
  'M9 a read-only role gets a status pill, not buttons'
);
assert(modal.includes('<span role="status" aria-live="polite" className="sr-only">{statusAnnouncement}</span>'), 'M10 the status announcement is a polite live region');

console.log('--- Objective checklist ---');
assert(
  checklist.includes('aria-pressed={isSelected}') && checklist.includes('aria-label={`Status of objective [') && checklist.includes('Narrative for objective [')
    && checklist.includes('objectiveSspBadge(') && checklist.includes('objectiveSaveView('),
  'C1 the objective status buttons, the narrative label, the SSP badge and the save line are in place'
);
assert(!checklist.includes('Confirmed for SSP') && !checklist.includes('alert(') && !checklist.includes('Control Status: {rollup'), 'C2 no old badge text, no alert, no old rollup label');
assert(
  checklist.includes('Objectives add up to: {statusDisplayLabel(rollup.calculatedStatus)}') && !/text-xs font-semibold font-bold/.test(checklist),
  'C3 the rollup pill says what the objectives add up to, in the display label, with one font weight'
);
const labelAt = checklist.indexOf('<label htmlFor={narrativeId}');
const labelEnd = checklist.indexOf('</label>', labelAt);
assert(labelAt > 0 && !checklist.slice(labelAt, labelEnd).includes('sspBadge'), 'C4 the SSP badge is outside the narrative label, so the field name is just "Narrative for objective [x]"');
assert(
  checklist.includes('aria-describedby={[sspBadge ? `${narrativeId}-ssp` : \'\', saveView ? `${narrativeId}-save` : \'\'].filter(Boolean).join(\' \') || undefined}'),
  'C5 the narrative box is described by the badge and the save line'
);
assert(
  checklist.includes('aria-label={`Save the narrative for objective [${shownLetter(obj.letter)}]`}') && checklist.includes('Save changes'),
  'C6 the narrative save button names its objective'
);
assert(
  checklist.includes('<p role="status" aria-live="polite" className="sr-only">{saveAnnouncement}</p>') && checklist.includes('objectiveSaveAnnouncement('),
  'C7 save results are announced politely'
);
assert(checklist.includes('const handleRetrySave = (obj: AssessmentObjective) =>') && checklist.includes('saveLineRefs.current.get(obj.id)?.focus()'), 'C8 Retry resends and returns the focus to the save line');
assert(checklist.includes('mark it Met') && !/mark (it|the objective) MET\b/.test(checklist), 'C9 the copy says Met, not MET');

console.log('--- Control matrix and card ---');
assert(
  matrix.includes('<MetMismatchNotice') && matrix.includes('metMismatchFilter && !metMismatchFilter.has(ctrl.id)') && matrix.includes('matrixSearchPlaceholder('),
  'X1 the matrix mounts the Met-mismatch notice, filters on it and builds the placeholder from the display id'
);
assert(!matrix.includes('frameworkControls[0]?.id ||'), 'X2 the placeholder no longer shows the stored id');
assert(
  matrix.includes('const metMismatches = useMemo(') && matrix.includes('objectivesReady && notesEditable ?'),
  'X3 the mismatches are computed only once the server objectives are merged and the notes are loaded'
);
assert(matrix.includes('setMetMismatchFilter(null)') && matrix.includes('matrixEmptyFilterMessage({ catalog: catalogUpdateFilter !== null, metMismatch: metMismatchFilter !== null })'), 'X4 the filter resets with the others and the empty state names it');
assert(
  matrix.includes('aria-pressed={metMismatchFilter !== null}') && matrix.includes('{item.id === \'ALL\' ? \'All\' : statusDisplayLabel(item.id)}') && matrix.includes('aria-pressed={isSelected}'),
  'X5 the chips are toggle buttons and the status chips use the display label'
);
assert(
  matrix.includes('hasSspStatement(ctrl.id, ctrlState?.implementationNotes, state.objectives, activeFramework)')
    && matrix.includes('metMismatch={mismatchById.get(ctrl.id) ?? null}') && matrix.includes('objectives open'),
  'X6 the "has notes" marker counts the composed statement and the open-objectives marker is on the row and the card'
);
assert(
  matrix.split('{statusDisplayLabel(status)}').length - 1 === 4 && ['MET', 'NOT_MET', 'IN_PROGRESS', 'NOT_STARTED'].every((s) => !new RegExp(`aria-hidden="true" /> ${s}\\s*<`).test(matrix)),
  'X7 the four table status badges print the display label, not the enum'
);
assert(card.includes('hasSspStatement(') && card.includes('statusDisplayLabel(status)') && card.includes('metMismatch?: { open: number; total: number } | null;'), 'K1 the card prints the display label and takes the open-objectives marker');
assert(
  card.includes('{metMismatch.open} of {metMismatch.total} objectives open') && !card.includes('Set to'),
  'K2 the card shows the open-objectives marker and offers no status action (the card is read-only; "Set to" lives in the control dialog)'
);
assert(
  card.includes('Narrative Documented') && card.includes('No narrative yet') && card.includes('Narrative not loaded'),
  'K3 the card keeps its three narrative strings'
);

console.log('--- Met-mismatch notice (rendered) ---');
const render = (count: number, canEdit: boolean, filterOn: boolean) =>
  renderToStaticMarkup(React.createElement(MetMismatchNotice, { count, canEdit, filterOn, onToggleFilter: () => undefined }));
const three = render(3, true, false);
const countCopy = metMismatchNoticeCopy(3, { canEdit: true });
assert(
  three.includes('role="region"') && three.includes('aria-pressed="false"') && three.includes(countCopy.count) && three.includes(countCopy.heading),
  'N1 three mismatches: a labelled region, an unpressed toggle and the count copy'
);
assert(!three.includes('Dismiss') && !three.includes('role="alert"'), 'N2 the notice cannot be dismissed and is not an alert');
assert(three.includes(metMismatchNoticeCopy(3, { canEdit: true }).action) && render(3, false, false).includes('A Tenant Owner or MSP Admin can update them.'), 'N3 the action text follows the role');
assert(render(0, true, false) === '', 'N4 nothing to show and the filter off: nothing rendered');
const done = render(0, true, true);
assert(done.includes('None left') && done.includes('aria-pressed="true"'), 'N5 all fixed with the filter on: "None left" and the toggle stays');
assert(render(1, true, true).includes('Showing only the controls recorded as Met with open objectives.'), 'N6 the filter state is announced');

console.log('--- Import and move results ---');
assert(
  header.includes('importResultMessage(') && header.includes('importControlsLowered()') && !header.includes('successfully imported for'),
  'R1 the import result is read through the getter after the import and built by the helper'
);
assert(legacy.includes('movedLoweredNote(') && legacy.includes('moved.controlsLowered'), 'R2 the move result names the controls that were lowered');

console.log('--- SSP page and exports ---');
assert(sspPage.includes('statusDisplayLabel(') && !sspPage.includes('Status: {status}') && !sspPage.includes('Status: ${cState?.status'), 'S1 the SSP page prints the display label');
assert(sspPage.split('composeImplementationStatement(').length - 1 === 2, 'S2 the page and its plaintext copy each compose the statement once');
assert(
  sspPage.includes('statement.trim() !== \'\' ?') && sspPage.includes('whitespace-pre-wrap break-words [overflow-wrap:anywhere]'),
  'S3 a whitespace-only statement shows the placeholder and long text wraps'
);
const cardTag = sspPage.indexOf('className="p-4 rounded-xl border border-slate-300 bg-white space-y-2.5 shadow-sm"');
assert(
  cardTag > 0 && sspPage.slice(cardTag - 120, cardTag + 100).indexOf('print-avoid-break') === -1 && sspPage.includes('<div className="print-avoid-break space-y-2.5">'),
  'S4 only the control bar and requirement keep together in print, so a long statement can break across pages'
);
assert(
  storage.includes('**${statusDisplayLabel(cState?.status)}**') && !storage.includes('**${cState?.status || \'NOT_STARTED\'}**'),
  'S5 the Markdown export prints the display label'
);

console.log('--- Privacy ---');
const checked: Record<string, string> = {
  'InspectDocumentModal.tsx': modal,
  'ObjectiveChecklist.tsx': checklist,
  'AssessmentMatrix.tsx': matrix,
  'ControlCard.tsx': card,
  'MetMismatchNotice.tsx': noticeSrc,
  'SSPBuilder.tsx': sspPage,
  'Header.tsx': header,
  'LegacyTenantNotice.tsx': legacy,
};
for (const [name, text] of Object.entries(checked)) {
  const bad = [/console\./, /\blocalStorage\b/, /\bsessionStorage\b/, /dangerouslySetInnerHTML/].filter((re) => re.test(text)).map(String);
  assert(bad.length === 0, `P1 ${name} has no console, browser storage or raw HTML`, bad);
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
