import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { createRateLimiter } from '../server/middleware/rateLimit';

/**
 * Shared in-memory rate limiter (issue #165): the count-then-check behaviour, eviction instead of a full clear
 * (a spray of fresh addresses must not reset a limited address), the sweep and the hard cap, and that setup / AI assist
 * use the shared limiter. Pure: an injected clock, no server, no network.
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

type Options = Omit<Parameters<typeof createRateLimiter>[0], 'windowMs' | 'now'> & { windowMs?: number };

function clocked(options: Options) {
  let t = 1_000_000;
  const lim = createRateLimiter({ windowMs: 60_000, ...options, now: () => t });
  return { lim, advance: (ms: number) => void (t += ms) };
}

function call(lim: ReturnType<typeof createRateLimiter>, ip: string) {
  const res = { code: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { res.headers[k] = v; }, status(c: number) { res.code = c; return res; }, json() { return res; } };
  let nexted = false;
  lim({ ip } as unknown as Request, res as unknown as Response, () => { nexted = true; });
  return { nexted, code: res.code, retryAfter: res.headers['Retry-After'] };
}

function run() {
  console.log('--- Rate limiter ---');

  {
    const { lim } = clocked({ max: 3 });
    const first = [call(lim, 'a'), call(lim, 'a'), call(lim, 'a')];
    const fourth = call(lim, 'a');
    assert(first.every((r) => r.nexted), 'RL-1: the first max requests pass');
    assert(!fourth.nexted && fourth.code === 429 && fourth.retryAfter === '60', 'RL-1: the next one is 429 with Retry-After 60', fourth);
  }

  const { lim: spray } = clocked({ max: 3 });
  {
    for (let i = 0; i < 3; i++) call(spray, 'victim');
    for (let i = 0; i <= 10_000; i++) spray.hit('k' + i);
    assert(spray.size() === 10_002, 'RL-2: 10,001 other addresses do not clear any bucket', spray.size());
    const r = call(spray, 'victim');
    assert(!r.nexted && r.code === 429, 'RL-2: the limited address is still limited after the spray', r);
  }

  {
    const { lim, advance } = clocked({ max: 3, sweepAbove: 5, maxKeys: 100 });
    for (let i = 0; i < 5; i++) lim.hit('k' + i);
    advance(60_000);
    const fresh = lim.hit('fresh');
    assert(lim.size() === 1 && !fresh.limited, 'RL-3: expired keys are swept when a new key arrives above the threshold', lim.size());
    for (let i = 0; i < 5; i++) lim.hit('x' + i);
    assert(lim.size() === 6, 'RL-4: no second sweep inside the same window', lim.size());
    advance(60_000);
    lim.hit('y');
    assert(lim.size() === 1, 'RL-4: a window later the sweep runs again', lim.size());
  }

  {
    const { lim, advance } = clocked({ max: 1, sweepAbove: 1000, maxKeys: 3 });
    lim.hit('a'); advance(1);
    lim.hit('b'); advance(1);
    lim.hit('c'); advance(1);
    lim.hit('d');
    assert(lim.size() === 3, 'RL-5: the hard cap holds', lim.size());
    // Probe in an order that does not itself evict: b, c, d are kept (their counts survive), a was evicted
    const kept = [lim.hit('b').limited, lim.hit('c').limited, lim.hit('d').limited];
    assert(kept.every(Boolean), 'RL-5: the newest windows keep their counts', kept);
    assert(lim.hit('a').limited === false, 'RL-5: the oldest window was evicted (fresh bucket)');
  }

  {
    const { lim, advance } = clocked({ windowMs: 10, max: 1, sweepAbove: 1000, maxKeys: 2 });
    lim.hit('a');
    advance(10);
    lim.hit('b');
    lim.hit('a'); // a starts a new window and moves behind b
    lim.hit('c'); // evicts b, not a
    assert(lim.hit('a').limited === true, 'RL-6: a key that restarted its window is kept');
    assert(lim.hit('b').limited === false, 'RL-6: the older window (b) was evicted');
  }

  {
    const { lim, advance } = clocked({ max: 3 });
    for (let i = 0; i < 1000; i++) lim.hit('a');
    advance(59_999);
    const inside = lim.hit('a').limited;
    advance(1);
    const after = lim.hit('a').limited;
    assert(inside && !after, 'RL-7: trimming a key to max+1 hits gives the same limited / unlocked answers', { inside, after });
  }

  {
    const { lim } = clocked({ max: 1, key: () => 'shared' });
    call(lim, '1.1.1.1');
    const second = call(lim, '2.2.2.2');
    assert(!second.nexted && second.code === 429, 'RL-8: the key option makes one bucket for different addresses', second);
  }

  {
    spray.reset();
    assert(spray.size() === 0, 'RL-9: reset empties every bucket', spray.size());
    assert(call(spray, 'victim').nexted, 'RL-9: after reset the address passes again');
  }

  {
    const root = process.cwd();
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    const limiterSrc = read('server/middleware/rateLimit.ts');
    const clears = limiterSrc.match(/\.clear\(\)/g) ?? [];
    assert(clears.length === 1 && /reset: \(\) => hits\.clear\(\)/.test(limiterSrc), 'RL-10: rateLimit.ts clears only inside reset()', clears.length);
    for (const rel of ['server/routes/setup.ts', 'server/routes/aiAssist.ts']) {
      const src = read(rel);
      assert(src.includes('createRateLimiter(') && !/\.clear\(\)/.test(src), `RL-10: ${rel} uses the shared limiter and never clears all buckets`);
    }
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
