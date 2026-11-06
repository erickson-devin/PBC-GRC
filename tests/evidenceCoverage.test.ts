import fs from 'fs';
import path from 'path';
import { evidenceCoverage } from '../src/data/evidenceCoverage';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';

/** The Evidence Vault coverage tile: evidence counts only against the controls of the active program. No rendering. */
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

const l2Ids = getFrameworkControls('CMMC_L2').map((c) => c.id);
const l1Ids = getFrameworkControls('CMMC_L1').map((c) => c.id);

const a = evidenceCoverage([{ controlId: 'AC.L1-3.1.1' }, { controlId: 'AC.L1-3.1.1' }, { controlId: 'AC.L2-3.1.3' }], l2Ids);
assert(a.covered === 2 && a.total === l2Ids.length, 'distinct covered controls out of the program controls', a);
const b = evidenceCoverage([{ controlId: 'AC-2' }], l1Ids);
assert(b.covered === 0 && b.total === l1Ids.length, 'evidence on a control outside the program does not count', b);
const c = evidenceCoverage([], []);
assert(c.covered === 0 && c.total === 0, 'nothing in, nothing out', c);
const d = evidenceCoverage([{ controlId: 'X' }], ['X', 'X', 'Y']);
assert(d.covered === 1 && d.total === 2, 'duplicate control ids count once', d);

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const vault = read('src/components/vault/EvidenceVaultView.tsx');
assert(!vault.includes('/ 17'), 'the vault has no fixed 17-control total');
assert(vault.includes('evidenceCoverage('), 'the tile uses evidenceCoverage');
assert(vault.includes('<optgroup') && vault.includes('htmlFor="vault-upload-control"'), 'the picker is grouped by domain and has a label');
assert(!vault.includes("|| 'AC.L1-3.1.1'"), 'the picker has no made-up first control');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
