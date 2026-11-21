import './testEnv';
import './evidenceEnv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { __programDocumentRowsForTests } from '../server/documents/programDocumentsStore';
import { __setDocumentLimitForTests } from '../server/documents/registerStore';
import { EXPECTED_CATALOG } from '../server/documents/expectedCatalog';
import { applicableExpected } from '../src/data/documents/expectedDocuments';
import { classifyLocation, safeLinkHref, validateApproval, validateDocumentInput } from '../src/data/documents/documentSchema';

/**
 * The document register (issues #240, #250) over HTTP: tenant documents (create, update with a stamp, approve with the approver taken from the session,
 * status, delete, usage), the location rule, generated drafts, the limit, tenant isolation, and a program's side (declared set, control links validated
 * against the program's catalog, attachments of the program's own evidence with one primary, expected-document links, the cascades of a document delete
 * and a program delete, roles, an archived program). Also that no title, owner, location or file name reaches the history or the logs. Runs against the
 * in-memory store; the SQL is checked structurally in tests/dbSchema.test.ts and, against a live database, by `npm run db:verify-rls`. Boots the server
 * on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';

let passed = 0;
let total = 0;
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    origLog(`  ✓ PASS: ${name}`);
  } else {
    origError(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

// every line the server writes while the tests run (the test's own output goes through origLog)
const captured: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  console[level] = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
const withRole = (sub: string, tenant: string, role: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

function pureTests() {
  origLog('--- Source and validation ---');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  const statements = (src: string): string[] =>
    [...src.matchAll(/(["'`])(\s*(?:SELECT|UPDATE|DELETE)\b(?:(?!\1)[\s\S])*)\1/g)].map((m) => m[2]).filter((s) => !s.includes('set_config'));
  const stmts = ['registerStore.ts', 'programDocumentsStore.ts'].flatMap((f) => statements(read('server', 'documents', f)));
  assert(stmts.length >= 25 && stmts.every((s) => /tenant_id\s*=\s*\$/.test(s)), 'DR-S1 every SELECT / UPDATE / DELETE in server/documents/*.ts filters by tenant_id', stmts.filter((s) => !/tenant_id\s*=\s*\$/.test(s)));
  const lines = ['documents.ts', 'programDocuments.ts'].flatMap((f) => read('server', 'routes', f).split('\n').filter((l) => /console\.\w+\(/.test(l)));
  assert(lines.length > 0 && !lines.some((l) => /title|owner|location|notes|version/.test(l)), 'DR-S2 no console line of routes/documents.ts or routes/programDocuments.ts mentions a title, owner, location, notes or version', lines);
  const programs = read('server', 'programs.ts');
  assert(programs.includes('__deleteProgramDocumentsForMemory({ tenantId, programId: id })'), 'DR-S3 programs.ts clears the memory rows of a deleted program');
  const api = read('server', 'routes', 'api.ts');
  assert(/router\.use\('\/program-documents', authMiddleware, programContext, programDocumentsRouter\)/.test(api) && read('server', 'routes', 'tenants.ts').includes("router.use('/:tenantId/documents', tenantDocumentsRouter)"), 'DR-S4 both routers are mounted (the program side behind authMiddleware and programContext, the tenant side after requireWriteRole)');

  const loc = (v: unknown) => classifyLocation(v);
  assert(loc('https://intranet.example/a b').ok && (loc('https://intranet.example/x') as Json).kind === 'http' && (loc('\\\\fs01\\Compliance\\AC Policy.docx') as Json).kind === 'unc' && (loc('file://fs01/Compliance/AC.docx') as Json).kind === 'file' && (loc('S:\\Policies\\AC.docx') as Json).kind === 'drive', 'DR-V1 http, UNC, file and mapped-drive locations are classified');
  assert((loc('javascript:alert(1)') as Json).reason === 'scheme' && (loc('data:text/html,x') as Json).reason === 'scheme' && (loc('mailto:a@b.c') as Json).reason === 'scheme' && (loc('docs/ac.docx') as Json).reason === 'scheme' && (loc('https://u:p@intranet/x') as Json).reason === 'credentials' && (loc('') as Json).reason === 'empty' && (loc('a'.repeat(2049)) as Json).reason === 'too_long' && (loc('https://x/\u0001') as Json).reason === 'control_chars', 'DR-V2 other schemes, relative paths, credentials, an empty value, 2049 characters and control characters are refused');
  assert(safeLinkHref('https://intranet.example/a b') === 'https://intranet.example/a%20b' && safeLinkHref('\\\\fs01\\x\\y') === null && safeLinkHref('file://x/y') === null && safeLinkHref('javascript:alert(1)') === null && safeLinkHref(null) === null, 'DR-V3 only an http / https URL becomes a link');
  assert(validateDocumentInput({ kind: 'POLICY', title: 'T' }, false).ok && !validateDocumentInput({ kind: 'POLICY', title: 'T', status: 'APPROVED' }, false).ok && !validateDocumentInput({ kind: 'POLICY', title: 'T', approvedBy: 'x' }, false).ok && !validateDocumentInput({ title: 'T' }, false).ok && validateDocumentInput({ owner: 'x', expectedUpdatedAt: 'y' }, true).ok && !validateDocumentInput({ origin: 'GENERATED' }, true).ok, 'DR-V4 create needs kind and title; status and approver are never writable; update takes the stamp but not origin');
  const appr = (b: Json) => validateApproval(b, '2026-11-19');
  assert(appr({ version: '1.0', approvalDate: '2026-11-20' }).ok && !appr({ version: '1.0', approvalDate: '2026-11-21' }).ok && !appr({ version: ' ', approvalDate: '2026-11-19' }).ok && !appr({ version: '1', approvalDate: '2026-11-19', reviewBy: '2026-11-18' }).ok && !appr({ version: '1', approvalDate: '2026-02-30' }).ok && !appr({ version: '1', approvalDate: '2026-11-19', approvedBy: 'Mallory' }).ok, 'DR-V5 approval: a version, a real date not after the server day + 1, a review date not before it, no approver');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_dr_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const owner = person('u_dr_owner');
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Document Register Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const viewer = withRole('u_dr_viewer', T, 'VIEWER');
  const assessor = withRole('u_dr_assessor', T, 'ASSESSOR');
  const rival = person('u_dr_rival');
  const U = (await call('POST', '/tenants', rival, undefined, { name: 'Document Register Rival Org' })).body?.tenant?.id as string;
  const mkProgram = async (name: string, frameworkId: string, baseline?: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId, ...(baseline ? { baseline } : {}) })).body?.program?.id as string;
  const P1 = await mkProgram('DR Program 1', 'CMMC_L2');
  const P2 = await mkProgram('DR Program 2', 'NIST_800_53_REV5', 'LOW');
  assert(Boolean(T) && Boolean(U) && Boolean(P1) && Boolean(P2), 'setup: tenant T with P1 (CMMC_L2) and P2 (NIST 800-53 LOW), and tenant U', [T, U, P1, P2]);

  const docs = (method: string, sub: string, body?: unknown, token: string | null = owner, tenant: string = T) => call(method, `/tenants/${tenant}/documents${sub}`, token, tenant, body);
  const pd = (program: string, token: string | null = owner, tenant: string = T) => (method: string, sub: string, body?: unknown) => call(method, `/program-documents${sub}`, token, tenant, body, program);
  const pd1 = pd(P1);
  const pd2 = pd(P2);
  const today = new Date().toISOString().slice(0, 10);
  const ids = (list: Json[], key: string) => list.map((x) => x[key]).sort();

  origLog('\n--- Tenant documents ---');
  const dr1 = await docs('POST', '', { kind: 'POLICY', title: 'Access Control Policy MARK', owner: 'Jane MARK', reviewBy: '2027-01-31' });
  const A = dr1.body?.document as Json;
  assert(dr1.status === 201 && A?.status === 'DRAFT' && A?.origin === 'MANUAL' && A?.approvedBy === null && A?.approvalDate === null && A?.reviewBy === '2027-01-31' && A?.version === '', 'DR1 POST -> 201, always a DRAFT with a MANUAL origin', dr1.body);
  const dr2 = await docs('POST', '', { kind: 'POLICY', title: 'access control policy mark' });
  assert(dr2.status === 409 && dr2.body?.code === 'duplicate_title' && !dr2.text.includes('MARK'), 'DR2 the same title ignoring case -> 409 duplicate_title, not echoed', dr2.body);
  const dr3a = await docs('POST', '', { kind: 'policy', title: 'Bad Kind MARK' });
  const dr3b = await docs('POST', '', { kind: 'POLICY', title: 'Status MARK', status: 'APPROVED' });
  const dr3c = await docs('POST', '', { kind: 'POLICY', title: 'Approver MARK', approvedBy: 'Mallory' });
  assert(dr3a.status === 400 && dr3a.body?.code === 'invalid' && dr3a.body?.field === 'kind' && dr3b.status === 400 && dr3b.body?.field === 'status' && dr3c.status === 400 && dr3c.body?.field === 'approvedBy' && ![dr3a, dr3b, dr3c].some((r) => r.text.includes('MARK')), 'DR3 a lower-case kind, a status and an approver in the body -> 400 naming the field, nothing echoed', [dr3a.body, dr3b.body, dr3c.body]);
  assert((await docs('POST', '', { kind: 'POLICY' })).status === 400 && (await docs('POST', '', { title: 'No Kind MARK' })).status === 400 && (await docs('POST', '', { kind: 'POLICY', title: 'Long MARK', notes: 'x'.repeat(4001) })).status === 400 && (await docs('POST', '', { kind: 'POLICY', title: 'Date MARK', reviewBy: '2026-02-30' })).status === 400, 'a missing kind or title, notes over 4000 characters and an impossible review date -> 400');

  const loc = async (n: number, locationUrl: string) => docs('POST', '', { kind: 'REFERENCE', title: `Location ${n} MARK`, locationUrl });
  const l1 = await loc(1, 'javascript:alert(1)');
  const l2 = await loc(2, 'data:text/html,x');
  const l3 = await loc(3, 'https://u:p@intranet/x');
  const l4 = await loc(4, 'https://intranet.example/' + 'a'.repeat(2049));
  assert([l1, l2, l3, l4].every((r) => r.status === 400 && r.body?.code === 'invalid_location' && r.body?.field === 'locationUrl' && !r.text.includes('MARK') && !r.text.includes('intranet')), 'DR4 javascript:, data:, credentials and 2049 characters -> 400 invalid_location, the value not echoed', [l1.body, l2.body, l3.body, l4.body]);
  const l5 = await loc(5, ' https://intranet.example/sites/grc/AC.docx ');
  const l6 = await loc(6, '\\\\fs01\\Compliance\\AC Policy.docx');
  const l7 = await loc(7, 'file://fs01/Compliance/AC.docx');
  const l8 = await loc(8, 'S:\\Policies\\AC.docx');
  assert(l5.status === 201 && l5.body?.document?.locationUrl === 'https://intranet.example/sites/grc/AC.docx' && l6.status === 201 && l6.body?.document?.locationUrl === '\\\\fs01\\Compliance\\AC Policy.docx' && l7.status === 201 && l8.status === 201 && l8.body?.document?.locationUrl === 'S:\\Policies\\AC.docx', 'DR4 a trimmed https URL, a UNC share, a file:// URL and a mapped drive are accepted and stored', [l5.body, l6.body, l7.body, l8.body]);

  const dr5v = await docs('POST', '', { kind: 'POLICY', title: 'Viewer MARK' }, viewer);
  const dr5g = await docs('GET', '', undefined, viewer);
  const dr5a = await docs('PUT', `/${A.id}`, { owner: 'x', expectedUpdatedAt: A.updatedAt }, assessor);
  assert(dr5v.status === 403 && dr5g.status === 200 && (dr5g.body?.documents as Json[]).some((d) => d.id === A.id) && dr5g.body?.limit === 2000 && dr5a.status === 403 && (await docs('DELETE', `/${A.id}`, undefined, viewer)).status === 403 && (await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: A.updatedAt, version: '1', approvalDate: today }, assessor)).status === 403, 'DR5 a VIEWER cannot create, an ASSESSOR cannot change; a VIEWER lists every document', [dr5v.status, dr5g.status, dr5a.status]);
  assert((await call('GET', `/tenants/${T}/documents`, null, T)).status === 401 && (await call('GET', `/tenants/${T}/documents`, rival, T)).status === 403, 'unauthenticated -> 401; a caller who is not a member -> 403');

  const dr6 = await docs('PUT', `/${A.id}`, { owner: 'Jane MARK 2', expectedUpdatedAt: A.updatedAt });
  const dr6stale = await docs('PUT', `/${A.id}`, { owner: 'Jane MARK 3', expectedUpdatedAt: A.updatedAt });
  const dr6none = await docs('PUT', `/${A.id}`, { owner: 'Jane MARK 4' });
  assert(dr6.status === 200 && dr6.body?.changed === true && dr6.body?.approvalCleared === false && dr6.body?.document?.owner === 'Jane MARK 2' && dr6.body?.document?.updatedAt > A.updatedAt, 'DR6 PUT with the current stamp -> 200 changed true', dr6.body);
  assert(dr6stale.status === 409 && dr6stale.body?.code === 'stale_write' && dr6stale.body?.current?.updatedAt === dr6.body?.document?.updatedAt && !dr6stale.text.includes('MARK') && dr6none.status === 400 && dr6none.body?.code === 'invalid_expected_updated_at', 'DR6 the old stamp -> 409 stale_write with the current stamp (no text); no stamp -> 400 invalid_expected_updated_at', [dr6stale.body, dr6none.body]);
  const same = await docs('PUT', `/${A.id}`, { owner: 'Jane MARK 2', expectedUpdatedAt: dr6.body?.document?.updatedAt });
  assert(same.status === 200 && same.body?.changed === false && same.body?.document?.updatedAt === dr6.body?.document?.updatedAt, 'a PUT that changes nothing -> changed false, the stamp is unchanged');
  assert((await docs('PUT', `/${A.id}`, { status: 'APPROVED', expectedUpdatedAt: same.body?.document?.updatedAt })).status === 400 && (await docs('PUT', `/${A.id}`, { origin: 'GENERATED', expectedUpdatedAt: same.body?.document?.updatedAt })).status === 400 && (await docs('PUT', '/no-such-document', { owner: 'x', expectedUpdatedAt: A.updatedAt })).status === 404, 'a status or origin in a PUT -> 400; an unknown document -> 404');

  let stamp = same.body?.document?.updatedAt as string;
  const dr7a = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '', approvalDate: today });
  const dr7b = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.0', approvalDate: today, approvedBy: 'Mallory' });
  const dr7c = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.0', approvalDate: '2999-01-01' });
  const dr7d = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.0', approvalDate: today, reviewBy: '2020-01-01' });
  assert([dr7a, dr7b, dr7c, dr7d].every((r) => r.status === 400 && r.body?.code === 'invalid') && dr7a.body?.field === 'version' && dr7b.body?.field === 'approvedBy' && dr7c.body?.field === 'approvalDate' && dr7d.body?.field === 'reviewBy', 'DR7 a blank version, an approver in the body, a far-future date and a review date before the approval -> 400', [dr7a.body, dr7b.body, dr7c.body, dr7d.body]);
  const dr7 = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.0', approvalDate: today, reviewBy: '2027-11-01' });
  const approved = dr7.body?.document as Json;
  assert(dr7.status === 200 && approved?.status === 'APPROVED' && approved?.approvedBy === 'u_dr_owner' && approved?.version === '1.0' && approved?.approvalDate === today && approved?.reviewBy === '2027-11-01' && typeof approved?.approvedAt === 'string', 'DR7 approve -> 200, APPROVED, the approver is the signed-in user, the dates and version are recorded', dr7.body);
  assert((await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.0', approvalDate: today })).body?.code === 'stale_write', 'approving with the stamp from before the approval -> 409 stale_write');

  const dr8a = await docs('PUT', `/${A.id}`, { owner: 'Bob MARK', expectedUpdatedAt: approved.updatedAt });
  assert(dr8a.status === 200 && dr8a.body?.document?.status === 'APPROVED' && dr8a.body?.approvalCleared === false && dr8a.body?.document?.approvedBy === 'u_dr_owner', 'DR8 changing the owner keeps the approval', dr8a.body);
  const dr8b = await docs('PUT', `/${A.id}`, { version: '1.1', expectedUpdatedAt: dr8a.body?.document?.updatedAt });
  assert(dr8b.status === 200 && dr8b.body?.approvalCleared === true && dr8b.body?.document?.status === 'DRAFT' && dr8b.body?.document?.approvedAt === null && dr8b.body?.document?.approvedBy === null && dr8b.body?.document?.approvalDate === null, 'DR8 changing the version clears the approval (DRAFT, no approver, no date)', dr8b.body);
  stamp = dr8b.body?.document?.updatedAt as string;
  const reappr = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: stamp, version: '1.1', approvalDate: today, reviewBy: '2027-11-01' });
  const dr8c = await docs('PUT', `/${A.id}`, { title: 'Access Control Policy MARK (renamed)', expectedUpdatedAt: reappr.body?.document?.updatedAt });
  const dr8d = await docs('PUT', `/${A.id}`, { locationUrl: 'https://intranet.example/ac', expectedUpdatedAt: dr8c.body?.document?.updatedAt });
  assert(reappr.status === 200 && dr8c.body?.approvalCleared === true && dr8c.body?.document?.status === 'DRAFT' && dr8d.body?.approvalCleared === false, 'DR8 a title change clears an approval (a location change on a draft does not)', [dr8c.body, dr8d.body]);
  const withdraw = await docs('POST', `/${A.id}/approve`, { expectedUpdatedAt: dr8d.body?.document?.updatedAt, version: '1.2', approvalDate: today });
  const dr8e = await docs('PUT', `/${A.id}`, { kind: 'PLAN', expectedUpdatedAt: withdraw.body?.document?.updatedAt });
  assert(withdraw.status === 200 && dr8e.body?.approvalCleared === true && dr8e.body?.document?.kind === 'PLAN', 'DR8 a kind change clears an approval', dr8e.body);
  const Astamp = dr8e.body?.document?.updatedAt as string;

  const seed = 'generated:CMMC_L2:AC';
  const dr9 = await docs('POST', '', { kind: 'POLICY', title: 'AC draft MARK', origin: 'GENERATED', seedKey: seed });
  const G = dr9.body?.document as Json;
  const dr9b = await docs('POST', '', { kind: 'POLICY', title: 'AC draft MARK 2', origin: 'GENERATED', seedKey: seed });
  assert(dr9.status === 201 && G?.status === 'DRAFT' && G?.origin === 'GENERATED' && G?.seedKey === seed && dr9b.status === 409 && dr9b.body?.code === 'duplicate_seed' && dr9b.body?.documentId === G?.id, 'DR9 a generated draft -> 201 DRAFT; the same seed again -> 409 duplicate_seed with the document id', [dr9.body, dr9b.body]);
  const notRev = await docs('POST', `/${G.id}/approve`, { expectedUpdatedAt: G.updatedAt, version: '1.0', approvalDate: today });
  const rev = await docs('POST', `/${G.id}/approve`, { expectedUpdatedAt: G.updatedAt, version: '1.0', approvalDate: today, confirmReviewed: true });
  assert(notRev.status === 409 && notRev.body?.code === 'not_reviewed' && rev.status === 200 && rev.body?.document?.status === 'APPROVED', 'DR9 approving a generated draft needs confirmReviewed (409 not_reviewed without it)', [notRev.body, rev.body]);
  assert((await docs('POST', '', { kind: 'POLICY', title: 'No Seed MARK', origin: 'GENERATED' })).status === 400 && (await docs('POST', '', { kind: 'POLICY', title: 'Manual Seed MARK', seedKey: seed })).status === 400 && (await docs('POST', '', { kind: 'POLICY', title: 'Bad Seed MARK', origin: 'GENERATED', seedKey: 'x' })).status === 400 && (await docs('POST', '', { kind: 'POLICY', title: 'Bad Origin MARK', origin: 'ROBOT' })).status === 400, 'GENERATED without a seed key, a seed key on a MANUAL document, a malformed seed and an unknown origin -> 400');

  const R = (await docs('POST', '', { kind: 'PROCEDURE', title: 'Retire Me MARK' })).body?.document as Json;
  const dr10 = await docs('POST', `/${R.id}/status`, { status: 'RETIRED', expectedUpdatedAt: R.updatedAt });
  const dup = await docs('POST', '', { kind: 'PROCEDURE', title: 'retire me mark' });
  const dr10b = await docs('POST', `/${R.id}/approve`, { expectedUpdatedAt: dr10.body?.document?.updatedAt, version: '1.0', approvalDate: today });
  const dr10c = await docs('POST', `/${R.id}/status`, { status: 'DRAFT', expectedUpdatedAt: dr10.body?.document?.updatedAt });
  assert(dr10.status === 200 && dr10.body?.document?.status === 'RETIRED' && dup.status === 201 && dr10b.status === 409 && dr10b.body?.code === 'retired' && dr10c.status === 409 && dr10c.body?.code === 'duplicate_title', 'DR10 RETIRED frees the title; approving a retired document -> 409 retired; reinstating it while the title is taken -> 409 duplicate_title', [dr10.body, dup.status, dr10b.body, dr10c.body]);
  const dupGone = await docs('DELETE', `/${dup.body?.document?.id}`);
  const dr10d = await docs('POST', `/${R.id}/status`, { status: 'DRAFT', expectedUpdatedAt: dr10.body?.document?.updatedAt });
  assert(dupGone.status === 200 && dr10d.status === 200 && dr10d.body?.document?.status === 'DRAFT' && dr10d.body?.changed === true && (await docs('POST', `/${R.id}/status`, { status: 'DRAFT', expectedUpdatedAt: dr10d.body?.document?.updatedAt })).body?.changed === false, 'a retired document is reinstated to DRAFT once the title is free; the same status again is not a change');
  assert((await docs('POST', `/${R.id}/status`, { status: 'APPROVED', expectedUpdatedAt: dr10d.body?.document?.updatedAt })).status === 400 && (await docs('POST', `/${R.id}/status`, { status: 'RETIRED', expectedUpdatedAt: R.updatedAt })).body?.code === 'stale_write', 'a status other than DRAFT or RETIRED -> 400; an old stamp -> 409 stale_write');

  const count = ((await docs('GET', '')).body?.documents as Json[]).length;
  __setDocumentLimitForTests(count);
  const dr11 = await docs('POST', '', { kind: 'POLICY', title: 'Over The Limit MARK' });
  __setDocumentLimitForTests(null);
  assert(dr11.status === 429 && dr11.body?.code === 'limit' && (await docs('POST', '', { kind: 'POLICY', title: 'Over The Limit MARK' })).status === 201, 'DR11 past the tenant limit -> 429 limit; after the hook is restored the same POST works', dr11.body);

  const dr12 = await docs('GET', '', undefined, rival, U);
  const dr12b = await docs('PUT', `/${A.id}`, { owner: 'x', expectedUpdatedAt: Astamp }, rival, U);
  const dr12c = await docs('GET', `/${A.id}/usage`, undefined, rival, U);
  assert(dr12.status === 200 && (dr12.body?.documents as Json[]).length === 0 && dr12b.status === 404 && dr12c.status === 404 && (await docs('DELETE', `/${A.id}`, undefined, rival, U)).status === 404 && (await docs('GET', `/${A.id}/usage`)).status === 200, "DR12 tenant U lists none of T's documents and cannot change, read the usage of or delete one (404)", [dr12.body, dr12b.status]);

  origLog('\n--- A program: declared set and control links ---');
  const B = (await docs('POST', '', { kind: 'PLAN', title: 'Beta Plan MARK' })).body?.document as Json;
  const l2Ids = getFrameworkControls('CMMC_L2').map((c) => c.id);
  const l2Set = new Set(l2Ids);
  const ac = l2Ids.find((id) => id.startsWith('AC.')) as string;
  const ir = l2Ids.find((id) => id.startsWith('IR.')) as string;
  const nistOnly = getFrameworkControls('NIST_800_53_REV5').map((c) => c.id).find((id) => !l2Set.has(id)) as string;
  const sortedLinks = [ac, ir].sort();

  const dr13 = await pd1('GET', '');
  assert(dr13.status === 200 && JSON.stringify(dr13.body) === JSON.stringify({ programId: P1, declared: false, documentIds: [], controlLinks: [], attachments: [], expectations: [] }), 'DR13 a fresh program: declared false, nothing else', dr13.body);
  assert((await call('GET', '/program-documents', null, T, undefined, P1)).status === 401 && (await call('GET', '/program-documents', rival, T, undefined, P1)).status === 403 && (await pd('no-such-program')('GET', '')).status === 404 && (await pd(P1, rival, U)('GET', '')).status === 404, 'unauthenticated -> 401; not a member -> 403; an unknown program or one of another tenant -> 404');

  const dr14 = await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [ir, ac], expectedControlIds: [] });
  assert(dr14.status === 200 && dr14.body?.changed === true && JSON.stringify(dr14.body?.controlIds) === JSON.stringify(sortedLinks) && dr14.body?.documentId === A.id, 'DR14 two controls of the program catalog -> 200, the ids sorted', dr14.body);
  const dr14b = await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [ir, ac], expectedControlIds: [] });
  assert(dr14b.status === 409 && dr14b.body?.code === 'stale_write' && JSON.stringify([...dr14b.body?.currentControlIds].sort()) === JSON.stringify(sortedLinks), 'DR14 the same body again (a stale expected set) -> 409 stale_write with currentControlIds', dr14b.body);
  const dr14c = await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [nistOnly], expectedControlIds: sortedLinks });
  assert(dr14c.status === 400 && dr14c.body?.code === 'control_not_in_program' && dr14c.body?.controlId === nistOnly, 'DR14 a control of another framework -> 400 control_not_in_program', dr14c.body);
  const unchanged = await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [ac, ir], expectedControlIds: sortedLinks });
  assert(unchanged.status === 200 && unchanged.body?.changed === false, 'the same set with the right expected set is not a change');
  assert((await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: ['a b'], expectedControlIds: [] })).status === 400 && (await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [ac, ac], expectedControlIds: sortedLinks })).status === 400 && (await pd1('PUT', `/documents/${A.id}/controls`, { controlIds: [ac] })).status === 400 && (await pd1('PUT', '/documents/no-such-document/controls', { controlIds: [], expectedControlIds: [] })).body?.code === 'document_not_found', 'a malformed or repeated control id and a missing expected set -> 400; an unknown document -> 404 document_not_found');

  const dr15 = await pd1('PATCH', '/documents', { add: [A.id] });
  assert(dr15.status === 200 && dr15.body?.declared === true && JSON.stringify(dr15.body?.documentIds) === JSON.stringify([A.id]) && dr15.body?.added === 1, 'DR15 PATCH {add:[A]} -> the program declares its documents', dr15.body);
  const outside = await pd1('PUT', `/documents/${B.id}/controls`, { controlIds: [ac], expectedControlIds: [] });
  const unknownDoc = await pd1('PATCH', '/documents', { add: ['no-such-document-MARK'] });
  assert(outside.status === 409 && outside.body?.code === 'document_not_in_program' && unknownDoc.status === 400 && unknownDoc.body?.code === 'unknown_documents' && unknownDoc.body?.count === 1 && !unknownDoc.text.includes('MARK'), 'DR15 linking a document that is not in the declared set -> 409 document_not_in_program; an unknown id -> 400 unknown_documents {count:1}', [outside.body, unknownDoc.body]);
  assert((await pd1('PATCH', '/documents', { add: [A.id] })).body?.added === 0 && (await pd1('PATCH', '/documents', { remove: [B.id] })).body?.removed === 0 && (await pd1('PATCH', '/documents', { add: [B.id], remove: [B.id] })).body?.code === 'invalid_document_ids' && (await pd1('PATCH', '/documents', {})).body?.code === 'invalid_document_ids' && (await pd1('PATCH', '/documents', { add: [A.id], force: 'yes' })).status === 400, 'adding a member again and removing a non-member are not changes; an id in both lists, nothing to change and a non-boolean force -> 400 invalid_document_ids');
  assert((await pd2('GET', '')).body?.declared === false && (await pd2('GET', '')).body?.controlLinks.length === 0, 'the declared set and the links of P1 are invisible in P2');

  origLog('\n--- Attachments ---');
  const upload = async (program: string, controlId: string, fileName: string) =>
    (await call('POST', '/evidence/upload-url', owner, T, { controlId, fileName, fileSize: 5, mimeType: 'text/plain', fileHash: sha256(fileName) }, program)).body?.evidenceId as string;
  const e1 = await upload(P1, ac, 'policy-file-one.txt');
  const e2 = await upload(P1, ac, 'policy-file-two.txt');
  const e3 = await upload(P2, getFrameworkControls('NIST_800_53_REV5', 'LOW')[0].id, 'other-program-file.txt');
  assert(Boolean(e1) && Boolean(e2) && Boolean(e3), 'setup: two evidence records in P1 and one in P2', [e1, e2, e3]);
  const a1 = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: e1, primary: true });
  assert(a1.status === 201 && a1.body?.attachment?.evidenceId === e1 && a1.body?.attachment?.isPrimary === true && a1.body?.changed === true, 'DR16 linking an evidence record of the program as primary -> 201', a1.body);
  const a2 = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: e2, primary: true });
  const afterTwo = ((await pd1('GET', '')).body?.attachments as Json[]).filter((a) => a.documentId === A.id);
  assert(a2.status === 201 && afterTwo.length === 2 && afterTwo.filter((a) => a.isPrimary).length === 1 && afterTwo.find((a) => a.isPrimary)?.evidenceId === e2, 'DR16 a second primary demotes the first: exactly one primary (e2)', afterTwo);
  const a2again = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: e2, primary: true });
  assert(a2again.status === 200 && a2again.body?.changed === false, 'DR16 the same link again -> 200 changed false');
  const promote = await pd1('PATCH', `/documents/${A.id}/attachments/${e1}`, { primary: true });
  assert(promote.status === 200 && (promote.body?.attachments as Json[]).filter((a) => a.isPrimary).length === 1 && (promote.body?.attachments as Json[]).find((a) => a.isPrimary)?.evidenceId === e1 && (await pd1('PATCH', `/documents/${A.id}/attachments/no-such`, { primary: true })).status === 404 && (await pd1('PATCH', `/documents/${A.id}/attachments/${e1}`, { primary: 'yes' })).status === 400, 'PATCH makes another attachment the primary (404 for one that is not linked, 400 for a non-boolean)', promote.body);
  const inh = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: `${e1}__inh_X` });
  const other = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: e3 });
  const gone = await pd1('POST', `/documents/${A.id}/attachments`, { evidenceId: 'no-such-evidence' });
  const notDeclared = await pd1('POST', `/documents/${B.id}/attachments`, { evidenceId: e1 });
  assert(inh.status === 400 && inh.body?.code === 'inherited_evidence' && other.status === 404 && other.body?.code === 'evidence_not_found' && gone.body?.code === 'evidence_not_found' && notDeclared.status === 409 && notDeclared.body?.code === 'document_not_in_program' && (await pd1('POST', '/documents/no-such-document/attachments', { evidenceId: e1 })).body?.code === 'document_not_found' && (await pd1('POST', `/documents/${A.id}/attachments`, {})).status === 400, 'DR16 an inherited copy -> 400 inherited_evidence; evidence of another program or none -> 404 evidence_not_found; a document outside the declared set -> 409; an unknown document -> 404', [inh.body, other.body, notDeclared.body]);
  assert((await call('DELETE', `/evidence/${e2}`, owner, T, undefined, P1)).status === 200 && ((await pd1('GET', '')).body?.attachments as Json[]).some((a) => a.documentId === A.id && a.evidenceId === e2), 'DR16 deleting the evidence record leaves the attachment listed (the client shows "file removed")');

  origLog('\n--- Expected documents ---');
  const applicable = applicableExpected(EXPECTED_CATALOG, 'CMMC_L2', l2Set);
  const expectedId = applicable[0].id;
  const nistExpected = (EXPECTED_CATALOG.frameworks.NIST_800_53_REV5 ?? [])[0].id;
  const dr22 = await pd1('PUT', `/expectations/${expectedId}`, { documentIds: [A.id], expectedDocumentIds: [] });
  assert(applicable.length > 0 && dr22.status === 200 && dr22.body?.changed === true && JSON.stringify(dr22.body?.documentIds) === JSON.stringify([A.id]), 'DR22 an expected document of the program -> 200', dr22.body);
  const dr22b = await pd1('PUT', `/expectations/${expectedId}`, { documentIds: [A.id], expectedDocumentIds: [] });
  const dr22c = await pd1('PUT', '/expectations/nope', { documentIds: [], expectedDocumentIds: [] });
  const dr22d = await pd1('PUT', `/expectations/${nistExpected}`, { documentIds: [], expectedDocumentIds: [] });
  assert(dr22b.status === 409 && dr22b.body?.code === 'stale_write' && JSON.stringify(dr22b.body?.currentDocumentIds) === JSON.stringify([A.id]) && dr22c.status === 400 && dr22c.body?.code === 'unknown_expected_document' && dr22d.status === 400 && dr22d.body?.code === 'unknown_expected_document', 'DR22 the same body again -> 409 stale_write; an unknown id and an entry of another framework -> 400 unknown_expected_document', [dr22b.body, dr22c.body, dr22d.body]);
  assert((await pd1('PUT', `/expectations/${expectedId}`, { documentIds: [B.id], expectedDocumentIds: [A.id] })).body?.code === 'document_not_in_program' && (await pd1('PUT', `/expectations/${expectedId}`, { documentIds: ['no-such-document'], expectedDocumentIds: [A.id] })).body?.code === 'document_not_found' && (await pd1('PUT', `/expectations/${expectedId}`, { documentIds: [A.id] })).status === 400, 'a document outside the declared set -> 409; an unknown document -> 404; a missing expected set -> 400');
  assert((await pd2('GET', '')).body?.expectations.length === 0, 'the checklist links of P1 are invisible in P2');

  origLog('\n--- Removing a document from the program, deleting a document or a program ---');
  const dr17 = await pd1('PATCH', '/documents', { remove: [A.id] });
  assert(dr17.status === 409 && dr17.body?.code === 'document_in_use' && dr17.body?.controlLinks === 2 && dr17.body?.attachments === 2 && dr17.body?.expectations === 1, 'DR17 removing a document that is still linked -> 409 document_in_use with the counts', dr17.body);
  const forced = await pd1('PATCH', '/documents', { remove: [A.id], force: true });
  const afterForce = (await pd1('GET', '')).body as Json;
  assert(forced.status === 200 && forced.body?.removed === 1 && forced.body?.declared === false && afterForce.controlLinks.length === 0 && afterForce.attachments.length === 0 && afterForce.expectations.length === 0, 'DR17 with force the links, the attachments and the checklist links go with it (the program is undeclared again)', forced.body);

  const C = (await docs('POST', '', { kind: 'PROCESS', title: 'Worksheet Gamma MARK' })).body?.document as Json;
  await pd1('PUT', `/documents/${C.id}/controls`, { controlIds: [ac], expectedControlIds: [] });
  await pd1('POST', `/documents/${C.id}/attachments`, { evidenceId: e1 });
  await pd1('PUT', `/expectations/${expectedId}`, { documentIds: [C.id], expectedDocumentIds: [] });
  const usage = await docs('GET', `/${C.id}/usage`);
  assert(usage.status === 200 && usage.body?.programs === 1 && usage.body?.controlLinks === 1 && usage.body?.attachments === 1 && usage.body?.expectations === 1, 'the usage of a document counts its links across the programs', usage.body);
  assert((await docs('DELETE', `/${C.id}`)).status === 200 && (await docs('DELETE', `/${C.id}`)).status === 404, 'DR18 DELETE removes the document (404 the second time)');
  const afterDelete = (await pd1('GET', '')).body as Json;
  assert(!afterDelete.controlLinks.some((l: Json) => l.documentId === C.id) && !afterDelete.attachments.some((x: Json) => x.documentId === C.id) && !afterDelete.expectations.some((x: Json) => x.documentId === C.id), 'DR18 the program has no rows for the deleted document');
  const P3 = await mkProgram('DR Program 3', 'CMMC_L2');
  const pd3 = pd(P3);
  const D = (await docs('POST', '', { kind: 'REFERENCE', title: 'Reference Delta MARK' })).body?.document as Json;
  await pd3('PUT', `/documents/${D.id}/controls`, { controlIds: [ac], expectedControlIds: [] });
  await pd3('PATCH', '/documents', { add: [D.id] });
  assert(__programDocumentRowsForTests({ tenantId: T, programId: P3 }) === 2, 'setup: P3 holds a declared document and a control link');
  const delProgram = await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T);
  assert(delProgram.status === 204 && (await pd3('GET', '')).status === 404 && __programDocumentRowsForTests({ tenantId: T, programId: P3 }) === 0, 'DR18 deleting the program: its GET is 404 and the store holds nothing for it', delProgram.status);
  assert((await pd1('GET', '')).body?.programId === P1 && (await docs('GET', '')).status === 200, 'the other programs and the register are untouched');

  origLog('\n--- History (digests, ids, counts and flags only) ---');
  const tenantEvents = (await call('GET', `/tenants/${T}/inventory/events?entityId=${A.id}&limit=200`, owner, T)).body?.events as Json[];
  const created = tenantEvents.find((e) => e.action === 'created');
  assert(tenantEvents.length > 3 && tenantEvents.every((e) => e.entityKind === 'document' && e.entityId === A.id) && /^[0-9a-f]{64}$/.test(created?.fields?.title?.sha256) && typeof created?.fields?.title?.length === 'number' && created?.fields?.kind === 'POLICY' && !JSON.stringify(tenantEvents).includes('MARK') && !JSON.stringify(tenantEvents).includes('intranet'), 'DR19 the tenant history of a document: entityKind document, the title as a digest, no text', tenantEvents.slice(0, 2));
  const actions = new Set(tenantEvents.map((e) => e.action));
  assert(['created', 'updated', 'approved', 'deleted'].filter((a) => a !== 'deleted').every((a) => actions.has(a)) && tenantEvents.some((e) => e.fields?.approvalCleared === true) && tenantEvents.every((e) => e.actor === 'u_dr_owner'), 'the history holds created, updated and approved events, the approval clearing as a flag, and the signed-in user as the actor', [...actions]);
  const programEvents = (await pd1('GET', '').then(() => call('GET', '/program-inventory/events?limit=200', owner, T, undefined, P1))).body?.events as Json[];
  const controlsChanged = programEvents.filter((e) => e.action === 'document_controls_changed' && e.entityId === A.id);
  const first = controlsChanged[controlsChanged.length - 1];
  assert(controlsChanged.length >= 1 && JSON.stringify([...first.detail.added].sort()) === JSON.stringify(sortedLinks) && first.detail.addedCount === 2, 'DR19 the program history holds document_controls_changed with the control ids', controlsChanged);
  const programActions = new Set(programEvents.map((e) => e.action));
  assert(['document_membership_changed', 'document_controls_changed', 'document_attachment_linked', 'document_primary_changed', 'document_attachment_unlinked', 'document_expectation_changed'].filter((a) => a !== 'document_attachment_unlinked').every((a) => programActions.has(a)) && !JSON.stringify(programEvents).includes('MARK'), 'the program history has membership, control, attachment, primary and checklist events and no text', [...programActions]);

  origLog('\n--- Roles and an archived program ---');
  const pdV = pd(P1, viewer);
  assert((await pdV('GET', '')).status === 200 && (await pdV('GET', '')).body?.programId === P1, 'a VIEWER reads the program documents');
  assert((await pdV('PUT', `/documents/${B.id}/controls`, { controlIds: [], expectedControlIds: [] })).status === 403 && (await pdV('PATCH', '/documents', { add: [B.id] })).status === 403 && (await pdV('POST', `/documents/${B.id}/attachments`, { evidenceId: e1 })).status === 403 && (await pdV('DELETE', `/documents/${B.id}/attachments/${e1}`)).status === 403 && (await pdV('PUT', `/expectations/${expectedId}`, { documentIds: [], expectedDocumentIds: [] })).status === 403 && (await pd(P1, assessor)('PATCH', '/documents', { add: [B.id] })).status === 403, 'DR20 a VIEWER and an ASSESSOR cannot write anything');
  const P4 = await mkProgram('DR Program 4 (archived)', 'CMMC_L1');
  assert((await call('POST', `/tenants/${T}/programs/${P4}/archive`, owner, T)).status === 200, 'P4 is archived');
  const pd4 = pd(P4);
  const arch = await pd4('PUT', `/documents/${B.id}/controls`, { controlIds: [], expectedControlIds: [] });
  assert(arch.status === 409 && arch.body?.code === 'program_archived' && (await pd4('PATCH', '/documents', { add: [B.id] })).body?.code === 'program_archived' && (await pd4('GET', '')).status === 200, 'DR20 an archived program: writes -> 409 program_archived, reads stay possible', arch.body);

  origLog('\n--- Logs ---');
  assert(captured.length > 0 && !captured.some((l) => l.includes('MARK')), 'DR21 no line the server logged contains a title, owner or note (MARK)', captured.filter((l) => l.includes('MARK')));
  assert(!captured.some((l) => /policy-file|other-program-file|intranet|fs01|Compliance/.test(l)), 'nor a file name or a location');
}

async function run() {
  pureTests();
  await apiTests();

  origLog('\n================================================================');
  origLog(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  origLog('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  origError('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
