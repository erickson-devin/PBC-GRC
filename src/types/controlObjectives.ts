/**
 * Assessment-objective records (NIST SP 800-171A / 800-53A): the status, narrative and evidence links a program holds for one objective
 * of a control (`AC.L2-3.1.3[a]`, `AC-2[a01]`). The narrative may contain CUI, so the history (control_objective_events) records only
 * its SHA-256 and length, never the text. server/schema.ts interpolates OBJECTIVE_STATUSES and OBJECTIVE_CHANGE_SOURCES into the CHECKs.
 * Timestamps are ISO strings.
 */

/** The same statuses an objective has in the assessment model (src/types/assessment.ts). */
export const OBJECTIVE_STATUSES = ['MET', 'NOT_MET', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_APPLICABLE'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** Append-only: the CHECK on control_objective_events.source is re-created from this list on every boot. */
export const OBJECTIVE_CHANGE_SOURCES = ['human', 'browser-import', 'clone'] as const;
export type ObjectiveChangeSource = (typeof OBJECTIVE_CHANGE_SOURCES)[number];

export const MAX_OBJECTIVE_NARRATIVE_LENGTH = 20000;
export const MAX_OBJECTIVE_EVIDENCE_LINKS = 50;
/** Objectives per bulk write, and per browser import. */
export const MAX_OBJECTIVE_BULK = 500;
export const MAX_OBJECTIVE_IMPORT = 5000;

/** What a client sends for one objective: a field left out keeps its stored value, an empty narrative clears it. */
export interface ObjectiveInput {
  objectiveId: string;
  controlId: string;
  status?: ObjectiveStatus;
  narrative?: string;
  linkedEvidenceIds?: string[];
}

export interface ObjectiveRecord {
  objectiveId: string;
  controlId: string;
  status: ObjectiveStatus;
  narrative: string;
  linkedEvidenceIds: string[];
  updatedBy: string;
  updatedAt: string | null;
}

export type ObjectiveImportResult = 'created' | 'unchanged' | 'conflict';

export interface ObjectiveEvent {
  id: string;
  tenantId: string;
  programId: string;
  controlId: string;
  objectiveId: string;
  source: ObjectiveChangeSource;
  actor: string;
  actorUserId: string | null;
  oldStatus: string | null;
  newStatus: string;
  narrativeChanged: boolean;
  oldNarrativeSha256: string | null;
  newNarrativeSha256: string;
  oldNarrativeLength: number | null;
  newNarrativeLength: number;
  evidenceChanged: boolean;
  createdAt: string;
}

const OBJECTIVE_ID_PATTERN = /^([A-Za-z0-9.()_-]{1,64})\[[a-z0-9]{1,16}\]$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const isObjectiveStatus = (value: unknown): value is ObjectiveStatus =>
  typeof value === 'string' && (OBJECTIVE_STATUSES as readonly string[]).includes(value);

/** The control part of an objective id (`AC.L2-3.1.3[a]` -> `AC.L2-3.1.3`), or null when the id is malformed. */
export function controlIdOfObjective(objectiveId: unknown): string | null {
  if (typeof objectiveId !== 'string') return null;
  const m = OBJECTIVE_ID_PATTERN.exec(objectiveId);
  return m ? m[1] : null;
}

/** A readable reason when the id is malformed or does not belong to `controlId`; null when it is valid. Never echoes request text. */
export function validateObjectiveId(objectiveId: unknown, controlId: unknown): string | null {
  const own = controlIdOfObjective(objectiveId);
  if (own === null) return 'objectiveId must look like CONTROL-ID[a] (letters, digits and . ( ) _ - then a bracketed lowercase letter or number)';
  if (typeof controlId !== 'string' || controlId === '') return 'controlId is required';
  if (own !== controlId) return 'objectiveId does not belong to controlId';
  return null;
}

/** A readable reason when one objective input is invalid; null when it is valid. Never echoes request text. */
export function validateObjectiveInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'each objective must be an object';
  const o = input as Record<string, unknown>;
  const idProblem = validateObjectiveId(o.objectiveId, o.controlId);
  if (idProblem) return idProblem;
  if (o.status !== undefined && !isObjectiveStatus(o.status)) return `status must be one of: ${OBJECTIVE_STATUSES.join(', ')}`;
  if (o.narrative !== undefined) {
    if (typeof o.narrative !== 'string') return 'narrative must be text';
    if (o.narrative.length > MAX_OBJECTIVE_NARRATIVE_LENGTH) return `narrative is longer than ${MAX_OBJECTIVE_NARRATIVE_LENGTH} characters`;
  }
  if (o.linkedEvidenceIds !== undefined) {
    if (!Array.isArray(o.linkedEvidenceIds)) return 'linkedEvidenceIds must be a list';
    if (o.linkedEvidenceIds.length > MAX_OBJECTIVE_EVIDENCE_LINKS) return `linkedEvidenceIds holds more than ${MAX_OBJECTIVE_EVIDENCE_LINKS} items`;
    if (!o.linkedEvidenceIds.every((e) => typeof e === 'string' && EVIDENCE_ID_PATTERN.test(e))) return 'linkedEvidenceIds holds an invalid evidence id';
  }
  return null;
}
