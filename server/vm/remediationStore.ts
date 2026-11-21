import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, nextStamp } from '../db';
import { listAssets } from '../assets';
import { StaleWriteError, matchesExpected } from '../controlAssessments';
import {
  decisionState,
  effectiveDecision,
  canApprove,
  packageCanonical,
  samePolicy,
  tallyTiers,
} from '../../src/data/vmRemediation';
import type {
  VmDecisionAction,
  VmDecisionEventCore,
  VmDecisionKind,
  VmDecisionState,
  VmEffectiveDecision,
  VmRemediationPolicy,
  VmTierResult,
  VmTierTally,
  VmWarnOnlySeverity,
} from '../../src/data/vmRemediation';
import { isOwnerLevel } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';
import type { VmFinding, VmSeverity } from '../../src/types/vm';
import type { VmPolicyEvent } from '../../src/types/vmRemediation';
import { getFindingForUpdate, listTierFindings, loadFindingsByIds, loadKevFlags, recomputeOpenSlaDueAt, tierOf, withVmTenantTx } from './findingsStore';
import type { VmTierRules } from './findingsStore';
import { getVmSlaConfig } from './transitions';

/**
 * The tenant's vulnerability remediation policy and risk decisions (#268): PostgreSQL (tenant tables with row security, history append-only)
 * or process memory when DB_MODE=memory. The policy is one row per tenant; a tenant with none uses the defaults the environment gives
 * (VM_SLA_DAYS_*, VM_WARN_ONLY_SEVERITIES, VM_GRACE_DAYS). Saving it recomputes the due dates of the open findings in the same transaction.
 * A decision's state is never stored: it is derived from its events and dates (src/data/vmRemediation.ts), so it follows the clock without a timer.
 * Nothing here logs; nothing puts a justification, host name or CVE id anywhere but the decision row itself.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const ACTOR_MAX = 255;
const USER_ID_MAX = 128;
const DECISIONS_MAX = 5000;

type Client = pg.PoolClient | null;

/** Runs `fn` in the caller's transaction when it has one (a client, or null in memory mode), else in a new tenant transaction. */
function inTx<T>(tenantId: string, client: Client | undefined, fn: (c: Client) => Promise<T>): Promise<T> {
  return client !== undefined ? fn(client) : withVmTenantTx(tenantId, fn);
}

const need = (c: Client): pg.PoolClient => {
  if (!c) throw new Error('A PostgreSQL client is required outside memory mode');
  return c;
};

// ------------------------------------------------------------------------------------------------ memory

interface MemoryPolicy {
  policy: VmRemediationPolicy;
  updatedAt: string;
  updatedBy: string;
}

const memoryPolicies = new Map<string, MemoryPolicy>(); // key: tenantId
const memoryPolicyEvents: Array<VmPolicyEvent & { tenantId: string }> = [];
const memoryDecisions: StoredDecision[] = [];
const memoryDecisionEvents: StoredDecisionEvent[] = [];

/** Test hook. */
export function __resetVmRemediationForTests(): void {
  memoryPolicies.clear();
  memoryPolicyEvents.length = 0;
  memoryDecisions.length = 0;
  memoryDecisionEvents.length = 0;
}

// ------------------------------------------------------------------------------------------------ defaults

/**
 * The policy a tenant has until it saves one: VM_SLA_DAYS_* (clamped 1..3650, defaults 15/30/90/180), VM_WARN_ONLY_SEVERITIES and VM_GRACE_DAYS.
 * docker-compose passes unset settings as empty strings, so '' means "the default"; 'none' means an empty warn-only list. A warn-only list that
 * names anything but MEDIUM and LOW, or MEDIUM without LOW, is ignored (the default applies). Not checked for ordering: a save is.
 */
export function getDefaultRemediationPolicy(env: NodeJS.ProcessEnv = process.env): VmRemediationPolicy {
  const raw = (env.VM_WARN_ONLY_SEVERITIES ?? '').trim().toUpperCase();
  let warnOnly: VmWarnOnlySeverity[] = ['MEDIUM', 'LOW'];
  if (raw === 'NONE') {
    warnOnly = [];
  } else if (raw !== '') {
    const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t !== '');
    const valid = tokens.length > 0 && tokens.every((t) => t === 'MEDIUM' || t === 'LOW') && (!tokens.includes('MEDIUM') || tokens.includes('LOW'));
    if (valid) warnOnly = tokens.includes('MEDIUM') ? ['MEDIUM', 'LOW'] : ['LOW'];
  }
  const rawGrace = (env.VM_GRACE_DAYS ?? '').trim();
  const graceDays = /^\d+$/.test(rawGrace) ? Math.min(30, Number(rawGrace)) : 0;
  return { slaDays: getVmSlaConfig(env), warnOnly, graceDays };
}

// ------------------------------------------------------------------------------------------------ policy

export interface StoredPolicy {
  policy: VmRemediationPolicy;
  source: 'tenant' | 'defaults';
  updatedAt: string | null;
  updatedBy: string | null;
}

function rowToPolicy(r: pg.QueryResultRow): VmRemediationPolicy {
  const warn = Array.isArray(r.warn_only) ? (r.warn_only as string[]) : [];
  const warnOnly: VmWarnOnlySeverity[] = [];
  if (warn.includes('MEDIUM')) warnOnly.push('MEDIUM');
  if (warn.includes('LOW')) warnOnly.push('LOW');
  return {
    slaDays: { CRITICAL: r.days_critical, HIGH: r.days_high, MEDIUM: r.days_medium, LOW: r.days_low },
    warnOnly,
    graceDays: r.grace_days,
  };
}

const clonePolicy = (p: VmRemediationPolicy): VmRemediationPolicy => ({ slaDays: { ...p.slaDays }, warnOnly: [...p.warnOnly], graceDays: p.graceDays });

async function readStored(tenantId: string, client: Client, lock: boolean): Promise<StoredPolicy | null> {
  if (isMemory()) {
    const m = memoryPolicies.get(tenantId);
    return m ? { policy: clonePolicy(m.policy), source: 'tenant', updatedAt: m.updatedAt, updatedBy: m.updatedBy } : null;
  }
  const { rows } = await need(client).query(`SELECT * FROM vm_remediation_policy WHERE tenant_id = $1::text${lock ? ' FOR UPDATE' : ''}`, [tenantId]);
  const r = rows[0];
  return r ? { policy: rowToPolicy(r), source: 'tenant', updatedAt: iso(r.updated_at), updatedBy: r.updated_by ?? null } : null;
}

/** The tenant's stored policy with who saved it and when, or the environment defaults (source 'defaults', no stamp). */
export async function loadStoredPolicy(tenantId: string, client?: Client): Promise<StoredPolicy> {
  const stored = await inTx(tenantId, client, (c) => readStored(tenantId, c, false));
  return stored ?? { policy: getDefaultRemediationPolicy(), source: 'defaults', updatedAt: null, updatedBy: null };
}

/** The policy in force for the tenant. The worker passes its transaction's client. */
export async function loadRemediationPolicy(tenantId: string, client?: Client): Promise<VmRemediationPolicy> {
  return (await loadStoredPolicy(tenantId, client)).policy;
}

export interface PolicyActor {
  /** Display name; the first 255 characters are kept. */
  actor: string;
  userId: string | null;
  role: TenantRole | null;
}

export interface PolicySaveOutcome {
  policy: VmRemediationPolicy;
  updatedAt: string;
  changed: boolean;
  impact: { openRecomputed: number; gap: number; warning: number };
}

/**
 * Saves the tenant's policy (already validated). `expectedUpdatedAt` is the stamp the caller loaded (null when it loaded the defaults), else
 * StaleWriteError. A save that changes nothing writes nothing (`changed: false`, no event, the stamp stays). A real change, in ONE transaction:
 * stores the policy, recomputes sla_due_at of the tenant's open findings, and records one event with the old and new numbers and how many due
 * dates changed. The impact counts what the new policy makes of the open findings. `nowIso` is injected: nothing here reads the clock.
 */
export async function saveRemediationPolicy(
  tenantId: string,
  policy: VmRemediationPolicy,
  expectedUpdatedAt: string | null,
  who: PolicyActor,
  nowIso: string,
): Promise<PolicySaveOutcome> {
  const actor = who.actor.slice(0, ACTOR_MAX);
  const userId = who.userId ? who.userId.slice(0, USER_ID_MAX) : null;
  const next = clonePolicy(policy);
  return withVmTenantTx(tenantId, async (c) => {
    if (!isMemory()) await need(c).query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', ['vm_remediation_policy', tenantId]);
    const current = await readStored(tenantId, c, true);
    if (!matchesExpected(current?.updatedAt ?? null, expectedUpdatedAt)) {
      throw new StaleWriteError({ updatedAt: current?.updatedAt ?? null, updatedBy: current?.updatedBy ?? null });
    }
    if (current && samePolicy(current.policy, next)) {
      const same = await impactOf(tenantId, next, nowIso, 0, c);
      return { policy: current.policy, updatedAt: current.updatedAt as string, changed: false, impact: same };
    }
    const updatedAt = nextStamp(current?.updatedAt ?? null, Date.parse(nowIso));
    if (isMemory()) {
      memoryPolicies.set(tenantId, { policy: next, updatedAt, updatedBy: actor });
    } else {
      await need(c).query(
        `INSERT INTO vm_remediation_policy (tenant_id, days_critical, days_high, days_medium, days_low, warn_only, grace_days, updated_by, updated_by_user_id, updated_at)
         VALUES ($1::text, $2::integer, $3::integer, $4::integer, $5::integer, $6::text[], $7::integer, $8::text, $9::text, $10::timestamptz)
         ON CONFLICT (tenant_id) DO UPDATE
            SET days_critical = EXCLUDED.days_critical, days_high = EXCLUDED.days_high, days_medium = EXCLUDED.days_medium, days_low = EXCLUDED.days_low,
                warn_only = EXCLUDED.warn_only, grace_days = EXCLUDED.grace_days, updated_by = EXCLUDED.updated_by,
                updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = EXCLUDED.updated_at`,
        [tenantId, next.slaDays.CRITICAL, next.slaDays.HIGH, next.slaDays.MEDIUM, next.slaDays.LOW, next.warnOnly, next.graceDays, actor, userId, updatedAt],
      );
    }
    const recomputed = await recomputeOpenSlaDueAt(tenantId, next.slaDays, c);
    if (isMemory()) {
      memoryPolicyEvents.push({
        id: crypto.randomUUID(),
        tenantId,
        actor,
        actorRole: who.role,
        oldPolicy: current ? clonePolicy(current.policy) : null,
        newPolicy: clonePolicy(next),
        openFindingsRecomputed: recomputed,
        createdAt: updatedAt,
      });
    } else {
      await need(c).query(
        `INSERT INTO vm_remediation_policy_events (tenant_id, actor, actor_user_id, actor_role, old_policy, new_policy, open_findings_recomputed, created_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::integer, $8::timestamptz)`,
        [tenantId, actor, userId, who.role, current ? JSON.stringify(current.policy) : null, JSON.stringify(next), recomputed, updatedAt],
      );
    }
    return { policy: next, updatedAt, changed: true, impact: await impactOf(tenantId, next, nowIso, recomputed, c) };
  });
}

/** What the policy makes of the tenant's findings now: how many are gaps and warnings (and how many due dates the save recomputed). */
async function impactOf(tenantId: string, policy: VmRemediationPolicy, nowIso: string, openRecomputed: number, c: Client): Promise<PolicySaveOutcome['impact']> {
  const tally = await tallyOf(tenantId, policy, nowIso, c);
  return { openRecomputed, gap: tally.gap, warning: tally.warning };
}

/** The policy's events, newest first (at most `limit`). */
export async function listPolicyEvents(tenantId: string, limit: number): Promise<VmPolicyEvent[]> {
  if (isMemory()) {
    return memoryPolicyEvents
      .filter((e) => e.tenantId === tenantId)
      .slice()
      .reverse()
      .slice(0, limit)
      .map(({ tenantId: _t, ...e }) => ({ ...e, oldPolicy: e.oldPolicy ? clonePolicy(e.oldPolicy) : null, newPolicy: clonePolicy(e.newPolicy) }));
  }
  return withVmTenantTx(tenantId, async (c) => {
    const { rows } = await need(c).query(
      `SELECT id, actor, actor_role, old_policy, new_policy, open_findings_recomputed, created_at
         FROM vm_remediation_policy_events WHERE tenant_id = $1::text ORDER BY created_at DESC, id DESC LIMIT $2::integer`,
      [tenantId, limit],
    );
    return rows.map((r): VmPolicyEvent => ({
      id: r.id,
      actor: r.actor,
      actorRole: r.actor_role ?? null,
      oldPolicy: (r.old_policy ?? null) as VmRemediationPolicy | null,
      newPolicy: r.new_policy as VmRemediationPolicy,
      openFindingsRecomputed: Number(r.open_findings_recomputed ?? 0),
      createdAt: iso(r.created_at) as string,
    }));
  });
}

// ------------------------------------------------------------------------------------------------ decisions

export interface StoredDecision {
  id: string;
  tenantId: string;
  findingId: string;
  assetId: string;
  vulnId: string;
  kind: VmDecisionKind;
  /** User text, possibly CUI: only ever read back by the decision routes. */
  justification: string;
  justificationSha256: string;
  packageFingerprint: string;
  findingFirstSeenAt: string;
  requestedBy: string;
  requestedByUserId: string;
  requestedByRole: string;
  requestedAt: string;
  expiresAt: string;
}

export interface StoredDecisionEvent extends VmDecisionEventCore {
  id: string;
  tenantId: string;
  decisionId: string;
  actor: string;
  actorUserId: string;
  actorRole: string;
}

/** A decision with its events and its state at the time it was read. */
export interface DecisionView {
  decision: StoredDecision;
  events: StoredDecisionEvent[];
  state: VmDecisionState;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The host name of the finding's asset; filled by listDecisionStates only. */
  assetName: string | null;
  /** The fingerprint of the finding's packages now (what a FALSE_POSITIVE is compared with). */
  currentFingerprint: string;
}

export type VmDecisionErrorCode =
  | 'not_found'
  | 'finding_not_open'
  | 'decision_pending'
  | 'decision_not_pending'
  | 'decision_expired'
  | 'decision_not_active'
  | 'self_approval_forbidden'
  | 'owner_required'
  | 'not_requester';

/** A decision request or resolution the rules refuse. Carries a code only, never any text of the decision. */
export class VmDecisionError extends Error {
  constructor(readonly code: VmDecisionErrorCode) {
    super(code);
    this.name = 'VmDecisionError';
  }
}

export interface DecisionActor {
  name: string;
  userId: string;
  role: TenantRole | null;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const fingerprintOf = (f: Pick<VmFinding, 'affectedPackages' | 'packageName' | 'packageVersion' | 'affectedPackageCount'>): string => sha256(packageCanonical(f));

function rowToDecision(r: pg.QueryResultRow): StoredDecision {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    findingId: r.finding_id,
    assetId: r.asset_id,
    vulnId: r.vuln_id,
    kind: r.kind as VmDecisionKind,
    justification: r.justification,
    justificationSha256: String(r.justification_sha256).trim(),
    packageFingerprint: String(r.package_fingerprint).trim(),
    findingFirstSeenAt: iso(r.finding_first_seen_at) as string,
    requestedBy: r.requested_by,
    requestedByUserId: r.requested_by_user_id,
    requestedByRole: r.requested_by_role,
    requestedAt: iso(r.requested_at) as string,
    expiresAt: iso(r.expires_at) as string,
  };
}

function rowToDecisionEvent(r: pg.QueryResultRow): StoredDecisionEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    decisionId: r.decision_id,
    action: r.action as VmDecisionAction,
    actor: r.actor,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    createdAt: iso(r.created_at) as string,
  };
}

interface Bundle {
  decisions: StoredDecision[];
  events: StoredDecisionEvent[];
}

/** The tenant's decisions (newest first, at most 5000) with their events, narrowed to some findings or one decision. */
async function loadBundle(tenantId: string, filter: { findingIds?: string[]; decisionId?: string }, c: Client): Promise<Bundle> {
  if (isMemory()) {
    const decisions = memoryDecisions
      .filter((d) => d.tenantId === tenantId && (!filter.findingIds || filter.findingIds.includes(d.findingId)) && (!filter.decisionId || d.id === filter.decisionId))
      .sort((a, b) => (a.requestedAt === b.requestedAt ? (a.id < b.id ? 1 : -1) : a.requestedAt < b.requestedAt ? 1 : -1))
      .slice(0, DECISIONS_MAX)
      .map((d) => ({ ...d }));
    const ids = new Set(decisions.map((d) => d.id));
    return { decisions, events: memoryDecisionEvents.filter((e) => e.tenantId === tenantId && ids.has(e.decisionId)).map((e) => ({ ...e })) };
  }
  const where = ['d.tenant_id = $1::text'];
  const params: unknown[] = [tenantId];
  if (filter.findingIds) {
    params.push(filter.findingIds);
    where.push(`d.finding_id = ANY($${params.length}::text[])`);
  }
  if (filter.decisionId) {
    params.push(filter.decisionId);
    where.push(`d.id = $${params.length}::text`);
  }
  const found = await need(c).query(`SELECT d.* FROM vm_finding_decisions d WHERE ${where.join(' AND ')} ORDER BY d.requested_at DESC, d.id DESC LIMIT ${DECISIONS_MAX}`, params);
  const decisions = found.rows.map(rowToDecision);
  if (decisions.length === 0) return { decisions, events: [] };
  const ev = await need(c).query('SELECT * FROM vm_finding_decision_events WHERE tenant_id = $1::text AND decision_id = ANY($2::text[]) ORDER BY created_at, id', [tenantId, decisions.map((d) => d.id)]);
  return { decisions, events: ev.rows.map(rowToDecisionEvent) };
}

function buildViews(bundle: Bundle, findings: ReadonlyMap<string, VmFinding>, nowMs: number): DecisionView[] {
  const byDecision = new Map<string, StoredDecisionEvent[]>();
  for (const e of bundle.events) {
    const list = byDecision.get(e.decisionId);
    if (list) list.push(e);
    else byDecision.set(e.decisionId, [e]);
  }
  return bundle.decisions.map((d) => {
    const events = (byDecision.get(d.id) ?? []).sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
    const f = findings.get(d.findingId);
    const currentFingerprint = f ? fingerprintOf(f) : d.packageFingerprint;
    const approved = events.find((e) => e.action === 'approved');
    return {
      decision: d,
      events,
      state: decisionState(d, events, currentFingerprint, nowMs),
      approvedBy: approved?.actor ?? null,
      approvedAt: approved?.createdAt ?? null,
      assetName: null,
      currentFingerprint,
    };
  });
}

async function viewsFor(tenantId: string, nowIso: string, filter: { findingIds?: string[]; decisionId?: string }, c: Client): Promise<DecisionView[]> {
  const bundle = await loadBundle(tenantId, filter, c);
  if (bundle.decisions.length === 0) return [];
  const findings = new Map((await loadFindingsByIds(tenantId, [...new Set(bundle.decisions.map((d) => d.findingId))], c)).map((f) => [f.id, f]));
  return buildViews(bundle, findings, Date.parse(nowIso));
}

/**
 * A new request, PENDING until another owner-level member approves it (the finding is not changed). The finding row is locked first, so two
 * requests cannot both pass the "one waiting request per finding" rule. Throws VmDecisionError: not_found, finding_not_open, decision_pending.
 * `value` comes from validateDecisionRequest (justification trimmed, expiresAt an ISO timestamp after `nowIso`).
 */
export async function requestDecision(
  tenantId: string,
  findingId: string,
  value: { kind: VmDecisionKind; justification: string; expiresAt: string },
  who: DecisionActor,
  nowIso: string,
): Promise<DecisionView> {
  const actor = who.name.slice(0, ACTOR_MAX);
  const userId = who.userId.slice(0, USER_ID_MAX);
  return withVmTenantTx(tenantId, async (c) => {
    const locked = await getFindingForUpdate(tenantId, findingId, c);
    if (!locked) throw new VmDecisionError('not_found');
    const f = locked.finding;
    if (f.status !== 'OPEN') throw new VmDecisionError('finding_not_open');
    const bundle = await loadBundle(tenantId, { findingIds: [findingId] }, c);
    const fingerprint = fingerprintOf(f);
    const nowMs = Date.parse(nowIso);
    const waiting = buildViews(bundle, new Map([[f.id, f]]), nowMs).some((v) => v.state === 'PENDING');
    if (waiting) throw new VmDecisionError('decision_pending');
    const role = who.role ?? 'VIEWER';
    const base = {
      tenantId,
      findingId,
      assetId: f.assetId,
      vulnId: f.vulnId,
      kind: value.kind,
      justification: value.justification,
      justificationSha256: sha256(value.justification),
      packageFingerprint: fingerprint,
      findingFirstSeenAt: f.firstSeenAt,
      requestedBy: actor,
      requestedByUserId: userId,
      requestedByRole: role,
      requestedAt: nowIso,
      expiresAt: value.expiresAt,
    };
    let stored: StoredDecision;
    if (isMemory()) {
      stored = { id: crypto.randomUUID(), ...base };
      memoryDecisions.push(stored);
    } else {
      const res = await need(c).query(
        `INSERT INTO vm_finding_decisions (tenant_id, finding_id, asset_id, vuln_id, kind, justification, justification_sha256, package_fingerprint,
                                          finding_first_seen_at, requested_by, requested_by_user_id, requested_by_role, requested_at, expires_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::timestamptz, $10::text, $11::text, $12::text, $13::timestamptz, $14::timestamptz)
         RETURNING *`,
        [tenantId, findingId, base.assetId, base.vulnId, base.kind, base.justification, base.justificationSha256, base.packageFingerprint, base.findingFirstSeenAt, actor, userId, role, nowIso, base.expiresAt],
      );
      stored = rowToDecision(res.rows[0]);
    }
    return { decision: stored, events: [], state: 'PENDING', approvedBy: null, approvedAt: null, assetName: null, currentFingerprint: fingerprint };
  });
}

export type DecisionResolution = 'approve' | 'reject' | 'withdraw' | 'revoke';

const ACTION_OF: Record<DecisionResolution, VmDecisionAction> = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn', revoke: 'revoked' };

/**
 * Approves, rejects, withdraws or revokes one decision. Approve needs owner-level access and a person other than the requester; reject and
 * revoke need owner-level access; withdraw is the requester's alone. Throws VmDecisionError: not_found, owner_required, self_approval_forbidden,
 * not_requester, decision_not_pending, decision_expired (an unresolved request past its expiry), decision_not_active (revoke needs an ACTIVE decision).
 * The partial unique indexes close the race between two people acting at the same moment.
 */
export async function resolveDecision(tenantId: string, decisionId: string, action: DecisionResolution, who: DecisionActor, nowIso: string): Promise<DecisionView> {
  const actor = who.name.slice(0, ACTOR_MAX);
  const userId = who.userId.slice(0, USER_ID_MAX);
  return withVmTenantTx(tenantId, async (c) => {
    if (!isMemory()) {
      const lock = await need(c).query('SELECT id FROM vm_finding_decisions WHERE tenant_id = $1::text AND id = $2::text FOR UPDATE', [tenantId, decisionId]);
      if (!lock.rows[0]) throw new VmDecisionError('not_found');
    }
    const [view] = await viewsFor(tenantId, nowIso, { decisionId }, c);
    if (!view) throw new VmDecisionError('not_found');
    const d = view.decision;
    if (action === 'approve') {
      const verdict = canApprove({ userId, role: who.role }, d.requestedByUserId);
      if (verdict === 'role') throw new VmDecisionError('owner_required');
      if (verdict === 'self') throw new VmDecisionError('self_approval_forbidden');
    } else if (action === 'withdraw') {
      if (userId !== d.requestedByUserId) throw new VmDecisionError('not_requester');
    } else if (!isOwnerLevel(who.role)) {
      throw new VmDecisionError('owner_required');
    }
    if (action === 'revoke') {
      if (view.state !== 'ACTIVE') throw new VmDecisionError('decision_not_active');
    } else {
      if (view.events.some((e) => e.action === 'approved' || e.action === 'rejected' || e.action === 'withdrawn')) throw new VmDecisionError('decision_not_pending');
      if (!(Date.parse(d.expiresAt) > Date.parse(nowIso))) throw new VmDecisionError('decision_expired');
    }
    const event: StoredDecisionEvent = {
      id: crypto.randomUUID(),
      tenantId,
      decisionId,
      action: ACTION_OF[action],
      actor,
      actorUserId: userId,
      actorRole: who.role ?? 'VIEWER',
      createdAt: nowIso,
    };
    if (isMemory()) {
      // The same rule as the partial unique indexes; no await between this check and the push.
      const clash = memoryDecisionEvents.some(
        (e) => e.tenantId === tenantId && e.decisionId === decisionId && (action === 'revoke' ? e.action === 'revoked' : e.action !== 'revoked'),
      );
      if (clash) throw new VmDecisionError(action === 'revoke' ? 'decision_not_active' : 'decision_not_pending');
      memoryDecisionEvents.push(event);
    } else {
      try {
        await need(c).query(
          `INSERT INTO vm_finding_decision_events (tenant_id, decision_id, action, actor, actor_user_id, actor_role, created_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz)`,
          [tenantId, decisionId, event.action, actor, userId, event.actorRole, nowIso],
        );
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') throw new VmDecisionError(action === 'revoke' ? 'decision_not_active' : 'decision_not_pending');
        throw err;
      }
    }
    const [after] = await viewsFor(tenantId, nowIso, { decisionId }, c);
    return after ?? view;
  });
}

/** Fills `assetName` of the views (the host name of each decision's asset). */
export async function nameDecisionAssets(tenantId: string, views: DecisionView[]): Promise<void> {
  if (views.length === 0) return;
  const names = new Map((await listAssets(tenantId)).map((a) => [a.id, a.hostName]));
  for (const v of views) v.assetName = names.get(v.decision.assetId) ?? null;
}

export type DecisionListFilter = 'pending' | 'active' | 'expiring' | 'all';

/**
 * The tenant's decisions with their states at `nowIso`, newest request first, at most `limit`. `findingId` narrows to one finding. `state`:
 * pending (PENDING), active (ACTIVE), expiring (ACTIVE and expiring within 30 days), all. The host names are looked up here.
 */
export async function listDecisionStates(
  tenantId: string,
  nowIso: string,
  opts: { state?: DecisionListFilter; findingId?: string; limit?: number } = {},
): Promise<DecisionView[]> {
  const nowMs = Date.parse(nowIso);
  const views = await withVmTenantTx(tenantId, (c) => viewsFor(tenantId, nowIso, opts.findingId ? { findingIds: [opts.findingId] } : {}, c));
  const state = opts.state ?? 'all';
  const kept = views.filter((v) => {
    if (state === 'pending') return v.state === 'PENDING';
    if (state === 'active') return v.state === 'ACTIVE';
    if (state === 'expiring') return v.state === 'ACTIVE' && Date.parse(v.decision.expiresAt) - nowMs <= 30 * 86_400_000;
    return true;
  });
  const limited = kept.slice(0, opts.limit ?? 500);
  await nameDecisionAssets(tenantId, limited);
  return limited;
}

/** The effective decision (approved, unexpired, not revoked, not lapsed) of each of the given findings, by finding id. */
export async function loadEffectiveDecisions(tenantId: string, findingIds: string[], nowIso: string, client?: Client): Promise<Map<string, VmEffectiveDecision>> {
  const out = new Map<string, VmEffectiveDecision>();
  if (findingIds.length === 0) return out;
  const views = await inTx(tenantId, client, (c) => viewsFor(tenantId, nowIso, { findingIds }, c));
  return effectiveOf(views, nowIso, out);
}

function effectiveOf(views: DecisionView[], nowIso: string, out: Map<string, VmEffectiveDecision>): Map<string, VmEffectiveDecision> {
  const byFinding = new Map<string, DecisionView[]>();
  for (const v of views) {
    const list = byFinding.get(v.decision.findingId);
    if (list) list.push(v);
    else byFinding.set(v.decision.findingId, [v]);
  }
  for (const [findingId, list] of byFinding) {
    const eventsById: Record<string, StoredDecisionEvent[]> = {};
    for (const v of list) eventsById[v.decision.id] = v.events;
    const best = effectiveDecision(list.map((v) => v.decision), eventsById, list[0].currentFingerprint, Date.parse(nowIso));
    if (best) out.set(findingId, best);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tiers for the routes and the snapshot

/** The policy and the decision reader the tier-aware store functions need (a null client opens its own transaction on PostgreSQL). */
export async function loadTierRules(tenantId: string, nowIso: string): Promise<VmTierRules> {
  const policy = await loadRemediationPolicy(tenantId);
  return { policy, decisionsFor: (ids, client) => loadEffectiveDecisions(tenantId, ids, nowIso, client ?? undefined) };
}

/** GET /vm/findings rows with `kev` and `remediation`, from the tenant's policy and decisions. */
export async function withRemediation(tenantId: string, findings: VmFinding[], nowIso: string): Promise<Array<VmFinding & { kev: boolean; remediation: VmTierResult }>> {
  if (findings.length === 0) return [];
  const policy = await loadRemediationPolicy(tenantId);
  const kev = await loadKevFlags(tenantId, findings.map((f) => f.vulnId));
  const decisions = await loadEffectiveDecisions(tenantId, findings.map((f) => f.id), nowIso);
  const nowMs = Date.parse(nowIso);
  return findings.map((f) => {
    const isKev = kev.has(f.vulnId);
    return { ...f, kev: isKev, remediation: tierOf(f, isKev, policy, decisions.get(f.id) ?? null, nowMs) };
  });
}

async function tallyOf(tenantId: string, policy: VmRemediationPolicy, nowIso: string, c: Client): Promise<VmTierTally> {
  const rows = await listTierFindings(tenantId, c);
  const decisions = await loadEffectiveDecisions(tenantId, rows.map((r) => r.finding.id), nowIso, c);
  const nowMs = Date.parse(nowIso);
  const results = rows.map((r) => tierOf(r.finding, r.kev, policy, decisions.get(r.finding.id) ?? null, nowMs));
  return tallyTiers(results, rows.map((r) => r.finding.severity as VmSeverity));
}

export interface RemediationSummary {
  policy: VmRemediationPolicy;
  tally: VmTierTally;
  pendingDecisions: number;
  expiringSoon: Array<{ view: DecisionView }>;
}

/** The tier counts of the tenant's findings, the waiting requests and the decisions expiring within 30 days, in one transaction. */
export async function summarizeRemediation(tenantId: string, nowIso: string): Promise<RemediationSummary> {
  const summary = await withVmTenantTx(tenantId, async (c) => {
    const policy = await loadRemediationPolicy(tenantId, c);
    const tally = await tallyOf(tenantId, policy, nowIso, c);
    const views = await viewsFor(tenantId, nowIso, {}, c);
    return { policy, tally, views };
  });
  const nowMs = Date.parse(nowIso);
  const pendingDecisions = summary.views.filter((v) => v.state === 'PENDING').length;
  const soon = summary.views.filter((v) => v.state === 'ACTIVE' && Date.parse(v.decision.expiresAt) - nowMs <= 30 * 86_400_000).sort((a, b) => (a.decision.expiresAt < b.decision.expiresAt ? -1 : 1));
  await nameDecisionAssets(tenantId, soon);
  return { policy: summary.policy, tally: summary.tally, pendingDecisions, expiringSoon: soon.map((view) => ({ view })) };
}

/** The effective decisions of every open finding, by finding id (the snapshot input). */
export async function loadTenantEffectiveDecisions(tenantId: string, nowIso: string, client?: Client): Promise<{ decisions: Map<string, VmEffectiveDecision>; pending: number }> {
  const views = await inTx(tenantId, client, (c) => viewsFor(tenantId, nowIso, {}, c));
  return { decisions: effectiveOf(views, nowIso, new Map()), pending: views.filter((v) => v.state === 'PENDING').length };
}
