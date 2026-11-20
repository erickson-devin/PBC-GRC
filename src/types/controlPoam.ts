import type { PoamMilestone, PoamMilestoneInput } from './poamMilestone';

/**
 * #304: what a person records on a control's POA&M entry. The weakness text stays generated from the control; this holds the owner, the scheduled
 * completion, the required resources, the plan and the milestones, one row per control and program. The text may be CUI: it is never logged and
 * never put in a history event (events carry flags, lengths, counts and digests).
 */

export const CONTROL_POAM_OWNER_MAX = 255;
export const CONTROL_POAM_RESOURCES_MAX = 2000;
export const CONTROL_POAM_PLAN_MAX = 4000;

/** One stored entry (GET /api/v1/control-poam). Only controls somebody recorded something for have one. */
export interface ControlPoamRecord {
  controlId: string;
  /** Empty when none is recorded. */
  owner: string;
  /** Calendar date (YYYY-MM-DD) or null. */
  scheduledCompletion: string | null;
  requiredResources: string;
  plan: string;
  milestones: PoamMilestone[];
  createdAt: string;
  /** The version stamp an edit sends back as `expectedUpdatedAt`. */
  updatedAt: string;
  updatedBy: string | null;
}

/** What PATCH /api/v1/control-poam/:controlId may change (the body also carries `expectedUpdatedAt`). An empty text clears it; a null date clears the date. */
export interface ControlPoamPatch {
  owner?: string;
  scheduledCompletion?: string | null;
  requiredResources?: string;
  plan?: string;
  /** Replaces the whole list (a new milestone has no id; an empty list clears it). */
  milestones?: PoamMilestoneInput[];
}

/** One change of a control's POA&M entry (control_poam_events). Never carries the text, a digest or a user id. */
export interface ControlPoamEvent {
  id: string;
  controlId: string;
  actor: string;
  /** The control's status when the change was made (null when the control had no answer yet). */
  controlStatus: string | null;
  oldScheduledCompletion: string | null;
  newScheduledCompletion: string | null;
  ownerChanged: boolean;
  resourcesChanged: boolean;
  planChanged: boolean;
  milestonesChanged: boolean;
  /** After the change; null when the milestones did not change. */
  milestoneCount: number | null;
  milestonesCompleted: number | null;
  createdAt: string;
}
