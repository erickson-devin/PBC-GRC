import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, getTenantProgram, pool, queryWithProgram, queryWithTenant, type ProgramScope, type SqlParam } from './db';
import { PROGRAM_FRAMEWORK_IDS } from './schema';
import { readControlAssessments, writeControlAssessment, type ControlChangeActor } from './controlAssessments';
import { stripDelimitedBlocks } from './vm/snapshot';
import { countOpenPoamItems, countPoamItems } from './vm/findingsStore';
import { getFrameworkControls } from '../src/data/frameworks';
import { getEquivalentControlIds } from '../src/data/frameworks/controlMappings';

/**
 * Programs: a tenant's authorization boundaries (an ATO effort or project). Each program has one framework and, for NIST SP 800-53,
 * one baseline; control answers, evidence, SSP imports and POA&M items belong to exactly one program. Every tenant has a default
 * program, created lazily from the tenant's primary framework, which also adopts the rows written before programs existed.
 *
 * This is the data layer: PostgreSQL (the tenant RLS context is set on every statement) or process memory when DB_MODE=memory.
 * The HTTP routes are in routes/programs.ts and the request scoping in middleware/programContext.ts.
 */

export const DEFAULT_PROGRAM_NAME = 'Default Authorization Boundary';
/** Programs per tenant, archived ones included (they stay in the table). */
export const MAX_PROGRAMS_PER_TENANT = 50;
export const PROGRAM_BASELINES = ['LOW', 'MODERATE', 'HIGH'] as const;
export type ProgramBaseline = (typeof PROGRAM_BASELINES)[number];

/** Tables that carry program_id, in the order the backfill visits them. */
export const PROGRAM_SCOPED_TABLES = ['control_assessments', 'control_assessment_events', 'evidence_metadata', 'ssp_import_jobs', 'staged_controls', 'vm_poam_items'] as const;
export type ProgramScopedTable = (typeof PROGRAM_SCOPED_TABLES)[number];

export interface Program {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  frameworkId: string;
  baseline: ProgramBaseline | null;
  systemBoundarySummary: string;
  isDefault: boolean;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProgramErrorCode =
  | 'invalid_name'
  | 'framework_not_enabled'
  | 'invalid_baseline'
  | 'program_name_taken'
  | 'program_limit'
  | 'program_is_default'
  | 'program_not_found'
  | 'program_archived'
  | 'framework_immutable'
  | 'program_not_empty'
  | 'not_implemented';

export class ProgramError extends Error {
  constructor(
    public readonly code: ProgramErrorCode,
    message: string,
    /** Extra facts for the caller, e.g. what keeps a program from being deleted. */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProgramError';
  }
}

export interface NewProgramInput {
  name: string;
  frameworkId: string;
  /** NIST SP 800-53 only (LOW, MODERATE or HIGH; MODERATE when omitted). Any other framework takes none. */
  baseline?: string | null;
  description?: string;
  systemBoundarySummary?: string;
  /** Initial content. Absent or empty is a blank program; `cloneFrom` (a program of the same tenant) copies its notes, see cloneProgramContent. */
  seed?: { cloneFrom?: string } | null;
}

export interface ProgramPatch {
  name?: string;
  description?: string;
  systemBoundarySummary?: string;
  /** Immutable: accepted only when it equals the current value, so a form can post the whole program back. */
  frameworkId?: string;
  /** Immutable, like frameworkId. */
  baseline?: string | null;
}

export type ProgramUsage = { evidence: number; imports: number; poam: number };
/** What the program page shows for a program: control coverage, evidence files (not the inherited copies) and open POA&M items. */
export type ProgramMetrics = { documented: number; total: number; evidence: number; openPoam: number };
export type MigrationCounts = Record<ProgramScopedTable, number> & { total: number };

const memoryPrograms = new Map<string, Program>(); // key: id
const migratedTenants = new Set<string>(); // tenants whose legacy rows were adopted by their default program in this process

/** Test hook. */
export function __resetProgramsForTests(): void {
  memoryPrograms.clear();
  migratedTenants.clear();
}

const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string => new Date(v as string).toISOString();
const FRAMEWORK_ALIASES: Record<string, string> = { 'nist-800-53-r5': 'NIST_800_53_REV5' };

/** The canonical framework id a program may carry, or null when it is not one of the five. */
function programFramework(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const canonical = FRAMEWORK_ALIASES[id.trim().toLowerCase()] ?? id.trim();
  return (PROGRAM_FRAMEWORK_IDS as readonly string[]).includes(canonical) ? canonical : null;
}

function rowToProgram(r: pg.QueryResultRow): Program {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description ?? '',
    frameworkId: r.framework_id,
    baseline: (r.baseline ?? null) as ProgramBaseline | null,
    systemBoundarySummary: r.system_boundary_summary ?? '',
    isDefault: Boolean(r.is_default),
    archivedAt: r.archived_at ? iso(r.archived_at) : null,
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

type Query = (text: string, params?: SqlParam[]) => Promise<pg.QueryResult>;

/** One PostgreSQL transaction under the tenant's RLS context. */
async function inTenantTx<T>(tenantId: string, fn: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The framework and baseline a tenant's default program starts with: its primary framework, CMMC_L1 without one. */
function defaultFramework(primary: unknown): { frameworkId: string; baseline: ProgramBaseline | null } {
  const frameworkId = programFramework(primary) ?? 'CMMC_L1';
  return { frameworkId, baseline: frameworkId === 'NIST_800_53_REV5' ? 'MODERATE' : null };
}

/** Finds the tenant's default program or creates it (idempotent, safe against a concurrent creator). Does not migrate. */
async function resolveDefaultProgram(tenantId: string): Promise<Program> {
  if (isMemory()) {
    const existing = [...memoryPrograms.values()].find((p) => p.tenantId === tenantId && p.isDefault);
    if (existing) return existing;
    const { frameworkId, baseline } = defaultFramework((await getTenantProgram(tenantId))?.primaryFramework);
    const now = new Date().toISOString();
    const program: Program = {
      id: crypto.randomUUID(),
      tenantId,
      name: DEFAULT_PROGRAM_NAME,
      description: '',
      frameworkId,
      baseline,
      systemBoundarySummary: '',
      isDefault: true,
      archivedAt: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    };
    memoryPrograms.set(program.id, program);
    return program;
  }
  return inTenantTx(tenantId, (q) => selectOrCreateDefault(q, tenantId));
}

async function selectOrCreateDefault(q: Query, tenantId: string): Promise<Program> {
  const select = 'SELECT * FROM programs WHERE tenant_id = $1 AND is_default';
  const found = await q(select, [tenantId]);
  if (found.rows[0]) return rowToProgram(found.rows[0]);
  const tenant = await q('SELECT primary_framework FROM tenants WHERE id = $1', [tenantId]);
  const { frameworkId, baseline } = defaultFramework(tenant.rows[0]?.primary_framework);
  await q(
    `INSERT INTO programs (tenant_id, name, framework_id, baseline, is_default)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (tenant_id) WHERE is_default DO NOTHING`,
    [tenantId, DEFAULT_PROGRAM_NAME, frameworkId, baseline]
  );
  const again = await q(select, [tenantId]);
  return rowToProgram(again.rows[0]);
}

/**
 * The tenant's default program, created on first use ('Default Authorization Boundary', from the tenant's primary framework, CMMC_L1
 * without one, baseline MODERATE for NIST). The first call per tenant and process also adopts the tenant's legacy rows
 * (migrateTenantToPrograms).
 */
export async function ensureDefaultProgram(tenantId: string): Promise<Program> {
  const program = await resolveDefaultProgram(tenantId);
  if (!migratedTenants.has(tenantId)) {
    await migrateTenantToPrograms(tenantId);
    migratedTenants.add(tenantId);
  }
  return program;
}

/**
 * Backfill: gives every row of the tenant that has no program the tenant's default program, in one transaction under the tenant's RLS
 * context and the default program's (the program row policies need both). It cannot be a plain UPDATE at boot, because FORCE RLS hides
 * every tenant from a session with no tenant context.
 * Idempotent: a second run changes nothing. Returns how many rows each table adopted.
 */
export async function migrateTenantToPrograms(tenantId: string): Promise<MigrationCounts> {
  const counts = Object.fromEntries(PROGRAM_SCOPED_TABLES.map((t) => [t, 0])) as MigrationCounts;
  const update = (table: ProgramScopedTable) => `UPDATE ${table} SET program_id = $1 WHERE tenant_id = $2 AND program_id IS NULL`;
  if (isMemory()) {
    const program = await resolveDefaultProgram(tenantId);
    for (const table of PROGRAM_SCOPED_TABLES) {
      // in the default program's context, like PostgreSQL below: the row policy lets only that context adopt the legacy rows
      counts[table] = (await queryWithProgram({ tenantId, programId: program.id }, update(table), [program.id, tenantId])).rowCount ?? 0;
    }
  } else {
    await inTenantTx(tenantId, async (q) => {
      const program = await selectOrCreateDefault(q, tenantId); // the program insert needs only the tenant policy
      // The program policy of the six tables: USING maps a row with no program to the default program, WITH CHECK demands the program
      // the row is given. So the UPDATEs run with BOTH settings, the default program being the current one.
      await q('SELECT set_config($1, $2, true)', ['app.current_program_id', program.id]);
      for (const table of PROGRAM_SCOPED_TABLES) counts[table] = (await q(update(table), [program.id, tenantId])).rowCount ?? 0;
    });
  }
  counts.total = PROGRAM_SCOPED_TABLES.reduce((sum, t) => sum + counts[t], 0);
  return counts;
}

/** The tenant's programs, the default first. Archived ones only with `includeArchived`. Does not create the default program. */
export async function listPrograms(tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<Program[]> {
  const rows: Program[] = isMemory()
    ? [...memoryPrograms.values()].filter((p) => p.tenantId === tenantId)
    : (await queryWithTenant(tenantId, 'SELECT * FROM programs WHERE tenant_id = $1', [tenantId])).rows.map(rowToProgram);
  return rows
    .filter((p) => p.tenantId === tenantId && (opts.includeArchived || p.archivedAt === null))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
}

/** One program of the tenant, or null when it does not exist or belongs to another tenant (the two are indistinguishable). */
export async function getProgram(tenantId: string, id: string): Promise<Program | null> {
  if (typeof id !== 'string' || id === '') return null;
  if (isMemory()) {
    const p = memoryPrograms.get(id);
    return p && p.tenantId === tenantId ? p : null;
  }
  const res = await queryWithTenant(tenantId, 'SELECT * FROM programs WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return res.rows[0] ? rowToProgram(res.rows[0]) : null;
}

function validName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 255) throw new ProgramError('invalid_name', 'A program name is 1 to 255 characters');
  return name;
}

const nameTaken = (): ProgramError => new ProgramError('program_name_taken', 'A program with this name already exists (names are compared ignoring case)');

/** Whether a program of the tenant already has this name, ignoring case; `exceptId` leaves one program out (a rename). */
async function isNameTaken(tenantId: string, name: string, exceptId?: string): Promise<boolean> {
  return (await listPrograms(tenantId, { includeArchived: true })).some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Creates a program. The framework must be one the tenant has enabled (a tenant with no tenant record, the development fallback, is not
 * restricted); the baseline applies to NIST SP 800-53 only (LOW, MODERATE or HIGH, MODERATE when omitted); names are unique per tenant
 * ignoring case; a tenant holds at most 50 programs. The seed is blank, or a clone of another program of the tenant (cloneProgramContent;
 * `cloner` is who the copied rows are recorded under in the history, the requesting user).
 */
export async function createProgram(tenantId: string, input: NewProgramInput, createdBy: string | null, cloner?: ControlChangeActor): Promise<Program> {
  const name = validName(input.name);
  const frameworkId = programFramework(input.frameworkId);
  const enabled = (await getTenantProgram(tenantId))?.enabledFrameworks;
  if (!frameworkId || (enabled && !enabled.some((f) => programFramework(f) === frameworkId))) {
    throw new ProgramError('framework_not_enabled', `Framework ${String(input.frameworkId)} is not enabled for this tenant`);
  }
  let baseline: ProgramBaseline | null = null;
  const rawBaseline = typeof input.baseline === 'string' ? input.baseline.trim().toUpperCase() : input.baseline;
  if (frameworkId === 'NIST_800_53_REV5') {
    baseline = rawBaseline === undefined || rawBaseline === null || rawBaseline === '' ? 'MODERATE' : ((PROGRAM_BASELINES as readonly string[]).includes(rawBaseline) ? (rawBaseline as ProgramBaseline) : null);
    if (!baseline) throw new ProgramError('invalid_baseline', 'The baseline of a NIST SP 800-53 program is LOW, MODERATE or HIGH');
  } else if (rawBaseline !== undefined && rawBaseline !== null && rawBaseline !== '') {
    throw new ProgramError('invalid_baseline', 'Only a NIST SP 800-53 program has a baseline');
  }
  const cloneFrom = input.seed?.cloneFrom;
  if (cloneFrom !== undefined && cloneFrom !== null && typeof cloneFrom !== 'string') throw new ProgramError('program_not_found', 'Program to clone from not found');

  await ensureDefaultProgram(tenantId);
  // The source must be a program of this tenant (another tenant's id is as unknown as a made-up one)
  const source = cloneFrom ? await requireProgram(tenantId, cloneFrom) : null;
  if (await isNameTaken(tenantId, name)) throw nameTaken();
  if ((await listPrograms(tenantId, { includeArchived: true })).length >= MAX_PROGRAMS_PER_TENANT) {
    throw new ProgramError('program_limit', `A tenant holds at most ${MAX_PROGRAMS_PER_TENANT} programs`);
  }

  const description = typeof input.description === 'string' ? input.description : '';
  const systemBoundarySummary = typeof input.systemBoundarySummary === 'string' ? input.systemBoundarySummary : '';
  const by = createdBy ? createdBy.slice(0, 255) : null;
  let program: Program;
  if (isMemory()) {
    const now = new Date().toISOString();
    program = {
      id: crypto.randomUUID(), tenantId, name, description, frameworkId, baseline, systemBoundarySummary,
      isDefault: false, archivedAt: null, createdBy: by, createdAt: now, updatedAt: now,
    };
    memoryPrograms.set(program.id, program);
  } else {
    try {
      const res = await queryWithTenant(
        tenantId,
        `INSERT INTO programs (tenant_id, name, description, framework_id, baseline, system_boundary_summary, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [tenantId, name, description, frameworkId, baseline, systemBoundarySummary, by]
      );
      program = rowToProgram(res.rows[0]);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw nameTaken();
      throw err;
    }
  }
  if (source) {
    try {
      await cloneProgramContent(source, program, cloner ?? { source: 'human', actor: by ?? 'System', userId: null });
    } catch (err) {
      await deleteProgram(tenantId, program.id).catch(() => undefined); // do not leave a half-seeded program behind
      throw err;
    }
  }
  return program;
}

/** The controls a program's framework and baseline define (the whole catalog without a baseline). */
function catalogIds(program: Program): Set<string> {
  return new Set(getFrameworkControls(program.frameworkId, program.baseline ?? 'ALL_CONTROLS').map((c) => c.id));
}

const DEFAULT_ROLE = 'IT / Security Lead';

/**
 * Seeds `target` from `source` (both programs of one tenant): the implementation notes (vulnerability-management snapshot blocks
 * stripped) and the responsible role of each control, with the status reset to NOT_STARTED. A control of the target's catalog is copied
 * when the source's catalog has the same id, or when exactly one control of the source's catalog is an EXACT / EQUIVALENT crosswalk
 * match for it (the copy is then written under the target's id). Nothing else is copied: no evidence, SSP imports or POA&M items, and
 * nothing for a control with neither notes nor a role of its own. Each copied row records a history event from `who`. Returns how many
 * controls were copied.
 */
export async function cloneProgramContent(source: Program, target: Program, who: ControlChangeActor): Promise<number> {
  if (source.tenantId !== target.tenantId) throw new ProgramError('program_not_found', 'Program not found');
  const tenantId = target.tenantId;
  const rows = await readControlAssessments({ tenantId, programId: source.id });
  const inSource = catalogIds(source);
  let copied = 0;
  for (const targetId of catalogIds(target)) {
    let sourceId: string | null = null;
    if (inSource.has(targetId)) sourceId = targetId;
    else {
      const matches = getEquivalentControlIds(targetId).filter((id) => inSource.has(id));
      if (matches.length === 1) sourceId = matches[0];
    }
    const row = sourceId ? rows.get(sourceId) : undefined;
    if (!row) continue;
    const notes = stripDelimitedBlocks(row.notes);
    if (notes.trim() === '' && row.role === DEFAULT_ROLE) continue;
    await writeControlAssessment(
      { tenantId, programId: target.id },
      targetId,
      () => ({ status: 'NOT_STARTED', notes, role: row.role, updatedBy: who.actor }),
      who
    );
    copied++;
  }
  return copied;
}

/**
 * The numbers a program card shows. total: the controls of the program's framework and baseline; documented: those with notes
 * (outside the vulnerability-management snapshot blocks) or the status MET; evidence: files uploaded to the program (not inherited
 * copies); openPoam: open and in-progress POA&M items.
 */
export async function getProgramMetrics(program: Program): Promise<ProgramMetrics> {
  const scope = { tenantId: program.tenantId, programId: program.id };
  const catalog = catalogIds(program);
  let documented = 0;
  for (const [controlId, a] of await readControlAssessments(scope)) {
    if (catalog.has(controlId) && (a.status === 'MET' || stripDelimitedBlocks(a.notes).trim() !== '')) documented++;
  }
  const usage = await countProgramUsage(scope);
  return { documented, total: catalog.size, evidence: usage.evidence, openPoam: await countOpenPoamItems(scope) };
}

async function requireProgram(tenantId: string, id: string): Promise<Program> {
  const program = await getProgram(tenantId, id);
  if (!program) throw new ProgramError('program_not_found', 'Program not found');
  return program;
}

/** Edits the name, description and boundary summary. The framework and the baseline cannot change; an archived program takes no writes. */
export async function updateProgram(tenantId: string, id: string, patch: ProgramPatch): Promise<Program> {
  const current = await requireProgram(tenantId, id);
  if (current.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be edited');
  if (patch.frameworkId !== undefined && programFramework(patch.frameworkId) !== current.frameworkId) {
    throw new ProgramError('framework_immutable', 'The framework of a program cannot be changed after creation');
  }
  if (patch.baseline !== undefined) {
    const wanted = typeof patch.baseline === 'string' ? (patch.baseline.trim().toUpperCase() || null) : patch.baseline;
    if (wanted !== current.baseline) throw new ProgramError('invalid_baseline', 'The baseline of a program cannot be changed after creation');
  }
  const name = patch.name === undefined ? current.name : validName(patch.name);
  if (name.toLowerCase() !== current.name.toLowerCase() && (await isNameTaken(tenantId, name, id))) throw nameTaken();
  const description = typeof patch.description === 'string' ? patch.description : current.description;
  const summary = typeof patch.systemBoundarySummary === 'string' ? patch.systemBoundarySummary : current.systemBoundarySummary;

  if (isMemory()) {
    const next: Program = { ...current, name, description, systemBoundarySummary: summary, updatedAt: new Date().toISOString() };
    memoryPrograms.set(id, next);
    return next;
  }
  try {
    const res = await queryWithTenant(
      tenantId,
      `UPDATE programs SET name = $3, description = $4, system_boundary_summary = $5, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, id, name, description, summary]
    );
    if (!res.rows[0]) throw new ProgramError('program_not_found', 'Program not found');
    return rowToProgram(res.rows[0]);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw nameTaken();
    throw err;
  }
}

async function setArchived(tenantId: string, id: string, archived: boolean): Promise<Program> {
  const current = await requireProgram(tenantId, id);
  if (current.isDefault) throw new ProgramError('program_is_default', 'The default program cannot be archived');
  if ((current.archivedAt !== null) === archived) return current;
  if (isMemory()) {
    const now = new Date().toISOString();
    const next: Program = { ...current, archivedAt: archived ? now : null, updatedAt: now };
    memoryPrograms.set(id, next);
    return next;
  }
  const res = await queryWithTenant(
    tenantId,
    `UPDATE programs SET archived_at = ${archived ? 'NOW()' : 'NULL'}, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND NOT is_default
      RETURNING *`,
    [tenantId, id]
  );
  if (!res.rows[0]) throw new ProgramError('program_not_found', 'Program not found');
  return rowToProgram(res.rows[0]);
}

/** Archive is the normal way to retire a program: its data stays readable and takes no writes. The default program cannot be archived. */
export const archiveProgram = (tenantId: string, id: string): Promise<Program> => setArchived(tenantId, id, true);
export const unarchiveProgram = (tenantId: string, id: string): Promise<Program> => setArchived(tenantId, id, false);

/** What a program holds that keeps it from being deleted: evidence files (not the inherited copies), SSP import jobs and POA&M items. */
export async function countProgramUsage(scope: ProgramScope): Promise<ProgramUsage> {
  const { tenantId, programId } = scope;
  const params = [tenantId, programId];
  let evidence: number;
  let imports: number;
  if (isMemory()) {
    // The emulator answers with whole rows (WHERE is not evaluated): count the program's own base rows
    const rows = (await queryWithProgram(scope, 'SELECT * FROM evidence_metadata WHERE tenant_id = $1 AND program_id = $2', params)).rows;
    evidence = rows.filter((r) => r.tenant_id === tenantId && r.program_id === programId && r.sync_status !== 'inherited').length;
    imports = 0; // the SSP import store in memory is not program-aware yet
  } else {
    const ev = await queryWithProgram(scope, "SELECT COUNT(*)::int AS n FROM evidence_metadata WHERE tenant_id = $1 AND program_id = $2 AND sync_status <> 'inherited'", params);
    const im = await queryWithProgram(scope, 'SELECT COUNT(*)::int AS n FROM ssp_import_jobs WHERE tenant_id = $1 AND program_id = $2', params);
    evidence = Number(ev.rows[0]?.n ?? 0);
    imports = Number(im.rows[0]?.n ?? 0);
  }
  return { evidence, imports, poam: await countPoamItems(scope) };
}

/**
 * Deletes a program that holds nothing: never the default program, never one with evidence, SSP imports or POA&M items (the foreign
 * keys are RESTRICT for those as well). Its control answers go with it; the history events stay as invisible history.
 */
export async function deleteProgram(tenantId: string, id: string): Promise<void> {
  const current = await requireProgram(tenantId, id);
  if (current.isDefault) throw new ProgramError('program_is_default', 'The default program cannot be deleted');
  const usage = await countProgramUsage({ tenantId, programId: id });
  if (usage.evidence + usage.imports + usage.poam > 0) {
    throw new ProgramError('program_not_empty', 'The program still holds evidence, SSP imports or POA&M items', { ...usage });
  }
  if (isMemory()) {
    // the answers of the program go with it (in PostgreSQL the foreign key cascades); the history events stay
    await queryWithProgram({ tenantId, programId: id }, 'DELETE FROM control_assessments WHERE tenant_id = $1 AND program_id = $2', [tenantId, id]);
    memoryPrograms.delete(id);
    return;
  }
  try {
    await queryWithTenant(tenantId, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2 AND NOT is_default', [tenantId, id]);
  } catch (err) {
    if ((err as { code?: string })?.code === '23503') throw new ProgramError('program_not_empty', 'The program still holds evidence, SSP imports or POA&M items', { ...usage });
    throw err;
  }
}
