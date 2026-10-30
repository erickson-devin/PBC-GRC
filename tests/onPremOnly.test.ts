import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import { readAppVersion } from '../server/version';

/**
 * On-prem only guard (Phase 5.8). PBC-GRC is deployed on the customer's own hardware: local accounts, local disk,
 * PostgreSQL. This pure suite (no server, no port) fails if a cloud-provider code path, dependency, deploy script or
 * identifier creeps back into the repository, and it pins the network shape of docker-compose.yml.
 *
 * Part 1 scans code and config for removed-cloud tokens. It does not scan prose for vendor names in general: option catalogs
 * (the stack survey, Enclave Settings), guidance text and placeholder="e.g. …" examples may name a vendor. It does pin (#122)
 * that no SSP, export or handover DEFAULT names a cloud vendor: the customer states its own providers (empty value, an
 * example in the placeholder). Catalog content (below) is exempt because it must never be edited.
 * Part 2 reads docker-compose.yml textually (no YAML library).
 */
const root = process.cwd();
const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');

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

// ----------------------------------------------------------------------------- file walking

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', 'build', 'coverage']);
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|json|sql|sh|ps1|css|html|yml|yaml)$/i;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), accept, out);
    } else if (accept(path.join(dir, entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Catalog content that describes customer environments and must never be edited: exempt from the whole scan.
const CATALOG_EXEMPT: Array<(r: string) => boolean> = [
  (r) => r.startsWith('src/data/frameworks/'),
  (r) => r.startsWith('src/data/stigs/'),
  (r) => r === 'src/data/cmmcLevel1Controls.ts',
  (r) => r === 'scripts/seed80053Objectives.ts',
  (r) => r.endsWith('.generated.json'),
];
const isCatalog = (r: string) => CATALOG_EXEMPT.some((f) => f(r));

const SELF = 'tests/onPremOnly.test.ts';
const files: string[] = [
  ...walk(path.join(root, 'server'), (f) => CODE_EXT.test(f)),
  ...walk(path.join(root, 'src'), (f) => CODE_EXT.test(f)),
  ...walk(path.join(root, 'scripts'), (f) => CODE_EXT.test(f)),
  ...walk(path.join(root, 'tests'), (f) => CODE_EXT.test(f)),
  ...walk(path.join(root, 'exporters'), (f) => /\.py$/i.test(f)),
  ...walk(path.join(root, '.github', 'workflows'), (f) => /\.ya?ml$/i.test(f)),
  ...['package.json', 'Dockerfile', 'docker-compose.yml', '.env.example', 'vite.config.ts'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
]
  .filter((f) => rel(f) !== SELF)
  .filter((f) => !isCatalog(rel(f)));
const text = new Map(files.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]));

// ----------------------------------------------------------------------------- Part 1: guard scan

console.log('--- Removed files ---');
for (const f of [
  'deploy-gcp.sh',
  'deploy-gcp.ps1',
  'cors.json',
  'src/config/firebase.ts',
  'src/config/devAuthToken.ts',
  'src/services/gcsService.ts',
  'src/data/schema.sql',
]) {
  assert(!fs.existsSync(path.join(root, f)), `${f} does not exist`);
}

console.log('\n--- Dependencies ---');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const REMOVED_DEPS = ['firebase', 'firebase-admin', '@google-cloud/storage'];
for (const block of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  const names = Object.keys(pkg[block] ?? {});
  assert(REMOVED_DEPS.every((d) => !names.includes(d)), `package.json ${block} lists none of ${REMOVED_DEPS.join(', ')}`, names.filter((n) => REMOVED_DEPS.includes(n)));
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const lockKeys = Object.keys(lock.packages ?? {});
for (const d of REMOVED_DEPS) {
  assert(!lockKeys.includes(`node_modules/${d}`), `package-lock.json has no node_modules/${d}`);
}

console.log('\n--- Removed tokens (code and config only, never prose) ---');
// Case-insensitive tokens, exempt nowhere (catalog files are excluded from the scan entirely).
const TOKENS: Array<{ name: string; re: RegExp }> = [
  { name: 'firebase', re: /firebase/i },
  { name: '@google-cloud', re: /@google-cloud/i },
  { name: 'gcsService', re: /gcsService/i },
  { name: 'verifyIdToken', re: /verifyIdToken/i },
  { name: 'getSignedUrl', re: /getSignedUrl/i },
  { name: 'VITE_FIREBASE', re: /VITE_FIREBASE/i },
  { name: 'VITE_GCP', re: /VITE_GCP/i },
  { name: 'VITE_GCS', re: /VITE_GCS/i },
  { name: '/cloudsql/', re: /\/cloudsql\//i },
  { name: 'deploy-gcp', re: /deploy-gcp/i },
  { name: 'isLocalAuthMode', re: /isLocalAuthMode/i },
  { name: 'uploadFileToGcs', re: /uploadFileToGcs/i },
  { name: 'getAuthMode', re: /getAuthMode/i },
  // The removed server helper, as a call. Case-SENSITIVE and not preceded by an identifier character, so the client
  // function getStorageProvider() in src/data/audit/storageDriver.ts is not a hit.
  { name: 'storageProvider(', re: /(^|[^A-Za-z0-9_$])storageProvider\(/ },
];
for (const t of TOKENS) {
  const hits: string[] = [];
  for (const [file, body] of text) {
    body.split(/\r?\n/).forEach((line, i) => {
      if (t.re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert(hits.length === 0, `no file contains ${t.name}`, hits.slice(0, 10));
}

// Legacy stored values: these names may still appear where old rows or types are described, nowhere else.
const LEGACY_EXEMPT: Array<{ token: string; re: RegExp; allowedIn: string[]; why: string }> = [
  { token: 'gcs_signed_url', re: /gcs_signed_url/i, allowedIn: ['src/types/cmmc.ts', 'server/db.ts'], why: 'type union of historic sync_status values; in-memory test emulator' },
  { token: 'gcs_synced', re: /gcs_synced/i, allowedIn: ['src/types/cmmc.ts', 'server/db.ts'], why: 'type union of historic sync_status values; in-memory test emulator' },
];
console.log('\n  Exemptions for legacy sync_status values (file -> token -> reason):');
for (const e of LEGACY_EXEMPT) console.log(`    ${e.allowedIn.join(', ')} -> ${e.token} -> ${e.why}`);
for (const e of LEGACY_EXEMPT) {
  const hits: string[] = [];
  for (const [file, body] of text) {
    if (e.allowedIn.includes(file)) continue;
    body.split(/\r?\n/).forEach((line, i) => {
      if (e.re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert(hits.length === 0, `${e.token} appears only in ${e.allowedIn.join(' and ')}`, hits.slice(0, 10));
}

// The install never points at the vendor's hosted domain: URLs are built from the install's own origin. Only the legal
// text may carry a vendor URL; the sidebar's Photon link comes from VITE_PHOTON_URL (#93).
console.log('\n--- Vendor URLs ---');
const VENDOR_URL = /https?:\/\/[A-Za-z0-9.-]*pitchblackcyber\.com/i;
const VENDOR_URL_ALLOWED = ['src/components/common/LegalModal.tsx'];
{
  const hits: string[] = [];
  for (const [file, body] of text) {
    if (VENDOR_URL_ALLOWED.includes(file)) continue;
    body.split(/\r?\n/).forEach((line, i) => {
      if (VENDOR_URL.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert(hits.length === 0, `a pitchblackcyber.com URL appears only in ${VENDOR_URL_ALLOWED.join(' and ')}`, hits.slice(0, 10));
}

// The Photon link is opt-in: no built-in vendor URL in the sidebar.
{
  const sb = (text.get('src/components/layout/Sidebar.tsx') ?? '').replace(/\r\n/g, '\n');
  assert(sb.includes('VITE_PHOTON_URL'), 'Sidebar.tsx reads VITE_PHOTON_URL');
  assert(!/beta\.vpn|:8800/.test(sb), 'Sidebar.tsx has no built-in Photon host or port');
  assert(/\.\.\.\(photonUrl\s*\?/.test(sb), 'Sidebar.tsx adds the Photon item only when photonUrl is set');
}

// The Accretion modal has no fake sensor key: the endpoint is built from the install's own origin.
{
  const registry = (text.get('src/data/telemetry/assetRegistry.ts') ?? '').replace(/\r\n/g, '\n');
  const modal = (text.get('src/components/telemetry/AccretionIntegrationModal.tsx') ?? '').replace(/\r\n/g, '\n');
  assert(registry.length > 0 && !registry.includes('acc_live_sk_'), 'assetRegistry.ts generates no acc_live_sk_ key');
  assert(!registry.includes('pbc_accretion_cfg_v1_'), 'assetRegistry.ts keeps no pbc_accretion_cfg_v1_ browser config');
  assert(modal.length > 0 && !modal.includes('secretKey'), 'AccretionIntegrationModal.tsx has no secretKey');
  assert(modal.includes('discoveryEndpointUrl('), 'AccretionIntegrationModal.tsx builds the URL with discoveryEndpointUrl(');
  assert(modal.includes('/api/v1/vm/ingest'), 'AccretionIntegrationModal.tsx points scheduled pushes at /api/v1/vm/ingest');
}

console.log('\n  Whole-file exemptions (catalog content, never edited): src/data/frameworks/**, src/data/stigs/**, src/data/cmmcLevel1Controls.ts, scripts/seed80053Objectives.ts, *.generated.json');
assert(files.length > 100, 'the scan actually covered the repository', files.length);
assert(text.has('server/index.ts') && text.has('package.json') && text.has('docker-compose.yml') && text.has('Dockerfile') && text.has('.env.example'), 'the scan includes server, package.json, compose, Dockerfile and .env.example');
assert(![...text.keys()].some((k) => isCatalog(k)), 'no exempt catalog file was scanned');

// ----------------------------------------------------------------------------- Vendor defaults (#122)

console.log('\n--- Vendor defaults (#122) ---');
const VENDOR = /Microsoft|Google|Cloudflare|\bAWS\b|Amazon Web Services|Azure|Okta|\bGCS\b|\bGCP\b|Cloud SQL|Firebase|GCC High|Entra|CrowdStrike|Intune|Splunk/;
// A string literal that follows `||` or `??` (a fallback), or that is the value of an SSP / boundary / content field.
const FALLBACK_LITERAL = /(?:\|\||\?\?)\s*[`'"]([^`'"]*)/g;
const FIELD_LITERAL = /\b(?:cloudServiceProviders|systemEnvironment|boundaryDescription|systemBoundaryScope|boundarySummary|content)\s*:\s*[`'"]([^`'"]*)/g;
function vendorDefaults(body: string): string[] {
  const src = body.replace(/\r\n/g, '\n');
  const found: string[] = [];
  for (const re of [FALLBACK_LITERAL, FIELD_LITERAL]) {
    for (const m of src.matchAll(re)) found.push(m[1]);
  }
  return found.filter((s) => VENDOR.test(s)).map((s) => s.trim().slice(0, 80));
}
assert(vendorDefaults("x || 'Google Cloud Platform, Microsoft 365.'").length === 1, 'helper: a vendor fallback literal is found');
assert(vendorDefaults('{text ||\n  `The boundary includes Microsoft 365 services`}').length === 1, 'helper: a vendor fallback template on the next line is found');
assert(vendorDefaults("cloudServiceProviders: 'AWS GovCloud'").length === 1, 'helper: a vendor field literal is found');
assert(vendorDefaults('placeholder="e.g. Microsoft 365 GCC High (leave empty if none)"').length === 0, 'helper: a placeholder example is not a default');
assert(vendorDefaults("name: 'Microsoft Entra ID (Commercial)'").length === 0, 'helper: an option catalog entry is not a default');
assert(vendorDefaults("cloudServiceProviders: meta.cloudServiceProviders || ''").length === 0, 'helper: an empty default is clean');

const DEFAULT_SCOPE = (k: string) =>
  k.startsWith('src/components/') || k.startsWith('src/data/reports/') || k.startsWith('src/data/storage/') || k === 'src/data/onboardingDefaults.ts';
{
  const offenders: string[] = [];
  for (const [k, body] of text) {
    if (!DEFAULT_SCOPE(k)) continue;
    for (const lit of vendorDefaults(body)) offenders.push(`${k}: ${lit}`);
  }
  assert(offenders.length === 0, 'S122-1: no SSP, export or handover default names a cloud vendor', offenders);
}
{
  const offenders: string[] = [];
  for (const [k, body] of text) {
    if (!k.startsWith('src/data/reports/') && !k.startsWith('src/data/storage/')) continue;
    body.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => { if (VENDOR.test(line)) offenders.push(`${k}:${i + 1}`); });
  }
  assert(offenders.length === 0, 'S122-2: no line of the report compilers or storage engines names a vendor', offenders);
}
const T122 = ['src/components/reports/ArtifactExportModal.tsx', 'src/data/reports/documentCompilers.ts', 'src/data/storage/offboardingEngine.ts', 'src/components/settings/EnclaveSettings.tsx'];
assert(T122.every((k) => text.has(k)), 'S122-3: the scan includes the four #122 target files');
{
  const modal122 = text.get('src/components/reports/ArtifactExportModal.tsx') ?? '';
  const off122 = text.get('src/data/storage/offboardingEngine.ts') ?? '';
  const dc122 = text.get('src/data/reports/documentCompilers.ts') ?? '';
  assert(modal122.includes("cloudServiceProviders: meta.cloudServiceProviders || '',") && modal122.includes("systemEnvironment: meta.systemEnvironment || '',"), 'S122-4: the export form starts with an empty provider list and environment');
  assert(off122.includes("cloudServiceProviders: sspMeta?.cloudServiceProviders || '',"), 'S122-4: the handover package reads the SSP provider list and states none of its own');
  assert(dc122.includes('|| NO_CSP_RECORDED'), 'S122-4: the SSP section 1.3 falls back to NO_CSP_RECORDED');
}

// ----------------------------------------------------------------------------- Part 2: container and config shape

console.log('\n--- docker-compose.yml ---');
const composeRaw = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8').split(/\r?\n/);
const compose = composeRaw.filter((l) => !/^\s*#/.test(l));

interface Service {
  name: string;
  lines: string[];
}
const services: Service[] = [];
{
  let inServices = false;
  let cur: Service | null = null;
  for (const line of compose) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      cur = null;
      continue;
    }
    if (!inServices) continue;
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], lines: [] };
      services.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
}

/** Items of a 4-space-indented list section (`ports:`, `volumes:`) in a service. */
function listOf(svc: Service, key: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of svc.lines) {
    if (/^ {4}\S/.test(line)) {
      inList = new RegExp(`^ {4}${key}:\\s*$`).test(line);
      continue;
    }
    if (inList) {
      const m = /^\s+-\s*(.*?)\s*$/.exec(line);
      if (m) out.push(m[1].replace(/^["']|["']$/g, ''));
    }
  }
  return out;
}
/** Keys of a 4-space-indented mapping section (`environment:`) in a service. */
function mapOf(svc: Service, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inMap = false;
  for (const line of svc.lines) {
    if (/^ {4}\S/.test(line)) {
      inMap = new RegExp(`^ {4}${key}:\\s*$`).test(line);
      continue;
    }
    if (inMap) {
      const m = /^ {6}([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const APP = 'singularity-app';
const app = services.find((s) => s.name === APP);
assert(services.length >= 3 && !!app, 'compose declares the database, the app and the optional ollama service', services.map((s) => s.name));
for (const svc of services.filter((s) => s.name !== APP)) {
  const ports = listOf(svc, 'ports');
  assert(ports.every((p) => p.startsWith('127.0.0.1:')), `${svc.name}: every published port is bound to 127.0.0.1 (or none is published)`, ports);
}
const db = services.find((s) => s.name === 'singularity-db');
assert(!!db && listOf(db, 'ports').length === 1, 'singularity-db publishes exactly one port, on localhost', db && listOf(db, 'ports'));
const ollama = services.find((s) => s.name === 'ollama');
assert(!!ollama && listOf(ollama, 'ports').length === 0, 'ollama publishes no port');
if (app) {
  const ports = listOf(app, 'ports');
  assert(ports.length === 1 && ports[0] === '${APP_PUBLISH_ADDRESS:-0.0.0.0}:${APP_PORT:-3000}:3000', 'the app publishes exactly "${APP_PUBLISH_ADDRESS:-0.0.0.0}:${APP_PORT:-3000}:3000" (APP_PUBLISH_ADDRESS=127.0.0.1 behind a TLS proxy)', ports);
  const env = mapOf(app, 'environment');
  assert('ALLOW_TENANT_CREATION' in env && 'LOCAL_AUTH_TOKEN_TTL_SECONDS' in env, 'app environment passes ALLOW_TENANT_CREATION and LOCAL_AUTH_TOKEN_TTL_SECONDS through', Object.keys(env));
  assert(!app.lines.some((l) => /^\s+disable:\s*true\b/.test(l)), 'the app service does not disable the image healthcheck');
  assert(app.lines.some((l) => /^ {4}logging:\s*$/.test(l)) && /max-size/.test(app.lines.join('\n')), 'the app service rotates its container logs (logging with max-size)');
  assert(env.APP_BIND_ADDRESS === '${APP_BIND_ADDRESS:-0.0.0.0}', 'app environment: APP_BIND_ADDRESS: ${APP_BIND_ADDRESS:-0.0.0.0}', env.APP_BIND_ADDRESS);
  assert(env.AUTH_MODE === 'local', 'app environment: AUTH_MODE: local', env.AUTH_MODE);
  assert(!('APP_PORT' in env), 'app environment has no APP_PORT key (the container always listens on 3000)');
  assert(env.MFA_REQUIRED === '${MFA_REQUIRED:-}', 'app environment: MFA_REQUIRED: ${MFA_REQUIRED:-} (empty means the default, all)', env.MFA_REQUIRED);
  assert(env.MFA_ENCRYPTION_KEY === '${MFA_ENCRYPTION_KEY:-}', 'app environment: MFA_ENCRYPTION_KEY: ${MFA_ENCRYPTION_KEY:-} (optional)', env.MFA_ENCRYPTION_KEY);
  assert(!('GOOGLE_APPLICATION_CREDENTIALS' in env) && Object.keys(env).every((k) => !/^(GOOGLE_|GCP_|GCS_|FIREBASE_)/i.test(k)), 'app environment has no cloud-provider variables', Object.keys(env));
}
assert(services.every((s) => s.lines.some((l) => /^ {4}logging:\s*$/.test(l)) && /max-size/.test(s.lines.join('\n'))), 'every service rotates its container logs (logging with max-size)', services.filter((s) => !s.lines.some((l) => /^ {4}logging:\s*$/.test(l))).map((s) => s.name));
assert(compose.some((l) => /^\s+-?\s*subnet:\s*172\.30\.0\.0\/24\s*$/.test(l)), 'the bridge network pins subnet 172.30.0.0/24 (a stable TRUST_PROXY address for a host proxy)');
assert(!compose.some((l) => /network_mode\s*:\s*["']?host/.test(l)), 'no service uses network_mode: host');
assert(!!db && listOf(db, 'volumes').some((v) => v.startsWith('${INITDB_DIR:-./docker/postgres}:')), 'the db init mount uses ${INITDB_DIR:-./docker/postgres}', db && listOf(db, 'volumes'));
assert(!!db && listOf(db, 'volumes').some((v) => v.startsWith('${DB_DATA_DIR:-postgres_data}:/var/lib/postgresql/data')), 'the db data volume is ${DB_DATA_DIR:-postgres_data} (host path on Unraid, named volume elsewhere)', db && listOf(db, 'volumes'));
assert(!!app && listOf(app, 'volumes').some((v) => v.startsWith('${EVIDENCE_DIR:-./data/evidence}:/app/data/evidence')), 'the evidence vault mount is ${EVIDENCE_DIR:-./data/evidence}', app && listOf(app, 'volumes'));
assert(!!ollama && listOf(ollama, 'volumes').some((v) => v.startsWith('${OLLAMA_MODELS_DIR:-ollama-models}:/root/.ollama')), 'the ollama model store is ${OLLAMA_MODELS_DIR:-ollama-models}', ollama && listOf(ollama, 'volumes'));
assert(!compose.some((l) => /\/mnt\//.test(l)), 'no host-specific /mnt path is hard-coded outside comments (Unraid values live in .env)', compose.filter((l) => /\/mnt\//.test(l)));

console.log('\n--- Dockerfile and .env.example ---');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
assert(!/GOOGLE_/.test(dockerfile), 'Dockerfile has no GOOGLE_ variable');
const healthcheck = dockerfile.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n').match(/HEALTHCHECK[\s\S]*?(?:\n(?=[A-Z]+\s)|$)/);
assert(!!healthcheck && /\/api\/v1\/health\b/.test(healthcheck[0]), 'the Dockerfile HEALTHCHECK targets /api/v1/health', healthcheck && healthcheck[0]);
assert(!!healthcheck && /127\.0\.0\.1:3000/.test(healthcheck[0]) && !/localhost/.test(healthcheck[0]), 'the Dockerfile HEALTHCHECK uses 127.0.0.1:3000 (localhost may resolve to IPv6 against an IPv4 bind)', healthcheck && healthcheck[0]);
// Global tsx installs in a Dockerfile: the pinned version, or null for an unpinned install. Comments are ignored.
function globalTsxPins(text: string): (string | null)[] {
  const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  return [...code.matchAll(/npm\s+(?:install|i)\s+(?:-g|--global)\s+tsx(?:@(\S+))?(?=\s|$)/g)].map((m) => m[1] ?? null);
}
assert(JSON.stringify(globalTsxPins('RUN npm install -g tsx\n')) === '[null]', 'globalTsxPins reports an unpinned install as null');
assert(JSON.stringify(globalTsxPins('RUN npm install -g tsx@4.23.13\r\n')) === '["4.23.13"]', 'globalTsxPins reads a pinned version from a CRLF line');
assert(globalTsxPins('# RUN npm install -g tsx\n').length === 0, 'globalTsxPins ignores a commented-out install');
// The Dockerfile has no global npm install: tsx (and its esbuild) is a production dependency installed from package-lock.json.
const dockerCode = dockerfile.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
const runnerStart = dockerCode.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner\s*$/i.test(l));
const runner = runnerStart < 0 ? [] : dockerCode.slice(runnerStart + 1);
function globalNpmInstalls(text: string): number {
  const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  return (code.match(/npm\s+(?:install|i)\s+(?:-g|--global)\b/g) ?? []).length;
}
assert(globalTsxPins(dockerfile).length === 0, 'the Dockerfile does not install tsx globally', globalTsxPins(dockerfile));
assert(globalNpmInstalls('RUN npm i --global esbuild\n') === 1 && globalNpmInstalls('# RUN npm install -g x\n') === 0 && globalNpmInstalls(dockerfile) === 0, 'the Dockerfile has no global npm install of anything');
assert(/^CMD \["node_modules\/\.bin\/tsx", "server\/index\.ts"\]\s*$/m.test(dockerfile) && !/^CMD \["tsx",/m.test(dockerfile), 'the Dockerfile starts the server with the tsx from node_modules');
assert(dockerCode.filter((l) => /^CMD\s/.test(l)).length === 1 && !dockerCode.some((l) => /^ENTRYPOINT\s/.test(l)), 'the Dockerfile has exactly one CMD and no ENTRYPOINT');
assert(runner.length > 0 && runner.filter((l) => /^RUN npm ci --omit=dev\s*$/.test(l)).length === 1 && runner.some((l) => /^COPY package\*\.json \.\/\s*$/.test(l)) && !runner.some((l) => /\bnpx\b/.test(l)), 'the runner stage installs from the lockfile once (npm ci --omit=dev) and never calls npx');
assert(typeof pkg.dependencies?.tsx === 'string' && pkg.devDependencies?.tsx === undefined, 'tsx is a production dependency, not a devDependency', { dep: pkg.dependencies?.tsx, dev: pkg.devDependencies?.tsx });
const lockRoot = lock.packages?.[''] ?? {};
assert(lockRoot.dependencies?.tsx === pkg.dependencies?.tsx && lockRoot.devDependencies?.tsx === undefined, 'package-lock.json lists tsx under the root dependencies with the same range', { lock: lockRoot.dependencies?.tsx, pkg: pkg.dependencies?.tsx });
const tsxLock = lock.packages?.['node_modules/tsx'];
assert(!!tsxLock && tsxLock.dev !== true && /^\d+\.\d+\.\d+$/.test(tsxLock.version ?? '') && String(tsxLock.integrity ?? '').startsWith('sha512-'), 'the tsx lock entry is not dev-only and has an exact version and an integrity hash', tsxLock && { dev: tsxLock.dev, version: tsxLock.version });
const esbuildLock = lock.packages?.['node_modules/tsx/node_modules/esbuild'] ?? lock.packages?.['node_modules/esbuild'];
const esbuildRange = /^~(\d+)\.(\d+)\./.exec(tsxLock?.dependencies?.esbuild ?? '');
assert(!!esbuildLock && esbuildLock.dev !== true && !!esbuildRange && String(esbuildLock.version).startsWith(`${esbuildRange[1]}.${esbuildRange[2]}.`), 'the esbuild tsx resolves to is installed with --omit=dev and satisfies its range', { range: tsxLock?.dependencies?.esbuild, esbuild: esbuildLock && { dev: esbuildLock.dev, version: esbuildLock.version } });
const nestedTsx = lockKeys.filter((k) => k.startsWith('node_modules/tsx/node_modules/'));
assert(nestedTsx.length > 0 && nestedTsx.every((k) => lock.packages[k].dev !== true), 'every package nested under tsx is installed with --omit=dev', nestedTsx.filter((k) => lock.packages[k].dev === true));
for (const p of ['linux-x64', 'linux-arm64']) {
  const x = lock.packages?.[`node_modules/tsx/node_modules/@esbuild/${p}`] ?? lock.packages?.[`node_modules/@esbuild/${p}`];
  assert(!!x && x.dev !== true && x.version === esbuildLock?.version, `the esbuild binary for ${p} is installed with --omit=dev and matches esbuild`, x && { dev: x.dev, version: x.version });
}
// Every package the server imports at runtime must be a production dependency (the image has no devDependencies).
const serverPackages = new Set<string>();
for (const file of walk(path.join(root, 'server'), (f) => /\.ts$/.test(f))) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(import|export)\s+type\b/.test(line)) continue;
    const specs = [
      /^\s*(?:import|export|\})[^'"]*\bfrom\s+['"]([^'"\s]+)['"]/.exec(line)?.[1],
      /\bimport\(\s*['"]([^'"\s]+)['"]\s*\)/.exec(line)?.[1],
      /^\s*import\s+['"]([^'"\s]+)['"]/.exec(line)?.[1],
    ];
    for (const spec of specs) {
      if (!spec || spec.startsWith('.')) continue;
      const bare = spec.replace(/^node:/, '');
      if (builtinModules.includes(bare)) continue;
      const parts = bare.split('/');
      serverPackages.add(bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
}
const missingDeps = [...serverPackages].filter((n) => !(n in (pkg.dependencies ?? {})));
console.log(`  server runtime packages: ${[...serverPackages].sort().join(', ')}`);
assert(serverPackages.size > 0 && missingDeps.length === 0, 'every package server/ imports at runtime is a production dependency', missingDeps);
const extractSrc = fs.readFileSync(path.join(root, 'server/ssp/extract.ts'), 'utf8').replace(/\r\n/g, '\n');
assert(extractSrc.includes('fork(CHILD_PATH') && /\.\.\.process\.execArgv/.test(extractSrc) && !/(spawn|exec|execFile|fork)\(\s*['"]tsx['"]/.test(extractSrc), 'the SSP extraction child is forked with the parent execArgv (the local tsx loader), never a global tsx');
const onPremDoc = fs.readFileSync(path.join(root, 'docs/ON_PREM_DATABASE.md'), 'utf8').replace(/\r\n/g, '\n');
assert(!/singularity-app\s+tsx\s/.test(onPremDoc), 'docs/ON_PREM_DATABASE.md does not tell the operator to run a global tsx in the container');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
assert(/^LOCAL_AUTH_SECRET=/m.test(envExample), '.env.example contains LOCAL_AUTH_SECRET=');
assert(!/VITE_FIREBASE|VITE_GCP|VITE_GCS/i.test(envExample), '.env.example has no VITE_FIREBASE / VITE_GCP / VITE_GCS');
assert(/^# MFA_REQUIRED=/m.test(envExample), '.env.example documents MFA_REQUIRED');
assert(/^# MFA_ENCRYPTION_KEY=/m.test(envExample), '.env.example documents MFA_ENCRYPTION_KEY');
assert(/^DB_USER=grc_app\s*$/m.test(envExample) && !/^DB_USER=postgres/m.test(envExample), '.env.example connects as DB_USER=grc_app, never the superuser');
const gitignoreLines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
const dockerignoreLines = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
assert(gitignoreLines.includes('data/'), '.gitignore ignores data/ (the local evidence vault)');
assert(dockerignoreLines.includes('data/') && dockerignoreLines.includes('.env.*') && dockerignoreLines.includes('!.env.example'), '.dockerignore excludes data/ and .env.* (but keeps .env.example)');
assert(!('cors' in (pkg.dependencies ?? {})) && !('@types/cors' in (pkg.devDependencies ?? {})), 'package.json has no cors / @types/cors (the SPA is same-origin)');
const testAll: string = pkg.scripts?.['test:all'] ?? '';
assert(['totp', 'mfa', 'mfaClient'].every((n) => testAll.includes(`tests/${n}.test.ts`)), 'package.json test:all runs tests/totp.test.ts, tests/mfa.test.ts and tests/mfaClient.test.ts');

console.log('\n--- Releases and pins (#157) ---');
assert(/^\d+\.\d+\.\d+$/.test(pkg.version) && readAppVersion() === pkg.version, 'readAppVersion() returns the package.json version (what /api/v1/health reports)', [readAppVersion(), pkg.version]);
assert(readAppVersion(path.join(root, 'no-such-file.json')) === 'unknown', 'readAppVersion of a missing file is "unknown"');
assert(readAppVersion(path.join(root, 'tsconfig.json')) === 'unknown', 'readAppVersion of a JSON file with no version is "unknown"');
const fromLines = dockerCode.filter((l) => /^FROM\s/i.test(l));
assert(fromLines.length === 2 && fromLines.every((l) => /^FROM node:22-alpine@sha256:[0-9a-f]{64} AS (builder|runner)\s*$/.test(l)), 'both Dockerfile stages start FROM node:22-alpine pinned by a sha256 digest', fromLines);
assert(new Set(fromLines.map((l) => l.split(/\s+/)[1])).size === 1, 'both Dockerfile stages use the same base image digest', fromLines);
if (app) {
  assert(app.lines.some((l) => l.trim() === 'image: ghcr.io/erickson-devin/pbc-grc:${IMAGE_TAG:-v' + pkg.version + '}'), 'the app image is ghcr.io/erickson-devin/pbc-grc:${IMAGE_TAG:-v<package.json version>}', app.lines.filter((l) => /^\s+image:/.test(l)));
  assert(!app.lines.some((l) => /^\s+image:.*latest/.test(l)), 'the app image never references latest');
  assert(!('IMAGE_TAG' in mapOf(app, 'environment')), 'IMAGE_TAG is a compose variable only, not passed into the app environment');
}
assert(!!db && db.lines.some((l) => /^image: postgres:16-alpine@sha256:[0-9a-f]{64}$/.test(l.trim())), 'the db service image is postgres:16-alpine pinned by a sha256 digest', db && db.lines.filter((l) => /^\s+image:/.test(l)));
const composeImages = services.flatMap((s) => s.lines).filter((l) => /^\s+image:/.test(l));
assert(composeImages.length >= 3 && composeImages.every((l) => !/latest/i.test(l)), 'no compose image: line references latest (#169)', composeImages);
assert(!!ollama && ollama.lines.some((l) => /^image: ollama\/ollama:\$\{OLLAMA_IMAGE_TAG:-\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\}$/.test(l.trim())), 'the ollama image is ollama/ollama pinned by version and sha256 digest in the OLLAMA_IMAGE_TAG default (#169)', ollama && ollama.lines.filter((l) => /^\s+image:/.test(l)));
assert(/^# IMAGE_TAG=v\d+\.\d+\.\d+\s*$/m.test(envExample), '.env.example documents IMAGE_TAG=v<x.y.z>');
const dependabotPath = path.join(root, '.github', 'dependabot.yml');
const dependabot = fs.existsSync(dependabotPath) ? fs.readFileSync(dependabotPath, 'utf8') : '';
assert(/package-ecosystem:\s*"docker"/.test(dependabot) && /package-ecosystem:\s*"github-actions"/.test(dependabot) && !/package-ecosystem:\s*"npm"/.test(dependabot), '.github/dependabot.yml watches the docker and github-actions ecosystems, not npm');
for (const wf of ['ci.yml', 'docker-publish.yml']) {
  const lines = fs.readFileSync(path.join(root, '.github', 'workflows', wf), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const uses = lines.map((l) => /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const external = uses.filter((m) => !m[1].startsWith('./'));
  assert(uses.length > 0 && external.length > 0, `${wf} has uses: references to check`, uses.length);
  assert(external.every((m) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(m[1]) && /#\s*v\d+(\.\d+){0,2}\s*$/.test(m[2])), `${wf}: every external action is pinned to a 40-hex commit with a version comment`, external.filter((m) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(m[1])).map((m) => m[1]));
}
const publishWf = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker-publish.yml'), 'utf8').replace(/\r\n/g, '\n');
const publishNeeds = ['tags: [ "v[0-9]+.[0-9]+.[0-9]+" ]', 'latest=false', 'type=raw,value=latest,enable={{is_default_branch}}', 'type=sha,enable={{is_default_branch}}', 'type=semver,pattern=v{{version}}', 'type=semver,pattern=v{{major}}.{{minor}}', 'type=semver,pattern=v{{major}}', 'git merge-base --is-ancestor HEAD origin/main', 'jq -r .version package.json', 'steps.build.outputs.digest'];
assert(publishNeeds.every((s) => publishWf.includes(s)), 'docker-publish.yml publishes SemVer tags, checks the release tag against main and package.json, and records the digest', publishNeeds.filter((s) => !publishWf.includes(s)));
assert(!publishWf.includes('type=raw,value=latest\n'), 'docker-publish.yml never tags latest unconditionally');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
