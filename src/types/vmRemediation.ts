import type { VmRemediationPolicy, VmDecisionState } from '../data/vmRemediation';

/**
 * The API shapes of the vulnerability remediation policy and risk decisions (#268): GET / PUT .../vm/remediation-policy, its events, the
 * summary and the decision routes. Every error the server sends is { error, reason: '<code>' }.
 */

export interface VmRemediationPolicyResponse {
  policy: VmRemediationPolicy;
  source: 'tenant' | 'defaults';
  defaults: VmRemediationPolicy;
  updatedAt: string | null;
  updatedBy: string | null;
  kevRule: string;
  limits: { daysMin: number; daysMax: number; graceMax: number };
}

export interface VmPolicySaveResult {
  policy: VmRemediationPolicy;
  updatedAt: string;
  changed: boolean;
  impact: { openRecomputed: number; gap: number; warning: number };
}

export interface VmPolicyEvent {
  id: string;
  actor: string;
  actorRole: string | null;
  oldPolicy: VmRemediationPolicy | null;
  newPolicy: VmRemediationPolicy;
  openFindingsRecomputed: number;
  createdAt: string;
}

export interface VmRemediationSummary {
  generatedAt: string;
  policy: VmRemediationPolicy;
  counts: { onTrack: number; warning: number; gap: number; accepted: number };
  warningBySeverity: Partial<Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>>;
  gapCritical: number;
  gapHigh: number;
  gapKev: number;
  pendingDecisions?: number;
  expiringSoon?: Array<{
    decisionId: string;
    findingId: string;
    vulnId: string;
    assetId: string;
    assetName: string | null;
    kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE';
    expiresAt: string;
  }>;
}

// risk decisions
export interface VmDecisionEvent {
  action: 'approved' | 'rejected' | 'withdrawn' | 'revoked';
  actor: string;
  actorRole: string;
  createdAt: string;
}

export interface VmDecision {
  id: string;
  kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE';
  state: VmDecisionState;
  /** null for a Viewer (who sees only that a justification exists, and its length). */
  justification: string | null;
  justificationLength: number;
  justificationSha256: string;
  requestedBy: string;
  requestedAt: string;
  /** The caller requested it (the server compares user ids): such a request cannot be approved by the caller. */
  requestedByMe: boolean;
  expiresAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  events: VmDecisionEvent[];
  /** The list routes (and the per-finding route) carry the finding the decision is about. */
  findingId?: string;
  vulnId?: string;
  assetId?: string;
  assetName?: string | null;
}
