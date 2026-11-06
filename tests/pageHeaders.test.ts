import { readFileSync } from 'fs';
import { join } from 'path';

/** Source checks for the page headers that must wrap instead of pushing a button out of its card. */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}`);
  }
}

const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const policy = source('src/views/PolicyLibraryView.tsx');
assert(policy.includes('flex flex-wrap items-start justify-between gap-4'), 'the Living Policy Library header row wraps');
assert(policy.includes('min-w-0 flex-1 basis-[22rem]'), 'its title block can shrink and sets its own wrap point');
assert(policy.includes('shrink-0 max-w-full'), 'its button wrapper keeps its width but never exceeds the card');
assert(!policy.includes('lg:flex-row lg:items-center justify-between'), 'the old non-wrapping header row is gone');
assert(policy.includes("aria-pressed={viewMode === 'formatted'}") && policy.includes("aria-pressed={viewMode === 'raw'}"), 'the Formatted / Raw toggle reports its state');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
