/**
 * scripts/generateNist80053.ts
 *
 * Builds the NIST SP 800-53 Rev. 5 data the platform ships, from NIST's own published sources. Run by a maintainer when NIST
 * publishes a new release, never at runtime:
 *
 *     npx tsx scripts/generateNist80053.ts            (downloads the sources, caches them in .cache/nist80053)
 *     npx tsx scripts/generateNist80053.ts --check    (regenerates in memory and fails if the committed files differ)
 *
 * Sources (public domain, NIST):
 *   - OSCAL catalog of SP 800-53 Rev. 5 and the SP 800-53A assessment procedures, with the Low / Moderate / High / Privacy
 *     baseline profiles (usnistgov/oscal-content, pinned to a commit below).
 *   - SP 800-171 Rev. 2, Appendix D (requirement -> security control mapping). Appendix D names Rev. 4 controls; each is carried
 *     to Rev. 5 through the incorporated-into / moved-to links that the OSCAL catalog records on withdrawn controls.
 *
 * Outputs, in src/data/frameworks/nist80053/:
 *   catalog.generated.json     every non-withdrawn base control and control enhancement, with its statement carrying the
 *                              [Assignment: ...] / [Selection: ...] tags, its guidance, and its baselines
 *   objectives.generated.json  the 800-53A determination statements per control, and the assessment methods
 *   crosswalk171.generated.json  800-171 Rev. 2 requirement -> 800-53 Rev. 5 controls
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseParameterTags } from '../src/data/frameworks/parameters';
import type { GeneratedControl, GeneratedObjective, GeneratedObjectives } from '../src/data/frameworks/nist80053/types';

const OSCAL_COMMIT = '78650f02ad9321bb7b817846f8fbd4f2bcd620de';
const OSCAL_BASE = `https://raw.githubusercontent.com/usnistgov/oscal-content/${OSCAL_COMMIT}/nist.gov/SP800-53/rev5/json`;
const SOURCES = {
  catalog: `${OSCAL_BASE}/NIST_SP-800-53_rev5_catalog.json`,
  low: `${OSCAL_BASE}/NIST_SP-800-53_rev5_LOW-baseline_profile.json`,
  moderate: `${OSCAL_BASE}/NIST_SP-800-53_rev5_MODERATE-baseline_profile.json`,
  high: `${OSCAL_BASE}/NIST_SP-800-53_rev5_HIGH-baseline_profile.json`,
  privacy: `${OSCAL_BASE}/NIST_SP-800-53_rev5_PRIVACY-baseline_profile.json`,
  sp800171r2: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r2.pdf',
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(here, '..');
const CACHE = path.join(ROOT, '.cache', 'nist80053');
const OUT = path.join(ROOT, 'src', 'data', 'frameworks', 'nist80053');

// ------------------------------------------------------------------------------------------------ OSCAL types (the parts we use)
interface Prop { name: string; value: string; class?: string }
interface Link { rel: string; href: string }
interface Param { id: string; label?: string; select?: { 'how-many'?: string; choice: string[] }; props?: Prop[] }
interface Part { id?: string; name: string; prose?: string; props?: Prop[]; parts?: Part[] }
interface OscalControl { id: string; title: string; params?: Param[]; props: Prop[]; links?: Link[]; parts?: Part[]; controls?: OscalControl[] }
interface OscalGroup { id: string; title: string; controls: OscalControl[] }

// ------------------------------------------------------------------------------------------------ fetching
async function source(name: string, url: string): Promise<Buffer> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}${path.extname(new URL(url).pathname)}`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------ catalog
const label = (props: Prop[] | undefined, cls?: string): string | undefined => props?.find((p) => p.name === 'label' && p.class === cls)?.value;
const isWithdrawn = (c: OscalControl): boolean => c.props.some((p) => p.name === 'status' && p.value === 'withdrawn');

/** "ac-2.1" -> "AC-2(1)"; the label property says it directly. */
const controlId = (c: OscalControl): string => label(c.props) ?? c.id.toUpperCase();
const oscalToId = (oscalId: string): string => {
  const m = oscalId.match(/^([a-z]{2})-(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`unexpected control id ${oscalId}`);
  return `${m[1].toUpperCase()}-${Number(m[2])}${m[3] ? `(${Number(m[3])})` : ''}`;
};

function* walk(controls: OscalControl[], parent?: OscalControl): Generator<{ control: OscalControl; parent?: OscalControl }> {
  for (const c of controls) {
    yield { control: c, parent };
    if (c.controls) yield* walk(c.controls, c);
  }
}

export function buildFromOscal(catalogJson: any, profiles: Record<'low' | 'moderate' | 'high' | 'privacy', any>): { controls: GeneratedControl[]; objectives: Record<string, GeneratedObjectives>; families: Array<{ code: string; title: string }>; withdrawnTo: Record<string, string[]>; version: string } {
  const catalog = catalogJson.catalog;
  const groups: OscalGroup[] = catalog.groups;
  const allParams = new Map<string, Param>();
  const all: Array<{ control: OscalControl; parent?: OscalControl; family: string }> = [];
  for (const g of groups) for (const w of walk(g.controls)) {
    all.push({ ...w, family: g.id.toUpperCase() });
    for (const p of w.control.params ?? []) allParams.set(p.id, p);
  }
  const baselineIds = (profile: any): Set<string> => new Set<string>(profile.profile.imports.flatMap((i: any) => (i['include-controls'] ?? []).flatMap((ic: any) => ic['with-ids'] ?? [])));
  const low = baselineIds(profiles.low), moderate = baselineIds(profiles.moderate), high = baselineIds(profiles.high), privacy = baselineIds(profiles.privacy);

  // --- ODP tags
  const renderParam = (id: string, depth = 0): string => {
    const p = allParams.get(id);
    if (!p || depth > 4) throw new Error(`unresolved parameter ${id}`);
    if (p.select) {
      const many = p.select['how-many'] === 'one-or-more';
      return `[Selection${many ? ' (one or more)' : ''}: ${p.select.choice.map((c) => render(c, depth + 1)).join('; ')}]`;
    }
    const l = (p.label ?? '').trim();
    return `[Assignment: ${/^organization-defined/i.test(l) ? l : `organization-defined ${l}`}]`;
  };
  const render = (text: string, depth = 0): string =>
    text.replace(/\{\{\s*insert:\s*param,\s*([^\s}]+)\s*\}\}/g, (_m, id: string) => renderParam(id, depth)).replace(/[ \t]+/g, ' ').trim();

  const statementOf = (parts: Part[] | undefined): string => {
    const out: string[] = [];
    const visit = (p: Part, depth: number): void => {
      const text = p.prose ? render(p.prose) : '';
      const lab = p.name === 'item' ? label(p.props) : undefined;
      if (text) out.push(`${'  '.repeat(depth)}${lab ? `${lab} ` : ''}${text}`);
      for (const c of p.parts ?? []) visit(c, p.name === 'statement' ? depth : depth + 1);
    };
    for (const p of (parts ?? []).filter((x) => x.name === 'statement')) visit(p, 0);
    return out.join('\n');
  };
  const guidanceOf = (parts: Part[] | undefined): string => render((parts ?? []).find((p) => p.name === 'guidance')?.prose ?? '').replace(/\s*\n\s*/g, ' ');

  // --- control rows
  const controls: GeneratedControl[] = [];
  const objectives: Record<string, GeneratedObjectives> = {};
  const withdrawnTo: Record<string, string[]> = {};
  for (const { control: c, parent, family } of all) {
    const id = controlId(c);
    if (isWithdrawn(c)) {
      withdrawnTo[id] = (c.links ?? []).filter((l) => l.rel === 'incorporated-into' || l.rel === 'moved-to').map((l) => l.href.replace(/^#/, '').replace(/_smt.*$/, ''));
      continue;
    }
    controls.push({
      id,
      title: c.title,
      family,
      kind: parent ? 'ENHANCEMENT' : 'BASE',
      ...(parent ? { parent: controlId(parent) } : {}),
      statement: statementOf(c.parts),
      guidance: guidanceOf(c.parts),
      baselines: (low.has(c.id) ? 'L' : '') + (moderate.has(c.id) ? 'M' : '') + (high.has(c.id) ? 'H' : ''),
      privacy: privacy.has(c.id),
      related: [...new Set((c.links ?? []).filter((l) => l.rel === 'related').map((l) => l.href.replace(/^#/, '')).filter((h) => /^[a-z]{2}-\d+(\.\d+)?$/.test(h)).map(oscalToId))],
    });

    // --- 800-53A
    const root = (c.parts ?? []).find((p) => p.name === 'assessment-objective');
    const list: GeneratedObjective[] = [];
    const visit = (p: Part, parentLabel?: string): void => {
      const lab = label(p.props, 'sp800-53a') ?? label(p.props) ?? '';
      const isRoot = p === root;
      if (!isRoot) {
        const letter = lab.replace(/^[A-Z]{2}-\d+(?:\(\d+\))?/, '').replace(/\.$/, '') || lab;
        list.push({ id: lab, letter, ...(parentLabel && parentLabel !== objRootLabel ? { parent: parentLabel } : {}), ...(p.prose ? { text: render(p.prose).replace(/\s*;\s*$/, '').replace(/\.$/, '') } : {}) });
      } else if (p.prose) {
        list.push({ id: lab, letter: 'a', text: render(p.prose).replace(/\s*;\s*$/, '').replace(/\.$/, '') });
      }
      for (const ch of p.parts ?? []) visit(ch, isRoot ? undefined : lab);
    };
    const objRootLabel = root ? label(root.props, 'sp800-53a') ?? label(root.props) ?? '' : '';
    if (root) visit(root);
    const method = (m: string): string[] => {
      const part = (c.parts ?? []).find((p) => p.name === 'assessment-method' && p.props?.some((x) => x.name === 'method' && x.value === m));
      const prose = part?.parts?.find((x) => x.name === 'assessment-objects')?.prose ?? '';
      return prose.split(/\n\s*\n/).map((s) => render(s).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
    };
    if (list.length) objectives[id] = { objectives: list, methods: { examine: method('EXAMINE'), interview: method('INTERVIEW'), test: method('TEST') } };
  }
  return { controls, objectives, families: groups.map((g) => ({ code: g.id.toUpperCase(), title: g.title })), withdrawnTo, version: catalog.metadata.version };
}

// ------------------------------------------------------------------------------------------------ SP 800-171 Rev. 2 Appendix D
async function appendixDLines(pdf: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), standardFontDataUrl: fontDir, verbosity: 0 }).promise;
  const lines: string[] = [];
  let inD = false;
  for (let i = 1; i <= doc.numPages; i++) {
    const text = (await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str + (x.hasEOL ? '\n' : ' ')).join('');
    if (/TABLE D-1:/.test(text)) inD = true;
    if (/^\s*APPENDIX E/m.test(text) && /TABLE E-1:/.test(text)) break;
    if (inD) lines.push(...text.split('\n'));
  }
  return lines;
}

/** The Rev. 4 controls Appendix D names for each requirement: "3.1.5" -> ["AC-6", "AC-6(1)", ...]. */
export function parseAppendixD(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let pending: string[] = [];
  let sawControl = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || /^(SECURITY REQUIREMENTS|Relevant Security Controls|ISO\/IEC|NIST SP 800-53|SP 800-171|APPENDIX|TABLE D|This publication|_+$|=+PAGE)/i.test(line)) continue;
    const req = line.match(/^3 ?\. ?(\d{1,2}) ?\. ?(\d{1,2})(?!\d)\s/);
    if (req) {
      if (sawControl) {
        pending = [];
        sawControl = false;
      }
      const id = `3.${req[1]}.${req[2]}`;
      pending.push(id);
      out[id] ??= [];
      continue;
    }
    const ctl = line.match(/^([A-Z]{2}) ?- ?(\d{1,2})(?: ?\( ?(\d{1,2}) ?\))?(?=\s|$)/);
    if (ctl && pending.length) {
      sawControl = true;
      const id = `${ctl[1]}-${Number(ctl[2])}${ctl[3] ? `(${Number(ctl[3])})` : ''}`;
      for (const r of pending) if (!out[r].includes(id)) out[r].push(id);
    }
  }
  return out;
}

/** Carries a Rev. 4 control to Rev. 5: itself if it still exists, else what NIST says it was incorporated into or moved to. */
export function toRev5(id: string, existing: Set<string>, withdrawnTo: Record<string, string[]>): { ids: string[]; viaWithdrawn: boolean } {
  if (existing.has(id)) return { ids: [id], viaWithdrawn: false };
  const targets = withdrawnTo[id] ?? [];
  const resolved = targets.map((t) => (/^[a-z]{2}-\d+(\.\d+)?$/.test(t) ? oscalToId(t) : t)).flatMap((t) => (existing.has(t) ? [t] : (withdrawnTo[t] ?? []).map((x) => (/^[a-z]{2}-/.test(x) ? oscalToId(x) : x)).filter((x) => existing.has(x))));
  return { ids: [...new Set(resolved)], viaWithdrawn: true };
}

// ------------------------------------------------------------------------------------------------ main
const stable = (v: unknown): string => JSON.stringify(v) + '\n';

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const bufs = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([k, u]) => [k, await source(k, u)]))) as Record<keyof typeof SOURCES, Buffer>;
  const parse = (b: Buffer): any => JSON.parse(b.toString('utf8'));
  const built = buildFromOscal(parse(bufs.catalog), { low: parse(bufs.low), moderate: parse(bufs.moderate), high: parse(bufs.high), privacy: parse(bufs.privacy) });

  // every generated tag must parse with the platform's own parser, and none may be left half-resolved
  let tags = 0;
  for (const c of built.controls) {
    if (/\{\{|\}\}/.test(c.statement + c.guidance)) throw new Error(`${c.id}: unresolved placeholder`);
    const found = parseParameterTags(c.statement, c.id);
    tags += found.length;
    const opens = (c.statement.match(/\[(Assignment|Selection)/g) ?? []).length;
    if (found.length !== opens && !/\[Selection[^\]]*\[Assignment/.test(c.statement)) throw new Error(`${c.id}: ${opens} tags but ${found.length} parsed`);
  }

  const existing = new Set(built.controls.map((c) => c.id));
  const rev4 = parseAppendixD(await appendixDLines(bufs.sp800171r2));
  const requirements = Object.keys(rev4);
  const crosswalk: Record<string, Array<{ control: string; rev4?: string }>> = {};
  const unresolved: string[] = [];
  for (const req of requirements.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const rows = new Map<string, { control: string; rev4?: string }>();
    for (const r4 of rev4[req]) {
      const { ids, viaWithdrawn } = toRev5(r4, existing, built.withdrawnTo);
      if (ids.length === 0) unresolved.push(`${req}: ${r4}`);
      for (const id of ids) if (!rows.has(id) || (rows.get(id)!.rev4 && !viaWithdrawn)) rows.set(id, viaWithdrawn ? { control: id, rev4: r4 } : { control: id });
    }
    crosswalk[req] = [...rows.values()];
  }
  if (requirements.length !== 110) throw new Error(`Appendix D parsed ${requirements.length} requirements, expected 110`);
  // A requirement may end up with no Rev. 5 control only if every Rev. 4 control it named was withdrawn without a successor
  // (3.13.14 names SC-19, Voice over Internet Protocol, which Rev. 5 withdrew). Anything else is a parsing problem.
  const withoutRev5: Record<string, string[]> = {};
  for (const [req, v] of Object.entries(crosswalk)) {
    if (v.length > 0) continue;
    if (rev4[req].length === 0 || rev4[req].some((r4) => existing.has(r4) || (built.withdrawnTo[r4]?.length ?? 0) > 0)) throw new Error(`requirement ${req} has no Rev. 5 control and the cause is not a withdrawn control`);
    withoutRev5[req] = rev4[req];
  }

  const meta = {
    generatedBy: 'scripts/generateNist80053.ts',
    oscalVersion: built.version,
    oscalCommit: OSCAL_COMMIT,
    sources: Object.fromEntries(Object.entries(bufs).map(([k, b]) => [k, { url: SOURCES[k as keyof typeof SOURCES], sha256: sha256(b) }])),
  };
  const files: Record<string, unknown> = {
    'catalog.generated.json': { meta, families: built.families, controls: built.controls },
    'objectives.generated.json': { meta: { ...meta, note: 'NIST SP 800-53A Rev. 5 determination statements, as published in the OSCAL catalog' }, objectives: built.objectives },
    'crosswalk171.generated.json': {
      meta: { ...meta, note: 'SP 800-171 Rev. 2 Appendix D names SP 800-53 Rev. 4 controls. "rev4" is set where the Rev. 4 control was withdrawn or moved in Rev. 5 and NIST\'s incorporated-into / moved-to link was followed.' },
      requirements: crosswalk,
      withdrawnWithoutSuccessor: withoutRev5,
    },
  };
  fs.mkdirSync(OUT, { recursive: true });
  let differs = false;
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(OUT, name);
    const text = stable(value);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        console.error(`DIFFERS: ${name}`);
        differs = true;
      }
    } else {
      fs.writeFileSync(file, text);
      console.log(`  wrote ${name} (${(text.length / 1024).toFixed(0)} KB)`);
    }
  }
  const baseCount = built.controls.filter((c) => c.kind === 'BASE').length;
  console.log(`\n${built.controls.length} controls (${baseCount} base, ${built.controls.length - baseCount} enhancements), ${tags} ODP tags, ${Object.keys(built.objectives).length} controls with 800-53A objectives, ${requirements.length} requirements crosswalked`);
  if (unresolved.length) console.log(`Appendix D controls with no Rev. 5 counterpart (${unresolved.length}): ${unresolved.join(', ')}`);
  if (differs) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
