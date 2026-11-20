import './testEnv';
import './evidenceEnv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { CUI_CATEGORY_IDS } from '../server/inventory/cuiCategories';
import { __programInventoryRowsForTests } from '../server/inventory/programInventoryStore';
import { validateDataInventoryInput, validateToolControlsInput, validateToolIdChange, validateVendorDocumentInput } from '../src/data/inventory/inventorySchema';

/**
 * A program's side of the Tools and Services register (issues #239, #243, #248) over HTTP: the declared boundary (deltas, tool_in_use unless forced),
 * the tool-to-control links (validated against the program's own catalog, stale-write protected by the set the client saw), the data inventory (FCI,
 * CUI categories of the shipped registry, tool roles; whole replace with a stamp), the vendor documents (evidence ids of the same program) and the
 * program history. Also: program isolation, roles, an archived program, the cascades of a tool delete and a program delete, and that no name or
 * text reaches the history or the logs. Runs against the in-memory store; the SQL is checked structurally in tests/dbSchema.test.ts and, against a
 * live database, by `npm run db:verify-rls`. Boots the server on port 8080: run it alone.
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
  const stmts = [...read('server', 'inventory', 'programInventoryStore.ts').replace(/\$\{[^}]*\}/g, '${}').replace(/interval '1 millisecond'/g, 'interval 1ms').matchAll(/(SELECT|UPDATE|DELETE)[^`'"]*?program_(tools|tool_controls|data_inventory|cui_categories|cui_category_tools|vendor_documents|inventory_events)[^`'"]*/g)].map((m) => m[0]);
  assert(stmts.length >= 15 && stmts.every((s) => /tenant_id\s*=\s*\$\d/.test(s) && /program_id\s*=\s*\$\d/.test(s)), 'PI-S1 every SELECT / UPDATE / DELETE of programInventoryStore.ts filters by tenant_id and program_id', stmts.filter((s) => !(/tenant_id\s*=\s*\$\d/.test(s) && /program_id\s*=\s*\$\d/.test(s))));
  const lines = read('server', 'routes', 'programInventory.ts').split('\n').filter((l) => /console\.\w+\(/.test(l));
  assert(lines.length > 0 && !lines.some((l) => /name|vendor|mission|notes|services|cost/.test(l)), 'PI-S2 no console line of routes/programInventory.ts contains name, vendor, mission, notes, services or cost', lines);
  const programs = read('server', 'programs.ts');
  assert(programs.includes('export function programCatalogIds(') && programs.includes('__deleteProgramInventoryForMemory({ tenantId, programId: id })'), 'PI-S3 programs.ts exports programCatalogIds and clears the memory rows of a deleted program');

  const known = new Set(['CTI', 'EXPT']);
  const ok = (cats: unknown, stored: string[] = []) => validateDataInventoryInput({ handlesFci: null, categories: cats }, known, new Set(stored));
  const tool = { toolId: 't1', stores: true, processes: false, transmits: false };
  assert(ok([{ categoryId: 'CTI', tools: [tool] }]).ok && ok([]).ok, 'PI-V1 a known category with a tool role is accepted');
  const unknown = ok([{ categoryId: 'LEGACY-ID', tools: [] }]);
  assert(!unknown.ok && unknown.code === 'unknown_cui_category' && unknown.index === 0 && !JSON.stringify(unknown).includes('LEGACY'), 'PI-V2 an unknown category is unknown_cui_category (position only, the id is not echoed)', unknown);
  assert(ok([{ categoryId: 'LEGACY-ID', tools: [] }], ['LEGACY-ID']).ok, 'PI-V3 a category already stored stays accepted even when the registry no longer lists it');
  assert(!ok([{ categoryId: 'cti', tools: [] }]).ok && !ok([{ categoryId: 'CTI', tools: [] }, { categoryId: 'CTI', tools: [] }]).ok && !ok([{ categoryId: 'CTI', tools: [{ ...tool, stores: false }] }]).ok && !ok([{ categoryId: 'CTI', tools: [tool, tool] }]).ok && !ok([{ categoryId: 'CTI', tools: [{ ...tool, stores: 'yes' }] }]).ok && !ok('nope').ok, 'PI-V4 a malformed id, a repeated category or tool, an empty role and a non-boolean role are refused');
  assert(!validateDataInventoryInput({ categories: [] }, known, new Set()).ok && !validateDataInventoryInput({ handlesFci: 'yes', categories: [] }, known, new Set()).ok, 'PI-V5 handlesFci is required: true, false or null');
  assert(validateToolControlsInput({ controls: [{ controlId: 'AC.L2-3.1.1', evidenceSource: true }], expectedControlIds: [] }).ok && !validateToolControlsInput({ controls: [{ controlId: 'a b', evidenceSource: true }], expectedControlIds: [] }).ok && !validateToolControlsInput({ controls: [{ controlId: 'AC-1', evidenceSource: 1 }], expectedControlIds: [] }).ok && !validateToolControlsInput({ controls: [], expectedControlIds: ['AC-1', 'AC-1'] }).ok && !validateToolControlsInput({ controls: [] }).ok, 'PI-V6 control links: shape, ids, booleans, duplicates and the expected set');
  assert(validateToolIdChange({ add: ['a'] }).ok && !validateToolIdChange({}).ok && !validateToolIdChange({ add: ['a'], remove: ['a'] }).ok && !validateToolIdChange({ add: ['a'], force: 'yes' }).ok && !validateToolIdChange({ add: ['a', 'a'] }).ok, 'PI-V7 boundary change: deltas, not empty, no id in both, force is a boolean');
  assert(validateVendorDocumentInput({ vendorId: 'v', evidenceId: 'e', docKind: 'CRM' }).ok && !validateVendorDocumentInput({ vendorId: 'v', evidenceId: 'e', docKind: 'XYZ' }).ok && !validateVendorDocumentInput({ vendorId: 'v' }).ok, 'PI-V8 vendor document: ids and a known kind');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_pi_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const owner = person('u_pi_owner');
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Program Inventory Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const viewer = withRole('u_pi_viewer', T, 'VIEWER');
  const rival = person('u_pi_rival');
  const U = (await call('POST', '/tenants', rival, undefined, { name: 'Program Inventory Rival Org' })).body?.tenant?.id as string;

  const mkProgram = async (name: string, frameworkId: string, baseline?: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId, ...(baseline ? { baseline } : {}) })).body?.program?.id as string;
  const P1 = await mkProgram('PI Program 1', 'CMMC_L2');
  const P2 = await mkProgram('PI Program 2', 'NIST_800_53_REV5', 'LOW');
  assert(Boolean(P1) && Boolean(P2), 'setup: tenant T with P1 (CMMC_L2) and P2 (NIST 800-53 LOW)', [P1, P2]);
  const pi = (program: string, token: string | null = owner, tenant: string = T) => (method: string, sub: string, body?: unknown) => call(method, `/program-inventory${sub}`, token, tenant, body, program);
  const in1 = pi(P1);
  const in2 = pi(P2);

  const mkTool = async (name: string) => (await call('POST', `/tenants/${T}/inventory/tools`, owner, T, { name })).body?.tool as Json;
  const A = await mkTool('Tool A MARK');
  const B = await mkTool('Tool B MARK');
  const V = (await call('POST', `/tenants/${T}/inventory/vendors`, owner, T, { name: 'Vendor MARK' })).body?.vendor as Json;
  assert(Boolean(A?.id) && Boolean(B?.id) && Boolean(V?.id), 'setup: tools A and B and a vendor in the register');

  const l2 = getFrameworkControls('CMMC_L2').map((c) => c.id);
  const l2Set = new Set(l2);
  const si = l2.find((id) => id.startsWith('SI.')) as string;
  const au = l2.find((id) => id.startsWith('AU.')) as string;
  const nistLow = getFrameworkControls('NIST_800_53_REV5', 'LOW').map((c) => c.id);
  const nistOnly = nistLow.filter((id) => !l2Set.has(id));
  const cat = [...CUI_CATEGORY_IDS][0];

  origLog('\n--- The boundary ---');
  const pi1 = await in1('GET', '');
  assert(pi1.status === 200 && JSON.stringify(pi1.body) === JSON.stringify({ programId: P1, declared: false, toolIds: [], controlLinks: [], vendorDocuments: [] }), 'PI1 a fresh program: declared false, nothing else', pi1.body);
  assert((await call('GET', '/program-inventory', null, T, undefined, P1)).status === 401 && (await call('GET', '/program-inventory', rival, T, undefined, P1)).status === 403, 'unauthenticated -> 401; a caller who is not a member -> 403');
  const pi2 = await in1('PATCH', '/tools', { add: [A.id] });
  assert(pi2.status === 200 && pi2.body?.declared === true && JSON.stringify(pi2.body?.toolIds) === JSON.stringify([A.id]) && pi2.body?.added === 1 && pi2.body?.removed === 0, 'PI2 PATCH {add:[A]} -> declared true, toolIds [A]', pi2.body);
  const unknownTool = await in1('PATCH', '/tools', { add: ['no-such-tool-MARK'] });
  assert(unknownTool.status === 400 && unknownTool.body?.code === 'unknown_tools' && unknownTool.body?.count === 1 && !unknownTool.text.includes('MARK'), 'PI2 an unknown id -> 400 unknown_tools {count:1}, never echoed', unknownTool.body);
  assert((await in1('PATCH', '/tools', { add: [B.id], remove: [B.id] })).body?.code === 'invalid_tool_ids' && (await in1('PATCH', '/tools', {})).body?.code === 'invalid_tool_ids' && (await in1('PATCH', '/tools', { add: ['a b'] })).status === 400 && (await in1('PATCH', '/tools', { add: [A.id], force: 'yes' })).status === 400, 'PI2 an id in both lists, nothing to change, a malformed id, a non-boolean force -> 400 invalid_tool_ids');
  const again = await in1('PATCH', '/tools', { add: [A.id] });
  assert(again.status === 200 && again.body?.added === 0 && JSON.stringify(again.body?.toolIds) === JSON.stringify([A.id]), 'adding a member again is not a change (added 0)');
  assert((await in1('PATCH', '/tools', { remove: [B.id] })).body?.removed === 0, 'removing a non-member is not a change');

  origLog('\n--- Control links ---');
  const sorted = [si, au].sort();
  const pi3 = await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: si, evidenceSource: true }, { controlId: au, evidenceSource: false }], expectedControlIds: [] });
  assert(pi3.status === 200 && pi3.body?.changed === true && JSON.stringify(pi3.body?.controls.map((c: Json) => c.controlId)) === JSON.stringify(sorted) && pi3.body?.controls.find((c: Json) => c.controlId === si)?.evidenceSource === true, 'PI3 two links of the program catalog, expectedControlIds [] -> 200, the ids sorted, the flags kept', pi3.body);
  const pi4 = await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: si, evidenceSource: true }, { controlId: au, evidenceSource: false }], expectedControlIds: [] });
  assert(pi4.status === 409 && pi4.body?.code === 'stale_write' && JSON.stringify([...pi4.body?.currentControlIds].sort()) === JSON.stringify(sorted), 'PI4 the same body again (a stale expected set) -> 409 stale_write with currentControlIds', pi4.body);
  const flip = await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: si, evidenceSource: false }, { controlId: au, evidenceSource: false }], expectedControlIds: sorted });
  assert(flip.status === 200 && flip.body?.changed === true && flip.body?.controls.every((c: Json) => c.evidenceSource === false), 'a flag change on a link -> 200 changed true');
  const noChange = await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: si, evidenceSource: false }, { controlId: au, evidenceSource: false }], expectedControlIds: sorted });
  assert(noChange.status === 200 && noChange.body?.changed === false, 'the same set and flags with the right expected set -> changed false');
  const pi5 = await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: nistOnly[0], evidenceSource: false }], expectedControlIds: sorted });
  assert(pi5.status === 400 && pi5.body?.code === 'control_not_in_program' && pi5.body?.controlId === nistOnly[0], 'PI5 a control of the other program (NIST) -> 400 control_not_in_program with the control id', pi5.body);
  const pi6 = await in1('PUT', `/tools/${B.id}/controls`, { controls: [{ controlId: si, evidenceSource: false }], expectedControlIds: [] });
  assert(pi6.status === 409 && pi6.body?.code === 'tool_not_in_boundary', 'PI6 a tool outside the declared boundary -> 409 tool_not_in_boundary', pi6.body);
  const pi6b = await in2('PUT', `/tools/${B.id}/controls`, { controls: [{ controlId: nistOnly[0], evidenceSource: true }], expectedControlIds: [] });
  assert(pi6b.status === 200 && pi6b.body?.controls.length === 1, 'PI6 in the undeclared P2 the same tool can be linked with a P2 control -> 200', pi6b.body);
  assert((await in1('PUT', '/tools/no-such-tool/controls', { controls: [], expectedControlIds: [] })).body?.code === 'tool_not_found' && (await in1('PUT', '/tools/..%2Fevil/controls', { controls: [], expectedControlIds: [] })).status === 404 && (await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: 'x y', evidenceSource: true }], expectedControlIds: sorted })).status === 400 && (await in1('PUT', `/tools/${A.id}/controls`, { controls: [] })).status === 400, 'an unknown tool -> 404 tool_not_found; a malformed id, control id or missing expected set -> 400/404');
  const pi7a = await in1('GET', '');
  const pi7b = await in2('GET', '');
  assert(pi7a.body?.controlLinks.length === 2 && pi7a.body?.controlLinks.every((l: Json) => l.toolId === A.id) && pi7b.body?.controlLinks.length === 1 && pi7b.body?.controlLinks[0].toolId === B.id && pi7b.body?.declared === false && pi7b.body?.toolIds.length === 0, "PI7 each program shows only its own links and boundary (P1's are invisible in P2)", [pi7a.body, pi7b.body]);

  origLog('\n--- Removing a tool from the boundary ---');
  const pi8a = await in1('PATCH', '/tools', { remove: [A.id] });
  assert(pi8a.status === 409 && pi8a.body?.code === 'tool_in_use' && pi8a.body?.controlLinks === 2 && pi8a.body?.cuiLinks === 0, 'PI8 removing a tool that still has links -> 409 tool_in_use {controlLinks:2, cuiLinks:0}', pi8a.body);
  assert(JSON.stringify((await in1('GET', '')).body?.toolIds) === JSON.stringify([A.id]) && (await in1('GET', '')).body?.controlLinks.length === 2, 'the refused removal changed nothing');
  const pi8b = await in1('PATCH', '/tools', { remove: [A.id], force: true });
  const afterForce = await in1('GET', '');
  assert(pi8b.status === 200 && pi8b.body?.removed === 1 && pi8b.body?.declared === false && pi8b.body?.linksRemoved === 2 && afterForce.body?.controlLinks.length === 0 && afterForce.body?.toolIds.length === 0, 'PI8 with force:true -> 200, the links are gone with it (the boundary is empty again: the whole register applies)', pi8b.body);
  assert((await in1('PATCH', '/tools', { add: [A.id] })).status === 200, 'the tool is back in the boundary');

  origLog('\n--- Data inventory ---');
  const fresh = await in1('GET', '/data-inventory');
  assert(fresh.status === 200 && JSON.stringify(fresh.body) === JSON.stringify({ handlesFci: null, categories: [], updatedAt: null, updatedBy: null }), 'PI9 a fresh GET -> {handlesFci:null, categories:[], updatedAt:null}', fresh.body);
  const row = { toolId: A.id, stores: true, processes: false, transmits: false };
  const pi9 = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [row] }], expectedUpdatedAt: null });
  assert(pi9.status === 200 && pi9.body?.changed === true && pi9.body?.handlesFci === true && pi9.body?.categories[0]?.categoryId === cat && pi9.body?.categories[0]?.tools[0]?.toolId === A.id && typeof pi9.body?.updatedAt === 'string', 'PI9 PUT with expectedUpdatedAt null -> 200 and the stored record', pi9.body);
  assert(JSON.stringify((await in1('GET', '/data-inventory')).body?.categories) === JSON.stringify([{ categoryId: cat, tools: [row] }]), 'a GET returns what was saved');
  const nope = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: 'NOPE-MARK', tools: [] }], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(nope.status === 400 && nope.body?.code === 'unknown_cui_category' && !nope.text.includes('MARK'), 'PI9 an unknown category -> 400 unknown_cui_category, and nothing echoes it', nope.body);
  const noRole = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [{ ...row, stores: false }] }], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(noRole.status === 400 && noRole.body?.code === 'invalid', 'PI9 a tool row that stores, processes and transmits nothing -> 400');
  const outside = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [row, { ...row, toolId: B.id }] }], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(outside.status === 409 && outside.body?.code === 'tool_not_in_boundary', 'PI9 a tool outside the declared boundary -> 409 tool_not_in_boundary', outside.body);
  const ghost = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [{ ...row, toolId: 'ghost-tool' }] }], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(ghost.status === 404 && ghost.body?.code === 'tool_not_found', 'an unknown tool -> 404 tool_not_found', ghost.body);
  const staleDi = await in1('PUT', '/data-inventory', { handlesFci: false, categories: [], expectedUpdatedAt: null });
  assert(staleDi.status === 409 && staleDi.body?.code === 'stale_write' && staleDi.body?.current?.updatedAt === pi9.body?.updatedAt && !staleDi.text.includes('MARK'), 'PI9 the old stamp -> 409 stale_write with the current one', staleDi.body);
  const sameDi = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [row] }], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(sameDi.status === 200 && sameDi.body?.changed === false && sameDi.body?.updatedAt === pi9.body?.updatedAt, 'the same content with the current stamp -> changed false, the stamp stays');
  assert((await in1('PUT', '/data-inventory', { handlesFci: true, categories: [] })).body?.code === 'invalid_expected_updated_at' && (await in1('PUT', '/data-inventory', { categories: [], expectedUpdatedAt: pi9.body?.updatedAt })).status === 400, 'a missing expectedUpdatedAt -> 400 invalid_expected_updated_at; a missing handlesFci -> 400');
  const cleared = await in1('PUT', '/data-inventory', { handlesFci: false, categories: [], expectedUpdatedAt: pi9.body?.updatedAt });
  assert(cleared.status === 200 && cleared.body?.changed === true && cleared.body?.handlesFci === false && cleared.body?.categories.length === 0, 'a whole replace can clear the categories');
  const refill = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [row] }], expectedUpdatedAt: cleared.body?.updatedAt });
  assert(refill.status === 200 && (await in2('GET', '/data-inventory')).body?.updatedAt === null, 'the data inventory of P1 is invisible in P2');

  origLog('\n--- Roles and an archived program ---');
  const inV = pi(P1, viewer);
  assert((await inV('GET', '')).status === 200 && (await inV('GET', '/data-inventory')).status === 200 && (await inV('GET', '/events')).status === 200, 'PI10 a VIEWER can read the boundary, the data inventory and the history');
  assert((await inV('PUT', '/data-inventory', { handlesFci: true, categories: [], expectedUpdatedAt: refill.body?.updatedAt })).status === 403 && (await inV('PATCH', '/tools', { add: [B.id] })).status === 403 && (await inV('PUT', `/tools/${A.id}/controls`, { controls: [], expectedControlIds: [] })).status === 403 && (await inV('POST', '/vendor-documents', { vendorId: V.id, evidenceId: 'x', docKind: 'CRM' })).status === 403 && (await inV('DELETE', `/vendor-documents/${V.id}/x`)).status === 403, 'PI10 a VIEWER cannot write anything');
  const assessor = withRole('u_pi_assessor', T, 'ASSESSOR');
  assert((await pi(P1, assessor)('PATCH', '/tools', { add: [B.id] })).status === 403, 'an ASSESSOR cannot write either');
  const P3 = await mkProgram('PI Program 3 (archived)', 'CMMC_L1');
  assert((await call('POST', `/tenants/${T}/programs/${P3}/archive`, owner, T)).status === 200, 'P3 is archived');
  const in3 = pi(P3);
  const arch = await in3('PUT', '/data-inventory', { handlesFci: true, categories: [], expectedUpdatedAt: null });
  assert(arch.status === 409 && arch.body?.code === 'program_archived' && (await in3('PATCH', '/tools', { add: [A.id] })).body?.code === 'program_archived' && (await in3('GET', '')).status === 200, 'PI10 an archived program: writes -> 409 program_archived, reads stay possible', arch.body);
  assert((await pi('no-such-program')('GET', '')).status === 404 && (await pi(P1, rival, U)('GET', '')).status === 404, 'an unknown program, or a program of another tenant -> 404');

  origLog('\n--- Vendor documents ---');
  const control1 = l2.find((id) => id.startsWith('AC.')) as string;
  const upload = async (program: string, controlId: string, fileName: string) =>
    (await call('POST', '/evidence/upload-url', owner, T, { controlId, fileName, fileSize: 5, mimeType: 'text/plain', fileHash: sha256(fileName) }, program)).body?.evidenceId as string;
  const E1 = await upload(P1, control1, 'crm-file.txt');
  const E2 = await upload(P2, nistLow[0], 'other-program-file.txt');
  assert(Boolean(E1) && Boolean(E2), 'setup: an evidence record in P1 and one in P2', [E1, E2]);
  const doc = await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E1, docKind: 'CRM' });
  assert(doc.status === 201 && doc.body?.document?.vendorId === V.id && doc.body?.document?.evidenceId === E1 && doc.body?.document?.docKind === 'CRM' && doc.body?.changed === true, 'PI11 linking an evidence record of the program -> 201', doc.body);
  const docAgain = await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E1, docKind: 'CRM' });
  assert(docAgain.status === 200 && docAgain.body?.changed === false && docAgain.body?.document?.linkedAt === doc.body?.document?.linkedAt, 'PI11 the same link again -> 200 changed false');
  const docKind = await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E1, docKind: 'CONTRACT' });
  assert(docKind.status === 200 && docKind.body?.changed === true && docKind.body?.document?.docKind === 'CONTRACT', 'the same pair with another kind changes the kind -> 200 changed true');
  assert((await in1('GET', '')).body?.vendorDocuments.length === 1 && (await in1('GET', '')).body?.vendorDocuments[0].docKind === 'CONTRACT' && (await in2('GET', '')).body?.vendorDocuments.length === 0, 'the link is listed in P1 only');
  const wrongProgram = await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E2, docKind: 'CRM' });
  assert(wrongProgram.status === 404 && wrongProgram.body?.code === 'evidence_not_found', "PI11 an evidence id of another program -> 404 evidence_not_found", wrongProgram.body);
  assert((await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E1, docKind: 'XYZ' })).status === 400 && (await in1('POST', '/vendor-documents', { vendorId: 'no-such-vendor', evidenceId: E1, docKind: 'CRM' })).body?.code === 'vendor_not_found' && (await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: 'no-such-evidence', docKind: 'CRM' })).body?.code === 'evidence_not_found' && (await in1('POST', '/vendor-documents', { vendorId: V.id })).status === 400, 'PI11 an unknown kind or a missing field -> 400; an unknown vendor -> 404 vendor_not_found; an unknown evidence id -> 404');
  const unlink = await in1('DELETE', `/vendor-documents/${V.id}/${E1}`);
  assert(unlink.status === 200 && unlink.body?.removed === E1 && (await in1('DELETE', `/vendor-documents/${V.id}/${E1}`)).status === 404 && (await in1('GET', '')).body?.vendorDocuments.length === 0, 'PI11 DELETE removes the link (404 the second time); the evidence record stays');
  assert((await in1('GET', '')).status === 200 && (await call('GET', `/evidence`, owner, T, undefined, P1)).text.includes(E1), 'the evidence record itself is untouched');
  await in1('POST', '/vendor-documents', { vendorId: V.id, evidenceId: E1, docKind: 'CRM' });
  assert((await call('DELETE', `/tenants/${T}/inventory/vendors/${V.id}`, owner, T)).status === 200 && (await in1('GET', '')).body?.vendorDocuments.length === 0, 'deleting the vendor removes its document links in every program');

  origLog('\n--- History (ids, counts and flags only) ---');
  const events = (await in1('GET', '/events')).body?.events as Json[];
  const controlsChanged = events.filter((e) => e.action === 'controls_changed');
  const first = controlsChanged[controlsChanged.length - 1];
  assert(events.length > 0 && controlsChanged.length === 2 && JSON.stringify([...first.detail.added].sort()) === JSON.stringify(sorted) && first.entityId === A.id && first.detail.addedCount === 2, 'PI14 /events holds controls_changed with the added control ids (oldest: the two links of PI3)', controlsChanged);
  const actions = new Set(events.map((e) => e.action));
  assert(['tools_changed', 'controls_changed', 'data_inventory_changed', 'vendor_document_linked', 'vendor_document_unlinked'].every((a) => actions.has(a)) && events[0].createdAt >= events[events.length - 1].createdAt, 'the history has boundary, link, data-inventory and document events, newest first', [...actions]);
  const di = events.find((e) => e.action === 'data_inventory_changed');
  assert(di?.detail.categoryCount === 1 && di?.detail.toolRowCount === 1 && (typeof di?.detail.handlesFci === 'boolean') && !JSON.stringify(events).includes('MARK'), 'a data-inventory event holds counts and flags, and nothing in the history holds a name');
  const forced = events.find((e) => e.action === 'tools_changed' && e.detail.forced === true);
  assert(forced?.detail.linksRemoved === 2 && forced?.detail.removed.length === 1, 'the forced removal is recorded with its link count');
  assert((await in1('GET', '/events?limit=2')).body?.events.length === 2 && (await in2('GET', '/events')).body?.events.every((e: Json) => e.action === 'controls_changed'), 'the history can be limited; P2 sees only its own events');

  origLog('\n--- Deleting a tool, a program ---');
  assert((await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: si, evidenceSource: true }], expectedControlIds: [] })).status === 200, 'A is linked again in P1 (and is in its data inventory)');
  assert((await in1('GET', '/data-inventory')).body?.categories[0]?.tools.length === 1, 'and in the CUI tool rows');
  assert((await call('DELETE', `/tenants/${T}/inventory/tools/${A.id}`, owner, T)).status === 200, 'the tool is deleted from the register');
  const goneInv = await in1('GET', '');
  const goneDi = await in1('GET', '/data-inventory');
  assert(goneInv.body?.toolIds.length === 0 && goneInv.body?.controlLinks.length === 0 && goneDi.body?.categories.every((c: Json) => c.tools.length === 0), 'PI12 the tool leaves P1 with no links, no boundary row and no CUI tool row');
  const P4 = await mkProgram('PI Program 4', 'CMMC_L2');
  const in4 = pi(P4);
  await in4('PATCH', '/tools', { add: [B.id] });
  await in4('PUT', `/tools/${B.id}/controls`, { controls: [{ controlId: si, evidenceSource: false }], expectedControlIds: [] });
  await in4('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [{ toolId: B.id, stores: true, processes: true, transmits: false }] }], expectedUpdatedAt: null });
  assert(__programInventoryRowsForTests({ tenantId: T, programId: P4 }) >= 5, 'setup: P4 holds a boundary row, a link, a data inventory, a category and a tool row');
  const delProgram = await call('DELETE', `/tenants/${T}/programs/${P4}`, owner, T);
  assert(delProgram.status === 204 && (await in4('GET', '')).status === 404 && __programInventoryRowsForTests({ tenantId: T, programId: P4 }) === 0, 'PI13 deleting the program: its inventory GET is 404 and the store holds nothing for it', delProgram.status);
  assert((await in1('GET', '')).body?.programId === P1 && (await in2('GET', '')).body?.controlLinks.length === 1, 'the other programs are untouched');

  origLog('\n--- Logs ---');
  assert(captured.length > 0 && !captured.some((l) => l.includes('MARK')), 'PI15 no line the server logged contains a tool, vendor or category name (MARK)', captured.filter((l) => l.includes('MARK')));
  assert(!captured.some((l) => /crm-file|other-program-file/.test(l)), 'nor an evidence file name');
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
