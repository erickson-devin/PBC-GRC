import {
  VM_KEV_RULE_TEXT,
  VM_POLICY_LIMITS,
  canApprove,
  computeRemediationTier,
  decisionState,
  effectiveDecision,
  expiringSoon,
  packageCanonical,
  samePolicy,
  tallyTiers,
  validateDecisionRequest,
  validateRemediationPolicy,
  type VmEffectiveDecision,
  type VmRemediationPolicy,
  type VmTierFinding,
  type VmTierResult,
} from '../src/data/vmRemediation';
import type { VmSeverity } from '../src/types/vm';

/**
 * Pure checks (no server, no database, no clock): the remediation policy validation, the tier of a finding and the risk decision rules
 * (state, effective decision, approver, request validation, expiring, package fingerprint) (#268, docs/VULNERABILITY_MANAGEMENT.md, section 6.4).
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
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const NOW = '2026-11-19T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const D = 86_400_000;
const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();
const DEF: VmRemediationPolicy = { slaDays: { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 }, warnOnly: ['MEDIUM', 'LOW'], graceDays: 0 };
const clone = (p: VmRemediationPolicy): Record<string, unknown> => JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
const withDays = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({ ...clone(DEF), slaDays: { ...DEF.slaDays, ...over } });

console.log('\n=== Policy validation ===');
{
  const v = validateRemediationPolicy(clone(DEF));
  assert(v.ok && eq(v.policy, DEF) && eq(v.policy.warnOnly, ['MEDIUM', 'LOW']), 'V1 the default policy is valid and warnOnly is kept', v);
  const v2 = validateRemediationPolicy(withDays({ CRITICAL: 0 }));
  assert(!v2.ok && v2.field === 'slaDays.CRITICAL' && v2.rule === 'integer_range', 'V2 CRITICAL 0 -> integer_range', v2);
  const v3 = validateRemediationPolicy(withDays({ HIGH: 3651 }));
  assert(!v3.ok && v3.field === 'slaDays.HIGH' && v3.rule === 'integer_range', 'V3 HIGH 3651 -> integer_range', v3);
  const v4 = validateRemediationPolicy(withDays({ HIGH: 10 }));
  assert(!v4.ok && v4.field === 'slaDays.HIGH' && v4.rule === 'order', 'V4 HIGH 10 below CRITICAL 15 -> order', v4);
  for (const bad of [['CRITICAL'], ['HIGH']]) {
    const v5 = validateRemediationPolicy({ ...clone(DEF), warnOnly: bad });
    assert(!v5.ok && v5.field === 'warnOnly' && v5.rule === 'not_allowed', `V5 warnOnly ${JSON.stringify(bad)} -> not_allowed`, v5);
  }
  const v6 = validateRemediationPolicy({ ...clone(DEF), warnOnly: ['MEDIUM'] });
  assert(!v6.ok && v6.field === 'warnOnly' && v6.rule === 'order', 'V6 MEDIUM warn-only without LOW -> order', v6);
  for (const bad of [31, 1.5, '7', -1, null]) {
    const v7 = validateRemediationPolicy({ ...clone(DEF), graceDays: bad });
    assert(!v7.ok && v7.field === 'graceDays' && v7.rule === 'integer_range', `V7 graceDays ${JSON.stringify(bad)} -> integer_range`, v7);
  }
  const v8 = validateRemediationPolicy({ ...clone(DEF), extra: 1 });
  assert(!v8.ok && v8.field === 'body' && v8.rule === 'unknown_key', 'V8 an extra key -> unknown_key', v8);
  const v9 = validateRemediationPolicy({ ...clone(DEF), warnOnly: ['LOW', 'LOW'] });
  assert(v9.ok && eq(v9.policy.warnOnly, ['LOW']), 'V9 duplicates collapse', v9);
  const v10 = validateRemediationPolicy({ ...clone(DEF), warnOnly: ['LOW', 'MEDIUM'] });
  assert(v10.ok && eq(v10.policy.warnOnly, ['MEDIUM', 'LOW']), 'V10 warnOnly is normalised to severity order', v10);
  const v11 = validateRemediationPolicy({ ...clone(DEF), warnOnly: [] });
  assert(v11.ok && eq(v11.policy.warnOnly, []), 'V11 an empty warnOnly is valid', v11);
  assert(!validateRemediationPolicy(null).ok && !validateRemediationPolicy([]).ok && !validateRemediationPolicy('x').ok, 'V12 a non-object body is refused');
  const v13 = validateRemediationPolicy({ ...clone(DEF), slaDays: { ...DEF.slaDays, UNKNOWN: 5 } });
  assert(!v13.ok && v13.field === 'slaDays' && v13.rule === 'unknown_key', 'V13 an unknown severity key -> unknown_key', v13);
  const v14 = validateRemediationPolicy({ slaDays: DEF.slaDays, warnOnly: [] });
  assert(!v14.ok && v14.field === 'graceDays', 'V14 a missing field is refused', v14);
  const v15 = validateRemediationPolicy({ ...clone(DEF), graceDays: 30, slaDays: { CRITICAL: 1, HIGH: 1, MEDIUM: 3650, LOW: 3650 } });
  assert(v15.ok && VM_POLICY_LIMITS.graceMax === 30 && VM_POLICY_LIMITS.daysMin === 1 && VM_POLICY_LIMITS.daysMax === 3650, 'V15 the limits are accepted at their edges', v15);
  const bodyCopy = JSON.stringify(clone(DEF));
  const v16 = validateRemediationPolicy(JSON.parse(bodyCopy));
  assert(v16.ok && v16.policy.slaDays !== (JSON.parse(bodyCopy) as { slaDays: unknown }).slaDays && JSON.stringify(v16.policy) === JSON.stringify(DEF), 'V16 the validated policy has the canonical shape');
  assert(
    samePolicy(DEF, { ...DEF, slaDays: { ...DEF.slaDays } }) && !samePolicy(DEF, { ...DEF, graceDays: 1 }) && !samePolicy(DEF, { ...DEF, warnOnly: ['LOW'] }) &&
      !samePolicy(DEF, { ...DEF, slaDays: { ...DEF.slaDays, LOW: 181 } }) && samePolicy(DEF, { ...DEF, warnOnly: ['LOW', 'MEDIUM'] }),
    'V17 samePolicy compares days, grace and the warn-only set',
  );
  assert(
    VM_KEV_RULE_TEXT === "A known exploited vulnerability (CISA KEV) is due within the Critical deadline, or its own severity's deadline if that is shorter. Once overdue it is always a gap, with no grace period.",
    'V18 the known-exploited rule text is fixed',
  );
}

console.log('\n=== Tiers ===');
const fnd = (over: Partial<VmTierFinding> = {}): VmTierFinding => ({ status: 'OPEN', severity: 'CRITICAL', slaDueAt: at(D), kev: false, ...over });
const tier = (f: VmTierFinding, policy: VmRemediationPolicy = DEF, decision: VmEffectiveDecision | null = null): VmTierResult =>
  computeRemediationTier(f, policy, decision, NOW_MS);
const dec = (expiresAt: string, kind: VmEffectiveDecision['kind'] = 'RISK_ACCEPTED'): VmEffectiveDecision => ({ decisionId: 'd1', kind, expiresAt, approvedAt: at(-D) });
{
  const t1 = tier(fnd({ status: 'RESOLVED', slaDueAt: at(-5 * D) }));
  assert(t1.tier === 'CLOSED' && t1.reason === 'resolved', 'T1 RESOLVED -> CLOSED', t1);
  const t2 = tier(fnd({ slaDueAt: at(D) }));
  assert(t2.tier === 'ON_TRACK' && t2.reason === 'within_due' && t2.overdueDays === null && t2.dueAt === at(D), 'T2 due tomorrow -> ON_TRACK', t2);
  const t3 = tier(fnd({ slaDueAt: NOW }));
  assert(t3.tier === 'ON_TRACK', 'T3 due exactly now is not overdue', t3);
  const t4 = tier(fnd({ slaDueAt: at(-1) }));
  assert(t4.tier === 'GAP' && t4.reason === 'overdue' && t4.overdueDays === 0, 'T4 overdue by 1 ms -> GAP, 0 whole days', t4);
  const t5 = tier(fnd({ severity: 'HIGH', slaDueAt: at(-10 * D) }));
  assert(t5.tier === 'GAP' && t5.overdueDays === 10, 'T5 HIGH overdue by 10 days -> GAP', t5);
  const t6 = tier(fnd({ severity: 'MEDIUM', slaDueAt: at(-D) }));
  assert(t6.tier === 'WARNING' && t6.reason === 'warn_only_severity', 'T6 MEDIUM overdue -> WARNING', t6);
  const t7a = tier(fnd({ severity: 'LOW', slaDueAt: at(-D) }));
  const t7b = tier(fnd({ severity: 'UNKNOWN', slaDueAt: at(-D) }));
  assert(t7a.tier === 'WARNING' && t7b.tier === 'WARNING' && t7b.reason === 'warn_only_severity', 'T7 LOW and UNKNOWN (held to MEDIUM) -> WARNING', { t7a, t7b });
  const t7c = tier(fnd({ severity: 'UNKNOWN', slaDueAt: at(-D) }), { ...DEF, warnOnly: ['LOW'] });
  assert(t7c.tier === 'GAP', 'T7b UNKNOWN follows MEDIUM: a gap when MEDIUM is not warn-only', t7c);
  const t8 = tier(fnd({ severity: 'MEDIUM', slaDueAt: at(-D), kev: true }));
  assert(t8.tier === 'GAP' && t8.reason === 'kev_overdue', 'T8 overdue KEV MEDIUM -> GAP kev_overdue', t8);
  const g7 = { ...DEF, graceDays: 7 };
  const t9a = tier(fnd({ severity: 'HIGH', slaDueAt: at(-7 * D) }), g7);
  const t9b = tier(fnd({ severity: 'HIGH', slaDueAt: at(-7 * D - 1) }), g7);
  assert(t9a.tier === 'WARNING' && t9a.reason === 'grace_period' && t9a.graceEndsAt === NOW, 'T9 HIGH overdue exactly 7 days with grace 7 -> WARNING until due + 7 d', t9a);
  assert(t9b.tier === 'GAP' && t9b.reason === 'overdue', 'T9 one millisecond past the grace -> GAP', t9b);
  const t10 = tier(fnd({ severity: 'CRITICAL', slaDueAt: at(-D), kev: true }), g7);
  assert(t10.tier === 'GAP' && t10.reason === 'kev_overdue' && t10.graceEndsAt === null, 'T10 no grace for known-exploited', t10);
  const t11 = tier(fnd({ severity: 'LOW', slaDueAt: at(-D) }), { ...DEF, warnOnly: [] });
  assert(t11.tier === 'GAP', 'T11 warn-only empty: an overdue LOW is a gap', t11);
  const t12 = tier(fnd({ slaDueAt: null }));
  assert(t12.tier === 'ON_TRACK' && t12.reason === 'no_due_date' && t12.dueAt === null && t12.overdueDays === null, 'T12 no due date -> ON_TRACK', t12);
  const t13 = tier(fnd({ slaDueAt: at(-3 * D) }), DEF, dec(at(D)));
  assert(t13.tier === 'ACCEPTED' && t13.reason === 'risk_accepted' && t13.decision?.id === 'd1' && t13.decision.kind === 'RISK_ACCEPTED' && t13.decision.expiresAt === at(D), 'T13 an unexpired decision accepts an overdue CRITICAL', t13);
  const t13b = tier(fnd({ slaDueAt: at(-3 * D) }), DEF, dec(at(D), 'FALSE_POSITIVE'));
  assert(t13b.tier === 'ACCEPTED' && t13b.reason === 'false_positive', 'T13b a FALSE_POSITIVE decision -> ACCEPTED false_positive', t13b);
  const t14 = tier(fnd({ slaDueAt: at(-3 * D) }), DEF, dec(NOW));
  assert(t14.tier === 'GAP' && t14.decision === null, 'T14 a decision expiring exactly now no longer applies -> GAP', t14);
  for (const status of ['RISK_ACCEPTED', 'FALSE_POSITIVE'] as const) {
    const t15 = tier(fnd({ status, slaDueAt: at(-3 * D) }));
    assert(t15.tier === 'ACCEPTED' && t15.reason === 'legacy_decision', `T15 legacy status ${status} -> ACCEPTED legacy_decision`, t15);
  }
  const t16 = tier(fnd({ status: 'RESOLVED', slaDueAt: at(-3 * D) }), DEF, dec(at(D)));
  assert(t16.tier === 'CLOSED', 'T16 RESOLVED wins over a decision', t16);
  const t17 = tier(fnd({ slaDueAt: at(D) }), DEF, dec(at(D)));
  assert(t17.tier === 'ACCEPTED', 'T17 a decision on a finding not yet overdue is still ACCEPTED', t17);
}
{
  const cases: Array<[VmTierFinding, VmRemediationPolicy]> = [
    [fnd({ slaDueAt: at(D) }), DEF], // T2
    [fnd({ slaDueAt: NOW }), DEF], // T3
    [fnd({ slaDueAt: at(-1) }), DEF], // T4
    [fnd({ severity: 'HIGH', slaDueAt: at(-10 * D) }), DEF], // T5
    [fnd({ severity: 'MEDIUM', slaDueAt: at(-D) }), DEF], // T6
    [fnd({ severity: 'LOW', slaDueAt: at(-D) }), DEF], // T7
    [fnd({ severity: 'UNKNOWN', slaDueAt: at(-D) }), DEF], // T7
    [fnd({ severity: 'MEDIUM', slaDueAt: at(-D), kev: true }), DEF], // T8
    [fnd({ severity: 'HIGH', slaDueAt: at(-7 * D) }), { ...DEF, graceDays: 7 }], // T9
    [fnd({ severity: 'HIGH', slaDueAt: at(-7 * D - 1) }), { ...DEF, graceDays: 7 }], // T9
    [fnd({ severity: 'CRITICAL', slaDueAt: at(-D), kev: true }), { ...DEF, graceDays: 7 }], // T10
    [fnd({ severity: 'LOW', slaDueAt: at(-D) }), { ...DEF, warnOnly: [] }], // T11
  ];
  const results = cases.map(([f, p]) => tier(f, p));
  const sevs: VmSeverity[] = cases.map(([f]) => f.severity);
  const t = tallyTiers(results, sevs);
  const count = (x: string): number => results.filter((r) => r.tier === x).length;
  assert(t.onTrack === count('ON_TRACK') && t.warning === count('WARNING') && t.gap === count('GAP') && t.accepted === count('ACCEPTED'), 'TT1 the tally equals a count of the tiers', { t, results: results.map((r) => r.tier) });
  assert(
    t.gap === 6 && t.gapCritical === 2 && t.gapHigh === 2 && t.gapKev === 2 && t.warning === 4 && eq(t.warningBySeverity, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 1, UNKNOWN: 1 }),
    'TT2 the tally splits gaps by severity and known-exploited, warnings by severity',
    t,
  );
  const mixed = tallyTiers([tier(fnd({ status: 'RESOLVED' })), tier(fnd({ status: 'RISK_ACCEPTED' }))], ['CRITICAL', 'CRITICAL']);
  assert(mixed.accepted === 1 && mixed.onTrack === 0 && mixed.gap === 0 && mixed.warning === 0, 'TT3 closed findings are not counted, accepted ones are', mixed);
  const empty = tallyTiers([], []);
  assert(empty.gap === 0 && eq(empty.warningBySeverity, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }), 'TT4 an empty tally is all zero', empty);
}

console.log('\n=== Risk decisions: state (DS), effective decision (EF) ===');
{
  const FP = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const core = (kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE', expiresAt: string, fingerprint = FP) => ({ kind, expiresAt, packageFingerprint: fingerprint });
  const ev = (action: 'approved' | 'rejected' | 'withdrawn' | 'revoked', createdAt = at(-D)) => ({ action, createdAt });
  const future = at(10 * D);
  assert(decisionState(core('RISK_ACCEPTED', future), [], FP, NOW_MS) === 'PENDING', 'DS1 no events and a future expiry -> PENDING');
  assert(decisionState(core('RISK_ACCEPTED', future), [ev('approved')], FP, NOW_MS) === 'ACTIVE', 'DS2 approved -> ACTIVE');
  assert(decisionState(core('RISK_ACCEPTED', at(0)), [ev('approved')], FP, NOW_MS) === 'EXPIRED' && decisionState(core('RISK_ACCEPTED', at(-1)), [ev('approved')], FP, NOW_MS) === 'EXPIRED', 'DS3 approved and now >= expiry -> EXPIRED (a decision is effective strictly before its expiry)');
  assert(decisionState(core('RISK_ACCEPTED', at(1)), [ev('approved')], FP, NOW_MS) === 'ACTIVE', 'DS3 one millisecond before the expiry it is still ACTIVE');
  assert(decisionState(core('RISK_ACCEPTED', future), [ev('rejected')], FP, NOW_MS) === 'REJECTED' && decisionState(core('RISK_ACCEPTED', future), [ev('withdrawn')], FP, NOW_MS) === 'WITHDRAWN', 'DS4 rejected -> REJECTED, withdrawn -> WITHDRAWN');
  assert(decisionState(core('RISK_ACCEPTED', future), [ev('approved', at(-2 * D)), ev('revoked')], FP, NOW_MS) === 'REVOKED', 'DS5 approved then revoked -> REVOKED');
  assert(decisionState(core('FALSE_POSITIVE', future), [ev('approved')], OTHER, NOW_MS) === 'PACKAGE_CHANGED', 'DS6 an approved FALSE_POSITIVE with a different package fingerprint -> PACKAGE_CHANGED');
  assert(decisionState(core('RISK_ACCEPTED', future), [ev('approved')], OTHER, NOW_MS) === 'ACTIVE', 'DS7 an approved RISK_ACCEPTED with a different package fingerprint stays ACTIVE');
  assert(decisionState(core('RISK_ACCEPTED', at(-D)), [], FP, NOW_MS) === 'EXPIRED', 'DS8 a request nobody approved before its expiry -> EXPIRED');
  assert(decisionState(core('FALSE_POSITIVE', at(-D)), [ev('approved', at(-3 * D))], OTHER, NOW_MS) === 'EXPIRED', 'DS9 expiry wins over a package change');

  const a = { id: 'older', ...core('RISK_ACCEPTED', future) };
  const b = { id: 'newer', ...core('RISK_ACCEPTED', future) };
  const events = { older: [ev('approved', at(-5 * D))], newer: [ev('approved', at(-2 * D)), ev('revoked', at(-D))] };
  const e1 = effectiveDecision([a, b], events, FP, NOW_MS);
  assert(e1?.decisionId === 'older' && e1?.kind === 'RISK_ACCEPTED' && e1?.expiresAt === future && e1?.approvedAt === at(-5 * D), 'EF1 an older ACTIVE decision and a newer REVOKED one -> the older one is effective', e1);
  assert(effectiveDecision([a, b], { older: [ev('rejected')], newer: [] }, FP, NOW_MS) === null && effectiveDecision([], {}, FP, NOW_MS) === null, 'EF2 no ACTIVE decision -> null');
  const e3 = effectiveDecision([a, b], { older: [ev('approved', at(-5 * D))], newer: [ev('approved', at(-2 * D))] }, FP, NOW_MS);
  assert(e3?.decisionId === 'newer', 'EF3 two ACTIVE decisions -> the newest approval');
}

console.log('\n=== Risk decisions: approver (CA), request (VR), expiring (ES), packages (PC) ===');
{
  assert(canApprove({ userId: 'u1', role: 'TENANT_OWNER' }, 'u1') === 'self', 'CA1 the requester themselves -> self');
  assert(canApprove({ userId: 'u2', role: 'TENANT_ADMIN' }, 'u1') === 'role' && canApprove({ userId: 'u1', role: 'TENANT_ADMIN' }, 'u1') === 'role', 'CA1 a TENANT_ADMIN -> role (the role is checked first)');
  assert(canApprove({ userId: 'u2', role: 'MSP_ADMIN' }, 'u1') === 'ok' && canApprove({ userId: 'u2', role: 'TENANT_OWNER' }, 'u1') === 'ok', 'CA1 another owner or an MSP Admin -> ok');
  assert(canApprove({ userId: 'u2', role: null }, 'u1') === 'role' && canApprove({ userId: 'u2', role: 'ASSESSOR' }, 'u1') === 'role' && canApprove({ userId: 'u2', role: 'VIEWER' }, 'u1') === 'role', 'CA1 no role, an Assessor or a Viewer -> role');

  const day = (n: number): string => new Date(Math.floor(NOW_MS / D) * D + n * D).toISOString().slice(0, 10);
  const req = (over: Record<string, unknown> = {}) => ({ kind: 'RISK_ACCEPTED', justification: 'Reviewed with the system owner', expiresAt: day(30), ...over });
  const bad = (over: Record<string, unknown>) => validateDecisionRequest(req(over), NOW_MS);
  const ok1 = validateDecisionRequest(req(), NOW_MS);
  assert(ok1.ok && ok1.value.kind === 'RISK_ACCEPTED' && ok1.value.justification === 'Reviewed with the system owner' && ok1.value.expiresAt === `${day(30)}T00:00:00.000Z`, 'VR1 a valid request -> the kind, the trimmed text and the expiry as the start of that day (UTC)', ok1);
  assert(eq(bad({ justification: '' }), { ok: false, field: 'justification', code: 'required' }) && eq(bad({ justification: '   ' }), { ok: false, field: 'justification', code: 'required' }) && eq(bad({ justification: 7 }), { ok: false, field: 'justification', code: 'required' }), 'VR1 an empty, blank or non-text justification -> required');
  assert(eq(bad({ justification: '😀'.repeat(4001) }), { ok: false, field: 'justification', code: 'too_long' }) && bad({ justification: '😀'.repeat(4000) }).ok, 'VR1 4001 code points -> too_long; 4000 is fine');
  assert(eq(bad({ expiresAt: day(0) }), { ok: false, field: 'expiresAt', code: 'range' }) && eq(bad({ expiresAt: day(-3) }), { ok: false, field: 'expiresAt', code: 'range' }) && eq(bad({ expiresAt: day(366) }), { ok: false, field: 'expiresAt', code: 'range' }), 'VR1 an expiry of today, in the past, or beyond today + 365 -> range');
  assert(bad({ expiresAt: day(365) }).ok && bad({ expiresAt: day(1) }).ok, 'VR1 tomorrow and today + 365 are allowed');
  assert(eq(bad({ expiresAt: '' }), { ok: false, field: 'expiresAt', code: 'required' }) && eq(bad({ expiresAt: undefined }), { ok: false, field: 'expiresAt', code: 'required' }), 'VR1 no expiry -> required');
  assert(eq(bad({ expiresAt: '2026-13-40' }), { ok: false, field: 'expiresAt', code: 'range' }) && eq(bad({ expiresAt: '2027-02-30' }), { ok: false, field: 'expiresAt', code: 'range' }) && eq(bad({ expiresAt: `${day(30)}T00:00:00Z` }), { ok: false, field: 'expiresAt', code: 'range' }) && eq(bad({ expiresAt: 20270101 }), { ok: false, field: 'expiresAt', code: 'required' }), 'VR1 a date that is not a real YYYY-MM-DD calendar day -> range');
  assert(eq(bad({ kind: 'RESOLVED' }), { ok: false, field: 'kind', code: 'kind' }) && eq(bad({ kind: undefined }), { ok: false, field: 'kind', code: 'kind' }) && bad({ kind: 'FALSE_POSITIVE' }).ok, 'VR1 a kind that is not RISK_ACCEPTED or FALSE_POSITIVE -> kind');
  assert(eq(validateDecisionRequest(null, NOW_MS), { ok: false, field: 'body', code: 'required' }) && eq(validateDecisionRequest([], NOW_MS), { ok: false, field: 'body', code: 'required' }), 'VR1 a body that is not an object -> body required');
  assert(!JSON.stringify([bad({ justification: '' }), bad({ expiresAt: day(0) })]).includes('Reviewed'), 'VR1 a refusal never echoes the text');

  const row = (state: 'ACTIVE' | 'PENDING' | 'EXPIRED', days: number) => ({ state, expiresAt: at(days * D), tag: `${state}${days}` });
  const rows = [row('ACTIVE', 30), row('ACTIVE', 31), row('ACTIVE', 1), row('PENDING', 5), row('EXPIRED', -1)];
  assert(eq(expiringSoon(rows, NOW_MS).map((r) => r.tag), ['ACTIVE30', 'ACTIVE1']), 'ES1 ACTIVE rows expiring in exactly 30 days are included, in 31 days excluded; other states never');
  assert(eq(expiringSoon(rows, NOW_MS, 2).map((r) => r.tag), ['ACTIVE1']) && expiringSoon([], NOW_MS).length === 0, 'ES1 the window is a parameter');

  const pk = (name: string, version: string) => ({ name, version, fixedVersion: null });
  const base = { packageName: '', packageVersion: '', affectedPackageCount: 0 };
  const c1 = packageCanonical({ ...base, affectedPackages: [pk('zlib', '1.2'), pk('openssl', '1.0')], affectedPackageCount: 2 });
  const c2 = packageCanonical({ ...base, affectedPackages: [pk('openssl', '1.0'), pk('zlib', '1.2')], affectedPackageCount: 2 });
  assert(c1 === c2 && c1 === 'openssl@1.0\nzlib@1.2#2', 'PC1 the same packages in another order -> the same text (sorted lines and the count)', c1);
  assert(packageCanonical({ ...base, affectedPackages: [], packageName: 'bash', packageVersion: '5.0' }) === 'bash@5.0#1', 'PC1 the legacy single package stands in when the list is empty');
  assert(packageCanonical({ ...base, affectedPackages: [] }) === '#0', 'PC1 no packages at all -> "#0"');
  assert(packageCanonical({ ...base, affectedPackages: [pk('openssl', '1.1'), pk('zlib', '1.2')], affectedPackageCount: 2 }) !== c1 && packageCanonical({ ...base, affectedPackages: [pk('openssl', '1.0'), pk('zlib', '1.2')], affectedPackageCount: 3 }) !== c1, 'PC1 a new version, or a larger true count with the same list, changes it');
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total} assertions passed`);
process.exit(passed === total ? 0 : 1);
