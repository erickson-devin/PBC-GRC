/**
 * Client side of the server-held assessment objectives (SP 800-171A / 800-53A): which cached objectives still have to move to the
 * server, what the import answered, how the server's records are merged into the state on screen, and how a conflict is resolved.
 * Pure functions: no storage, no network, no React. The narrative may contain CUI, so nothing here ever logs one.
 */
import type { AssessmentState } from '../types/cmmc';
import type { AssessmentObjective, ObjectiveStatus } from '../types/assessment';
import {
  MAX_OBJECTIVE_EVIDENCE_LINKS,
  controlIdOfObjective,
  isObjectiveStatus,
  validateObjectiveInput,
  type ObjectiveImportResult,
  type ObjectiveInput,
  type ObjectiveRecord,
} from '../types/controlObjectives';
import { FAR_L1_TO_800_171_MAP, NIST_800_171A_REGISTRY, normalizeControlNumber } from './frameworks/assessmentObjectives';
import { getCascadedObjectiveNarrative } from './frameworks/policyCompiler';
import type { EnclaveStackProfile } from '../types/tenant';

/** The message a user who cannot write sees while this browser still holds narratives the server does not have. */
export const OBJECTIVES_NEED_OWNER_MESSAGE =
  'This browser holds objective narratives that are not on the server yet. Ask a tenant owner to open this organization in this browser to move them.';

/** Splits a list into runs of at most `size` (the server accepts 500 per bulk write and 5000 per import). */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface UploadSelection {
  /** What goes to the server. */
  items: ObjectiveInput[];
  /** Cached objectives with a narrative the server would refuse (malformed id, narrative too long): kept in the cache and put under review. */
  unsendable: string[];
  /** Entries that are dropped without an upload (a control no framework knows: nothing to attach them to, or nothing in them but defaults). */
  skipped: number;
}

/**
 * The cached objectives worth uploading: a narrative, a status other than NOT_STARTED, or evidence links. An untouched
 * NOT_STARTED entry with no text is the catalog default and never goes. `isKnownControl` (optional) drops entries whose control is
 * unknown (for example the orphaned `3.1.1[a]` keys an older stack cascade wrote).
 */
export function objectivesToUpload(
  objectives: Record<string, AssessmentObjective> | undefined,
  isKnownControl?: (controlId: string) => boolean
): UploadSelection {
  const items: ObjectiveInput[] = [];
  const unsendable: string[] = [];
  let skipped = 0;
  for (const [id, o] of Object.entries(objectives ?? {})) {
    if (!o || typeof o !== 'object') continue;
    const narrative = typeof o.implementationNarrative === 'string' ? o.implementationNarrative : '';
    const links = Array.isArray(o.linkedEvidenceIds) ? o.linkedEvidenceIds.filter((e) => typeof e === 'string') : [];
    const status: ObjectiveStatus = isObjectiveStatus(o.status) ? o.status : 'NOT_STARTED';
    if (narrative.trim() === '' && status === 'NOT_STARTED' && links.length === 0) continue;
    const controlId = controlIdOfObjective(id);
    if (controlId !== null && isKnownControl && !isKnownControl(controlId)) {
      skipped++;
      continue;
    }
    const input: ObjectiveInput = {
      objectiveId: id,
      controlId: controlId ?? '',
      status,
      narrative,
      linkedEvidenceIds: links.slice(0, MAX_OBJECTIVE_EVIDENCE_LINKS),
    };
    if (validateObjectiveInput(input) !== null) {
      if (narrative.trim() !== '') unsendable.push(id);
      else skipped++;
      continue;
    }
    items.push(input);
  }
  return { items, unsendable, skipped };
}

/** Only a narrative conflict is worth a human's time: a non-empty cached text that differs from the server's (a missing server record counts as a difference). */
export function needsNarrativeReview(cachedNarrative: string | undefined, serverRecord: ObjectiveRecord | undefined): boolean {
  const cached = cachedNarrative ?? '';
  if (cached.trim() === '') return false;
  return !serverRecord || serverRecord.narrative !== cached;
}

/** The review ids that still need a decision: drops those whose cached narrative is empty or equal to the server's (self-healing for older caches). */
export function pruneResolvedReviews(state: AssessmentState, server: Record<string, ObjectiveRecord>): AssessmentState {
  const pending = state.objectivesPendingReview ?? [];
  if (pending.length === 0) return state;
  const keep = pending.filter((id) => needsNarrativeReview(state.objectives?.[id]?.implementationNarrative, server[id]));
  if (keep.length === pending.length) return state;
  const objectives = { ...(state.objectives ?? {}) };
  for (const id of pending) {
    if (!keep.includes(id) && objectives[id]) objectives[id] = { ...objectives[id], implementationNarrative: '' };
  }
  const next: AssessmentState = { ...state, objectives };
  if (keep.length > 0) next.objectivesPendingReview = keep;
  else delete next.objectivesPendingReview;
  return next;
}

/**
 * The state after an upload that finished: ids the server created or already held identically lose their cached narrative (the
 * server's copy is shown), conflicts (and `unsendable` ids) go under review with their cached narrative kept, and the marker is set.
 * Never mutates its input.
 */
export function applyImportResult(
  state: AssessmentState,
  results: readonly { objectiveId: string; result: ObjectiveImportResult }[],
  now: string,
  unsendable: readonly string[] = [],
  server?: Record<string, ObjectiveRecord>
): AssessmentState {
  const objectives = { ...(state.objectives ?? {}) };
  const pending = new Set<string>(state.objectivesPendingReview ?? []);
  for (const r of results) {
    const cached = objectives[r.objectiveId];
    if (r.result === 'conflict' && needsNarrativeReview(cached?.implementationNarrative, server?.[r.objectiveId])) {
      pending.add(r.objectiveId);
    } else if (cached) {
      // created / unchanged, or a conflict that is not about the narrative text: the server is authoritative (status and evidence
      // links are not CUI), so the cached narrative goes and the server's values are merged
      objectives[r.objectiveId] = { ...cached, implementationNarrative: '' };
    }
  }
  for (const id of unsendable) pending.add(id);
  const next: AssessmentState = { ...state, objectives, objectivesMigratedAt: now };
  if (pending.size > 0) next.objectivesPendingReview = [...pending];
  else delete next.objectivesPendingReview;
  return next;
}

export interface MergeOptions {
  /** The catalog objective for an id the cache does not hold yet (text, template, letter): the server's record is laid over it. */
  seedFor?: (objectiveId: string, controlId: string) => AssessmentObjective | undefined;
  /** Ids under review: their cached narrative stays (the user decides which text wins). */
  pending?: readonly string[];
}

/**
 * Lays the server's records over the cached objectives: the server is authoritative for the status, narrative and evidence links of
 * every id it returns, except the narrative of an id under review. Objectives the server does not return stay as they are. Never
 * mutates its input.
 */
export function mergeServerObjectives(
  cached: Record<string, AssessmentObjective> | undefined,
  server: Record<string, ObjectiveRecord>,
  options: MergeOptions = {}
): Record<string, AssessmentObjective> {
  const pending = new Set<string>(options.pending ?? []);
  const out: Record<string, AssessmentObjective> = { ...(cached ?? {}) };
  for (const [id, rec] of Object.entries(server)) {
    const letter = /\[([a-z0-9]+)\]$/i.exec(id)?.[1] ?? 'a';
    const base: AssessmentObjective =
      out[id] ??
      options.seedFor?.(id, rec.controlId) ?? {
        id,
        controlId: rec.controlId,
        letter,
        text: 'Objective determination',
        status: rec.status,
        prefilledTemplate: '',
        implementationNarrative: '',
        linkedEvidenceIds: [],
        isAutoVerifiedByTelemetry: false,
      };
    out[id] = {
      ...base,
      status: rec.status,
      implementationNarrative: pending.has(id) ? base.implementationNarrative ?? '' : rec.narrative,
      linkedEvidenceIds: [...rec.linkedEvidenceIds],
      lastUpdated: rec.updatedAt ?? base.lastUpdated,
      updatedBy: rec.updatedBy || base.updatedBy,
    };
  }
  return out;
}

export type ReconcileOutcome =
  /** The marker was already set: the server's records were merged. */
  | 'merged'
  /** Nothing to upload: the marker was set together with the first merge. */
  | 'marked'
  /** Cached narratives (or status / evidence) are not on the server and the user can write: upload them first; nothing was merged. */
  | 'upload'
  /** They are not on the server and the user cannot write: leave the cache alone and tell the user to ask an owner. */
  | 'blocked';

export interface ReconcileOptions extends MergeOptions {
  canWrite: boolean;
  now: string;
  isKnownControl?: (controlId: string) => boolean;
}

/**
 * Decides what happens when the live objectives of exactly the scope on screen have loaded. The server's narratives are merged into the
 * state only when the marker is set, or is set in the same step because there is nothing to upload: until then the cache is the only
 * copy of the cached narratives, and saveAssessment (which strips narratives only once the marker is set) would otherwise store the
 * server's narratives in this browser too, and the upload would send them back.
 */
export function reconcileObjectives(
  state: AssessmentState,
  live: Record<string, ObjectiveRecord>,
  options: ReconcileOptions
): { state: AssessmentState; outcome: ReconcileOutcome } {
  const merge = (s: AssessmentState): AssessmentState => ({
    ...s,
    objectives: mergeServerObjectives(s.objectives, live, { seedFor: options.seedFor, pending: s.objectivesPendingReview }),
  });
  if (state.objectivesMigratedAt) return { state: merge(state), outcome: 'merged' };
  const sel = objectivesToUpload(state.objectives, options.isKnownControl);
  if (sel.items.length === 0 && sel.unsendable.length === 0) {
    return { state: merge({ ...state, objectivesMigratedAt: options.now }), outcome: 'marked' };
  }
  return { state, outcome: options.canWrite ? 'upload' : 'blocked' };
}

/**
 * The user's answer for one conflicting objective: "browser" keeps the cached text (the caller has saved it to the server first),
 * "server" takes the server's. Either way the id leaves the review list, so the next save of the cache strips its narrative.
 */
export function resolveConflict(
  state: AssessmentState,
  objectiveId: string,
  choice: 'browser' | 'server',
  serverNarrative: string
): AssessmentState {
  const objectives = { ...(state.objectives ?? {}) };
  const current = objectives[objectiveId];
  if (current && choice === 'server') objectives[objectiveId] = { ...current, implementationNarrative: serverNarrative };
  const next: AssessmentState = { ...state, objectives };
  const pending = (state.objectivesPendingReview ?? []).filter((id) => id !== objectiveId);
  if (pending.length > 0) next.objectivesPendingReview = pending;
  else delete next.objectivesPendingReview;
  return next;
}

/**
 * The tech-stack cascade: a generated narrative for each objective of the given controls, only where the current narrative is empty
 * (a user's text is never overwritten). Only objective ids of `controlIds` are produced, so nothing lands outside the framework.
 */
export function cascadeFill(
  controlIds: readonly string[],
  lettersFor: (controlId: string) => string[],
  currentNarrative: (objectiveId: string) => string,
  narrativeFor: (controlId: string, letter: string) => string
): ObjectiveInput[] {
  const out: ObjectiveInput[] = [];
  const seen = new Set<string>();
  for (const controlId of controlIds) {
    for (const letter of lettersFor(controlId)) {
      const objectiveId = `${controlId}[${letter}]`;
      if (seen.has(objectiveId)) continue;
      seen.add(objectiveId);
      if (currentNarrative(objectiveId).trim() !== '') continue;
      const narrative = narrativeFor(controlId, letter);
      if (narrative.trim() === '') continue;
      out.push({ objectiveId, controlId, narrative });
    }
  }
  return out;
}

/** The determination letters the SP 800-171A registry holds for a framework control id (the same lookup the objective checklist uses); [] when it has none. */
export function registryLettersForControl(controlId: string): string[] {
  const trimmed = controlId.trim();
  const normNum = normalizeControlNumber(trimmed);
  const mappedKey = FAR_L1_TO_800_171_MAP[trimmed.toLowerCase()] || FAR_L1_TO_800_171_MAP[normNum.toLowerCase()];
  const registered =
    (mappedKey ? NIST_800_171A_REGISTRY[mappedKey] : undefined) ||
    NIST_800_171A_REGISTRY[trimmed] ||
    NIST_800_171A_REGISTRY[trimmed.toUpperCase()] ||
    NIST_800_171A_REGISTRY[normNum];
  return registered ? registered.objectives.map((o) => o.letter) : [];
}

/** The cascade for a stack profile over the given framework controls: generated text for the objectives whose narrative is empty. */
export function stackCascadeFill(
  controlIds: readonly string[],
  profile: EnclaveStackProfile,
  currentNarrative: (objectiveId: string) => string
): ObjectiveInput[] {
  return cascadeFill(controlIds, registryLettersForControl, currentNarrative, (controlId, letter) =>
    getCascadedObjectiveNarrative(controlId, letter, profile)
  );
}

/** Window event the tenant context raises for a browser-only tenant; the assessment context applies it to its own state. */
export const OBJECTIVE_CASCADE_EVENT = 'pbc:objective-cascade';
export interface ObjectiveCascadeDetail {
  scope: string;
  profile: EnclaveStackProfile;
}
