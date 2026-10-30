import { ApiClient } from '../src/services/apiClient';
import {
  fetchStorageConfig,
  getStorageConfig,
  storagePathLabel,
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

console.log('\n--- storagePathLabel: the server value or nothing, never the client default ---');
assert(storagePathLabel({ loaded: true, localStoragePath: '/app/data/evidence' }) === '/app/data/evidence', 'a loaded config shows the server path');
assert(storagePathLabel({ loaded: false, localStoragePath: './data/evidence/' }) === null, 'a config the server has not answered shows no path');
assert(storagePathLabel({ loaded: true, localStoragePath: '' }) === null, 'a loaded config without a path shows no path');

const noPath = setServerStorageConfig({ provider: 'local', isAirGapped: true });
assert(noPath.localStoragePath === '' && getStorageConfig().localStoragePath === '', 'a server answer without a path keeps it empty (no invented default)');

(async () => {
  console.log('\n--- getStorageInfo / fetchStorageConfig send the session reference they are given ---');
  const realFetch = globalThis.fetch;
  try {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url);
      seenHeaders = init?.headers ?? {};
      return { ok: true, status: 200, json: async () => ({ provider: 'local', localStoragePath: '/app/data/evidence', isAirGapped: true }) };
    }) as unknown as typeof fetch;
    const info = await ApiClient.getStorageInfo('tenant-x', 'ref-1');
    assert(seenUrl.endsWith('/api/v1/evidence/config/storage-info'), 'calls the storage-info endpoint');
    assert(seenHeaders['X-PBC-Session'] === 'ref-1' && seenHeaders['x-tenant-id'] === 'tenant-x', 'sends the given session reference and the tenant id');
    assert(info?.localStoragePath === '/app/data/evidence', 'returns the server path');

    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    assert((await ApiClient.getStorageInfo('tenant-x', 'ref-1')) === null, 'a 401 resolves null');

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ provider: 'local', localStoragePath: '/srv/vault', isAirGapped: true }),
    })) as unknown as typeof fetch;
    const cfg = await fetchStorageConfig('tenant-x', 'ref-1');
    assert(cfg?.localStoragePath === '/srv/vault' && getStorageConfig().localStoragePath === '/srv/vault', 'fetchStorageConfig applies the server config');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
