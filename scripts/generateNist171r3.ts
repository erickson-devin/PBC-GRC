/**
 * scripts/generateNist171r3.ts
 *
 * Builds the NIST SP 800-171 Rev. 3 data the platform ships, from NIST's own published sources. Run by a maintainer when NIST
 * publishes a new release, never at runtime:
 *
 *     npx tsx scripts/generateNist171r3.ts            (downloads the sources, caches them in .cache/nist171r3)
 *     npx tsx scripts/generateNist171r3.ts --check    (regenerates in memory and fails if the committed files differ)
 *
 * Sources (public domain, NIST):
 *   - OSCAL catalog of SP 800-171 Rev. 3 with the SP 800-171A Rev. 3 assessment objectives and methods, the organization-defined
 *     parameters (ODPs) and the links of the withdrawn requirements (usnistgov/oscal-content, pinned to a commit below).
 *   - NIST's change analysis workbook, SP 800-171 Rev. 2 to Rev. 3 (xlsx). Read with jszip.
 *
 * Outputs, in src/data/frameworks/nist171r3/ (shapes: types.ts):
 *   catalog.generated.json     every active requirement with its statement carrying the [Assignment: ...] / [Selection: ...] tags,
 *                              its discussion and ODP ids, the ODP table, and the withdrawn requirements with their successors
 *   objectives.generated.json  the SP 800-171A determination statements per requirement, and the assessment methods
 *   r2r3.generated.json        SP 800-171 Rev. 2 requirement -> Rev. 3 requirement(s), change type, new ODP, new in Rev. 3
 *
 * Nothing is counted by hand: the checks below compare the sources with each other and with the platform's own Rev. 2 catalog.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { parseParameterTags } from '../src/data/frameworks/parameters';
import { crosswalkRequirements } from '../src/data/frameworks/nist80053/crosswalk';
import type { GeneratedMeta, GeneratedObjective, GeneratedObjectives } from '../src/data/frameworks/nist80053/types';
import type {
  GeneratedR2R3Entry,
  GeneratedR2R3File,
  GeneratedR2R3Target,
  GeneratedR3CatalogFile,
  GeneratedR3Odp,
  GeneratedR3Requirement,
  GeneratedR3Withdrawn,
  R3ChangeType,
} from '../src/data/frameworks/nist171r3/types';
import { DOD_ODP_DEFAULTS } from '../src/data/frameworks/nist171r3/odpDefaults';
import { checkDodDefaults } from '../src/data/frameworks/nist171r3/odp';

const OSCAL_COMMIT = '5006f18c8047643eaa70e35dd0d20a58bcc41856';
const SOURCES = {
  catalog: `https://raw.githubusercontent.com/usnistgov/oscal-content/${OSCAL_COMMIT}/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json`,
  changeAnalysis: 'https://csrc.nist.gov/files/pubs/sp/800/171/r3/final/docs/sp800-171r2-to-r3-analysis.xlsx',
} as const;
// csrc.nist.gov refuses clients that do not look like a browser
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CACHE = path.join(ROOT, '.cache', 'nist171r3');
const OUT = path.join(ROOT, 'src', 'data', 'frameworks', 'nist171r3');

// ------------------------------------------------------------------------------------------------ OSCAL types (the parts we use)
interface Prop { name: string; value: string; class?: string }
interface Link { rel: string; href: string }
interface Param { id: string; label?: string; usage?: string; props?: Prop[]; select?: { 'how-many'?: string; choice: string[] }; guidelines?: Array<{ prose: string }> }
interface Part { id?: string; name: string; prose?: string; props?: Prop[]; parts?: Part[] }
interface OscalControl { id: string; title: string; class?: string; params?: Param[]; props: Prop[]; links?: Link[]; parts?: Part[]; controls?: OscalControl[] }
interface OscalGroup { id: string; title: string; controls: OscalControl[] }

// ------------------------------------------------------------------------------------------------ fetching
async function source(name: string, url: string): Promise<Buffer> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}${path.extname(new URL(url).pathname)}`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------ identifiers
const R3_ID = /^03\.\d{2}\.\d{2}$/;
const R2_ID = /^3\.\d{1,2}\.\d{1,2}$/;

/**
 * "3.1.1", "03.01.01", "03.01.10\t" (a spreadsheet cell with trailing white space) -> "03.01.01". Spreadsheets drop leading zeros
 * and NIST's workbook carries stray tabs and line breaks, so both are repaired here. Anything else is an error.
 */
export function normalizeR3Id(raw: string): string {
  const m = raw.replace(/[\s ]+/g, '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) throw new Error(`not a requirement identifier: ${JSON.stringify(raw)}`);
  return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3].padStart(2, '0')}`;
}
/** "03.01.01" -> "3.1.1". */
export const r2IdOf = (r3Id: string): string => r3Id.split('.').map((p) => String(Number(p))).join('.');

const compareIds = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

// ------------------------------------------------------------------------------------------------ catalog
const INSERT_RE = /\{\{\s*insert:\s*param,\s*([^\s}]+)\s*\}\}/g;
const propOf = (props: Prop[] | undefined, name: string): string | undefined => props?.find((p) => p.name === name)?.value;
const isWithdrawn = (c: OscalControl): boolean => c.props.some((p) => p.name === 'status' && p.value === 'withdrawn');

/** Where an ODP is used while a requirement's text is rendered. */
interface Collector {
  /** ODP ids of the outermost tags of the statement, in order. */
  order: string[];
  /** Assignments inside a Selection of the statement: ODP id -> number of the Selection tag. */
  nested: Map<string, number>;
  /** Tags opened in the statement, outermost and nested. */
  opened: number;
  /** Every ODP id any part of the requirement inserts. */
  refs: Set<string>;
  /** True while the statement is rendered: only then do inserts become numbered tags. */
  statement: boolean;
}

const WITHDRAWN_RELATIONS: Record<string, GeneratedR3Withdrawn['relation']> = { incorporated_into: 'INCORPORATED_INTO', addressed_by: 'ADDRESSED_BY' };

/** Natural order of an objective suffix: "a", "a.01", "b.01", "b.02", "01", "02". Letters sort before numbers. */
function compareSuffix(a: string, b: string): number {
  const ta = a.split('.').filter(Boolean);
  const tb = b.split('.').filter(Boolean);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    if (ta[i] === tb[i]) continue;
    const na = /^\d+$/.test(ta[i]);
    const nb = /^\d+$/.test(tb[i]);
    if (na && nb) return Number(ta[i]) - Number(tb[i]);
    if (na !== nb) return na ? 1 : -1;
    return ta[i] < tb[i] ? -1 : 1;
  }
  return ta.length - tb.length;
}

export interface BuiltR3 {
  requirements: GeneratedR3Requirement[];
  families: Array<{ code: string; title: string }>;
  /** Withdrawn requirement -> the ids it was moved to (empty: none). */
  withdrawn: Record<string, string[]>;
  /** The same with the relation NIST gives. */
  withdrawnLinks: Record<string, GeneratedR3Withdrawn[]>;
  odps: Record<string, GeneratedR3Odp>;
  objectives: Record<string, GeneratedObjectives>;
  version: string;
}

export function buildR3FromOscal(catalogJson: any): BuiltR3 {
  const catalog = catalogJson.catalog;
  const groups: OscalGroup[] = catalog.groups;
  const params = new Map<string, Param>();
  const all: Array<{ control: OscalControl; family: string }> = [];
  for (const g of groups) {
    const family = g.id.replace(/^.*_(\d{2}\.\d{2})$/, '$1');
    if (!/^03\.\d{2}$/.test(family)) throw new Error(`unexpected family id ${g.id}`);
    for (const control of g.controls) {
      if (control.controls?.length) throw new Error(`${control.id}: nested controls are not expected`);
      all.push({ control, family });
      for (const p of control.params ?? []) params.set(p.id, p);
    }
  }

  const odpIdOf = (p: Param): string => {
    const v = propOf(p.props, 'label');
    if (!v) throw new Error(`parameter ${p.id} has no label property`);
    return v;
  };
  /** The markup of NIST's cross references ("[](#/cprt/...)03.01.02") reduces to the plain id that follows. */
  const clean = (text: string): string => text.replace(/\[\]\([^)]*\)/g, '').replace(/[ \t]+/g, ' ').trim();

  const renderParam = (oscalId: string, depth: number, col: Collector, parentTag?: number): string => {
    const p = params.get(oscalId);
    if (!p || depth > 4) throw new Error(`unresolved parameter ${oscalId}`);
    const odp = odpIdOf(p);
    col.refs.add(odp);
    let tag: number | undefined;
    if (col.statement) {
      col.opened++;
      if (depth === 0) {
        col.order.push(odp);
        tag = col.order.length;
      } else col.nested.set(odp, parentTag as number);
    }
    if (p.select) {
      const many = p.select['how-many'] === 'one-or-more';
      return `[Selection${many ? ' (one or more)' : ''}: ${p.select.choice.map((c) => inserts(c, depth + 1, col, depth === 0 ? tag : parentTag)).join('; ')}]`;
    }
    // In the requirement text NIST's `usage` is the wording the publication prints (for example "organization-defined functions,
    // ports, protocols, connections, and services"); the short `label` is what the 800-171A statements use.
    const l = ((col.statement ? p.usage : undefined) ?? p.label ?? '').trim();
    return `[Assignment: ${/^organization-defined/i.test(l) ? l : `organization-defined ${l}`}]`;
  };
  const inserts = (text: string, depth: number, col: Collector, parentTag?: number): string =>
    text.replace(INSERT_RE, (_m, id: string) => renderParam(id, depth, col, parentTag)).replace(/[ \t]+/g, ' ').trim();
  const render = (text: string, col: Collector): string => clean(inserts(text, 0, col));

  /** "SR-03.01.01.c.01" -> "1." for a numbered sub-item, "c." for a lettered one. */
  const itemLabel = (p: Part, sortId: string): string => {
    const raw = propOf(p.props, 'label') ?? '';
    const prefix = `SR-${sortId}.`;
    if (!raw.startsWith(prefix)) throw new Error(`${sortId}: unexpected item label ${raw}`);
    const last = raw.slice(prefix.length).split('.').pop() as string;
    return /^\d+$/.test(last) ? `${Number(last)}.` : `${last}.`;
  };
  const statementOf = (parts: Part[] | undefined, sortId: string, col: Collector): string => {
    const out: string[] = [];
    const visit = (p: Part, depth: number): void => {
      const text = p.prose ? render(p.prose, col) : '';
      const lab = p.name === 'item' ? itemLabel(p, sortId) : undefined;
      if (text) out.push(`${'  '.repeat(depth)}${lab ? `${lab} ` : ''}${text}`);
      for (const c of p.parts ?? []) visit(c, p.name === 'statement' ? depth : depth + 1);
    };
    for (const p of (parts ?? []).filter((x) => x.name === 'statement')) visit(p, 0);
    return out.join('\n');
  };

  const requirements: GeneratedR3Requirement[] = [];
  const odps: Record<string, GeneratedR3Odp> = {};
  const objectives: Record<string, GeneratedObjectives> = {};
  const withdrawn: Record<string, string[]> = {};
  const withdrawnLinks: Record<string, GeneratedR3Withdrawn[]> = {};
  for (const { control: c, family } of all) {
    const sortId = propOf(c.props, 'sort-id');
    if (!sortId || !R3_ID.test(sortId)) throw new Error(`${c.id}: sort-id ${JSON.stringify(sortId)} is not a requirement id`);
    if (isWithdrawn(c)) {
      const links: GeneratedR3Withdrawn[] = [];
      for (const l of c.links ?? []) {
        if (l.rel === 'reference') continue;
        const relation = WITHDRAWN_RELATIONS[l.rel];
        if (!relation) throw new Error(`${sortId}: unexpected link relation ${l.rel}`);
        links.push({ id: normalizeR3Id(l.href.replace(/^#/, '')), relation });
      }
      withdrawnLinks[sortId] = links;
      withdrawn[sortId] = links.map((l) => l.id);
      continue;
    }

    const col: Collector = { order: [], nested: new Map(), opened: 0, refs: new Set(), statement: true };
    const statement = statementOf(c.parts, sortId, col);
    col.statement = false;
    const guidance = (c.parts ?? []).find((p) => p.name === 'guidance')?.prose ?? '';
    const discussion = render(guidance, col).replace(/\s*\n\s*/g, ' ');

    // --- SP 800-171A: the determination statements (flat, one per OSCAL assessment-objective part) and the methods
    const list: Array<{ suffix: string; o: GeneratedObjective }> = [];
    const objectivePrefix = `assessment-objective_DS-A.${sortId}`;
    for (const p of (c.parts ?? []).filter((x) => x.name === 'assessment-objective')) {
      if (!p.id || !p.id.startsWith(objectivePrefix) || !p.prose) throw new Error(`${sortId}: unexpected assessment objective ${p.id}`);
      const suffix = p.id.slice(objectivePrefix.length).replace(/^\./, '');
      const text = render(p.prose, col).replace(/\s*;\s*$/, '').replace(/\.$/, '');
      list.push({ suffix, o: { id: p.id.replace(/^assessment-objective_DS-/, ''), letter: suffix.toLowerCase().replace(/[^a-z0-9]/g, '') || 'a', text } });
    }
    list.sort((a, b) => compareSuffix(a.suffix, b.suffix));

    // --- ODPs
    const objectiveList: GeneratedObjective[] = [];
    for (const p of c.params ?? []) {
      const id = odpIdOf(p);
      const first = col.order.indexOf(id);
      if (first !== col.order.lastIndexOf(id)) throw new Error(`${sortId}: ${id} is inserted in more than one tag`);
      if (!col.refs.has(id)) throw new Error(`${sortId}: ${id} is not referenced by the statement, the objectives or the discussion`);
      const guideline = (p.guidelines ?? []).map((g) => g.prose.trim()).filter(Boolean).join(' ');
      const placement: GeneratedR3Odp['placement'] = first >= 0 ? 'TAG' : col.nested.has(id) ? 'NESTED' : 'OBJECTIVES';
      if (odps[id]) throw new Error(`duplicate ODP id ${id}`);
      odps[id] = {
        requirement: sortId,
        tag: first >= 0 ? first + 1 : null,
        placement,
        ...(placement === 'NESTED' ? { parentTag: col.nested.get(id) } : {}),
        label: p.select ? 'Selection' : (p.label ?? '').trim().replace(/^organization-defined\s+/i, ''),
        kind: p.select ? 'SELECTION' : 'ASSIGNMENT',
        ...(guideline ? { guideline } : {}),
      };
      // NIST's ODP determination statement ("the time period ... is defined") comes first, as SP 800-171A lists it
      if (guideline) objectiveList.push({ id, letter: `odp${id.replace(/^.*ODP\[(\d+)\]$/, '$1')}`, text: guideline.replace(/\s*;\s*$/, '').replace(/\.$/, '') });
    }
    objectiveList.push(...list.map((x) => x.o));
    const letters = objectiveList.map((o) => o.letter);
    if (new Set(letters).size !== letters.length || !letters.every((l) => /^[a-z0-9]+$/.test(l))) throw new Error(`${sortId}: objective letters are not unique: ${letters.join(', ')}`);

    // --- tags: every generated tag must parse with the platform's own parser, in the order the ODP list records, none half-resolved
    const found = parseParameterTags(statement, sortId);
    if (found.length !== col.order.length) throw new Error(`${sortId}: ${col.order.length} tags but ${found.length} parsed`);
    const opens = (statement.match(/\[\s*(Assignment|Selection)\b/gi) ?? []).length;
    if (opens !== col.opened) throw new Error(`${sortId}: ${col.opened} tags opened but ${opens} found in the text`);
    found.forEach((f, i) => {
      if (f.kind !== odps[col.order[i]].kind) throw new Error(`${sortId}: tag ${i + 1} is a ${f.kind} but ${col.order[i]} is a ${odps[col.order[i]].kind}`);
    });

    const method = (m: string): string[] => {
      const part = (c.parts ?? []).find((p) => p.name === 'assessment-method' && p.props?.some((x) => x.name === 'method' && x.value === m));
      const prose = part?.parts?.find((x) => x.name === 'assessment-objects')?.prose ?? '';
      return prose.split(/\n\s*\n/).map((s) => clean(s).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
    };
    if (objectiveList.length) objectives[sortId] = { objectives: objectiveList, methods: { examine: method('EXAMINE'), interview: method('INTERVIEW'), test: method('TEST') } };

    const methods = objectives[sortId]?.methods;
    const text = [statement, discussion, ...objectiveList.map((o) => o.text ?? ''), ...(methods ? [...methods.examine, ...methods.interview, ...methods.test] : [])].join('\n');
    if (/\{\{|\}\}/.test(text)) throw new Error(`${sortId}: unresolved placeholder`);
    if (/\]\(/.test(text)) throw new Error(`${sortId}: unresolved link markup`);

    requirements.push({ id: sortId, title: c.title, family, statement, discussion, odps: col.order });
  }
  requirements.sort((a, b) => compareIds(a.id, b.id));
  return {
    requirements,
    families: groups.map((g) => ({ code: g.id.replace(/^.*_(\d{2}\.\d{2})$/, '$1'), title: g.title })),
    withdrawn,
    withdrawnLinks,
    odps,
    objectives,
    version: catalog.metadata.version,
  };
}

/** Cross-references inside the catalog: every withdrawn requirement points at active requirements, every requirement has its family. */
export function verifyR3Build(built: BuiltR3): void {
  const active = new Set(built.requirements.map((r) => r.id));
  const families = new Set(built.families.map((f) => f.code));
  const problems: string[] = [];
  for (const r of built.requirements) if (!families.has(r.family)) problems.push(`${r.id}: unknown family ${r.family}`);
  for (const [id, targets] of Object.entries(built.withdrawn)) {
    if (active.has(id)) problems.push(`${id} is both active and withdrawn`);
    for (const t of targets) if (!active.has(t)) problems.push(`${id} was moved to ${t}, which is not an active requirement`);
  }
  for (const [id, odp] of Object.entries(built.odps)) {
    if (!active.has(odp.requirement)) problems.push(`${id} belongs to ${odp.requirement}, which is not an active requirement`);
  }
  if (problems.length) throw new Error(`catalog check failed:\n  ${problems.join('\n  ')}`);
}

// ------------------------------------------------------------------------------------------------ xlsx
const decodeXml = (s: string): string =>
  s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}
const textRuns = (xml: string): string => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
const columnIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The cells of one sheet of an xlsx as rows of strings (row n is rows[n - 1], column A is index 0; gaps are ''). `sheet` is a sheet name, default the first sheet. */
export async function readXlsxRows(buf: Buffer, sheet?: string): Promise<string[][]> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (name: string): Promise<string> => {
    const f = zip.file(name);
    if (!f) throw new Error(`xlsx: ${name} is missing`);
    return f.async('string');
  };
  const sheets = [...(await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*>/g)].map((m) => attrs(m[0]));
  const chosen = sheet === undefined ? sheets[0] : sheets.find((s) => s.name === sheet);
  if (!chosen) throw new Error(`xlsx: no sheet ${sheet === undefined ? '(any)' : JSON.stringify(sheet)}`);
  const rels = [...(await read('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\b[^>]*>/g)].map((m) => attrs(m[0]));
  const target = rels.find((r) => r.Id === chosen['r:id'])?.Target;
  if (!target) throw new Error('xlsx: the sheet has no relationship');
  const sheetXml = await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  const shared = zip.file('xl/sharedStrings.xml') ? [...(await read('xl/sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1])) : [];

  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attrs(rowMatch[1]).r) - 1;
    const cells: string[] = [];
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      const col = columnIndex((a.r ?? '').replace(/\d+/g, ''));
      const body = c[2] ?? '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (a.t === 'inlineStr') value = textRuns(body);
      else if (a.t === 's') value = v ? (shared[Number(v[1])] ?? '') : '';
      else value = v ? decodeXml(v[1]) : '';
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = cells;
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------ the change analysis workbook
export interface ComparisonRow {
  /** Row number in the sheet. */
  row: number;
  /** Rev. 2 identifier ("3.1.1"); absent on a requirement that is new in Rev. 3. */
  r2?: string;
  /** Rev. 3 identifier ("03.01.01"). */
  r3: string;
  withdrawn: boolean;
  /** Set on a requirement Rev. 3 carries (not withdrawn, not new). */
  changeType?: R3ChangeType;
  newOdp: boolean;
  newRequirement: boolean;
}

const mark = (v: string | undefined): boolean => (v ?? '').trim().toUpperCase() === 'X';

export function parseComparisonRows(rows: string[][]): { rows: ComparisonRow[]; corrections: string[] } {
  const header = (rows[0] ?? []).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
  const col = (title: string): number => {
    const i = header.indexOf(title);
    if (i < 0) throw new Error(`change analysis sheet: no column "${title}" (found: ${header.join(' | ')})`);
    return i;
  };
  const C = {
    r2: col('sp 800-171 r2 identifier'),
    r3: col('sp 800-171 r3 identifier'),
    none: col('no significant change'),
    significant: col('significant change'),
    minor: col('minor change'),
    newOdp: col('new odp'),
    newReq: col('new requirement'),
    withdrawn: col('withdrawn requirement'),
  };
  const out: ComparisonRow[] = [];
  const corrections: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    if (!cells.some((c) => c.trim())) continue;
    const r3 = normalizeR3Id(cells[C.r3] ?? '');
    const withdrawn = mark(cells[C.withdrawn]);
    let r2 = (cells[C.r2] ?? '').trim() ? normalizeR3Id(cells[C.r2]) : undefined;
    // A withdrawn Rev. 3 requirement keeps its Rev. 2 number. If the workbook names another one, the Rev. 3 identifier wins.
    if (withdrawn && r2 !== r3) {
      corrections.push(`row ${i + 1}: Rev. 2 identifier ${r2 ? JSON.stringify(r2IdOf(r2)) : 'missing'} on withdrawn Rev. 3 requirement ${r3}; ${r2IdOf(r3)} used`);
      r2 = r3;
    }
    const marks = [
      [mark(cells[C.none]), 'NO_SIGNIFICANT_CHANGE'],
      [mark(cells[C.significant]), 'SIGNIFICANT_CHANGE'],
      [mark(cells[C.minor]), 'MINOR_CHANGE'],
    ].filter(([on]) => on) as Array<[boolean, R3ChangeType]>;
    const newRequirement = mark(cells[C.newReq]);
    if (!withdrawn && r2 && marks.length !== 1) throw new Error(`row ${i + 1} (${r3}): ${marks.length} change type marks, expected one`);
    if (newRequirement !== (!withdrawn && !r2)) throw new Error(`row ${i + 1} (${r3}): the new requirement mark disagrees with the missing Rev. 2 identifier`);
    out.push({ row: i + 1, ...(r2 ? { r2: r2IdOf(r2) } : {}), r3, withdrawn, ...(!withdrawn && r2 ? { changeType: marks[0][1] } : {}), newOdp: mark(cells[C.newOdp]), newRequirement });
  }
  const ids = out.map((r) => r.r3);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`change analysis sheet: Rev. 3 identifier listed twice: ${dup.join(', ')}`);
  return { rows: out, corrections };
}

/** The workbook against the catalog: same requirements, same withdrawn set. Throws with every disagreement. */
export function checkComparison(rows: ComparisonRow[], built: BuiltR3): void {
  const active = new Set(built.requirements.map((r) => r.id));
  const withdrawn = new Set(Object.keys(built.withdrawn));
  const problems: string[] = [];
  const seen = new Set(rows.map((r) => r.r3));
  for (const r of rows) {
    if (r.withdrawn && !withdrawn.has(r.r3)) problems.push(`row ${r.row}: ${r.r3} is withdrawn in the workbook, not in the catalog`);
    if (!r.withdrawn && !active.has(r.r3)) problems.push(`row ${r.row}: ${r.r3} is active in the workbook, not in the catalog`);
  }
  for (const id of [...active, ...withdrawn]) if (!seen.has(id)) problems.push(`${id} is in the catalog but not in the workbook`);
  if (problems.length) throw new Error(`workbook and catalog disagree:\n  ${problems.join('\n  ')}`);
}

const SEVERITY: Record<R3ChangeType, number> = { NO_SIGNIFICANT_CHANGE: 0, MINOR_CHANGE: 1, SIGNIFICANT_CHANGE: 2 };

/**
 * Classifies every Rev. 2 requirement.
 *  - an active Rev. 3 row of the workbook names it: target = that row's identifier (relation SAME, the number may differ), change
 *    type and new-ODP mark from the row (several rows: the most significant change, any new ODP);
 *  - Rev. 3 withdrew it (its number is a withdrawn placeholder): the targets are the successors NIST links, relation from the link;
 *    with none it is listed in withdrawnWithoutSuccessor;
 *  - without the workbook (`comparison` omitted) a Rev. 2 number that is still an active Rev. 3 id is SAME.
 * A requirement none of this classifies is an error. Rev. 3 requirements no Rev. 2 requirement leads to are newInR3.
 */
export function buildR2toR3Mapping(
  r2Ids: string[],
  r3Ids: Set<string>,
  withdrawn: Record<string, Array<string | GeneratedR3Withdrawn>>,
  comparison?: ComparisonRow[],
): { requirements: Record<string, GeneratedR2R3Entry>; withdrawnWithoutSuccessor: Record<string, true>; newInR3: string[] } {
  const activeRows = new Map<string, ComparisonRow[]>();
  for (const row of comparison ?? []) if (!row.withdrawn && row.r2) activeRows.set(row.r2, [...(activeRows.get(row.r2) ?? []), row]);
  const links = (id: string): GeneratedR3Withdrawn[] =>
    (withdrawn[id] ?? []).map((l) => (typeof l === 'string' ? { id: l, relation: 'INCORPORATED_INTO' as const } : l));

  const requirements: Record<string, GeneratedR2R3Entry> = {};
  const withdrawnWithoutSuccessor: Record<string, true> = {};
  const unclassified: string[] = [];
  const targeted = new Set<string>();
  for (const r2 of [...r2Ids].sort(compareIds)) {
    if (!R2_ID.test(r2)) throw new Error(`not a Rev. 2 requirement identifier: ${JSON.stringify(r2)}`);
    const placeholder = normalizeR3Id(r2);
    const rows = comparison ? (activeRows.get(r2) ?? []) : r3Ids.has(placeholder) ? [{ r3: placeholder } as ComparisonRow] : [];
    const isWithdrawn = placeholder in withdrawn;
    if (rows.length === 0 && !isWithdrawn) {
      unclassified.push(r2);
      continue;
    }
    const targets = new Map<string, GeneratedR2R3Target>();
    for (const row of rows) targets.set(row.r3, { id: row.r3, relation: 'SAME' });
    if (isWithdrawn) for (const l of links(placeholder)) if (!targets.has(l.id)) targets.set(l.id, { id: l.id, relation: l.relation });
    for (const t of targets.keys()) {
      if (!r3Ids.has(t)) throw new Error(`${r2}: target ${t} is not an active Rev. 3 requirement`);
      targeted.add(t);
    }
    const entry: GeneratedR2R3Entry = { targets: [...targets.values()] };
    if (comparison && rows.length) {
      entry.changeType = rows.map((r) => r.changeType as R3ChangeType).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
      entry.newOdp = rows.some((r) => r.newOdp);
    }
    if (rows.length === 0) entry.withdrawn = true;
    if (entry.targets.length === 0) withdrawnWithoutSuccessor[r2] = true;
    requirements[r2] = entry;
  }
  if (unclassified.length) throw new Error(`Rev. 2 requirements that Rev. 3 neither carries nor withdraws (${unclassified.length}): ${unclassified.join(', ')}`);
  return { requirements, withdrawnWithoutSuccessor, newInR3: [...r3Ids].filter((id) => !targeted.has(id)).sort(compareIds) };
}

// ------------------------------------------------------------------------------------------------ main
const stable = (v: unknown): string => JSON.stringify(v) + '\n';

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const bufs = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([k, u]) => [k, await source(k, u)]))) as Record<keyof typeof SOURCES, Buffer>;
  const built = buildR3FromOscal(JSON.parse(bufs.catalog.toString('utf8')));
  verifyR3Build(built);
  const dodProblems = checkDodDefaults(DOD_ODP_DEFAULTS, built.odps);
  if (dodProblems.length) throw new Error(`DoD ODP defaults check failed:\n  ${dodProblems.join('\n  ')}`);

  const sheet = parseComparisonRows(await readXlsxRows(bufs.changeAnalysis, 'Change Analysis 800-171 R2-R3'));
  checkComparison(sheet.rows, built);
  const r2Ids = crosswalkRequirements();
  const r3Ids = new Set(built.requirements.map((r) => r.id));
  const mapping = buildR2toR3Mapping(r2Ids, r3Ids, built.withdrawnLinks, sheet.rows);
  // A requirement the mapping calls new must be one the workbook calls new. The reverse can differ: NIST marks a requirement New
  // although its change analysis withdraws Rev. 2 requirements into it (03.10.07). The mapping follows the links, and says so.
  const newInWorkbook = new Set(sheet.rows.filter((r) => r.newRequirement).map((r) => r.r3));
  const notNew = mapping.newInR3.filter((id) => !newInWorkbook.has(id));
  if (notNew.length) throw new Error(`the mapping leaves ${notNew.join(', ')} new but the workbook does not mark them new`);
  for (const id of [...newInWorkbook].sort(compareIds)) {
    if (mapping.newInR3.includes(id)) continue;
    const from = Object.entries(mapping.requirements).filter(([, e]) => e.targets.some((t) => t.id === id)).map(([r2]) => r2);
    sheet.corrections.push(`${id} is marked New Requirement in the workbook, but Rev. 2 requirement(s) ${from.join(', ')} lead to it through NIST's withdrawn-requirement links; it is not listed in newInR3`);
  }

  const meta: GeneratedMeta = {
    generatedBy: 'scripts/generateNist171r3.ts',
    oscalVersion: built.version,
    oscalCommit: OSCAL_COMMIT,
    sources: Object.fromEntries(Object.entries(bufs).map(([k, b]) => [k, { url: SOURCES[k as keyof typeof SOURCES], sha256: sha256(b) }])),
  };
  const catalogFile: GeneratedR3CatalogFile = { meta, families: built.families, requirements: built.requirements, odps: built.odps, withdrawn: built.withdrawnLinks };
  const mappingFile: GeneratedR2R3File = {
    meta: { ...meta, note: 'Rev. 2 requirement -> Rev. 3 requirement(s). SAME: the active Rev. 3 row of NIST\'s change analysis for the requirement (its number can differ). INCORPORATED_INTO / ADDRESSED_BY: the successors NIST links on the withdrawn Rev. 3 requirement.' },
    ...mapping,
    corrections: sheet.corrections,
  };
  const files: Record<string, unknown> = {
    'catalog.generated.json': catalogFile,
    'objectives.generated.json': { meta: { ...meta, note: 'NIST SP 800-171A Rev. 3 determination statements and assessment methods, as published in the OSCAL catalog' }, objectives: built.objectives },
    'r2r3.generated.json': mappingFile,
  };
  fs.mkdirSync(OUT, { recursive: true });
  let differs = false;
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(OUT, name);
    const text = stable(value);
    if (check) {
      // a Windows checkout may have converted the line endings of the committed file
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text) {
        console.error(`DIFFERS: ${name}`);
        differs = true;
      }
    } else {
      fs.writeFileSync(file, text);
      console.log(`  wrote ${name} (${Buffer.byteLength(text)} bytes)`);
    }
  }

  const relations: Record<string, number> = {};
  const changes: Record<string, number> = {};
  for (const e of Object.values(mapping.requirements)) {
    for (const t of e.targets) relations[t.relation] = (relations[t.relation] ?? 0) + 1;
    if (e.changeType) changes[e.changeType] = (changes[e.changeType] ?? 0) + 1;
  }
  const objectiveCount = Object.values(built.objectives).reduce((n, o) => n + o.objectives.length, 0);
  console.log(
    `\n${built.requirements.length} requirements in ${built.families.length} families, ${Object.keys(built.withdrawn).length} withdrawn, ` +
      `${Object.keys(built.odps).length} ODPs, ${Object.keys(built.objectives).length} requirements with ${objectiveCount} objectives`,
  );
  console.log(`mapping: ${Object.keys(mapping.requirements).length} Rev. 2 requirements, relations ${JSON.stringify(relations)}, changes ${JSON.stringify(changes)}, ${mapping.newInR3.length} new in Rev. 3, ${Object.keys(mapping.withdrawnWithoutSuccessor).length} withdrawn without successor`);
  for (const c of sheet.corrections) console.log(`workbook correction: ${c}`);
  if (differs) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
