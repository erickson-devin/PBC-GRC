import './testEnv';
import { SSP_TEST_VAULT } from './sspEnv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { server } from '../server/index';
import { chunkDocument } from '../server/ssp/chunk';
import { mapDocumentToControls } from '../server/ssp/controlMapper';
import { detectDocumentKind, extractDocument, ExtractionError } from '../server/ssp/extract';
import { getFrameworkControls } from '../src/data/frameworks';

/**
 * SSP import, Phase 1: upload, extraction, chunking, regex control mapping, the staging area, and the review/commit rules.
 * The rule this suite exists to protect: an import NEVER changes a tenant's control answers by itself.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
process.env.PLATFORM_ADMIN_EMAILS = 'u_ssp_owner2@test.mil';

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

// ------------------------------------------------------------------------------------------------ fixtures

const SSP_LINES = [
  'System Security Plan - Acme Defense LLC',
  '1. ACCESS CONTROL',
  'AC.L1-3.1.1 Authorized Access Control',
  'Access to systems is limited to authorized users with MFA, and accounts are reviewed quarterly by the IT lead.',
  '3.1.2 Limit User Function Access',
  'Users are limited to the functions their role permits through RBAC groups. Quarterly access reviews are documented by the IT lead.',
  '2. IDENTIFICATION',
  'IA.L1-3.5.1 Identify Users',
  'Every user has a unique account in the directory and shared accounts are prohibited by policy and technical control.',
  'See also AC.L2-3.1.5 for least privilege.',
];

const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
/** A minimal valid PDF; each inner array is one page, one string per line. */
function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const n = pages.length;
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  objs.push(`<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}]/Count ${n}>>`);
  pages.forEach((lines, i) => {
    const content = `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${3 + n * 2} 0 R>>>>>>`);
    objs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  });
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\n%%EOF`);
}

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${xmlEsc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ------------------------------------------------------------------------------------------------ http helpers

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;

async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

async function upload(token: string | null, tenant: string, file: { data: Buffer; name: string; type?: string } | null, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type ?? 'application/octet-stream' }), file.name);
  const headers: Record<string, string> = { 'x-tenant-id': tenant };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/tenants/${tenant}/ssp-imports`, { method: 'POST', headers, body: form });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

async function waitReady(token: string, tenant: string, jobId: string): Promise<Json> {
  for (let i = 0; i < 100; i++) {
    const job = (await call('GET', `/tenants/${tenant}/ssp-imports/${jobId}`, token, tenant)).body?.job as Json;
    if (job && ['READY_FOR_REVIEW', 'FAILED', 'COMMITTED'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
}

const controlOf = async (token: string, tenant: string, id: string, framework = 'CMMC_L1') =>
  ((await call('GET', `/controls?framework=${framework}`, token, tenant)).body?.controls as Json[]).find((c) => c.id === id) as Json;

// ------------------------------------------------------------------------------------------------ tests

function unitTests() {
  console.log('--- Chunking ---');
  const text = SSP_LINES.join('\n');
  const chunks = chunkDocument(text);
  assert(chunks.every((c) => text.slice(c.start, c.end) === c.text), 'every chunk is exactly text[start..end] of the source');
  assert(chunks.map((c) => c.heading).join('|') === 'System Security Plan - Acme Defense LLC|1. ACCESS CONTROL|AC.L1-3.1.1 Authorized Access Control|3.1.2 Limit User Function Access|2. IDENTIFICATION|IA.L1-3.5.1 Identify Users', 'sections start at headings and control anchors; a sentence that only refers to a control is not one', chunks.map((c) => c.heading));
  const mid = chunkDocument('Overview\nBoundary protection is covered by 3.13.1 in the diagram.\nMore text.');
  assert(mid.length === 1 && mid[0].heading === 'Overview', 'a number in the middle of a sentence does not start a section');
  const dashed = chunkDocument('Plan\nAC.L1‑3.1.1 – Access\nText here.');
  assert(dashed.length === 2 && dashed[1].heading.startsWith('AC.L1'), 'typographic dashes in an identifier are still recognised', dashed.map((c) => c.heading));
  const pages = [{ page: 1, start: 0, end: 60 }, { page: 2, start: 61, end: text.length }];
  const paged = chunkDocument(text, pages);
  assert(paged[0].page === 1 && paged[paged.length - 1].page === 2, 'chunks carry the page they start on');
  const long = chunkDocument('3.1.1 Access\n' + ('Sentence about access. '.repeat(30) + '\n\n').repeat(6), [], { maxChars: 700 });
  assert(long.length > 3 && long.every((c) => c.text.length <= 700) && long.every((c) => c.heading === '3.1.1 Access'), 'an oversized section is split into pieces that keep its heading', long.map((c) => c.text.length));

  console.log('\n--- Regex control mapping ---');
  const l1 = mapDocumentToControls(text, [], 'CMMC_L1');
  const byId = new Map(l1.staged.map((s) => [s.controlId, s]));
  assert(l1.staged.length === 3 && ['AC.L1-3.1.1', 'AC.L1-3.1.2', 'IA.L1-3.5.1'].every((id) => byId.has(id)), 'finds the three described practices', l1.staged.map((s) => s.controlId));
  assert(byId.get('AC.L1-3.1.1')?.matchKind === 'CMMC_ID_SECTION' && byId.get('AC.L1-3.1.2')?.matchKind === 'NIST_NUMBER_SECTION', 'a CMMC identifier and a bare number are told apart');
  assert(byId.get('AC.L1-3.1.1')!.suggestedNotes.startsWith('Access to systems is limited'), 'the suggested notes are the section text without the label or title');
  assert(byId.get('AC.L1-3.1.1')!.confidence > byId.get('AC.L1-3.1.2')!.confidence, 'an explicit identifier is more confident than a bare number');
  assert(l1.staged.every((s) => s.sourceQuotes.length > 0 && s.sourceQuotes.every((q) => q.verified && text.slice(q.start, q.end) === q.quote)), 'every suggestion carries a source quote that is verbatim from the document');
  assert(!byId.get('AC.L1-3.1.1')!.sourceQuotes[0].quote.includes('3.1.2'), 'a source quote stops at the end of its section');
  assert(l1.unmapped.some((u) => u.reference === 'AC.L2-3.1.5' && u.reason === 'OUT_OF_SCOPE'), 'a practice of another level is reported as out of scope, not staged');
  assert(l1.coverage.totalControls === 17 && l1.coverage.foundControls === 3 && l1.coverage.missing.length === 14 && !l1.coverage.missing.includes('IA.L1-3.5.1'), 'coverage lists the in-scope practices the document never mentions');
  assert(l1.staged.every((s) => s.gapAnalysis.source === 'heuristic'), 'Phase 1 findings are labelled as simple automated checks');

  const l2 = mapDocumentToControls(text, [], 'CMMC_L2');
  assert(l2.coverage.totalControls === 110 && l2.staged.length === 4 && l2.staged.find((s) => s.controlId === 'AC.L2-3.1.5')?.matchKind === 'MENTION' && !l2.unmapped.some((u) => u.reference === 'AC.L2-3.1.5'), 'the same document mapped to Level 2 sees 110 practices, and AC.L2-3.1.5 is now in scope (a mention)');
  assert(JSON.stringify(mapDocumentToControls(text, [], 'CMMC_L2')) === JSON.stringify(l2), 'mapping is deterministic');
  const l2ids = new Set(getFrameworkControls('CMMC_L2').map((c) => c.id));
  assert(l2.staged.every((s) => l2ids.has(s.controlId)), 'only real catalog control ids are ever staged');

  const mention = mapDocumentToControls('Intro\nThe boundary is described under AC.L1-3.1.20 in the appendix diagram.\nEnd', [], 'CMMC_L1');
  assert(mention.staged.length === 1 && mention.staged[0].matchKind === 'MENTION' && mention.staged[0].gapAnalysis.gaps[0]?.missingElement === 'Implementation description', 'a reference with no section of its own is a mention with a gap');
  const none = mapDocumentToControls('Nothing relevant here at all, only prose.', [], 'CMMC_L1');
  assert(none.staged.length === 0 && none.coverage.foundControls === 0 && none.coverage.missing.length === 17, 'a document that names no control stages nothing');
  const fake = mapDocumentToControls('Plan\nAC.L2-3.1.99 Imaginary Practice\nSome text.', [], 'CMMC_L2');
  assert(fake.staged.length === 0 && fake.unmapped[0]?.reason === 'NOT_IN_CATALOG', 'an identifier that is not in the catalog is reported, never staged');
}

async function extractionTests() {
  console.log('\n--- Extraction ---');
  const pdf = makePdf([SSP_LINES.slice(0, 5), SSP_LINES.slice(5)]);
  const docx = await makeDocx(SSP_LINES);
  assert((await detectDocumentKind(pdf))?.kind === 'pdf' && (await detectDocumentKind(docx))?.kind === 'docx', 'PDF and DOCX are recognised from their bytes');
  assert((await detectDocumentKind(Buffer.from('just text, named .pdf')) ) === null && (await detectDocumentKind(Buffer.from('MZ\x90\x00\x03'))) === null, 'anything else (text, executables) is refused');
  const fromPdf = await extractDocument(pdf, 'pdf');
  assert(fromPdf.pageCount === 2 && fromPdf.pages.length === 2 && fromPdf.text.includes('AC.L1-3.1.1 Authorized Access Control'), 'a PDF yields its text and page spans', fromPdf.text.slice(0, 80));
  const mappedPdf = mapDocumentToControls(fromPdf.text, fromPdf.pages, 'CMMC_L1');
  assert(mappedPdf.staged.length === 3 && mappedPdf.staged.some((s) => s.sourceQuotes[0]?.page === 2), 'mapping a PDF works and records page numbers', mappedPdf.staged.map((s) => s.controlId + '@' + s.sourceQuotes[0]?.page));
  const fromDocx = await extractDocument(docx, 'docx');
  assert(fromDocx.text.includes('3.1.2 Limit User Function Access') && fromDocx.pageCount === 0, 'a DOCX yields its text');
  assert(mapDocumentToControls(fromDocx.text, [], 'CMMC_L1').staged.length === 3, 'mapping a DOCX works');
  const blank = await extractDocument(makePdf([['', '']]), 'pdf').then(() => null, (e) => e);
  assert(blank instanceof ExtractionError && blank.code === 'no_text', 'a PDF with no text layer (a scan) is reported as needing OCR', blank?.message);
  const corrupt = await extractDocument(Buffer.from('%PDF-1.4\nthis is not a pdf'), 'pdf').then(() => null, (e) => e);
  assert(corrupt instanceof ExtractionError, 'a corrupt PDF fails cleanly instead of crashing the server', corrupt?.code);
  const notZip = await extractDocument(Buffer.from('PK\x03\x04garbage'), 'docx').then(() => null, (e) => e);
  assert(notZip instanceof ExtractionError, 'a corrupt DOCX fails cleanly', notZip?.code);
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_ssp_owner');
  const assessor = person('u_ssp_assessor');
  const viewer = person('u_ssp_viewer');
  const stranger = person('u_ssp_stranger');
  const l2owner = person('u_ssp_owner2'); // a platform administrator (see PLATFORM_ADMIN_EMAILS above)

  const tenant = (await call('POST', '/tenants', owner, undefined, { name: 'SSP Org' })).body?.tenant?.id as string;
  for (const [tok, role, sub] of [[assessor, 'ASSESSOR', 'u_ssp_assessor'], [viewer, 'VIEWER', 'u_ssp_viewer']] as const) {
    await call('POST', `/tenants/${tenant}/members`, owner, tenant, { userId: sub, email: `${sub}@test.mil`, role });
    void tok;
  }
  const otherTenant = (await call('POST', '/tenants', stranger, undefined, { name: 'Other Org' })).body?.tenant?.id as string;
  const l2tenant = (await call('POST', '/tenants', l2owner, undefined, { name: 'L2 Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  const root = (t: string) => `/tenants/${t}/ssp-imports`;

  console.log('\n--- Access and capabilities ---');
  const capOwner = await call('GET', `${root(tenant)}/capabilities`, owner, tenant);
  assert(capOwner.status === 200 && capOwner.body?.canUpload === true && capOwner.body?.canCommit === true && capOwner.body?.ai === false, 'an owner can upload and commit; the analyzer is not AI in Phase 1', capOwner.body);
  assert(JSON.stringify(capOwner.body?.frameworks) === '["CMMC_L1"]', 'a Level 1 tenant is offered Level 1 only');
  assert(JSON.stringify((await call('GET', `${root(l2tenant)}/capabilities`, l2owner, l2tenant)).body?.frameworks) === '["CMMC_L1","CMMC_L2"]', 'a Level 2 tenant is offered both');
  const capAssessor = await call('GET', `${root(tenant)}/capabilities`, assessor, tenant);
  assert(capAssessor.status === 200 && capAssessor.body?.canUpload === false && capAssessor.body?.canCommit === false, 'an assessor can look but not upload or commit');
  assert((await call('GET', root(tenant), viewer, tenant)).status === 403, 'a viewer sees nothing of the imports (403)');
  assert((await call('GET', root(tenant), null, tenant)).status === 401, 'no session: 401');
  assert((await call('GET', root(tenant), stranger, tenant)).status === 403, 'a person from another tenant is refused (403)');

  console.log('\n--- Upload hardening ---');
  const pdf = makePdf([SSP_LINES.slice(0, 5), SSP_LINES.slice(5)]);
  assert((await upload(owner, tenant, null, { framework: 'CMMC_L1' })).status === 400, 'no file: 400');
  assert((await upload(owner, tenant, { data: pdf, name: 'ssp.pdf' }, {})).status === 400, 'no framework: 400');
  assert((await upload(owner, tenant, { data: pdf, name: 'ssp.pdf' }, { framework: 'NIST_800_53_REV5' })).status === 400, 'a framework other than CMMC L1 / L2: 400 (Phase 1 scope)');
  const notEnabled = await upload(owner, tenant, { data: pdf, name: 'ssp.pdf' }, { framework: 'CMMC_L2' });
  assert(notEnabled.status === 403 && notEnabled.body?.code === 'framework_not_enabled', 'a framework outside the tenant\'s program is refused (403)', notEnabled.body);
  const disguised = await upload(owner, tenant, { data: Buffer.from('MZ not really a document'), name: 'ssp.pdf', type: 'application/pdf' }, { framework: 'CMMC_L1' });
  assert(disguised.status === 415, 'a file named .pdf that is not a PDF is refused by its content (415)');
  assert((await upload(assessor, tenant, { data: pdf, name: 'ssp.pdf' }, { framework: 'CMMC_L1' })).status === 403, 'an assessor cannot upload (403)');
  assert((await upload(viewer, tenant, { data: pdf, name: 'ssp.pdf' }, { framework: 'CMMC_L1' })).status === 403, 'a viewer cannot upload (403)');
  const huge = await upload(owner, tenant, { data: Buffer.alloc(51 * 1024 * 1024, 1), name: 'big.pdf' }, { framework: 'CMMC_L1' });
  assert(huge.status === 413, 'a file over 50 MB is refused (413)', huge.status);
  assert(((await call('GET', root(tenant), owner, tenant)).body?.jobs ?? []).length === 0, 'none of the refused uploads left a job behind');

  console.log('\n--- A PDF end to end ---');
  const up = await upload(owner, tenant, { data: pdf, name: '../../etc/My SSP.pdf', type: 'application/pdf' }, { framework: 'CMMC_L1' });
  assert(up.status === 202 && /^sspj_/.test(up.body?.job?.id), 'an upload is accepted (202) and becomes a job', up.body);
  const jobId = up.body?.job?.id as string;
  assert(up.body?.job?.fileName === 'My SSP.pdf', 'the file name is reduced to its base name (no path)', up.body?.job?.fileName);
  assert(up.body?.job?.fileSha256 === crypto.createHash('sha256').update(pdf).digest('hex'), 'the SHA-256 of the document is recorded');
  const job = await waitReady(owner, tenant, jobId);
  assert(job.status === 'READY_FOR_REVIEW' && job.pageCount === 2 && job.chunkCount > 0 && job.coverage?.foundControls === 3, 'processing ends READY_FOR_REVIEW with page, section and coverage figures', job);

  const vaultDir = path.join(SSP_TEST_VAULT, 'tenants', tenant, 'policies', 'uploaded');
  const kept = fs.existsSync(vaultDir) ? fs.readdirSync(vaultDir) : [];
  assert(kept.length === 1 && kept[0].startsWith(jobId) && fs.readFileSync(path.join(vaultDir, kept[0])).equals(pdf), 'the original is kept in the evidence vault under policies/uploaded, byte for byte', kept);
  const download = await fetch(`${BASE}${root(tenant)}/${jobId}/file`, { headers: { Authorization: `Bearer ${assessor}`, 'x-tenant-id': tenant } });
  assert(download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(pdf), 'an assessor can download the stored document');

  const staged = (await call('GET', `${root(tenant)}/${jobId}/staged`, assessor, tenant)).body as Json;
  const items = staged.staged as Json[];
  assert(items.length === 3 && items.every((i) => i.reviewState === 'PENDING'), 'an assessor can read the three suggestions, all PENDING');
  assert(items.every((i) => i.current === null || i.current.notes === ''), 'each is shown next to the control\'s current answer (none yet)');
  assert(items.every((i) => i.framework === 'CMMC_L1' && /\.L1-/.test(i.controlId)), 'only controls of the requested framework are staged');

  console.log('\n--- An import never changes the controls by itself ---');
  const target = items.find((i) => i.controlId === 'AC.L1-3.1.1') as Json;
  const other = items.find((i) => i.controlId === 'IA.L1-3.5.1') as Json;
  const keep = items.find((i) => i.controlId === 'AC.L1-3.1.2') as Json;
  await call('PUT', '/controls/AC.L1-3.1.1', owner, tenant, { status: 'IN_PROGRESS', implementationNotes: 'ORIGINAL NOTES', responsibleRole: 'CISO' });
  const before = await controlOf(owner, tenant, 'AC.L1-3.1.1');
  assert(before.implementationNotes === 'ORIGINAL NOTES', 'setup: the control has its own answer');
  assert((await controlOf(owner, tenant, 'IA.L1-3.5.1')).implementationNotes === '', 'setup: an unrelated control is empty');
  const reread = (await call('GET', `${root(tenant)}/${jobId}/staged`, owner, tenant)).body?.staged as Json[];
  assert(reread.find((i) => i.controlId === 'AC.L1-3.1.1')?.current?.notes === 'ORIGINAL NOTES' && reread.find((i) => i.controlId === 'AC.L1-3.1.1')?.changedSinceStaged === true, 'the review shows the current answer and flags that it changed since staging');

  const stagedPath = (id: string) => `${root(tenant)}/${jobId}/staged/${id}`;
  assert((await call('PATCH', stagedPath(target.id), assessor, tenant, { reviewState: 'ACCEPTED' })).status === 403, 'an assessor cannot accept a suggestion (403)');
  assert((await call('POST', `${root(tenant)}/${jobId}/commit`, assessor, tenant, {})).status === 403, 'an assessor cannot commit (403)');
  assert((await call('DELETE', `${root(tenant)}/${jobId}`, assessor, tenant)).status === 403, 'an assessor cannot delete an import (403)');
  assert((await controlOf(owner, tenant, 'AC.L1-3.1.1')).implementationNotes === 'ORIGINAL NOTES', 'refused attempts changed nothing');

  assert((await call('PATCH', stagedPath(target.id), owner, tenant, { reviewState: 'MAYBE' })).status === 400, 'an unknown review state: 400');
  assert((await call('PATCH', stagedPath(target.id), owner, tenant, { reviewState: 'COMMITTED' })).status === 400, 'COMMITTED cannot be set by a reviewer: 400');
  assert((await call('PATCH', stagedPath(target.id), owner, tenant, { reviewState: 'EDITED', editedNotes: '   ' })).status === 400, 'an edited suggestion needs text: 400');
  assert((await call('PATCH', stagedPath('stg_nope'), owner, tenant, { reviewState: 'ACCEPTED' })).status === 404, 'an unknown suggestion: 404');

  const accepted = await call('PATCH', stagedPath(other.id), owner, tenant, { reviewState: 'ACCEPTED' });
  assert(accepted.status === 200 && accepted.body?.staged?.reviewState === 'ACCEPTED' && accepted.body.staged.reviewedBy === 'u_ssp_owner', 'an owner accepts a suggestion (recorded with who)');
  assert((await controlOf(owner, tenant, 'IA.L1-3.5.1')).implementationNotes === '', 'accepting alone changes nothing: the control is untouched until commit');
  const edited = await call('PATCH', stagedPath(target.id), owner, tenant, { reviewState: 'ACCEPTED', editedNotes: 'EDITED BY REVIEWER' });
  assert(edited.body?.staged?.reviewState === 'EDITED' && edited.body.staged.editedNotes === 'EDITED BY REVIEWER', 'accepting with different text makes it an edit');
  assert((await call('PATCH', stagedPath(keep.id), owner, tenant, { reviewState: 'REJECTED' })).body?.staged?.reviewState === 'REJECTED', 'a suggestion can be rejected');

  console.log('\n--- Conflict detection ---');
  // someone changes the control after it was staged and while it is awaiting commit... first make it differ from the snapshot
  const commit1 = await call('POST', `${root(tenant)}/${jobId}/commit`, owner, tenant, {});
  assert(commit1.status === 200 && commit1.body?.conflicts.length === 1 && commit1.body.conflicts[0] === target.id, 'a control changed after staging is NOT overwritten: it becomes a conflict', commit1.body);
  assert(commit1.body?.committed.length === 1 && commit1.body.committed[0] === other.id, 'the unchanged control was committed in the same call');
  const afterConflict = await controlOf(owner, tenant, 'AC.L1-3.1.1');
  assert(afterConflict.implementationNotes === 'ORIGINAL NOTES' && afterConflict.status === 'IN_PROGRESS', 'the conflicting control keeps its own notes and status');
  const committed = await controlOf(owner, tenant, 'IA.L1-3.5.1');
  assert(committed.implementationNotes.startsWith('Every user has a unique account') && committed.status === 'NOT_STARTED', 'the committed control got the suggested notes and its status was NOT changed');
  assert(String(committed.updatedBy).includes('My SSP.pdf') && String(committed.updatedBy).includes('u_ssp_owner'), 'the update is attributed to the import and the reviewer', committed.updatedBy);
  assert((await controlOf(owner, tenant, 'AC.L1-3.1.2')).implementationNotes === '', 'the rejected suggestion was not written');
  const state = (await call('GET', `${root(tenant)}/${jobId}/staged`, owner, tenant)).body?.staged as Json[];
  assert(state.find((i) => i.id === other.id)?.reviewState === 'COMMITTED' && state.find((i) => i.id === target.id)?.reviewState === 'CONFLICT', 'states are recorded: COMMITTED and CONFLICT');
  assert((await call('PATCH', stagedPath(other.id), owner, tenant, { reviewState: 'REJECTED' })).status === 409, 'a committed suggestion cannot be changed (409)');

  const reopened = await call('PATCH', stagedPath(target.id), owner, tenant, { reviewState: 'EDITED', editedNotes: 'EDITED BY REVIEWER' });
  assert(reopened.body?.staged?.reviewState === 'EDITED', 'a conflicting suggestion can be reviewed again against the control as it is now');
  const commit2 = await call('POST', `${root(tenant)}/${jobId}/commit`, owner, tenant, {});
  assert(commit2.body?.committed.length === 1 && commit2.body.conflicts.length === 0, 're-reviewed, it commits');
  const final = await controlOf(owner, tenant, 'AC.L1-3.1.1');
  assert(final.implementationNotes === 'EDITED BY REVIEWER' && final.status === 'IN_PROGRESS' && final.responsibleRole === 'CISO', 'the edited text was written; status and responsible role were preserved');
  const done = (await call('GET', `${root(tenant)}/${jobId}`, owner, tenant)).body?.job as Json;
  assert(done.status === 'COMMITTED', 'once every suggestion is committed or rejected the import is COMMITTED');
  assert((await call('POST', `${root(tenant)}/${jobId}/commit`, owner, tenant, {})).status === 409 && (await call('PATCH', stagedPath(keep.id), owner, tenant, { reviewState: 'ACCEPTED' })).status === 409, 'a finished import is closed to further review and commits (409)');
  assert((await controlOf(owner, tenant, 'AC.L1-3.1.2')).implementationNotes === '', 'and the rejected suggestion never reached the control');

  console.log('\n--- Isolation ---');
  assert((await call('GET', `${root(otherTenant)}/${jobId}`, stranger, otherTenant)).status === 404, 'another tenant cannot see this import (404)');
  assert((await call('GET', `${root(otherTenant)}/${jobId}/staged`, stranger, otherTenant)).status === 404, '... nor its suggestions (404)');
  assert((await call('GET', `${root(tenant)}/${jobId}`, stranger, otherTenant)).status === 403, 'using the tenant id in the URL against your own tenant header is refused (403)');
  assert(((await call('GET', root(otherTenant), stranger, otherTenant)).body?.jobs ?? []).length === 0, 'the other tenant\'s list is empty');

  console.log('\n--- Level 2, DOCX, and deleting ---');
  const docx = await makeDocx(SSP_LINES);
  const up2 = await upload(l2owner, l2tenant, { data: docx, name: 'plan.docx' }, { framework: 'CMMC_L2' });
  const job2 = await waitReady(l2owner, l2tenant, up2.body?.job?.id);
  assert(up2.status === 202 && job2.status === 'READY_FOR_REVIEW' && job2.coverage?.totalControls === 110 && job2.coverage?.foundControls === 4, 'a DOCX mapped to Level 2 is checked against 110 practices', job2.coverage);
  const l1on2 = await upload(l2owner, l2tenant, { data: docx, name: 'plan.docx' }, { framework: 'CMMC_L1' });
  assert(l1on2.status === 202, 'a Level 2 tenant may also import against Level 1');
  await waitReady(l2owner, l2tenant, l1on2.body?.job?.id);

  const del = await call('DELETE', `${root(tenant)}/${jobId}`, owner, tenant);
  assert(del.status === 204 && (await call('GET', `${root(tenant)}/${jobId}`, owner, tenant)).status === 404, 'deleting an import removes it (204)');
  assert(!fs.existsSync(vaultDir) || fs.readdirSync(vaultDir).length === 0, 'and removes its stored document');
  assert((await controlOf(owner, tenant, 'IA.L1-3.5.1')).implementationNotes.startsWith('Every user'), 'committed control answers are not undone by deleting the import');

  const failed = await upload(owner, tenant, { data: makePdf([['', '']]), name: 'scan.pdf' }, { framework: 'CMMC_L1' });
  const failedJob = await waitReady(owner, tenant, failed.body?.job?.id);
  assert(failedJob.status === 'FAILED' && /OCR|No text/i.test(failedJob.error), 'a scanned PDF fails with a clear reason', failedJob.error);
  assert((await call('PATCH', `${root(tenant)}/${failedJob.id}/staged/x`, owner, tenant, { reviewState: 'ACCEPTED' })).status === 409, 'a failed import is not open for review (409)');
}

async function run() {
  unitTests();
  await extractionTests();
  await apiTests();
}

run()
  .catch((e) => {
    console.error('TEST CRASHED:', e);
    total++;
  })
  .finally(() => {
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    server.closeAllConnections();
    server.close();
    fs.rmSync(SSP_TEST_VAULT, { recursive: true, force: true });
    process.exit(passed === total ? 0 : 1);
  });
