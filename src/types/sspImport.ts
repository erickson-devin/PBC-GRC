/**
 * SSP import: shared types.
 *
 * An uploaded System Security Plan is extracted to text, split into sections, and mapped to the controls of ONE
 * requested framework. The result is only ever written to the staging tables (ssp_import_jobs, staged_controls);
 * the live control answers (control_assessments) change only through an explicit, reviewed commit.
 */

/** The frameworks a document can be mapped to: the CMMC levels (NIST SP 800-171) and NIST SP 800-53 Rev. 5. */
export const SSP_IMPORT_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] as const;
export type SspImportFramework = (typeof SSP_IMPORT_FRAMEWORKS)[number];
export const isSspImportFramework = (v: unknown): v is SspImportFramework =>
  typeof v === 'string' && (SSP_IMPORT_FRAMEWORKS as readonly string[]).includes(v);

/** NIST SP 800-53B baseline a 800-53 import is measured against (its coverage report); matching itself spans the whole catalog. */
export const SSP_BASELINES = ['LOW', 'MODERATE', 'HIGH'] as const;
export type SspBaseline = (typeof SSP_BASELINES)[number];
export const isSspBaseline = (v: unknown): v is SspBaseline => typeof v === 'string' && (SSP_BASELINES as readonly string[]).includes(v);
export const SSP_DEFAULT_BASELINE: SspBaseline = 'MODERATE';

export type SspDocumentKind = 'pdf' | 'docx';

export type SspJobStatus = 'QUEUED' | 'EXTRACTING' | 'ANALYZING' | 'READY_FOR_REVIEW' | 'COMMITTED' | 'FAILED' | 'CANCELLED';
export const SSP_JOB_TERMINAL: readonly SspJobStatus[] = ['READY_FOR_REVIEW', 'COMMITTED', 'FAILED', 'CANCELLED'];

/** How a document is analysed: by rules alone (identifiers), or by a local language model as well. */
export type SspAnalysisMode = 'rules' | 'ai';
/** Where a suggestion came from. AI suggestions are only ever kept if their quotes were verified against the document. */
export type SspSuggestionOrigin = 'RULES' | 'AI';

export type SspReviewState = 'PENDING' | 'ACCEPTED' | 'EDITED' | 'REJECTED' | 'COMMITTED' | 'CONFLICT';
/** States a reviewer may set. COMMITTED and CONFLICT are set by the commit step only. */
export const SSP_SETTABLE_STATES: readonly SspReviewState[] = ['PENDING', 'ACCEPTED', 'EDITED', 'REJECTED'];

/** How a control was found in the document. */
export type SspMatchKind =
  | 'CMMC_ID_SECTION' // a section headed by the CMMC identifier (AC.L2-3.1.1): the strongest signal
  | 'NIST_NUMBER_SECTION' // a section that starts with the NIST SP 800-171 number (3.1.1): could be the document's own numbering
  | 'NIST53_ID_SECTION' // a section headed by the NIST SP 800-53 identifier (AC-2, AC-2(1)): explicit, like a CMMC identifier
  | 'MENTION' // referred to inside another section; no section of its own
  | 'AI_EXTRACTED'; // a language model read a section and found the control implemented there; the quote was verified

export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

export interface ExtractedDocument {
  text: string;
  /** Character ranges of each page (PDF); empty for DOCX, which has no fixed pages. */
  pages: PageSpan[];
  pageCount: number;
}

export interface DocChunk {
  index: number;
  /** Offsets into the extracted text. */
  start: number;
  end: number;
  /** First line of the section (its heading), trimmed. */
  heading: string;
  /** 1-based page the section starts on (PDF), or null. */
  page: number | null;
  text: string;
}

export interface SourceQuote {
  quote: string;
  page: number | null;
  start: number;
  end: number;
  /** True when `quote` is exactly text[start..end] of the extracted document. */
  verified: boolean;
}

export interface GapItem {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  /** The NIST SP 800-171A / 800-53A objective this concerns (a, b, c...), when it concerns one. */
  objective?: string;
  missingElement: string;
  recommendation: string;
}

/**
 * How the document stands against one NIST SP 800-171A assessment objective.
 *  ADDRESSED     the document says how the objective is met, and the passage cited was verified
 *  PARTIAL       only part of it
 *  NOT_ADDRESSED nothing in the document speaks to it
 *  UNSUPPORTED   the model said it was addressed but could not point to a passage that exists in the document
 *  NOT_ASSESSED  the model gave no answer for it
 */
export type ObjectiveStatus = 'ADDRESSED' | 'PARTIAL' | 'NOT_ADDRESSED' | 'UNSUPPORTED' | 'NOT_ASSESSED';

export interface ObjectiveAssessment {
  letter: string;
  text: string;
  status: ObjectiveStatus;
  /** A passage of the document, verbatim, that supports the status (ADDRESSED / PARTIAL only). */
  evidence?: string;
  /**
   * AI extractive analysis only: the sentence was found but shares fewer than two distinctive words with the objective, so
   * the semantic match is weak. The sentence is kept for the reviewer; the flag tells them to check it.
   */
  weak?: boolean;
}

export interface GapAnalysis {
  /** 'heuristic': simple text checks (rules). 'ai': a language model compared the document with the objectives. */
  source: 'heuristic' | 'ai';
  /** AI only. 'extractive': the model copied supporting sentences and the program wrote the rest; 'narrative': the model wrote the comparison. */
  mode?: 'extractive' | 'narrative';
  summary: string;
  gaps: GapItem[];
  /** Per-objective result of the comparison with NIST SP 800-171A or 800-53A (AI analysis only). */
  objectives?: ObjectiveAssessment[];
}

export interface StagedControlDraft {
  controlId: string;
  framework: SspImportFramework;
  matchKind: SspMatchKind;
  origin: SspSuggestionOrigin;
  sectionHeading: string;
  suggestedNotes: string;
  confidence: number;
  sourceQuotes: SourceQuote[];
  gapAnalysis: GapAnalysis;
}

export interface UnmappedFinding {
  reference: string;
  reason: 'NOT_IN_CATALOG' | 'OUT_OF_SCOPE';
  page: number | null;
  excerpt: string;
}

export interface CoverageReport {
  framework: SspImportFramework;
  /** NIST SP 800-53 only: the baseline the counts below are measured against. */
  baseline?: SspBaseline;
  /** NIST SP 800-53 only: true when the counts include the SP 800-53B privacy baseline (the program has it, issue #20). */
  privacy?: boolean;
  totalControls: number;
  foundControls: number;
  /** In-scope control ids the document never mentions. */
  missing: string[];
}

export interface MappingResult {
  staged: StagedControlDraft[];
  unmapped: UnmappedFinding[];
  coverage: CoverageReport;
}

export interface SspAiStats {
  model: string;
  promptVersion: string;
  sectionsAnalyzed: number;
  sectionsSkipped: number;
  sectionsFailed: number;
  findingsProposed: number;
  findingsGrounded: number;
  /** Why proposed findings were thrown away, by reason (e.g. QUOTE_NOT_FOUND). */
  rejected: Record<string, number>;
  gapAnalyses: number;
  gapAnalysesFailed: number;
  /** How the objectives were assessed: the model copies supporting sentences (small models) or writes the comparison. */
  gapMode?: 'extractive' | 'narrative';
  durationMs: number;
}

export interface SspStageProgress {
  stage?: string;
  chunksTotal?: number;
  chunksDone?: number;
  controlsFound?: number;
  /** Something the reviewer should know, e.g. the AI analysis was skipped. */
  warning?: string;
  ai?: SspAiStats;
}

export interface SspImportJob {
  id: string;
  tenantId: string;
  /** The program the import belongs to; its suggestions are committed only there. Absent on a job written before programs existed. */
  programId?: string;
  createdBy: string;
  createdByUserId: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileSha256: string;
  framework: SspImportFramework;
  /** NIST SP 800-53 imports only. */
  baseline: SspBaseline | null;
  status: SspJobStatus;
  stageProgress: SspStageProgress;
  storedProvider: 'local';
  storedPath: string;
  pageCount: number | null;
  charCount: number | null;
  chunkCount: number | null;
  analyzer: string;
  coverage: CoverageReport | null;
  unmapped: UnmappedFinding[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StagedControl extends StagedControlDraft {
  id: string;
  jobId: string;
  tenantId: string;
  programId?: string;
  /** Hash of the live notes + status when this suggestion was staged; null when the control had no row yet. */
  baseHash: string | null;
  reviewState: SspReviewState;
  editedNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  committedAt: string | null;
}

// ---------------------------------------------------------------------------------------------- API shapes

export interface SspCapabilities {
  analyzer: string;
  /** The local language model can be used for an import right now. */
  ai: boolean;
  aiStatus: { enabled: boolean; available: boolean; model: string; reason?: string };
  maxUploadBytes: number;
  acceptedTypes: string[];
  /** The supported frameworks that are part of this tenant's assessment program. */
  frameworks: SspImportFramework[];
  canUpload: boolean;
  canCommit: boolean;
}

/** A staged suggestion together with the control's current answer. */
export interface StagedControlView extends StagedControl {
  current: { status: string; notes: string; updatedAt: string | null } | null;
  /** The control's answer is not what it was when this suggestion was staged. */
  changedSinceStaged: boolean;
}

export interface SspCommitOutcome {
  committed: string[];
  conflicts: string[];
  job: SspImportJob | null;
}
