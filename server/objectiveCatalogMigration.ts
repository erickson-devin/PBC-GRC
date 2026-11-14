import { writeControlAssessment, type ControlChangeActor } from './controlAssessments';
import { hasLegacyObjectives, runCatalogMigration, type CatalogUpdateObjectiveEvent, type HumanEventMark, type ObjectiveActor } from './controlObjectives';
import type { ProgramScope } from './db';
import { CMMC_OBJECTIVE_CATALOG_REV, cmmcNumberOf } from '../src/data/cmmcGuide/guide';
import { controlStatusAfterCatalogUpdate, objectiveStatusAfterCatalogUpdate } from '../src/data/cmmcGuide/migration';
import type { ControlStatus } from '../src/types/cmmc';
import type { ControlAssessmentEvent } from '../src/types/controlHistory';
import type { CatalogUpdateChanges, CatalogUpdateControlChange, CatalogUpdateObjectiveChange, ObjectiveStatus } from '../src/types/controlObjectives';

/**
 * Brings a program's stored objective answers up to the CMMC Assessment Guide objectives (catalog revision cmmc-ag-2.13), the first time
 * the program is read or written after the upgrade. The same two rules the browser applies to its cached answers (src/data/cmmcGuide/migration.ts):
 *   R: a Met / Not applicable objective whose meaning changed (the old objective at that letter does not say what the guide's does) becomes In progress;
 *   C: a Met control that has objective answers is re-rolled up over the guide's letters, and can only come out lower.
 * Narratives and evidence links are never touched and nothing is deleted. Each changed answer records a 'catalog-update' history event (hashes and
 * lengths only, never text). Rows that do not change are only stamped with the revision, which leaves their updatedAt alone.
 * Archived and non-CMMC programs are skipped. Idempotent and safe under concurrent requests (PostgreSQL: the legacy rows are read FOR UPDATE, so a
 * second caller waits, then finds none). It never throws into a request and never logs a row value: only an SQL state code.
 */

/** The actor the update records its history events under; the catalog-update listing filters on it, so each guide revision has its own. */
export const CATALOG_UPDATE_ACTOR = 'CMMC Assessment Guide v2.13 update';

const sqlState = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

/** The result of one migration, for tests and logs: counts only. */
export interface ObjectiveCatalogMigrationResult {
  objectivesChanged: number;
  controlsChanged: number;
}

/** Applies the update to the program if it needs it. `program` is the request's program (an archived one is left as it is). */
export async function ensureObjectiveCatalogCurrent(
  scope: ProgramScope,
  framework: string | undefined,
  program?: { archivedAt?: string | null } | null
): Promise<ObjectiveCatalogMigrationResult | null> {
  if (framework !== 'CMMC_L1' && framework !== 'CMMC_L2') return null;
  if (program?.archivedAt) return null;
  if (!scope.tenantId || !scope.programId) return null;
  try {
    if (!(await hasLegacyObjectives(scope))) return null;
    return await runCatalogMigration(scope, async (m) => {
      const rows = await m.legacyRows();
      if (!rows.length) return { objectivesChanged: 0, controlsChanged: 0 };
      const objectiveWho: ObjectiveActor = { source: 'catalog-update', actor: CATALOG_UPDATE_ACTOR, userId: null };
      let objectivesChanged = 0;
      for (const row of rows) {
        const to = objectiveStatusAfterCatalogUpdate(row.objectiveId, row.status as ObjectiveStatus, framework);
        if (to === row.status) continue;
        await m.setStatus(row, to, objectiveWho);
        objectivesChanged++;
      }
      await m.stampLegacy();

      // rule C, over every control that had a legacy row, from the stored statuses after rule R
      const controlIds = [...new Set(rows.map((r) => r.controlId).filter((id) => cmmcNumberOf(id) !== null))];
      const post = await m.statusesOf(controlIds);
      const controlWho: ControlChangeActor = { source: 'catalog-update', actor: CATALOG_UPDATE_ACTOR, userId: null };
      let controlsChanged = 0;
      for (const controlId of controlIds) {
        const written = await writeControlAssessment(
          scope,
          controlId,
          (current) => {
            if (!current || current.status !== 'MET') return null;
            const to = controlStatusAfterCatalogUpdate(controlId, current.status as ControlStatus, post, framework);
            return to === current.status ? null : { status: to, notes: null, role: null, updatedBy: CATALOG_UPDATE_ACTOR };
          },
          controlWho,
          m.client
        );
        if (written) controlsChanged++;
      }
      return { objectivesChanged, controlsChanged };
    });
  } catch (err) {
    // the state code only: an error message can carry a row's values, and a narrative may be CUI
    console.error(`[Objective catalog ${CMMC_OBJECTIVE_CATALOG_REV}] The update was not applied (SQL state ${sqlState(err)}); it is retried on the next read.`);
    return null;
  }
}
/**
 * The catalog-update listing from the history events (pure, so it is tested without a server). Ids and statuses only: nothing of an event but
 * its ids, statuses and time is kept. An objective counts as reviewed when a person ('human') wrote to it after the update (`humanAt`: memory mode
 * compares positions in the history, PostgreSQL compares times). `currentById` is the objectives' status now. Each list is sorted by id and cut at `cap`.
 */
export function buildCatalogUpdateChanges(
  objectiveEvents: readonly CatalogUpdateObjectiveEvent[],
  controlEvents: readonly ControlAssessmentEvent[],
  humanAt: ReadonlyMap<string, HumanEventMark>,
  currentById: ReadonlyMap<string, string>,
  cap: number
): Pick<CatalogUpdateChanges, 'objectives' | 'controls' | 'truncated'> {
  // oldest first: the first event of an id has the status from before the update
  const firstObjective = new Map<string, CatalogUpdateObjectiveEvent>();
  for (const e of objectiveEvents) if (!firstObjective.has(e.objectiveId)) firstObjective.set(e.objectiveId, e);
  const firstControl = new Map<string, ControlAssessmentEvent>();
  for (const e of controlEvents) if (!firstControl.has(e.controlId)) firstControl.set(e.controlId, e);
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  const objectives: CatalogUpdateObjectiveChange[] = [...firstObjective.values()]
    .sort((a, b) => byId(a.objectiveId, b.objectiveId))
    .map((e) => {
      const human = humanAt.get(e.objectiveId);
      const reviewed = human !== undefined && (human.seq !== null && e.seq !== null ? human.seq > e.seq : human.at >= e.createdAt);
      return {
        objectiveId: e.objectiveId,
        controlId: e.controlId,
        oldStatus: e.oldStatus,
        newStatus: e.newStatus,
        currentStatus: currentById.get(e.objectiveId) ?? null,
        reviewed,
        changedAt: e.createdAt,
      };
    });
  const controls: CatalogUpdateControlChange[] = [...firstControl.values()]
    .sort((a, b) => byId(a.controlId, b.controlId))
    .map((e) => ({ controlId: e.controlId, oldStatus: e.oldStatus, newStatus: e.newStatus, changedAt: e.createdAt }));

  const truncated = objectives.length > cap || controls.length > cap || objectiveEvents.length > cap || controlEvents.length > cap;
  return { objectives: objectives.slice(0, cap), controls: controls.slice(0, cap), truncated };
}
