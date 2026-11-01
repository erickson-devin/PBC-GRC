import fs from 'node:fs';
import path from 'node:path';
import {
  VM_TOKENS_COPY, VM_TOKEN_ACTIVE_LIMIT, VM_TOKEN_DEFAULT_DAYS, VM_TOKEN_MAX_DAYS, activeTokenCaption, countActiveTokens, createdByLabel,
  newTokenFor, normalizeTokenName, parseExpiryDays, revokeConfirmText, revokedMessage, tokenNameError, tokenPrefixLabel, tokenState,
  tokenStateLabel, vmTokenErrorMessage, vmTokenLoadErrorMessage,
} from '../src/data/telemetry/vmTokensView';
import type { VmServiceToken } from '../src/types/vm';

/**
 * VM service tokens screen (#190): the pure helpers and copy of VmServiceTokensSection, plus source checks that the token value is only ever
 * held in state and shown in the read-only field, that nothing is stored or logged, and that the client methods stay tenant-wide. No server.
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

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const now = Date.parse('2026-11-01T00:00:00Z');
const tok = (over: Partial<VmServiceToken>): VmServiceToken => ({
  id: 't1', tenantId: 'ten', name: 'Exporter', tokenPrefix: 'pbcvm_abc123', scopes: ['vm:ingest'], createdBy: 'Ann (ann@x)', createdByUserId: null,
  createdAt: '2026-10-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null, ...over,
});

function main() {
  console.log('--- helpers ---');
  assert(tokenState(tok({}), now) === 'active', 'TK1a a live token is active');
  assert(tokenState(tok({ expiresAt: '2026-10-31T00:00:00Z' }), now) === 'expired', 'TK1b a past expiry is expired');
  assert(tokenState(tok({ revokedAt: '2026-10-15T00:00:00Z' }), now) === 'revoked', 'TK1c a revoked token is revoked');
  assert(tokenState(tok({ revokedAt: '2026-10-15T00:00:00Z', expiresAt: '2026-10-31T00:00:00Z' }), now) === 'revoked', 'TK1d revoked wins over expired');
  assert(tokenStateLabel('active') === 'Active' && tokenStateLabel('expired') === 'Expired' && tokenStateLabel('revoked') === 'Revoked', 'TK1e state labels');
  assert(countActiveTokens([tok({}), tok({ id: 'b' }), tok({ id: 'c', expiresAt: '2026-10-31T00:00:00Z' }), tok({ id: 'd', revokedAt: '2026-10-15T00:00:00Z' })], now) === 2, 'TK1f counts only active tokens');

  assert(tokenNameError('') === VM_TOKENS_COPY.nameRequired && tokenNameError('   ') === VM_TOKENS_COPY.nameRequired, 'TK2a empty or blank name is refused');
  assert(tokenNameError('a'.repeat(256)) === VM_TOKENS_COPY.nameTooLong, 'TK2b 256 characters is too long');
  assert(tokenNameError('x\u0007y') === VM_TOKENS_COPY.nameControl, 'TK2c control characters are refused');
  assert(tokenNameError('  Exporter  ') === null && tokenNameError('a'.repeat(255)) === null, 'TK2d a normal name and 255 characters are fine');
  assert(normalizeTokenName('  Wazuh exporter  ') === 'Wazuh exporter', 'TK2e the name is trimmed');

  assert(parseExpiryDays('90') === 90 && parseExpiryDays('1') === 1 && parseExpiryDays('730') === 730, 'TK3a days 1..730 parse');
  assert(['0', '731', '1.5', '', '-3', 'abc'].every((v) => parseExpiryDays(v) === null), 'TK3b out-of-range or non-integer days are null');

  const serverTokens = read('server/vm/tokens.ts');
  assert(VM_TOKEN_DEFAULT_DAYS === 90 && VM_TOKEN_MAX_DAYS === 730 && serverTokens.includes('export const MAX_TOKEN_DAYS = 730;'), 'TK4a the limits match the server');
  assert(VM_TOKEN_ACTIVE_LIMIT === 10 && serverTokens.includes('export const MAX_ACTIVE_TOKENS_PER_TENANT = 10;'), 'TK4b the active-token limit matches the server');

  const err = (status: number, message: string, reason?: string) => Object.assign(new Error(message), { status, ...(reason ? { reason } : {}) });
  assert(vmTokenErrorMessage(err(403, 'vm_insecure_transport')) === VM_TOKENS_COPY.insecure, 'TK5a insecure transport');
  assert(vmTokenErrorMessage(err(429, 'Too many requests.', 'limit')) === VM_TOKENS_COPY.limit, 'TK5b active-token limit');
  assert(vmTokenErrorMessage(err(403, 'You do not have permission to do that.')) === VM_TOKENS_COPY.forbidden, 'TK5c forbidden');
  assert(vmTokenErrorMessage(err(404, 'x')) === VM_TOKENS_COPY.notFound, 'TK5d not found');
  assert(vmTokenErrorMessage(err(0, 'x')) === VM_TOKENS_COPY.unreachable, 'TK5e unreachable');
  assert(vmTokenErrorMessage(err(400, 'name is required')) === 'name is required', 'TK5f a 400 shows its validation message');
  assert(vmTokenErrorMessage(err(500, 'boom')) === VM_TOKENS_COPY.failed && vmTokenErrorMessage(null) === VM_TOKENS_COPY.failed, 'TK5g anything else is the generic message');
  assert(vmTokenLoadErrorMessage(err(403, 'x')) === VM_TOKENS_COPY.forbidden && vmTokenLoadErrorMessage(err(0, 'x')) === VM_TOKENS_COPY.unreachable
    && vmTokenLoadErrorMessage(err(500, 'x')) === VM_TOKENS_COPY.loadError && vmTokenLoadErrorMessage(null) === VM_TOKENS_COPY.loadError, 'TK5h load errors');

  assert(revokeConfirmText('Exporter', 'pbcvm_abc123') === 'Revoke "Exporter" (pbcvm_abc123…)? Anything that pushes with it is refused from now on. This cannot be undone.', 'TK6a revoke confirmation text');
  assert(tokenPrefixLabel('pbcvm_abc123') === 'pbcvm_abc123…', 'TK6b prefix label');
  assert(revokedMessage('Exporter') === '"Exporter" revoked. Anything that pushes with it is now refused.', 'TK6c revoked message');
  assert(newTokenFor('Exporter') === 'Token for "Exporter"' && createdByLabel('Ann (ann@x)') === 'by Ann (ann@x)', 'TK6d labels');
  assert(
    activeTokenCaption(0) === 'No active tokens. An organization can have 10.' && activeTokenCaption(1) === '1 active token of the 10 allowed.'
      && activeTokenCaption(3) === '3 active tokens of the 10 allowed.' && activeTokenCaption(10) === '10 active tokens of the 10 allowed: revoke one before creating another.',
    'TK6e active-token captions'
  );
  assert(same(Object.keys(VM_TOKENS_COPY).filter((k) => !(VM_TOKENS_COPY as Record<string, string>)[k]), []), 'TK6f no empty copy');

  const helperSrc = read('src/data/telemetry/vmTokensView.ts');
  const nonTypeImports = helperSrc.split('\n').filter((l) => /^import /.test(l) && !/^import type /.test(l));
  assert(nonTypeImports.length === 0 && !/react|console\.|localStorage|sessionStorage|fetch\(/.test(helperSrc.replace(/\/\*[\s\S]*?\*\//, '')), 'TK7 the helper module is pure: type imports only, no react, console, storage or fetch');

  console.log('\n--- source checks ---');
  const section = read('src/components/auth/VmServiceTokensSection.tsx');
  const sectionNeeds = [
    'ApiClient.listVmTokens(tenantId)', 'ApiClient.createVmToken(tenantId,', 'ApiClient.revokeVmToken(tenantId,', 'copyText(', 'readOnly',
    'VM_TOKENS_COPY.oneTimeWarning', 'setNewToken(null)', 'aria-live="polite"', 'aria-describedby={warningId}', "e.key === 'Escape'", 'role="group"', 'colSpan={6}',
  ].filter((s) => !section.includes(s));
  assert(sectionNeeds.length === 0, 'TK8a the section lists, creates and revokes, copies, and warns once', sectionNeeds);
  const sectionBanned = ['console.', 'localStorage', 'sessionStorage', 'recordAuditEvent', 'dangerouslySetInnerHTML', 'title={'].filter((s) => section.includes(s));
  assert(sectionBanned.length === 0, 'TK8b nothing is logged, stored, audited or injected', sectionBanned);
  assert(occurrences(section, 'newToken.token') === 2, 'TK8c the token value is used only in the read-only field and the copy call', occurrences(section, 'newToken.token'));

  const modal = read('src/components/auth/ApiTokensModal.tsx');
  assert(
    modal.includes('<VmServiceTokensSection key={currentTenant.id}') && modal.includes('canEdit') && modal.includes('serverBacked')
      && modal.includes('-H "Authorization: Bearer <SERVICE_TOKEN>"') && !modal.includes('API Keys & Session Tokens'),
    'TK9a the modal mounts the section for owners of a server-backed organization and keeps the header example'
  );
  assert(
    modal.includes('max-w-2xl') && modal.includes('max-h-[94vh]') && modal.includes('as="h2"') && !modal.includes('PostgreSQL')
      && modal.indexOf('useId()') > -1 && modal.indexOf('useId()') < modal.indexOf('if (!isOpen) return null;'),
    'TK9b modal frame, heading level, hooks before the early return'
  );

  const api = read('src/services/apiClient.ts');
  assert(/async listVmTokens\(tenantId: string\)/.test(api), 'TK10a listVmTokens(tenantId)');
  assert(/async createVmToken\(tenantId: string, input: /.test(api), 'TK10b createVmToken(tenantId, input)');
  assert(/async revokeVmToken\(tenantId: string, tokenId: string\)/.test(api), 'TK10c revokeVmToken(tenantId, tokenId)');
  assert(!/(listVmTokens|createVmToken|revokeVmToken)\([^)]*programId/.test(api), 'TK10d the token methods take no programId');
  const accretion = read('src/components/telemetry/AccretionIntegrationModal.tsx');
  assert(!accretion.includes('create a VM service token and send it') && /API Keys (&|&amp;) Service Tokens/.test(accretion), 'TK10e the integration modal points to the new screen');
  const dropdown = read('src/components/auth/UserProfileDropdown.tsx');
  assert(dropdown.includes('API Keys & Service Tokens') && !dropdown.includes('API Session Token'), 'TK10f the profile menu label');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main();
