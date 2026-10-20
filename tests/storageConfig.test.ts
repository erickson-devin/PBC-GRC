import {
  getStorageConfig,
  setServerStorageConfig,
  subscribeStorageConfig,
} from '../src/data/audit/storageDriver';

/**
 * Regression: useStorageConfig feeds getStorageConfig to React's useSyncExternalStore as `getSnapshot`.
 * It must return the SAME reference while nothing changed, or React re-renders forever
 * ("Maximum update depth exceeded").
 */
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

assert(getStorageConfig() === getStorageConfig(), 'env-derived snapshot is referentially stable before the server answers');
assert(getStorageConfig().provider === 'local', 'defaults to local (air-gap safe) before the server answers');

let notifications = 0;
const unsubscribe = subscribeStorageConfig(() => {
  notifications++;
});

const first = setServerStorageConfig({ provider: 'local', localStoragePath: './data/evidence', isAirGapped: true });
assert(getStorageConfig() === first, 'server config becomes the snapshot');
assert(getStorageConfig() === getStorageConfig(), 'server-config snapshot is referentially stable');
assert(notifications === 1, 'subscribers notified once on first server config');

const again = setServerStorageConfig({ provider: 'local', localStoragePath: './data/evidence', isAirGapped: true });
assert(again === first && notifications === 1, 'identical server config keeps the reference and does not re-notify');

setServerStorageConfig({ provider: 'local', localStoragePath: '/srv/evidence', isAirGapped: true });
assert(getStorageConfig().localStoragePath === '/srv/evidence' && notifications === 2, 'changed server config (the path) updates snapshot and notifies');

const legacy = setServerStorageConfig({ provider: 'gcs' } as unknown as Parameters<typeof setServerStorageConfig>[0]);
assert(legacy.provider === 'local', 'a legacy provider value from an old server normalises to local');

unsubscribe();

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
