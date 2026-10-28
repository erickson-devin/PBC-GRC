import fs from 'fs';
import path from 'path';
import { summarizeEvidenceDeletion, copiesPhrase } from '../src/components/common/ConfirmDeleteEvidenceDialog';

/** The evidence-delete confirmation: what the summary says it removes (from ids only), and the wiring of both delete buttons. No rendering. */
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const index = [{ id: 'ev1' }, { id: 'ev1__inh_SI-2' }, { id: 'ev1__inh_CC7_1' }, { id: 'ev10__inh_x' }, { id: 'ev2' }];

const t1 = summarizeEvidenceDeletion('ev1', index, true);
assert(same(t1, { isCopy: false, copiesRemoved: 2, copiesKept: 0 }), 'server tenant: a base record goes with its two copies (ev10 is not one of them)', t1);
const t2 = summarizeEvidenceDeletion('ev1', index, false);
assert(same(t2, { isCopy: false, copiesRemoved: 0, copiesKept: 2 }), 'browser-only tenant: the copies stay', t2);
const t3 = summarizeEvidenceDeletion('ev1__inh_SI-2', index, true);
assert(same(t3, { isCopy: true, copiesRemoved: 0, copiesKept: 0 }), 'a copy goes alone', t3);
const t4 = summarizeEvidenceDeletion('ev2', index, true);
assert(same(t4, { isCopy: false, copiesRemoved: 0, copiesKept: 0 }), 'a record without copies', t4);
assert(copiesPhrase(1) === '1 cross-framework copy' && copiesPhrase(3) === '3 cross-framework copies', 'the copies phrase is singular or plural');

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const dialog = read('src/components/common/ConfirmDeleteEvidenceDialog.tsx');
const count = (s: string, needle: string) => s.split(needle).length - 1;
assert(dialog.includes('role="alertdialog"') && dialog.includes('z-[60]') && dialog.includes('max-h-[90vh]'), 'the dialog is an alertdialog above the inspector (z-[60]) and fits a short screen');
assert(dialog.includes('onClose={handleCancel}') && !/onClose=\{busy/.test(dialog), 'the overlay always gets an onClose (Escape stays in the stack and is ignored while busy)');
assert(count(dialog, 'if (busyRef.current) return;') >= 2 && count(dialog, 'disabled={busy}') >= 2, 'a running delete cannot be cancelled or repeated');
assert(dialog.includes('autoFocus') && dialog.includes('<ErrorNotice'), 'focus starts on Cancel; a failure shows an error notice');
assert(!dialog.includes('console.') && !dialog.includes('dangerouslySetInnerHTML'), 'the dialog logs nothing and injects no HTML');

const vault = read('src/components/vault/EvidenceVaultView.tsx');
assert(!vault.includes('onClick={() => removeEvidence(') && vault.includes('setPendingDelete(item)') && vault.includes('<ConfirmDeleteEvidenceDialog'), 'the vault delete button asks first');
const inspector = read('src/components/matrix/InspectDocumentModal.tsx');
assert(
  !inspector.includes('onClick={() => removeEvidence(') && inspector.includes('setPendingDelete(ev)') && inspector.indexOf('<ConfirmDeleteEvidenceDialog') > 0 && inspector.indexOf('<ConfirmDeleteEvidenceDialog') < inspector.lastIndexOf('</DialogOverlay>'),
  'the inspector delete button asks first, and the dialog sits inside the inspector overlay'
);
// The dialog's autoFocus takes focus before effects run: the trap must remember the previous focus at first render
const trap = read('src/hooks/useFocusTrap.ts');
assert(
  /const previousRef = useRef<HTMLElement \| null>\(/.test(trap) && trap.includes('!root.contains(previousRef.current)') && !/useEffect\(\(\) => \{[^}]*const previous = document\.activeElement/.test(trap),
  'the focus trap remembers the element focused before the dialog rendered, so closing returns focus to the delete button'
);

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
