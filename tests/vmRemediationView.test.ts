import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateDecisionRequest, validateRemediationPolicy, remediationPolicySspParagraph, VM_POLICY_SSP_LABEL_PREFIX } from '../src/data/vmRemediation';
import type { VmRemediationPolicy, VmTierResult } from '../src/data/vmRemediation';
import {
  DECISION_STATE_LABEL,
  REMEDIATION_COPY,
  TIER_LABEL,
  approverNote,
  canRequestDecision,
  decisionActionError,
  decisionActions,
  decisionConfirmText,
  decisionDateBounds,
  decisionDoneText,
  decisionFormErrors,
  decisionRequestError,
  decisionUnsavedText,
  expiryText,
  filterByTier,
  justificationView,
  loadErrorText,
  overdueText,
  ownerLevelCount,
  parseTierResult,
  pendingText,
  policyAsOf,
  policyChanges,
  policyEventView,
  policyFormErrors,
  policyFormFrom,
  policyFormSetWarn,
  policyFromForm,
  policySaveError,
  policySavedText,
  policySourceText,
  policySummaryRows,
  roleNote,
  splitPolicyParagraph,
  sspPolicyNote,
  summaryBreakdown,
  tierCounts,
  tierCountsText,
  tierLines,
  vmPoamPolicyNote,
} from '../src/data/telemetry/vmRemediationView';
import { parseVmFindings } from '../src/data/telemetry/vmFindingsView';
import { cmmcDisplayId } from '../src/data/cmmcGuide/displayId';
import { VmFindingsList } from '../src/components/telemetry/VmFindingsList';
import { VmRemediationPolicyPanel } from '../src/components/telemetry/VmRemediationPolicyPanel';
import { VmRemediationSummaryPanel } from '../src/components/telemetry/VmRemediationSummaryPanel';
import { VmDecisionCard } from '../src/components/telemetry/VmDecisionCard';
import { GeneratedParagraphText } from '../src/components/reports/GeneratedParagraphText';
import { PoamVulnerabilitiesSection } from '../src/components/reports/PoamVulnerabilitiesSection';
import type { VmFinding, VmPoamResponse, VmPoamRow } from '../src/types/vm';
import type { TeamMember } from '../src/types/tenant';
import type { VmDecision, VmRemediationPolicyResponse, VmRemediationSummary } from '../src/types/vmRemediation';

/**
 * The vulnerability remediation screens (#268): the pure wording and rules (tiers, the policy form, risk decisions, the SSP paragraph note), the
 * components rendered on the server (no browser), and source pins on the wiring. Pure test: no server boots.
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
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-11-19T15:00:00.000Z');
const DEF: VmRemediationPolicy = { slaDays: { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 }, warnOnly: ['MEDIUM', 'LOW'], graceDays: 0 };
const apiErr = (status: number, reason?: string) => ({ name: 'ApiError', status, reason });

const tier = (over: Partial<VmTierResult> = {}): VmTierResult => ({ tier: 'GAP', reason: 'overdue', dueAt: '2026-11-01T00:00:00Z', overdueDays: 18, graceEndsAt: null, decision: null, ...over });

console.log('--- TL1 tier labels and TL2 tierLines ---');
assert(JSON.stringify(TIER_LABEL) === JSON.stringify({ CLOSED: 'Closed', ON_TRACK: 'On track', WARNING: 'Warning', GAP: 'Gap', ACCEPTED: 'Accepted' }), 'TL1 TIER_LABEL');
{
  const l = (o: Partial<VmTierResult>) => tierLines(tier(o));
  assert(JSON.stringify(l({ tier: 'ON_TRACK', reason: 'within_due', dueAt: '2026-12-04T00:00:00Z', overdueDays: null })) === JSON.stringify({ due: 'Due 2026-12-04', reason: null }), 'TL2 on track');
  assert(JSON.stringify(l({ tier: 'ON_TRACK', reason: 'no_due_date', dueAt: null, overdueDays: null })) === JSON.stringify({ due: 'No deadline recorded', reason: null }), 'TL2 no deadline');
  assert(l({}).due === 'Due 2026-11-01 · 18 days past due' && l({ overdueDays: 0 }).due === 'Due 2026-11-01 · less than a day past due' && l({ overdueDays: 1 }).due === 'Due 2026-11-01 · 1 day past due', 'TL2 overdue wording');
  assert(l({ tier: 'WARNING', reason: 'warn_only_severity' }).reason === 'Warning-only severity under the policy', 'TL2 warn only');
  assert(l({ tier: 'WARNING', reason: 'grace_period', graceEndsAt: '2026-11-26T00:00:00Z' }).reason === 'In grace period until 2026-11-26', 'TL2 grace');
  assert(l({ reason: 'kev_overdue' }).reason === 'Known exploited', 'TL2 kev');
  assert(l({ tier: 'ACCEPTED', reason: 'risk_accepted', decision: { id: 'd', kind: 'RISK_ACCEPTED', expiresAt: '2027-03-01T00:00:00Z' } }).reason === 'Risk accepted until 2027-03-01', 'TL2 risk accepted');
  assert(l({ tier: 'ACCEPTED', reason: 'false_positive', decision: { id: 'd', kind: 'FALSE_POSITIVE', expiresAt: '2027-03-01T00:00:00Z' } }).reason === 'False positive until 2027-03-01', 'TL2 false positive');
  assert(l({ tier: 'ACCEPTED', reason: 'legacy_decision' }).reason === 'Decision recorded on the finding', 'TL2 legacy');
  assert(JSON.stringify(l({ tier: 'CLOSED', reason: 'resolved' })) === JSON.stringify({ due: null, reason: null }), 'TL2 closed');
  assert(overdueText(0) === 'less than a day past due' && overdueText(1) === '1 day past due' && overdueText(5) === '5 days past due', 'TL2 overdueText');
}

console.log('\n--- PT1 parseTierResult ---');
{
  const ok = tier({ decision: { id: 'd1', kind: 'RISK_ACCEPTED', expiresAt: '2027-01-01T00:00:00Z' } });
  assert(JSON.stringify(parseTierResult(ok)) === JSON.stringify(ok), 'PT1 a valid object round-trips');
  assert(parseTierResult({ tier: 'X', reason: 'overdue' }) === null && parseTierResult(null) === null && parseTierResult('x') === null && parseTierResult({ tier: 'GAP', reason: 'nope' }) === null, 'PT1 unknown tier or reason, null and a string give null');
  assert(parseTierResult({ ...ok, overdueDays: '3' })?.overdueDays === null, 'PT1 a non-number overdueDays becomes null');
  const f = parseVmFindings({ findings: [{ id: 'a', vulnId: 'CVE-1', status: 'OPEN', kev: true, remediation: ok }, { id: 'b', vulnId: 'CVE-2', status: 'OPEN', remediation: { tier: 'bad' } }] }).findings;
  assert(f[0].kev === true && f[0].remediation?.tier === 'GAP' && f[1].kev === false && f[1].remediation === null, 'PT1 parseFinding carries kev and the tier');
}

console.log('\n--- FT1 filter and counts ---');
{
  const rows = [{ remediation: tier() }, { remediation: tier({ tier: 'WARNING' }) }, { remediation: tier({ tier: 'ON_TRACK' }) }, {}, { remediation: tier({ tier: 'GAP' }) }];
  assert(filterByTier(rows, 'GAP').length === 2 && filterByTier(rows, 'ALL').length === 5 && filterByTier(rows, 'ACCEPTED').length === 0, 'FT1 filterByTier');
  const c = tierCounts(rows);
  assert(c.GAP === 2 && c.WARNING === 1 && c.ON_TRACK === 1 && c.ACCEPTED === 0, 'FT1 tierCounts ignores rows without a tier', c);
  assert(tierCountsText({ GAP: 2, WARNING: 0, ON_TRACK: 10, ACCEPTED: 1 }) === 'Remediation: Gap 2 · On track 10 · Accepted 1' && tierCountsText({ GAP: 0, WARNING: 0, ON_TRACK: 0, ACCEPTED: 0 }) === '', 'FT1 tierCountsText');
}

console.log('\n--- PF1-PF2 policy form ---');
{
  const f = policyFormFrom(DEF);
  assert(JSON.stringify(f) === JSON.stringify({ CRITICAL: '15', HIGH: '30', MEDIUM: '90', LOW: '180', warnMedium: true, warnLow: true, graceDays: '0' }), 'PF1 policyFormFrom', f);
  const none = { ...f, warnMedium: false, warnLow: false };
  const m = policyFormSetWarn(none, 'MEDIUM', true);
  assert(m.warnMedium && m.warnLow, 'PF2 Medium on forces Low on');
  assert(policyFormSetWarn(f, 'LOW', false) === f, 'PF2 Low cannot be turned off while Medium is on (same object)');
  assert(policyFormSetWarn(f, 'MEDIUM', false).warnLow === true && policyFormSetWarn(f, 'MEDIUM', false).warnMedium === false, 'PF2 Medium off leaves Low on');
  assert(policyFormSetWarn(none, 'LOW', true).warnLow === true && policyFormSetWarn(none, 'LOW', true).warnMedium === false, 'PF2 Low alone');
}

console.log('\n--- PE1-PE2 validation ---');
{
  const base = policyFormFrom(DEF);
  const DAYS = 'Enter whole days from 1 to 3650.';
  const bad = ['', '0', '3651', '1.5', 'abc'].map((v) => policyFormErrors({ ...base, CRITICAL: v }).CRITICAL);
  assert(bad.every((e) => e === DAYS), 'PE1 invalid day values', bad);
  assert(policyFormErrors({ ...base, CRITICAL: ' 15 ' }).CRITICAL === undefined, 'PE1 a padded value is fine');
  assert(JSON.stringify(policyFormErrors({ ...base, HIGH: '10' })) === JSON.stringify({ HIGH: 'Must be at least the Critical deadline (15 days).' }), 'PE1 order High');
  assert(policyFormErrors({ ...base, LOW: '60' }).LOW === 'Must be at least the Medium deadline (90 days).', 'PE1 order Low against Medium');
  assert(policyFormErrors({ ...base, graceDays: '31' }).graceDays === 'Enter whole days from 0 to 30.' && policyFormErrors({ ...base, graceDays: '' }).graceDays === 'Enter whole days from 0 to 30.', 'PE1 grace range');
  assert(Object.keys(policyFormErrors(base)).length === 0, 'PE1 the defaults are valid');
  const back = policyFromForm(base);
  assert(JSON.stringify(back) === JSON.stringify(DEF) && validateRemediationPolicy(back).ok === true, 'PE2 policyFromForm round-trips and the shared validator accepts it', back);
  assert(policyFromForm({ ...base, HIGH: '1' }) === null, 'PE2 an invalid form gives null');
  const odd = policyFromForm({ ...base, warnMedium: true, warnLow: false });
  assert(JSON.stringify(odd?.warnOnly) === JSON.stringify(['MEDIUM', 'LOW']), 'PE2 Medium always brings Low', odd);
}

console.log('\n--- PC1 changes, PS1-PS2 errors and saved text, PV1 events, SB1 summary ---');
{
  const changed: VmRemediationPolicy = { slaDays: { ...DEF.slaDays, CRITICAL: 10 }, warnOnly: ['LOW'], graceDays: 7 };
  assert(JSON.stringify(policyChanges(DEF, changed)) === JSON.stringify(['Critical deadline from 15 days to 10 days', 'Warning only from Medium and Low to Low', 'Grace period from None to 7 days']), 'PC1 policyChanges', policyChanges(DEF, changed));
  assert(policyChanges(DEF, DEF).length === 0, 'PC1 no change');
  const rows = policySummaryRows(DEF);
  assert(rows.length === 6 && rows[0].value === '15 days' && rows[4].value === 'Medium and Low' && rows[5].value === 'None', 'PC1 summary rows', rows);
  assert(policySourceText({ source: 'defaults', updatedAt: null, updatedBy: null }) === 'No policy has been saved for this organization, so the server defaults apply.' && policySourceText({ source: 'tenant', updatedAt: '2026-11-18T10:00:00Z', updatedBy: 'Ann' }) === 'Last changed 2026-11-18 by Ann.', 'PC1 source text');

  assert(JSON.stringify(policySaveError(apiErr(401))) === JSON.stringify({ kind: 'session', text: null }), 'PS1 401');
  assert(policySaveError(apiErr(409, 'stale_write')).text === 'Someone else changed the policy while you were editing, so nothing was saved.' && policySaveError(apiErr(409, 'stale_write')).kind === 'stale', 'PS1 stale');
  assert(policySaveError(apiErr(400, 'invalid_policy')).text === 'The server refused these values. Check each field and try again.', 'PS1 400');
  assert(policySaveError(apiErr(403, 'owner_required')).text === 'Only owner-level roles (Tenant Owner, MSP Admin) can change this policy. Nothing was saved.' && policySaveError(apiErr(403)).kind === 'forbidden', 'PS1 403 with and without a reason');
  assert(policySaveError(apiErr(0)).text === 'The server could not be reached. Nothing was saved.' && policySaveError(new Error('x')).text === 'The policy could not be saved. Try again.' && policySaveError(apiErr(500)).kind === 'failed', 'PS1 network and failures');
  assert(policySavedText({ changed: false, impact: { openRecomputed: 0, gap: 0, warning: 0 } }) === 'Nothing to save: the policy already has these values.', 'PS2 no-op');
  assert(policySavedText({ changed: true, impact: { openRecomputed: 1, gap: 2, warning: 1 } }) === 'Policy saved. 1 open finding got a new deadline. Open vulnerabilities now: 2 gaps, 1 warning.', 'PS2 saved');

  const ev = policyEventView({ id: 'e', actor: 'Ann', actorRole: 'TENANT_OWNER', oldPolicy: null, newPolicy: DEF, openFindingsRecomputed: 3, createdAt: '2026-11-19T10:05:00Z' });
  assert(ev.what === 'Saved the first policy: Critical 15, High 30, Medium 90, Low 180 days; warning only: Medium and Low; grace period: None.' && ev.who === 'Ann (Tenant Owner)' && ev.when === '2026-11-19 10:05 UTC' && ev.impact === '3 open findings got a new deadline.', 'PV1 first event', ev);
  const ev2 = policyEventView({ id: 'e', actor: 'Bo', actorRole: null, oldPolicy: DEF, newPolicy: DEF, openFindingsRecomputed: 1, createdAt: '2026-11-19T10:05:00Z' });
  assert(ev2.what === 'No value changed.' && ev2.who === 'Bo' && ev2.impact === '1 open finding got a new deadline.', 'PV1 unchanged event', ev2);

  const sum = (o: Partial<VmRemediationSummary>): VmRemediationSummary => ({ generatedAt: '', policy: DEF, counts: { onTrack: 1, warning: 3, gap: 3, accepted: 0 }, warningBySeverity: { MEDIUM: 2, LOW: 1 }, gapCritical: 2, gapHigh: 1, gapKev: 0, ...o });
  const s0 = summaryBreakdown(sum({}));
  assert(s0.gaps === 'Of the gaps: Critical 2, High 1.' && !s0.gaps.includes('known exploited') && s0.warnings === 'Of the warnings: Medium 2, Low 1.', 'SB1 breakdown', s0);
  assert(summaryBreakdown(sum({ gapKev: 1 })).gaps?.endsWith(', known exploited 1.') === true, 'SB1 kev only when above zero');
  assert(summaryBreakdown(sum({ counts: { onTrack: 0, warning: 0, gap: 0, accepted: 0 } })).gaps === null && summaryBreakdown(sum({ counts: { onTrack: 0, warning: 0, gap: 0, accepted: 0 } })).warnings === null, 'SB1 nothing to break down');
  assert(loadErrorText('policy', true) === 'The server could not be reached, so the remediation policy could not be loaded.' && loadErrorText('history', false) === 'The policy history could not be loaded.', 'SB1 loadErrorText');
}

console.log('\n--- PN1 POA&M row note, RN1 role notes ---');
{
  const r = (status: string, remediation: VmTierResult | null | undefined, severity = 'MEDIUM'): Pick<VmPoamRow, 'status' | 'finding'> =>
    ({ status, finding: { id: 'f', vulnId: 'CVE-1', severity, status: 'OPEN', kev: false, firstSeenAt: '', lastSeenAt: '', slaDueAt: null, resolvedAt: null, affectedPackages: [], affectedPackageCount: 0, asset: null, remediation } }) as unknown as Pick<VmPoamRow, 'status' | 'finding'>;
  assert(vmPoamPolicyNote(r('OPEN', tier({ tier: 'WARNING', reason: 'warn_only_severity' }))) === 'Not required by the current policy (Medium is warning only)', 'PN1 warn only');
  assert(vmPoamPolicyNote(r('IN_PROGRESS', tier({ tier: 'WARNING', reason: 'grace_period', graceEndsAt: '2026-11-26T00:00:00Z' }))) === 'Not required by the current policy (in the grace period until 2026-11-26)', 'PN1 grace');
  assert(vmPoamPolicyNote(r('OPEN', tier({ tier: 'ACCEPTED', reason: 'risk_accepted', decision: { id: 'd', kind: 'RISK_ACCEPTED', expiresAt: '2027-03-01T00:00:00Z' } }))) === 'Not required by the current policy (risk accepted until 2027-03-01)', 'PN1 accepted');
  assert(vmPoamPolicyNote(r('OPEN', tier({ tier: 'WARNING', reason: 'warn_only_severity' }), 'UNKNOWN')) === 'Not required by the current policy (Unknown severity is warning only)', 'PN1 unknown severity');
  assert(vmPoamPolicyNote(r('OPEN', tier())) === null && vmPoamPolicyNote(r('COMPLETED', tier({ tier: 'WARNING', reason: 'warn_only_severity' }))) === null && vmPoamPolicyNote(r('OPEN', undefined)) === null && vmPoamPolicyNote({ status: 'OPEN', finding: null }) === null, 'PN1 gap, completed, no tier and no finding give null');
  assert(roleNote('ASSESSOR') === 'Read-only: you can review the policy and the decisions, including their justifications, but not change them.', 'RN1 assessor');
  assert(roleNote('VIEWER') === 'Read-only: you can see the policy and which decisions exist. Justifications are not shown to Viewers.', 'RN1 viewer');
  assert(roleNote('TENANT_ADMIN') === 'You can request decisions. Changing the policy and approving decisions needs owner-level access (Tenant Owner, MSP Admin).', 'RN1 admin');
  assert(roleNote('TENANT_OWNER') === null && roleNote('MSP_ADMIN') === null && roleNote(null) === null, 'RN1 owner-level and none');
}

// every user-facing string of the module, with the function-valued ones called
const allCopy = (): string[] => {
  const out: string[] = [];
  for (const v of Object.values(REMEDIATION_COPY)) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'function') out.push((v as (...a: string[]) => string)('CVE-2024-1', '2026-11-20', '2027-11-19'), (v as (...a: unknown[]) => string)(null), (v as (...a: unknown[]) => string)(3));
  }
  return out;
};
// copied from tests/roleScreens.test.ts S7 (the wording guard)
const OLD_WRITE_WORDING = /Tenant Owner (or|\/|and) MSP Admin|owners? (or|\/|and) (an? )?MSP admin(istrator)?s?|only a tenant owner can resolve|TENANT_OWNER (\/|and|or) MSP_ADMIN|owner \/ MSP( only)?\b/i;

console.log('\n--- DR1 wording drift guard ---');
{
  const texts = [
    ...allCopy(), roleNote('TENANT_ADMIN') ?? '', roleNote('ASSESSOR') ?? '', roleNote('VIEWER') ?? '',
    policySaveError(apiErr(403)).text ?? '', policySaveError(apiErr(409, 'stale_write')).text ?? '',
  ];
  const hits = texts.filter((t) => OLD_WRITE_WORDING.test(t));
  assert(texts.length > 80 && hits.length === 0, 'DR1 no phase 1 string says "Tenant Owner or MSP Admin"', hits);
}

// ------------------------------------------------------------------------------------------------ phase 2
console.log('\n--- DB1 date bounds, DF1 decision form ---');
{
  assert(JSON.stringify(decisionDateBounds(NOW)) === JSON.stringify({ min: '2026-11-20', max: '2027-11-19' }), 'DB1 bounds', decisionDateBounds(NOW));
  const ok = { kind: 'RISK_ACCEPTED' as const, justification: 'Compensating control in place', expiresAt: '2027-03-01' };
  assert(Object.keys(decisionFormErrors(ok, NOW)).length === 0 && validateDecisionRequest(ok, NOW).ok === true, 'DF1 a valid form, cross-checked with the shared validator');
  assert(decisionFormErrors({ ...ok, kind: '' }, NOW).kind === 'Choose Risk accepted or False positive.', 'DF1 kind');
  assert(decisionFormErrors({ ...ok, justification: '   ' }, NOW).justification === 'Write a justification.', 'DF1 justification required');
  assert(decisionFormErrors({ ...ok, justification: '😀'.repeat(4001) }, NOW).justification === 'The justification is limited to 4000 characters.' && decisionFormErrors({ ...ok, justification: '😀'.repeat(4000) }, NOW).justification === undefined, 'DF1 4000 code points');
  assert(decisionFormErrors({ ...ok, expiresAt: '' }, NOW).expiresAt === 'Choose an expiry date.', 'DF1 date required');
  const range = 'Choose a date from 2026-11-20 to 2027-11-19.';
  assert(decisionFormErrors({ ...ok, expiresAt: '2026-11-19' }, NOW).expiresAt === range && decisionFormErrors({ ...ok, expiresAt: '2027-11-20' }, NOW).expiresAt === range && decisionFormErrors({ ...ok, expiresAt: '2027-02-30' }, NOW).expiresAt === range, 'DF1 date range');
  const u = decisionUnsavedText({ findingId: 'f1', vulnId: 'CVE-2024-1', assetName: null, severity: null, findingStatus: null, tier: null }, ok);
  assert(u.length === 1 && u[0].key === 'vmdecision:f1:justification' && u[0].label === 'Risk decision justification, CVE-2024-1' && !u[0].label.includes('Compensating'), 'DF1 unsaved-text entry labels the CVE only', u);
  assert(canRequestDecision('TENANT_ADMIN', { findingStatus: 'OPEN' }) && canRequestDecision('MSP_ADMIN', { findingStatus: null }) && !canRequestDecision('VIEWER', { findingStatus: 'OPEN' }) && !canRequestDecision('ASSESSOR', { findingStatus: 'OPEN' }) && !canRequestDecision('TENANT_OWNER', { findingStatus: 'RESOLVED' }), 'DF1 canRequestDecision');
}

console.log('\n--- DA1 action matrix ---');
{
  const none = { approve: null, reject: false, withdraw: false, revoke: false };
  const a = (state: VmDecision['state'], me: boolean, role: Parameters<typeof decisionActions>[1]) => JSON.stringify(decisionActions({ state, requestedByMe: me }, role));
  assert(a('PENDING', true, 'TENANT_OWNER') === JSON.stringify({ approve: 'self', reject: false, withdraw: true, revoke: false }), 'DA1 owner, own request');
  assert(a('PENDING', false, 'MSP_ADMIN') === JSON.stringify({ approve: 'ok', reject: true, withdraw: false, revoke: false }), 'DA1 MSP Admin, someone else');
  assert(a('PENDING', true, 'TENANT_ADMIN') === JSON.stringify({ approve: null, reject: false, withdraw: true, revoke: false }) && a('PENDING', false, 'TENANT_ADMIN') === JSON.stringify(none), 'DA1 admin');
  assert(a('PENDING', false, 'ASSESSOR') === JSON.stringify(none) && a('PENDING', false, 'VIEWER') === JSON.stringify(none) && a('PENDING', false, null) === JSON.stringify(none), 'DA1 read-only roles');
  assert(a('ACTIVE', false, 'TENANT_OWNER') === JSON.stringify({ approve: null, reject: false, withdraw: false, revoke: true }) && a('ACTIVE', false, 'TENANT_ADMIN') === JSON.stringify(none) && a('EXPIRED', false, 'TENANT_OWNER') === JSON.stringify(none), 'DA1 active and expired');
  assert(Object.keys(DECISION_STATE_LABEL).length === 7, 'DA1 every state has a label');
}

console.log('\n--- DE1-DE2 errors, DC1 confirmations, JV1 ---');
{
  assert(decisionActionError('approve', apiErr(403, 'self_approval_forbidden')).kind === 'self' && decisionActionError('approve', apiErr(403, 'self_approval_forbidden')).text === 'You requested this decision, so someone else must approve it.', 'DE1 self approval');
  assert(decisionActionError('approve', apiErr(403, 'owner_required')).text === 'This needs owner-level access (Tenant Owner, MSP Admin).' && decisionActionError('withdraw', apiErr(403, 'not_requester')).text === 'Only the person who requested it can withdraw a request.' && decisionActionError('reject', apiErr(403)).kind === 'forbidden', 'DE1 403 variants');
  const np = decisionActionError('approve', apiErr(409, 'decision_not_pending'));
  assert(np.kind === 'conflict' && np.reload === true && np.text === 'This request was already approved, rejected or withdrawn. The list has been reloaded.', 'DE1 not pending');
  const ex = decisionActionError('reject', apiErr(409, 'decision_expired'));
  assert(ex.kind === 'expired' && ex.reload === true && ex.text === 'This request reached its expiry date before it was approved. Request a new decision.', 'DE1 expired');
  const na = decisionActionError('revoke', apiErr(409, 'decision_not_active'));
  assert(na.kind === 'not_active' && na.reload === true && na.text === 'This decision is no longer in force, so there is nothing to revoke. The list has been reloaded.', 'DE1 not active');
  assert(decisionActionError('approve', apiErr(404, 'not_found')).reload === true && decisionActionError('approve', apiErr(0)).kind === 'network' && decisionActionError('approve', apiErr(401)).kind === 'session' && decisionActionError('approve', new Error('x')).kind === 'failed', 'DE1 404, network, session, other');

  assert(decisionRequestError(apiErr(409, 'decision_pending')).reload === true && decisionRequestError(apiErr(409, 'decision_pending')).text === 'A request for this finding is already waiting for approval.', 'DE2 pending');
  assert(decisionRequestError(apiErr(409, 'finding_not_open')).reload === true && decisionRequestError(apiErr(409, 'finding_not_open')).text === 'This finding is no longer open, so no decision is needed.', 'DE2 not open');
  assert(decisionRequestError(apiErr(400, 'invalid_decision')).text === 'The request was refused. Check the decision type, justification and expiry date.', 'DE2 400');
  assert(decisionRequestError(apiErr(403)).text === 'Only Tenant Owners, Admins and MSP Admins can request a decision.', 'DE2 403');
  assert(decisionRequestError(apiErr(404, 'not_found')).text === 'This finding no longer exists. It may have been removed with its asset.' && decisionRequestError(apiErr(0)).text === 'The server could not be reached. Nothing was sent.' && decisionRequestError(apiErr(500)).text === 'The request could not be sent. Try again.', 'DE2 404, network, other');

  const secret = 'Compensating control: air gapped';
  const dec = { kind: 'RISK_ACCEPTED' as const, expiresAt: '2027-03-01T00:00:00.000Z' };
  const ctx = { vulnId: 'CVE-2024-1', assetName: 'host-a' };
  assert(decisionConfirmText('approve', dec, ctx) === 'Approve the risk acceptance for CVE-2024-1 on host-a until 2027-03-01? From now on it does not count as a gap. Its POA&M item, if it has one, is not changed.', 'DC1 approve');
  assert(decisionConfirmText('reject', dec, ctx) === 'Reject the request for CVE-2024-1 on host-a? It stays in the history and cannot be approved later.' && decisionConfirmText('withdraw', dec, ctx) === 'Withdraw your request for CVE-2024-1 on host-a? It stays in the history.', 'DC1 reject and withdraw');
  assert(decisionConfirmText('revoke', dec, { vulnId: 'CVE-2024-1', assetName: null }).includes('an asset no longer recorded'), 'DC1 revoke without an asset');
  assert(decisionDoneText('approve', { kind: 'FALSE_POSITIVE', expiresAt: dec.expiresAt }, ctx) === 'Approved. CVE-2024-1 on host-a is marked as a false positive until 2027-03-01.' && decisionDoneText('revoke', dec, ctx) === 'Revoked. CVE-2024-1 on host-a counts as before.', 'DC1 done texts');
  assert(!(['approve', 'reject', 'withdraw', 'revoke'] as const).some((a) => decisionConfirmText(a, dec, ctx).includes(secret) || decisionDoneText(a, dec, ctx).includes(secret)), 'DC1 no output carries a justification');
  assert(JSON.stringify(justificationView({ justification: null, justificationLength: 42 })) === JSON.stringify({ kind: 'hidden', text: 'A justification is recorded (42 characters). Viewers cannot read it.' }) && justificationView({ justification: 'x', justificationLength: 1 }).kind === 'text', 'JV1 viewer sees only the length');
}

console.log('\n--- OC1 owner count, AN1 approver note, EX1, PT2 ---');
{
  const m = (role: TeamMember['role'], o: Partial<TeamMember> = {}): TeamMember => ({ id: Math.random().toString(), tenantId: 't', email: 'a@b.c', name: 'A', role, status: 'ACTIVE', ...o });
  const members = [m('TENANT_OWNER'), m('MSP_ADMIN'), m('TENANT_OWNER', { status: 'PENDING_INVITE' }), m('MSP_ADMIN', { accountDisabled: true }), m('TENANT_ADMIN')];
  assert(ownerLevelCount(members) === 2 && ownerLevelCount(undefined) === null && ownerLevelCount([]) === 0, 'OC1 counts active, enabled owner-level members');
  const single = 'Nobody approves their own request, and this organization lists only one owner-level member. Unless an MSP Admin works with this organization, add a second Tenant Owner under Team & Role Permissions so decisions can be approved.';
  assert(approverNote({ role: 'TENANT_OWNER', ownerLevelCount: 1 }) === single && approverNote({ role: 'TENANT_OWNER', ownerLevelCount: 2 }) === null, 'AN1 single owner');
  assert(approverNote({ role: 'TENANT_ADMIN', ownerLevelCount: 0 }) === 'This organization lists no owner-level member who could approve a request. Unless an MSP Admin works with this organization, ask for a Tenant Owner to be added.', 'AN1 admin, none');
  assert(approverNote({ role: 'VIEWER', ownerLevelCount: 0 }) === null && approverNote({ role: 'TENANT_OWNER', ownerLevelCount: null }) === null && approverNote({ role: 'TENANT_ADMIN', ownerLevelCount: 1 }) === null, 'AN1 viewer, unknown count, admin with an owner');
  const iso = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
  assert(expiryText(iso(12), NOW) === `Expires ${iso(12).slice(0, 10)} (in 12 days)` && expiryText(iso(1), NOW) === `Expires ${iso(1).slice(0, 10)} (in 1 day)` && expiryText(iso(-2), NOW) === `Expired ${iso(-2).slice(0, 10)}`, 'EX1 expiry text');
  assert(pendingText(0) === null && pendingText(1) === '1 decision request is waiting for approval.' && pendingText(3) === '3 decision requests are waiting for approval.', 'PT2 pending text');
}

console.log('\n--- DR2 wording drift guard, phase 2 ---');
{
  const a = approverNote({ role: 'TENANT_OWNER', ownerLevelCount: 1 }) ?? '';
  const b = approverNote({ role: 'TENANT_ADMIN', ownerLevelCount: 0 }) ?? '';
  const ctx = { vulnId: 'CVE-1', assetName: 'h' };
  const dec = { kind: 'RISK_ACCEPTED' as const, expiresAt: '2027-03-01T00:00:00Z' };
  const texts = [
    ...allCopy(), a, b,
    ...(['approve', 'reject', 'withdraw', 'revoke'] as const).flatMap((x) => [decisionConfirmText(x, dec, ctx), decisionDoneText(x, dec, ctx), decisionActionError(x, apiErr(403)).text ?? '', decisionActionError(x, apiErr(403, 'self_approval_forbidden')).text ?? '']),
    decisionRequestError(apiErr(403)).text ?? '',
  ];
  assert(texts.every((t) => !OLD_WRITE_WORDING.test(t)), 'DR2 no phase 2 string matches the old wording');
}

// ------------------------------------------------------------------------------------------------ renders
const noop = () => undefined;
const finding = (o: Partial<VmFinding> = {}): VmFinding => ({
  id: 'f1', tenantId: 't1', assetId: 'a1', vulnId: 'CVE-2024-0001', status: 'OPEN', severity: 'HIGH', firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z',
  resolvedAt: null, resolvedRunId: null, slaDueAt: null, packageName: 'openssl', packageVersion: '3.0.1', fixedVersion: null, affectedPackages: [], affectedPackageCount: 0,
  justification: null, decidedBy: null, decidedByUserId: null, decidedAt: null, ...o,
});
const listHtml = (findings: VmFinding[], extra: Partial<React.ComponentProps<typeof VmFindingsList>> = {}): string =>
  renderToStaticMarkup(React.createElement(VmFindingsList, { status: 'ready', findings, statusFilter: 'OPEN', onStatusFilterChange: noop, onRetry: noop, scannerReported: true, ...extra }));

console.log('\n--- R1 findings list ---');
{
  const three = [
    finding({ id: 'a', remediation: tier() }),
    finding({ id: 'b', vulnId: 'CVE-2024-0002', severity: 'MEDIUM', remediation: tier({ tier: 'WARNING', reason: 'warn_only_severity' }) }),
    finding({ id: 'c', vulnId: 'CVE-2024-0003' }),
  ];
  const html = listHtml(three);
  assert(html.split('>Remediation<').length - 1 === 2 && html.includes('18 days past due') && html.includes(REMEDIATION_COPY.legend.replace(/&/g, '&amp;').replace(/'/g, '&#x27;')) && html.includes('Not reported'), 'R1 label, column, overdue text, legend and the not-reported cell');
  const select = html.slice(html.indexOf('-tier"'), html.indexOf('</select>', html.indexOf('-tier"')));
  assert((select.match(/<option/g) ?? []).length === 5, 'R1 the tier select has five options', select);
  const plain = listHtml([finding({ id: 'z' })]);
  assert(!plain.includes('All tiers') && !plain.includes('Remediation follows'), 'R1 no tier select and no legend without any tier');
  assert(!html.includes('>Decisions<') && listHtml(three, { onOpenDecisions: noop }).includes('>Decisions<') && listHtml(three, { onOpenDecisions: noop }).includes('aria-label="Risk decisions for CVE-2024-0001"'), 'R1 the Decisions button only with the callback, labelled with the CVE');
}

console.log('\n--- R2 policy panel, R3 summary panel ---');
{
  const resp = (source: 'tenant' | 'defaults'): VmRemediationPolicyResponse => ({ policy: DEF, source, defaults: DEF, updatedAt: source === 'tenant' ? '2026-11-18T10:00:00Z' : null, updatedBy: source === 'tenant' ? 'Ann' : null, kevRule: 'A known exploited vulnerability (CISA KEV) is due within the Critical deadline.', limits: { daysMin: 1, daysMax: 3650, graceMax: 30 } });
  const panel = (load: React.ComponentProps<typeof VmRemediationPolicyPanel>['load'], canEdit = false): string =>
    renderToStaticMarkup(React.createElement(VmRemediationPolicyPanel, { load, canEdit, onRetry: noop, onSave: () => Promise.reject(new Error('no')), onReload: () => Promise.resolve(null), loadEvents: () => Promise.resolve([]) }));
  assert(panel({ status: 'loading' }).includes('role="status"') && panel({ status: 'loading' }).includes(REMEDIATION_COPY.policyLoading), 'R2 loading');
  const off = panel({ status: 'error', offline: true });
  assert(off.includes('role="alert"') && off.includes('The server could not be reached, so the remediation policy could not be loaded.') && off.includes('Retry loading the remediation policy'), 'R2 offline error with a Retry');
  const ro = panel({ status: 'ready', data: resp('defaults') });
  assert(ro.includes('Using server defaults') && ro.includes(REMEDIATION_COPY.readOnlyPolicy) && !ro.includes('Edit policy'), 'R2 read-only on defaults');
  assert(panel({ status: 'ready', data: resp('tenant') }, true).includes('Edit policy') && panel({ status: 'ready', data: resp('tenant') }, true).includes('Saved for this organization'), 'R2 owner-level can edit');
  assert((ro.match(/CISA KEV/g) ?? []).length === 1, 'R2 the known-exploited rule appears once');

  const sumHtml = (load: React.ComponentProps<typeof VmRemediationSummaryPanel>['load']): string => renderToStaticMarkup(React.createElement(VmRemediationSummaryPanel, { load, onRetry: noop }));
  const data: VmRemediationSummary = { generatedAt: '', policy: DEF, counts: { gap: 2, warning: 3, onTrack: 4, accepted: 1 }, warningBySeverity: { MEDIUM: 3 }, gapCritical: 2, gapHigh: 0, gapKev: 0, pendingDecisions: 2 };
  const h = sumHtml({ status: 'ready', data });
  const at = (s: string) => h.indexOf(`>${s}<`);
  assert(at('Gaps') > 0 && at('Gaps') < at('Warnings') && at('Warnings') < at('On track') && at('On track') < at('Accepted'), 'R3 four tiles in order');
  assert(h.includes('2 decision requests are waiting for approval.') && !h.includes('known exploited'), 'R3 pending count and no known-exploited tile');
  assert(sumHtml({ status: 'ready', data: { ...data, counts: { gap: 0, warning: 0, onTrack: 0, accepted: 0 } } }).includes(REMEDIATION_COPY.summaryEmpty), 'R3 all zero');
}

console.log('\n--- R4 POA&M row note ---');
{
  const poamRow = (): VmPoamRow => ({
    id: 'p1', status: 'OPEN', controlId: 'RA.L2-3.11.3', weakness: 'w', scheduledCompletion: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', findingFirstSeenAt: '2026-01-01T00:00:00Z',
    createdBy: 'system:vm-worker', owner: '', mitigation: '', updatedBy: null, statusChangedBy: null, statusChangedAt: null, autoComplete: true, milestones: [], itemNumber: 1,
    finding: { id: 'f', vulnId: 'CVE-2024-9', severity: 'MEDIUM', status: 'OPEN', kev: false, firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-02T00:00:00Z', slaDueAt: '2026-02-01T00:00:00Z', resolvedAt: null,
      affectedPackages: [], affectedPackageCount: 0, asset: { id: 'a-1', name: 'host-1' }, remediation: tier({ tier: 'WARNING', reason: 'warn_only_severity' }) },
  });
  const response: VmPoamResponse = {
    tenantId: 't', programId: 'p', generatedAt: '2026-01-10T00:00:00Z',
    rules: { controlId: 'RA.L2-3.11.3', autocreateEnabled: true, vmTargetProgramId: 'p', isVmTarget: true, slaDays: DEF.slaDays, policy: DEF },
    items: [poamRow()], itemsTotal: 1, openItemsTotal: 1, overdueWithoutItemCount: 0, upcoming: [], upcomingTotal: 0,
  } as unknown as VmPoamResponse;
  const html = renderToStaticMarkup(React.createElement(PoamVulnerabilitiesSection, { load: { status: 'ready', data: response } as never, onRetry: noop, framework: 'CMMC_L2', targetProgramName: null }));
  assert(html.includes('Not required by the current policy (Medium is warning only)'), 'R4 the row carries the policy note');
}

console.log('\n--- R5 decision card ---');
{
  const dec = (o: Partial<VmDecision> = {}): VmDecision => ({
    id: 'd1', kind: 'RISK_ACCEPTED', state: 'PENDING', justification: 'Compensating control in place', justificationLength: 29, justificationSha256: 'x', requestedBy: 'Ann', requestedAt: '2026-11-18T10:00:00Z',
    requestedByMe: false, expiresAt: '2027-03-01T00:00:00.000Z', approvedBy: null, approvedAt: null, events: [], ...o,
  });
  const card = (d: VmDecision, role: Parameters<typeof decisionActions>[1]): string =>
    renderToStaticMarkup(React.createElement(VmDecisionCard, { decision: d, ctx: { vulnId: 'CVE-2024-1', assetName: 'host-a' }, showFinding: true, role, nowMs: NOW, onAct: () => Promise.resolve(), onDone: noop, onReloadNeeded: noop }));
  const viewer = card(dec({ justification: null, justificationLength: 29 }), 'VIEWER');
  assert(!/<button[^>]*>(Approve|Reject request|Withdraw request)/.test(viewer) && viewer.includes('A justification is recorded (29 characters). Viewers cannot read it.') && !viewer.includes('Compensating'), 'R5 a Viewer sees no buttons and no text', viewer);
  const own = card(dec({ requestedByMe: true }), 'TENANT_OWNER');
  assert(/<button[^>]*disabled=""[^>]*>Approve</.test(own) && own.includes(REMEDIATION_COPY.selfApprove) && own.includes('Withdraw request') && !own.includes('Reject request'), 'R5 own request: Approve disabled with the reason, Withdraw offered');
  const msp = card(dec(), 'MSP_ADMIN');
  assert(/>Approve</.test(msp) && msp.includes('Reject request') && !/disabled=""[^>]*>Approve/.test(msp), 'R5 MSP Admin approves and rejects someone else\'s request');
  assert(card(dec(), 'ASSESSOR').includes('Show justification') && !card(dec(), 'ASSESSOR').includes('Compensating'), 'R5 an Assessor can open the text (collapsed by default)');
  assert(!viewer.includes('aria-label="CVE') && !msp.includes('Compensating'), 'R5 the CVE and the text are never in an aria-label');
  const xss = renderToStaticMarkup(React.createElement(GeneratedParagraphText, { text: 'Notes <b>x</b>' }));
  assert(xss.includes('&lt;b&gt;') && !xss.includes('<b>'), 'R5 markup in text is escaped');
}

// ------------------------------------------------------------------------------------------------ phase 3
console.log('\n--- SP1-SP4 SSP paragraph ---');
{
  const para = remediationPolicySspParagraph('RA.L2-3.11.3', DEF, '2026-11-19') as string;
  const s1 = splitPolicyParagraph(`Notes\n\n${para}`);
  assert(s1.recorded === 'Notes' && s1.generated === para, 'SP1 split');
  assert(splitPolicyParagraph('Notes only').generated === null && splitPolicyParagraph('Notes only').recorded === 'Notes only', 'SP1 no label');
  const s3 = splitPolicyParagraph(`No implementation narrative documented.\n\n${para}`);
  assert(s3.recorded === 'No implementation narrative documented.' && s3.generated?.startsWith(VM_POLICY_SSP_LABEL_PREFIX) === true, 'SP1 the default sentence stays recorded');
  assert(splitPolicyParagraph(para).recorded === '' && splitPolicyParagraph(para).generated === para, 'SP1 a narrative that is only the paragraph');

  const l2 = `${cmmcDisplayId('RA.L2-3.11.3', 'CMMC_L2')} and ${cmmcDisplayId('SI.L1-3.14.1', 'CMMC_L2')} end with a paragraph generated from the vulnerability remediation policy (as of 2026-11-19). It is labelled in every export and is not saved to the controls.`;
  assert(sspPolicyNote('CMMC_L2', 'ready', '2026-11-19') === l2, 'SP2 L2 ready', sspPolicyNote('CMMC_L2', 'ready', '2026-11-19'));
  const l1 = sspPolicyNote('CMMC_L1', 'ready', '2026-11-19');
  assert(l1 === `${cmmcDisplayId('SI.L1-3.14.1', 'CMMC_L1')} ends with a paragraph generated from the vulnerability remediation policy (as of 2026-11-19). It is labelled in every export and is not saved to the controls.`, 'SP2 L1 ready', l1);
  assert(sspPolicyNote('CMMC_L2', 'error', null) === 'The vulnerability remediation policy could not be loaded, so its generated paragraph is missing from this document. Reopen the export to try again.' && sspPolicyNote('CMMC_L2', 'loading', null) === 'Loading the vulnerability remediation policy for its generated SSP paragraph…', 'SP2 error and loading');
  assert(sspPolicyNote('NIST_800_53_REV5', 'ready', '2026-11-19') === null && sspPolicyNote('CMMC_L2', 'unsupported', null) === null, 'SP2 other frameworks and browser-only give null');

  const base = { source: 'tenant' as const, updatedAt: '2026-11-18T10:00:00Z' };
  assert(policyAsOf(base, NOW) === '2026-11-18' && policyAsOf({ source: 'defaults', updatedAt: null }, NOW) === '2026-11-19', 'SP3 as-of date');

  const withPara = renderToStaticMarkup(React.createElement(GeneratedParagraphText, { text: `Notes <b>x</b>\n\n${para}` }));
  assert(withPara.includes('border-dashed') && withPara.includes('Notes &lt;b&gt;x&lt;/b&gt;') && !withPara.includes('<b>'), 'SP4 the generated paragraph is styled apart and the recorded text is escaped');
  assert(!renderToStaticMarkup(React.createElement(GeneratedParagraphText, { text: 'Plain narrative' })).includes('border-dashed'), 'SP4 no label, no styling');

  const variants: VmRemediationPolicy[] = [DEF, { ...DEF, warnOnly: [] }, { ...DEF, warnOnly: ['LOW'] }, { ...DEF, graceDays: 7 }];
  assert(variants.every((p) => !OLD_WRITE_WORDING.test(remediationPolicySspParagraph('SI.L1-3.14.1', p, '2026-11-19') as string)), 'DR3 the paragraph never says "Tenant Owner or MSP Admin"');
}

// ------------------------------------------------------------------------------------------------ source pins
console.log('\n--- SC1-SC2 wiring ---');
{
  const modal = read('src/components/telemetry/VmRemediationModal.tsx');
  const dropdown = read('src/components/auth/UserProfileDropdown.tsx');
  const dialog = read('src/components/telemetry/VmFindingDecisionDialog.tsx');
  const scanner = read('src/components/telemetry/AssetScannerDataDialog.tsx');
  const list = read('src/components/telemetry/VmFindingsList.tsx');
  const client = read('src/services/apiClient.ts');
  const exportModal = read('src/components/reports/ArtifactExportModal.tsx');
  const fresh = [
    'src/data/telemetry/vmRemediationView.ts', 'src/hooks/useVmRemediationPolicy.ts', 'src/hooks/useVmDecisions.ts', 'src/components/telemetry/VmRemediationModal.tsx',
    'src/components/telemetry/VmRemediationPolicyPanel.tsx', 'src/components/telemetry/VmRemediationSummaryPanel.tsx', 'src/components/telemetry/VmDecisionCard.tsx',
    'src/components/telemetry/VmDecisionsSection.tsx', 'src/components/telemetry/VmFindingDecisionDialog.tsx', 'src/components/reports/GeneratedParagraphText.tsx',
  ];
  assert(
    modal.includes('<DialogOverlay') && modal.includes('max-h-[90vh]') && modal.includes('<DialogTitle as="h2"') && modal.includes('onClose={busy ? undefined : confirmClose ? keepEditing : requestClose}'),
    'SC1 the window is a DialogOverlay with a title, a scroll cap and the guarded close',
  );
  assert(dropdown.includes('Vulnerability Remediation') && dropdown.includes('currentTenant.serverBacked && (') && dropdown.includes('<VmRemediationModal key={currentTenant.id}'), 'SC1 the profile menu item is for server-backed organizations only');
  const bad = fresh.filter((f) => /console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|https?:/.test(read(f)));
  assert(bad.length === 0, 'SC1 no console, storage, raw HTML or URL in the new files', bad);
  const programIds = /(getVmRemediationPolicy|saveVmRemediationPolicy|getVmRemediationPolicyEvents|getVmRemediationSummary|requestVmFindingDecision|listVmFindingDecisions|listVmDecisions|approveVmDecision|rejectVmDecision|withdrawVmDecision|revokeVmDecision)\([^)]*programId/;
  assert(!programIds.test(client), 'SC1 the remediation client methods are tenant-wide (no programId)');
  assert(dialog.includes('z-[60]') && dialog.includes('max-h-[90vh]') && dialog.includes('<DialogTitle') && dialog.includes('useUnsavedTextProvider(') && dialog.includes('onClose={sending ? undefined : requestClose}'), 'SC2 the decision dialog nests above the window, keeps the scroll cap, rescues unsent text and blocks close while sending');
  assert(scanner.includes('<VmFindingDecisionDialog') && scanner.includes('max-w-4xl rounded-2xl') && !list.includes('ApiClient'), 'SC2 the scanner dialog opens it, and the list still has no ApiClient');
  assert(
    exportModal.includes('useVmRemediationPolicy(') && exportModal.includes('vmRemediationPolicy') && exportModal.includes('<GeneratedParagraphText') && exportModal.includes('data-testid="vm-policy-paragraph-note"') &&
      exportModal.split('downloadEmassCsv(frameworkControls, state.controls, formData, state.objectives)').length - 1 === 2,
    'SP5 the export modal carries the policy, notes it, styles the paragraph and keeps both pinned eMASS calls',
  );
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
