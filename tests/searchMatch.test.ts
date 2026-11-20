import fs from 'fs';
import path from 'path';
import { likePattern, matchText, normalizeQuery, rankResults, snippetAround } from '../src/data/search/searchMatch';
import { isSearchShortcut } from '../src/data/search/searchShortcut';
import { searchNavPlan } from '../src/data/search/searchNav';
import { SEARCH_KINDS, type SearchNav, type SearchResult } from '../src/types/search';

/**
 * #254: the pure parts of the global search. The query rules, the ILIKE-equal matching, the plain-text snippet, the ranking, the keyboard shortcut and
 * where each kind of result opens. Nothing here stores or logs a query.
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

console.log('\n--- SM1: normalizeQuery ---');
{
  const q = (v: unknown) => normalizeQuery(v);
  assert(q(' a ').ok === false, 'SM1 one character after trimming is too short');
  const ab = q('ab');
  assert(ab.ok === true && ab.q === 'ab', 'SM1 two characters is the minimum');
  const t = q('  needle  ');
  assert(t.ok === true && t.q === 'needle', 'SM1 trimmed');
  assert(q('x'.repeat(100)).ok === true && q('x'.repeat(101)).ok === false, 'SM1 100 characters is the maximum');
  assert(q('a\u0007b').ok === false && q('a\nb').ok === false && q('a\u007fb').ok === false, 'SM1 a control character is refused');
  assert(q(42).ok === false && q(null).ok === false && q(undefined).ok === false && q({}).ok === false, 'SM1 a non-string is refused');
  assert(q('%%').ok === true, 'SM1 wildcard characters are ordinary characters');
}

console.log('\n--- SM2: likePattern ---');
{
  assert(likePattern('50%_a\\b') === '%50\\%\\_a\\\\b%', 'SM2 percent, underscore and backslash are escaped', likePattern('50%_a\\b'));
  assert(likePattern('plain') === '%plain%', 'SM2 plain text is only wrapped');
}

console.log('\n--- SM3: matching and snippets ---');
{
  assert(matchText('Uses FalconMARK for EDR', 'falconmark') === 5 && matchText('abc', 'ABC') === 0 && matchText('abc', 'd') === -1 && matchText('abc', '') === -1, 'SM3 case-insensitive index, -1 for none and for empty');
  assert(matchText('a_c', '_') === 1 && matchText('abc', '_') === -1 && matchText('50%', '%') === 2 && matchText('abc', '%') === -1, 'SM3 wildcards match only themselves');
  assert(matchText('ab cd', 'b c') === 1 && matchText('ab  cd', 'b c') === -1, 'SM3 contiguous: the text must hold the query as typed');
  assert(matchText('İstanbul needle', 'needle') === 9 && matchText('İİ x', 'x') === 3, 'SM3 a character whose lower case is longer keeps the offsets', matchText('İstanbul needle', 'needle'));
  const s = snippetAround('x'.repeat(200) + 'NeedLE' + 'y'.repeat(200), 'needle');
  assert(!!s && s.match === 'NeedLE', 'SM3 the match keeps the text case', s?.match);
  assert(!!s && s.before.startsWith('…') && s.before.length === 61 && s.before.slice(1) === 'x'.repeat(60), 'SM3 before: an ellipsis and 60 characters', s?.before.length);
  assert(!!s && s.after.endsWith('…') && s.after.length === 61 && s.after.slice(0, 60) === 'y'.repeat(60), 'SM3 after: 60 characters and an ellipsis', s?.after.length);
  const short = snippetAround('a needle b', 'needle');
  assert(!!short && short.before === 'a ' && short.after === ' b', 'SM3 no ellipsis when nothing was cut', short);
  const ws = snippetAround('line one\n\tline  two needle', 'needle');
  assert(!!ws && ws.before === 'line one line two ', 'SM3 whitespace collapses to single spaces', ws);
  const r = snippetAround('x'.repeat(10) + 'needle' + 'y'.repeat(10), 'needle', 5);
  assert(!!r && r.before.length === 6 && r.after.length === 6, 'SM3 a custom radius', r);
  assert(snippetAround('nothing here', 'needle') === null && snippetAround('abc', '') === null, 'SM3 no match gives null');
  const html = snippetAround('<script>alert(1)</script> needle', 'needle');
  assert(!!html && html.before === '<script>alert(1)</script> ' && html.match === 'needle', 'SM3 text is returned as is, never as HTML (the renderer shows it as a text node)', html);
}

console.log('\n--- SM4: rankResults ---');
{
  const r = (id: string, title: string, field = 'title'): SearchResult => ({ kind: 'control', id, title, subtitle: '', field, snippet: null, nav: { screen: 'control', controlId: id } });
  const ranked = rankResults([r('c9', 'Review of access'), r('c3', 'Access control policy'), r('AC.L2-3.1.1', 'Authorized access control'), r('c1', 'AC.L2-3.1.1 notes', 'notes'), r('c0', 'Other', 'notes')], 'AC.L2-3.1.1');
  assert(ranked[0].id === 'AC.L2-3.1.1', 'SM4 the exact id comes first', ranked.map((x) => x.id));
  assert(ranked[1].id === 'c1', 'SM4 then a title that starts with the query');
  const byTitle = rankResults([r('b', 'The access list'), r('a', 'Access list'), r('c', 'Other'), r('d', 'access')], 'access');
  assert(byTitle.map((x) => x.id).join(',') === 'd,a,b,c', 'SM4 exact title, prefix, contains, the rest', byTitle.map((x) => x.id));
  const ties = rankResults([r('z', 'access x'), r('m', 'access y')], 'access');
  assert(ties.map((x) => x.id).join(',') === 'm,z', 'SM4 ties are ordered by id');
  const input = [r('b', 'b'), r('a', 'a')];
  rankResults(input, 'zz');
  assert(input[0].id === 'b', 'SM4 the input is not changed');
}

console.log('\n--- SM5: isSearchShortcut ---');
{
  const e = (over: Record<string, unknown>) => ({ key: '/', ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'BODY' }, ...over }) as Parameters<typeof isSearchShortcut>[0];
  assert(isSearchShortcut(e({})) === true, 'SM5 "/" outside a field');
  assert(isSearchShortcut(e({ target: { tagName: 'INPUT' } })) === false && isSearchShortcut(e({ target: { tagName: 'textarea' } })) === false && isSearchShortcut(e({ target: { tagName: 'SELECT' } })) === false, 'SM5 "/" in a field is typed');
  assert(isSearchShortcut(e({ target: { isContentEditable: true } })) === false, 'SM5 "/" in an editable area is typed');
  assert(isSearchShortcut(e({ target: null })) === true, 'SM5 no target');
  assert(isSearchShortcut(e({ key: 'k', ctrlKey: true, target: { tagName: 'TEXTAREA' } })) === true, 'SM5 Ctrl+K works in a field');
  assert(isSearchShortcut(e({ key: 'K', metaKey: true })) === true, 'SM5 Cmd+K, either case');
  assert(isSearchShortcut(e({ key: 'k' })) === false, 'SM5 plain k is typing');
  assert(isSearchShortcut(e({ altKey: true })) === false && isSearchShortcut(e({ key: 'k', ctrlKey: true, altKey: true })) === false, 'SM5 Alt is another shortcut');
  assert(isSearchShortcut(e({ ctrlKey: true })) === false && isSearchShortcut(e({ metaKey: true })) === false, 'SM5 Ctrl+/ and Cmd+/ are not ours');
  assert(isSearchShortcut(e({ isComposing: true })) === false && isSearchShortcut(e({ key: 'k', ctrlKey: true, isComposing: true })) === false, 'SM5 never while composing');
  assert(isSearchShortcut(e({ defaultPrevented: true })) === false, 'SM5 never when another handler took the key');
}

console.log('\n--- SM6: where each kind opens ---');
{
  const navs: SearchNav[] = [
    { screen: 'control', controlId: 'c1' },
    { screen: 'objective', controlId: 'c1', objectiveId: 'c1[a]' },
    { screen: 'evidence', evidenceId: 'e1', controlId: 'c1' },
    { screen: 'asset', assetId: 'a1' },
    { screen: 'poam_control', controlId: 'c1' },
    { screen: 'poam_vm', itemId: 'v1' },
    { screen: 'tool', toolId: 't1' },
    { screen: 'vendor', vendorId: 'n1' },
    { screen: 'document', documentId: 'd1' },
  ];
  assert(navs.length === SEARCH_KINDS.length && new Set(navs.map((n) => n.screen)).size === SEARCH_KINDS.length && navs.every((n) => (SEARCH_KINDS as readonly string[]).includes(n.screen)), 'SM6 one navigation per kind');
  const p = navs.map((n) => searchNavPlan(n));
  assert(p[0].tab === 'matrix' && p[0].selectControlId === 'c1', 'SM6 a control selects it on the matrix');
  assert(p[1].tab === 'matrix' && p[1].openObjective?.objectiveId === 'c1[a]' && p[1].openObjective.controlId === 'c1', 'SM6 an objective opens at the objective');
  assert(p[2].tab === 'evidence' && p[2].previewEvidenceId === 'e1', 'SM6 evidence opens its preview');
  assert(p[3].tab === 'assets' && p[7].tab === 'tools' && p[6].tab === 'tools' && p[8].tab === 'documents', 'SM6 asset, tool, vendor and document tabs');
  assert(p[4].tab === 'poam' && p[5].tab === 'poam' && p[5].pendingFocus?.id === 'v1' && p[5].pendingFocus.kind === 'poam_vm', 'SM6 both POA&M kinds open the POA&M tab with a pending focus');
  assert(p.every((x) => JSON.stringify(x).length < 300), 'SM6 a plan is small ids only');
}

console.log('\n--- SM7: no storage, logging or URL query ---');
{
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
  for (const f of ['searchMatch', 'searchShortcut', 'searchNav']) {
    assert(!/\b(localStorage|sessionStorage|caches\.|recordAuditEvent|console\.|fetch\(|Date\.now|new Date|from 'react')/.test(read('src', 'data', 'search', `${f}.ts`)), `SM7 ${f} is pure`);
  }
  for (const rel of [['src', 'hooks', 'useGlobalSearch.ts'], ['src', 'components', 'search', 'GlobalSearch.tsx']]) {
    const p = path.join(process.cwd(), ...rel);
    if (!fs.existsSync(p)) continue; // written later by the client and UI coders
    const src = fs.readFileSync(p, 'utf8');
    assert(!/\b(localStorage|sessionStorage|caches\.|recordAuditEvent|console\.)/.test(src) && !src.includes('?q=') && !src.includes('dangerouslySetInnerHTML'), `SM7 ${rel[rel.length - 1]} keeps no query and renders no HTML`);
  }
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
