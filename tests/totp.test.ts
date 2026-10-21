import './testEnv';
import './localAuthEnv';
import crypto from 'crypto';
import {
  TOTP_SECRET_BYTES,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hotp,
  normalizeRecoveryCode,
  totpStep,
  verifyTotp,
} from '../server/auth/totp';
import { MfaSecretUnreadableError, decryptTotpSecret, deriveKey, encryptTotpSecret, hashRecoveryCode } from '../server/auth/mfaCrypto';
import { isMfaRequiredFor } from '../server/auth/mfaPolicy';
import {
  DEFAULT_MFA_REQUIREMENT,
  LOCAL_TOKEN_AUDIENCE,
  LOCAL_TOKEN_ISSUER,
  LocalAuthConfigError,
  assertAuthConfig,
  authStartupWarnings,
  getMfaRequirement,
  hashPassword,
  signLocalToken,
  signMfaPendingToken,
  verifyLocalToken,
  verifyMfaPendingToken,
  verifyPassword,
} from '../server/auth/localAuth';
import {
  __resetMemoryLocalUsersForTests,
  clearLocalUserMfa,
  confirmTotp,
  consumeRecoveryCode,
  replaceRecoveryCodeHashes,
  consumeTotpStep,
  createLocalUser,
  findLocalUserByEmail,
  getLocalUserAuthState,
  listLocalUsers,
  resetLocalUserMfa,
  setLocalUserDisabled,
  setLocalUserPassword,
  setMustChangePassword,
  setPendingTotpSecret,
} from '../server/auth/localUsers';

/**
 * Pure checks (no server, no port, no database): TOTP / HOTP against the RFC vectors, recovery codes, at-rest encryption,
 * key separation, session and pending tokens, the MFA policy and the in-memory local_users storage.
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
function throws(fn: () => unknown, test?: (e: unknown) => boolean): boolean {
  try {
    fn();
  } catch (e) {
    return test ? test(e) : true;
  }
  return false;
}

const SECRET = process.env.LOCAL_AUTH_SECRET as string;
const OTHER_SECRET = 'another-secret-0123456789abcdef-0123456789';
const ascii = (s: string) => Buffer.from(s, 'ascii');
const RFC_SECRET = ascii('12345678901234567890');

async function main() {
  console.log('--- T1 base32 encode (RFC 4648 section 10) ---');
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  assert(vectors.every(([plain, enc]) => base32Encode(ascii(plain)) === enc), 'T1 padded encodings match the RFC vectors', vectors.map(([p]) => base32Encode(ascii(p))));
  assert(vectors.every(([plain, enc]) => base32Encode(ascii(plain), { padding: false }) === enc.replace(/=/g, '')), 'T1 unpadded output is the same with = stripped');

  console.log('\n--- T2 base32 decode ---');
  assert(vectors.every(([plain, enc]) => base32Decode(enc).toString('ascii') === plain), 'T2 decoding inverts the vectors');
  assert(base32Decode('mzxw 6ytb oi').toString('ascii') === 'foobar', 'T2 decode is case-insensitive and ignores spaces');
  assert(throws(() => base32Decode('MZXW1===')) && throws(() => base32Decode('MZXW8')), 'T2 characters 1 and 8 are rejected');
  let roundTrip = true;
  for (let i = 0; i < 500; i++) {
    const buf = crypto.randomBytes(i % 41);
    if (!base32Decode(base32Encode(buf)).equals(buf) || !base32Decode(base32Encode(buf, { padding: false })).equals(buf)) roundTrip = false;
  }
  assert(roundTrip, 'T2 500 random buffers of length 0..40 round-trip');

  console.log('\n--- T3 / T4 / T5 RFC vectors ---');
  assert(base32Encode(RFC_SECRET) === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'T3 the RFC test secret encodes to its known base32');
  const hotpExpected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  assert(hotpExpected.every((code, i) => hotp(RFC_SECRET, i) === code), 'T4 HOTP counters 0..9 match RFC 4226 Appendix D', hotpExpected.map((_, i) => hotp(RFC_SECRET, i)));
  const rfc6238: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  assert(rfc6238.every(([t, code]) => generateTotp(RFC_SECRET, t * 1000, { digits: 8 }) === code), 'T5 8-digit TOTP matches RFC 6238 Appendix B (SHA1)');
  assert(rfc6238.every(([t, code]) => generateTotp(RFC_SECRET, t * 1000) === code.slice(2)), 'T5 6-digit codes keep leading zeros');

  console.log('\n--- T6 / T7 / T8 verification window, replay, malformed input ---');
  const nowMs = 1_700_000_000_000;
  const s = totpStep(nowMs);
  const codeAt = (step: number) => hotp(RFC_SECRET, step);
  const v = (code: unknown, lastUsedStep: number | null) => verifyTotp(RFC_SECRET, code, { nowMs, lastUsedStep });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  assert(same(v(codeAt(s), null), { ok: true, step: s }), 'T6 the current step is accepted');
  assert(same(v(codeAt(s - 1), null), { ok: true, step: s - 1 }), 'T6 one step back is accepted');
  assert(same(v(codeAt(s + 1), null), { ok: true, step: s + 1 }), 'T6 one step ahead is accepted');
  assert(same(v(codeAt(s - 2), null), { ok: false, reason: 'mismatch' }), 'T6 two steps back is rejected');
  assert(same(v(codeAt(s + 2), null), { ok: false, reason: 'mismatch' }), 'T6 two steps ahead is rejected');
  assert(same(v(codeAt(s), s), { ok: false, reason: 'replayed' }), 'T7 the code of the last used step is a replay');
  assert(same(v(codeAt(s), s - 1), { ok: true, step: s }), 'T7 a newer step than the last used one is accepted');
  assert(same(v(codeAt(s - 1), s), { ok: false, reason: 'replayed' }), 'T7 an older step than the last used one is a replay');
  assert(same(v(codeAt(s + 1), s), { ok: true, step: s + 1 }), 'T7 a later step is accepted after the current one was used');
  assert(['12345', '1234567', 'abcdef', '', null, 123456].every((c) => same(v(c, null), { ok: false, reason: 'malformed' })), 'T8 wrong length, letters, empty, null and a number are malformed');
  const spaced = codeAt(s);
  assert(same(v(`${spaced.slice(0, 3)} ${spaced.slice(3)}`, null), { ok: true, step: s }), 'T8 a code typed with a space is accepted');

  console.log('\n--- T9 / T10 secret and otpauth URI ---');
  const gen1 = generateTotpSecret();
  const gen2 = generateTotpSecret();
  assert(gen1.length === TOTP_SECRET_BYTES && TOTP_SECRET_BYTES === 20 && !gen1.equals(gen2), 'T9 secrets are 20 random bytes and differ');
  assert(base32Encode(gen1, { padding: false }).length === 32 && !base32Encode(gen1, { padding: false }).includes('='), 'T9 the unpadded base32 secret is 32 characters');
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert(
    buildOtpauthUri({ issuer: 'PBC-GRC', accountName: 'ann@enclave.mil', secretBase32: b32 }) ===
      `otpauth://totp/PBC-GRC:ann%40enclave.mil?secret=${b32}&issuer=PBC-GRC&algorithm=SHA1&digits=6&period=30`,
    'T10 the otpauth URI is exactly the documented shape'
  );
  assert(buildOtpauthUri({ issuer: 'PBC-GRC', accountName: 'a+b@x.mil', secretBase32: b32 }).includes(':a%2Bb%40x.mil?'), 'T10 the account name is percent-encoded (+ and @)');
  assert(throws(() => buildOtpauthUri({ issuer: 'A:B', accountName: 'x@y.mil', secretBase32: b32 })), 'T10 an issuer containing a colon is refused');

  console.log('\n--- T11 recovery codes (Crockford alphabet) ---');
  const codes = generateRecoveryCodes();
  assert(codes.length === 8 && new Set(codes).size === 8 && codes.every((c) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(c)), 'T11 eight unique codes shaped XXXXX-XXXXX with no I, L, O or U', codes);
  assert(codes.every((c) => normalizeRecoveryCode(c) === c.replace('-', '')), 'T11 every generated code normalizes to itself without the hyphen');
  assert(normalizeRecoveryCode(' abcde-fghjk ') === 'ABCDEFGHJK', 'T11 lowercase, spaces and hyphen are normalized');
  assert(normalizeRecoveryCode('short') === null && normalizeRecoveryCode(null) === null && normalizeRecoveryCode(1234567890) === null, 'T11 short and non-string input is null');
  assert(normalizeRecoveryCode('ABCDE-FGHJU') === null, 'T11 U is not in the alphabet');
  assert(normalizeRecoveryCode('0l1io-abcde') === '01110ABCDE', 'T11 I and L read as 1, O reads as 0');

  console.log('\n--- T12 recovery code hash ---');
  const envA: NodeJS.ProcessEnv = { LOCAL_AUTH_SECRET: SECRET };
  const h1 = hashRecoveryCode('ABCDEFGHJK', envA);
  assert(/^[0-9a-f]{64}$/.test(h1) && h1 === hashRecoveryCode('ABCDEFGHJK', envA), 'T12 the hash is a stable 64-hex string');
  assert(h1 !== hashRecoveryCode('ABCDEFGHJK', { LOCAL_AUTH_SECRET: OTHER_SECRET }), 'T12 another LOCAL_AUTH_SECRET gives another hash');
  assert(!h1.toLowerCase().includes('abcdefghjk'), 'T12 the hash does not contain the code');

  console.log('\n--- T13 secret encryption and key separation ---');
  const secret = generateTotpSecret();
  const blob = encryptTotpSecret(secret, 'lu_ann', envA);
  assert(decryptTotpSecret(blob, 'lu_ann', envA).equals(secret), 'T13 the secret round-trips');
  assert(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(blob), 'T13 the blob has the v1.<iv>.<ct>.<tag> shape', blob);
  assert(encryptTotpSecret(secret, 'lu_ann', envA) !== blob, 'T13 two encryptions of the same secret differ');
  assert(!blob.includes(base32Encode(secret, { padding: false })) && !blob.includes(secret.toString('hex')) && !blob.includes(secret.toString('base64url')), 'T13 the blob contains no encoding of the secret');
  const isUnreadable = (e: unknown) => e instanceof MfaSecretUnreadableError && !(e as Error).message.includes(blob) && !(e as Error).message.includes(secret.toString('hex'));
  const parts = blob.split('.');
  const flipped = [parts[0], parts[1], (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1), parts[3]].join('.');
  assert(throws(() => decryptTotpSecret(blob, 'lu_bob', envA), isUnreadable), 'T13 another user id fails (AAD binds the row)');
  assert(throws(() => decryptTotpSecret(blob, 'lu_ann', { LOCAL_AUTH_SECRET: OTHER_SECRET }), isUnreadable), 'T13 another secret fails');
  assert(throws(() => decryptTotpSecret(flipped, 'lu_ann', envA), isUnreadable), 'T13 a flipped ciphertext character fails');
  assert(throws(() => decryptTotpSecret('garbage', 'lu_ann', envA), isUnreadable), 'T13 a malformed blob fails with the generic error');
  const MFA_KEY = 'dedicated-mfa-key-0123456789abcdef-0123456789';
  const envK: NodeJS.ProcessEnv = { LOCAL_AUTH_SECRET: SECRET, MFA_ENCRYPTION_KEY: MFA_KEY };
  const blobK = encryptTotpSecret(secret, 'lu_ann', envK);
  assert(decryptTotpSecret(blobK, 'lu_ann', { LOCAL_AUTH_SECRET: OTHER_SECRET, MFA_ENCRYPTION_KEY: MFA_KEY }).equals(secret), 'T13 with MFA_ENCRYPTION_KEY set the blob survives a LOCAL_AUTH_SECRET change');
  assert(throws(() => decryptTotpSecret(blobK, 'lu_ann', { LOCAL_AUTH_SECRET: SECRET, MFA_ENCRYPTION_KEY: `${MFA_KEY}-changed` }), isUnreadable), 'T13 a changed MFA_ENCRYPTION_KEY fails');
  assert(
    hashRecoveryCode('ABCDEFGHJK', { LOCAL_AUTH_SECRET: OTHER_SECRET, MFA_ENCRYPTION_KEY: MFA_KEY }) === hashRecoveryCode('ABCDEFGHJK', envK),
    'T13 the recovery pepper follows MFA_ENCRYPTION_KEY too'
  );
  const k1 = deriveKey(SECRET, 'pbc-grc session-signing v1');
  const k2 = deriveKey(SECRET, 'pbc-grc totp-secret v1');
  const k3 = deriveKey(SECRET, 'pbc-grc recovery-pepper v1');
  assert(k1.length === 32 && !k1.equals(k2) && !k1.equals(k3) && !k2.equals(k3) && !k1.equals(Buffer.from(SECRET)), 'T13 the three derived keys are 32 bytes and distinct');

  console.log('\n--- T14 pending tokens ---');
  const realNow = Math.floor(Date.now() / 1000);
  const pendingUser = { id: 'lu_ann', tokenVersion: 2 };
  const pv = signMfaPendingToken(pendingUser, 'verify');
  const pe = signMfaPendingToken(pendingUser, 'enrol');
  const pvClaims = verifyMfaPendingToken(pv.token, 'verify');
  assert(pvClaims.stage === 'verify' && pvClaims.purpose === 'mfa_pending' && pvClaims.ver === 2 && pvClaims.sub === 'lu_ann' && pvClaims.exp - pvClaims.iat === 300, 'T14 a verify token carries its claims and lives 300 s');
  assert(verifyMfaPendingToken(pe.token, 'enrol').exp - verifyMfaPendingToken(pe.token, 'enrol').iat === 600, 'T14 an enrol token lives 600 s');
  assert(pv.claims.jti !== signMfaPendingToken(pendingUser, 'verify').claims.jti && /^[A-Za-z0-9_-]{22}$/.test(pv.claims.jti), 'T14 jti is 16 random bytes (base64url) and unique per token');
  assert(throws(() => verifyLocalToken(pv.token)), 'T14 a pending token is not a session token');
  assert(throws(() => verifyMfaPendingToken(signLocalToken({ id: 'lu_ann', email: 'a@x.mil', name: 'Ann' }).token, 'verify')), 'T14 a session token is not a pending token');
  assert(throws(() => verifyMfaPendingToken(pv.token, 'enrol')) && throws(() => verifyMfaPendingToken(pe.token, 'verify')), 'T14 a stage mismatch is refused');
  assert(throws(() => verifyMfaPendingToken(signMfaPendingToken(pendingUser, 'verify', { now: realNow - 301 }).token, 'verify')), 'T14 an expired token is refused');
  assert(throws(() => verifyMfaPendingToken(signMfaPendingToken(pendingUser, 'verify', { env: { LOCAL_AUTH_SECRET: OTHER_SECRET } }).token, 'verify')), 'T14 a token signed with another secret is refused');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert(throws(() => verifyMfaPendingToken(`${noneHeader}.${pv.token.split('.')[1]}.`, 'verify')), 'T14 alg none is refused');

  console.log('\n--- T15 session claims and signing key ---');
  const withVer = signLocalToken({ id: 'lu_ann', email: 'a@x.mil', name: 'Ann', tokenVersion: 3 }, { amr: ['pwd', 'otp'] });
  const vc = verifyLocalToken(withVer.token);
  assert(vc.ver === 3 && JSON.stringify(vc.amr) === JSON.stringify(['pwd', 'otp']) && vc.purpose === 'session', 'T15 ver, amr and purpose survive a round trip');
  const legacy = verifyLocalToken(signLocalToken({ id: 'lu_ann', email: 'a@x.mil', name: 'Ann' }).token);
  assert(legacy.ver === undefined && JSON.stringify(legacy.amr) === JSON.stringify(['pwd']), 'T15 without a tokenVersion ver is absent (read as 0) and amr defaults to pwd');
  const forge = (key: string | Buffer, claims: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.${crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
  };
  const baseClaims = { iss: LOCAL_TOKEN_ISSUER, aud: LOCAL_TOKEN_AUDIENCE, sub: 'lu_ann', email: 'a@x.mil', name: 'Ann', iat: realNow, exp: realNow + 600 };
  assert(throws(() => verifyLocalToken(forge(SECRET, baseClaims))), 'T15 a token signed with the raw LOCAL_AUTH_SECRET is rejected');
  assert(!throws(() => verifyLocalToken(forge(deriveKey(SECRET, 'pbc-grc session-signing v1'), baseClaims))), 'T15 the same claims signed with the derived key verify (control)');
  assert(throws(() => verifyLocalToken(forge(deriveKey(SECRET, 'pbc-grc session-signing v1'), { ...baseClaims, purpose: 'mfa_pending' }))), 'T15 a correctly signed token with purpose mfa_pending is rejected as a session');

  console.log('\n--- T16 MFA_REQUIRED and startup configuration ---');
  assert(DEFAULT_MFA_REQUIREMENT === 'all' && getMfaRequirement({}) === DEFAULT_MFA_REQUIREMENT && getMfaRequirement({ MFA_REQUIRED: '  ' }) === 'all', 'T16 unset or blank gives the default (all)');
  assert(getMfaRequirement({ MFA_REQUIRED: 'all' }) === 'all' && getMfaRequirement({ MFA_REQUIRED: ' PRIVILEGED ' }) === 'privileged' && getMfaRequirement({ MFA_REQUIRED: 'off' }) === 'off', 'T16 all, privileged and off parse (trimmed, case-insensitive)');
  assert(throws(() => getMfaRequirement({ MFA_REQUIRED: 'yes' }), (e) => e instanceof LocalAuthConfigError), 'T16 any other value is a LocalAuthConfigError');
  assert(throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, MFA_REQUIRED: 'yes' }), (e) => e instanceof LocalAuthConfigError && /MFA_REQUIRED/.test((e as Error).message)), 'T16 assertAuthConfig refuses MFA_REQUIRED=yes');
  assert(throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, MFA_ENCRYPTION_KEY: 'short-key!' }), (e) => e instanceof LocalAuthConfigError && /MFA_ENCRYPTION_KEY/.test((e as Error).message)), 'T16 a 10-character MFA_ENCRYPTION_KEY is refused');
  assert(!throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, MFA_ENCRYPTION_KEY: MFA_KEY, MFA_REQUIRED: 'privileged' })) && !throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, MFA_ENCRYPTION_KEY: '' })), 'T16 a valid or empty MFA_ENCRYPTION_KEY passes');
  const offWarning = authStartupWarnings({ LOCAL_AUTH_SECRET: SECRET, MFA_REQUIRED: 'off', NODE_ENV: 'production' });
  assert(offWarning.length === 1 && offWarning[0] === 'MFA_REQUIRED=off in production: multi-factor authentication is disabled; NIST SP 800-171 3.5.3 is not met by the application', 'T16 off in production gives exactly one warning', offWarning);
  assert(authStartupWarnings({ MFA_REQUIRED: 'off', NODE_ENV: 'development' }).length === 0, 'T16 off in development gives none');
  assert(authStartupWarnings({ MFA_REQUIRED: 'all', NODE_ENV: 'production' }).length === 0 && authStartupWarnings({ NODE_ENV: 'production' }).length === 0, 'T16 all (or the default) in production gives none');

  console.log('\n--- T17 isMfaRequiredFor ---');
  const subjects = [
    { isPlatformAdmin: false, tenantRoles: [] },
    { isPlatformAdmin: true, tenantRoles: [] },
    { isPlatformAdmin: false, tenantRoles: ['VIEWER'] as const },
  ];
  assert(subjects.every((x) => !isMfaRequiredFor('off', x)), 'T17 off is never required');
  assert(subjects.every((x) => isMfaRequiredFor('all', x)), 'T17 all is always required, including a user with no tenant');
  assert(isMfaRequiredFor('privileged', { isPlatformAdmin: true, tenantRoles: [] }), 'T17 privileged: a platform admin');
  assert(isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: ['TENANT_OWNER'] }) && isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: ['MSP_ADMIN'] }), 'T17 privileged: TENANT_OWNER and MSP_ADMIN');
  assert(!isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: ['ASSESSOR'] }) && !isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: ['VIEWER'] }) && !isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: [] }), 'T17 privileged: ASSESSOR, VIEWER and no tenant are not');
  assert(isMfaRequiredFor('privileged', { isPlatformAdmin: false, tenantRoles: ['VIEWER', 'TENANT_OWNER'] }), 'T17 privileged: one write role in any tenant is enough');

  console.log('\n--- T18 / T19 storage (memory mode) ---');
  __resetMemoryLocalUsersForTests();
  const email = 'ann@enclave.mil';
  const created = await createLocalUser({ email, name: 'Ann', password: 'correct horse battery staple' });
  const createdKeys = Object.keys(created);
  assert(!createdKeys.includes('passwordHash') && !createdKeys.includes('totpSecretEnc') && !createdKeys.includes('recoveryCodeHashes'), 'T18 the created user has no passwordHash, totpSecretEnc or recoveryCodeHashes', createdKeys);
  assert(created.tokenVersion === 0 && created.mustChangePassword === false && created.totpConfirmedAt === null, 'T18 a new user starts at version 0, without a forced password change and without a factor');
  const id = created.id;

  const totpSecret = generateTotpSecret();
  const enc = encryptTotpSecret(totpSecret, id);
  assert((await setPendingTotpSecret(id, enc)) === true && (await findLocalUserByEmail(email))!.totpConfirmedAt === null, 'T18 a pending secret leaves totpConfirmedAt null');
  assert((await confirmTotp('lu_ghost', 5, [])) === false, 'T18 confirmTotp for an unknown user is false');
  const recovery = generateRecoveryCodes();
  const hashes = recovery.map((c) => hashRecoveryCode(normalizeRecoveryCode(c) as string));
  const step = totpStep(nowMs);
  assert((await consumeTotpStep(id, step)) === false, 'T18 an unconfirmed factor cannot consume a step');
  assert((await confirmTotp(id, step, hashes)) === true, 'T18 confirmTotp succeeds with a pending secret');
  const confirmed = (await findLocalUserByEmail(email))!;
  assert(confirmed.totpConfirmedAt instanceof Date && confirmed.totpLastUsedStep === step && confirmed.recoveryCodeHashes.length === 8, 'T18 confirmTotp sets confirmedAt, lastUsedStep and the hashes');
  assert((await confirmTotp(id, step + 9, hashes)) === false && (await setPendingTotpSecret(id, enc)) === false, 'T18 a confirmed factor cannot be re-confirmed or overwritten by a new pending secret');
  assert(
    (await consumeTotpStep(id, step)) === false && (await consumeTotpStep(id, step + 1)) === true && (await consumeTotpStep(id, step + 1)) === false && (await consumeTotpStep(id, step)) === false,
    'T18 consumeTotpStep: the used step and older are refused, the next is accepted once'
  );
  assert((await consumeRecoveryCode(id, hashes[0])) === true && (await consumeRecoveryCode(id, hashes[0])) === false && (await consumeRecoveryCode(id, 'f'.repeat(64))) === false, 'T18 consumeRecoveryCode: once, never twice, unknown refused');
  assert((await findLocalUserByEmail(email))!.recoveryCodeHashes.length === 7, 'T18 the remaining recovery codes go from 8 to 7');
  const regenerated = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  assert((await replaceRecoveryCodeHashes(id, regenerated)) === true, 'T18 replaceRecoveryCodeHashes: an enrolled user gets a fresh set');
  const afterReplace = (await findLocalUserByEmail(email))!.recoveryCodeHashes;
  assert(afterReplace.length === 3 && afterReplace.every((h, i) => h === regenerated[i]) && !afterReplace.includes(hashes[1]), 'T18 the old digests are gone and only the new set remains');
  assert((await consumeRecoveryCode(id, hashes[1])) === false && (await consumeRecoveryCode(id, regenerated[0])) === true, 'T18 an old code is refused and a new one is consumed');
  assert((await replaceRecoveryCodeHashes('lu_ghost', regenerated)) === false, 'T18 replaceRecoveryCodeHashes refuses an unknown user');

  // T19: nothing readable in the stored record.
  const stored = JSON.stringify(await findLocalUserByEmail(email));
  const b32Secret = base32Encode(totpSecret, { padding: false });
  assert(!stored.includes(b32Secret) && !stored.includes(totpSecret.toString('hex')) && !stored.includes(totpSecret.toString('base64')), 'T19 the stored record never holds the TOTP secret in the clear');
  assert(recovery.every((c) => !stored.includes(c) && !stored.includes(c.replace('-', ''))), 'T19 the stored record never holds a recovery code, formatted or normalized');

  const before = (await findLocalUserByEmail(email))!.tokenVersion;
  const reset = await resetLocalUserMfa('ANN@ENCLAVE.MIL');
  const afterReset = (await findLocalUserByEmail(email))!;
  assert(reset.found === true && reset.hadFactor === true, 'T18 resetLocalUserMfa finds the user (case-insensitive) and reports the factor', reset);
  assert(
    afterReset.totpSecretEnc === null && afterReset.totpConfirmedAt === null && afterReset.totpLastUsedStep === null && afterReset.recoveryCodeHashes.length === 0 &&
      afterReset.tokenVersion === before + 1 && afterReset.failedAttempts === 0 && afterReset.lockedUntil === null,
    'T18 resetLocalUserMfa clears the factor, bumps the version and clears the lockout'
  );
  const nobody = await resetLocalUserMfa('nobody@x.mil');
  assert(nobody.found === false, 'T18 resetLocalUserMfa for an unknown email is { found: false }', nobody);

  // Enrol again, then disable.
  await setPendingTotpSecret(id, enc);
  await confirmTotp(id, step, hashes);
  const v0 = (await getLocalUserAuthState(id))!.tokenVersion;
  assert((await setLocalUserDisabled(id, true)) === true, 'T18 setLocalUserDisabled(true) finds the user');
  const disabled = (await findLocalUserByEmail(email))!;
  assert(disabled.disabled === true && disabled.tokenVersion === v0 + 1 && disabled.totpConfirmedAt === null && disabled.recoveryCodeHashes.length === 0, 'T18 disabling bumps the version and clears the factor');
  await setLocalUserDisabled(id, false);
  assert((await findLocalUserByEmail(email))!.disabled === false && (await getLocalUserAuthState(id))!.tokenVersion === v0 + 1, 'T18 enabling does not bump the version again');
  await setPendingTotpSecret(id, enc);
  await confirmTotp(id, step, hashes);
  const v1 = (await getLocalUserAuthState(id))!.tokenVersion;
  assert((await clearLocalUserMfa(id)) === true && (await getLocalUserAuthState(id))!.tokenVersion === v1 + 1 && (await findLocalUserByEmail(email))!.totpConfirmedAt === null, 'T18 clearLocalUserMfa clears the factor and bumps the version');

  // Password change.
  const vp = (await getLocalUserAuthState(id))!.tokenVersion;
  const newPassword = 'a completely different passphrase';
  const hash = await hashPassword(newPassword);
  assert((await setLocalUserPassword(id, hash)) === true, 'T18 setLocalUserPassword finds the user');
  const afterPw = (await findLocalUserByEmail(email))!;
  assert(afterPw.tokenVersion === vp + 1, 'T18 a password change bumps the version');
  assert((await verifyPassword(newPassword, afterPw.passwordHash)) === true && (await verifyPassword('correct horse battery staple', afterPw.passwordHash)) === false, 'T18 the new password verifies and the old one does not');
  assert((await getLocalUserAuthState('lu_ghost')) === null && (await setLocalUserPassword('lu_ghost', hash)) === false, 'T18 an unknown id has no auth state and no password change');

  // must_change_password.
  assert((await getLocalUserAuthState(id))!.mustChangePassword === false, 'T18 must_change_password defaults to false');
  const hash2 = await hashPassword('yet another long passphrase');
  await setLocalUserPassword(id, hash2, { mustChangePassword: true });
  assert((await findLocalUserByEmail(email))!.mustChangePassword === true && (await getLocalUserAuthState(id))!.mustChangePassword === true, 'T18 an admin reset can set must_change_password in the same call');
  const hash3 = await hashPassword('and one more long passphrase');
  await setLocalUserPassword(id, hash3);
  assert((await findLocalUserByEmail(email))!.mustChangePassword === false, 'T18 a later password change clears must_change_password');
  assert((await setMustChangePassword(id, true)) === true && (await getLocalUserAuthState(id))!.mustChangePassword === true, 'T18 setMustChangePassword sets the flag');
  const flagged = await createLocalUser({ email: 'bob@enclave.mil', name: 'Bob', password: 'bobs long passphrase here' }, { mustChangePassword: true });
  assert(flagged.mustChangePassword === true, 'T18 createLocalUser can create a user who must change the password');

  const listed = await listLocalUsers();
  assert(listed.length === 2 && listed.every((u) => !('passwordHash' in u) && !('totpSecretEnc' in u) && !('recoveryCodeHashes' in u) && typeof u.mfaEnrolled === 'boolean'), 'T18 listLocalUsers returns public fields plus mfaEnrolled');

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
