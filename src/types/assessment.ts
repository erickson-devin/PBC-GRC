/**
 * NIST SP 800-171A Objective-Level Evaluation & Assessment Types
 * Event Horizon: Singularity | Pitch Black Cyber CMMC Defense Enclave
 */

export type ObjectiveStatus =
  | 'MET'
  | 'NOT_MET'
  | 'IN_PROGRESS'
  | 'NOT_STARTED'
  | 'NOT_APPLICABLE';

export interface AssessmentObjective {
  /** Unique objective identifier, e.g. 'AC.L2-3.1.1[a]' or '3.1.1[a]' */
  id: string;
  /** Parent control identifier, e.g. 'AC.L2-3.1.1' or '3.1.1' */
  controlId: string;
  /** Objective determination letter, e.g. 'a', 'b', 'c' */
  letter: string;
  /** Determination statement text from NIST SP 800-171A */
  text: string;
  /** Current assessment evaluation status */
  status: ObjectiveStatus;
  /** Default industry best-practice narrative template (e.g. Entra ID, AD, Intune, STIG) */
  prefilledTemplate: string;
  /** User-edited or confirmed implementation narrative */
  implementationNarrative: string;
  /** IDs of linked evidence items from the Evidence Vault */
  linkedEvidenceIds: string[];
  /** Flag indicating whether the objective was verified by automated telemetry / SCAP scans */
  isAutoVerifiedByTelemetry: boolean;
  /** Associated SCAP CCE or benchmark rule ID if auto-verified */
  scapRuleId?: string;
  /** Human-readable explanation of telemetry finding */
  telemetryEvidence?: string;
  /** Organization-Defined Parameters (ODP) defined in this objective/template */
  odpParameters?: OdpParameter[];
  /** Audit timestamp of last update */
  lastUpdated?: string;
  /** Actor who last modified or confirmed this objective */
  updatedBy?: string;
}

export interface OdpParameter {
  id: string;
  label: string;
  defaultValue: string;
  currentValue?: string;
}

export interface ControlObjectiveRollup {
  controlId: string;
  totalObjectives: number;
  metCount: number;
  notMetCount: number;
  inProgressCount: number;
  notStartedCount: number;
  notApplicableCount: number;
  calculatedStatus: 'MET' | 'NOT_MET' | 'IN_PROGRESS' | 'NOT_STARTED';
  isSatisfied: boolean;
}
