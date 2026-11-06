import fs from 'fs';
import path from 'path';
import { AI_BUTTON_CHECKING_TITLE, aiAvailability, aiErrorForUser, aiNoticeCopy, type AiAvailability } from '../src/data/aiAvailabilityView';

/** What people are told about the local AI helper: pure copy rules, and that no server reason (which can name the host) is shown. */
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

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

console.log('--- aiAvailability ---');
assert(aiAvailability({ enabled: true, available: true, canUse: true }, false) === 'readOnly', 'a read-only role: readOnly');
assert(aiAvailability(null, true) === 'checking', 'no status yet: checking');
assert(aiAvailability({ enabled: false, available: false, canUse: true }, true) === 'off', 'switched off: off');
assert(aiAvailability({ enabled: true, available: false, canUse: true }, true) === 'unavailable', 'enabled but not usable: unavailable');
assert(aiAvailability({ enabled: true, available: true, canUse: false }, true) === 'noRole', 'role may not use it: noRole');
assert(aiAvailability({ enabled: true, available: true, canUse: true }, true) === 'ready', 'everything fine: ready');

console.log('--- copy ---');
assert(aiNoticeCopy('ready', 'assist') === null && aiNoticeCopy('checking', 'assist') === null && aiNoticeCopy('readOnly', 'import') === null, 'ready, checking and read-only show no notice');
const all: AiAvailability[] = ['off', 'unavailable', 'noRole'];
for (const a of all) {
  for (const where of ['assist', 'import'] as const) {
    const c = aiNoticeCopy(a, where);
    if (!c) continue;
    assert(!/https?:|:\d{2,5}|ollama/i.test(c.line), `${a}/${where}: the main line names no address, port or service`, c.line);
    assert(!(c.adminHint ?? '').includes('http'), `${a}/${where}: the administrator hint has no URL`, c.adminHint);
  }
}
assert(aiNoticeCopy('off', 'assist')?.adminHint?.includes('SSP_AI_ENABLED=true') === true, 'the off notice tells an administrator which setting to change');
assert(AI_BUTTON_CHECKING_TITLE.length > 0, 'the checking title exists');

console.log('--- aiErrorForUser ---');
const unavailable = aiNoticeCopy('unavailable', 'assist')!.line;
assert(aiErrorForUser('The AI helper is not available: Cannot reach Ollama at http://ollama:11434.') === unavailable, 'an old-style message that names the host becomes the plain line');
assert(aiErrorForUser('The model took too long. Try again.') === 'The model took too long. Try again.', 'other messages are unchanged');
assert(aiErrorForUser(undefined).length > 0, 'a missing message gets a generic one');

console.log('--- source checks ---');
assert(!read('src/components/sspImport/SspImportView.tsx').includes('caps.aiStatus.reason'), 'SSP Import never shows the server reason');
assert(!read('src/components/matrix/OdpPanel.tsx').includes('status.reason'), 'the parameter panel never shows the server reason');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
