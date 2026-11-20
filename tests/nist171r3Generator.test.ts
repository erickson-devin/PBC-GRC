import JSZip from 'jszip';
import {
  buildR2toR3Mapping,
  buildR3FromOscal,
  checkComparison,
  normalizeR3Id,
  parseComparisonRows,
  r2IdOf,
  readXlsxRows,
  verifyR3Build,
} from '../scripts/generateNist171r3';
import { parseParameterTags } from '../src/data/frameworks/parameters';

/**
 * scripts/generateNist171r3.ts, on fixtures built here (no network, no committed data): the OSCAL catalog walk (statement
 * flattening, ODP tags and their order, objectives, withdrawn links), the xlsx reader, the change analysis rows and the Rev. 2 to
 * Rev. 3 mapping, and every fail-loud check. Pure: does not boot the server.
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function throws(fn: () => unknown, pattern: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return pattern.test(e instanceof Error ? e.message : String(e));
  }
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return pattern.test(e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------------------------------------ OSCAL fixture
const item = (sid: string, suffix: string, prose: string, parts?: unknown[]) => ({
  id: `SR-${sid}.${suffix}`,
  name: 'item',
  props: [{ name: 'label', value: `SR-${sid}.${suffix}` }],
  prose,
  ...(parts ? { parts } : {}),
});
const param = (sid: string, n: string, label: string, guideline?: string) => ({
  id: `A.${sid}.ODP.${n}`,
  props: [{ name: 'label', value: `A.${sid}.ODP[${n}]` }],
  label,
  usage: `organization-defined ${label}`,
  ...(guideline ? { guidelines: [{ prose: guideline }] } : {}),
});
const objective = (sid: string, suffix: string, prose: string) => ({
  id: `assessment-objective_DS-A.${sid}${suffix ? `.${suffix}` : ''}`,
  name: 'assessment-objective',
  prose,
  links: [{ href: `#SR-${sid}`, rel: 'assessment-for' }],
});
const method = (sid: string, m: string, prose: string) => ({
  id: `${m[0]}-${sid}_assessment-method_${m.toLowerCase()}`,
  name: 'assessment-method',
  props: [{ name: 'method', ns: 'http://csrc.nist.gov/ns/rmf', value: m }],
  parts: [{ name: 'assessment-objects', prose }],
});
const ins = (sid: string, n: string) => `{{ insert: param, A.${sid}.ODP.${n} }}`;

function fixture(): any {
  const S1 = '03.01.01';
  const S2 = '03.13.08';
  return {
    catalog: {
      metadata: { version: '9.9.9' },
      groups: [
        {
          id: 'SP_800_171_03.01',
          title: 'Access Control',
          controls: [
            {
              id: `SP_800_171_${S1}`,
              class: 'requirement',
              title: 'Account Management',
              params: [
                {
                  id: `A.${S1}.ODP.01`,
                  props: [{ name: 'label', value: `A.${S1}.ODP[01]` }],
                  label: 'SELECTED PARAMETER VALUES',
                  select: { 'how-many': 'one-or-more', choice: [`lock the account for ${ins(S1, '02')}`, 'notify an administrator'] },
                },
                param(S1, '02', 'time period', 'the time period for the lock is defined (if selected).'),
                param(S1, '03', 'frequency', 'the review frequency is defined.'),
                param(S1, '04', 'events'),
              ],
              props: [
                { name: 'sort-id', value: S1 },
                { name: 'label', value: 'Account Management (03.01.01)' },
              ],
              links: [{ href: '#some-uuid', rel: 'reference' }],
              parts: [
                {
                  id: `statement_${S1}`,
                  name: 'statement',
                  class: 'security_requirement',
                  parts: [
                    item(S1, 'a', `Take ${ins(S1, '01')} when attempts are exceeded.`),
                    item(S1, 'b', 'Specify:', [item(S1, 'b.01', 'Authorized users,'), item(S1, 'b.02', `Review accounts ${ins(S1, '03')}.`)]),
                  ],
                },
                { id: `guidance_D-${S1}`, name: 'guidance', prose: 'See [](#/cprt/framework/version/SP_800_171_3_0_0/home?element=03.13.08)03.13.08 and also [](#/cprt/x) 03.13.09. Done.' },
                // out of order on purpose, as NIST's catalog is
                objective(S1, 'b.02', `accounts are reviewed ${ins(S1, '03')}.`),
                objective(S1, 'a.02', 'the lock is applied;'),
                objective(S1, 'b.01', 'authorized users are specified.'),
                objective(S1, 'a.01', `an action is taken: ${ins(S1, '01')}.`),
                objective(S1, '02', 'numbered second'),
                objective(S1, '01', `events are defined: ${ins(S1, '04')}`),
                method(S1, 'EXAMINE', 'policy and procedures\n\nlist of accounts\nover two lines'),
                method(S1, 'INTERVIEW', 'system administrators'),
              ],
            },
            {
              id: 'SP_800_171_03.01.13',
              class: 'requirement',
              title: '03.01.13',
              props: [
                { name: 'sort-id', value: '03.01.13' },
                { name: 'status', value: 'withdrawn' },
              ],
              links: [
                { href: '03.13.08', rel: 'incorporated_into' },
                { href: '#a-uuid', rel: 'reference' },
              ],
            },
            {
              id: 'SP_800_171_03.01.14',
              class: 'requirement',
              title: '03.01.14',
              props: [
                { name: 'sort-id', value: '03.01.14' },
                { name: 'status', value: 'withdrawn' },
              ],
              links: [{ href: '03.01.01', rel: 'addressed_by' }],
            },
            { id: 'SP_800_171_03.01.15', class: 'requirement', title: '03.01.15', props: [{ name: 'sort-id', value: '03.01.15' }, { name: 'status', value: 'withdrawn' }] },
          ],
        },
        {
          id: 'SP_800_171_03.13',
          title: 'System and Communications Protection',
          controls: [
            {
              id: `SP_800_171_${S2}`,
              class: 'requirement',
              title: 'Information in Shared System Resources',
              props: [{ name: 'sort-id', value: S2 }],
              parts: [
                { id: `statement_${S2}`, name: 'statement', class: 'security_requirement', prose: 'Prevent unauthorized information transfer.' },
                objective(S2, '', 'unauthorized information transfer is prevented'),
              ],
            },
          ],
        },
      ],
    },
  };
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const control = (f: any, i = 0, g = 0) => f.catalog.groups[g].controls[i];

(async () => {
  console.log('--- normalizeR3Id ---');
  assert(normalizeR3Id('3.1.1') === '03.01.01', 'G1: 3.1.1 -> 03.01.01');
  assert(normalizeR3Id('03.01.01') === '03.01.01', 'G2: 03.01.01 stays');
  assert(normalizeR3Id('3.12.4') === '03.12.04', 'G3: 3.12.4 -> 03.12.04');
  assert(normalizeR3Id('03.01.10\t') === '03.01.10', 'G4: trailing tab');
  assert(normalizeR3Id('  3.1.1\r\n') === '03.01.01', 'G5: leading and trailing white space, nbsp, line break');
  assert(normalizeR3Id('3. 1.1') === '03.01.01', 'G6: inner space removed');
  assert(throws(() => normalizeR3Id('abc'), /not a requirement identifier/), 'G7: text is refused');
  assert(throws(() => normalizeR3Id('3.1'), /not a requirement identifier/), 'G8: two parts are refused');
  assert(throws(() => normalizeR3Id('03.01.01.01'), /not a requirement identifier/), 'G9: four parts are refused');
  assert(throws(() => normalizeR3Id(''), /not a requirement identifier/), 'G10: empty is refused');
  assert(r2IdOf('03.12.04') === '3.12.4' && r2IdOf('03.01.01') === '3.1.1', 'G11: r2IdOf drops the leading zeros');

  console.log('\n--- buildR3FromOscal: requirements ---');
  const built = buildR3FromOscal(fixture());
  assert(built.requirements.length === 2, 'G12: two active requirements (withdrawn ones are not requirements)', built.requirements.map((r) => r.id));
  assert(same(built.requirements.map((r) => r.id), ['03.01.01', '03.13.08']), 'G13: ids are the sort-ids, in order');
  assert(built.version === '9.9.9', 'G14: version is the catalog content version');
  assert(same(built.families, [{ code: '03.01', title: 'Access Control' }, { code: '03.13', title: 'System and Communications Protection' }]), 'G15: families', built.families);
  const r1 = built.requirements[0];
  assert(r1.family === '03.01' && r1.title === 'Account Management', 'G16: family code and title');
  assert(r1.statement.includes('[Selection (one or more): lock the account for [Assignment: organization-defined time period]; notify an administrator]'), 'G17: a Selection renders its choices, a nested Assignment stays inside it', r1.statement);
  assert(r1.statement.includes('[Assignment: organization-defined frequency]'), 'G18: an Assignment renders organization-defined <label>');
  assert(r1.statement.split('\n').length === 4, 'G19: items are flattened one per line', r1.statement);
  assert(r1.statement.split('\n')[0].startsWith('a. Take [Selection'), 'G20: a lettered item is "a. text"', r1.statement.split('\n')[0]);
  assert(r1.statement.split('\n')[1] === 'b. Specify:', 'G21: a parent item keeps its own line');
  assert(r1.statement.split('\n')[2] === '  1. Authorized users,' && r1.statement.split('\n')[3].startsWith('  2. Review accounts'), 'G22: a sub-item is indented and numbered 1., 2.', r1.statement);
  assert(built.requirements[1].statement === 'Prevent unauthorized information transfer.', 'G23: a statement with prose and no items has no label');
  assert(r1.discussion === 'See 03.13.08 and also 03.13.09. Done.', 'G24: cross-reference markup is removed, the target id stays', r1.discussion);
  const allText = [
    ...built.requirements.flatMap((r) => [r.statement, r.discussion]),
    ...Object.values(built.objectives).flatMap((o) => [...o.objectives.map((x) => x.text ?? ''), ...o.methods.examine, ...o.methods.interview, ...o.methods.test]),
  ].join('\n');
  assert(allText.length > 0 && !/\{\{|\}\}|\]\(/.test(allText), 'G25: no placeholder or link markup is left in any text');

  console.log('\n--- buildR3FromOscal: ODPs ---');
  assert(same(r1.odps, ['A.03.01.01.ODP[01]', 'A.03.01.01.ODP[03]']), 'G26: odps lists the outermost tags in order, bracket labels', r1.odps);
  const tags = parseParameterTags(r1.statement, r1.id);
  assert(tags.length === r1.odps.length, 'G27: parseParameterTags finds exactly the tags the ODP list records', tags.length);
  assert(tags[0].kind === 'SELECTION' && tags[1].kind === 'ASSIGNMENT', 'G28: tag kinds follow the ODP kinds', tags.map((t) => t.kind));
  assert(tags[0].choices?.length === 2 && tags[0].selectionMode === 'ONE_OR_MORE', 'G29: the Selection parses with its choices');
  assert(same(Object.keys(built.odps), ['A.03.01.01.ODP[01]', 'A.03.01.01.ODP[02]', 'A.03.01.01.ODP[03]', 'A.03.01.01.ODP[04]']), 'G30: every ODP of the catalog is in the table', Object.keys(built.odps));
  const o1 = built.odps['A.03.01.01.ODP[01]'];
  assert(o1.tag === 1 && o1.placement === 'TAG' && o1.kind === 'SELECTION' && o1.label === 'Selection' && o1.requirement === '03.01.01', 'G31: the Selection is tag 1', o1);
  const o2 = built.odps['A.03.01.01.ODP[02]'];
  assert(o2.tag === null && o2.placement === 'NESTED' && o2.parentTag === 1 && o2.kind === 'ASSIGNMENT' && o2.label === 'time period', 'G32: an Assignment inside a Selection is NESTED in tag 1', o2);
  assert(o2.guideline === 'the time period for the lock is defined (if selected).', 'G33: the guideline prose is kept');
  const o3 = built.odps['A.03.01.01.ODP[03]'];
  assert(o3.tag === 2 && o3.placement === 'TAG' && o3.label === 'frequency', 'G34: the second outermost tag is tag 2', o3);
  const o4 = built.odps['A.03.01.01.ODP[04]'];
  assert(o4.tag === null && o4.placement === 'OBJECTIVES' && !('guideline' in o4), 'G35: an ODP only the objectives use is OBJECTIVES, no guideline key without one', o4);

  console.log('\n--- buildR3FromOscal: objectives ---');
  const obj = built.objectives['03.01.01'];
  assert(same(obj.objectives.map((o) => o.letter), ['odp02', 'odp03', 'a01', 'a02', 'b01', 'b02', '01', '02']), 'G36: ODP statements (those with a guideline) first, then the objectives in natural order, letters normalised (a[01] -> a01)', obj.objectives.map((o) => o.letter));
  assert(obj.objectives[0].id === 'A.03.01.01.ODP[02]' && obj.objectives[0].text === 'the time period for the lock is defined (if selected)', 'G37: an ODP statement is the guideline without its final period', obj.objectives[0]);
  assert(obj.objectives.find((o) => o.letter === 'a01')?.id === 'A.03.01.01.a.01', 'G38: objective id drops the OSCAL prefix');
  assert(obj.objectives.find((o) => o.letter === 'a01')?.text === 'an action is taken: [Selection (one or more): lock the account for [Assignment: organization-defined time period]; notify an administrator]', 'G39: objective text carries tags and loses the final period', obj.objectives.find((o) => o.letter === 'a01')?.text);
  assert(obj.objectives.find((o) => o.letter === 'a02')?.text === 'the lock is applied', 'G40: a trailing semicolon is removed');
  assert(obj.objectives.every((o) => !('parent' in o)), 'G41: objectives are flat');
  assert(same(obj.methods.examine, ['policy and procedures', 'list of accounts over two lines']), 'G42: methods split on blank lines and join wrapped lines', obj.methods.examine);
  assert(same(obj.methods.interview, ['system administrators']) && same(obj.methods.test, []), 'G43: a missing method is an empty list');
  assert(same(built.objectives['03.13.08'].objectives.map((o) => o.letter), ['a']) && built.objectives['03.13.08'].objectives[0].id === 'A.03.13.08', 'G44: an objective for the whole requirement gets letter a', built.objectives['03.13.08']);

  console.log('\n--- buildR3FromOscal: withdrawn ---');
  assert(same(built.withdrawn['03.01.13'], ['03.13.08']), 'G45: withdrawn requirement -> its successor id', built.withdrawn);
  assert(same(built.withdrawnLinks['03.01.13'], [{ id: '03.13.08', relation: 'INCORPORATED_INTO' }]), 'G46: incorporated_into keeps its relation');
  assert(same(built.withdrawnLinks['03.01.14'], [{ id: '03.01.01', relation: 'ADDRESSED_BY' }]), 'G47: addressed_by keeps its relation');
  assert(same(built.withdrawn['03.01.15'], []), 'G48: a withdrawn requirement without links has no successor');
  assert(!built.requirements.some((r) => r.id === '03.01.13'), 'G49: a withdrawn requirement is not in the active list');

  console.log('\n--- verifyR3Build ---');
  assert(!throws(() => verifyR3Build(built), /./), 'G50: a consistent build passes');
  const dangling = clone(built);
  dangling.withdrawn['03.01.13'] = ['03.99.99'];
  assert(throws(() => verifyR3Build(dangling), /03\.99\.99, which is not an active requirement/), 'G51: a withdrawn target that is not active fails');
  const toWithdrawn = clone(built);
  toWithdrawn.withdrawn['03.01.13'] = ['03.01.14'];
  assert(throws(() => verifyR3Build(toWithdrawn), /03\.01\.14, which is not an active requirement/), 'G52: a withdrawn target that is itself withdrawn fails');
  const noFamily = clone(built);
  noFamily.families = [noFamily.families[0]];
  assert(throws(() => verifyR3Build(noFamily), /unknown family 03\.13/), 'G53: a requirement without a family fails');

  console.log('\n--- buildR3FromOscal: fail-loud ---');
  const f1 = fixture();
  control(f1).parts[0].parts[0].prose = 'Take {{ insert: param, A.03.01.01.ODP.77 }}.';
  assert(throws(() => buildR3FromOscal(f1), /unresolved parameter A\.03\.01\.01\.ODP\.77/), 'G54: an insert naming no parameter fails');
  const f2 = fixture();
  control(f2).params.push(param('03.01.01', '05', 'frequency', 'never used.'));
  assert(throws(() => buildR3FromOscal(f2), /ODP\[05\] is not referenced/), 'G55: an ODP nothing references fails');
  const f3 = fixture();
  control(f3, 1).links = [{ href: '03.13.08', rel: 'moved_to' }];
  assert(throws(() => buildR3FromOscal(f3), /unexpected link relation moved_to/), 'G56: an unknown withdrawn link relation fails');
  const f4 = fixture();
  control(f4).props[0].value = '3.1.1';
  assert(throws(() => buildR3FromOscal(f4), /is not a requirement id/), 'G57: a sort-id that is not 03.xx.xx fails');
  const f5 = fixture();
  control(f5).parts.push(objective('03.01.01', 'a.[01]', 'collides with a01'));
  assert(throws(() => buildR3FromOscal(f5), /letters are not unique/), 'G58: two objectives with the same letter fail');
  const f6 = fixture();
  control(f6).parts[0].parts[0].prose = 'Take [Assignment: unclosed';
  assert(throws(() => buildR3FromOscal(f6), /tags opened/), 'G59: a hand-written tag the parser cannot read fails');
  const f7 = fixture();
  control(f7).parts[0].parts[0].prose = `Take ${ins('03.01.01', '03')} and ${ins('03.01.01', '03')}.`;
  assert(throws(() => buildR3FromOscal(f7), /more than one tag/), 'G60: an ODP inserted in two tags fails');
  const f8 = fixture();
  control(f8).parts[0].parts[0].prose = 'Take {{ unknown }} action.';
  assert(throws(() => buildR3FromOscal(f8), /unresolved placeholder/), 'G61: a placeholder that is not an insert fails');
  const f9 = fixture();
  f9.catalog.groups[0].id = 'SP_800_171_xx';
  assert(throws(() => buildR3FromOscal(f9), /unexpected family id/), 'G62: an unexpected family id fails');
  const f10 = fixture();
  control(f10).parts.push({ id: 'assessment-objective_DS-A.03.99.99.a', name: 'assessment-objective', prose: 'x' });
  assert(throws(() => buildR3FromOscal(f10), /unexpected assessment objective/), 'G63: an objective of another requirement fails');

  console.log('\n--- readXlsxRows ---');
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="x"><sheets><sheet name="Summary" sheetId="3" r:id="rId1"/><sheet name="Data &amp; more" sheetId="1" r:id="rId2"/></sheets></workbook>');
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file('xl/sharedStrings.xml', '<sst><si><t>3.1.1</t></si><si><t xml:space="preserve">03.01.10&#9;</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh><t>PHONETIC</t></rPh></si><si><t>A &amp; B</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>summary sheet</t></is></c></row></sheetData></worksheet>');
  zip.file(
    'xl/worksheets/sheet2.xml',
    '<worksheet><cols><col min="1" max="1"/></cols><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="3"><c r="A3" s="9"/><c r="C3" t="inlineStr"><is><t>inline</t></is></c><c r="E3"><v>42</v></c></row>' +
      '<row r="4"><c r="B4" t="s"><v>3</v></c><c r="D4" t="str"><v>a &lt; b</v></c></row>' +
      '<row r="6"/>' +
      '</sheetData></worksheet>',
  );
  const xlsx = await zip.generateAsync({ type: 'nodebuffer' });
  const rows = await readXlsxRows(xlsx, 'Data & more');
  assert(rows[0][0] === '3.1.1' && rows[0][1] === '03.01.10\t' && rows[0][2] === 'Rich text', 'G64: shared strings, entities, rich text runs without the phonetic run', rows[0]);
  assert(rows[1]?.length === 0, 'G65: a row without cells is empty and keeps its row number', rows[1]);
  assert(rows[2][0] === '' && rows[2][1] === '' && rows[2][2] === 'inline' && rows[2][3] === '' && rows[2][4] === '42', 'G66: column gaps are empty strings, inline strings and numbers are read', rows[2]);
  assert(rows[3][1] === 'A & B' && rows[3][3] === 'a < b', 'G67: shared index 3 and a formula string', rows[3]);
  assert(rows.length === 6 && rows[3].length === 4, 'G68: row index is the sheet row number - 1', rows.length);
  assert((await readXlsxRows(xlsx))[0][0] === 'summary sheet', 'G69: the default sheet is the first one');
  assert(await rejects(() => readXlsxRows(xlsx, 'Nope'), /no sheet "Nope"/), 'G70: an unknown sheet name fails');
  const broken = new JSZip();
  broken.file('xl/workbook.xml', '<workbook><sheets/></workbook>');
  assert(await rejects(async () => readXlsxRows(await broken.generateAsync({ type: 'nodebuffer' })), /xlsx: /), 'G71: a workbook without the parts fails');

  console.log('\n--- parseComparisonRows / checkComparison ---');
  const header = ['Family', 'SP 800-171 R2 SORT-ID', 'SP 800-171 R2 Identifier', 'R2 text', 'Basic/Derived', 'SP 800-171 R3 SORT-ID', 'SP 800-171 R3 Identifier', 'Requirement Name', 'R3 text', 'No Significant Change', 'Significant Change ', 'Minor Change', 'New ODP', 'New Requirement ', 'Withdrawn Requirement', 'Summary'];
  const row = (r2: string, r3: string, marks: string, name = 'Name'): string[] => {
    const cells = ['AC', '', r2, '', '', '', r3, name, '', '', '', '', '', '', '', ''];
    const cols: Record<string, number> = { none: 9, sig: 10, minor: 11, odp: 12, nu: 13, wd: 14 };
    for (const m of marks.split(',').filter(Boolean)) cells[cols[m]] = 'X';
    return cells;
  };
  const sheetRows = [
    header,
    row('3.1.1', '03.01.01', 'sig,odp'),
    row('3.1.2', '03.01.02', 'none'),
    row('3.1.13', '03.01.13\t', 'wd', 'Withdrawn'),
    row('3.11.4', '03.01.14', 'wd', 'Withdrawn'),
    row('', '03.13.08', 'odp,nu'),
    row('3.12.4', '03.13.09\r\n', 'minor,odp'),
    [],
  ];
  const parsed = parseComparisonRows(sheetRows);
  assert(parsed.rows.length === 6, 'G72: one row per non-empty sheet row', parsed.rows.length);
  assert(same(parsed.rows[0], { row: 2, r2: '3.1.1', r3: '03.01.01', withdrawn: false, changeType: 'SIGNIFICANT_CHANGE', newOdp: true, newRequirement: false }), 'G73: an active row', parsed.rows[0]);
  assert(parsed.rows[1].changeType === 'NO_SIGNIFICANT_CHANGE' && parsed.rows[1].newOdp === false, 'G74: no significant change, no new ODP');
  assert(parsed.rows[2].r3 === '03.01.13' && parsed.rows[2].withdrawn && parsed.rows[2].changeType === undefined, 'G75: a withdrawn row has its identifier cleaned and no change type');
  assert(parsed.rows[3].r2 === '3.1.14' && parsed.corrections.length === 1 && /row 5: .*"3\.11\.4".*03\.01\.14/.test(parsed.corrections[0]), 'G76: a withdrawn row naming another Rev. 2 id follows the Rev. 3 id, and says so', parsed.corrections);
  assert(parsed.rows[4].r2 === undefined && parsed.rows[4].newRequirement && parsed.rows[4].newOdp, 'G77: a new requirement has no Rev. 2 id');
  assert(parsed.rows[5].r2 === '3.12.4' && parsed.rows[5].r3 === '03.13.09' && parsed.rows[5].changeType === 'MINOR_CHANGE', 'G78: an active row may carry another number', parsed.rows[5]);
  assert(throws(() => parseComparisonRows([header.slice(0, 5)]), /no column/), 'G79: a missing column fails');
  assert(throws(() => parseComparisonRows([header, row('3.1.1', '03.01.01', 'sig,minor')]), /2 change type marks/), 'G80: two change type marks fail');
  assert(throws(() => parseComparisonRows([header, row('3.1.1', '03.01.01', '')]), /0 change type marks/), 'G81: no change type mark fails');
  assert(throws(() => parseComparisonRows([header, row('3.1.1', '03.01.01', 'sig,nu')]), /new requirement mark disagrees/), 'G82: a new mark on a row with a Rev. 2 id fails');
  assert(throws(() => parseComparisonRows([header, row('', '03.01.01', 'odp')]), /new requirement mark disagrees/), 'G83: a row without Rev. 2 id and without the new mark fails');
  assert(throws(() => parseComparisonRows([header, row('3.1.1', '03.01.01', 'sig'), row('3.1.2', '03.01.01', 'sig')]), /listed twice/), 'G84: a Rev. 3 id listed twice fails');
  assert(throws(() => parseComparisonRows([header, row('3.1.1', 'junk', 'sig')]), /not a requirement identifier/), 'G85: a bad Rev. 3 id fails');

  const wb: any = { requirements: [{ id: '03.01.01' }, { id: '03.01.02' }, { id: '03.13.08' }, { id: '03.13.09' }], withdrawn: { '03.01.13': [], '03.01.14': [] } };
  assert(!throws(() => checkComparison(parsed.rows, wb), /./), 'G86: workbook and catalog agree');
  const otherWithdrawn = { ...wb, withdrawn: { '03.01.13': [] } };
  assert(throws(() => checkComparison(parsed.rows, otherWithdrawn), /row 5: 03\.01\.14 is withdrawn in the workbook, not in the catalog/), 'G87: a withdrawn mark the catalog does not share fails');
  const lessActive = { ...wb, requirements: wb.requirements.slice(0, 3) };
  assert(throws(() => checkComparison(parsed.rows, lessActive), /03\.13\.09 is active in the workbook, not in the catalog/), 'G88: an active row the catalog lacks fails');
  const moreActive = { ...wb, requirements: [...wb.requirements, { id: '03.17.01' }] };
  assert(throws(() => checkComparison(parsed.rows, moreActive), /03\.17\.01 is in the catalog but not in the workbook/), 'G89: a catalog requirement the workbook lacks fails');

  console.log('\n--- buildR2toR3Mapping ---');
  const r3Ids = new Set(['03.01.01', '03.01.02', '03.13.08', '03.13.09', '03.15.02', '03.17.01']);
  const links = {
    '03.01.13': [{ id: '03.13.08', relation: 'INCORPORATED_INTO' as const }],
    '03.01.14': [{ id: '03.01.02', relation: 'ADDRESSED_BY' as const }, { id: '03.13.09', relation: 'INCORPORATED_INTO' as const }],
    '03.01.15': [],
    '03.12.04': [{ id: '03.15.02', relation: 'INCORPORATED_INTO' as const }],
  };
  // without the workbook: the same number is SAME, a withdrawn number follows the links
  const plain = buildR2toR3Mapping(['3.1.1', '3.1.13', '3.1.15'], r3Ids, { '03.01.13': ['03.13.08'], '03.01.15': [] });
  assert(same(plain.requirements['3.1.1'], { targets: [{ id: '03.01.01', relation: 'SAME' }] }), 'G90: 3.1.1 is SAME 03.01.01', plain.requirements['3.1.1']);
  assert(same(plain.requirements['3.1.13'], { targets: [{ id: '03.13.08', relation: 'INCORPORATED_INTO' }], withdrawn: true }), 'G91: 3.1.13 is INCORPORATED_INTO 03.13.08 and withdrawn', plain.requirements['3.1.13']);
  assert(same(plain.withdrawnWithoutSuccessor, { '3.1.15': true }) && same(plain.requirements['3.1.15'], { targets: [], withdrawn: true }), 'G92: a withdrawn requirement without links is in withdrawnWithoutSuccessor and still has an entry', plain);
  assert(same(plain.newInR3, ['03.01.02', '03.13.09', '03.15.02', '03.17.01']), 'G93: newInR3 is the active ids nothing leads to', plain.newInR3);
  assert(!('changeType' in plain.requirements['3.1.1']), 'G94: no workbook, no change type');
  assert(throws(() => buildR2toR3Mapping(['3.1.1', '3.1.99', '3.1.98'], r3Ids, {}), /neither carries nor withdraws \(2\): 3\.1\.98, 3\.1\.99/), 'G95: a Rev. 2 requirement nothing classifies fails, listing every one');
  assert(throws(() => buildR2toR3Mapping(['3.1.13'], r3Ids, { '03.01.13': ['03.50.01'] }), /03\.50\.01 is not an active Rev\. 3 requirement/), 'G96: a successor that is not active fails');
  assert(throws(() => buildR2toR3Mapping(['3.1'], r3Ids, {}), /not a Rev\. 2 requirement identifier/), 'G97: a malformed Rev. 2 id fails');

  // with the workbook rows
  const cmp = [
    { row: 2, r2: '3.1.1', r3: '03.01.01', withdrawn: false, changeType: 'SIGNIFICANT_CHANGE' as const, newOdp: true, newRequirement: false },
    { row: 3, r2: '3.1.2', r3: '03.01.02', withdrawn: false, changeType: 'NO_SIGNIFICANT_CHANGE' as const, newOdp: false, newRequirement: false },
    { row: 4, r2: '3.1.13', r3: '03.01.13', withdrawn: true, newOdp: false, newRequirement: false },
    { row: 5, r2: '3.1.14', r3: '03.01.14', withdrawn: true, newOdp: false, newRequirement: false },
    { row: 6, r2: '3.12.4', r3: '03.12.04', withdrawn: true, newOdp: false, newRequirement: false },
    { row: 7, r2: '3.12.4', r3: '03.15.02', withdrawn: false, changeType: 'MINOR_CHANGE' as const, newOdp: true, newRequirement: false },
    { row: 8, r3: '03.17.01', withdrawn: false, newOdp: true, newRequirement: true },
  ];
  const full = buildR2toR3Mapping(['3.1.1', '3.1.2', '3.1.13', '3.1.14', '3.1.15', '3.12.4'], r3Ids, links, cmp);
  assert(same(full.requirements['3.1.1'], { targets: [{ id: '03.01.01', relation: 'SAME' }], changeType: 'SIGNIFICANT_CHANGE', newOdp: true }), 'G98: an active row gives target, change type and new ODP', full.requirements['3.1.1']);
  assert(full.requirements['3.1.2'].changeType === 'NO_SIGNIFICANT_CHANGE' && full.requirements['3.1.2'].newOdp === false, 'G99: newOdp is false when the row has no mark');
  assert(same(full.requirements['3.1.14'].targets, [{ id: '03.01.02', relation: 'ADDRESSED_BY' }, { id: '03.13.09', relation: 'INCORPORATED_INTO' }]) && full.requirements['3.1.14'].withdrawn === true && !('changeType' in full.requirements['3.1.14']), 'G100: a withdrawn requirement with two successors keeps both relations, no change type', full.requirements['3.1.14']);
  assert(same(full.requirements['3.12.4'], { targets: [{ id: '03.15.02', relation: 'SAME' }], changeType: 'MINOR_CHANGE', newOdp: true }), 'G101: an active row and a withdrawn placeholder pointing at the same target give one SAME target, not withdrawn', full.requirements['3.12.4']);
  assert(same(full.withdrawnWithoutSuccessor, { '3.1.15': true }) && same(full.requirements['3.1.15'], { targets: [], withdrawn: true }), 'G102: withdrawnWithoutSuccessor holds only the requirement with no target');
  assert(same(full.newInR3, ['03.17.01']), 'G103: with the workbook, newInR3 is what nothing leads to', full.newInR3);
  assert(same(Object.keys(full.requirements), ['3.1.1', '3.1.2', '3.1.13', '3.1.14', '3.1.15', '3.12.4']), 'G104: entries are in numeric order', Object.keys(full.requirements));
  const dup = buildR2toR3Mapping(
    ['3.2.1'],
    new Set(['03.02.01', '03.02.02']),
    {},
    [
      { row: 2, r2: '3.2.1', r3: '03.02.01', withdrawn: false, changeType: 'MINOR_CHANGE', newOdp: false, newRequirement: false },
      { row: 3, r2: '3.2.1', r3: '03.02.02', withdrawn: false, changeType: 'SIGNIFICANT_CHANGE', newOdp: true, newRequirement: false },
    ],
  );
  assert(dup.requirements['3.2.1'].targets.length === 2 && dup.requirements['3.2.1'].changeType === 'SIGNIFICANT_CHANGE' && dup.requirements['3.2.1'].newOdp === true, 'G105: a split requirement has several SAME targets, the most significant change and any new ODP', dup.requirements['3.2.1']);
  assert(throws(() => buildR2toR3Mapping(['3.1.1'], new Set(['03.01.02']), {}, [{ row: 2, r2: '3.1.1', r3: '03.01.01', withdrawn: false, changeType: 'MINOR_CHANGE', newOdp: false, newRequirement: false }]), /03\.01\.01 is not an active Rev\. 3 requirement/), 'G106: a workbook row naming an inactive requirement fails');

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  if (passed !== total) process.exitCode = 1;
})();
