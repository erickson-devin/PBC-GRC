import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMarkdownBlocks, parseInline, Block } from '../src/utils/markdownBlocks';
import { MarkdownPreview } from '../src/components/common/MarkdownPreview';
import { generatePolicyDocument } from '../src/data/reports/policyDocumentGenerator';
import type { Tenant } from '../src/types/tenant';

/** The Markdown reader behind the policy previews, the preview component rendered on the server, and the source of the views that use it. */
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

const render = (markdown: string, headingOffset = 0) =>
  renderToStaticMarkup(React.createElement(MarkdownPreview, { markdown, headingOffset }));
const source = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

// Headings and paragraphs
const b1 = parseMarkdownBlocks('## 1. Purpose\nBody text');
assert(b1.length === 2 && b1[0].t === 'heading' && b1[0].level === 2 && JSON.stringify(b1[0].c) === JSON.stringify([{ t: 'text', v: '1. Purpose' }]) && b1[1].t === 'paragraph', 'a heading is its own block even without a blank line after it', b1);

const b2 = parseMarkdownBlocks('**Organization:** Acme\n**System Name:** X');
assert(b2.length === 1 && b2[0].t === 'paragraph' && b2[0].lines.length === 2 && b2[0].lines.every((l) => l[0].t === 'strong'), 'two metadata lines are one paragraph of two lines, each starting bold', b2);

// Inline
const i1 = parseInline('*Requirement Summary*: y');
assert(i1.length === 2 && i1[0].t === 'em' && i1[1].t === 'text' && (i1[1] as { v: string }).v === ': y', 'an italic span followed by text', i1);
const i2 = parseInline('a `**x**` b');
assert(i2.length === 3 && i2[1].t === 'code' && (i2[1] as { v: string }).v === '**x**' && !i2.some((n) => n.t === 'strong'), 'bold markers inside code stay literal', i2);
const i3 = parseInline('**Signature:** ____  **Date:** ____');
assert(i3.filter((n) => n.t === 'strong').length === 2 && JSON.stringify(i3).includes('____') && !i3.some((n) => n.t === 'em'), 'blank signature underscores stay and are not emphasis', i3);
const i4 = parseInline('a ** b');
assert(i4.length === 1 && i4[0].t === 'text' && (i4[0] as { v: string }).v === 'a ** b', 'an unmatched delimiter stays literal', i4);
const i5 = parseInline('see [the page](https://example.com/x) now');
assert(i5.length === 1 && (i5[0] as { v: string }).v === 'see the page (https://example.com/x) now', 'a link becomes plain text with its address', i5);
assert(!render('[x](javascript:alert(1))').includes('<a '), 'a link never produces an anchor');
const i6 = parseInline('**bold *and em* here**');
assert(i6.length === 1 && i6[0].t === 'strong' && (i6[0] as { c: { t: string }[] }).c.some((n) => n.t === 'em'), 'bold may contain italic', i6);

// Lists
const l1 = parseMarkdownBlocks('- a\n- b');
assert(l1.length === 1 && l1[0].t === 'list' && !l1[0].ordered && l1[0].items.length === 2, 'a bullet list of two items', l1);
const l2 = parseMarkdownBlocks('3. a\n4. b');
assert(l2.length === 1 && l2[0].t === 'list' && l2[0].ordered && l2[0].start === 3 && l2[0].items.length === 2, 'a numbered list keeps its first number', l2);
const l3 = parseMarkdownBlocks('- one\n  more of one\n- two');
assert(l3.length === 1 && l3[0].t === 'list' && l3[0].items.length === 2, 'an indented line continues its item', l3);

// Tables
const t1 = parseMarkdownBlocks('| A | B |\n|---|---|\n| x --- y | 2 |');
assert(t1.length === 1 && t1[0].t === 'table' && t1[0].head !== null && t1[0].rows.length === 1 && JSON.stringify(t1[0].rows[0][0]).includes('x --- y'), 'only the separator row is dropped; a data cell with --- stays', t1);
const t2 = parseMarkdownBlocks('| a | b |\n| c | d |');
assert(t2.length === 1 && t2[0].t === 'table' && t2[0].head === null && t2[0].rows.length === 2, 'a table without a separator has no header row', t2);
const t3 = parseMarkdownBlocks('| a \\| b | c |');
assert(t3[0].t === 'table' && t3[0].rows[0].length === 2, 'an escaped pipe does not split a cell', t3);

// Quotes, rules, code
const q1 = parseMarkdownBlocks('> [!NOTE]\n> The **AC** family');
assert(q1.length === 1 && q1[0].t === 'quote' && q1[0].callout === 'NOTE' && q1[0].lines.length === 1 && JSON.stringify(q1[0].lines[0]).includes('"strong"'), 'a NOTE callout drops its marker line and keeps the bold text', q1);
const q2 = parseMarkdownBlocks('> plain words');
assert(q2[0].t === 'quote' && q2[0].callout === null, 'a plain quote has no callout', q2);
assert(parseMarkdownBlocks('a\n\n---\n\nb').some((b) => b.t === 'hr') && !parseMarkdownBlocks('___').some((b) => b.t === 'hr'), 'dashes are a rule; underscores are not', null);
const c1 = parseMarkdownBlocks('```\n**not bold**\n# not a heading\n```');
assert(c1.length === 1 && c1[0].t === 'code' && c1[0].text === '**not bold**\n# not a heading', 'a fenced block is kept verbatim', c1);

// Line endings
const e1 = parseMarkdownBlocks('x\r\n\r\ny');
assert(e1.length === 2 && e1.every((b: Block) => b.t === 'paragraph'), 'CRLF text splits into the same blocks', e1);

// Rendering
const hostile = render('<script>alert(1)</script>');
assert(hostile.includes('&lt;script&gt;') && !hostile.includes('<script'), 'raw HTML is shown as text', hostile);
const html1 = render('## Title\n\n**a** and *b*\n\n- x\n\n| H |\n|---|\n| v |', 2);
assert(html1.includes('<h4') && !html1.includes('<h2') && html1.includes('<thead') && html1.includes('scope="col"') && html1.includes('<ul') && html1.includes('<strong'), 'headings shift by the offset; table, list and bold render as elements', html1);
assert(render('# T', 5).includes('<h6'), 'the heading level never passes h6');
const note = render('> [!WARNING]\n> careful');
assert(note.includes('role="note"') && note.includes('>Warning<') && note.includes('amber') && !note.includes('[!WARNING]'), 'a WARNING callout renders as a labelled note', note);

// A whole generated policy
const tenant = {
  id: 't-md', name: 'Acme', cageCode: '1ABC2', samStatus: 'ACTIVE', systemName: 'Enclave', systemOwner: 'Owner', industry: '', createdAt: '', updatedAt: '',
  stackProfile: { identityProvider: 'OKTA', edrSolution: 'GENERIC_AV', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'MANUAL_GPO', siemSolution: 'LOCAL_AUDITD' },
} as Tenant;
const doc = generatePolicyDocument(tenant, 'AC', 'Access Control', 'CMMC_L1');
const docHtml = render(doc, 2);
assert(!docHtml.includes('**') && !docHtml.includes('<h1') && !docHtml.includes('<h2'), 'a generated policy renders with no stray bold markers');
assert(doc.includes('| Date |') && docHtml.includes('<thead') && docHtml.includes('<h3') && docHtml.includes('<h4'), 'the revision table gets a header row and the headings shift by two', null);
assert(docHtml.includes('<li><strong') && docHtml.includes('Acme'), 'the metadata is a bullet list with bold labels');

// The views use the shared renderer
for (const rel of ['src/views/PolicyLibraryView.tsx', 'src/components/settings/EnclaveSettings.tsx']) {
  const src = source(rel);
  assert(src.includes('<MarkdownPreview') && !src.includes("split('\\n\\n')"), `${rel} uses MarkdownPreview and no longer splits on blank lines`);
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
