import './testEnv';
import './evidenceEnv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { searchRateLimiter } from '../server/routes/search';
import { insertPoamItems } from '../server/vm/findingsStore';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { cmmcDisplayId } from '../src/data/cmmcGuide/displayId';
import { SEARCH_KINDS } from '../src/types/search';

/**
 * Global search (issue #254) over HTTP: POST /api/v1/search finds controls (id, the id the screens show, title, notes), objectives (catalog text and stored
 * narratives), evidence file names, assets, control and vulnerability POA&M entries, tools, vendors and documents in the open program; wildcards in the query are
 * literal; every role may search (a viewer, an archived program); another program or tenant never leaks; the query and the snippets are never logged; the
 * answers are never cached; the limits (8 per kind by default, 25 at most, 60 searches a minute). Runs against the in-memory store; the ILIKE statements run
 * only on a live PostgreSQL (CI). Boots the server on port 8080: run it alone.
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
  return { status: res.status, body: json, text, headers: res.headers };
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_gs_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const owner = person('u_gs_owner');
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Global Search Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const viewer = withRole('u_gs_viewer', T, 'VIEWER');
  const rival = person('u_gs_rival');
  const U = (await call('POST', '/tenants', rival, undefined, { name: 'Global Search Rival Org' })).body?.tenant?.id as string;
  const mkProgram = async (name: string, frameworkId: string, baseline?: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId, ...(baseline ? { baseline } : {}) })).body?.program?.id as string;
  const P1 = await mkProgram('GS Program 1', 'CMMC_L2');
  const P2 = await mkProgram('GS Program 2', 'NIST_800_53_REV5', 'LOW');
  assert(Boolean(T) && Boolean(U) && Boolean(P1) && Boolean(P2), 'setup: tenant T with P1 (CMMC_L2) and P2 (NIST 800-53 LOW), and tenant U', [T, U, P1, P2]);

  searchRateLimiter.reset();
  const search = (body: unknown, token: string | null = owner, program: string = P1, tenant: string = T) => call('POST', '/search', token, tenant, body, program);
  const group = (r: { body: Json | null }, kind: string): Json[] => ((r.body?.groups ?? []) as Json[]).find((g) => g.kind === kind)?.results ?? [];
  const c0 = getFrameworkControls('CMMC_L2')[0];

  origLog('\n--- Controls ---');
  const s1 = await search({ q: c0.id });
  assert(s1.status === 200 && s1.body?.programId === P1 && group(s1, 'control')[0]?.id === c0.id && group(s1, 'control')[0]?.nav?.screen === 'control' && group(s1, 'control')[0]?.nav?.controlId === c0.id, 'GS1 searching a control id -> the control is the first result, with its navigation', group(s1, 'control')[0]);
  assert(((s1.body?.groups ?? []) as Json[]).map((g) => g.kind).join() === SEARCH_KINDS.join(), 'one group per kind, in the order of SEARCH_KINDS', (s1.body?.groups ?? []).map((g: Json) => g.kind));
  const display = cmmcDisplayId(c0.id, 'CMMC_L2');
  const s2 = await search({ q: display });
  assert(group(s2, 'control').some((r) => r.id === c0.id), `GS2 searching the id the screens show (${display}) finds the stored control`, group(s2, 'control').map((r) => r.id));
  const s2b = await search({ q: c0.id.toLowerCase() });
  assert(group(s2b, 'control')[0]?.id === c0.id, 'the match ignores case');
  const titleWord = c0.title.split(/\s+/).find((w) => w.length >= 5) as string;
  const s2c = await search({ q: titleWord, kinds: ['control'] });
  assert(group(s2c, 'control').some((r) => r.id === c0.id && r.field === 'title' && r.snippet?.match.toLowerCase() === titleWord.toLowerCase()), 'a word of the title finds the control with field title and a snippet', group(s2c, 'control')[0]);
  assert((await call('PUT', `/controls/${encodeURIComponent(c0.id)}`, owner, T, { status: 'IN_PROGRESS', implementationNotes: 'Uses FalconMARK for EDR' }, P1)).status === 200, 'setup: notes on the first control');
  const s3 = await search({ q: 'falconmark' });
  const notesHit = group(s3, 'control').find((r) => r.id === c0.id);
  assert(notesHit?.field === 'notes' && notesHit?.snippet?.match === 'FalconMARK' && notesHit?.snippet?.before.endsWith('Uses ') && notesHit?.snippet?.after.startsWith(' for EDR'), 'GS3 a word of the notes finds the control: field notes, snippet around the match as plain text', notesHit);
  const blocked = await search({ q: 'FalconMARK' }, owner, P2);
  assert(group(blocked, 'control').length === 0, 'GS9 another program does not see those notes (P2: no control result)', group(blocked, 'control'));

  origLog('\n--- Objectives ---');
  const objectiveId = `${c0.id}[a]`;
  assert((await call('PUT', `/objectives/${encodeURIComponent(objectiveId)}`, owner, T, { controlId: c0.id, narrative: 'MARK objective narrative text' }, P1)).status === 200, 'setup: a narrative on the first objective');
  const s4 = await search({ q: 'mark objective narrative' });
  const objHit = group(s4, 'objective').find((r) => r.id === objectiveId);
  assert(objHit?.nav?.screen === 'objective' && objHit?.nav?.objectiveId === objectiveId && objHit?.nav?.controlId === c0.id && objHit?.field === 'narrative', 'GS4 a stored narrative finds the objective with its navigation', objHit);

  origLog('\n--- Evidence ---');
  const upload = async (fileName: string) =>
    (await call('POST', '/evidence/upload-url', owner, T, { controlId: c0.id, fileName, fileSize: 5, mimeType: 'text/plain', fileHash: sha256(fileName) }, P1)).body?.evidenceId as string;
  const e1 = await upload('mark-policy_v1.pdf');
  const e2 = await upload('mark-policyXv1.pdf');
  const s5 = await search({ q: '_v1' });
  assert(group(s5, 'evidence').length === 1 && group(s5, 'evidence')[0]?.id === e1 && group(s5, 'evidence')[0]?.nav?.evidenceId === e1 && group(s5, 'evidence')[0]?.nav?.controlId === c0.id, 'GS5 a file name is found by a part of it; "_" is literal (the file with an X there is not)', group(s5, 'evidence'));
  assert((await search({ q: '%' })).status === 400, 'GS5 "%" alone is too short -> 400');
  assert(group(await search({ q: '%%' }), 'evidence').length === 0 && group(await search({ q: 'mark%v1' }), 'evidence').length === 0, 'GS5 "%%" and "mark%v1" find nothing: wildcards are literal');
  assert(e2 !== undefined && group(await search({ q: 'policyXv1' }), 'evidence')[0]?.id === e2, 'the other file is found by its own name');
  const inherited = group(await search({ q: 'mark-policy_v1' }), 'evidence');
  assert(inherited.length === 1, 'an inherited copy of a file is not a second result', inherited.map((r) => r.id));

  origLog('\n--- Assets, tools, vendors, documents ---');
  const asset = await call('POST', `/tenants/${T}/assets`, owner, T, { hostName: 'srv-mark-01', cmmcAssetCategory: 'CUI_ASSET', ipAddress: '10.9.8.7' });
  const tool = await call('POST', `/tenants/${T}/inventory/tools`, owner, T, { name: 'MarkTool', vendorName: 'Acme Vendor' });
  const vendor = await call('POST', `/tenants/${T}/inventory/vendors`, owner, T, { name: 'MarkVendor', services: 'Managed detection' });
  const doc = await call('POST', `/tenants/${T}/documents`, owner, T, { kind: 'POLICY', title: 'Mark Access Policy', notes: 'NOTES-ONLY-TEXT' });
  assert(asset.status === 201 && tool.status === 201 && vendor.status === 201 && doc.status === 201, 'setup: an asset, a tool, a vendor and a document', [asset.status, tool.status, vendor.status, doc.status]);
  const s6 = await search({ q: 'mark' });
  const assetHit = group(s6, 'asset').find((r) => r.title === 'srv-mark-01');
  const toolHit = group(s6, 'tool').find((r) => r.title === 'MarkTool');
  const vendorHit = group(s6, 'vendor').find((r) => r.title === 'MarkVendor');
  const docHit = group(s6, 'document').find((r) => r.title === 'Mark Access Policy');
  assert(assetHit?.nav?.screen === 'asset' && toolHit?.nav?.screen === 'tool' && vendorHit?.nav?.screen === 'vendor' && docHit?.nav?.screen === 'document', 'GS6 the asset, the tool, the vendor and the document are found, each with its navigation', [assetHit, toolHit, vendorHit, docHit].map((r) => r?.nav));
  assert([assetHit, toolHit, vendorHit, docHit].every((r) => typeof r?.inProgram === 'boolean') && assetHit?.inProgram === true && toolHit?.inProgram === true && vendorHit?.inProgram === false && docHit?.inProgram === true, 'GS6 each carries inProgram (the whole register applies while the program declares none; a vendor with no tool or document in it is not in the program)', [assetHit, toolHit, vendorHit, docHit].map((r) => r?.inProgram));
  assert(group(await search({ q: '10.9.8.7' }), 'asset')[0]?.field === 'IP address', 'an asset is found by its IP address');
  assert((await call('PATCH', '/program-inventory/tools', owner, T, { add: [tool.body?.tool?.id] }, P2)).status === 200, 'setup: P2 declares the tool as its boundary');
  const inP2 = await search({ q: 'MarkTool' }, owner, P2);
  const inP1 = await search({ q: 'MarkTool' }, owner, P1);
  assert(group(inP2, 'tool')[0]?.inProgram === true && group(inP1, 'tool')[0]?.inProgram === true, 'a tool of the register is found in any program (inProgram follows that program\'s boundary)');
  assert(group(await search({ q: 'NOTES-ONLY' }), 'document').length === 0 && group(await search({ q: 'NOTES-ONLY' }), 'tool').length === 0, 'B21 a document\'s notes are not searched');

  origLog('\n--- POA&M ---');
  const draft = {
    findingId: 'fnd_gs_1',
    findingFirstSeenAt: '2026-01-01T00:00:00.000Z',
    controlId: 'RA.L2-3.11.3' as const,
    weakness: 'mark weakness in the web tier',
    mitigation: '' as const,
    owner: '' as const,
    scheduledCompletion: null,
    status: 'OPEN' as const,
    createdBy: 'system:vm-worker' as const,
  };
  await insertPoamItems(T, [draft], null, P1);
  const c1 = getFrameworkControls('CMMC_L2')[1];
  assert((await call('PATCH', `/control-poam/${encodeURIComponent(c1.id)}`, owner, T, { expectedUpdatedAt: null, owner: 'Mark Owner' }, P1)).status === 200, 'setup: a control POA&M entry with an owner');
  const s7 = await search({ q: 'mark' });
  const vm = group(s7, 'poam_vm')[0];
  const cp = group(s7, 'poam_control').find((r) => r.id === c1.id);
  assert(vm?.nav?.screen === 'poam_vm' && vm?.field === 'weakness' && cp?.nav?.screen === 'poam_control' && cp?.field === 'owner' && cp?.nav?.controlId === c1.id, 'GS7 a vulnerability item (weakness) and a control POA&M entry (owner) are found', [vm, cp]);
  assert(group(await search({ q: 'weakness in the web' }, owner, P2), 'poam_vm').length === 0, 'the vulnerability item is invisible in another program');
  assert(group(await search({ q: 'mark weak', kinds: ['poam_vm'] }), 'poam_vm').length === 1 && ((await search({ q: 'mark weak', kinds: ['poam_vm'] })).body?.groups ?? []).length === 1, 'kinds narrows the search to the kinds asked for');

  origLog('\n--- Roles, programs and tenants ---');
  const sv = await search({ q: 'FalconMARK' }, viewer);
  assert(sv.status === 200 && group(sv, 'control').some((r) => r.id === c0.id), 'GS8 a viewer can search (200, not 403)', sv.status);
  const crossTenant = await search({ q: 'FalconMARK' }, rival, P1, U);
  assert(crossTenant.status === 404 && !crossTenant.text.includes('FalconMARK') && !crossTenant.text.includes(c0.id), 'GS9 another tenant naming P1 -> 404, never P1\'s data', crossTenant.body);
  const noHeader = await call('POST', '/search', rival, U, { q: 'FalconMARK' });
  assert(noHeader.status === 409 && noHeader.body?.code === 'program_required', 'a tenant with no program -> 409 program_required (nothing of P1)', noHeader.body);
  assert((await search({ q: 'FalconMARK' }, null)).status === 401, 'no token -> 401');

  origLog('\n--- Limits and refusals ---');
  const bad1 = await search({ q: 'a' });
  const bad2 = await search({ q: 'x'.repeat(101) });
  const bad3 = await search({ q: '  ' });
  const bad4 = await search({ q: 42 });
  const bad5 = await search({ q: 'a\u0007b' });
  const bad6 = await search({});
  assert([bad1, bad2, bad3, bad4, bad5, bad6].every((r) => r.status === 400 && r.body?.code === 'invalid_query'), 'GS10 a missing, short, long, blank, non-text or control-character query -> 400 invalid_query', [bad1, bad2, bad3, bad4, bad5, bad6].map((r) => r.status));
  assert(Object.keys(bad1.body ?? {}).sort().join() === 'code,error', 'the error body is just { error, code }');
  assert((await search({ q: 'ab', perKind: 26 })).status === 400 && (await search({ q: 'ab', perKind: 0 })).status === 400 && (await search({ q: 'ab', perKind: 1.5 })).status === 400 && (await search({ q: 'ab', kinds: ['nope'] })).status === 400 && (await search({ q: 'ab', kinds: [] })).status === 400, 'GS11 perKind 26, 0 and 1.5, and an unknown or empty kinds list -> 400');
  for (const f of ['mark-a-1.txt', 'mark-a-2.txt', 'mark-a-3.txt', 'mark-a-4.txt', 'mark-a-5.txt']) await upload(f);
  const s11 = await search({ q: 'mark-a-', perKind: 2 });
  const ev = ((s11.body?.groups ?? []) as Json[]).find((g) => g.kind === 'evidence');
  assert(ev?.results?.length === 2 && ev?.truncated === true, 'GS11 perKind 2 with 5 matching files -> 2 results and truncated true', [ev?.results?.length, ev?.truncated]);
  const s11b = await search({ q: 'mark-a-', perKind: 25 });
  assert(((s11b.body?.groups ?? []) as Json[]).find((g) => g.kind === 'evidence')?.results?.length === 5 && ((s11b.body?.groups ?? []) as Json[]).find((g) => g.kind === 'evidence')?.truncated === false, 'perKind 25 returns them all, truncated false');
  for (let i = 0; i < 12; i++) await upload(`mark-b-${i}.txt`);
  const dflt = ((await search({ q: 'mark-b-' })).body?.groups as Json[]).find((g) => g.kind === 'evidence');
  assert(dflt?.results?.length === 8 && dflt?.truncated === true, 'the default is 8 per kind (12 matching files -> 8, truncated)', [dflt?.results?.length, dflt?.truncated]);
  const s13 = await search({ q: 'mark' });
  assert((s13.headers.get('cache-control') ?? '').includes('no-store') && (bad1.headers.get('cache-control') ?? '').includes('no-store'), 'GS13 Cache-Control: no-store on an answer and on a refusal');

  origLog('\n--- An archived program ---');
  assert((await call('POST', `/tenants/${T}/programs/${P2}/archive`, owner, T)).status === 200, 'P2 is archived');
  const arch = await search({ q: 'MarkTool' }, owner, P2);
  assert(arch.status === 200 && group(arch, 'tool').length === 1, 'GS8 an archived program can be searched (200, not 409)', arch.status);
  assert((await call('PUT', `/controls/${encodeURIComponent(getFrameworkControls('NIST_800_53_REV5', 'LOW')[0].id)}`, owner, T, { status: 'IN_PROGRESS' }, P2)).status === 409, 'the existing program context still refuses writes to it (409)');

  origLog('\n--- The rate limit ---');
  searchRateLimiter.reset();
  const limiter = withRole('u_gs_limited', T, 'VIEWER');
  let last = 0;
  let firstLimited = 0;
  for (let i = 1; i <= 61; i++) {
    last = (await search({ q: 'zz', kinds: ['tool'] }, limiter)).status;
    if (last === 429 && firstLimited === 0) firstLimited = i;
  }
  assert(firstLimited === 61 && last === 429, 'GS12 the 61st search of a minute from one user -> 429', [firstLimited, last]);
  assert((await search({ q: 'zz', kinds: ['tool'] }, viewer)).status === 200, 'another user is not limited');
  searchRateLimiter.reset();

  origLog('\n--- Source and logs ---');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  const route = read('server', 'routes', 'search.ts');
  const api = read('server', 'routes', 'api.ts');
  assert(!route.includes('requireWriteRole') && /router\.use\('\/search', authMiddleware, searchRateLimiter, programReadContext, searchRouter\)/.test(api), 'GS15 the route has no write guard and is mounted behind authMiddleware, the limiter and programReadContext');
  const ctx = read('server', 'middleware', 'programContext.ts');
  assert(/export async function programContext\(req: Request, res: Response, next: NextFunction\): Promise<void> \{\n  await resolveProgram\(req, res, next, true\);\n\}/.test(ctx) && /export async function optionalProgramContext\(req: Request, res: Response, next: NextFunction\): Promise<void> \{\n  await resolveProgram\(req, res, next, false\);\n\}/.test(ctx), 'GS15b programContext and optionalProgramContext are unchanged (the read-only variant is a new export)');
  const logLines = ['routes/search.ts', 'search/searchStore.ts', 'search/catalogIndex.ts'].flatMap((f) => read('server', ...f.split('/')).split('\n').filter((l) => /console\.\w+\(/.test(l)));
  assert(logLines.length > 0 && !logLines.some((l) => /\bq\b|snippet|body|query/i.test(l.replace(/\[Search\] Failed to search the program:/, ''))), 'GS14b no console line of the search code mentions the query, a snippet or the body', logLines);
  assert(captured.length > 0 && !captured.some((l) => /MARK|falconmark|mark-policy|mark-a-|mark-b-|srv-mark|NOTES-ONLY|mark weakness/.test(l)), 'GS14 no line the server logged contains the query, a snippet, a note, a file name or an asset name', captured.filter((l) => /MARK|falconmark|mark-policy|mark-a-|mark-b-|srv-mark|NOTES-ONLY|mark weakness/.test(l)));
  assert(captured.some((l) => /^\[Search\] u_gs_owner searched program/.test(l) && /\(\d+ results\)$/.test(l)), 'the log line holds the user, the program and a count');
}

async function run() {
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
