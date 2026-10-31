import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import {
  assertRequireTlsConfig,
  createRequireTls,
  isRequireTls,
  ollamaTransportWarnings,
  transportWarnings,
} from '../server/transportSecurity';

/**
 * Transport security (#166): REQUIRE_TLS middleware and config check, and the two startup warnings. Pure: no server, no port.
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

interface Outcome { next: boolean; status: number | null; body: unknown; redirect: { code: number; url: string } | null }

function run(env: NodeJS.ProcessEnv, req: { secure?: boolean; method?: string; path: string; originalUrl?: string; hostname?: string | undefined }): Outcome {
  const out: Outcome = { next: false, status: null, body: null, redirect: null };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
    redirect(code: number, url: string) { out.redirect = { code, url }; },
  };
  const fakeReq = { secure: false, method: 'GET', originalUrl: req.path, hostname: 'grc.example.mil', ...req };
  createRequireTls(env)(fakeReq as unknown as Request, res as unknown as Response, (() => { out.next = true; }) as NextFunction);
  return out;
}

const ON = { REQUIRE_TLS: 'true', TRUST_PROXY: '172.30.0.1' };
const REFUSED = { error: 'HTTPS is required', code: 'tls_required' };
const isRefused = (o: Outcome) => !o.next && o.status === 403 && JSON.stringify(o.body) === JSON.stringify(REFUSED);

console.log('\n--- REQUIRE_TLS middleware ---');
assert(run({}, { path: '/api/v1/controls' }).next, 'T1: off by default, an insecure request passes');
assert(run(ON, { path: '/api/v1/controls', secure: true }).next, 'T2: on, a secure request passes');
assert(isRefused(run(ON, { path: '/api/v1/controls' })), 'T3: on, an insecure GET on the API is 403 tls_required');
assert(isRefused(run(ON, { method: 'POST', path: '/api/v1/auth/login' })), 'T4: on, an insecure login POST is 403');
assert(isRefused(run(ON, { path: '/API/v1/controls' })), 'T5: the API match is case-insensitive');
assert(run(ON, { path: '/api/v1/health' }).next && run(ON, { path: '/api/v1/health/' }).next && run(ON, { method: 'HEAD', path: '/api/v1/health' }).next, 'T6: GET and HEAD health stay open');
assert(isRefused(run(ON, { method: 'POST', path: '/api/v1/health' })), 'T7: POST on health is refused');
const page = run(ON, { path: '/dashboard', originalUrl: '/dashboard?x=1' });
assert(!page.next && page.redirect?.code === 301 && page.redirect.url === 'https://grc.example.mil/dashboard?x=1', 'T8: a page load is redirected to https on the same host', page.redirect);
assert(isRefused(run(ON, { method: 'POST', path: '/dashboard' })), 'T9: a non-GET page request is 403');
const evil = run(ON, { path: '/', hostname: 'evil"><x' });
const none = run(ON, { path: '/', hostname: undefined });
assert(evil.status === 400 && evil.redirect === null && none.status === 400 && none.redirect === null, 'T10: an unsafe or missing hostname is 400, never a redirect', { evil: evil.status, none: none.status });
assert(!isRequireTls({ REQUIRE_TLS: 'false' }) && isRequireTls({ REQUIRE_TLS: ' TRUE ' }) && isRequireTls({ REQUIRE_TLS: '1' }) && !isRequireTls({}), 'T11: REQUIRE_TLS parsing (false off, " TRUE " on)');
assert(run({ REQUIRE_TLS: 'false' }, { path: '/api/v1/controls' }).next, 'T11b: REQUIRE_TLS=false lets an insecure request through');

console.log('\n--- assertRequireTlsConfig ---');
function throws(env: NodeJS.ProcessEnv): string | null {
  try { assertRequireTlsConfig(env); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
assert((throws({ REQUIRE_TLS: 'true' }) ?? '').includes('TRUST_PROXY'), 'T12: REQUIRE_TLS=true without TRUST_PROXY refuses to start');
assert(throws({ REQUIRE_TLS: 'true', TRUST_PROXY: '172.30.0.1' }) === null, 'T12: with TRUST_PROXY it is accepted');
assert(throws({ REQUIRE_TLS: 'yes' }) === 'REQUIRE_TLS must be true or false', 'T12: an unknown value is refused');
assert(throws({}) === null && throws({ REQUIRE_TLS: '' }) === null && throws({ REQUIRE_TLS: 'false' }) === null, 'T12: unset, blank and false are accepted');

console.log('\n--- transportWarnings ---');
const prod = { NODE_ENV: 'production' };
const w1 = transportWarnings(prod, '0.0.0.0');
assert(w1.length === 1 && w1[0].includes('TRUST_PROXY'), 'T13: production on 0.0.0.0 without TRUST_PROXY warns once', w1);
assert(transportWarnings(prod, '::').length === 1, 'T13: the IPv6 wildcard warns too');
assert(transportWarnings({}, '0.0.0.0').length === 1, 'T13: an unset NODE_ENV counts as production');
assert(transportWarnings({ ...prod, TRUST_PROXY: '172.30.0.1' }, '0.0.0.0').length === 0, 'T13: no warning with TRUST_PROXY');
assert(transportWarnings(prod, '127.0.0.1').length === 0, 'T13: no warning on loopback');
assert(transportWarnings({ NODE_ENV: 'development' }, '0.0.0.0').length === 0, 'T13: no warning in development');

console.log('\n--- ollamaTransportWarnings ---');
const ai = (url?: string, enabled = true): string[] => ollamaTransportWarnings({ ...(enabled ? { SSP_AI_ENABLED: 'true' } : {}), ...(url ? { OLLAMA_BASE_URL: url } : {}) });
assert(ollamaTransportWarnings({}).length === 0, 'W1: AI off, no warning');
assert(ai().length === 0, 'W2: AI on with the default loopback URL, no warning');
assert(ai('http://ollama:11434').length === 0, 'W3: the bundled docker service, no warning');
assert(ai('http://host.docker.internal:11434').length === 0, 'W4: host.docker.internal, no warning');
assert(ai('http://[::1]:11434').length === 0 && ai('http://127.0.0.5:11434').length === 0 && ai('http://localhost:11434').length === 0, 'W5: loopback forms, no warning');
const w6 = ai('http://192.168.1.20:11434');
assert(w6.length === 1 && w6[0].includes('OLLAMA_BASE_URL') && !w6[0].includes('192.168.1.20'), 'W6: another machine over plain HTTP warns, without naming the host', w6);
assert(ai('http://gpu-box.local:11434').length === 1, 'W7: a named LAN host warns');
assert(ai('https://192.168.1.20:11434').length === 0, 'W8: https is fine');
assert(ai('http://192.168.1.20:11434', false).length === 0, 'W8: AI off silences it');
assert(ai('not a url').length === 0, 'W8: an invalid URL is not this check\'s business');

console.log('\n--- server/index.ts wiring ---');
const index = fs.readFileSync(path.join(process.cwd(), 'server/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const mw = index.indexOf('app.use(createRequireTls());');
assert(mw > index.indexOf("res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);") && mw < index.indexOf('const jsonParser') && mw > 0, 'T14: REQUIRE_TLS runs after the security headers and before the body parsers');
assert(index.includes('assertRequireTlsConfig();') && index.includes('transportWarnings(process.env, BIND_ADDRESS)') && index.includes('ollamaTransportWarnings()'), 'T14: startup validates the config and logs both warnings');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
