import fs from 'fs';
import path from 'path';

/**
 * On-prem only guard (Phase 5.8). PBC-GRC is deployed on the customer's own hardware: local accounts, local disk,
 * PostgreSQL. This pure suite (no server, no port) fails if a cloud-provider code path, dependency, deploy script or
 * identifier creeps back into the repository, and it pins the network shape of docker-compose.yml.
 *
 * Part 1 scans code and config for removed-cloud tokens. It deliberately does NOT scan prose: the customer-CSP default text
 * (documentCompilers, offboardingEngine, ArtifactExportModal, SSPBuilder) describes the customer's own cloud
 * provider and stays. Catalog content (below) is exempt because it must never be edited.
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
  assert(ports.length === 1 && ports[0] === '${APP_PORT:-3000}:3000', 'the app publishes exactly "${APP_PORT:-3000}:3000"', ports);
  const env = mapOf(app, 'environment');
  assert(env.APP_BIND_ADDRESS === '${APP_BIND_ADDRESS:-0.0.0.0}', 'app environment: APP_BIND_ADDRESS: ${APP_BIND_ADDRESS:-0.0.0.0}', env.APP_BIND_ADDRESS);
  assert(env.AUTH_MODE === 'local', 'app environment: AUTH_MODE: local', env.AUTH_MODE);
  assert(!('APP_PORT' in env), 'app environment has no APP_PORT key (the container always listens on 3000)');
  assert(env.MFA_REQUIRED === '${MFA_REQUIRED:-}', 'app environment: MFA_REQUIRED: ${MFA_REQUIRED:-} (empty means the default, all)', env.MFA_REQUIRED);
  assert(env.MFA_ENCRYPTION_KEY === '${MFA_ENCRYPTION_KEY:-}', 'app environment: MFA_ENCRYPTION_KEY: ${MFA_ENCRYPTION_KEY:-} (optional)', env.MFA_ENCRYPTION_KEY);
  assert(!('GOOGLE_APPLICATION_CREDENTIALS' in env) && Object.keys(env).every((k) => !/^(GOOGLE_|GCP_|GCS_|FIREBASE_)/i.test(k)), 'app environment has no cloud-provider variables', Object.keys(env));
}
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
// Global tsx installs in a Dockerfile: the pinned version, or null for an unpinned install. Comments are ignored.
function globalTsxPins(text: string): (string | null)[] {
  const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  return [...code.matchAll(/npm\s+(?:install|i)\s+(?:-g|--global)\s+tsx(?:@(\S+))?(?=\s|$)/g)].map((m) => m[1] ?? null);
}
assert(JSON.stringify(globalTsxPins('RUN npm install -g tsx\n')) === '[null]', 'globalTsxPins reports an unpinned install as null');
assert(JSON.stringify(globalTsxPins('RUN npm install -g tsx@4.23.13\r\n')) === '["4.23.13"]', 'globalTsxPins reads a pinned version from a CRLF line');
assert(globalTsxPins('# RUN npm install -g tsx\n').length === 0, 'globalTsxPins ignores a commented-out install');
const tsxPins = globalTsxPins(dockerfile);
assert(tsxPins.length === 1 && /^\d+\.\d+\.\d+$/.test(tsxPins[0] ?? ''), 'the Dockerfile installs tsx globally exactly once, at an exact version (not ^, ~ or latest)', tsxPins);
assert(tsxPins[0] === lock.packages?.['node_modules/tsx']?.version, 'the Dockerfile tsx version equals the package-lock.json node_modules/tsx version', { dockerfile: tsxPins[0], lock: lock.packages?.['node_modules/tsx']?.version });
assert(/^CMD \["tsx", "server\/index\.ts"\]\s*$/m.test(dockerfile), 'the Dockerfile still starts the server with CMD ["tsx", "server/index.ts"]');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
assert(/^LOCAL_AUTH_SECRET=/m.test(envExample), '.env.example contains LOCAL_AUTH_SECRET=');
assert(!/VITE_FIREBASE|VITE_GCP|VITE_GCS/i.test(envExample), '.env.example has no VITE_FIREBASE / VITE_GCP / VITE_GCS');
assert(/^# MFA_REQUIRED=/m.test(envExample), '.env.example documents MFA_REQUIRED');
assert(/^# MFA_ENCRYPTION_KEY=/m.test(envExample), '.env.example documents MFA_ENCRYPTION_KEY');
const testAll: string = pkg.scripts?.['test:all'] ?? '';
assert(['totp', 'mfa', 'mfaClient'].every((n) => testAll.includes(`tests/${n}.test.ts`)), 'package.json test:all runs tests/totp.test.ts, tests/mfa.test.ts and tests/mfaClient.test.ts');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
