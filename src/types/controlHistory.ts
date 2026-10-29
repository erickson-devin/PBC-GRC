/**
 * Control-assessment history. Every write to a control's status, notes or role records one event. server/schema.ts interpolates
 * CONTROL_CHANGE_SOURCES into the CHECK on control_assessment_events.source. Notes are never stored in an event: only their
 * SHA-256 and length, because they may contain CUI. Timestamps are ISO strings.
 */

/** Append-only: the CHECK on control_assessment_events.source is re-created from this list on every boot. */
export const CONTROL_CHANGE_SOURCES = ['human', 'ssp-commit', 'vm-snapshot', 'clone'] as const;
export type ControlChangeSource = (typeof CONTROL_CHANGE_SOURCES)[number];

export interface ControlAssessmentEvent {
  id: string;
  tenantId: string;
  controlId: string;
  source: ControlChangeSource;
  actor: string;
  actorUserId: string | null;
  oldStatus: string | null;
  newStatus: string;
  oldRole: string | null;
  newRole: string;
  notesChanged: boolean;
  oldNotesSha256: string | null;
  newNotesSha256: string;
  oldNotesLength: number | null;
  newNotesLength: number;
  createdAt: string;
}
