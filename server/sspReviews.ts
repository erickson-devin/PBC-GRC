import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SspMetadataFields } from '../src/types/sspMetadata';
import type { SspProfile, SspReviewsResponse, SspSectionReview, SspSectionReviewState } from '../src/types/sspProfile';
import { SSP_DIGEST_VERSION, SSP_SIGNABLE_SECTION_IDS, sectionCanonical, type SspSectionContentInput, type SspSectionId } from '../src/data/ssp/sspSections';
import { SSP_METADATA_FIELDS } from '../src/types/sspMetadata';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from './db';
import { readSspMetadata } from './sspMetadata';
import { normalizeSspProfile, readSspProfile } from './sspProfile';

/**
 * Section sign-offs of a program's SSP (issue #238): an append-only table of "this person reviewed this section, whose saved content then had this
 * SHA-256". The digest is computed here, on the server, from the saved SSP metadata and profile (browser crypto is not reliable on plain HTTP).
 * A section counts as reviewed while the newest sign-off carries the section's current digest; any later change to its saved fields makes it
 * "changed since review", and the old sign-offs stay in the history. The reviewer (user id, name, role, time) comes from the signed-in
 * session, never from the request body. Rows hold ids, names and digests only: no SSP text.
 *
 * Memory mode keeps its own array and a serial queue (the emulator answers unknown SQL with no rows) and fails closed without a tenant or program.
 */

export const SSP_REVIEW_HISTORY_LIMIT = 200;

export interface SspReviewer {
  userId: string;
  name: string;
  role: string;
}

/** The section's saved content changed after the caller loaded it; carries the digest it has now. Nothing was written. */
export class SectionChangedError extends Error {
  constructor(public readonly currentDigest: string) {
    super('The SSP section changed since it was loaded');
    this.name = 'SectionChangedError';
  }
}

const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);

/** SHA-256 (hex) of the version, the section id and the section's canonical saved content. */
export function computeSectionDigest(id: SspSectionId, input: SspSectionContentInput): string {
  return createHash('sha256').update(`${SSP_DIGEST_VERSION}\n${id}\n${sectionCanonical(id, input)}`, 'utf8').digest('hex');
}

/** Only the known string fields of a stored metadata object (as server/sspMetadata.ts keeps them). */
function metadataFrom(raw: unknown): SspMetadataFields {
  const out: SspMetadataFields = {};
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  for (const key of SSP_METADATA_FIELDS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

const digestsFor = (input: SspSectionContentInput): Record<SspSectionId, string> =>
  Object.fromEntries(SSP_SIGNABLE_SECTION_IDS.map((id) => [id, computeSectionDigest(id, input)])) as Record<SspSectionId, string>;

function statesFrom(input: SspSectionContentInput, history: SspSectionReview[]): SspSectionReviewState[] {
  const digests = digestsFor(input);
  return SSP_SIGNABLE_SECTION_IDS.map((id) => {
    const latest = history.find((r) => r.sectionId === id) ?? null; // history is newest first
    return { sectionId: id, currentDigest: digests[id], latest, reviewed: latest !== null && latest.contentSha256 === digests[id] };
  });
}

// ---- memory mode ----

type MemoryReview = SspSectionReview & { tenantId: string; programId: string };

let memoryReviews: MemoryReview[] = []; // oldest first
let memoryQueue: Promise<unknown> = Promise.resolve();

export function __resetSspReviewsForTests(): void {
  memoryReviews = [];
}

/** The sign-offs of a deleted program go with it (in PostgreSQL the foreign key cascades). */
export function __deleteProgramSspReviewsForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryReviews = memoryReviews.filter((r) => !(r.tenantId === scope.tenantId && r.programId === scope.programId));
}

const publicReview = (r: MemoryReview): SspSectionReview => ({
  id: r.id,
  sectionId: r.sectionId,
  contentSha256: r.contentSha256,
  reviewerUserId: r.reviewerUserId,
  reviewerName: r.reviewerName,
  reviewerRole: r.reviewerRole,
  createdAt: r.createdAt,
});

const memoryHistory = (scope: ProgramScope): SspSectionReview[] =>
  memoryReviews.filter((r) => r.tenantId === scope.tenantId && r.programId === scope.programId).map(publicReview).reverse();

// ---- PostgreSQL ----

function reviewFrom(row: pg.QueryResultRow): SspSectionReview {
  return {
    id: row.id,
    sectionId: row.section_id,
    contentSha256: row.content_sha256,
    reviewerUserId: row.reviewer_user_id,
    reviewerName: row.reviewer_name,
    reviewerRole: row.reviewer_role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const NEWEST_PER_SECTION = `
  SELECT DISTINCT ON (section_id) * FROM program_ssp_section_reviews
  WHERE tenant_id = $1 AND program_id = $2 AND action = 'signed_off'
  ORDER BY section_id, created_at DESC, id DESC
`;

const INSERT_REVIEW = `
  INSERT INTO program_ssp_section_reviews (tenant_id, program_id, section_id, action, content_sha256, reviewer_user_id, reviewer_name, reviewer_role)
  VALUES ($1, $2, $3, 'signed_off', $4, $5, $6, $7)
  RETURNING *;
`;

// ---- public API ----

/** The review state of every signable section (with the server-computed current digest) and the sign-off history, newest first. */
export async function readSspReviews(scope: ProgramScope): Promise<SspReviewsResponse> {
  const metadata = (await readSspMetadata(scope)).metadata ?? {};
  const profile = (await readSspProfile(scope)).profile;
  const input: SspSectionContentInput = { metadata, profile };
  if (!hasScope(scope)) return { sections: statesFrom(input, []), history: [] };
  if (getDbMode() === 'memory') {
    const all = memoryHistory(scope);
    return { sections: statesFrom(input, all), history: all.slice(0, SSP_REVIEW_HISTORY_LIMIT) };
  }
  const where = 'WHERE tenant_id = $1 AND program_id = $2 AND action = \'signed_off\'';
  const [newest, recent] = await Promise.all([
    queryWithProgram(scope, NEWEST_PER_SECTION, [scope.tenantId, scope.programId]),
    queryWithProgram(scope, `SELECT * FROM program_ssp_section_reviews ${where} ORDER BY created_at DESC, id DESC LIMIT ${SSP_REVIEW_HISTORY_LIMIT}`, [scope.tenantId, scope.programId]),
  ]);
  const latestRows = newest.rows.filter((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId).map(reviewFrom);
  const history = recent.rows.filter((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId).map(reviewFrom);
  return { sections: statesFrom(input, latestRows), history };
}

/**
 * Records `reviewer`'s sign-off of a section when `expectedDigest` is still the section's digest, else throws SectionChangedError and writes
 * nothing. The saved metadata and profile are read under a share lock in the same transaction (PostgreSQL) or inside the queue (memory), so a
 * write cannot slip in between the check and the insert. Signing the digest the newest sign-off already carries, as the same user, writes
 * nothing and returns that review (changed false).
 */
export async function signOffSection(
  scope: ProgramScope,
  sectionId: SspSectionId,
  expectedDigest: string,
  reviewer: SspReviewer
): Promise<{ review: SspSectionReview; section: SspSectionReviewState; changed: boolean }> {
  if (!hasScope(scope)) throw new Error('A program is required to sign off an SSP section');
  const finish = (input: SspSectionContentInput, review: SspSectionReview, changed: boolean) => {
    const section = statesFrom(input, [review]).find((s) => s.sectionId === sectionId)!;
    return { review, section, changed };
  };
  if (getDbMode() === 'memory') {
    const run = async () => {
      const input: SspSectionContentInput = { metadata: (await readSspMetadata(scope)).metadata ?? {}, profile: (await readSspProfile(scope)).profile };
      const current = computeSectionDigest(sectionId, input);
      if (current !== expectedDigest) throw new SectionChangedError(current);
      const newest = memoryHistory(scope).find((r) => r.sectionId === sectionId);
      if (newest && newest.contentSha256 === current && newest.reviewerUserId === reviewer.userId) return finish(input, newest, false);
      const row: MemoryReview = {
        id: randomUUID(),
        tenantId: scope.tenantId,
        programId: scope.programId,
        sectionId,
        contentSha256: current,
        reviewerUserId: reviewer.userId.slice(0, 128),
        reviewerName: reviewer.name.slice(0, 255),
        reviewerRole: reviewer.role.slice(0, 32),
        createdAt: nextStamp(memoryReviews.length ? memoryReviews[memoryReviews.length - 1].createdAt : null),
      };
      memoryReviews.push(row);
      return finish(input, publicReview(row), true);
    };
    const next = memoryQueue.then(run, run);
    memoryQueue = next.catch(() => undefined);
    return next;
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', scope.tenantId]);
    await c.query('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    const meta = await c.query('SELECT metadata FROM program_ssp_metadata WHERE tenant_id = $1 AND program_id = $2 FOR SHARE', [scope.tenantId, scope.programId]);
    const prof = await c.query('SELECT profile FROM program_ssp_profile WHERE tenant_id = $1 AND program_id = $2 FOR SHARE', [scope.tenantId, scope.programId]);
    const input: SspSectionContentInput = {
      metadata: metadataFrom(meta.rows[0]?.metadata),
      profile: prof.rows[0] ? (normalizeSspProfile(prof.rows[0].profile) as SspProfile) : null,
    };
    const current = computeSectionDigest(sectionId, input);
    if (current !== expectedDigest) throw new SectionChangedError(current);
    const newest = await c.query(
      "SELECT * FROM program_ssp_section_reviews WHERE tenant_id = $1 AND program_id = $2 AND section_id = $3 AND action = 'signed_off' ORDER BY created_at DESC, id DESC LIMIT 1",
      [scope.tenantId, scope.programId, sectionId]
    );
    const last = newest.rows[0] ? reviewFrom(newest.rows[0]) : null;
    let result;
    if (last && last.contentSha256 === current && last.reviewerUserId === reviewer.userId) {
      result = finish(input, last, false);
    } else {
      const ins = await c.query(INSERT_REVIEW, [scope.tenantId, scope.programId, sectionId, current, reviewer.userId.slice(0, 128), reviewer.name.slice(0, 255), reviewer.role.slice(0, 32)]);
      result = finish(input, reviewFrom(ins.rows[0]), true);
    }
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
