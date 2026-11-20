import type { VmFinding, VmFindingStatus, VmSeverity } from '../types/vm';
import type { TenantRole } from '../types/tenant';
import { isOwnerLevel } from '../utils/roles';

/**
 * The pure core of the vulnerability remediation policy (#268): the editable timelines, their validation, and the tier of one
 * finding (on track, warning, gap, accepted, closed). Shared by the server (POA&M drafting, the snapshot) and the screens. No
 * node or server imports, no clock: `nowMs` is always passed in.
 */

export type VmPolicySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
/** Only these two may be warn-only: CRITICAL, HIGH and known-exploited findings are always gaps once overdue. */
export type VmWarnOnlySeverity = 'MEDIUM' | 'LOW';

export interface VmRemediationPolicy {
  /** Remediation deadline in days after first sight. UNKNOWN severity uses the MEDIUM deadline. */
  slaDays: Record<VmPolicySeverity, number>;
  /** Severities whose overdue findings are shown as warnings on the dashboard and get no POA&M item. */
  warnOnly: VmWarnOnlySeverity[];
  /** Days after the due date during which an overdue finding is still a warning (never for known-exploited). */
  graceDays: number;
}

export const VM_POLICY_LIMITS = { daysMin: 1, daysMax: 3650, graceMax: 30 } as const;

export const VM_KEV_RULE_TEXT =
  'A known exploited vulnerability (CISA KEV) is due within the Critical deadline, or its own severity\'s deadline if that is shorter. Once overdue it is always a gap, with no grace period.';

const DAY_MS = 86_400_000;
const POLICY_SEVERITIES: readonly VmPolicySeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const POLICY_KEYS = ['slaDays', 'warnOnly', 'graceDays'];

export type VmPolicyRule = 'integer_range' | 'order' | 'not_allowed' | 'unknown_key' | 'type';

export type VmPolicyValidation =
  | { ok: true; policy: VmRemediationPolicy }
  | { ok: false; field: string; rule: VmPolicyRule };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The first problem found, naming the field and the rule but never the value. */
export function validateRemediationPolicy(body: unknown): VmPolicyValidation {
  if (!isRecord(body)) return { ok: false, field: 'body', rule: 'type' };
  if (Object.keys(body).some((k) => !POLICY_KEYS.includes(k))) return { ok: false, field: 'body', rule: 'unknown_key' };

  const sla = body.slaDays;
  if (!isRecord(sla)) return { ok: false, field: 'slaDays', rule: 'type' };
  if (Object.keys(sla).some((k) => !(POLICY_SEVERITIES as readonly string[]).includes(k))) {
    return { ok: false, field: 'slaDays', rule: 'unknown_key' };
  }
  const days = {} as Record<VmPolicySeverity, number>;
  for (const s of POLICY_SEVERITIES) {
    const v = sla[s];
    if (!isIntInRange(v, VM_POLICY_LIMITS.daysMin, VM_POLICY_LIMITS.daysMax)) {
      return { ok: false, field: `slaDays.${s}`, rule: 'integer_range' };
    }
    days[s] = v;
  }
  for (let i = 1; i < POLICY_SEVERITIES.length; i++) {
    if (days[POLICY_SEVERITIES[i]] < days[POLICY_SEVERITIES[i - 1]]) {
      return { ok: false, field: `slaDays.${POLICY_SEVERITIES[i]}`, rule: 'order' };
    }
  }

  const warn = body.warnOnly;
  if (!Array.isArray(warn)) return { ok: false, field: 'warnOnly', rule: 'type' };
  if (warn.some((w) => w !== 'MEDIUM' && w !== 'LOW')) return { ok: false, field: 'warnOnly', rule: 'not_allowed' };
  const hasMedium = warn.includes('MEDIUM');
  const hasLow = warn.includes('LOW');
  if (hasMedium && !hasLow) return { ok: false, field: 'warnOnly', rule: 'order' };
  const warnOnly: VmWarnOnlySeverity[] = [];
  if (hasMedium) warnOnly.push('MEDIUM');
  if (hasLow) warnOnly.push('LOW');

  const grace = body.graceDays;
  if (!isIntInRange(grace, 0, VM_POLICY_LIMITS.graceMax)) return { ok: false, field: 'graceDays', rule: 'integer_range' };

  return { ok: true, policy: { slaDays: days, warnOnly, graceDays: grace } };
}

export function samePolicy(a: VmRemediationPolicy, b: VmRemediationPolicy): boolean {
  if (a.graceDays !== b.graceDays) return false;
  if (POLICY_SEVERITIES.some((s) => a.slaDays[s] !== b.slaDays[s])) return false;
  const wa = [...new Set(a.warnOnly)].sort();
  const wb = [...new Set(b.warnOnly)].sort();
  return wa.length === wb.length && wa.every((w, i) => w === wb[i]);
}

// ------------------------------------------------------------------------------------------------ tiers

export type VmRemediationTier = 'CLOSED' | 'ON_TRACK' | 'WARNING' | 'GAP' | 'ACCEPTED';

export type VmTierReason =
  | 'resolved'
  | 'within_due'
  | 'no_due_date'
  | 'warn_only_severity'
  | 'grace_period'
  | 'overdue'
  | 'kev_overdue'
  | 'risk_accepted'
  | 'false_positive'
  | 'legacy_decision';

export interface VmTierFinding {
  status: VmFindingStatus;
  severity: VmSeverity;
  slaDueAt: string | null;
  kev: boolean;
}

/** A risk decision that is approved and not revoked or lapsed, as the tier function needs it. */
export interface VmEffectiveDecision {
  decisionId: string;
  kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE';
  expiresAt: string;
  approvedAt: string;
}

export interface VmTierResult {
  tier: VmRemediationTier;
  reason: VmTierReason;
  dueAt: string | null;
  /** Whole days past the due date; null when the finding is not overdue. */
  overdueDays: number | null;
  /** The end of the grace period; set only when a grace period applies to this finding. */
  graceEndsAt: string | null;
  decision: { id: string; kind: string; expiresAt: string } | null;
}

/**
 * The tier of one finding. The first rule that matches wins: resolved, a legacy human status, an effective decision, no due date,
 * not yet overdue, known-exploited (always a gap), a warn-only severity (UNKNOWN counts as MEDIUM), inside the grace period, else
 * a gap. "Overdue" is `due < now`, the same strict test as planPoamItems.
 */
export function computeRemediationTier(
  f: VmTierFinding,
  policy: VmRemediationPolicy,
  decision: VmEffectiveDecision | null,
  nowMs: number,
): VmTierResult {
  const dueMs = f.slaDueAt === null ? NaN : Date.parse(f.slaDueAt);
  const hasDue = !Number.isNaN(dueMs);
  const overdue = hasDue && dueMs < nowMs;
  const base = {
    dueAt: f.slaDueAt,
    overdueDays: overdue ? Math.floor((nowMs - dueMs) / DAY_MS) : null,
    graceEndsAt: null as string | null,
    decision: null as VmTierResult['decision'],
  };
  const done = (tier: VmRemediationTier, reason: VmTierReason, extra: Partial<VmTierResult> = {}): VmTierResult => ({
    tier,
    reason,
    ...base,
    ...extra,
  });

  if (f.status === 'RESOLVED') return done('CLOSED', 'resolved', { overdueDays: null });
  if (f.status === 'RISK_ACCEPTED' || f.status === 'FALSE_POSITIVE') return done('ACCEPTED', 'legacy_decision');
  if (decision !== null && Date.parse(decision.expiresAt) > nowMs) {
    return done('ACCEPTED', decision.kind === 'RISK_ACCEPTED' ? 'risk_accepted' : 'false_positive', {
      decision: { id: decision.decisionId, kind: decision.kind, expiresAt: decision.expiresAt },
    });
  }
  if (!hasDue) return done('ON_TRACK', 'no_due_date');
  if (!overdue) return done('ON_TRACK', 'within_due');
  if (f.kev) return done('GAP', 'kev_overdue');
  const effective: VmPolicySeverity = f.severity === 'UNKNOWN' ? 'MEDIUM' : f.severity;
  if ((policy.warnOnly as readonly string[]).includes(effective)) return done('WARNING', 'warn_only_severity');
  if (policy.graceDays > 0) {
    const graceEndMs = dueMs + policy.graceDays * DAY_MS;
    const graceEndsAt = new Date(graceEndMs).toISOString();
    return nowMs <= graceEndMs ? done('WARNING', 'grace_period', { graceEndsAt }) : done('GAP', 'overdue', { graceEndsAt });
  }
  return done('GAP', 'overdue');
}

export interface VmTierTally {
  onTrack: number;
  warning: number;
  gap: number;
  accepted: number;
  warningBySeverity: Record<VmSeverity, number>;
  gapCritical: number;
  gapHigh: number;
  gapKev: number;
}

/** Counts of tier results; `severities[i]` is the severity of `results[i]`. CLOSED results are not counted. */
export function tallyTiers(results: readonly VmTierResult[], severities: readonly VmSeverity[]): VmTierTally {
  const t: VmTierTally = {
    onTrack: 0,
    warning: 0,
    gap: 0,
    accepted: 0,
    warningBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
    gapCritical: 0,
    gapHigh: 0,
    gapKev: 0,
  };
  results.forEach((r, i) => {
    const sev = severities[i];
    if (r.tier === 'ON_TRACK') t.onTrack += 1;
    else if (r.tier === 'ACCEPTED') t.accepted += 1;
    else if (r.tier === 'WARNING') {
      t.warning += 1;
      t.warningBySeverity[sev] += 1;
    } else if (r.tier === 'GAP') {
      t.gap += 1;
      if (sev === 'CRITICAL') t.gapCritical += 1;
      if (sev === 'HIGH') t.gapHigh += 1;
      if (r.reason === 'kev_overdue') t.gapKev += 1;
    }
  });
  return t;
}

// ------------------------------------------------------------------------------------------------ risk decisions

export type VmDecisionKind = 'RISK_ACCEPTED' | 'FALSE_POSITIVE';
export type VmDecisionState = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REJECTED' | 'WITHDRAWN' | 'REVOKED' | 'PACKAGE_CHANGED';
export type VmDecisionAction = 'approved' | 'rejected' | 'withdrawn' | 'revoked';

export const VM_DECISION_JUSTIFICATION_MAX = 4000;
/** A decision (either kind) lasts at most this many days from the day it is requested. */
export const VM_DECISION_MAX_DAYS = 365;

/** The fields of a stored decision that its state depends on. */
export interface VmDecisionCore {
  kind: VmDecisionKind;
  expiresAt: string;
  /** SHA-256 of packageCanonical() of the finding when the decision was requested. */
  packageFingerprint: string;
}

export interface VmDecisionEventCore {
  action: VmDecisionAction;
  createdAt: string;
}

/**
 * The state of one decision at `nowMs`. A decision is effective strictly before its expiry. A rejected or withdrawn request stays that way;
 * a request nobody approved before its expiry is EXPIRED. A revoked decision is REVOKED whatever its date. A FALSE_POSITIVE also lapses
 * (PACKAGE_CHANGED) once the finding's affected packages differ from the ones it was approved for; a RISK_ACCEPTED does not.
 */
export function decisionState(
  d: VmDecisionCore,
  events: readonly VmDecisionEventCore[],
  currentFingerprint: string,
  nowMs: number,
): VmDecisionState {
  if (events.some((e) => e.action === 'rejected')) return 'REJECTED';
  if (events.some((e) => e.action === 'withdrawn')) return 'WITHDRAWN';
  const expired = !(Date.parse(d.expiresAt) > nowMs);
  if (!events.some((e) => e.action === 'approved')) return expired ? 'EXPIRED' : 'PENDING';
  if (events.some((e) => e.action === 'revoked')) return 'REVOKED';
  if (expired) return 'EXPIRED';
  if (d.kind === 'FALSE_POSITIVE' && d.packageFingerprint !== currentFingerprint) return 'PACKAGE_CHANGED';
  return 'ACTIVE';
}

/** The newest (by approval time) ACTIVE decision of one finding, or null. `eventsById` maps a decision id to its events. */
export function effectiveDecision(
  decisions: ReadonlyArray<VmDecisionCore & { id: string }>,
  eventsById: Readonly<Record<string, readonly VmDecisionEventCore[]>>,
  currentFingerprint: string,
  nowMs: number,
): VmEffectiveDecision | null {
  let best: VmEffectiveDecision | null = null;
  for (const d of decisions) {
    const events = eventsById[d.id] ?? [];
    if (decisionState(d, events, currentFingerprint, nowMs) !== 'ACTIVE') continue;
    const approvedAt = events.find((e) => e.action === 'approved')?.createdAt;
    if (approvedAt === undefined) continue;
    const better = best === null || Date.parse(approvedAt) > Date.parse(best.approvedAt) || (approvedAt === best.approvedAt && d.id > best.decisionId);
    if (better) best = { decisionId: d.id, kind: d.kind, expiresAt: d.expiresAt, approvedAt };
  }
  return best;
}

/**
 * What identifies the packages a finding is about, for the false-positive lapse rule: the sorted "name@version" lines plus the true count
 * ("#n"), so a change beyond the stored list still changes it. The legacy single package stands in when the list is empty. The server hashes it.
 */
export function packageCanonical(f: Pick<VmFinding, 'affectedPackages' | 'packageName' | 'packageVersion' | 'affectedPackageCount'>): string {
  const list = f.affectedPackages.length > 0 ? f.affectedPackages : f.packageName ? [{ name: f.packageName, version: f.packageVersion }] : [];
  const lines = list.map((p) => `${p.name}@${p.version}`).sort();
  return `${lines.join('\n')}#${Math.max(f.affectedPackageCount, list.length)}`;
}

export type VmDecisionRequestCode = 'required' | 'too_long' | 'range' | 'kind';

export type VmDecisionRequestValidation =
  | { ok: true; value: { kind: VmDecisionKind; justification: string; expiresAt: string } }
  | { ok: false; field: 'kind' | 'justification' | 'expiresAt' | 'body'; code: VmDecisionRequestCode };

/**
 * A decision request body: { kind, justification, expiresAt: 'YYYY-MM-DD' }. The justification is trimmed and at most 4000 code points.
 * The date must be after today (UTC) and at most 365 days after it; the value returned is that day's start (UTC) as an ISO timestamp.
 * Names the field and a code, never the value.
 */
export function validateDecisionRequest(body: unknown, nowMs: number): VmDecisionRequestValidation {
  if (!isRecord(body)) return { ok: false, field: 'body', code: 'required' };
  const kind = body.kind;
  if (kind !== 'RISK_ACCEPTED' && kind !== 'FALSE_POSITIVE') return { ok: false, field: 'kind', code: 'kind' };
  const raw = body.justification;
  const justification = typeof raw === 'string' ? raw.trim() : '';
  if (justification === '') return { ok: false, field: 'justification', code: 'required' };
  if ([...justification].length > VM_DECISION_JUSTIFICATION_MAX) return { ok: false, field: 'justification', code: 'too_long' };
  const date = body.expiresAt;
  if (typeof date !== 'string' || date === '') return { ok: false, field: 'expiresAt', code: 'required' };
  const dayMs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (Number.isNaN(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== date) return { ok: false, field: 'expiresAt', code: 'range' };
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  if (dayMs <= todayMs || dayMs > todayMs + VM_DECISION_MAX_DAYS * DAY_MS) return { ok: false, field: 'expiresAt', code: 'range' };
  return { ok: true, value: { kind, justification, expiresAt: new Date(dayMs).toISOString() } };
}

/** Who may approve: owner-level access (Tenant Owner, MSP Admin), and never the person who requested it ('self'; the role is checked first). */
export function canApprove(approver: { userId: string; role: TenantRole | null }, requesterUserId: string): 'ok' | 'role' | 'self' {
  if (!isOwnerLevel(approver.role)) return 'role';
  return approver.userId === requesterUserId ? 'self' : 'ok';
}

/** The ACTIVE rows that expire within `days` days (inclusive) of `nowMs`. */
export function expiringSoon<T extends { state: VmDecisionState; expiresAt: string }>(rows: readonly T[], nowMs: number, days = 30): T[] {
  return rows.filter((r) => r.state === 'ACTIVE' && Date.parse(r.expiresAt) - nowMs <= days * DAY_MS);
}

// ------------------------------------------------------------------------------------------------ SSP paragraph

/** The two controls whose SSP narrative states the policy: vulnerability remediation (RA 3.11.3) and flaw remediation (SI 3.14.1). */
export const VM_POLICY_SSP_CONTROLS = ['RA.L2-3.11.3', 'SI.L1-3.14.1'] as const;

/** What every generated paragraph starts with, so a screen can set it apart from the recorded narrative. */
export const VM_POLICY_SSP_LABEL_PREFIX = '[Generated from the vulnerability remediation policy as of ';

/**
 * The paragraph the SSP appends to the two controls' narratives, stating the organization's remediation policy as it is configured on `asOf`
 * (YYYY-MM-DD). It is generated at export time, labelled as such, and never stored: the recorded narrative, the control notes and every status
 * are untouched. Null for any other control.
 */
export function remediationPolicySspParagraph(controlId: string, policy: VmRemediationPolicy, asOf: string): string | null {
  if (!(VM_POLICY_SSP_CONTROLS as readonly string[]).includes(controlId)) return null;
  const d = policy.slaDays;
  const warn = policy.warnOnly;
  const gapList = warn.length >= 2 ? 'Critical or High' : warn.length === 1 ? 'Critical, High or Medium' : 'Critical, High, Medium or Low';
  const warnClause =
    warn.length >= 2
      ? '; Medium and Low vulnerabilities past their deadline are tracked as warnings on the Vulnerability Remediation screen.'
      : warn.length === 1
        ? '; Low vulnerabilities past their deadline are tracked as warnings on the Vulnerability Remediation screen.'
        : '.';
  const grace =
    policy.graceDays > 0
      ? ` A grace period of ${policy.graceDays} ${policy.graceDays === 1 ? 'day' : 'days'} applies before a vulnerability counts as overdue, except a known exploited one.`
      : '';
  return (
    `${VM_POLICY_SSP_LABEL_PREFIX}${asOf}; not part of the recorded narrative] ` +
    `Vulnerabilities reported by the organization's scanners must be remediated within these deadlines, counted from when each is first seen: ` +
    `Critical ${d.CRITICAL} days, High ${d.HIGH} days, Medium ${d.MEDIUM} days, Low ${d.LOW} days; unknown severity is treated as Medium. ` +
    `A known exploited vulnerability (CISA KEV) is due within the Critical deadline, or its own deadline if that is shorter. ` +
    `A ${gapList} vulnerability, or a known exploited one, that is still open after its deadline is recorded as a POA&M item${warnClause}${grace} ` +
    `A finding may be accepted as a risk or marked as a false positive only with a written justification, approved by an owner-level administrator ` +
    `(Tenant Owner, MSP Admin) other than the person who requested it, for at most ${VM_DECISION_MAX_DAYS} days.`
  );
}

/**
 * The narrative with the policy paragraph appended after a blank line, for the two controls of a CMMC Level 1 or 2 program, and only when the
 * policy is given (a package built without it is unchanged). Any other framework or control: the narrative as it is.
 */
export function appendRemediationPolicyParagraph(
  narrative: string,
  controlId: string,
  framework: string,
  policy?: { policy: VmRemediationPolicy; asOf: string },
): string {
  if (!policy || (framework !== 'CMMC_L1' && framework !== 'CMMC_L2')) return narrative;
  const paragraph = remediationPolicySspParagraph(controlId, policy.policy, policy.asOf);
  if (paragraph === null) return narrative;
  return narrative.trim() === '' ? paragraph : `${narrative}\n\n${paragraph}`;
}
