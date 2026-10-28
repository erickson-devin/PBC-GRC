import { writeControlAssessment } from '../controlAssessments';
import type { ProgramScope } from '../db';
import { VM_SNAPSHOT_CONTROLS, composeCommittedNotes } from '../vm/snapshot';
import { hashLiveControl, readLiveControls } from './runner';
import { listStaged, updateJob, updateStaged } from './store';
import type { SspImportJob } from './types';

/**
 * The ONLY place an SSP import writes to the live control answers, and only for suggestions a reviewer accepted (or edited).
 *
 *  - It never changes a control's status: the document's text is not evidence that a practice is met. Only the
 *    implementation notes change (a control with no answer yet starts as NOT_STARTED).
 *    On the vulnerability-management snapshot controls the existing snapshot block is kept; status and role are passed
 *    as NULL and therefore never changed.
 *  - A suggestion is committed only if the control still looks the way it did when the suggestion was staged. If someone
 *    changed it meanwhile the item becomes CONFLICT and nothing is written for it.
 *  - Items that were rejected, are still pending or are in conflict are left alone.
 *  - It writes only into the program the import belongs to (the scope the job was read in); another program's controls are never touched.
 */
export interface CommitResult {
  committed: string[];
  conflicts: string[];
}

export async function commitReviewedSuggestions(
  scope: ProgramScope,
  job: SspImportJob,
  reviewer: string,
  onlyIds?: string[],
  reviewerUserId: string | null = null
): Promise<CommitResult> {
  if (job.programId && job.programId !== scope.programId) throw new Error('The import belongs to another program');
  const result: CommitResult = { committed: [], conflicts: [] };
  const staged = (await listStaged(scope, job.id)).filter(
    (s) => (s.reviewState === 'ACCEPTED' || s.reviewState === 'EDITED') && (!onlyIds || onlyIds.includes(s.id))
  );
  if (staged.length === 0) return result;

  const live = await readLiveControls(scope);
  const updatedBy = `SSP import "${job.fileName}" - reviewed by ${reviewer}`.slice(0, 255);

  for (const item of staged) {
    const current = live.get(item.controlId);
    if (hashLiveControl(current) !== item.baseHash) {
      await updateStaged(scope, job.id, item.id, { reviewState: 'CONFLICT' });
      result.conflicts.push(item.id);
      continue;
    }
    const notes = item.reviewState === 'EDITED' ? (item.editedNotes ?? '') : item.suggestedNotes;
    // A vulnerability-management snapshot control keeps its snapshot block (docs/VULNERABILITY_MANAGEMENT.md, section 7.3):
    // the block is machine-owned, so any block inside the reviewed text is dropped and the one the control carried is re-appended.
    const keepsBlock = (VM_SNAPSHOT_CONTROLS as readonly string[]).includes(item.controlId);
    const written = await writeControlAssessment(
      scope,
      item.controlId,
      (locked) =>
        hashLiveControl(locked) !== item.baseHash
          ? null // changed between the check above and this locked read: the same CONFLICT rule, applied once more
          : { status: null, notes: keepsBlock ? composeCommittedNotes(locked?.notes ?? '', notes, null) : notes, role: null, updatedBy },
      { source: 'ssp-commit', actor: reviewer, userId: reviewerUserId },
    );
    if (!written) {
      await updateStaged(scope, job.id, item.id, { reviewState: 'CONFLICT' });
      result.conflicts.push(item.id);
      continue;
    }
    await updateStaged(scope, job.id, item.id, { reviewState: 'COMMITTED', committedAt: new Date().toISOString() });
    result.committed.push(item.id);
  }

  // The job is done once nothing is waiting for a decision any more
  const remaining = (await listStaged(scope, job.id)).filter((s) => ['PENDING', 'ACCEPTED', 'EDITED', 'CONFLICT'].includes(s.reviewState));
  if (result.committed.length > 0 && remaining.length === 0) await updateJob(scope, job.id, { status: 'COMMITTED' });

  console.log(
    `[SSP Import] ${job.id} (${job.fileName}, sha256 ${job.fileSha256.slice(0, 12)}...): ${reviewer} committed ${result.committed.length} control(s), ${result.conflicts.length} conflict(s)`
  );
  return result;
}
