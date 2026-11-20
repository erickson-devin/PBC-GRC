import type { POAMMilestone } from '../types/report';
import type { PoamMilestone, PoamMilestoneInput } from '../types/poamMilestone';
import { isValidPoamDate } from './poamDates';

/**
 * #304: the milestones of a POA&M entry, one parser shared by the vulnerability items and the control entries (pure, so the server, the screens
 * and the tests share one definition). An edit replaces the whole list; the server assigns the id of a new milestone, and an id the entry does
 * not hold is refused. An error names the field, never a value (a description can hold CUI).
 */

export const POAM_MILESTONES_MAX = 20;
export const POAM_MILESTONE_DESCRIPTION_MAX = 500;
/** Largest stored list in bytes (the database CHECK pins the same figure). */
export const POAM_MILESTONES_MAX_BYTES = 65536;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Every C0 control character and DEL: a description is one line. */
const LINE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type PoamMilestonesParse = { ok: true; milestones: PoamMilestoneInput[] } | { ok: false };

/**
 * Reads the `milestones` of an edit request: an array of at most POAM_MILESTONES_MAX entries, each { id?, description, targetDate, completed? }.
 * The description is trimmed and must be 1 to POAM_MILESTONE_DESCRIPTION_MAX characters on one line; the target date a valid POA&M date; `completed`
 * a boolean when present (absent means false). Unknown keys are refused. An empty array clears the list.
 */
export function parseMilestonesInput(raw: unknown): PoamMilestonesParse {
  if (!Array.isArray(raw) || raw.length > POAM_MILESTONES_MAX) return { ok: false };
  const out: PoamMilestoneInput[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const m = item as Record<string, unknown>;
    for (const key of Object.keys(m)) {
      if (key !== 'id' && key !== 'description' && key !== 'targetDate' && key !== 'completed') return { ok: false };
    }
    if (m.id !== undefined && m.id !== null && (typeof m.id !== 'string' || !ID_PATTERN.test(m.id))) return { ok: false };
    if (typeof m.description !== 'string') return { ok: false };
    const description = m.description.trim();
    if (description.length < 1 || description.length > POAM_MILESTONE_DESCRIPTION_MAX || LINE_CONTROL_CHARS.test(description)) return { ok: false };
    if (!isValidPoamDate(m.targetDate)) return { ok: false };
    if (m.completed !== undefined && typeof m.completed !== 'boolean') return { ok: false };
    out.push({ ...(typeof m.id === 'string' ? { id: m.id } : {}), description, targetDate: m.targetDate, completed: m.completed === true });
  }
  return { ok: true, milestones: out };
}

/**
 * The list an edit leaves: each input keeps its id when the entry already holds it, a new milestone gets `newId()`. Refuses (ok false) an id that
 * is not among `stored`, an id used twice in one request, and an id the generator hands out twice.
 */
export function resolveMilestones(
  stored: readonly PoamMilestone[],
  input: readonly PoamMilestoneInput[],
  newId: () => string
): { ok: true; milestones: PoamMilestone[] } | { ok: false } {
  const known = new Set(stored.map((m) => m.id));
  const used = new Set<string>();
  const milestones: PoamMilestone[] = [];
  for (const m of input) {
    let id: string;
    if (m.id === undefined || m.id === null) {
      id = newId();
      if (known.has(id) || used.has(id)) return { ok: false };
    } else {
      if (!known.has(m.id) || used.has(m.id)) return { ok: false };
      id = m.id;
    }
    used.add(id);
    milestones.push({ id, description: m.description, targetDate: m.targetDate, completed: m.completed === true });
  }
  return { ok: true, milestones };
}

/** A request named a milestone id the entry does not hold (or used one twice). Carries no text: the route answers 400 with field `milestones`. */
export class PoamMilestoneError extends Error {
  readonly code = 'invalid_milestones';
  constructor() {
    super('invalid milestones');
    this.name = 'PoamMilestoneError';
  }
}

/** A fresh milestone id (the server assigns them): "ms-" and 12 hex characters. */
export const newMilestoneId = (): string => `ms-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** A stored JSON value as a milestone list: well-formed entries only, in order (a defensive read of the column, which the CHECK keeps an array). */
export function normalizeStoredMilestones(raw: unknown): PoamMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: PoamMilestone[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || typeof m.description !== 'string' || typeof m.targetDate !== 'string') continue;
    out.push({ id: m.id, description: m.description, targetDate: m.targetDate, completed: m.completed === true });
  }
  return out;
}

/** The list as one canonical string (fixed key order), what a digest is taken over and what two lists are compared by. */
export function canonicalMilestones(milestones: readonly PoamMilestone[]): string {
  return JSON.stringify(milestones.map((m) => ({ id: m.id, description: m.description, targetDate: m.targetDate, completed: m.completed })));
}

export const sameMilestones = (a: readonly PoamMilestone[], b: readonly PoamMilestone[]): boolean => canonicalMilestones(a) === canonicalMilestones(b);

/** How many milestones there are and how many are completed (what a history event records instead of the text). */
export function milestoneCounts(milestones: readonly PoamMilestone[]): { count: number; completed: number } {
  return { count: milestones.length, completed: milestones.filter((m) => m.completed).length };
}

/** The milestones as the export prints them: ids M1..Mn in list order (the stored id is internal). */
export function toPOAMMilestones(milestones: readonly PoamMilestone[] | undefined): POAMMilestone[] {
  return (milestones ?? []).map((m, i) => ({ id: `M${i + 1}`, description: m.description, targetDate: m.targetDate, completed: m.completed }));
}
