import { VM_DECISION_JUSTIFICATION_MAX, VM_POLICY_SSP_LABEL_PREFIX } from '../vmRemediation';
import type { VmDecisionState, VmRemediationPolicy, VmRemediationTier, VmTierReason, VmTierResult, VmWarnOnlySeverity } from '../vmRemediation';
import type { VmFindingStatus, VmPoamRow, VmSeverity } from '../../types/vm';
import type { VmDecision, VmPolicyEvent, VmPolicySaveResult, VmRemediationPolicyResponse, VmRemediationSummary } from '../../types/vmRemediation';
import type { TeamMember, TenantRole } from '../../types/tenant';
import type { UnsavedTextEntry } from '../../services/unsavedText';
import { ROLE_LABELS, canRoleWrite, isOwnerLevel } from '../../utils/roles';
import { cmmcDisplayId } from '../cmmcGuide/displayId';

/**
 * The wording and the rules of the vulnerability remediation screens (#268): tiers, the policy form, risk decisions and the generated SSP
 * paragraph note. Pure: no network, no storage, no console, and it imports neither vmFindingsView nor vmPoamView (they import it).
 * Justification text never appears in anything this module returns except `justificationView`, and only for roles that may read it.
 */

export { VM_DECISION_JUSTIFICATION_MAX };

const DAY_MS = 86_400_000;

const dateOf = (iso: string): string => iso.slice(0, 10);
const fmtStamp = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const d = (n: number): string => (n === 1 ? '1 day' : `${n} days`);
const grace = (n: number): string => (n === 0 ? 'None' : d(n));

// ------------------------------------------------------------------------------------------------ tiers

export const TIER_LABEL: Record<VmRemediationTier, string> = { CLOSED: 'Closed', ON_TRACK: 'On track', WARNING: 'Warning', GAP: 'Gap', ACCEPTED: 'Accepted' };

export const TIER_BADGE: Record<VmRemediationTier, string> = {
  CLOSED: 'bg-slate-800 text-slate-300 border-slate-700',
  ON_TRACK: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  WARNING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  GAP: 'bg-rose-500/20 text-rose-200 border-rose-500/50',
  ACCEPTED: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
};

export type TierFilter = 'ALL' | 'GAP' | 'WARNING' | 'ON_TRACK' | 'ACCEPTED';
export const TIER_FILTERS: TierFilter[] = ['ALL', 'GAP', 'WARNING', 'ON_TRACK', 'ACCEPTED'];
export const TIER_FILTER_LABEL: Record<TierFilter, string> = { ALL: 'All tiers', GAP: 'Gap', WARNING: 'Warning', ON_TRACK: 'On track', ACCEPTED: 'Accepted' };

const TIERS: readonly string[] = ['CLOSED', 'ON_TRACK', 'WARNING', 'GAP', 'ACCEPTED'];
const REASONS: readonly string[] = [
  'resolved', 'within_due', 'no_due_date', 'warn_only_severity', 'grace_period', 'overdue', 'kev_overdue', 'risk_accepted', 'false_positive', 'legacy_decision',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A tier result read defensively from the API: null unless the tier and the reason are known ones. */
export function parseTierResult(raw: unknown): VmTierResult | null {
  if (!isObj(raw) || typeof raw.tier !== 'string' || !TIERS.includes(raw.tier) || typeof raw.reason !== 'string' || !REASONS.includes(raw.reason)) return null;
  const dec = raw.decision;
  const decision =
    isObj(dec) && typeof dec.id === 'string' && typeof dec.kind === 'string' && typeof dec.expiresAt === 'string'
      ? { id: dec.id, kind: dec.kind, expiresAt: dec.expiresAt }
      : null;
  return {
    tier: raw.tier as VmRemediationTier,
    reason: raw.reason as VmTierReason,
    dueAt: strOrNull(raw.dueAt),
    overdueDays: typeof raw.overdueDays === 'number' && Number.isFinite(raw.overdueDays) ? raw.overdueDays : null,
    graceEndsAt: strOrNull(raw.graceEndsAt),
    decision,
  };
}

export function overdueText(days: number): string {
  if (days <= 0) return 'less than a day past due';
  return days === 1 ? '1 day past due' : `${days} days past due`;
}

export function tierLines(r: VmTierResult): { due: string | null; reason: string | null } {
  let due: string | null;
  if (r.tier === 'CLOSED') due = null;
  else if (r.dueAt === null) due = 'No deadline recorded';
  else if (r.overdueDays === null || r.tier === 'ON_TRACK') due = `Due ${dateOf(r.dueAt)}`;
  else due = `Due ${dateOf(r.dueAt)} · ${overdueText(r.overdueDays)}`;

  let reason: string | null = null;
  const until = r.decision ? ` until ${dateOf(r.decision.expiresAt)}` : '';
  if (r.reason === 'warn_only_severity') reason = 'Warning-only severity under the policy';
  else if (r.reason === 'grace_period') reason = r.graceEndsAt ? `In grace period until ${dateOf(r.graceEndsAt)}` : 'In grace period';
  else if (r.reason === 'kev_overdue') reason = 'Known exploited';
  else if (r.reason === 'risk_accepted') reason = `Risk accepted${until}`;
  else if (r.reason === 'false_positive') reason = `False positive${until}`;
  else if (r.reason === 'legacy_decision') reason = 'Decision recorded on the finding';
  return { due, reason };
}

export function filterByTier<T extends { remediation?: VmTierResult | null }>(list: readonly T[], f: TierFilter): T[] {
  if (f === 'ALL') return [...list];
  return list.filter((r) => r.remediation?.tier === f);
}

export function tierCounts(list: readonly { remediation?: VmTierResult | null }[]): { GAP: number; WARNING: number; ON_TRACK: number; ACCEPTED: number } {
  const c = { GAP: 0, WARNING: 0, ON_TRACK: 0, ACCEPTED: 0 };
  for (const r of list) {
    const t = r.remediation?.tier;
    if (t === 'GAP' || t === 'WARNING' || t === 'ON_TRACK' || t === 'ACCEPTED') c[t]++;
  }
  return c;
}

export function tierCountsText(c: ReturnType<typeof tierCounts>): string {
  const parts = ([['GAP', 'Gap'], ['WARNING', 'Warning'], ['ON_TRACK', 'On track'], ['ACCEPTED', 'Accepted']] as const)
    .filter(([k]) => c[k] > 0)
    .map(([k, label]) => `${label} ${c[k]}`);
  return parts.length === 0 ? '' : `Remediation: ${parts.join(' · ')}`;
}

/** The note under a draft the policy no longer requires (it stays; nothing is removed). Null for any other row. */
export function vmPoamPolicyNote(row: Pick<VmPoamRow, 'status' | 'finding'>): string | null {
  if (row.status !== 'OPEN' && row.status !== 'IN_PROGRESS') return null;
  const r = row.finding?.remediation;
  if (!r) return null;
  const prefix = 'Not required by the current policy';
  if (r.tier === 'WARNING' && r.reason === 'warn_only_severity') {
    const sev = row.finding?.severity;
    const label = sev === undefined || sev === 'UNKNOWN' ? 'Unknown severity' : SEVERITY_WORD[sev];
    return `${prefix} (${label} is warning only)`;
  }
  if (r.tier === 'WARNING' && r.reason === 'grace_period') {
    return r.graceEndsAt ? `${prefix} (in the grace period until ${dateOf(r.graceEndsAt)})` : null;
  }
  if (r.tier === 'ACCEPTED') {
    const until = r.decision ? ` until ${dateOf(r.decision.expiresAt)}` : '';
    if (r.reason === 'risk_accepted') return `${prefix} (risk accepted${until})`;
    if (r.reason === 'false_positive') return `${prefix} (false positive${until})`;
    if (r.reason === 'legacy_decision') return `${prefix} (decision recorded on the finding)`;
  }
  return null;
}

const SEVERITY_WORD: Record<Exclude<VmSeverity, 'UNKNOWN'>, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

// ------------------------------------------------------------------------------------------------ policy form

export const VM_POLICY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const POLICY_SEVERITY_LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' } as const;

export type VmPolicyField = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'graceDays';

export interface VmPolicyForm {
  CRITICAL: string;
  HIGH: string;
  MEDIUM: string;
  LOW: string;
  warnMedium: boolean;
  warnLow: boolean;
  graceDays: string;
}

export function policyFormFrom(p: VmRemediationPolicy): VmPolicyForm {
  return {
    CRITICAL: String(p.slaDays.CRITICAL),
    HIGH: String(p.slaDays.HIGH),
    MEDIUM: String(p.slaDays.MEDIUM),
    LOW: String(p.slaDays.LOW),
    warnMedium: p.warnOnly.includes('MEDIUM'),
    warnLow: p.warnOnly.includes('LOW'),
    graceDays: String(p.graceDays),
  };
}

/** Medium warn-only forces Low on; Low cannot be turned off while Medium is on (the same object comes back). */
export function policyFormSetWarn(form: VmPolicyForm, sev: 'MEDIUM' | 'LOW', on: boolean): VmPolicyForm {
  if (sev === 'MEDIUM') return { ...form, warnMedium: on, warnLow: on ? true : form.warnLow };
  if (!on && form.warnMedium) return form;
  return { ...form, warnLow: on };
}

export function policyFormErrors(form: VmPolicyForm): Partial<Record<VmPolicyField, string>> {
  const errors: Partial<Record<VmPolicyField, string>> = {};
  let prev: { label: string; n: number } | null = null;
  for (const s of VM_POLICY_SEVERITIES) {
    const raw = form[s].trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      errors[s] = 'Enter whole days from 1 to 3650.';
      continue;
    }
    if (prev && n < prev.n) errors[s] = `Must be at least the ${prev.label} deadline (${prev.n} days).`;
    else prev = { label: POLICY_SEVERITY_LABEL[s], n };
  }
  const g = form.graceDays.trim();
  const gn = /^\d+$/.test(g) ? Number(g) : NaN;
  if (!Number.isInteger(gn) || gn < 0 || gn > 30) errors.graceDays = 'Enter whole days from 0 to 30.';
  return errors;
}

export function policyFromForm(form: VmPolicyForm): VmRemediationPolicy | null {
  if (Object.keys(policyFormErrors(form)).length > 0) return null;
  const warnOnly: VmWarnOnlySeverity[] = [];
  if (form.warnMedium) warnOnly.push('MEDIUM');
  if (form.warnLow || form.warnMedium) warnOnly.push('LOW');
  return {
    slaDays: { CRITICAL: Number(form.CRITICAL.trim()), HIGH: Number(form.HIGH.trim()), MEDIUM: Number(form.MEDIUM.trim()), LOW: Number(form.LOW.trim()) },
    warnOnly,
    graceDays: Number(form.graceDays.trim()),
  };
}

export function policyFormDirty(base: VmRemediationPolicy, form: VmPolicyForm): boolean {
  const b = policyFormFrom(base);
  return (
    VM_POLICY_SEVERITIES.some((s) => b[s] !== form[s].trim()) || b.warnMedium !== form.warnMedium || b.warnLow !== form.warnLow || b.graceDays !== form.graceDays.trim()
  );
}

export function warnOnlyText(w: readonly VmWarnOnlySeverity[]): string {
  const m = w.includes('MEDIUM');
  const l = w.includes('LOW');
  if (m && l) return 'Medium and Low';
  if (m) return 'Medium';
  if (l) return 'Low';
  return 'None';
}

export function policyChanges(a: VmRemediationPolicy, b: VmRemediationPolicy): string[] {
  const out: string[] = [];
  for (const s of VM_POLICY_SEVERITIES) {
    if (a.slaDays[s] !== b.slaDays[s]) out.push(`${POLICY_SEVERITY_LABEL[s]} deadline from ${d(a.slaDays[s])} to ${d(b.slaDays[s])}`);
  }
  if (warnOnlyText(a.warnOnly) !== warnOnlyText(b.warnOnly)) out.push(`Warning only from ${warnOnlyText(a.warnOnly)} to ${warnOnlyText(b.warnOnly)}`);
  if (a.graceDays !== b.graceDays) out.push(`Grace period from ${grace(a.graceDays)} to ${grace(b.graceDays)}`);
  return out;
}

export function policySummaryRows(p: VmRemediationPolicy): Array<{ label: string; value: string }> {
  return [
    ...VM_POLICY_SEVERITIES.map((s) => ({ label: POLICY_SEVERITY_LABEL[s], value: d(p.slaDays[s]) })),
    { label: 'Warning only', value: warnOnlyText(p.warnOnly) },
    { label: 'Grace period', value: grace(p.graceDays) },
  ];
}

export function policySourceText(r: Pick<VmRemediationPolicyResponse, 'source' | 'updatedAt' | 'updatedBy'>): string {
  if (r.source === 'defaults' || !r.updatedAt) return 'No policy has been saved for this organization, so the server defaults apply.';
  return `Last changed ${dateOf(r.updatedAt)} by ${r.updatedBy ?? 'an unknown user'}.`;
}

export type PolicySaveErrorKind = 'session' | 'stale' | 'invalid' | 'forbidden' | 'network' | 'failed';

/** Fixed copy for a failed policy save: never the server's message. Same ApiError check as vmPoamSaveError. */
export function policySaveError(err: unknown): { kind: PolicySaveErrorKind; text: string | null } {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  const failed = { kind: 'failed' as const, text: 'The policy could not be saved. Try again.' };
  if (!e || e.name !== 'ApiError') return failed;
  if (e.status === 401) return { kind: 'session', text: null };
  if (e.status === 409 && e.reason === 'stale_write') return { kind: 'stale', text: 'Someone else changed the policy while you were editing, so nothing was saved.' };
  if (e.status === 400) return { kind: 'invalid', text: 'The server refused these values. Check each field and try again.' };
  if (e.status === 403) return { kind: 'forbidden', text: 'Only owner-level roles (Tenant Owner, MSP Admin) can change this policy. Nothing was saved.' };
  if (e.status === 0) return { kind: 'network', text: 'The server could not be reached. Nothing was saved.' };
  return failed;
}

export function policySavedText(r: Pick<VmPolicySaveResult, 'changed' | 'impact'>): string {
  if (!r.changed) return 'Nothing to save: the policy already has these values.';
  const n = r.impact.openRecomputed;
  const g = r.impact.gap;
  const w = r.impact.warning;
  return `Policy saved. ${n} open ${n === 1 ? 'finding' : 'findings'} got a new deadline. Open vulnerabilities now: ${g} ${g === 1 ? 'gap' : 'gaps'}, ${w} ${w === 1 ? 'warning' : 'warnings'}.`;
}

export function policyEventView(ev: VmPolicyEvent): { what: string; who: string; when: string; impact: string } {
  const p = ev.newPolicy;
  let what: string;
  if (ev.oldPolicy === null) {
    what = `Saved the first policy: Critical ${p.slaDays.CRITICAL}, High ${p.slaDays.HIGH}, Medium ${p.slaDays.MEDIUM}, Low ${p.slaDays.LOW} days; warning only: ${warnOnlyText(p.warnOnly)}; grace period: ${grace(p.graceDays)}.`;
  } else {
    what = policyChanges(ev.oldPolicy, p).join('; ') || 'No value changed.';
  }
  const roleLabel = ev.actorRole && (ROLE_LABELS as Record<string, string>)[ev.actorRole] ? ` (${(ROLE_LABELS as Record<string, string>)[ev.actorRole]})` : '';
  const n = ev.openFindingsRecomputed;
  return { what, who: `${ev.actor}${roleLabel}`, when: fmtStamp(ev.createdAt), impact: `${n} open ${n === 1 ? 'finding' : 'findings'} got a new deadline.` };
}

export function summaryBreakdown(s: VmRemediationSummary): { gaps: string | null; warnings: string | null } {
  let gaps: string | null = null;
  if (s.counts.gap > 0) {
    const parts: string[] = [];
    if (s.gapCritical > 0) parts.push(`Critical ${s.gapCritical}`);
    if (s.gapHigh > 0) parts.push(`High ${s.gapHigh}`);
    const rest = s.counts.gap - s.gapCritical - s.gapHigh;
    if (rest > 0) parts.push(`Medium or lower ${rest}`);
    gaps = `Of the gaps: ${parts.join(', ')}${s.gapKev > 0 ? `, known exploited ${s.gapKev}` : ''}.`;
  }
  let warnings: string | null = null;
  if (s.counts.warning > 0) {
    const parts = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
      .filter((k) => (s.warningBySeverity[k] ?? 0) > 0)
      .map((k) => `${POLICY_SEVERITY_LABEL[k]} ${s.warningBySeverity[k]}`);
    warnings = `Of the warnings: ${parts.join(', ')}.`;
  }
  return { gaps, warnings };
}

export function loadErrorText(what: 'policy' | 'summary' | 'history' | 'decisions', offline: boolean): string {
  const noun = what === 'policy' ? 'remediation policy' : what === 'summary' ? 'remediation summary' : what === 'decisions' ? 'decisions' : 'policy history';
  return `${offline ? 'The server could not be reached, so the ' : 'The '}${noun} could not be loaded.`;
}

export function roleNote(role: TenantRole | null): string | null {
  if (role === 'ASSESSOR') return 'Read-only: you can review the policy and the decisions, including their justifications, but not change them.';
  if (role === 'VIEWER') return 'Read-only: you can see the policy and which decisions exist. Justifications are not shown to Viewers.';
  if (role === 'TENANT_ADMIN') return 'You can request decisions. Changing the policy and approving decisions needs owner-level access (Tenant Owner, MSP Admin).';
  return null;
}

// ------------------------------------------------------------------------------------------------ risk decisions

export const DECISION_KIND_LABEL = { RISK_ACCEPTED: 'Risk accepted', FALSE_POSITIVE: 'False positive' } as const;
const KIND_PHRASE = { RISK_ACCEPTED: 'risk acceptance', FALSE_POSITIVE: 'false-positive decision' } as const;
const NO_ASSET = 'an asset no longer recorded';

export const DECISION_STATE_LABEL: Record<VmDecisionState, string> = {
  PENDING: 'Waiting for approval',
  ACTIVE: 'In force',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  REVOKED: 'Revoked',
  PACKAGE_CHANGED: 'Lapsed: packages changed',
};

export const DECISION_STATE_BADGE: Record<VmDecisionState, string> = {
  PENDING: TIER_BADGE.WARNING,
  ACTIVE: TIER_BADGE.ACCEPTED,
  REVOKED: TIER_BADGE.GAP,
  EXPIRED: TIER_BADGE.CLOSED,
  REJECTED: TIER_BADGE.CLOSED,
  WITHDRAWN: TIER_BADGE.CLOSED,
  PACKAGE_CHANGED: TIER_BADGE.CLOSED,
};

export interface VmDecisionTarget {
  findingId: string;
  vulnId: string;
  assetName: string | null;
  severity: VmSeverity | null;
  findingStatus: VmFindingStatus | null;
  tier: VmTierResult | null;
}

export interface VmDecisionForm {
  kind: '' | 'RISK_ACCEPTED' | 'FALSE_POSITIVE';
  justification: string;
  expiresAt: string;
}

export function justificationLength(s: string): number {
  return [...s].length;
}

/** The earliest and latest expiry the server accepts: tomorrow and today + 365 days, in UTC. */
export function decisionDateBounds(nowMs: number): { min: string; max: string } {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { min: new Date(today + DAY_MS).toISOString().slice(0, 10), max: new Date(today + 365 * DAY_MS).toISOString().slice(0, 10) };
}

export function decisionFormErrors(f: VmDecisionForm, nowMs: number): Partial<Record<'kind' | 'justification' | 'expiresAt', string>> {
  const errors: Partial<Record<'kind' | 'justification' | 'expiresAt', string>> = {};
  if (f.kind === '') errors.kind = 'Choose Risk accepted or False positive.';
  if (f.justification.trim() === '') errors.justification = 'Write a justification.';
  else if (justificationLength(f.justification.trim()) > VM_DECISION_JUSTIFICATION_MAX) errors.justification = `The justification is limited to ${VM_DECISION_JUSTIFICATION_MAX} characters.`;
  if (f.expiresAt === '') errors.expiresAt = 'Choose an expiry date.';
  else {
    const { min, max } = decisionDateBounds(nowMs);
    const t = /^\d{4}-\d{2}-\d{2}$/.test(f.expiresAt) ? Date.parse(`${f.expiresAt}T00:00:00.000Z`) : NaN;
    const real = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === f.expiresAt;
    if (!real || f.expiresAt < min || f.expiresAt > max) errors.expiresAt = `Choose a date from ${min} to ${max}.`;
  }
  return errors;
}

export function decisionFormDirty(f: VmDecisionForm): boolean {
  return f.kind !== '' || f.justification !== '' || f.expiresAt !== '';
}

/** The justification typed and not sent yet, for the session rescue. The label carries the CVE only. */
export function decisionUnsavedText(t: VmDecisionTarget, f: VmDecisionForm): UnsavedTextEntry[] {
  if (f.justification === '') return [];
  return [{ key: `vmdecision:${t.findingId}:justification`, label: `Risk decision justification, ${t.vulnId}`, text: f.justification }];
}

export function canRequestDecision(role: TenantRole | null, t: Pick<VmDecisionTarget, 'findingStatus'>): boolean {
  return canRoleWrite(role) && (t.findingStatus === null || t.findingStatus === 'OPEN');
}

export type VmDecisionAction = 'approve' | 'reject' | 'withdraw' | 'revoke';

export function decisionActions(
  dec: Pick<VmDecision, 'state' | 'requestedByMe'>,
  role: TenantRole | null,
): { approve: 'ok' | 'self' | null; reject: boolean; withdraw: boolean; revoke: boolean } {
  const owner = isOwnerLevel(role);
  const pending = dec.state === 'PENDING';
  return {
    approve: owner && pending ? (dec.requestedByMe ? 'self' : 'ok') : null,
    reject: owner && pending && !dec.requestedByMe,
    withdraw: pending && dec.requestedByMe && canRoleWrite(role),
    revoke: owner && dec.state === 'ACTIVE',
  };
}

interface DecisionCtx { vulnId: string; assetName: string | null }

export function decisionConfirmText(a: VmDecisionAction, dec: Pick<VmDecision, 'kind' | 'expiresAt'>, ctx: DecisionCtx): string {
  const asset = ctx.assetName ?? NO_ASSET;
  const phrase = KIND_PHRASE[dec.kind];
  if (a === 'approve') return `Approve the ${phrase} for ${ctx.vulnId} on ${asset} until ${dateOf(dec.expiresAt)}? From now on it does not count as a gap. Its POA&M item, if it has one, is not changed.`;
  if (a === 'reject') return `Reject the request for ${ctx.vulnId} on ${asset}? It stays in the history and cannot be approved later.`;
  if (a === 'withdraw') return `Withdraw your request for ${ctx.vulnId} on ${asset}? It stays in the history.`;
  return `Revoke the ${phrase} for ${ctx.vulnId} on ${asset}? If it is past its deadline at a gap severity it counts as a gap again, and the next processed scan drafts a POA&M item if it needs one.`;
}

export function decisionDoneText(a: VmDecisionAction, dec: Pick<VmDecision, 'kind' | 'expiresAt'>, ctx: DecisionCtx): string {
  const asset = ctx.assetName ?? NO_ASSET;
  if (a === 'approve') return `Approved. ${ctx.vulnId} on ${asset} is ${dec.kind === 'RISK_ACCEPTED' ? 'risk accepted' : 'marked as a false positive'} until ${dateOf(dec.expiresAt)}.`;
  if (a === 'reject') return `Rejected the request for ${ctx.vulnId} on ${asset}.`;
  if (a === 'withdraw') return `Withdrew the request for ${ctx.vulnId} on ${asset}.`;
  return `Revoked. ${ctx.vulnId} on ${asset} counts as before.`;
}

export type DecisionActionErrorKind = 'session' | 'conflict' | 'self' | 'forbidden' | 'not_found' | 'expired' | 'not_active' | 'network' | 'failed';

/** Fixed copy for a failed approve, reject, withdraw or revoke: never the server's message. `reload` says the list is stale. */
export function decisionActionError(a: VmDecisionAction, err: unknown): { kind: DecisionActionErrorKind; text: string | null; reload: boolean } {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  const failed = { kind: 'failed' as const, text: 'That did not work. Nothing was changed. Try again.', reload: false };
  if (!e || e.name !== 'ApiError') return failed;
  const status = e.status;
  const reason = e.reason;
  if (status === 401) return { kind: 'session', text: null, reload: false };
  if (status === 403) {
    if (reason === 'self_approval_forbidden') return { kind: 'self', text: 'You requested this decision, so someone else must approve it.', reload: false };
    if (a === 'withdraw') return { kind: 'forbidden', text: 'Only the person who requested it can withdraw a request.', reload: false };
    return { kind: 'forbidden', text: 'This needs owner-level access (Tenant Owner, MSP Admin).', reload: false };
  }
  if (status === 409 && reason === 'decision_not_pending') return { kind: 'conflict', text: 'This request was already approved, rejected or withdrawn. The list has been reloaded.', reload: true };
  if (status === 409 && reason === 'decision_expired') return { kind: 'expired', text: 'This request reached its expiry date before it was approved. Request a new decision.', reload: true };
  if (status === 409 && reason === 'decision_not_active') return { kind: 'not_active', text: 'This decision is no longer in force, so there is nothing to revoke. The list has been reloaded.', reload: true };
  if (status === 404) return { kind: 'not_found', text: 'This decision no longer exists. The list has been reloaded.', reload: true };
  if (status === 0) return { kind: 'network', text: 'The server could not be reached. Nothing was changed.', reload: false };
  return failed;
}

export type DecisionRequestErrorKind = 'session' | 'pending' | 'not_open' | 'not_found' | 'invalid' | 'forbidden' | 'network' | 'failed';

export function decisionRequestError(err: unknown): { kind: DecisionRequestErrorKind; text: string | null; reload: boolean } {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  const failed = { kind: 'failed' as const, text: 'The request could not be sent. Try again.', reload: false };
  if (!e || e.name !== 'ApiError') return failed;
  const status = e.status;
  const reason = e.reason;
  if (status === 401) return { kind: 'session', text: null, reload: false };
  if (status === 409 && reason === 'decision_pending') return { kind: 'pending', text: 'A request for this finding is already waiting for approval.', reload: true };
  if (status === 409 && reason === 'finding_not_open') return { kind: 'not_open', text: 'This finding is no longer open, so no decision is needed.', reload: true };
  if (status === 404) return { kind: 'not_found', text: 'This finding no longer exists. It may have been removed with its asset.', reload: false };
  if (status === 400) return { kind: 'invalid', text: 'The request was refused. Check the decision type, justification and expiry date.', reload: false };
  if (status === 403) return { kind: 'forbidden', text: 'Only Tenant Owners, Admins and MSP Admins can request a decision.', reload: false };
  if (status === 0) return { kind: 'network', text: 'The server could not be reached. Nothing was sent.', reload: false };
  return failed;
}

/** The justification as the caller may see it: the text, or (for a Viewer, whose copy is null) only that one exists. */
export function justificationView(dec: Pick<VmDecision, 'justification' | 'justificationLength'>): { kind: 'text'; text: string } | { kind: 'hidden'; text: string } {
  if (dec.justification !== null) return { kind: 'text', text: dec.justification };
  return { kind: 'hidden', text: `A justification is recorded (${dec.justificationLength} characters). Viewers cannot read it.` };
}

/** ACTIVE members with owner-level access and a working account, or null when the member list is not known. */
export function ownerLevelCount(members: readonly TeamMember[] | undefined): number | null {
  if (!members) return null;
  return members.filter((m) => m.status === 'ACTIVE' && !m.accountDisabled && !m.membershipExpired && isOwnerLevel(m.role)).length;
}

export function approverNote(o: { role: TenantRole | null; ownerLevelCount: number | null }): string | null {
  if (o.ownerLevelCount === null) return null;
  if (isOwnerLevel(o.role) && o.ownerLevelCount <= 1) {
    return 'Nobody approves their own request, and this organization lists only one owner-level member. Unless an MSP Admin works with this organization, add a second Tenant Owner under Team & Role Permissions so decisions can be approved.';
  }
  if (o.role === 'TENANT_ADMIN' && o.ownerLevelCount === 0) {
    return 'This organization lists no owner-level member who could approve a request. Unless an MSP Admin works with this organization, ask for a Tenant Owner to be added.';
  }
  return null;
}

export function expiryText(expiresAt: string, nowMs: number): string {
  const days = Math.ceil((Date.parse(expiresAt) - nowMs) / DAY_MS);
  const date = dateOf(expiresAt);
  if (!(days > 0)) return `Expired ${date}`;
  return days === 1 ? `Expires ${date} (in 1 day)` : `Expires ${date} (in ${days} days)`;
}

export function pendingText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 decision request is waiting for approval.' : `${n} decision requests are waiting for approval.`;
}

// ------------------------------------------------------------------------------------------------ SSP paragraph

/** The recorded narrative and the generated policy paragraph the SSP appended to it (null when there is none). */
export function splitPolicyParagraph(text: string): { recorded: string; generated: string | null } {
  const at = text.lastIndexOf(VM_POLICY_SSP_LABEL_PREFIX);
  if (at === -1) return { recorded: text, generated: null };
  return { recorded: text.slice(0, at).replace(/\n+$/, ''), generated: text.slice(at) };
}

export function sspPolicyNote(framework: string, state: 'ready' | 'loading' | 'error' | 'unsupported', asOf: string | null): string | null {
  if ((framework !== 'CMMC_L1' && framework !== 'CMMC_L2') || state === 'unsupported') return null;
  if (state === 'loading') return 'Loading the vulnerability remediation policy for its generated SSP paragraph…';
  if (state === 'error') return 'The vulnerability remediation policy could not be loaded, so its generated paragraph is missing from this document. Reopen the export to try again.';
  if (asOf === null) return null;
  const si = cmmcDisplayId('SI.L1-3.14.1', framework);
  const ids = framework === 'CMMC_L1' ? `${si} ends` : `${cmmcDisplayId('RA.L2-3.11.3', framework)} and ${si} end`;
  return `${ids} with a paragraph generated from the vulnerability remediation policy (as of ${asOf}). It is labelled in every export and is not saved to the controls.`;
}

/** The date the paragraph is stated as of: the day the policy was last saved, or today (UTC) while the server defaults apply. */
export function policyAsOf(r: Pick<VmRemediationPolicyResponse, 'source' | 'updatedAt'>, nowMs: number): string {
  return r.source === 'tenant' && r.updatedAt ? dateOf(r.updatedAt) : new Date(nowMs).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------------------------------------ copy

export const REMEDIATION_COPY = {
  title: 'Vulnerability Remediation',
  subtitle: (org: string): string => `Deadlines, warnings and risk decisions for ${org}, across all its programs.`,
  menuItem: 'Vulnerability Remediation',
  browserOnly: 'Vulnerability remediation needs the scanner integration, which needs an organization stored on the server. This organization is stored only in this browser.',
  legend:
    "Remediation follows the organization's policy. On track: before its deadline. Warning: past the deadline, but tracked without a POA&M item (a warning-only severity, or still in the grace period). Gap: past the deadline and needs a POA&M item; this always applies to a known exploited vulnerability (listed by CISA KEV). Accepted: an approved risk decision is in force until it expires.",
  noMatchFilters: 'No findings match the search and filters.',
  summaryHeading: 'Open vulnerabilities by remediation tier',
  summaryLoading: 'Loading the remediation summary…',
  summaryEmpty: 'No open vulnerabilities are reported for this organization.',
  tileGap: 'Gaps',
  tileGapNote: 'Past the deadline; need a POA&M item',
  tileWarning: 'Warnings',
  tileWarningNote: 'Past the deadline; tracked here only',
  tileOnTrack: 'On track',
  tileOnTrackNote: 'Before the deadline',
  tileAccepted: 'Accepted',
  tileAcceptedNote: 'Approved risk decision in force',
  policyHeading: 'Remediation policy',
  policyIntro: 'How long each severity has before it counts against the organization, and which overdue findings need a POA&M item. It applies to every program of this organization.',
  policyLoading: 'Loading the remediation policy…',
  badgeDefaults: 'Using server defaults',
  badgeTenant: 'Saved for this organization',
  readOnlyPolicy: 'Only owner-level roles (Tenant Owner, MSP Admin) can change this policy.',
  daysLegend: 'Deadlines, in days from when a vulnerability is first seen',
  daysHint: 'Whole days from 1 to 3650. Each severity needs at least as many days as the one above it. Unknown severity counts as Medium.',
  warnLegend: 'Warning only (no POA&M item)',
  warnHint: 'Overdue findings at these severities are tracked as warnings here instead of becoming POA&M items. Critical and High always become gaps.',
  warnLowForced: 'Low is included whenever Medium is.',
  graceLabel: 'Grace period (days)',
  graceHint: 'Extra days after the deadline before a finding at a gap severity counts as a gap: 0 to 30. Never applies to a known exploited vulnerability.',
  fixedRule: 'Fixed rule: ',
  edit: 'Edit policy',
  cancel: 'Cancel',
  review: 'Review changes',
  confirmQuestion: 'Save these changes to the remediation policy?',
  confirmEffects: [
    "Every open finding's deadline is recalculated from when it was first seen. Resolved findings keep theirs.",
    'Existing POA&M items are not changed or removed. New items follow the next processed scan.',
    'The change is recorded in the policy history with your name.',
  ],
  back: 'Back to editing',
  save: 'Save policy',
  saving: 'Saving…',
  loadCurrent: 'Load the current policy',
  loadingCurrent: 'Loading the current policy…',
  loadCurrentFailed: 'The current policy could not be loaded. Try again.',
  loadedCurrent: 'The current policy is loaded. Your entries are kept: review them and save again.',
  useCurrent: 'Use the current values',
  historyToggle: 'Change history',
  historyLoading: 'Loading the policy history…',
  historyEmpty: 'No changes have been saved. The server defaults apply.',
  historyCap: 'Showing the 50 most recent changes.',
  discardQuestion: 'Discard the policy changes you have not saved?',
  keepEditing: 'Keep editing',
  discard: 'Discard changes',
  close: 'Close',
  retry: 'Retry',
  // risk decisions
  decisionsButton: 'Decisions',
  decisionsAria: (v: string): string => `Risk decisions for ${v}`,
  dialogTitle: (v: string): string => `Risk decisions: ${v}`,
  historyHeading: 'Decision history',
  historyNone: 'No decision has been requested for this finding.',
  requestHeading: 'Request a decision',
  kindLegend: 'Decision',
  kindRiskNote: 'The risk is understood and accepted until the expiry date. Stays in force if the affected packages change.',
  kindFpNote: 'The scanner is wrong about this host. Lapses automatically if the affected packages change.',
  justificationLabel: 'Justification',
  justificationHint:
    "Why the risk is acceptable, or why the finding is wrong. Stored only in this organization's database: never written to logs, the audit trail or the evidence snapshot, and not shown to Viewers.",
  expiresLabel: 'Expires on',
  expiresHint: (min: string, max: string): string => `In force until this date begins (UTC). Choose a date from ${min} to ${max}.`,
  approvalHint: 'Another person with owner-level access (Tenant Owner, MSP Admin) must approve it before it takes effect. Until then the finding counts as before.',
  pendingBlock: 'A request for this finding is waiting for approval. It must be approved, rejected or withdrawn before a new one can be made.',
  notOpen: 'This finding is not open, so no decision can be requested.',
  send: 'Send for approval',
  sending: 'Sending…',
  sent: 'Request sent. It takes effect once another person with owner-level access approves it.',
  discardRequest: 'Discard the request you have not sent?',
  discardRequestButton: 'Discard',
  selfApprove: 'You requested this decision, so someone else must approve it.',
  showJustification: 'Show justification',
  hideJustification: 'Hide justification',
  approve: 'Approve',
  reject: 'Reject request',
  withdraw: 'Withdraw request',
  revoke: 'Revoke decision',
  requestNew: 'Request a new decision',
  pendingHeading: (n: number | null): string => (n === null ? 'Waiting for approval' : `Waiting for approval (${n})`),
  pendingIntro: 'Requests to accept a risk or mark a false positive. They take effect only after another person with owner-level access approves them.',
  pendingEmpty: 'No request is waiting for approval.',
  reviewHeading: 'Decisions to re-review',
  reviewIntro: 'In force and expiring within 30 days. A decision cannot be extended: request a new one, which needs approval again.',
  reviewEmpty: 'No decision expires in the next 30 days.',
  decisionsLoading: 'Loading the decisions…',
  decisionsCap: 'Showing the 500 most recent.',
  requested: 'Requested',
  approved: 'Approved',
  notYet: 'Not yet',
};
