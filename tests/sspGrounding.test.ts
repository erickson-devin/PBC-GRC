import { foldWithMap, groundQuote, locateQuote, resolveControlId } from '../server/ssp/grounding';

/** Grounding: a model's quotation must be the document's own words, and its control ids must be real and offered. */
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

const SECTION = [
  'AC.L1-3.1.1 Authorized Access Control',
  'Access to company systems is limited to authorized users. Accounts are created by the IT lead after manager approval,',
  'and reviewed every quarter — inactive accounts are disabled within 30 days.',
  '• Shared accounts are prohibited by policy.',
].join('\n');
const DOC_PREFIX = 'Cover page and table of contents.\n\n';
const DOC = DOC_PREFIX + SECTION + '\n\nNext section about something else entirely.';
const START = DOC_PREFIX.length;
const pages = [{ page: 1, start: 0, end: 20 }, { page: 2, start: 21, end: DOC.length }];

console.log('--- Folding ---');
const f = foldWithMap('  A  B\n\nC — D “E”  ');
assert(f.text === 'a b c - d "e"', 'whitespace runs collapse; dashes and quotes fold; case folds', f.text);
assert(f.map.length === f.text.length && f.map.every((v, i) => i === 0 || v >= f.map[i - 1]), 'every folded character maps back to a position, in order');

console.log('\n--- Quotes ---');
const ok = (claimed: string) => groundQuote(SECTION, START, claimed, pages);
let r = ok('Access to company systems is limited to authorized users.');
assert(r.ok && r.quote.quote === 'Access to company systems is limited to authorized users.' && DOC.slice(r.quote.start, r.quote.end) === r.quote.quote, 'an exact quotation is verified, with document offsets', r);
assert(r.ok && r.quote.page === 2 && r.quote.verified, 'and its page');
r = ok('accounts are created by the it lead after manager approval, and reviewed every quarter');
assert(r.ok && r.quote.quote.includes('IT lead') && r.quote.quote.includes('\n'), 'differences in case, spacing and line breaks are tolerated, and the document\'s own text (with its line break) is what is stored', r.ok ? r.quote.quote : r);
r = ok('reviewed every quarter - inactive accounts are disabled within 30 days');
assert(r.ok, 'a typographic dash in the document matches a plain hyphen from the model');
r = ok('“Shared accounts are prohibited by policy.”');
assert(r.ok && r.quote.quote === 'Shared accounts are prohibited by policy.', 'surrounding quote marks and a list bullet are ignored');
r = ok('Access to company systems ... inactive accounts are disabled within 30 days');
assert(r.ok && /inactive accounts are disabled within 30 days/.test(r.quote.quote), 'a quotation with an ellipsis is accepted as its longest part, which is exact', r.ok ? r.quote.quote : r);
assert(DOC.slice((r as any).quote.start, (r as any).quote.end) === (r as any).quote.quote, '... and its offsets still point at exactly that text');

const fail = (claimed: string) => { const x = ok(claimed); return x.ok ? null : x.reason; };
assert(fail('Users are granted access only after their manager approves the request and security is notified') === 'QUOTE_NOT_FOUND', 'a paraphrase is not a quotation');
assert(fail('Access to company systems is limited to authorized users and administrators.') === 'QUOTE_NOT_FOUND', 'an added word breaks it');
assert(fail('limited to authorized users company systems access to is') === 'QUOTE_NOT_FOUND', 'reordered words do not match');
assert(fail('AC.L1-3.1.1 Authorized') === 'QUOTE_TOO_SHORT', 'a fragment of fewer than five words is refused');
assert(fail('') === 'QUOTE_TOO_SHORT' && fail('   ') === 'QUOTE_TOO_SHORT', 'an empty quotation is refused');
const prompt = 'Authorized system access: limit information system access to authorized users, processes acting on behalf of authorized users, and devices.';
assert(fail(prompt) === 'QUOTE_NOT_FOUND', 'text copied from the control requirement (which is in the prompt, not the document) is not grounded');
assert(groundQuote(SECTION, START, 'Next section about something else entirely.', pages).ok === false, 'text from a different section is not accepted for this section');
const long = 'word '.repeat(400);
const lg = groundQuote(long, 0, long.trim());
assert(lg.ok && lg.quote.quote.length <= 600, 'a very long verbatim quotation is capped in length (and stays a true prefix)', lg.ok ? lg.quote.quote.length : lg);
assert(locateQuote(SECTION, 'nothing like this') === null, 'locateQuote returns null for text that is not there');

console.log('\n--- Control ids ---');
const L1 = (raw: unknown, offered?: string[]) => resolveControlId(raw, 'CMMC_L1', offered ? new Set(offered) : undefined);
const L2 = (raw: unknown, offered?: string[]) => resolveControlId(raw, 'CMMC_L2', offered ? new Set(offered) : undefined);
assert(JSON.stringify(L1('AC.L1-3.1.1')) === '{"ok":true,"controlId":"AC.L1-3.1.1"}', 'an exact catalog id resolves');
assert((L1('ac.l1-3.1.1') as any).controlId === 'AC.L1-3.1.1' && (L1('  AC.L1‑3.1.1 ') as any).controlId === 'AC.L1-3.1.1', 'case, spaces and typographic dashes are tolerated');
assert((L1('3.1.1') as any).controlId === 'AC.L1-3.1.1' && (L1('NIST SP 800-171 3.1.2') as any).controlId === 'AC.L1-3.1.2', 'a bare NIST number resolves to the framework\'s id');
assert((L2('AC.L1-3.1.1') as any).controlId === 'AC.L1-3.1.1' && (L2('AC.L2-3.1.5') as any).controlId === 'AC.L2-3.1.5', 'Level 2 resolves both its Level 1 and Level 2 practices');
assert((L1('AC.L2-3.1.1') as any).controlId === 'AC.L1-3.1.1', 'a wrong level label for a real number resolves to the right id');
assert((L1('AC.L2-3.1.5') as any).reason === 'OUT_OF_SCOPE', 'a Level 2 practice is out of scope for a Level 1 mapping');
assert((L1('AC.L1-3.1.99') as any).reason === 'UNKNOWN_CONTROL' && (L2('AC.L2-3.99.1') as any).reason === 'UNKNOWN_CONTROL', 'an id that does not exist is refused');
assert((L1('AC-2') as any).reason === 'UNKNOWN_CONTROL' && (L1('banana') as any).reason === 'UNKNOWN_CONTROL' && (L1(42) as any).reason === 'UNKNOWN_CONTROL' && (L1(null) as any).reason === 'UNKNOWN_CONTROL', 'a NIST 800-53 id, nonsense and non-strings are refused');
assert((L1('AC.L1-3.1.2', ['AC.L1-3.1.1']) as any).reason === 'NOT_OFFERED', 'a real control the model was not offered for this section is refused');
assert((L1('AC.L1-3.1.1', ['AC.L1-3.1.1']) as any).ok === true, 'an offered control is accepted');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
