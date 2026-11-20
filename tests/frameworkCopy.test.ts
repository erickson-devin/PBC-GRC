import './testEnv';
import { EVIDENCE_TEST_VAULT } from './evidenceEnv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { getFrameworkControls } from '../src/data/frameworks';
import { archiveProgram } from '../server/programs';
import { updateTenantSettings, queryWithProgram } from '../server/db';
import { writeControlAssessment } from '../server/controlAssessments';
import { VM_NOTES_BEGIN, VM_NOTES_END, VM_SNAPSHOT_ACTOR, stripDelimitedBlocks } from '../server/vm/snapshot';
import { __frameworkCopyRowsForTests } from '../server/frameworkCopy/store';
import { newInR3, r2r3Mapping } from '../src/data/frameworks/nist171r3/r2r3';
import { planFrameworkCopy, planDigestInput, suggestR3Status } from '../src/data/frameworkCopy/plan';

/**
 * "Copy from Rev. 2" over HTTP (#255): a CMMC Level 2 program is copied into a NIST SP 800-171 Rev. 3 program. Preview writes nothing and agrees with the pure
 * planner; commit appends (the existing text stays first), records a 'clone' history event without the text, copies the evidence bytes (new file, same hash,
 * independent of the source), skips inherited and vulnerability-snapshot evidence, links tools and documents through their own stores, and is idempotent
 * (a second preview has nothing to do, a second commit changes nothing, two commits at once append once). A stale digest is 409, more than 200 evidence
 * files is 413, roles and sources are checked, error bodies carry `code` and `reason`, and the server log holds neither a note nor a file name.
 * Runs against the in-memory store and a throw-away vault. PostgreSQL paths (transaction, markers, rollback, RLS) are proven by scripts/verifyRls.ts in CI.
 * Boots the server on port 8080: run it alone.
 */
let passed = 0;
let total = 0;
// the server's own log lines (not this test's PASS / FAIL lines) are collected to prove they carry no note and no file name
const serverLog: string[] = [];
let inAssert = false;
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (!inAssert) serverLog.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    original(...args);
  };
}
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  inAssert = true;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
  inAssert = false;
}

const R3 = 'NIST_800_171_R3';
const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
const withRole = (sub: string, tenant: string, role: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string, raw?: string) {
  const headers: Record<string, string> = { 'Content-Type': raw !== undefined ? 'application/octet-stream' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// the narratives and the file name that must never reach a log, an event, a run row or a preview
const N1 = 'SECRET-NARR-ALPHA unique implementation text for access control';
const N2 = 'SECRET-NARR-BRAVO second control text';
const N3 = 'SECRET-NARR-CHARLIE third control text';
const N13 = 'SECRET-NARR-LIMA text of the withdrawn wireless access requirement';
const N14 = 'SECRET-NARR-NOVEMBER text of the first requirement merged into 03.01.12';
const N15 = 'SECRET-NARR-OSCAR text of the second requirement merged into 03.01.12';
const N56 = 'SECRET-NARR-WITHDRAWN text of a requirement without a successor';
const OBJ = 'SECRET-NARR-OBJECTIVE text of an assessment objective';
const FILE_NAME = 'alpha-evidence-SECRETFILE.txt';
const FILE_BYTES = 'alpha bytes of the evidence file';
const EXISTING = 'Existing Rev. 3 note written by a person';

const AC1 = 'AC.L1-3.1.1';
/** The id the screens (and the copied headers) show for a Level 2 program: the stored 'AC.L1-3.1.1' reads 'AC.L2-3.1.1'. */
const AC1_SHOWN = AC1.replace('.L1-', '.L2-');
const AC2 = 'AC.L1-3.1.2';
const AC3 = 'AC.L2-3.1.3';
const AC13 = 'AC.L2-3.1.13';
const AC14 = 'AC.L2-3.1.14';
const AC15 = 'AC.L2-3.1.15';
const IA56 = 'IA.L2-3.5.6';
const SI1 = 'SI.L1-3.14.1';

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_fc_admin@test.mil';
  const owner = person('u_fc_admin');

  console.log('--- Setup: a tenant with CMMC L2, CMMC L1, SOC 2 and Rev. 3, and programs ---');
  const mkTenant = async (name: string, enabledFrameworks: string[]) => (await call('POST', '/tenants', owner, undefined, { name, primaryFramework: 'CMMC_L2', enabledFrameworks })).body?.tenant?.id as string;
  const T = await mkTenant('Copy Org', ['CMMC_L1', 'CMMC_L2', 'SOC_2_TYPE_II', R3]);
  const T2 = await mkTenant('Copy Other Org', ['CMMC_L2', R3]);
  const T3 = await mkTenant('Copy Disabled Org', ['CMMC_L1', 'CMMC_L2', R3]);
  const mkProgram = async (tenant: string, name: string, frameworkId: string) => (await call('POST', `/tenants/${tenant}/programs`, owner, tenant, { name, frameworkId })).body?.program?.id as string;
  const SRC = await mkProgram(T, 'Source L2', 'CMMC_L2');
  const L1 = await mkProgram(T, 'Source L1', 'CMMC_L1');
  const ARCH = await mkProgram(T, 'Source Archived', 'CMMC_L2');
  const SOC = await mkProgram(T, 'Source SOC2', 'SOC_2_TYPE_II');
  const R3A = await mkProgram(T, 'Rev 3 Target', R3);
  const R3B = await mkProgram(T, 'Rev 3 Other', R3);
  const R3C = await mkProgram(T, 'Rev 3 Big', R3);
  const R3D = await mkProgram(T, 'Rev 3 Parallel', R3);
  const R3E = await mkProgram(T, 'Rev 3 Level One', R3);
  const R3X = await mkProgram(T, 'Rev 3 Archived', R3);
  const OTHER = await mkProgram(T2, 'Foreign L2', 'CMMC_L2');
  const OTHER_R3 = await mkProgram(T2, 'Foreign R3', R3);
  const DIS_L1 = await mkProgram(T3, 'Disabled L1', 'CMMC_L1');
  const DIS_R3 = await mkProgram(T3, 'Disabled R3', R3);
  assert([T, T2, T3, SRC, L1, ARCH, SOC, R3A, R3B, R3C, R3D, R3E, R3X, OTHER, OTHER_R3, DIS_L1, DIS_R3].every(Boolean), 'setup: tenants and programs created');
  await archiveProgram(T, ARCH);
  await archiveProgram(T, R3X);
  await updateTenantSettings(T3, { primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2', R3] });
  const viewer = withRole('u_fc_viewer', T, 'VIEWER');
  const assessor = withRole('u_fc_assessor', T, 'ASSESSOR');
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_fc_viewer', email: 'u_fc_viewer@test.mil', role: 'VIEWER' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_fc_assessor', email: 'u_fc_assessor@test.mil', role: 'ASSESSOR' });

  const scopeOf = (program: string) => ({ tenantId: T, programId: program });
  const putControl = (program: string, id: string, body: Json) => call('PUT', `/controls/${id}`, owner, T, body, program);
  const getControls = async (program: string): Promise<Record<string, Json>> => {
    const res = await call('GET', '/controls', owner, T, undefined, program);
    return Object.fromEntries(((res.body?.controls ?? []) as Json[]).map((c) => [c.id, c]));
  };
  const uploadEvidence = async (program: string, controlId: string, fileName: string, bytes: string | null) => {
    const up = await call('POST', '/evidence/upload-url', owner, T, { controlId, fileName, fileSize: bytes?.length ?? 0, mimeType: 'text/plain', fileHash: sha256(bytes ?? fileName) }, program);
    const id = up.body?.evidenceId as string;
    if (bytes !== null) await call('PUT', `/evidence/upload-local/${id}`, owner, T, undefined, program, bytes);
    return id;
  };

  console.log('\n--- Setup: the Rev. 2 content ---');
  // the Rev. 2 answers are written straight to the store: PUT /controls refuses MET while the objectives of a CMMC control are open
  const setSource = (program: string, id: string, status: string | null, notes: string) => writeControlAssessment(scopeOf(program), id, () => ({ status, notes, role: null, updatedBy: 'test' }), { source: 'human', actor: 'test', userId: null });
  await setSource(SRC, AC1, 'MET', N1);
  await setSource(SRC, AC2, 'MET', N2);
  await setSource(SRC, AC3, null, N3);
  await setSource(SRC, AC13, 'NOT_MET', N13);
  await setSource(SRC, AC14, 'IN_PROGRESS', N14);
  await setSource(SRC, AC15, 'MET', N15);
  await setSource(SRC, IA56, 'MET', N56);
  assert(Object.keys(await getControls(SRC)).length > 0 && (await getControls(SRC))[AC1]?.status === 'MET' && (await getControls(SRC))[AC3]?.status === 'NOT_STARTED', 'the Rev. 2 program holds MET, NOT_MET, IN_PROGRESS and NOT_STARTED answers with notes');
  const vmBlock = `${VM_NOTES_BEGIN}\nvulnerability snapshot text that is never copied\n${VM_NOTES_END}`;
  await setSource(SRC, SI1, null, vmBlock);
  assert((await call('PUT', `/objectives/${encodeURIComponent(`${AC1}[a]`)}`, owner, T, { controlId: AC1, narrative: OBJ, status: 'IN_PROGRESS' }, SRC)).status === 200, 'an objective narrative under AC.L1-3.1.1');
  const E1 = await uploadEvidence(SRC, AC1, FILE_NAME, FILE_BYTES);
  const E2 = await uploadEvidence(SRC, AC2, 'never-uploaded.txt', null); // a record whose bytes are not on disk
  const VMROW = 'ev_vmsnap_9999999999999_fc001';
  await queryWithProgram(scopeOf(SRC), 'INSERT INTO evidence_metadata (id, tenant_id, control_id, file_name, file_size, mime_type, gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12) RETURNING *', [VMROW, T, AC2, 'snapshot.json', 5, 'application/json', path.join(EVIDENCE_TEST_VAULT, 'tenants', T, 'vm', 'none.json'), sha256('x'), 'local_storage', 'vm desc', VM_SNAPSHOT_ACTOR, SRC]);
  const evidenceSrc = (await call('GET', '/evidence', owner, T, undefined, SRC)).body?.evidence as Json[];
  const e1src = evidenceSrc.find((e) => e.id === E1) as Json;
  assert(Boolean(E1) && Boolean(E2) && Boolean(e1src) && evidenceSrc.some((e) => e.syncStatus === 'inherited'), 'evidence: one file, one record without bytes, one vulnerability snapshot row, and inherited copies exist in the source');
  const mkTool = async (name: string) => (await call('POST', `/tenants/${T}/inventory/tools`, owner, T, { name })).body?.tool?.id as string;
  const T1 = await mkTool('Copy Tool One');
  const T3x = await mkTool('Copy Tool Three');
  await call('PUT', `/program-inventory/tools/${T1}/controls`, owner, T, { controls: [{ controlId: AC1, evidenceSource: true }], expectedControlIds: [] }, SRC);
  await call('PUT', `/program-inventory/tools/${T3x}/controls`, owner, T, { controls: [{ controlId: AC2, evidenceSource: false }], expectedControlIds: [] }, SRC);
  const D1 = (await call('POST', `/tenants/${T}/documents`, owner, T, { kind: 'POLICY', title: 'Copy Access Policy' })).body?.document?.id as string;
  await call('PUT', `/program-documents/documents/${D1}/controls`, owner, T, { controlIds: [AC1], expectedControlIds: [] }, SRC);
  const srcInv = (await call('GET', '/program-inventory', owner, T, undefined, SRC)).body as Json;
  const srcDocs = (await call('GET', '/program-documents', owner, T, undefined, SRC)).body as Json;
  assert(Boolean(T1) && Boolean(T3x) && Boolean(D1) && srcInv?.controlLinks?.length === 2 && srcDocs?.controlLinks?.length === 1, 'two tools linked to controls and one document linked to a control in the source');
  // the target: an existing note, a tool boundary that holds tool one only, and tool one already linked to another control
  await putControl(R3A, '03.01.01', { implementationNotes: EXISTING });
  assert((await call('PATCH', '/program-inventory/tools', owner, T, { add: [T1] }, R3A)).status === 200, 'the target declares a boundary with tool one only');
  assert((await call('PUT', `/program-inventory/tools/${T1}/controls`, owner, T, { controls: [{ controlId: '03.02.01', evidenceSource: false }], expectedControlIds: [] }, R3A)).status === 200, 'tool one is already linked to 03.02.01 in the target');

  const noMarkers = () => __frameworkCopyRowsForTests(scopeOf(R3A));
  const preview = (program: string, body: Json, token: string | null = owner) => call('POST', '/framework-copy/preview', token, T, body, program);
  const commit = (program: string, body: Json, token: string | null = owner) => call('POST', '/framework-copy/commit', token, T, body, program);

  console.log('\n--- Before any copy ---');
  const sug0 = await call('GET', '/framework-copy/suggestions', owner, T, undefined, R3A);
  const runs0 = await call('GET', '/framework-copy/runs', owner, T, undefined, R3A);
  assert(sug0.status === 200 && sug0.body?.applies === false && sug0.body?.sourceProgramId === null && JSON.stringify(sug0.body?.suggestions) === '[]', 'suggestions: applies false before any run', sug0.body);
  assert(runs0.status === 200 && JSON.stringify(runs0.body?.runs) === '[]', 'runs: an empty list');

  console.log('\n--- Preview: the same counts as the pure planner, nothing written ---');
  const pv = await preview(R3A, { sourceProgramId: SRC });
  const expected = planFrameworkCopy({
    mapping: r2r3Mapping(),
    newInR3: newInR3(),
    targetCatalog: new Set(getFrameworkControls(R3).map((c) => c.id)),
    source: {
      controls: new Map([AC1, AC2, AC3, AC13, AC14, AC15, IA56].map((id, i) => [id, { notes: [N1, N2, N3, N13, N14, N15, N56][i], status: 'MET', updatedAt: null }] as const).concat([[SI1, { notes: vmBlock, status: 'NOT_STARTED', updatedAt: null }] as const])),
      objectives: [{ objectiveId: `${AC1}[a]`, controlId: AC1, narrative: OBJ }],
      evidence: [
        { id: E1, controlId: AC1, sizeBytes: FILE_BYTES.length, copyable: true },
        { id: E2, controlId: AC2, sizeBytes: 0, copyable: true, available: false },
        { id: VMROW, controlId: AC2, sizeBytes: 5, copyable: false },
      ],
      toolLinks: [{ toolId: T1, controlId: AC1 }, { toolId: T3x, controlId: AC2 }],
      documentLinks: [{ documentId: D1, controlId: AC1 }],
    },
    markers: new Set<string>(),
    stripNotes: stripDelimitedBlocks,
  });
  const pvTotals = pv.body?.totals as Json;
  assert(pv.status === 200 && JSON.stringify(pvTotals) === JSON.stringify(expected.totals), 'POST /preview: the totals equal the pure planner on the same rows', [pvTotals, expected.totals]);
  assert(pvTotals?.notes === 6 && pvTotals?.objectives === 1 && pvTotals?.evidenceFiles === 1 && pvTotals?.evidenceUnavailable === 1 && pvTotals?.tools === 2 && pvTotals?.documents === 1 && pvTotals?.tooLarge === false, 'six notes (the vulnerability block and the withdrawn control give none), one objective, one file, one unavailable, two tools, one document', pvTotals);
  assert(JSON.stringify(pv.body?.items.map((i: Json) => i.targetControlId)) === JSON.stringify(expected.items.map((i) => i.targetControlId)) && JSON.stringify(pv.body?.notCarried) === JSON.stringify(expected.notCarried) && JSON.stringify(pv.body?.newInR3) === JSON.stringify(expected.newInR3), 'the items, the not-carried list and the new-in-Rev.-3 list equal the planner');
  const digest = pv.body?.planDigest as string;
  const pvAgain = await preview(R3A, { sourceProgramId: SRC });
  assert(/^[0-9a-f]{64}$/.test(digest) && pvAgain.body?.planDigest === digest, 'the plan digest is a SHA-256 hex and is the same for the same rows');
  assert(pv.body?.source?.id === SRC && pv.body?.source?.frameworkId === 'CMMC_L2' && pv.body?.targetProgramId === R3A && /^[0-9a-f]{64}$/.test(pv.body?.mapping?.sha256) && typeof pv.body?.mapping?.provenance === 'string' && pv.body.mapping.provenance.length > 0, 'the preview names the source, the target, the mapping digest and its provenance');
  assert(!pv.text.includes('SECRET') && !pv.text.includes('alpha') && !pv.text.includes('Existing'), 'the preview holds no narrative and no file name');
  const before = await getControls(R3A);
  assert(before['03.01.01']?.implementationNotes === EXISTING && noMarkers().markers === 0 && noMarkers().runs === 0 && (await call('GET', '/framework-copy/runs', owner, T, undefined, R3A)).body?.runs.length === 0, 'the preview wrote nothing: the target note is unchanged, no marker, no run');
  assert(((await call('GET', '/evidence', owner, T, undefined, R3A)).body?.evidence as Json[]).length === 0, 'and no evidence row in the target');

  console.log('\n--- Commit: a wrong digest ---');
  const stale = await commit(R3A, { sourceProgramId: SRC, planDigest: 'f'.repeat(64) });
  assert(stale.status === 409 && stale.body?.code === 'copy_plan_stale' && stale.body?.reason === 'copy_plan_stale' && stale.body?.planDigest === digest, '409 copy_plan_stale with the fresh digest (equal to the previewed one: nothing changed)', stale.body);
  assert(noMarkers().markers === 0 && (await getControls(R3A))['03.01.01']?.implementationNotes === EXISTING, 'nothing was written');

  console.log('\n--- Commit ---');
  const done = await commit(R3A, { sourceProgramId: SRC, planDigest: digest });
  const s = done.body?.summary as Json;
  assert(done.status === 200 && typeof done.body?.runId === 'string' && s?.notesAppended === 6 && s?.objectivesAppended === 1 && s?.evidenceCopied === 1 && s?.evidenceUnavailable === 1 && s?.toolLinksAdded === 1 && s?.toolLinksSkipped === 1 && s?.documentLinksAdded === 1 && s?.alreadyCopied === 0, 'commit -> 200 with the run id and the summary (one tool link added, one skipped outside the boundary)', done.body);
  assert(typeof s?.newInR3 === 'number' && s.newInR3 === expected.newInR3.length && s.notCarried === expected.notCarried.length && s.mergedInto === expected.mergedInto.length && Array.isArray(s.controls) && s.controls.includes('03.01.01') && s.controls.includes('03.01.12') && s.controls.includes('03.13.08'), 'the summary counts the new, not-carried and merged requirements and lists the controls it touched', s);
  const after = await getControls(R3A);
  const note0101 = String(after['03.01.01']?.implementationNotes);
  assert(note0101.startsWith(`${EXISTING}\n\n[Copied from NIST SP 800-171 Rev. 2 ${AC1_SHOWN} (program "Source L2") on `) && note0101.includes(N1) && note0101.includes(`[Rev. 2 objective ${AC1}[a]]\n${OBJ}`) && note0101.includes('; review against Rev. 3]'), 'the target note starts with the old text, then the header, the Rev. 2 note and the objective narrative');
  assert(String(after['03.01.12']?.implementationNotes).includes(N14) && String(after['03.01.12']?.implementationNotes).includes(N15) && String(after['03.13.08']?.implementationNotes).includes(N13) && String(after['03.01.02']?.implementationNotes).includes(N2), 'merged requirements land in the one Rev. 3 control (03.01.12), an ADDRESSED_BY successor gets its text (03.13.08)');
  assert(!Object.values(after).some((c) => String(c.implementationNotes).includes('SECRET-NARR-WITHDRAWN') || String(c.implementationNotes).includes('vm-snapshot') || String(c.implementationNotes).includes('vulnerability snapshot text')), 'the requirement without a successor and the vulnerability block were not copied');
  assert(after['03.01.01']?.status === 'NOT_STARTED' && after['03.01.02']?.status === 'NOT_STARTED' && after['03.13.08']?.status === 'NOT_STARTED', 'no status was written: every target control is still NOT_STARTED');
  const hist = await call('GET', '/controls/03.01.01/history', owner, T, undefined, R3A);
  const ev = (hist.body?.events as Json[])?.[0];
  assert(ev?.source === 'clone' && ev?.notesChanged === true && ev?.oldNotesLength === EXISTING.length && ev?.newNotesLength === note0101.length && ev?.actor === 'u_fc_admin' && !hist.text.includes('SECRET') && !hist.text.includes('Existing'), "the control history has a 'clone' event with notesChanged and the lengths, and no text", ev);

  console.log('\n--- Evidence, tools and documents ---');
  const evT = (await call('GET', '/evidence', owner, T, undefined, R3A)).body?.evidence as Json[];
  const copied = evT.find((e) => e.controlId === '03.01.01') as Json;
  assert(evT.length === 1 && Boolean(copied) && copied.fileHash === e1src.fileHash && copied.fileHash === sha256(FILE_BYTES) && copied.gcsPath !== e1src.gcsPath && copied.id !== E1 && copied.syncStatus === 'local_storage' && String(copied.description).startsWith(`[Copied from Rev. 2 ${AC1_SHOWN}] `), 'the target holds one new evidence row: same hash, a different path, an id of its own (inherited, snapshot and missing-file rows were not copied)', evT);
  assert(fs.existsSync(copied.gcsPath) && fs.readFileSync(copied.gcsPath, 'utf8') === FILE_BYTES && copied.gcsPath.startsWith(path.join(EVIDENCE_TEST_VAULT, 'tenants', T, 'controls', '03.01.01')), 'its bytes are a physical copy under the tenant vault, in the layout of an upload');
  const del = await call('DELETE', `/evidence/${E1}`, owner, T, undefined, SRC);
  const dl = await call('GET', `/evidence/${copied.id}/file`, owner, T, undefined, R3A);
  assert(del.status === 200 && dl.status === 200 && dl.text === FILE_BYTES, 'deleting the source evidence leaves the target file downloadable');
  const tgtInv = (await call('GET', '/program-inventory', owner, T, undefined, R3A)).body as Json;
  const links = (tgtInv.controlLinks as Json[]).map((l) => `${l.toolId}|${l.controlId}`).sort();
  assert(JSON.stringify(links) === JSON.stringify([`${T1}|03.01.01`, `${T1}|03.02.01`].sort()), 'tool one keeps its link to 03.02.01 and gains 03.01.01 (the union); tool three, outside the boundary, was skipped', links);
  const tgtDocs = (await call('GET', '/program-documents', owner, T, undefined, R3A)).body as Json;
  assert(tgtDocs.controlLinks.length === 1 && tgtDocs.controlLinks[0].documentId === D1 && tgtDocs.controlLinks[0].controlId === '03.01.01', 'the document is linked to 03.01.01 through the document register');
  const invEvents = (await call('GET', '/program-inventory/events', owner, T, undefined, R3A)).body as Json;
  assert(JSON.stringify(invEvents).includes('controls_changed') && JSON.stringify(invEvents).includes('document_controls_changed'), 'the tool and document stores recorded their own history events');

  console.log('\n--- The run and the suggestions ---');
  const runs1 = await call('GET', '/framework-copy/runs', owner, T, undefined, R3A);
  const run1 = runs1.body?.runs?.[0] as Json;
  assert(runs1.body?.runs?.length === 1 && run1.id === done.body?.runId && run1.sourceProgramId === SRC && run1.sourceFramework === 'CMMC_L2' && run1.actor === 'u_fc_admin' && run1.summary?.notesAppended === 6 && typeof run1.createdAt === 'string', 'GET /runs lists the run with its source, actor and counts', run1);
  assert(!runs1.text.includes('SECRET') && !runs1.text.includes('alpha'), 'the run holds counts and ids only');
  const sug1 = await call('GET', '/framework-copy/suggestions', owner, T, undefined, R3A);
  const list = (sug1.body?.suggestions ?? []) as Json[];
  const by = (id: string) => list.find((x) => x.controlId === id) as Json;
  assert(sug1.status === 200 && sug1.body?.applies === true && sug1.body?.sourceProgramId === SRC && list.length > 0, 'suggestions: applies, with the source program of the latest run', sug1.body);
  assert(list.every((x) => { const r = suggestR3Status(x.sources); return (r?.suggested ?? null) === x.suggested && (r?.reasonCode ?? null) === x.reasonCode; }), 'every suggestion equals suggestR3Status on its sources');
  assert(by('03.01.02')?.suggested === 'MET' && by('03.01.02')?.reasonCode === 'all_met_unchanged' && by('03.01.01')?.suggested === 'IN_PROGRESS' && by('03.01.01')?.reasonCode === 'partial' && by('03.13.08')?.suggested === 'NOT_MET' && by('03.13.08')?.reasonCode === 'any_not_met', 'MET stays MET only for an unchanged requirement; a source that is only in progress gives IN_PROGRESS; a NOT_MET source gives NOT_MET');
  assert(by('03.01.03') !== undefined && by('03.01.03').suggested === null && by('03.01.03').reasonCode === null && Array.isArray(by('03.01.03').sources) && by('03.01.03').sources[0].status === 'NOT_STARTED', 'an entry whose sources give no suggestion has suggested null', by('03.01.03'));
  assert((await getControls(R3A))['03.01.02']?.status === 'NOT_STARTED', 'and the target status is still NOT_STARTED');
  const viewerRuns = await call('GET', '/framework-copy/runs', viewer, T, undefined, R3A);
  const viewerSug = await call('GET', '/framework-copy/suggestions', viewer, T, undefined, R3A);
  assert(viewerRuns.status === 200 && viewerSug.status === 200 && viewerSug.body?.applies === true, 'a VIEWER can read the runs and the suggestions');
  const sugOther = await call('GET', '/framework-copy/suggestions', owner, T, undefined, R3B);
  assert(sugOther.status === 200 && sugOther.body?.applies === false, 'a Rev. 3 program with no run: applies false');
  const sugNotR3 = await call('GET', '/framework-copy/suggestions', owner, T, undefined, SRC);
  assert(sugNotR3.status === 200 && sugNotR3.body?.applies === false, 'a program that is not Rev. 3: applies false');

  console.log('\n--- Idempotency ---');
  const pv2 = await preview(R3A, { sourceProgramId: SRC });
  const onlySkipped = (b: Json | null) => (b?.items as Json[]).every((i) => (i.ops as Json[]).every((o) => o.kind === 'TOOL' && o.sourceKey === T3x));
  assert(pv2.status === 200 && onlySkipped(pv2.body) && pv2.body?.totals?.alreadyCopied >= 9 && pv2.body?.totals?.notes === 0 && pv2.body?.totals?.objectives === 0 && pv2.body?.totals?.evidenceFiles === 0 && pv2.body?.totals?.documents === 0, 'a second preview counts what is already copied and offers only the tool link that was skipped (it has no marker, so it can be retried once the boundary allows it)', pv2.body?.totals);
  const done2 = await commit(R3A, { sourceProgramId: SRC, planDigest: pv2.body?.planDigest });
  const after2 = await getControls(R3A);
  assert(done2.status === 200 && done2.body?.summary?.notesAppended === 0 && done2.body?.summary?.evidenceCopied === 0 && done2.body?.summary?.documentLinksAdded === 0 && after2['03.01.01']?.implementationNotes === note0101 && after2['03.01.12']?.implementationNotes === after['03.01.12']?.implementationNotes, 'a second commit changes nothing: notes byte-identical', done2.body);
  assert(((await call('GET', '/evidence', owner, T, undefined, R3A)).body?.evidence as Json[]).length === 1 && ((await call('GET', '/program-documents', owner, T, undefined, R3A)).body as Json).controlLinks.length === 1 && countOf(String(after2['03.01.01']?.implementationNotes), '[Copied from NIST SP 800-171 Rev. 2') === 1, 'one evidence row, one document link and one header after the second commit (documents are linked once)');
  await setSource(SRC, AC1, null, `${N1} and a later edit`);
  const pv3 = await preview(R3A, { sourceProgramId: SRC });
  assert(pv3.status === 200 && onlySkipped(pv3.body) && pv3.body?.totals?.notes === 0 && pv3.body?.totals?.changedSinceCopy >= 1, 'a source whose text changed after it was copied is listed as changed since copy and is not copied again', pv3.body?.totals);
  const done3 = await commit(R3A, { sourceProgramId: SRC, planDigest: pv3.body?.planDigest });
  assert(done3.status === 200 && (await getControls(R3A))['03.01.01']?.implementationNotes === note0101, 'and committing again leaves the note as it was');
  assert((await call('GET', '/framework-copy/runs', owner, T, undefined, R3A)).body?.runs.length === 3, 'each commit is one run row');

  console.log('\n--- A change between preview and commit ---');
  await setSource(SRC, AC3, null, `${N3} edited after the preview`);
  const staleAgain = await commit(R3A, { sourceProgramId: SRC, planDigest: digest });
  assert(staleAgain.status === 409 && staleAgain.body?.code === 'copy_plan_stale' && /^[0-9a-f]{64}$/.test(staleAgain.body?.planDigest), 'a digest of an older plan is 409 copy_plan_stale with the fresh digest', staleAgain.body);

  console.log('\n--- Two commits at once ---');
  const pvD = await preview(R3D, { sourceProgramId: SRC, include: { evidence: false, tools: false, documents: false } });
  const both = await Promise.all([commit(R3D, { sourceProgramId: SRC, include: { evidence: false, tools: false, documents: false }, planDigest: pvD.body?.planDigest }), commit(R3D, { sourceProgramId: SRC, include: { evidence: false, tools: false, documents: false }, planDigest: pvD.body?.planDigest })]);
  const statuses = both.map((r) => r.status).sort();
  const loser = both.find((r) => r.status !== 200);
  const parallel = await getControls(R3D);
  assert(statuses[0] === 200 && statuses[1] === 409 && (loser?.body?.code === 'copy_in_progress' || loser?.body?.code === 'copy_plan_stale') && loser?.body?.reason === loser?.body?.code, 'two commits at once: one wins, the other is 409', both.map((r) => [r.status, r.body?.code]));
  assert(countOf(String(parallel['03.01.02']?.implementationNotes), '[Copied from NIST SP 800-171 Rev. 2') === 1 && countOf(String(parallel['03.01.02']?.implementationNotes), N2) === 1 && __frameworkCopyRowsForTests(scopeOf(R3D)).runs === 1, 'each pair was appended once and one run was recorded');

  console.log('\n--- Sources and targets ---');
  const body = (extra: Json = {}) => ({ sourceProgramId: SRC, ...extra });
  const codeAndReason = (r: { body: Json | null }) => typeof r.body?.code === 'string' && r.body.code === r.body.reason;
  const foreign = await preview(R3B, { sourceProgramId: OTHER });
  assert(foreign.status === 404 && foreign.body?.code === 'program_not_found' && codeAndReason(foreign), "a source program of another organization -> 404 program_not_found", foreign.body);
  const unknown = await preview(R3B, { sourceProgramId: 'no-such-program' });
  assert(unknown.status === 404 && unknown.body?.code === 'program_not_found', 'an unknown source program -> 404');
  const soc = await preview(R3B, { sourceProgramId: SOC });
  assert(soc.status === 400 && soc.body?.code === 'invalid_copy_source' && codeAndReason(soc), 'a SOC 2 source -> 400 invalid_copy_source', soc.body);
  const r3Source = await preview(R3B, { sourceProgramId: R3A });
  assert(r3Source.status === 400 && r3Source.body?.code === 'invalid_copy_source' && codeAndReason(r3Source), 'a Rev. 3 source -> 400 invalid_copy_source', r3Source.body);
  const same = await preview(R3B, { sourceProgramId: R3B });
  assert(same.status === 400 && same.body?.code === 'invalid_copy_source', 'the same program as source and target -> 400 invalid_copy_source');
  const badId = await preview(R3B, { sourceProgramId: 'bad id!' });
  const noId = await preview(R3B, {});
  assert(badId.status === 400 && badId.body?.code === 'invalid_copy_source' && noId.status === 400 && noId.body?.code === 'invalid_copy_source', 'a malformed or missing sourceProgramId -> 400 invalid_copy_source');
  const notR3 = await preview(SRC, { sourceProgramId: L1 });
  assert(notR3.status === 400 && notR3.body?.code === 'invalid_copy_target' && codeAndReason(notR3), 'a target that is not Rev. 3 -> 400 invalid_copy_target', notR3.body);
  const archivedTarget = await preview(R3X, body());
  assert(archivedTarget.status === 409 && archivedTarget.body?.code === 'program_archived', 'an archived target -> 409 program_archived', archivedTarget.body);
  const archivedSource = await preview(R3B, { sourceProgramId: ARCH });
  assert(archivedSource.status === 200 && archivedSource.body?.source?.id === ARCH, 'an archived source program is accepted', archivedSource.body);
  const disabled = await call('POST', '/framework-copy/preview', owner, T3, { sourceProgramId: DIS_L1 }, DIS_R3);
  assert(disabled.status === 403 && disabled.body?.code === 'framework_not_enabled' && codeAndReason(disabled), 'a source whose framework the organization no longer has enabled -> 403 framework_not_enabled', disabled.body);
  const badInclude = await preview(R3B, body({ include: { notes: 'yes' } }));
  const unknownKey = await preview(R3B, body({ include: { everything: true } }));
  const noDigest = await commit(R3B, body());
  assert(badInclude.status === 400 && badInclude.body?.code === 'invalid_request' && codeAndReason(badInclude) && unknownKey.status === 400 && noDigest.status === 400 && noDigest.body?.code === 'invalid_request', 'an include that is not an object of booleans, and a commit without a digest -> 400 invalid_request');
  for (const [name, token] of [['VIEWER', viewer], ['ASSESSOR', assessor]] as const) {
    const p = await preview(R3B, body(), token);
    const c = await commit(R3B, body({ planDigest: digest }), token);
    assert(p.status === 403 && c.status === 403, `${name}: preview and commit -> 403`, [p.status, c.status]);
  }
  assert((await preview(R3B, body(), null)).status === 401, 'without a token -> 401');
  const foreignTenant = await call('POST', '/framework-copy/preview', owner, T2, { sourceProgramId: OTHER }, OTHER_R3);
  assert(foreignTenant.status === 200 && foreignTenant.body?.source?.id === OTHER, "the same call inside its own organization works (the 404 above is the other tenant's program)");
  assert(__frameworkCopyRowsForTests(scopeOf(R3B)).markers === 0 && __frameworkCopyRowsForTests(scopeOf(R3B)).runs === 0, 'none of the refused calls wrote a marker or a run');

  console.log('\n--- A CMMC Level 1 source ---');
  await setSource(L1, AC1, 'MET', 'Level one note LONE');
  const pvL1 = await preview(R3E, { sourceProgramId: L1 });
  assert(pvL1.status === 200 && pvL1.body?.items.some((i: Json) => i.targetControlId === '03.01.01'), 'a CMMC_L1 program is a valid source');
  const doneL1 = await commit(R3E, { sourceProgramId: L1, planDigest: pvL1.body?.planDigest });
  assert(doneL1.status === 200 && String((await getControls(R3E))['03.01.01']?.implementationNotes).includes('LONE'), 'and its note is appended');

  console.log('\n--- Too much evidence in one commit ---');
  const BIG = await mkProgram(T, 'Source Big', 'CMMC_L2');
  const rows = Array.from({ length: 201 }, (_, i) => i);
  for (let at = 0; at < rows.length; at += 25) {
    await Promise.all(rows.slice(at, at + 25).map((i) => call('POST', '/evidence/upload-url', owner, T, { controlId: AC1, fileName: `bulk-${i}.txt`, fileSize: 1, mimeType: 'text/plain', fileHash: sha256(`bulk-${i}`) }, BIG)));
  }
  const vaultFiles = () => (fs.existsSync(path.join(EVIDENCE_TEST_VAULT, 'tenants', T, 'controls')) ? fs.readdirSync(path.join(EVIDENCE_TEST_VAULT, 'tenants', T, 'controls'), { recursive: true }).length : 0);
  const filesBefore = vaultFiles();
  const pvBig = await preview(R3C, { sourceProgramId: BIG });
  assert(pvBig.status === 200 && pvBig.body?.totals?.tooLarge === true && pvBig.body?.totals?.evidenceFiles === 201, 'preview still works and reports totals.tooLarge for more than 200 files', pvBig.body?.totals);
  const bigCommit = await commit(R3C, { sourceProgramId: BIG, planDigest: pvBig.body?.planDigest });
  assert(bigCommit.status === 413 && bigCommit.body?.code === 'copy_too_large' && bigCommit.body?.reason === 'copy_too_large', '413 copy_too_large', bigCommit.body);
  assert(__frameworkCopyRowsForTests(scopeOf(R3C)).markers === 0 && ((await call('GET', '/evidence', owner, T, undefined, R3C)).body?.evidence as Json[]).length === 0 && vaultFiles() === filesBefore, 'nothing was written: no marker, no evidence row, no file');
  const evidenceOnly = await preview(R3C, { sourceProgramId: BIG, include: { evidence: false } });
  assert(evidenceOnly.status === 200 && evidenceOnly.body?.totals?.tooLarge === false && evidenceOnly.body?.totals?.evidenceFiles === 0, 'without the evidence the same source is not too large');

  console.log('\n--- What the server logged ---');
  const logged = serverLog.join('\n');
  assert(!logged.includes('SECRET') && !logged.includes('alpha-evidence') && !logged.includes('Existing Rev. 3') && !logged.includes(FILE_NAME) && !logged.includes('LONE') && !logged.includes('never-uploaded'), 'the server log holds no note, narrative or file name');
  assert(serverLog.some((l) => l.includes('[Framework Copy API]') && l.includes(String(done.body?.runId))), 'the commit was logged with its run id');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
