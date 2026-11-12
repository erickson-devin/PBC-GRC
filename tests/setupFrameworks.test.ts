import fs from 'fs';
import path from 'path';
import { SETUP_FRAMEWORKS, DEFAULT_PRIMARY_FRAMEWORK } from '../src/data/tenantFrameworkPolicy';
import {
  DEFAULT_SETUP_FRAMEWORKS,
  setupFrameworksPayload,
  setupFrameworksSentence,
  toggleSetupFramework,
} from '../src/data/setupFrameworks';

/**
 * The framework choice on the first-run setup page: the pure helpers (list order, which framework is sent first as the
 * primary, the sentence on the all-set screen) and a source check of the page. No server.
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n--- Offered frameworks ---');
assert(same(SETUP_FRAMEWORKS, ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5']), 'setup offers CMMC L1, CMMC L2 and NIST SP 800-53 only (no SOC 2, no HIPAA)', SETUP_FRAMEWORKS);
assert(same(setupFrameworksPayload(DEFAULT_SETUP_FRAMEWORKS), [DEFAULT_PRIMARY_FRAMEWORK]), 'an untouched page sends the default, CMMC Level 1 only');

console.log('\n--- Ticking and unticking ---');
assert(same(toggleSetupFramework(['CMMC_L1'], 'CMMC_L2'), ['CMMC_L1', 'CMMC_L2']), 'ticking CMMC L2 adds it');
assert(same(toggleSetupFramework(['NIST_800_53_REV5', 'CMMC_L1'], 'CMMC_L2'), ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5']), 'the selection is always in list order');
assert(same(toggleSetupFramework(['CMMC_L1'], 'CMMC_L1'), []), 'unticking the only framework leaves nothing');
assert(same(toggleSetupFramework(['CMMC_L1'], 'SOC_2_TYPE_II'), ['CMMC_L1']), 'an id the page does not offer is ignored');
assert(same(toggleSetupFramework(['CMMC_L1', 'HIPAA_SECURITY'], 'CMMC_L2'), ['CMMC_L1', 'CMMC_L2']), 'a stray id is dropped');

console.log('\n--- The payload: first entry is the primary ---');
assert(same(setupFrameworksPayload([]), []), 'nothing ticked sends nothing');
assert(same(setupFrameworksPayload(['CMMC_L1']), ['CMMC_L1']), 'CMMC L1 alone');
assert(same(setupFrameworksPayload(['CMMC_L1', 'CMMC_L2']), ['CMMC_L2', 'CMMC_L1']), 'L1 + L2: CMMC L2 is primary, not L1');
assert(same(setupFrameworksPayload(['CMMC_L2', 'NIST_800_53_REV5']), ['NIST_800_53_REV5', 'CMMC_L2']), 'L2 + NIST: NIST is primary');
assert(same(setupFrameworksPayload(['NIST_800_53_REV5', 'CMMC_L1']), ['NIST_800_53_REV5', 'CMMC_L1']), 'NIST + L1: NIST is primary');
assert(same(setupFrameworksPayload(['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5']), ['NIST_800_53_REV5', 'CMMC_L1', 'CMMC_L2']), 'all three: NIST first, the others in list order');
assert(same(setupFrameworksPayload(['CMMC_L2', 'CMMC_L2']), ['CMMC_L2']), 'no duplicates');
assert(same(setupFrameworksPayload(['SOC_2_TYPE_II', 'HIPAA_SECURITY']), []), 'frameworks the page does not offer are not sent');

console.log('\n--- The all-set sentence ---');
assert(setupFrameworksSentence(['CMMC_L1']) === 'CMMC Level 1', 'one framework');
assert(setupFrameworksSentence(['CMMC_L2', 'CMMC_L1']) === 'CMMC Level 1 and CMMC Level 2', 'two frameworks, list order', setupFrameworksSentence(['CMMC_L2', 'CMMC_L1']));
assert(
  setupFrameworksSentence(['NIST_800_53_REV5', 'CMMC_L2', 'CMMC_L1']) === 'CMMC Level 1, CMMC Level 2 and NIST SP 800-53 Rev. 5',
  'three frameworks',
  setupFrameworksSentence(['NIST_800_53_REV5', 'CMMC_L2', 'CMMC_L1'])
);
assert(setupFrameworksSentence([]) === '', 'nothing ticked gives an empty sentence');

console.log('\n--- The setup page ---');
const page = fs.readFileSync(path.join(process.cwd(), 'src/pages/SetupPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
assert(page.includes('<legend className={label}>Compliance frameworks</legend>'), 'the group is a fieldset with a legend');
assert(page.includes('SETUP_FRAMEWORKS.map((f) =>'), 'one checkbox per offered framework');
assert(page.includes('type="checkbox"'), 'native checkboxes');
assert(page.includes('htmlFor={`${ids.fw}-${f}`}'), 'each label is bound to its checkbox');
assert(page.includes('`${ids.fw}-hint`'), 'the group is described by its hint');
assert(page.includes('useState<ComplianceFramework[]>([...DEFAULT_SETUP_FRAMEWORKS])'), 'CMMC Level 1 is ticked by default');
assert(page.includes('if (frameworks.length === 0) return SETUP_FRAMEWORKS_REQUIRED;'), 'at least one framework is required');
assert(page.includes('frameworks: setupFrameworksPayload(frameworks),'), 'the choice is sent with the setup request');
assert(page.includes("err.reason === 'invalid_frameworks'"), 'a server rejection of the choice has its own message');
assert(page.includes('Programs in this organization can use the frameworks you tick. A platform administrator can add more later.'), 'the hint text');
assert(!page.includes('SOC_2_TYPE_II') && !page.includes('HIPAA_SECURITY'), 'the page does not offer SOC 2 or HIPAA');
assert(!page.includes('dangerouslySetInnerHTML'), 'no raw HTML is injected');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
