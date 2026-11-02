/**
 * scripts/generateThirdPartyNotices.ts
 *
 * Writes THIRD_PARTY_NOTICES.txt: the licences of every third-party component a PBC-GRC container image contains, with
 * the licence texts the packages ship. PBC-GRC itself is proprietary (LICENSE); its permissive dependencies still require
 * their copyright notices to travel with the product, and the Alpine base image contains GPL-2.0 programs (BusyBox,
 * apk-tools) whose source must be made available to whoever receives the image.
 *
 *     npx tsx scripts/generateThirdPartyNotices.ts                 (prints the notices)
 *     npx tsx scripts/generateThirdPartyNotices.ts --out FILE      (writes them; the Dockerfile does this in the runner stage)
 *
 * The package list comes from package-lock.json (every non-dev entry), the licence texts from node_modules. Run inside
 * the image, the Alpine package database adds the operating-system packages. The script exits 1, writing nothing, when a
 * production dependency's licence is not on ALLOWED_LICENSES, so a dependency that cannot ship in a proprietary product
 * fails the image build instead of reaching a customer. Pure Node: no dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/** SPDX ids (and the legacy "BSD" some packages declare) that a proprietary product may ship with their notices. */
export const ALLOWED_LICENSES: readonly string[] = [
  'MIT', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0',
  'Unlicense', 'Python-2.0', 'CC-BY-4.0',
];

/** Packages whose lockfile entry carries no licence field; the value is what their own LICENSE file grants. */
export const DECLARED_BY_LICENSE_FILE: Readonly<Record<string, string>> = {
  busboy: 'MIT',
  streamsearch: 'MIT',
};

export interface NoticePackage {
  name: string;
  version: string;
  /** The licence expression the package declares. */
  declared: string;
  /** The licence this product uses it under: the declared one, or the permissive option elected from an OR. */
  used: string;
  allowed: boolean;
  /** Installed path relative to the repository root, when installed (optional platform binaries often are not). */
  installedAt: string | null;
}

const stripParens = (s: string): string => s.trim().replace(/^\(+|\)+$/g, '').trim();

/**
 * The licence a dual-licensed package is used under: from "A OR B" the first allowed option; "A AND B" needs every part
 * allowed. Returns the expression as used and whether it is allowed.
 */
export function electLicense(expression: string): { used: string; allowed: boolean } {
  const expr = stripParens(expression);
  if (/\sOR\s/.test(expr)) {
    const options = expr.split(/\s+OR\s+/).map(stripParens);
    const pick = options.find((o) => electLicense(o).allowed);
    return pick ? { used: `${pick} (elected from ${expr})`, allowed: true } : { used: expr, allowed: false };
  }
  if (/\sAND\s/.test(expr)) {
    const parts = expr.split(/\s+AND\s+/).map(stripParens);
    return { used: expr, allowed: parts.every((p) => ALLOWED_LICENSES.includes(p)) };
  }
  return { used: expr, allowed: ALLOWED_LICENSES.includes(expr) };
}

/** Every non-dev package in package-lock.json, sorted by name. */
export function collectPackages(root: string = ROOT): NoticePackage[] {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; license?: string; dev?: boolean }>;
  };
  const out: NoticePackage[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || entry.dev) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const declared = entry.license ?? DECLARED_BY_LICENSE_FILE[name] ?? 'UNKNOWN';
    const { used, allowed } = electLicense(declared);
    out.push({
      name,
      version: entry.version ?? '',
      declared,
      used,
      allowed,
      installedAt: fs.existsSync(path.join(root, key)) ? key : null,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)([.-].*)?$/i;

/** The licence and notice files a package ships, in a stable order. */
export function licenseTexts(root: string, installedAt: string | null): { file: string; text: string }[] {
  if (!installedAt) return [];
  const dir = path.join(root, installedAt);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n)).sort();
  } catch {
    return [];
  }
  return names.map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
}

/** Alpine packages from the apk database (present only inside the image). */
export function alpinePackages(dbPath = '/lib/apk/db/installed'): { name: string; version: string; license: string }[] {
  let raw: string;
  try {
    raw = fs.readFileSync(dbPath, 'utf8');
  } catch {
    return [];
  }
  const out: { name: string; version: string; license: string }[] = [];
  for (const record of raw.split(/\n\s*\n/)) {
    const field = (k: string) => record.match(new RegExp(`^${k}:(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const name = field('P');
    if (name) out.push({ name, version: field('V'), license: field('L') || 'UNKNOWN' });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function devVersion(root: string, name: string): string {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    return lock.packages[`node_modules/${name}`]?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const RULE = '='.repeat(100);

export function renderNotices(root: string = ROOT, apkDb?: string): string {
  const pkgs = collectPackages(root);
  const alpine = alpinePackages(apkDb);
  const lines: string[] = [];
  lines.push('THIRD-PARTY NOTICES for PBC-GRC ("Event Horizon: Singularity")');
  lines.push('');
  lines.push('PBC-GRC is proprietary software of Pitch Black Cyber, LLC (see LICENSE). It includes the third-party components');
  lines.push('below, each under its own licence. Nothing in the PBC-GRC licence limits the rights these licences grant.');
  lines.push('');
  lines.push(RULE);
  lines.push('1. Operating system and runtime (the node:22-alpine base image)');
  lines.push(RULE);
  lines.push('');
  lines.push(`Node.js ${process.version}: MIT licence, with the licences of its bundled dependencies (https://github.com/nodejs/node/blob/${process.version}/LICENSE).`);
  lines.push('');
  lines.push('Alpine Linux packages. Some are licensed under the GNU General Public License version 2 (notably BusyBox and');
  lines.push('apk-tools). The corresponding source code for every Alpine package is published by the Alpine Linux project');
  lines.push('(https://gitlab.alpinelinux.org/alpine/aports, at the release of the base image) and is also available from');
  lines.push('Pitch Black Cyber, LLC on request.');
  lines.push('');
  if (alpine.length > 0) {
    for (const a of alpine) lines.push(`  ${a.name} ${a.version}  ${a.license}`);
  } else {
    lines.push('  (The package list is filled in when this file is generated inside the image.)');
  }
  lines.push('');
  lines.push(RULE);
  lines.push('2. Node.js packages in the image (production dependencies, from package-lock.json)');
  lines.push(RULE);
  lines.push('');
  for (const p of pkgs) lines.push(`  ${p.name}@${p.version}  ${p.used}${p.installedAt ? '' : '  (optional, not installed on this platform)'}`);
  lines.push('');
  lines.push(RULE);
  lines.push('3. Build tools whose output is part of the browser bundle');
  lines.push(RULE);
  lines.push('');
  lines.push(`  vite@${devVersion(root, 'vite')}  MIT (module preload helper)`);
  lines.push(`  tailwindcss@${devVersion(root, 'tailwindcss')}  MIT (generated stylesheet, including its base reset)`);
  lines.push('');
  lines.push(RULE);
  lines.push('4. Fonts (public/fonts)');
  lines.push(RULE);
  lines.push('');
  lines.push('  Inter (Rasmus Andersson) and JetBrains Mono (JetBrains): SIL Open Font License 1.1 (https://openfontlicense.org).');
  lines.push('');
  lines.push(RULE);
  lines.push('5. Components not in the image (pulled separately, under their own licences)');
  lines.push(RULE);
  lines.push('');
  lines.push('  docker-compose.yml pulls postgres (PostgreSQL License) and, with the "ai" profile, ollama/ollama (MIT).');
  lines.push('  The language model the operator installs into Ollama carries its own licence (for llama3.2: the Llama 3.2');
  lines.push('  Community License Agreement and Acceptable Use Policy of Meta).');
  lines.push('  pbc-vm-exporter (exporters/pbc-vm-exporter, proprietary, see its LICENSE) is installed by the customer with pip,');
  lines.push('  which fetches requests (Apache-2.0) and its dependencies urllib3 (MIT), idna (BSD-3-Clause),');
  lines.push('  charset-normalizer (MIT) and certifi (MPL-2.0).');
  lines.push('');
  lines.push(RULE);
  lines.push('6. Licence texts shipped by the Node.js packages');
  lines.push(RULE);
  for (const p of pkgs) {
    const texts = licenseTexts(root, p.installedAt);
    if (texts.length === 0) continue;
    lines.push('');
    lines.push(`----- ${p.name}@${p.version} (${p.used}) -----`);
    for (const t of texts) {
      lines.push(`[${t.file}]`);
      lines.push(t.text);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const outIndex = process.argv.indexOf('--out');
  const outFile = outIndex > -1 ? process.argv[outIndex + 1] : null;
  const refused = collectPackages().filter((p) => !p.allowed);
  if (refused.length > 0) {
    console.error('[notices] these production dependencies have a licence that is not on the allow list (scripts/generateThirdPartyNotices.ts):');
    for (const p of refused) console.error(`  ${p.name}@${p.version}: ${p.declared}`);
    process.exit(1);
  }
  const text = renderNotices();
  if (outFile) {
    fs.writeFileSync(outFile, text);
    console.log(`[notices] wrote ${outFile}`);
  } else {
    process.stdout.write(text);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
