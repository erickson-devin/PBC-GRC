import fs from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';
import { decideBlobAction, previewKind, runEvidenceBlobScrub, ScrubDeps, VerifyResult } from '../src/services/evidenceBlobScrub';

/**
 * Evidence files of a server-backed tenant: the browser copy is removed only after the server verifies the same bytes, and what a
 * file may render as is decided by previewKind. Pure test: fake store, fake verify, real Node crypto.subtle. No server, no browser.
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

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

async function sha256(data: ArrayBuffer): Promise<string> {
  const d = await webcrypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const TENANT = 'tenant-secret-1';

interface Harness {
  store: Map<string, unknown>;
  verifyCalls: string[];
  deletes: string[];
  logs: string[];
  deps: ScrubDeps & { tenantId: string };
}

function harness(verify: (id: string) => Promise<VerifyResult>, hash: (d: ArrayBuffer) => Promise<string | null> = sha256): Harness {
  const store = new Map<string, unknown>();
  const h: Harness = {
    store,
    verifyCalls: [],
    deletes: [],
    logs: [],
    deps: {
      tenantId: TENANT,
      get: async (k) => store.get(k),
      del: async (k) => { h.deletes.push(k); store.delete(k); },
      verify: async (id) => { h.verifyCalls.push(id); return verify(id); },
      hash,
      log: (m) => { h.logs.push(m); },
    },
  };
  return h;
}

const rec = (data: ArrayBuffer, name = 'secret-plan.pdf') => ({ tenantId: TENANT, name, type: 'application/pdf', size: data.byteLength, data, uploadedAt: 'x' });
const key = (id: string) => `pbc_evidence_${TENANT}_${id}`;

async function main() {
  console.log('\n=== evidence blob scrub ===');
  const data = bytes('the evidence bytes');
  const good = await sha256(data);

  // E1
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('e1'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, []);
    assert(h.verifyCalls.length === 0 && h.deletes.length === 0 && c.removed === 0, 'E1 no ids -> no verify calls, nothing deleted');
  }
  // E2
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('e2'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e2']);
    assert(c.removed === 1 && !h.store.has(key('e2')), 'E2 verified with a matching hash -> deleted, removed 1', c);
  }
  // E3
  {
    const h = harness(async () => ({ status: 404 }));
    h.store.set(key('e3'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e3']);
    assert(c.keptNotOnServer === 1 && c.removed === 0 && h.store.has(key('e3')), 'E3 404 -> kept, keptNotOnServer', c);
  }
  // E4
  {
    const h = harness(async () => ({ status: 200, verified: false, currentHash: good }));
    h.store.set(key('e4'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e4']);
    assert(c.keptUnverified === 1 && c.removed === 0 && h.store.has(key('e4')), 'E4 verified false -> kept', c);
  }
  // E5
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: 'a'.repeat(64) }));
    h.store.set(key('e5'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e5']);
    assert(c.keptUnverified === 1 && c.removed === 0 && h.store.has(key('e5')), 'E5 hash differs -> kept', c);
  }
  // E6
  {
    const h0 = harness(async () => ({ status: 0 }));
    h0.store.set(key('e6'), rec(data));
    const c0 = await runEvidenceBlobScrub(h0.deps, ['e6']);
    const h1 = harness(async () => { throw new Error('network'); });
    h1.store.set(key('e6'), rec(data));
    let threw = false;
    let c1 = { removed: -1, keptNotOnServer: -1, keptUnverified: -1 };
    try { c1 = await runEvidenceBlobScrub(h1.deps, ['e6']); } catch { threw = true; }
    assert(c0.keptUnverified === 1 && h0.store.has(key('e6')), 'E6a status 0 -> kept', c0);
    assert(!threw && c1.keptUnverified === 1 && c1.removed === 0 && h1.store.has(key('e6')), 'E6b verify throws -> kept, run does not throw', c1);
  }
  // E7
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }), async () => null);
    h.store.set(key('e7'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e7']);
    assert(c.keptUnverified === 1 && c.removed === 0 && h.store.has(key('e7')), 'E7 hash unavailable -> kept', c);
  }
  // E8
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('m1'), 'not an object');
    h.store.set(key('m2'), { name: 'x' });
    h.store.set(key('m3'), { data: 'string, not bytes' });
    h.store.set(key('m4'), null);
    let threw = false;
    let c = { removed: -1, keptNotOnServer: -1, keptUnverified: -1 };
    try { c = await runEvidenceBlobScrub(h.deps, ['m1', 'm2', 'm3', 'm4', 'missing']); } catch { threw = true; }
    assert(!threw && c.removed === 0 && h.verifyCalls.length === 0 && h.deletes.length === 0, 'E8 malformed or missing records are skipped without a throw', c);
  }
  // E9
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set('pbc_evidence_e9', rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['e9']);
    assert(c.removed === 1 && !h.store.has('pbc_evidence_e9'), 'E9 legacy key with a match -> deleted', c);
  }
  // E10
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('e10'), rec(data));
    await runEvidenceBlobScrub(h.deps, ['e10']);
    const before = h.deletes.length;
    const c = await runEvidenceBlobScrub(h.deps, ['e10']);
    assert(c.removed === 0 && h.deletes.length === before, 'E10 second run deletes nothing', c);
  }
  // E11
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('mine'), rec(data));
    h.store.set('pbc_evidence_other-tenant_theirs', rec(data));
    await runEvidenceBlobScrub(h.deps, ['mine']);
    assert(h.store.has('pbc_evidence_other-tenant_theirs') && !h.store.has(key('mine')), 'E11 another tenant\'s key, not in ids, is untouched');
  }
  // E12
  {
    const h = harness(async () => ({ status: 200, verified: true, currentHash: good }));
    h.store.set(key('evid-secret-id'), rec(data, 'secret-plan.pdf'));
    await runEvidenceBlobScrub(h.deps, ['evid-secret-id']);
    const line = h.logs.join('\n');
    assert(h.logs.length === 1 && line === '[evidence-scrub] removed 1, kept-not-on-server 0, kept-unverified 0', 'E12a one counts-only log line', h.logs);
    assert(!line.includes('evid-secret-id') && !line.includes(TENANT) && !line.includes('secret-plan'), 'E12b the log line has no id, tenant or file name');
  }
  // E13 hash case and serial order
  {
    const order: string[] = [];
    const h = harness(async (id) => { order.push(`v:${id}`); return { status: 200, verified: true, currentHash: good.toUpperCase() }; });
    h.store.set(key('a'), rec(data));
    h.store.set(key('b'), rec(data));
    const c = await runEvidenceBlobScrub(h.deps, ['a', 'b']);
    assert(c.removed === 2 && order.join(',') === 'v:a,v:b', 'E13 an upper-case server hash still matches; ids are handled in order', { c, order });
    assert(decideBlobAction({ status: 200, verified: true, currentHash: 'sha256_123_abc' }, 'sha256_123_abc') === 'keptUnverified', 'E14 a pseudo hash is never a match');
  }

  // previewKind
  assert(previewKind('application/pdf', 'a.pdf') === 'pdf', 'P1 pdf');
  assert(previewKind('text/html', 'a.pdf') === 'download', 'P2 text/html named .pdf is never pdf');
  assert(previewKind('image/png', 'a.png') === 'image', 'P3 png is an image');
  assert(previewKind('image/svg+xml', 'a.svg') === 'download', 'P4 svg is download-only');
  assert(previewKind('text/plain', 'a.txt') === 'text', 'P5 text/plain is text');
  assert(previewKind('application/json', 'a.json') === 'text', 'P6 json is text');
  assert(previewKind('application/octet-stream', 'a.bin') === 'download', 'P7 octet-stream is download');
  assert(previewKind('', 'x.html') === 'download', 'P8 empty type with .html is download');
  assert(previewKind('text/html', 'x.txt') === 'download', 'P9 text/html is never text');
  assert(previewKind('', 'x.csv') === 'text' && previewKind('', 'x.txt') === 'text', 'P10 empty type with .csv / .txt is text');
  assert(previewKind('application/pdf; charset=binary', 'a.pdf') === 'pdf' && previewKind('IMAGE/JPEG', 'a.jpg') === 'image', 'P11 parameters and case are normalised');
  assert(previewKind('application/pdf', 'a.html') === 'pdf' && previewKind(undefined, undefined) === 'download', 'P12 undefined inputs are download');

  // Source checks
  const ctx = read('src/context/AssessmentContext.tsx');
  const start = ctx.indexOf('const uploadEvidence = useCallback');
  const upload = ctx.slice(start, ctx.indexOf('// Action: Remove Evidence', start));
  const okBranch = upload.slice(upload.indexOf('if (uploadResp) {'), upload.indexOf('} catch {'));
  assert(okBranch.length > 0 && !/EvidenceVault\.saveFile/.test(okBranch), 'S1 the successful-upload branch does not save a browser copy');
  const saveAt = upload.indexOf('EvidenceVault.saveFile');
  const guardAt = upload.indexOf('if (currentTenant.serverBacked) throw');
  assert(saveAt === -1 || (guardAt !== -1 && guardAt < saveAt), 'S2 any remaining saveFile in uploadEvidence sits after a serverBacked check');
  assert(/was not saved to the server/.test(upload), 'S3 a server-backed failure throws "not saved to the server"');
  assert(/useEvidenceBlobScrub\(\);/.test(ctx), 'S4 AssessmentContext calls useEvidenceBlobScrub');

  const modal = read('src/components/common/EvidencePreviewModal.tsx');
  const view = read('src/components/vault/EvidenceVaultView.tsx');
  assert(modal.includes('getEvidenceFileBlob') && modal.includes('revokeObjectURL'), 'S5 EvidencePreviewModal fetches from the server and revokes its object URLs');
  assert(view.includes('getEvidenceFileBlob') && view.includes('revokeObjectURL'), 'S6 EvidenceVaultView downloads from the server and revokes its object URL');
  const api = read('src/services/apiClient.ts');
  const fnStart = api.indexOf('async getEvidenceFileBlob');
  const fnBody = api.slice(fnStart, api.indexOf('async verifyEvidenceIntegrity', fnStart));
  assert(fnStart !== -1 && /cache: 'no-store'/.test(fnBody), 'S7 getEvidenceFileBlob asks for cache: no-store');
  const iframeAt = modal.indexOf('<iframe');
  assert(iframeAt !== -1 && modal.indexOf("kind === 'pdf'") !== -1 && modal.indexOf("kind === 'pdf'") < iframeAt && modal.split('<iframe').length === 2, 'S8 the only iframe sits under the pdf kind');
  assert(!/dangerouslySetInnerHTML/.test(modal), 'S9 the preview never uses dangerouslySetInnerHTML');
  const hook = read('src/hooks/useEvidenceBlobScrub.ts');
  assert(/liveScopeKey !== scope/.test(hook) && /serverBacked/.test(hook), 'S10 the scrub waits for the live data of the scope on screen and only runs for server-backed tenants');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
