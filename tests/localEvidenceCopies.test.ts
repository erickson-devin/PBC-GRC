import fs from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';
import {
  bytesEqual,
  controlIdFromVaultPath,
  listLocalEvidenceCopies,
  moveLocalEvidenceCopy,
  moveLocalEvidenceKey,
  remapEvidenceLinks,
  MoveDeps,
  MoveInput,
} from '../src/services/localEvidenceCopies';

/**
 * Evidence files that exist only in this browser: which copies are listed, how one is moved to the server (the browser copy goes
 * only on proof), and how evidence links follow the server ids. Pure test: fake store, fake network, real Node crypto.subtle.
 * No server, no browser.
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
const AC1 = 'AC.L1-3.1.1';
const NAME = 'secret-plan.pdf';
const rec = (tenantId: string, data: ArrayBuffer, extra: Record<string, unknown> = {}) => ({ tenantId, name: NAME, type: 'application/pdf', size: data.byteLength, data, uploadedAt: '2026-10-01T00:00:00.000Z', ...extra });

function fakeStore(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    keys: async () => [...store.keys()] as unknown[],
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => { store.set(k, v); },
    del: async (k: string) => { store.delete(k); },
  };
}

type Payload = Parameters<MoveDeps['requestUploadUrl']>[0];

function moveHarness(opts: {
  data: ArrayBuffer;
  verify?: (id: string) => Promise<{ status: number; verified?: boolean; currentHash?: string }>;
  hash?: (d: ArrayBuffer) => Promise<string | null>;
  fetchServerBytes?: (id: string) => Promise<ArrayBuffer>;
  failRequest?: boolean;
  failUpload?: boolean;
}) {
  const s = fakeStore({ 'pbc_evidence_OLD_ev_1_aaaaa': rec('OLD', opts.data) });
  const h = {
    s,
    payloads: [] as Payload[],
    requests: 0,
    uploads: 0,
    serverDeletes: [] as string[],
    deps: undefined as unknown as MoveDeps,
  };
  h.deps = {
    get: s.get,
    set: s.set,
    del: s.del,
    hash: opts.hash ?? sha256,
    requestUploadUrl: async (p) => {
      h.requests++;
      h.payloads.push(p);
      if (opts.failRequest) throw new Error('no');
      return { uploadUrl: '/api/v1/evidence/upload-local/ev_9_srv', evidenceId: 'ev_9_srv' };
    },
    uploadFile: async () => {
      h.uploads++;
      if (opts.failUpload) throw new Error('no');
    },
    verify: opts.verify ?? (async () => ({ status: 200, verified: true, currentHash: await sha256(opts.data) })),
    fetchServerBytes: opts.fetchServerBytes,
    deleteServerRecord: async (id) => { h.serverDeletes.push(id); },
  };
  return h;
}
const input = (over: Partial<MoveInput> = {}): MoveInput => ({ key: 'pbc_evidence_OLD_ev_1_aaaaa', evidenceId: 'ev_1_aaaaa', controlId: AC1, targetTenantId: 'NEW', ...over });

async function main() {
  console.log('--- L: controlIdFromVaultPath and the listing ---');
  assert(controlIdFromVaultPath('tenants/T/controls/AC.L1-3.1.1/ev_1_aaaaa_plan.pdf') === AC1, 'L1 the control id is read from a vault path');
  assert(controlIdFromVaultPath(undefined) === null && controlIdFromVaultPath('Local') === null && controlIdFromVaultPath('tenants/T/controls/../x') === null, 'L2 undefined, "Local" and a ".." segment -> null');

  const a = bytes('one');
  const list = fakeStore({
    pbc_evidence_T_ev_1_aaaaa: rec('T', a, { gcsPath: `tenants/T/controls/${AC1}/ev_1_aaaaa_plan.pdf` }),
    pbc_evidence_T_ev_2_bbbbb: rec('T', a),
    pbc_evidence_OTHER_ev_3_ccccc: rec('OTHER', a),
    pbc_evidence_ev_4_ddddd: rec('T', a),
    pbc_evidence_ev_5_eeeee: rec('OTHER', a),
    pbc_evidence_T_ev_6_fffff: { ...rec('T', a), data: 'not bytes' },
  });
  const found = await listLocalEvidenceCopies(list, 'T', new Set(['ev_2_bbbbb']));
  assert(JSON.stringify(found.map(c => c.key)) === JSON.stringify(['pbc_evidence_T_ev_1_aaaaa', 'pbc_evidence_ev_4_ddddd']), 'L3 keys: only this tenant, not on the server, with real bytes, sorted', found.map(c => c.key));
  assert(JSON.stringify(found.map(c => c.evidenceId)) === JSON.stringify(['ev_1_aaaaa', 'ev_4_ddddd']), 'L3 evidence ids come from the tenant key and the legacy key', found.map(c => c.evidenceId));
  assert(JSON.stringify(found.map(c => c.controlId)) === JSON.stringify([AC1, null]), 'L3 the control id comes from the vault path when there is one', found.map(c => c.controlId));

  const prefix = fakeStore({ pbc_evidence_T_x_ev_7_ggggg: rec('T_x', a) });
  assert((await listLocalEvidenceCopies(prefix, 'T', new Set())).length === 0, 'L4 a tenant whose id extends this one (T_x vs T) is not listed');

  const messy = fakeStore({ other_key: rec('T', a), pbc_evidence_T_ev_8_hhhhh: rec('T', a), pbc_evidence_T_ev_9_iiiii: rec('T', a) });
  const baseKeys = messy.keys;
  const result5 = await listLocalEvidenceCopies(
    { keys: async () => [...(await baseKeys()), 42, null], get: async (k) => { if (k === 'pbc_evidence_T_ev_8_hhhhh') throw new Error('boom'); return messy.get(k); } },
    'T',
    new Set()
  );
  assert(JSON.stringify(result5.map(c => c.evidenceId)) === JSON.stringify(['ev_9_iiiii']), 'L5 numeric keys and other_key are ignored; a get that rejects skips only that key', result5.map(c => c.evidenceId));
  const broken = await listLocalEvidenceCopies({ keys: async () => { throw new Error('no idb'); }, get: async () => undefined }, 'T', new Set());
  assert(broken.length === 0, 'L5 a keys() that rejects returns an empty list and does not throw');

  console.log('\n--- M: moveLocalEvidenceCopy ---');
  const data = bytes('the file bytes');
  const results: unknown[] = [];

  const m1 = moveHarness({ data });
  const r1 = await moveLocalEvidenceCopy(m1.deps, input());
  results.push(r1);
  assert(JSON.stringify(r1) === JSON.stringify({ status: 'moved', serverEvidenceId: 'ev_9_srv' }) && !m1.s.store.has('pbc_evidence_OLD_ev_1_aaaaa') && m1.s.store.size === 0, 'M1 verified upload -> moved, and the browser copy is deleted', [r1, m1.s.store.size]);
  const p1 = m1.payloads[0];
  assert(p1.controlId === AC1 && p1.fileHash === await sha256(data) && p1.fileSize === data.byteLength && p1.mimeType === 'application/pdf' && p1.description === `Audit evidence for control ${AC1}`, 'M1 the request carries the control, the real hash, the size, the type and the default description', p1);

  const m2 = moveHarness({ data, verify: async () => ({ status: 200, verified: true, currentHash: 'a'.repeat(64) }) });
  const r2 = await moveLocalEvidenceCopy(m2.deps, input());
  results.push(r2);
  const kept = m2.s.store.get('pbc_evidence_NEW_ev_9_srv') as { tenantId?: string; data?: ArrayBuffer } | undefined;
  assert(r2.status === 'uploadedUnverified' && !m2.s.store.has('pbc_evidence_OLD_ev_1_aaaaa') && Boolean(kept) && kept?.tenantId === 'NEW' && kept?.data instanceof ArrayBuffer && bytesEqual(kept.data, data), 'M2 a hash mismatch -> uploadedUnverified, re-keyed under the server id with the new tenant id', r2);

  const m3 = moveHarness({ data, failRequest: true });
  const r3 = await moveLocalEvidenceCopy(m3.deps, input());
  results.push(r3);
  assert(r3.status === 'failed' && m3.s.store.size === 1 && m3.s.store.has('pbc_evidence_OLD_ev_1_aaaaa') && m3.uploads === 0 && m3.serverDeletes.length === 0, 'M3 requestUploadUrl rejects -> failed, store unchanged, no upload, no server delete', r3);

  const m4 = moveHarness({ data, failUpload: true });
  const r4 = await moveLocalEvidenceCopy(m4.deps, input());
  results.push(r4);
  assert(r4.status === 'failed' && JSON.stringify(m4.serverDeletes) === JSON.stringify(['ev_9_srv']) && m4.s.store.size === 1 && m4.s.store.has('pbc_evidence_OLD_ev_1_aaaaa'), 'M4 uploadFile rejects -> failed, the orphan server record is deleted once, store unchanged', [r4, m4.serverDeletes]);

  const m5 = moveHarness({ data, hash: async () => null, verify: async () => ({ status: 200, verified: true }), fetchServerBytes: async () => bytes('the file bytes') });
  const r5 = await moveLocalEvidenceCopy(m5.deps, input());
  results.push(r5);
  assert(r5.status === 'moved' && m5.payloads[0].fileHash === 'sha256-unavailable' && m5.s.store.size === 0, 'M5 no local hash, server bytes identical -> moved, with the placeholder hash sent', [r5, m5.payloads[0]?.fileHash]);

  const m6 = moveHarness({ data, hash: async () => null, verify: async () => ({ status: 200, verified: true }), fetchServerBytes: async () => bytes('different bytes!') });
  const r6 = await moveLocalEvidenceCopy(m6.deps, input());
  results.push(r6);
  assert(r6.status === 'uploadedUnverified' && m6.s.store.has('pbc_evidence_NEW_ev_9_srv') && !m6.s.store.has('pbc_evidence_OLD_ev_1_aaaaa'), 'M6 no local hash, server bytes differ -> uploadedUnverified and the copy is kept', r6);

  const m7 = moveHarness({ data });
  const r7 = await moveLocalEvidenceCopy(m7.deps, input({ controlId: null }));
  const r7b = await moveLocalEvidenceCopy(m7.deps, input({ key: 'pbc_evidence_OLD_missing' }));
  results.push(r7, r7b);
  assert(r7.status === 'needsControl' && m7.requests === 0 && r7b.status === 'missing', 'M7 no control -> needsControl with no request; a missing key -> missing', [r7, r7b, m7.requests]);

  assert(results.every(r => !JSON.stringify(r).includes(NAME)), 'M8 no result carries the file name');

  const mk = fakeStore({ pbc_evidence_ev_1_aaaaa: rec('OLD', data) });
  const okKey = await moveLocalEvidenceKey(mk, 'pbc_evidence_ev_1_aaaaa', 'NEW', 'ev_1_aaaaa');
  const moved = mk.store.get('pbc_evidence_NEW_ev_1_aaaaa') as { tenantId?: string } | undefined;
  assert(okKey === true && !mk.store.has('pbc_evidence_ev_1_aaaaa') && moved?.tenantId === 'NEW', 'M9 moveLocalEvidenceKey re-keys a legacy record and rewrites its tenant id');
  assert((await moveLocalEvidenceKey(mk, 'pbc_evidence_nothing', 'NEW', 'x')) === false, 'M9 a missing record -> false');

  console.log('\n--- R: remapEvidenceLinks, B: bytesEqual ---');
  const objectives = { 'AC.L1-3.1.1[a]': { linkedEvidenceIds: ['ev_1', 'ev_1__inh_AC_1', 'ev_x'] } };
  const before = JSON.stringify(objectives);
  const mapped = remapEvidenceLinks(objectives, { ev_1: 'ev_9' });
  assert(JSON.stringify(mapped['AC.L1-3.1.1[a]'].linkedEvidenceIds) === JSON.stringify(['ev_9', 'ev_9__inh_AC_1', 'ev_x']) && JSON.stringify(objectives) === before, 'R1 exact ids and inherited copies are mapped, unknown ids kept, the input is not mutated', mapped);
  assert(remapEvidenceLinks(objectives, {}) === objectives, 'R2 an empty map returns the input unchanged');
  assert(bytesEqual(bytes('a'), bytes('a')) === true && bytesEqual(bytes('a'), bytes('ab')) === false && bytesEqual(bytes('a'), bytes('b')) === false, 'B1 bytesEqual compares length and content');

  console.log('\n--- S: source checks ---');
  const view = read('src/components/vault/EvidenceVaultView.tsx');
  const dialog = read('src/components/vault/ConfirmDiscardLocalCopyDialog.tsx');
  const service = read('src/services/localEvidenceCopies.ts');
  const hook = read('src/hooks/useLocalEvidenceCopies.ts');
  assert(['useLocalEvidenceCopies(', 'Only in this browser', 'Upload to server', 'setPendingDiscard(copy)', '<ConfirmDiscardLocalCopyDialog'].every(s => view.includes(s)) && !view.includes('onClick={() => local.discard('), 'S1 the vault lists the copies, offers upload and discard, and discards only through the dialog');
  assert(dialog.includes('role="alertdialog"') && dialog.includes('onClose={handleCancel}') && dialog.includes('autoFocus') && dialog.split('if (busyRef.current) return;').length - 1 >= 2 && !dialog.includes('dangerouslySetInnerHTML') && !dialog.includes('console.'), 'S2 the dialog is an alertdialog that ignores Escape and a second click while busy, with no console and no raw HTML');
  const consoleNaming = (src: string) => src.split('\n').filter(l => /console\.(log|warn|error|info|debug)\(/.test(l) && /\b(name|fileName)\b/.test(l));
  assert(!service.includes('console.') && consoleNaming(hook).length === 0 && consoleNaming(dialog).length === 0, 'S3 the service has no console and no console line names a file');
  const deletedAt = hook.indexOf("'EVIDENCE_DELETED'");
  const auditBlock = hook.slice(Math.max(0, deletedAt - 400), deletedAt + 400);
  assert(['serverBacked', 'liveScopeKey', 'ApiClient.getEvidence(', 'programs'].every(s => hook.includes(s)) && deletedAt !== -1 && !auditBlock.includes('copy.name'), 'S4 the hook is gated on a server-backed tenant and the live scope, asks every program, and the ledger entry has no file name');
  const scrub = read('src/hooks/useEvidenceBlobScrub.ts');
  assert(/import \{ sha256Hex \} from '\.\.\/services\/localEvidenceCopies'/.test(scrub) && !/async function sha256Hex/.test(scrub), 'S5 the scrub hook imports sha256Hex from the service');
  assert(!view.includes('gcsPath'), 'S167-1 the vault list does not reference the stored path (on a server tenant it is the absolute disk path)');
  assert(['{item.name}', 'item.controlId', 'item.fileHash'].every(s => view.includes(s)), 'S167-2 each row still shows the file name, the control and the SHA-256');
  assert(read('src/types/cmmc.ts').includes('gcsPath?: string'), 'S167-3 the path stays in the evidence data for the integrity check and the handover package');
  assert(!read('src/components/common/EvidencePreviewModal.tsx').includes('gcsPath') && !read('src/components/ssp/SSPBuilder.tsx').includes('gcsPath') && !read('src/services/storageService.ts').includes('gcsPath'), 'S167-4 the preview modal, the printable SSP and the markdown export show no stored path');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
