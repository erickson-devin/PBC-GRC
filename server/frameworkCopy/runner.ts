import { createHash, randomBytes } from 'node:crypto';
import { getTenantFrameworkPolicy, queryWithProgram, type ProgramScope } from '../db';
import { notesDigest, readControlAssessments, writeControlAssessment, memoryEventsCheckpoint } from '../controlAssessments';
import { readObjectives } from '../controlObjectives';
import { programCatalogIds, getProgram, type Program } from '../programs';
import { readProgramInventory, putToolControls } from '../inventory/programInventoryStore';
import { InventoryError } from '../inventory/registerStore';
import { DocumentError } from '../documents/registerStore';
import { readProgramDocuments, putDocumentControls } from '../documents/programDocumentsStore';
import type { InventoryActor } from '../inventory/events';
import { readTenantFile, removeTenantFile, writeTenantFile } from '../evidence/storage';
import { VM_SNAPSHOT_ACTOR, stripDelimitedBlocks } from '../vm/snapshot';
import { insertMarkerTx, insertRunTx, latestRun, listMarkers, newRunId, withCopyTx, type CopyTx } from './store';
import {
  COPY_MAX_EVIDENCE_BYTES,
  COPY_MAX_EVIDENCE_FILES,
  appendCopiedBlock,
  buildR3Suggestions,
  copyBlock,
  copyableText,
  normalizeCopyInclude,
  planDigestInput,
  planFrameworkCopy,
  type PlanSourceControl,
  type PlanSourceEvidence,
  type PlanSourceObjective,
} from '../../src/data/frameworkCopy/plan';
import { R2R3_PROVENANCE, newInR3, r2r3Mapping, r2r3MappingSha256 } from '../../src/data/frameworks/nist171r3/r2r3';
import { cmmcDisplayId } from '../../src/data/cmmcGuide/displayId';
import type { ObjectiveRecord } from '../../src/types/controlObjectives';
import type {
  FrameworkCopyCommitResult,
  FrameworkCopyInclude,
  FrameworkCopyOp,
  FrameworkCopyPlan,
  FrameworkCopyPreview,
  FrameworkCopySummary,
  FrameworkCopySuggestions,
} from '../../src/types/frameworkCopy';

/**
 * "Copy from Rev. 2" (#255): appends the content of a CMMC Level 2 / Level 1 program of the tenant to a NIST SP 800-171 Rev. 3 program. The pure planner
 * (src/data/frameworkCopy/plan.ts) decides what goes where from the generated Rev. 2 -> Rev. 3 mapping; this module reads the rows, checks the files and
 * applies the plan.
 *
 * Append only: a note is added after the existing text (never changed), a tool or document link is added to the links the control already has, an evidence
 * file is a new row with its own copy of the bytes. Each item's marker (program_framework_copy_items) is inserted FIRST in the run's transaction with ON
 * CONFLICT DO NOTHING, so a re-run, a crash or a concurrent run appends nothing twice. A source whose text changed after it was copied is not re-copied.
 *
 * Commit recomputes the plan and compares its digest with the one the person previewed (copy_plan_stale otherwise). Evidence files are written before the
 * transaction and removed when it rolls back (like server/vm/snapshotWriter.ts). Tool and document links go through their own stores, so their validation and
 * history events apply; they are written before the transaction (a link is additive and idempotent: a failed run leaves only links a re-run would add anyway)
 * and a link the store refuses is skipped and counted, never marked. Every control change is a history event with source 'clone'.
 *
 * Logs, errors, events and the run row hold ids, digests, counts and lengths only: never a note, an objective narrative or a file name.
 */

export const FRAMEWORK_COPY_TARGET = 'NIST_800_171_R3';
/** The source frameworks: CMMC Level 2 and Level 1 (Level 1's ids carry the Rev. 2 numbers too). */
export const FRAMEWORK_COPY_SOURCES: readonly string[] = ['CMMC_L2', 'CMMC_L1'];

export type CopyErrorCode =
  | 'invalid_copy_target'
  | 'invalid_copy_source'
  | 'program_not_found'
  | 'framework_not_enabled'
  | 'copy_plan_stale'
  | 'copy_in_progress'
  | 'copy_too_large';

export const COPY_STATUS: Record<CopyErrorCode, number> = {
  invalid_copy_target: 400,
  invalid_copy_source: 400,
  program_not_found: 404,
  framework_not_enabled: 403,
  copy_plan_stale: 409,
  copy_in_progress: 409,
  copy_too_large: 413,
};

export class CopyError extends Error {
  constructor(
    public readonly code: CopyErrorCode,
    message: string,
    /** Extra facts for the caller (a digest, counts: never a text). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CopyError';
  }
}

const PROGRAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const actorName = (who: InventoryActor): string => who.actor.slice(0, 255);

/** In-process lock per target program: one commit at a time (a second one answers copy_in_progress). */
const running = new Set<string>();

// ------------------------------------------------------------------------------------------------ source and target

async function resolveSource(target: Program, sourceProgramId: unknown): Promise<Program> {
  if (target.frameworkId !== FRAMEWORK_COPY_TARGET) throw new CopyError('invalid_copy_target', 'Copy from Rev. 2 works in a NIST SP 800-171 Rev. 3 program only');
  if (typeof sourceProgramId !== 'string' || !PROGRAM_ID_RE.test(sourceProgramId)) throw new CopyError('invalid_copy_source', 'sourceProgramId must be the id of a program of this organization');
  const source = await getProgram(target.tenantId, sourceProgramId);
  if (!source) throw new CopyError('program_not_found', 'Program not found');
  if (source.id === target.id) throw new CopyError('invalid_copy_source', 'The source must be another program');
  if (!FRAMEWORK_COPY_SOURCES.includes(source.frameworkId)) throw new CopyError('invalid_copy_source', 'The source must be a CMMC Level 2 or Level 1 program');
  const policy = await getTenantFrameworkPolicy(target.tenantId);
  if (policy && !policy.enabledFrameworks.includes(source.frameworkId)) throw new CopyError('framework_not_enabled', 'The framework of the source program is not enabled for this organization');
  return source;
}

// ------------------------------------------------------------------------------------------------ reading the source

interface EvidenceRow {
  id: string;
  controlId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  gcsPath: string;
  fileHash: string;
  description: string;
}

interface Snapshot {
  source: Program;
  target: Program;
  include: FrameworkCopyInclude;
  controls: Map<string, PlanSourceControl>;
  objectives: Map<string, ObjectiveRecord>;
  evidence: Map<string, EvidenceRow>;
  plan: FrameworkCopyPlan;
  planDigest: string;
}

/** Evidence the copy never carries: inherited copies (they follow the base row's own copy) and the vulnerability snapshots (system managed). */
const isCopyableEvidence = (row: Record<string, unknown>): boolean =>
  row.sync_status !== 'inherited' && row.uploaded_by !== VM_SNAPSHOT_ACTOR && !String(row.id).includes('__inh_');

/** The bytes of a source evidence file when it is there and its recorded hash matches; null otherwise. */
async function readVerified(tenantId: string, row: EvidenceRow): Promise<{ bytes: Buffer; sha256: string } | null> {
  const bytes = await readTenantFile(tenantId, row.gcsPath);
  if (!bytes) return null;
  const sha256 = sha256Hex(bytes);
  // a placeholder hash (the upload recomputes the real one) cannot be checked: the bytes are taken as they are
  if (HEX64_RE.test(row.fileHash.toLowerCase()) && sha256 !== row.fileHash.toLowerCase()) return null;
  return { bytes, sha256 };
}

const tooLarge = (plan: FrameworkCopyPlan): boolean => plan.totals.evidenceFiles > COPY_MAX_EVIDENCE_FILES || plan.totals.evidenceBytes > COPY_MAX_EVIDENCE_BYTES;

async function snapshotOf(target: Program, source: Program, includeIn: Partial<FrameworkCopyInclude> | null | undefined): Promise<Snapshot> {
  const tenantId = target.tenantId;
  const include = normalizeCopyInclude(includeIn);
  const sourceScope: ProgramScope = { tenantId, programId: source.id };
  const targetScope: ProgramScope = { tenantId, programId: target.id };

  const controls = new Map<string, PlanSourceControl>();
  for (const [id, row] of await readControlAssessments(sourceScope)) {
    const text = copyableText(row.notes, stripDelimitedBlocks);
    controls.set(id, { notes: row.notes, status: row.status, updatedAt: row.updatedAt, ...(text ? { notesSha256: sha256Hex(text) } : {}) });
  }

  const objectives = new Map<string, ObjectiveRecord>();
  const planObjectives: PlanSourceObjective[] = [];
  if (include.objectives) {
    for (const o of await readObjectives(sourceScope)) {
      objectives.set(o.objectiveId, o);
      const text = copyableText(o.narrative);
      planObjectives.push({ objectiveId: o.objectiveId, controlId: o.controlId, narrative: o.narrative, updatedAt: o.updatedAt, ...(text ? { narrativeSha256: sha256Hex(text) } : {}) });
    }
  }

  const evidence = new Map<string, EvidenceRow>();
  const planEvidence: PlanSourceEvidence[] = [];
  if (include.evidence) {
    const res = await queryWithProgram(sourceScope, 'SELECT * FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY uploaded_at DESC', [tenantId, source.id]);
    for (const r of res.rows) {
      if (r.tenant_id !== tenantId) continue; // defence in depth: the store already filters by tenant
      const row: EvidenceRow = {
        id: String(r.id),
        controlId: String(r.control_id),
        fileName: String(r.file_name ?? ''),
        fileSize: typeof r.file_size === 'number' ? r.file_size : parseInt(r.file_size, 10) || 0,
        mimeType: String(r.mime_type || 'application/octet-stream'),
        gcsPath: String(r.gcs_path ?? ''),
        fileHash: String(r.file_hash ?? ''),
        description: String(r.description ?? ''),
      };
      evidence.set(row.id, row);
      planEvidence.push({ id: row.id, controlId: row.controlId, sizeBytes: row.fileSize, ...(HEX64_RE.test(row.fileHash.toLowerCase()) ? { fileHash: row.fileHash.toLowerCase() } : {}), copyable: isCopyableEvidence(r) });
    }
  }

  const toolLinks = include.tools ? (await readProgramInventory(sourceScope)).controlLinks.map((l) => ({ toolId: l.toolId, controlId: l.controlId })) : [];
  const documentLinks = include.documents ? (await readProgramDocuments(sourceScope)).controlLinks.map((l) => ({ documentId: l.documentId, controlId: l.controlId })) : [];
  const markers = await listMarkers(targetScope, source.id);

  const build = (unavailable: ReadonlySet<string>): FrameworkCopyPlan =>
    planFrameworkCopy({
      mapping: r2r3Mapping(),
      newInR3: newInR3(),
      targetCatalog: programCatalogIds(target),
      source: { controls, objectives: planObjectives, evidence: planEvidence.map((e) => (unavailable.has(e.id) ? { ...e, available: false } : e)), toolLinks, documentLinks },
      markers,
      include,
      stripNotes: stripDelimitedBlocks,
    });

  // First with every file assumed to be there: too large a copy is reported without reading a single file.
  let plan = build(new Set());
  if (!tooLarge(plan)) {
    const missing = new Set<string>();
    for (const item of plan.items) {
      for (const op of item.ops) {
        if (op.kind !== 'EVIDENCE') continue;
        const row = evidence.get(op.sourceKey);
        if (!row || !(await readVerified(tenantId, row))) missing.add(op.sourceKey);
      }
    }
    if (missing.size > 0) plan = build(missing);
  }
  plan.totals.tooLarge = tooLarge(plan);
  return { source, target, include, controls, objectives, evidence, plan, planDigest: sha256Hex(planDigestInput(plan)) };
}

/** A short, fixed description of where the mapping comes from (ids and digests of NIST's public sources). */
function provenanceText(): string {
  const sources = Object.keys(R2R3_PROVENANCE.sources)
    .sort()
    .map((k) => `${k} sha256 ${R2R3_PROVENANCE.sources[k].sha256}`)
    .join('; ');
  return `usnistgov/oscal-content ${R2R3_PROVENANCE.oscalCommit}; ${sources}`;
}

// ------------------------------------------------------------------------------------------------ preview

/** What a copy would do. Writes nothing; ids, counts and lengths only. */
export async function previewCopy(target: Program, sourceProgramId: unknown, include?: Partial<FrameworkCopyInclude> | null): Promise<FrameworkCopyPreview> {
  const source = await resolveSource(target, sourceProgramId);
  const snap = await snapshotOf(target, source, include);
  return {
    ...snap.plan,
    source: { id: source.id, name: source.name, frameworkId: source.frameworkId },
    targetProgramId: target.id,
    mapping: { sha256: await r2r3MappingSha256(), provenance: provenanceText() },
    planDigest: snap.planDigest,
  };
}

// ------------------------------------------------------------------------------------------------ commit

const opId = (op: FrameworkCopyOp): string => `${op.kind}|${op.targetControlId}|${op.sourceKey}`;
const validSha = (s: string | undefined): string | null => (s && HEX64_RE.test(s) ? s : null);

interface LinkOutcome {
  /** Ops whose link the store refused: no marker, counted as skipped. */
  skipped: Set<string>;
  added: number;
}

const refusal = (err: unknown): boolean => err instanceof InventoryError || err instanceof DocumentError;
const isStale = (err: unknown): boolean => refusal(err) && (err as InventoryError | DocumentError).code === 'stale_write';

/** Adds the copied tool links to the target program through putToolControls: the union of the links a tool has and the controls it gains. */
async function linkTools(scope: ProgramScope, ops: FrameworkCopyOp[], catalog: ReadonlySet<string>, who: InventoryActor): Promise<LinkOutcome> {
  const out: LinkOutcome = { skipped: new Set(), added: 0 };
  const byTool = new Map<string, FrameworkCopyOp[]>();
  for (const op of ops) byTool.set(op.sourceKey, [...(byTool.get(op.sourceKey) ?? []), op]);
  for (const [toolId, toolOps] of byTool) {
    const wanted = [...new Set(toolOps.map((o) => o.targetControlId))];
    for (let attempt = 0; attempt < 2; attempt++) {
      const have = new Map((await readProgramInventory(scope)).controlLinks.filter((l) => l.toolId === toolId).map((l) => [l.controlId, l.evidenceSource] as const));
      const add = wanted.filter((id) => !have.has(id));
      try {
        if (add.length > 0) {
          await putToolControls(scope, toolId, [...have].map(([controlId, evidenceSource]) => ({ controlId, evidenceSource })).concat(add.map((controlId) => ({ controlId, evidenceSource: false }))), [...have.keys()], catalog, who);
        }
        out.added += add.length;
        break;
      } catch (err) {
        if (isStale(err) && attempt === 0) continue; // the links changed between the read and the write: read again once
        if (!refusal(err)) throw err;
        for (const op of toolOps) out.skipped.add(opId(op));
        break;
      }
    }
  }
  return out;
}

/** The same for documents, through putDocumentControls. */
async function linkDocuments(scope: ProgramScope, ops: FrameworkCopyOp[], catalog: ReadonlySet<string>, who: InventoryActor): Promise<LinkOutcome> {
  const out: LinkOutcome = { skipped: new Set(), added: 0 };
  const byDoc = new Map<string, FrameworkCopyOp[]>();
  for (const op of ops) byDoc.set(op.sourceKey, [...(byDoc.get(op.sourceKey) ?? []), op]);
  for (const [documentId, docOps] of byDoc) {
    const wanted = [...new Set(docOps.map((o) => o.targetControlId))];
    for (let attempt = 0; attempt < 2; attempt++) {
      const have = (await readProgramDocuments(scope)).controlLinks.filter((l) => l.documentId === documentId).map((l) => l.controlId);
      const add = wanted.filter((id) => !have.includes(id));
      try {
        if (add.length > 0) await putDocumentControls(scope, documentId, [...have, ...add], have, catalog, who);
        out.added += add.length;
        break;
      } catch (err) {
        if (isStale(err) && attempt === 0) continue;
        if (!refusal(err)) throw err;
        for (const op of docOps) out.skipped.add(opId(op));
        break;
      }
    }
  }
  return out;
}

const EVIDENCE_INSERT = `
  INSERT INTO evidence_metadata (
    id, tenant_id, control_id, file_name, file_size, mime_type,
    gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12
  )
  RETURNING id;
`;

interface CopiedFile {
  newId: string;
  absPath: string;
  sha256: string;
  size: number;
}

/**
 * Appends the plan the person previewed. `planDigest` must equal the digest of the plan recomputed now (409 copy_plan_stale with the fresh digest
 * otherwise); more than COPY_MAX_EVIDENCE_FILES files or COPY_MAX_EVIDENCE_BYTES bytes is 413 copy_too_large with nothing written; a second commit for the
 * same target while one runs is 409 copy_in_progress.
 */
export async function commitCopy(
  target: Program,
  sourceProgramId: unknown,
  include: Partial<FrameworkCopyInclude> | null | undefined,
  planDigest: string,
  who: InventoryActor
): Promise<FrameworkCopyCommitResult> {
  const source = await resolveSource(target, sourceProgramId);
  const lockKey = `${target.tenantId}__${target.id}`;
  if (running.has(lockKey)) throw new CopyError('copy_in_progress', 'A copy into this program is already running');
  running.add(lockKey);
  const written: string[] = [];
  try {
    const snap = await snapshotOf(target, source, include);
    if (snap.plan.totals.tooLarge) throw new CopyError('copy_too_large', 'This copy carries more evidence than one run may copy: copy fewer controls or files', { files: snap.plan.totals.evidenceFiles, bytes: snap.plan.totals.evidenceBytes });
    if (snap.planDigest !== planDigest) throw new CopyError('copy_plan_stale', 'The Rev. 2 program or this program changed after the preview: preview again', { planDigest: snap.planDigest });

    const tenantId = target.tenantId;
    const scope: ProgramScope = { tenantId, programId: target.id };
    const catalog = programCatalogIds(target);
    const plan = snap.plan;
    const ops = plan.items.flatMap((i) => i.ops);
    const runId = newRunId();
    const date = new Date().toISOString().slice(0, 10);

    // 1. Evidence: the bytes are copied (and checked against the recorded hash) before the transaction.
    const copies = new Map<string, CopiedFile>();
    let vanished = 0;
    for (const op of ops) {
      if (op.kind !== 'EVIDENCE') continue;
      const row = snap.evidence.get(op.sourceKey);
      const verified = row ? await readVerified(tenantId, row) : null;
      if (!row || !verified) {
        vanished++;
        continue;
      }
      const newId = `ev_${Date.now()}_${randomBytes(4).toString('hex')}`;
      const clean = (row.fileName || 'evidence.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
      const file = await writeTenantFile(tenantId, `controls/${op.targetControlId}/${newId}_${clean}`, verified.bytes, { exclusive: true });
      written.push(file.absPath);
      copies.set(opId(op), { newId, absPath: file.absPath, sha256: file.sha256, size: file.size });
    }

    // 2. Tool and document links, through their own stores.
    const tools = await linkTools(scope, ops.filter((o) => o.kind === 'TOOL'), catalog, who);
    const docs = await linkDocuments(scope, ops.filter((o) => o.kind === 'DOCUMENT'), catalog, who);

    // 3. One transaction: markers first, then the notes, the evidence rows and the run record.
    const summary: FrameworkCopySummary = {
      notesAppended: 0,
      objectivesAppended: 0,
      evidenceCopied: 0,
      evidenceUnavailable: plan.totals.evidenceUnavailable + vanished,
      toolLinksAdded: tools.added,
      toolLinksSkipped: tools.skipped.size,
      documentLinksAdded: docs.added,
      documentLinksSkipped: docs.skipped.size,
      alreadyCopied: plan.totals.alreadyCopied,
      controls: [],
      newInR3: plan.newInR3.length,
      notCarried: plan.notCarried.length,
      mergedInto: plan.mergedInto.length,
    };
    const usedFiles = new Set<string>();
    await withCopyTx(scope, async (tx: CopyTx) => {
      if (tx.client === null) tx.onRollback(memoryEventsCheckpoint(scope));
      const touched = new Set<string>();
      for (const item of plan.items) {
        const blocks: string[] = [];
        for (const op of item.ops) {
          const id = opId(op);
          const marker = { sourceProgramId: source.id, kind: op.kind, targetControlId: op.targetControlId, sourceKey: op.sourceKey, runId, sourceSha256: validSha(op.sha256), targetRef: null as string | null };
          if (op.kind === 'NOTES' || op.kind === 'OBJECTIVE') {
            const raw = op.kind === 'NOTES' ? snap.controls.get(op.sourceKey)?.notes ?? '' : snap.objectives.get(op.sourceKey)?.narrative ?? '';
            const text = copyableText(raw, op.kind === 'NOTES' ? stripDelimitedBlocks : undefined);
            if (!text) continue;
            if (!(await insertMarkerTx(tx, scope, { ...marker, sourceSha256: notesDigest(text).sha256 }))) {
              summary.alreadyCopied++;
              continue;
            }
            blocks.push(copyBlock({ kind: op.kind, sourceId: op.kind === 'NOTES' ? cmmcDisplayId(op.sourceControlId, source.frameworkId) : op.sourceKey, programName: source.name, date, text }));
            if (op.kind === 'NOTES') summary.notesAppended++;
            else summary.objectivesAppended++;
          } else if (op.kind === 'EVIDENCE') {
            const file = copies.get(id);
            const row = snap.evidence.get(op.sourceKey);
            if (!file || !row) continue;
            if (!(await insertMarkerTx(tx, scope, { ...marker, sourceSha256: file.sha256, targetRef: file.newId }))) {
              summary.alreadyCopied++;
              continue;
            }
            const params = [file.newId, tenantId, op.targetControlId, row.fileName, file.size, row.mimeType, file.absPath, file.sha256, 'local_storage', `[Copied from Rev. 2 ${cmmcDisplayId(op.sourceControlId, source.frameworkId)}] ${row.description}`, actorName(who), scope.programId];
            if (tx.client) await tx.client.query(EVIDENCE_INSERT, params);
            else await queryWithProgram(scope, EVIDENCE_INSERT, params as (string | number)[]);
            usedFiles.add(file.absPath);
            summary.evidenceCopied++;
          } else {
            if ((op.kind === 'TOOL' ? tools : docs).skipped.has(id)) continue;
            if (!(await insertMarkerTx(tx, scope, marker))) summary.alreadyCopied++;
          }
          touched.add(op.targetControlId);
        }
        if (blocks.length > 0) {
          await writeControlAssessment(
            scope,
            item.targetControlId,
            (current) => ({ status: null, notes: blocks.reduce((notes, block) => appendCopiedBlock(notes, block), current?.notes ?? ''), role: null, updatedBy: actorName(who) }),
            { source: 'clone', actor: who.actor, userId: who.userId },
            tx.client
          );
        }
      }
      summary.controls = [...touched].sort();
      await insertRunTx(tx, scope, { id: runId, sourceProgramId: source.id, sourceFramework: source.frameworkId, mappingSha256: await r2r3MappingSha256(), actor: actorName(who), actorUserId: who.userId, summary });
    });
    // files whose marker belonged to a concurrent run (not ours to keep)
    for (const p of written) if (!usedFiles.has(p)) await removeTenantFile(tenantId, p).catch(() => undefined);
    return { runId, summary };
  } catch (err) {
    if (!(err instanceof CopyError)) for (const p of written) await removeTenantFile(target.tenantId, p).catch(() => undefined);
    throw err;
  } finally {
    running.delete(lockKey);
  }
}

// ------------------------------------------------------------------------------------------------ suggestions

/**
 * The suggested Rev. 3 statuses, from the Rev. 2 statuses of the source program of the latest run. Computed on request, never stored or written.
 * applies is false when the program is not Rev. 3, there was no run, or the source program no longer exists.
 */
export async function copySuggestions(target: Program): Promise<FrameworkCopySuggestions> {
  const none: FrameworkCopySuggestions = { applies: false, sourceProgramId: null, suggestions: [] };
  if (target.frameworkId !== FRAMEWORK_COPY_TARGET) return none;
  const run = await latestRun({ tenantId: target.tenantId, programId: target.id });
  if (!run) return none;
  const source = await getProgram(target.tenantId, run.sourceProgramId);
  if (!source) return none;
  const statuses = new Map<string, string>();
  for (const [id, row] of await readControlAssessments({ tenantId: target.tenantId, programId: source.id })) statuses.set(id, row.status);
  return { applies: true, sourceProgramId: source.id, suggestions: buildR3Suggestions({ mapping: r2r3Mapping(), targetCatalog: programCatalogIds(target), sourceStatuses: statuses }) };
}
