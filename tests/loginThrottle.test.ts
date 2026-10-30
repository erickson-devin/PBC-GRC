import { createLoginThrottle, loginAccountKey } from '../server/auth/loginThrottle';
import { createForwardedForWarning } from '../server/trustProxy';

/**
 * Sign-in throttle (issue #41): the per-IP window, the per-account failure lock (covering emails with no account),
 * hashed keys, bounded memory, and the one-time X-Forwarded-For warning. Pure: an injected clock, no server, no network.
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

function clockedThrottle(options: Parameters<typeof createLoginThrottle>[0] = {}) {
  let t = 1_000_000;
  const throttle = createLoginThrottle({ ...options, now: () => t });
  return { throttle, advance: (ms: number) => void (t += ms) };
}

function run() {
  console.log('\n--- LT-1..3: per-IP window ---');
  {
    const { throttle, advance } = clockedThrottle();
    const first20 = Array.from({ length: 20 }, () => throttle.hitIp('10.0.0.1'));
    assert(first20.every((h) => !h.limited), 'LT-1: 20 hits in the window are allowed');
    const twentyFirst = throttle.hitIp('10.0.0.1');
    assert(twentyFirst.limited && twentyFirst.retryAfterSeconds === 60, 'LT-1: the 21st is limited with retryAfterSeconds 60', twentyFirst);
    assert(!throttle.hitIp('10.0.0.2').limited, 'LT-2: another address is not limited');
    advance(60_000);
    assert(!throttle.hitIp('10.0.0.1').limited, 'LT-3: after the window the address is allowed again');
  }

  console.log('\n--- LT-4..6: per-account lock ---');
  {
    const { throttle, advance } = clockedThrottle();
    const key = loginAccountKey('ann@enclave.mil');
    for (let i = 0; i < 4; i++) throttle.recordAccountFailure(key);
    assert(throttle.accountLockedFor(key) === 0, 'LT-4: 4 failures do not lock');
    throttle.recordAccountFailure(key);
    assert(throttle.accountLockedFor(key) === 900, 'LT-4: the 5th failure locks for 900 seconds', throttle.accountLockedFor(key));
    advance(899_000);
    assert(throttle.accountLockedFor(key) === 1, 'LT-5: 899 seconds later 1 second is left');
    advance(1_000);
    assert(throttle.accountLockedFor(key) === 0, 'LT-5: the lock has expired');
    throttle.recordAccountFailure(key);
    assert(throttle.accountLockedFor(key) === 0, 'LT-5: a failure after expiry starts a new count (still not locked)');
  }
  {
    const { throttle } = clockedThrottle();
    const key = loginAccountKey('bob@enclave.mil');
    for (let i = 0; i < 4; i++) throttle.recordAccountFailure(key);
    throttle.clearAccount(key);
    for (let i = 0; i < 4; i++) throttle.recordAccountFailure(key);
    assert(throttle.accountLockedFor(key) === 0, 'LT-6: clearAccount resets the count');
  }

  console.log('\n--- LT-7: keys hold no email ---');
  {
    const a = loginAccountKey(' Ann@Enclave.MIL ');
    const b = loginAccountKey('ann@enclave.mil');
    assert(a === b, 'LT-7: the key is the same after trim and lower-casing');
    assert(a.startsWith('acct:') && a.length === 69, 'LT-7: acct: prefix plus 64 hex characters', a.length);
    assert(!a.includes('ann') && !a.includes('@'), 'LT-7: the key contains neither the name nor an @');
  }

  console.log('\n--- LT-8..9: bounded memory, reset ---');
  {
    const { throttle } = clockedThrottle({ maxKeys: 3 });
    for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) throttle.hitIp(ip);
    assert(throttle.sizes().ip === 3, 'LT-8: four addresses with maxKeys 3 keep 3 (oldest evicted, never a full clear)', throttle.sizes());
  }
  {
    const { throttle, advance } = clockedThrottle({ maxKeys: 2 });
    const a = loginAccountKey('a@x.mil');
    const b = loginAccountKey('b@x.mil');
    const c = loginAccountKey('c@x.mil');
    for (let i = 0; i < 5; i++) throttle.recordAccountFailure(a);
    advance(900_000); // A's lock has expired
    throttle.recordAccountFailure(b);
    throttle.recordAccountFailure(c);
    assert(throttle.sizes().account === 2, 'LT-8: two keys remain with maxKeys 2', throttle.sizes());
    for (let i = 0; i < 4; i++) throttle.recordAccountFailure(b);
    assert(throttle.accountLockedFor(b) === 900, 'LT-8: the expired entry went first: B kept its count and locks on its 5th failure');
    throttle.reset();
    assert(throttle.sizes().ip === 0 && throttle.sizes().account === 0, 'LT-9: reset empties both maps');
  }

  console.log('\n--- LT-10: X-Forwarded-For warning ---');
  {
    const lines: string[] = [];
    const mw = createForwardedForWarning((m) => void lines.push(m));
    let nexts = 0;
    const next = () => void nexts++;
    const req = { headers: { 'x-forwarded-for': '10.9.8.7' }, app: { get: () => false } } as any;
    mw(req, {} as any, next);
    mw(req, {} as any, next);
    assert(lines.length === 1 && nexts === 2, 'LT-10: warns once, next is called every time', { lines: lines.length, nexts });
    assert(!lines[0].includes('10.9.8.7') && lines[0].includes('TRUST_PROXY'), 'LT-10: the message never includes the header value');

    const quiet: string[] = [];
    const noHeader = createForwardedForWarning((m) => void quiet.push(m));
    noHeader({ headers: {}, app: { get: () => false } } as any, {} as any, next);
    const trusted = createForwardedForWarning((m) => void quiet.push(m));
    trusted({ headers: { 'x-forwarded-for': '10.9.8.7' }, app: { get: () => 'loopback' } } as any, {} as any, next);
    assert(quiet.length === 0, 'LT-10: no header, or TRUST_PROXY set, means no warning');
  }

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
}

try {
  run();
} catch (err) {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
}
