import type { ControlStatus } from './cmmc';
import type { R3ChangeType, R3Relation } from '../data/frameworks/nist171r3/types';

/**
 * "Copy from Rev. 2" (#255): copying a CMMC program's content into a NIST SP 800-171 Rev. 3 program. These are the shapes of the pure planner
 * (src/data/frameworkCopy/plan.ts) and of the /api/v1/framework-copy endpoints. Ids, counts and lengths only: never narrative text or file names.
 */

export type { R3ChangeType, R3Relation };

/** What a copy carries. */
export interface FrameworkCopyInclude {
  notes: boolean;
  objectives: boolean;
  evidence: boolean;
  tools: boolean;
  documents: boolean;
}

/** Marker kinds: they match the database pattern ^[A-Z][A-Z_]{0,15}$. */
export type FrameworkCopyKind = 'NOTES' | 'OBJECTIVE' | 'EVIDENCE' | 'TOOL' | 'DOCUMENT';

/** A Rev. 2 control (as stored: "AC.L2-3.1.1") that leads to a Rev. 3 control, with what the Rev. 2 -> Rev. 3 analysis says about it. */
export interface FrameworkCopySourceRef {
  controlId: string;
  relation: R3Relation;
  changeType?: R3ChangeType;
  newOdp?: boolean;
}

/** One concrete thing to copy: which source control / objective / evidence row / tool / document goes to which target control. */
export interface FrameworkCopyOp {
  kind: FrameworkCopyKind;
  targetControlId: string;
  sourceControlId: string;
  /** The idempotency key: the source control id (NOTES), objective id, evidence id, tool id or document id. */
  sourceKey: string;
  relation: R3Relation;
  /** Length of the text that will be copied (NOTES, OBJECTIVE). */
  chars?: number;
  /** Size of the file (EVIDENCE). */
  bytes?: number;
  /** The caller's digest of the source text or file, kept in the marker to spot "changed since copy". */
  sha256?: string;
  /** The source row's updatedAt, part of the plan digest. */
  sourceUpdatedAt?: string | null;
}

export interface FrameworkCopyItem {
  /** The Rev. 3 control. */
  targetControlId: string;
  sources: FrameworkCopySourceRef[];
  notes: { count: number; chars: number };
  objectives: { count: number; chars: number };
  evidence: { count: number; bytes: number; unavailable: number };
  tools: number;
  documents: number;
  /** Pairs of this control already copied by an earlier run (nothing is appended for them). */
  alreadyCopied: number;
  /** Of those, how many have a source whose text changed after it was copied (not re-copied). */
  changedSinceCopy: number;
  /** What will be written, in a fixed order. */
  ops: FrameworkCopyOp[];
}

export interface FrameworkCopyTotals {
  controls: number;
  notes: number;
  objectives: number;
  evidenceFiles: number;
  evidenceBytes: number;
  evidenceUnavailable: number;
  tools: number;
  documents: number;
  alreadyCopied: number;
  changedSinceCopy: number;
  /** More evidence than one copy may carry (COPY_MAX_EVIDENCE_FILES / COPY_MAX_EVIDENCE_BYTES): the server answers 413 copy_too_large. */
  tooLarge: boolean;
}

/** The planner's output. */
export interface FrameworkCopyPlan {
  items: FrameworkCopyItem[];
  /** Active Rev. 3 controls no Rev. 2 requirement leads to: nothing is copied. */
  newInR3: string[];
  /** Rev. 2 controls of the source Rev. 3 withdrew without a successor. */
  notCarried: { r2: string; cmmcId: string }[];
  /** Rev. 2 controls of the source Rev. 3 withdrew and merged into others. */
  mergedInto: { r2: string; cmmcId: string; targets: string[] }[];
  /** Mapping targets that are not in the target catalog (never written). */
  skippedTargets: { controlId: string; targetId: string }[];
  /** Marker keys already present (copied before) and the subset whose source text changed since: part of the digest. */
  copiedKeys: string[];
  changedKeys: string[];
  totals: FrameworkCopyTotals;
}

/** 200 body of POST /framework-copy/preview. */
export interface FrameworkCopyPreview extends FrameworkCopyPlan {
  source: { id: string; name: string; frameworkId: string };
  targetProgramId: string;
  mapping: { sha256: string; provenance: string };
  /** SHA-256 hex of planDigestInput(plan). */
  planDigest: string;
}

export interface FrameworkCopyPreviewBody {
  sourceProgramId: string;
  include?: Partial<FrameworkCopyInclude>;
}

export interface FrameworkCopyCommitBody {
  sourceProgramId: string;
  include?: Partial<FrameworkCopyInclude>;
  planDigest: string;
}

export interface FrameworkCopySummary {
  notesAppended: number;
  objectivesAppended: number;
  evidenceCopied: number;
  evidenceUnavailable: number;
  toolLinksAdded: number;
  toolLinksSkipped: number;
  documentLinksAdded: number;
  documentLinksSkipped: number;
  alreadyCopied: number;
  controls: string[];
  newInR3: number;
  notCarried: number;
  mergedInto: number;
}

/** 200 body of POST /framework-copy/commit. */
export interface FrameworkCopyCommitResult {
  runId: string;
  summary: FrameworkCopySummary;
}

export interface FrameworkCopyRun {
  id: string;
  sourceProgramId: string;
  sourceFramework: string;
  actor: string;
  createdAt: string;
  summary: FrameworkCopySummary;
}

export type R3SuggestedStatus = 'MET' | 'IN_PROGRESS' | 'NOT_MET';
export type R3SuggestionReason = 'any_not_met' | 'all_met_unchanged' | 'all_met_changed' | 'partial';

/** A Rev. 2 source of a Rev. 3 control, with its status in the source program. */
export interface R3StatusSource extends FrameworkCopySourceRef {
  status: ControlStatus;
}

/** One Rev. 3 control that has Rev. 2 sources. `suggested` is null when the rule gives none. Computed on request, never stored. */
export interface R3StatusSuggestion {
  controlId: string;
  suggested: R3SuggestedStatus | null;
  reasonCode: R3SuggestionReason | null;
  sources: R3StatusSource[];
}

/** 200 body of GET /framework-copy/suggestions. */
export interface FrameworkCopySuggestions {
  applies: boolean;
  sourceProgramId: string | null;
  suggestions: R3StatusSuggestion[];
}
