import mammoth from 'mammoth';
import { makeDocx, makeDocxBody, wp, wpNum, wpRuns, wtbl } from './sspFixtures';
import { chunkDocument } from '../server/ssp/chunk';
import { mapDocumentToControls } from '../server/ssp/controlMapper';
import { diagnoseDocx } from '../server/ssp/docxDiagnostics';
import { extractWith } from '../server/ssp/extractCore';
import { getFrameworkControls } from '../src/data/frameworks';

/**
 * Rule-based SSP import recall (no Ollama): how a control's id is found in a .docx as Word really writes it (line breaks, tables,
 * status cells, label styles). Pure suite: no server, no database.
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

const L2 = getFrameworkControls('CMMC_L2');
const num = (id: string): string => id.match(/-(3\.\d+\.\d+)$/)![1];
const body = (c: { title: string }): string => `Implementation: ${c.title} is enforced by the IT lead and reviewed every quarter; evidence is kept in the ticket system.`;

async function run(docx: Buffer) {
  const { text } = await extractWith({ kind: 'docx', data: docx, maxPages: 0, maxChars: 5_000_000, maxZipEntries: 1000 });
  const chunks = chunkDocument(text, [], { refStyle: 'cmmc' });
  return { text, chunks, result: mapDocumentToControls(text, [], 'CMMC_L2', chunks) };
}

const allKind = (r: Awaited<ReturnType<typeof run>>['result'], kind: string): boolean => r.staged.length === L2.length && r.staged.every((s) => s.matchKind === kind);
const rawText = async (docx: Buffer): Promise<string> => (await mammoth.extractRawText({ buffer: docx })).value.replace(/\r\n/g, '\n').trim();

async function main() {
  console.log('--- A: ids typed in paragraphs, tables, sentences ---');
  assert(L2.length === 110, 'the CMMC L2 catalog has 110 controls', L2.length);
  const a1Docx = await makeDocxBody(L2.map((c) => wp(`${c.id} ${c.title}`) + wp(body(c))).join(''));
  const a1 = await run(a1Docx);
  assert(allKind(a1.result, 'CMMC_ID_SECTION') && a1.result.coverage.missing.length === 0, 'A1: "id title" paragraphs: all 110 are CMMC_ID_SECTION, none missing', { staged: a1.result.staged.length, missing: a1.result.coverage.missing.length });
  const a2 = await run(await makeDocxBody(L2.map((c) => wp(`${c.id} – ${c.title}`) + wp(body(c))).join('')));
  assert(allKind(a2.result, 'CMMC_ID_SECTION') && a2.result.coverage.missing.length === 0, 'A2: "id – title" (en dash): all 110 found');
  const a3 = await run(await makeDocxBody(L2.map((c) => wp(`${num(c.id)} ${c.plainEnglishSummary || c.title}`) + wp(body(c))).join('')));
  assert(allKind(a3.result, 'NIST_NUMBER_SECTION'), 'A3: "3.x.y summary" paragraphs: all 110 are NIST_NUMBER_SECTION', { staged: a3.result.staged.length });

  const rows = (status: string) => L2.map((c) => [c.id, c.title, status, body(c)]);
  const tableDocx = (status: string) => makeDocxBody(wtbl([['Control', 'Title', 'Status', 'Implementation Statement'], ...rows(status)]));
  const a4Docx = await tableDocx('Implemented');
  const a4 = await run(a4Docx);
  const notesOk = (r: Awaited<ReturnType<typeof run>>['result']): boolean => L2.every((c) => r.staged.find((s) => s.controlId === c.id)?.suggestedNotes.includes(body(c)));
  assert(a4.result.staged.length === 110 && a4.result.coverage.missing.length === 0 && notesOk(a4.result), 'A4: a 110-row table: all found, each with its statement as notes', { staged: a4.result.staged.length });

  const five = ['AC.L2-3.1.10', 'AC.L2-3.1.5', 'IA.L2-3.5.3', 'SC.L2-3.13.1', 'AU.L2-3.3.1'];
  const a5 = await run(await makeDocxBody(wp('General') + five.map((id) => wp(`Account handling is also covered elsewhere (see ${id}) in the plan.`)).join('')));
  assert(a5.result.staged.length === 5 && a5.result.staged.every((s) => s.matchKind === 'MENTION' && s.confidence === 0.3) && a5.result.coverage.missing.length === 105, 'A5: five inline "(see id)" sentences stay MENTION at 0.3, 105 missing', { staged: a5.result.staged.length, missing: a5.result.coverage.missing.length });

  console.log('--- B: line breaks and page breaks ---');
  const b1 = await run(await makeDocxBody(wpRuns([L2[0].id, L2[0].title], 'br')));
  assert(b1.text.includes(`${L2[0].id}\n${L2[0].title}`), 'B1: a <w:br/> between runs becomes a newline', b1.text);
  const b2Docx = await makeDocxBody(L2.map((c) => wpRuns([c.id, c.title], 'br') + wp(body(c))).join(''));
  const b2 = await run(b2Docx);
  assert(allKind(b2.result, 'CMMC_ID_SECTION'), 'B2: "id<br>title" for every control: all 110 are CMMC_ID_SECTION', { staged: b2.result.staged.length });
  assert(a1.text === (await rawText(a1Docx)) && a4.text === (await rawText(a4Docx)), 'B3: a docx without line breaks extracts byte-identically to mammoth.extractRawText');
  const b4 = await run(await makeDocxBody(wpRuns(['3.1.1 Limit access', 'Body'], 'page')));
  assert(b4.text.includes('3.1.1 Limit access\nBody'), 'B4: a page break becomes a newline', b4.text);

  console.log('--- C: status cells and headings ---');
  const c1 = await run(await tableDocx('IMPLEMENTED'));
  assert(c1.result.staged.length === 110 && notesOk(c1.result), 'C1: an ALL-CAPS status cell does not cut the section (statement kept in notes)', { staged: c1.result.staged.length });
  const c2 = chunkDocument('Intro\nINCIDENT RESPONSE\nText');
  assert(c2.map((c) => c.heading).join('|') === 'Intro|INCIDENT RESPONSE', 'C2: a real ALL-CAPS heading still starts a section', c2.map((c) => c.heading));
  const c3 = chunkDocument('AC.L2-3.1.5 Least\nNOT APPLICABLE\nBody');
  assert(c3.length === 1, 'C3: "NOT APPLICABLE" does not start a section', c3.map((c) => c.heading));

  console.log('--- D: label styles ---');
  const formats: Array<[string, (c: (typeof L2)[number]) => string]> = [
    ['Control ID: n', (c) => `Control ID: ${num(c.id)}`],
    ['Security Requirement n', (c) => `Security Requirement ${num(c.id)}`],
    ['FAM-n title', (c) => `${c.id.slice(0, 2)}-${num(c.id)} ${c.title}`],
    ['FAM.L2 n title', (c) => `${c.id.slice(0, 2)}.L2 ${num(c.id)} ${c.title}`],
    ['NIST SP 800-171 Rev. 2 n', (c) => `NIST SP 800-171 Rev. 2 ${num(c.id)}`],
    ['bullet n title', (c) => `▪ ${num(c.id)} ${c.title}`],
  ];
  for (const [name, f] of formats) {
    const d = await run(await makeDocxBody(L2.map((c) => wp(f(c)) + wp(body(c))).join('')));
    assert(allKind(d.result, 'NIST_NUMBER_SECTION'), `D1: "${name}" : all 110 are NIST_NUMBER_SECTION`, { staged: d.result.staged.length, kinds: [...new Set(d.result.staged.map((s) => s.matchKind))] });
  }
  const d2 = mapDocumentToControls('Intro\nAccess Control 3.1.1 is described in the policy.\nEnd', [], 'CMMC_L2');
  assert(d2.staged.length === 1 && d2.staged[0].matchKind === 'MENTION', 'D2: a prose sentence naming a family and a number stays a MENTION', d2.staged.map((s) => s.matchKind));

  console.log('--- Diagnostics (counts only) ---');
  const dg = await diagnoseDocx(b2Docx);
  assert(dg.lineBreaks === 110 && dg.numberedParagraphs === 0, 'diagnose: 110 line breaks, no numbered paragraphs', dg);
  const dg2 = await diagnoseDocx(await makeDocx(['AC.L2-3.1.5 Least Privilege', 'text']));
  assert(dg2.cmmcIds === 1 && dg2.gluedIds === 0, 'diagnose: one CMMC id, none glued', dg2);
  const dg3 = await diagnoseDocx(await makeDocxBody(wp('AC.2.005 Least') + wpNum('Numbered', 0)));
  assert(dg3.v1Ids === 1 && dg3.numberedParagraphs === 1, 'diagnose: a v1 id and a numbered paragraph are counted', dg3);
  assert(Object.values(dg).every((v) => typeof v === 'number'), 'diagnose: every value is a count');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('suite crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
