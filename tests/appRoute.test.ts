import { routeFromUrl, resolveRoot } from '../src/utils/appRoute';
import fs from 'fs';
import path from 'path';

/**
 * The application has no public site. Only /login, /invite (/accept-invite), the app and /admin are routes; "/" and every
 * unknown path (including the old marketing paths) resolve to the login page, or the app when there is a session.
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
const route = (pathname: string, hash = '', search = '') => routeFromUrl({ pathname, hash, search });

console.log('--- Known routes ---');
assert(route('/login') === 'login' && route('/', '#login') === 'login' && route('/', '#login?redirectUrl=%2Fapp') === 'login' && route('/', '', '?view=login') === 'login', 'login: /login, #login (with a redirect), ?view=login');
assert(route('/invite') === 'accept-invite' && route('/accept-invite', '', '?token=inv_x') === 'accept-invite' && route('/', '#accept-invite?token=inv_x') === 'accept-invite' && route('/', '#invite') === 'accept-invite', 'invitation: /invite and /accept-invite (existing links keep working), also by hash');
assert(route('/app') === 'app' && route('/dashboard') === 'app' && route('/', '#app') === 'app', 'app: /app, /dashboard, #app');
assert(route('/admin') === 'admin' && route('/', '#admin') === 'admin', 'administration: /admin, #admin');
assert(route('/setup') === 'setup' && route('/', '#setup') === 'setup' && route('/', '', '?view=setup') === 'setup', 'setup: /setup, #setup (the page itself only renders while the server says setup is required)');
assert(route('/LOGIN') === 'login' && route('/Invite') === 'accept-invite', 'matching is case-insensitive');

console.log('\n--- "/" and unknown paths never show a page of their own ---');
assert(route('/') === 'root' && route('') === 'root', '"/" is resolved (root)');
for (const p of ['/pricing', '/about', '/contact', '/request-license', '/landing', '/demo', '/sandbox', '/features', '/does-not-exist', '/login/extra', '/app/x']) {
  assert(route(p) === 'root', `${p} is not a route: it is resolved like "/"`, route(p));
}
assert(route('/', '#demo') === 'root' && route('/', '#sandbox') === 'root' && route('/', '', '?mode=sandbox') === 'root' && route('/', '', '?view=demo') === 'root', 'the demo sandbox has no route any more (path, hash or query)');
assert(route('/privacy') === 'root' && route('/terms') === 'root', 'the legal paths are not pages either (the app opens its legal dialog for them, then resolves)');

console.log('\n--- Resolving "/" ---');
assert(resolveRoot(false) === 'login', 'without a session: the login page');
assert(resolveRoot(true) === 'app', 'with a session: the app');

console.log('\n--- Nothing of the public site is left in the repository ---');
const root = path.join(process.cwd());
const gone = [
  'src/components/landing',
  'src/components/auth/LicenseRequestModal.tsx',
  'src/data/marketingPlans.ts',
  'public/privacy.html',
  'public/terms.html',
];
for (const g of gone) assert(!fs.existsSync(path.join(root, g)), `${g} is deleted`);
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const source = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))].filter((f) => /\.(ts|tsx)$/.test(f));
const offenders = (re: RegExp) => source.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
assert(offenders(/components\/landing|marketingPlans|LicenseRequestModal|PricingSection|LandingPage|SampleSspModal/).length === 0, 'no source file imports a removed marketing module', offenders(/components\/landing|marketingPlans|LicenseRequestModal|PricingSection|LandingPage|SampleSspModal/));
assert(offenders(/submitLicenseRequest|openLicenseModal|licenseRequests/).length === 0, 'the lead-capture state and its callers are gone', offenders(/submitLicenseRequest|openLicenseModal|licenseRequests/));
const nginx = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
assert(/location \^~ \/api\//.test(nginx) && /try_files \$uri \$uri\/ \/index\.html/.test(nginx) && !/privacy|terms/i.test(nginx.replace(/#[^\n]*/g, '')), 'nginx.conf is the SPA plus an /api/ proxy, with no routes of the public site');
const serverIndex = fs.readFileSync(path.join(root, 'server/index.ts'), 'utf8');
assert(!/privacy|terms/i.test(serverIndex), 'the Express server has no static routes for public pages');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
