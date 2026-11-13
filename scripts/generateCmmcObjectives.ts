/**
 * scripts/generateCmmcObjectives.ts
 *
 * Builds the CMMC assessment objectives the platform ships, from the DoD CIO's CMMC Assessment Guides (Level 2 and Level 1,
 * version 2.13, DISTRIBUTION STATEMENT A: approved for public release). Run by a maintainer when the Department publishes a new
 * version, never at runtime, and it never touches the network. The PDFs are not part of the repository; pass their paths:
 *
 *     npx tsx scripts/generateCmmcObjectives.ts --l2 <AssessmentGuideL2.pdf> --l1 <AssessmentGuideL1.pdf>
 *     npx tsx scripts/generateCmmcObjectives.ts --check [--l2 <pdf> --l1 <pdf>]
 *
 * --check without the PDFs validates the committed files; with the PDFs it also confirms they are the PDFs the files came from
 * (SHA-256) and that regenerating gives the committed files byte for byte.
 *
 * Outputs, in src/data/cmmcGuide/:
 *   cmmcL2Guide.generated.json   every Level 2 requirement: its statement and its lettered assessment objectives
 *   cmmcL1Guide.generated.json   the same for the 15 Level 1 (FAR 52.204-21) requirements, each objective tied to the 800-171
 *                                requirement and letter it is the same determination as
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { displayTitleOf, normalizeObjectiveText, validateGuideData } from '../src/data/cmmcGuide/validate';
import type { GuideMeta, L1GuideFile, L1Requirement, L2GuideFile, L2Requirement } from '../src/data/cmmcGuide/validate';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OUT = path.join(path.resolve(here, '..'), 'src', 'data', 'cmmcGuide');
const L2_FILE = 'cmmcL2Guide.generated.json';
const L1_FILE = 'cmmcL1Guide.generated.json';
const DASH = '–';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------------ PDF text
/** The PDF's text, one line per visual line, with "=== page N ===" markers. Only text is read; nothing in the PDF is run. */
export async function pdfToLines(buf: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, standardFontDataUrl: fontDir, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map<number, Array<{ x: number; s: string }>>();
    for (const item of content.items as any[]) {
      if (!('str' in item) || item.str === '') continue;
      const y = Math.round(item.transform[5]);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key)!.push({ x: item.transform[4], s: item.str });
    }
    out.push(`=== page ${p} ===`);
    for (const key of [...rows.keys()].sort((a, b) => b - a)) {
      const line = rows.get(key)!.sort((a, b) => a.x - b.x).map((i) => i.s).join('').replace(/\s+/g, ' ').trim();
      if (line) out.push(line);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ parsing
export interface ParsedRequirement {
  /** 'AC.L2-3.1.1', or 'PE.L1-b.1.ix' for Level 1 (FAR part lower-cased). */
  id: string;
  family: string;
  /** The title as the guide prints it in mixed case, tag included. */
  title: string;
  statement: string;
  objectives: Array<{ letter: string; text: string }>;
  /** The 800-171 requirements the KEY REFERENCES name. */
  numbers: string[];
  /** Level 2 only. */
  number?: string;
  /** Level 1 only: the FAR 52.204-21 paragraph. */
  far?: string;
}

export interface ParsedGuide {
  level: 1 | 2;
  /** From the cover page; null when the lines do not include it (a test excerpt). */
  version: string | null;
  date: string | null;
  documentNumber: string | null;
  distribution: string | null;
  pages: number;
  requirements: ParsedRequirement[];
}

const HEADING = /^([A-Z]{2})\.L([12])-(3\.\d{1,2}\.\d{1,2}|[Bb]\.1\.[ivxIVX]+) [–-] (.+)$/;
const FOOTER = /^CMMC Assessment Guide [–-] Level (\d) \| Version (\d+(?:\.\d+)*) \S+$/;
const isNoise = (l: string): boolean => /^=== page \d+ ===$/.test(l) || /^\d{1,3}$/.test(l) || /^CMMC Assessment Guide [–-] Level/.test(l) || /^NIST SP 800-171A, pp?\./.test(l);
/** Joins a wrapped line; a line that ends in a hyphen is a hyphenated word, so it joins with no space ("security-" + "related"). */
const joinLine = (acc: string, next: string): string => (acc === '' ? next : acc.endsWith('-') ? acc + next : `${acc} ${next}`);
// a trailing "; and" / "; or" goes, and so does an "and" the guide printed without its semicolon (IA.L2-3.5.8[a])
const cleanObjective = (t: string): string => t.replace(/\s+/g, ' ').trim().replace(/(?:[;.]\s*|\s)(?:and|or)$/, '').replace(/[;.]$/, '').trim();

export function parseGuideLines(lines: string[]): ParsedGuide {
  // cover and notices pages: version, date, document number, distribution statement
  let page = 0;
  let pages = 0;
  let version: string | null = null;
  let date: string | null = null;
  let documentNumber: string | null = null;
  let distribution: string | null = null;
  const footers = new Set<string>();
  for (const l of lines) {
    const pm = /^=== page (\d+) ===$/.exec(l);
    if (pm) {
      page = Number(pm[1]);
      pages = Math.max(pages, page);
      continue;
    }
    const f = FOOTER.exec(l);
    if (f) footers.add(`${f[1]}|${f[2]}`);
    if (page === 0 || page > 2) continue;
    const v = /^Version\s+(?:[–-]\s*)?(\d+(?:\.\d+)*)\s*\|\s*(.+)$/.exec(l);
    if (v) {
      version = v[1];
      date = v[2].trim();
    }
    const d = /^(DoD-CIO-\d+)\b/.exec(l);
    if (d) documentNumber = d[1];
    if (/^DISTRIBUTION STATEMENT A\./.test(l)) distribution = l.trim();
  }
  if (footers.size > 1) throw new Error(`the page footers disagree on the guide's level or version: ${[...footers].join(', ')}`);
  const footer = [...footers][0]?.split('|');
  if (version && footer && footer[1] !== version) throw new Error(`the cover says version ${version} but the footers say ${footer[1]}`);

  // each requirement: its upper-case heading, the "ASSESSMENT OBJECTIVES" line, and the section up to the next heading
  const found: Array<{ i: number; h: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ASSESSMENT OBJECTIVES \[NIST SP 800-171A\]/.test(lines[i])) continue;
    let h = i - 1;
    while (h >= 0 && !(HEADING.test(lines[h]) && lines[h] === lines[h].toUpperCase())) h--;
    if (h < 0) throw new Error(`ASSESSMENT OBJECTIVES at line ${i + 1} has no requirement heading before it`);
    found.push({ i, h });
  }
  if (found.length === 0) throw new Error('no requirements found');

  const requirements: ParsedRequirement[] = [];
  const seen = new Set<string>();
  found.forEach(({ i, h }, k) => {
    const m = HEADING.exec(lines[h])!;
    const family = m[1];
    const levelOf = Number(m[2]);
    const part = levelOf === 1 ? m[3].toLowerCase() : m[3];
    const id = `${family}.L${levelOf}-${part}`;
    if (seen.has(id)) throw new Error(`${id}: duplicate requirement`);
    seen.add(id);

    // the mixed-case heading printed just above the upper-case one carries the title as the contents page spells it
    const titleLine = lines.slice(Math.max(0, h - 3), h).map((l) => HEADING.exec(l)).find((x) => x && x[1] === family && x[2] === m[2] && x[3].toLowerCase() === m[3].toLowerCase());
    if (!titleLine) throw new Error(`${id}: no mixed-case title line above the heading`);

    let statement = '';
    for (const l of lines.slice(h + 1, i)) if (!isNoise(l)) statement = joinLine(statement, l);

    const objectives: Array<{ letter: string; text: string }> = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^POTENTIAL ASSESSMENT METHODS/.test(l)) break;
      if (isNoise(l) || /^Determine if:?$/.test(l)) continue;
      const o = /^\[([a-z])\]\s*(.*)$/.exec(l);
      if (o) objectives.push({ letter: o[1], text: o[2] });
      else if (objectives.length) objectives[objectives.length - 1].text = joinLine(objectives[objectives.length - 1].text, l);
      else objectives.push({ letter: '?', text: l });
    }
    for (const o of objectives) o.text = cleanObjective(o.text);
    if (objectives.length === 0) throw new Error(`${id}: no objectives`);
    objectives.forEach((o, n) => {
      if (o.letter === '?') throw new Error(`${id}: text before the first objective letter`);
      if (o.letter !== String.fromCharCode(97 + n)) throw new Error(`${id}: objective letters are not contiguous (${objectives.map((x) => x.letter).join('')})`);
      if (!o.text) throw new Error(`${id}[${o.letter}]: empty objective`);
    });

    // KEY REFERENCES, before the next requirement starts
    const end = k + 1 < found.length ? found[k + 1].h : lines.length;
    const numbers: string[] = [];
    let far: string | undefined;
    const keyAt = lines.slice(i, end).findIndex((l) => /^KEY REFERENCES/.test(l));
    if (keyAt >= 0) {
      for (const l of lines.slice(i + keyAt + 1, end)) {
        const n = /^\S?\s*NIST SP 800-171 Rev\. 2 (3\.\d{1,2}\.\d{1,2})\s*$/.exec(l);
        if (n && !numbers.includes(n[1])) numbers.push(n[1]);
        const f = /^\S?\s*FAR Clause 52\.204-21 (b\.1\.[ivx]+)\s*$/i.exec(l);
        if (f) far = f[1].toLowerCase();
      }
    }

    const req: ParsedRequirement = { id, family, title: titleLine[4].trim(), statement, objectives, numbers };
    if (levelOf === 2) {
      req.number = part;
      if (numbers.length === 0) req.numbers = [part];
      else if (numbers.length !== 1 || numbers[0] !== part) throw new Error(`${id}: KEY REFERENCES name ${numbers.join(', ')}`);
    } else {
      req.far = part;
      if (numbers.length === 0) throw new Error(`${id}: no 800-171 numbers in KEY REFERENCES`);
      if (far && far !== part) throw new Error(`${id}: KEY REFERENCES name FAR ${far}`);
    }
    requirements.push(req);
  });

  const levels = new Set(requirements.map((r) => (r.number ? 2 : 1)));
  if (levels.size !== 1) throw new Error('the guide mixes Level 1 and Level 2 requirements');
  const level = [...levels][0] as 1 | 2;
  if (footer && Number(footer[0]) !== level) throw new Error(`the footers say Level ${footer[0]} but the requirements are Level ${level}`);
  return { level, version: version ?? footer?.[1] ?? null, date, documentNumber, distribution, pages, requirements };
}

// ------------------------------------------------------------------------------------------------ building the files
export interface GuideSource {
  /** Any path; only its base name is stored. */
  file: string;
  sha256: string;
}

function metaOf(g: ParsedGuide, src: GuideSource): GuideMeta {
  for (const [k, v] of Object.entries({ version: g.version, date: g.date, documentNumber: g.documentNumber, distribution: g.distribution })) {
    if (!v) throw new Error(`Level ${g.level} guide: no ${k} on the cover pages`);
  }
  return {
    generatedBy: 'scripts/generateCmmcObjectives.ts',
    document: `CMMC Assessment Guide ${DASH} Level ${g.level}`,
    version: g.version!,
    date: g.date!,
    documentNumber: g.documentNumber!,
    distribution: g.distribution!,
    sourceFile: path.basename(src.file.replace(/\\/g, '/')),
    sha256: src.sha256,
    pages: g.pages,
  };
}

/** Level 1 text matches Level 2 text but for CUI becoming FCI, so compare with the two treated alike. */
const sameDetermination = (t: string): string => normalizeObjectiveText(t).replace(/\bcui\b/g, 'fci');

export function buildGuideFiles(l2: ParsedGuide, l1: ParsedGuide, sources: { l2: GuideSource; l1: GuideSource }): { l2: L2GuideFile; l1: L1GuideFile } {
  if (l2.level !== 2 || l1.level !== 1) throw new Error('buildGuideFiles needs the Level 2 guide first and the Level 1 guide second');
  const l2Reqs: L2Requirement[] = l2.requirements.map((r) => ({
    id: r.id,
    number: r.number!,
    family: r.family,
    title: r.title,
    displayTitle: displayTitleOf(r.title),
    statement: r.statement,
    objectives: r.objectives.map((o) => ({ letter: o.letter, text: o.text })),
  }));
  const byNumber = new Map(l2Reqs.map((r) => [r.number, r]));
  const l1Reqs: L1Requirement[] = l1.requirements.map((r) => ({
    id: r.id,
    far: r.far!,
    numbers: r.numbers,
    family: r.family,
    title: r.title,
    displayTitle: displayTitleOf(r.title),
    statement: r.statement,
    objectives: r.objectives.map((o) => {
      const matches: Array<{ number: string; letter: string }> = [];
      for (const n of r.numbers) {
        for (const x of byNumber.get(n)?.objectives ?? []) if (sameDetermination(x.text) === sameDetermination(o.text)) matches.push({ number: n, letter: x.letter });
      }
      if (matches.length !== 1) throw new Error(`${r.id}[${o.letter}] matches ${matches.length} Level 2 objectives (${matches.map((x) => `${x.number}[${x.letter}]`).join(', ') || 'none'}), expected exactly one`);
      return { letter: o.letter, text: o.text, number: matches[0].number, numberLetter: matches[0].letter };
    }),
  }));
  return {
    l2: { meta: metaOf(l2, sources.l2), requirements: l2Reqs },
    l1: { meta: metaOf(l1, sources.l1), requirements: l1Reqs },
  };
}

// ------------------------------------------------------------------------------------------------ main
const stable = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

function argOf(name: string): string | undefined {
  const k = process.argv.indexOf(name);
  return k >= 0 ? process.argv[k + 1] : undefined;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const l2Path = argOf('--l2');
  const l1Path = argOf('--l1');
  if (Boolean(l2Path) !== Boolean(l1Path)) throw new Error('give both --l2 and --l1, or neither');
  const committed = (name: string): any => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));

  if (!l2Path || !l1Path) {
    if (!check) throw new Error('usage: npx tsx scripts/generateCmmcObjectives.ts --l2 <AssessmentGuideL2.pdf> --l1 <AssessmentGuideL1.pdf>   (add --check to verify only)');
    const problems = validateGuideData(committed(L2_FILE), committed(L1_FILE));
    for (const p of problems) console.error(`PROBLEM: ${p}`);
    console.log(problems.length ? `${problems.length} problem(s)` : 'The committed CMMC guide data is consistent (the PDFs were not given, so it was not compared with them).');
    if (problems.length) process.exit(1);
    return;
  }

  const bufs = { l2: fs.readFileSync(l2Path), l1: fs.readFileSync(l1Path) };
  let differs = false;
  if (check) {
    for (const [lvl, file] of [['l2', L2_FILE], ['l1', L1_FILE]] as const) {
      if (!fs.existsSync(path.join(OUT, file)) || committed(file).meta?.sha256 !== sha256(bufs[lvl])) {
        console.error(`DIFFERENT SOURCE: ${lvl === 'l2' ? '--l2' : '--l1'} is not the PDF ${file} was generated from`);
        differs = true;
      }
    }
    if (differs) process.exit(1);
  }
  const l2 = parseGuideLines(await pdfToLines(bufs.l2));
  const l1 = parseGuideLines(await pdfToLines(bufs.l1));
  const built = buildGuideFiles(l2, l1, { l2: { file: l2Path, sha256: sha256(bufs.l2) }, l1: { file: l1Path, sha256: sha256(bufs.l1) } });
  const problems = validateGuideData(built.l2, built.l1);
  for (const p of problems) console.error(`PROBLEM: ${p}`);
  if (problems.length) process.exit(1);

  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, value] of [[L2_FILE, built.l2], [L1_FILE, built.l1]] as const) {
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
      console.log(`  wrote ${name} (${(text.length / 1024).toFixed(0)} KB)`);
    }
  }
  const total = (g: ParsedGuide): number => g.requirements.reduce((n, r) => n + r.objectives.length, 0);
  console.log(`\nLevel 2: ${l2.requirements.length} requirements, ${total(l2)} objectives (version ${l2.version}, ${l2.pages} pages). Level 1: ${l1.requirements.length} requirements, ${total(l1)} objectives (${l1.pages} pages).`);
  if (differs) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
