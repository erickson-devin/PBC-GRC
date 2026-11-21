import {
  AFFILIATIONS,
  MAX_EXPIRY_DAYS,
  US_PERSON_VALUES,
  accessEndsAtMs,
  checkNewExpiry,
  isAffiliation,
  isUsPerson,
  membershipExpired,
  parseExpiryDate,
  utcToday,
} from '../src/utils/memberProfile';

/** Membership profile helpers (issues #258, #259): pure functions, no server. Every time is passed in; nothing here reads the clock. */
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

const NOW = Date.parse('2026-11-19T12:00:00.000Z');

console.log('--- membershipExpired: the day lasts until the end of UTC ---');
assert(membershipExpired('2026-12-31', Date.parse('2026-12-31T23:59:59.999Z')) === false, 'the last millisecond of the expiry day is still allowed');
assert(membershipExpired('2026-12-31', Date.parse('2027-01-01T00:00:00.000Z')) === true, 'the first millisecond after the expiry day is expired');
assert(membershipExpired('2026-12-31', Date.parse('2026-12-31T00:00:00.000Z')) === false, 'the start of the expiry day is allowed');
assert(membershipExpired('2026-12-31', Date.parse('2026-12-31T23:30:00-05:00')) === true, 'a UTC instant after midnight counts although the local clock at -05:00 still reads the 31st');
assert(membershipExpired(null, NOW) === false && membershipExpired(undefined, NOW) === false, 'no expiry never expires');
assert(membershipExpired('2026-02-30', NOW) === true && membershipExpired('', NOW) === true && membershipExpired('garbage', NOW) === true, 'a malformed value counts as expired (fails closed)');
assert(membershipExpired('2026-12-31T00:00:00Z', NOW) === true, 'a timestamp instead of a date is malformed, so expired');

console.log('\n--- parseExpiryDate / accessEndsAtMs ---');
assert(parseExpiryDate('2028-02-29') === '2028-02-29', 'a leap day parses');
assert(parseExpiryDate('2027-02-29') === null, 'a leap day in a common year does not');
assert(parseExpiryDate(20261231) === null && parseExpiryDate(null) === null && parseExpiryDate('2026-1-5') === null, 'non-strings and short forms do not parse');
assert(parseExpiryDate('0050-01-01') === null, 'a year below 100 does not parse');
assert(accessEndsAtMs('2026-12-31') === Date.UTC(2027, 0, 1) && accessEndsAtMs('2026-12-30') === Date.UTC(2026, 11, 31) && accessEndsAtMs('nope') === null, 'access ends at the next UTC midnight; malformed gives null');

console.log('\n--- checkNewExpiry (now = 2026-11-19T12:00Z) ---');
assert(checkNewExpiry('2026-11-19', NOW) === null, 'today (UTC) is allowed');
assert(checkNewExpiry('2026-11-18', NOW) === 'expiry_in_past', 'yesterday is in the past');
assert(checkNewExpiry('2026-02-30', NOW) === 'invalid_request' && checkNewExpiry('x', NOW) === 'invalid_request', 'a bad date is invalid_request');
const limitDay = utcToday(NOW + MAX_EXPIRY_DAYS * 86_400_000);
const beyondDay = utcToday(NOW + (MAX_EXPIRY_DAYS + 1) * 86_400_000);
assert(checkNewExpiry(limitDay, NOW) === null && checkNewExpiry(beyondDay, NOW) === 'expiry_too_far', 'MAX_EXPIRY_DAYS ahead is allowed, one more day is too far', [limitDay, beyondDay]);
assert(checkNewExpiry('2036-11-21', NOW) === 'expiry_too_far', 'about ten years and two days ahead is too far');
assert(checkNewExpiry('2026-11-20', Date.parse('2026-11-19T23:59:59.999Z')) === null && checkNewExpiry('2026-11-19', Date.parse('2026-11-20T00:00:00.000Z')) === 'expiry_in_past', '"today" turns over at UTC midnight');

console.log('\n--- utcToday ---');
assert(utcToday(Date.parse('2026-11-19T23:30:00-05:00')) === '2026-11-20', 'the UTC day, not the local day');
assert(utcToday(Date.parse('2026-01-01T00:00:00.000Z')) === '2026-01-01', 'the first instant of a UTC day');

console.log('\n--- value lists ---');
assert(AFFILIATIONS.join() === 'EMPLOYEE,CONTRACTOR,ESP' && US_PERSON_VALUES.join() === 'US_PERSON,OTHER', 'the lists are as documented');
assert(isAffiliation('ESP') && !isAffiliation('esp') && !isAffiliation(null) && isUsPerson('OTHER') && !isUsPerson('YES') && !isUsPerson(undefined), 'the type guards accept exactly the listed values');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exitCode = passed === total ? 0 : 1;
