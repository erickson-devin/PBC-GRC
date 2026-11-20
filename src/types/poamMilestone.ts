/**
 * #304: one milestone of a POA&M entry (a control entry or a vulnerability item). The list of an entry is stored as one JSON value and replaced
 * as a whole by an edit; the server assigns the id of a new milestone. The description is user text and may be CUI: it is never logged and never
 * put in a history event (events carry counts and a digest only).
 */
export interface PoamMilestone {
  /** Server-assigned, stable for the life of the milestone. */
  id: string;
  /** One line, 1 to 500 characters. */
  description: string;
  /** Calendar date (YYYY-MM-DD). */
  targetDate: string;
  completed: boolean;
}

/** One milestone of an edit request. `id` is omitted (or null) for a new milestone and is the stored id for an existing one. */
export interface PoamMilestoneInput {
  id?: string | null;
  description: string;
  targetDate: string;
  completed?: boolean;
}
