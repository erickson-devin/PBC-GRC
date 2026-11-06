import fs from 'fs';
import path from 'path';
import { isCrossReferenceOnly } from '../src/utils/sspImportHints';

/** The hint shown when an import found only cross-references. */
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

const mention = { matchKind: 'MENTION' };
assert(isCrossReferenceOnly([mention, mention, mention, mention, mention]) === true, 'only mentions: the hint applies');
assert(isCrossReferenceOnly([mention, mention, mention, mention, { matchKind: 'CMMC_ID_SECTION' }]) === false, 'one real section: no hint');
assert(isCrossReferenceOnly([]) === false, 'nothing staged: no hint');
assert(fs.readFileSync(path.join(process.cwd(), 'src/components/sspImport/SspImportView.tsx'), 'utf8').includes('isCrossReferenceOnly('), 'SSP Import uses the check');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
