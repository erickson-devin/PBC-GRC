import { writeControlAssessment, type ControlChangeActor } from './controlAssessments';
import { hasLegacyObjectives, runCatalogMigration, type ObjectiveActor } from './controlObjectives';
import type { ProgramScope } from './db';
import { CMMC_OBJECTIVE_CATALOG_REV, cmmcNumberOf } from '../src/data/cmmcGuide/guide';
import { controlStatusAfterCatalogUpdate, objectiveStatusAfterCatalogUpdate } from '../src/data/cmmcGuide/migration';
import type { ControlStatus } from '../src/types/cmmc';
import type { ObjectiveStatus } from '../src/types/controlObjectives';

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

const ACTOR = 'CMMC Assessment Guide v2.13 update';

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
      const objectiveWho: ObjectiveActor = { source: 'catalog-update', actor: ACTOR, userId: null };
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
      const controlWho: ControlChangeActor = { source: 'catalog-update', actor: ACTOR, userId: null };
      let controlsChanged = 0;
      for (const controlId of controlIds) {
        const written = await writeControlAssessment(
          scope,
          controlId,
          (current) => {
            if (!current || current.status !== 'MET') return null;
            const to = controlStatusAfterCatalogUpdate(controlId, current.status as ControlStatus, post, framework);
            return to === current.status ? null : { status: to, notes: null, role: null, updatedBy: ACTOR };
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
