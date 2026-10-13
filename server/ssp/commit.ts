import { queryWithTenant } from '../db';
import { hashLiveControl, readLiveControls } from './runner';
import { listStaged, updateJob, updateStaged } from './store';
import type { SspImportJob } from './types';

/**
 * The ONLY place an SSP import writes to the live control answers, and only for suggestions a reviewer accepted (or edited).
 *
 *  - It never changes a control's status: the document's text is not evidence that a practice is met. Only the
 *    implementation notes change (a control with no answer yet starts as NOT_STARTED).
 *  - A suggestion is committed only if the control still looks the way it did when the suggestion was staged. If someone
 *    changed it meanwhile the item becomes CONFLICT and nothing is written for it.
 *  - Items that were rejected, are still pending or are in conflict are left alone.
 */
export interface CommitResult {
  committed: string[];
  conflicts: string[];
}

const UPSERT = `
  INSERT INTO control_assessments (
    tenant_id, control_id, status, implementation_notes, responsible_role, updated_by
  ) VALUES (
    $1, $2, $3, $4, $5, $6
  )
  ON CONFLICT (tenant_id, control_id)
  DO UPDATE SET
    status = COALESCE($3, control_assessments.status),
    implementation_notes = COALESCE($4, control_assessments.implementation_notes),
    responsible_role = COALESCE($5, control_assessments.responsible_role),
    updated_by = $6,
    updated_at = NOW()
  RETURNING *;
`;

export async function commitReviewedSuggestions(
  tenantId: string,
  job: SspImportJob,
  reviewer: string,
  onlyIds?: string[]
): Promise<CommitResult> {
  const result: CommitResult = { committed: [], conflicts: [] };
  const staged = (await listStaged(tenantId, job.id)).filter(
    (s) => (s.reviewState === 'ACCEPTED' || s.reviewState === 'EDITED') && (!onlyIds || onlyIds.includes(s.id))
  );
  if (staged.length === 0) return result;

  const live = await readLiveControls(tenantId);
  const updatedBy = `SSP import "${job.fileName}" - reviewed by ${reviewer}`.slice(0, 255);

  for (const item of staged) {
    const current = live.get(item.controlId);
    if (hashLiveControl(current) !== item.baseHash) {
      await updateStaged(tenantId, job.id, item.id, { reviewState: 'CONFLICT' });
      result.conflicts.push(item.id);
      continue;
    }
    const notes = item.reviewState === 'EDITED' ? (item.editedNotes ?? '') : item.suggestedNotes;
    const written = await queryWithTenant(tenantId, UPSERT, [
      tenantId,
      item.controlId,
      current?.status ?? 'NOT_STARTED',
      notes,
      current?.role ?? 'IT / Security Lead',
      updatedBy,
    ]);
    if (!written.rows.length) throw new Error(`Control ${item.controlId} could not be written`);
    await updateStaged(tenantId, job.id, item.id, { reviewState: 'COMMITTED', committedAt: new Date().toISOString() });
    result.committed.push(item.id);
  }

  // The job is done once nothing is waiting for a decision any more
  const remaining = (await listStaged(tenantId, job.id)).filter((s) => ['PENDING', 'ACCEPTED', 'EDITED', 'CONFLICT'].includes(s.reviewState));
  if (result.committed.length > 0 && remaining.length === 0) await updateJob(tenantId, job.id, { status: 'COMMITTED' });

  console.log(
    `[SSP Import] ${job.id} (${job.fileName}, sha256 ${job.fileSha256.slice(0, 12)}...): ${reviewer} committed ${result.committed.length} control(s), ${result.conflicts.length} conflict(s)`
  );
  return result;
}
