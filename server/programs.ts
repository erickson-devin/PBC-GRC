import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, getTenantFrameworkPolicy, pool, queryWithProgram, queryWithTenant, type ProgramScope, type SqlParam } from './db';
import { PROGRAM_FRAMEWORK_IDS } from './schema';
import { readControlAssessments, writeControlAssessment, type ControlChangeActor } from './controlAssessments';
import { __deleteProgramObjectivesForMemory, cloneObjectives } from './controlObjectives';
import { __deleteProgramSspMetadataForMemory } from './sspMetadata';
import { __deleteUserDefaultsForProgramMemory, __resetUserProgramDefaultsForTests } from './userProgramDefaults';
import { stripDelimitedBlocks } from './vm/snapshot';
import { countOpenPoamItems, countPoamItems } from './vm/findingsStore';
import { getFrameworkControls } from '../src/data/frameworks';
import { getEquivalentControlIds } from '../src/data/frameworks/controlMappings';
import { PROGRAM_SCOPING_KEYS, normalizeProgramScoping, programFrameworkControls, scopingToOverlays } from '../src/data/programScope';
import type { ComplianceFramework, OverlayFilters } from '../src/types/framework';
import type { ProgramScoping } from '../src/types/program';

/**
 * Programs: a tenant's authorization boundaries (an ATO effort or project). Each program has one framework and, for NIST SP 800-53,
 * one baseline; control answers, evidence, SSP imports and POA&M items belong to exactly one program. A tenant starts with NO program:
 * the first one created becomes the organization default (`is_default`, a movable fallback that also adopts the rows written before
 * programs existed). Each user may pick a personal default on top of it (userProgramDefaults.ts).
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
  /** The NIST SP 800-53B privacy baseline as an add-on to `baseline` (NIST programs only). Immutable; false for every other program. */
  privacyBaseline: boolean;
  systemBoundarySummary: string;
  /** The overlays of the program (NIST SP 800-53 only): the switches that are on, `{}` otherwise. Booleans only. */
  scoping: ProgramScoping;
  /** The tenant's VM target: receives the vulnerability-management snapshots and POA&M items. At most one per tenant, CMMC_L1 / CMMC_L2 only. */
  vmTarget: boolean;
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
  | 'program_not_found'
  | 'program_required'
  | 'program_archived'
  | 'framework_immutable'
  | 'program_not_empty'
  | 'invalid_scoping'
  | 'scoping_conflict'
  | 'invalid_vm_target'
  | 'invalid_asset_ids'
  | 'unknown_assets'
  | 'program_is_vm_target'
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
  /** NIST SP 800-53 only: adds the SP 800-53B privacy baseline to the security baseline. Absent, null or false is none. */
  privacyBaseline?: boolean | null;
  /** NIST SP 800-53 only: the overlays that are on (see normalizeProgramScoping). Absent is none. */
  scoping?: unknown;
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
  /** Immutable, like frameworkId. */
  privacyBaseline?: boolean | null;
  /** Mutable (the owner or an admin): replaces the scoping as a whole. */
  scoping?: unknown;
  /** The overlays the client last saw; a mismatch is scoping_conflict and nothing is written. Absent skips the check. */
  expectedScoping?: unknown;
}

/** Who made a change, as the program events record it. */
export interface ProgramActor {
  actor: string;
  userId: string | null;
}

export type ProgramEventKind = 'scoping_set' | 'scoping_changed' | 'vm_target_set' | 'vm_target_cleared' | 'assets_changed' | 'ssp_metadata_changed';

/** One entry of a program's history. Holds booleans and ids only (never a name or a description), so it carries no CUI. */
export interface ProgramEvent {
  id: string;
  tenantId: string;
  programId: string;
  kind: ProgramEventKind;
  actor: string;
  actorUserId: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown>;
  createdAt: string;
}

export type ProgramUsage = { evidence: number; imports: number; poam: number };
/** What the program page shows for a program: control coverage, evidence files (not the inherited copies) and open POA&M items. */
export type ProgramMetrics = { documented: number; total: number; evidence: number; openPoam: number };
export type MigrationCounts = Record<ProgramScopedTable, number> & { total: number };

const memoryPrograms = new Map<string, Program>(); // key: id
const migratedTenants = new Set<string>(); // tenants whose legacy rows were adopted by their default program in this process
const memoryProgramEvents: ProgramEvent[] = []; // oldest first; the history outlives a deleted program, as in PostgreSQL (no foreign key)

/** Test hook. */
export function __resetProgramsForTests(): void {
  memoryPrograms.clear();
  memoryProgramEvents.length = 0;
  migratedTenants.clear();
  __resetUserProgramDefaultsForTests();
}

const isMemory = (): boolean => getDbMode() === 'memory';

let lastMemoryCreatedMs = 0;
/** Memory only: a creation time that is later than every earlier one, so "the oldest program" is never a tie broken by a random id. */
function nextMemoryCreatedAt(): string {
  lastMemoryCreatedMs = Math.max(Date.now(), lastMemoryCreatedMs + 1);
  return new Date(lastMemoryCreatedMs).toISOString();
}
const iso = (v: unknown): string => new Date(v as string).toISOString();
const FRAMEWORK_ALIASES: Record<string, string> = { 'nist-800-53-r5': 'NIST_800_53_REV5' };

/** The canonical framework id a program may carry, or null when it is not one of the five. */
function programFramework(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const canonical = FRAMEWORK_ALIASES[id.trim().toLowerCase()] ?? id.trim();
  return (PROGRAM_FRAMEWORK_IDS as readonly string[]).includes(canonical) ? canonical : null;
}

/** The switches of a stored scoping that are on; the database CHECK already keeps anything else out. */
function scopingFromRow(raw: unknown): ProgramScoping {
  const out: ProgramScoping = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of PROGRAM_SCOPING_KEYS) if ((raw as Record<string, unknown>)[key] === true) out[key] = true;
  }
  return out;
}

const sameScoping = (a: ProgramScoping, b: ProgramScoping): boolean => PROGRAM_SCOPING_KEYS.every((k) => Boolean(a[k]) === Boolean(b[k]));

function rowToProgram(r: pg.QueryResultRow): Program {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description ?? '',
    frameworkId: r.framework_id,
    baseline: (r.baseline ?? null) as ProgramBaseline | null,
    privacyBaseline: r.privacy_baseline === true,
    systemBoundarySummary: r.system_boundary_summary ?? '',
    scoping: scopingFromRow(r.scoping),
    vmTarget: r.vm_target === true,
    isDefault: Boolean(r.is_default),
    archivedAt: r.archived_at ? iso(r.archived_at) : null,
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function rowToEvent(r: pg.QueryResultRow): ProgramEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    programId: r.program_id,
    kind: r.kind,
    actor: r.actor,
    actorUserId: r.actor_user_id ?? null,
    oldValue: r.old_value ?? null,
    newValue: r.new_value ?? {},
    createdAt: iso(r.created_at),
  };
}

/** Records one event in a transaction (PostgreSQL): the program policy of program_events needs the program as the current one. */
export async function insertEventTx(q: Query, tenantId: string, programId: string, kind: ProgramEventKind, who: ProgramActor, oldValue: Record<string, unknown> | null, newValue: Record<string, unknown>): Promise<void> {
  await q('SELECT set_config($1, $2, true)', ['app.current_program_id', programId]);
  await q(
    `INSERT INTO program_events (tenant_id, program_id, kind, actor, actor_user_id, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [tenantId, programId, kind, who.actor.slice(0, 255), who.userId ? who.userId.slice(0, 128) : null, oldValue === null ? null : JSON.stringify(oldValue), JSON.stringify(newValue)]
  );
}

export function pushMemoryEvent(tenantId: string, programId: string, kind: ProgramEventKind, who: ProgramActor, oldValue: Record<string, unknown> | null, newValue: Record<string, unknown>): void {
  memoryProgramEvents.push({
    id: crypto.randomUUID(), tenantId, programId, kind, actor: who.actor.slice(0, 255), actorUserId: who.userId ? who.userId.slice(0, 128) : null,
    oldValue, newValue, createdAt: new Date().toISOString(),
  });
}

/** A program's history, newest first (at most `limit`, 1 to 500, 100 by default), through the program policy of program_events. */
export async function listProgramEvents(scope: ProgramScope, limit = 100): Promise<ProgramEvent[]> {
  const n = Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 100)));
  if (isMemory()) {
    return memoryProgramEvents.filter((e) => e.tenantId === scope.tenantId && e.programId === scope.programId).reverse().slice(0, n);
  }
  const res = await queryWithProgram(
    scope,
    'SELECT * FROM program_events WHERE tenant_id = $1 AND program_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    [scope.tenantId, scope.programId, n]
  );
  return res.rows.map(rowToEvent);
}

export type Query = (text: string, params?: SqlParam[]) => Promise<pg.QueryResult>;

/** One PostgreSQL transaction under the tenant's RLS context. */
export async function inTenantTx<T>(tenantId: string, fn: (q: Query) => Promise<T>): Promise<T> {
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

/**
 * Finds the tenant's default program or creates the legacy one (idempotent, safe against a concurrent creator). Does not migrate.
 * Only the operator backfill (migrateTenantToPrograms) may create it: a request never does.
 */
async function resolveDefaultProgram(tenantId: string): Promise<Program> {
  if (isMemory()) {
    const existing = [...memoryPrograms.values()].find((p) => p.tenantId === tenantId && p.isDefault);
    if (existing) return existing;
    const { frameworkId, baseline } = defaultFramework((await getTenantFrameworkPolicy(tenantId))?.primaryFramework);
    const now = new Date().toISOString();
    const program: Program = {
      id: crypto.randomUUID(),
      tenantId,
      name: DEFAULT_PROGRAM_NAME,
      description: '',
      frameworkId,
      baseline,
      privacyBaseline: false,
      systemBoundarySummary: '',
      scoping: {},
      vmTarget: false,
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

/** The tenant's organization default program (the active one flagged `is_default`), or null when it has none. Never creates a program. */
export async function getTenantDefaultProgram(tenantId: string): Promise<Program | null> {
  if (isMemory()) return [...memoryPrograms.values()].find((p) => p.tenantId === tenantId && p.isDefault && p.archivedAt === null) ?? null;
  const res = await queryWithTenant(tenantId, 'SELECT * FROM programs WHERE tenant_id = $1 AND is_default AND archived_at IS NULL', [tenantId]);
  return res.rows[0] ? rowToProgram(res.rows[0]) : null;
}

/**
 * The first call per tenant and process, when the tenant has a default program: gives the rows written before programs existed (no
 * program_id) to that program (migrateTenantToPrograms). Without a default there is nothing to give them to, and nothing is done.
 * Run it before the default moves (archive, delete, change): the row policy maps a row with no program to the default program.
 */
export async function adoptLegacyRowsOnce(tenantId: string): Promise<void> {
  if (migratedTenants.has(tenantId)) return;
  if (!(await getTenantDefaultProgram(tenantId))) return;
  await migrateTenantToPrograms(tenantId);
  migratedTenants.add(tenantId);
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
 * `cloner` is who the copied rows are recorded under in the history, the requesting user). The first program of a tenant (or the first
 * one when no active default is left) becomes the organization default.
 */
export async function createProgram(tenantId: string, input: NewProgramInput, createdBy: string | null, cloner?: ControlChangeActor): Promise<Program> {
  const name = validName(input.name);
  const frameworkId = programFramework(input.frameworkId);
  const enabled = (await getTenantFrameworkPolicy(tenantId))?.enabledFrameworks;
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
  const rawPrivacy = input.privacyBaseline;
  if (rawPrivacy !== undefined && rawPrivacy !== null && typeof rawPrivacy !== 'boolean') {
    throw new ProgramError('invalid_baseline', 'The privacy baseline is true or false');
  }
  const privacyBaseline = rawPrivacy === true;
  if (privacyBaseline && frameworkId !== 'NIST_800_53_REV5') {
    throw new ProgramError('invalid_baseline', 'Only a NIST SP 800-53 program has a privacy baseline');
  }
  const scopingCheck = normalizeProgramScoping(input.scoping, { frameworkId, privacyBaseline });
  if (!scopingCheck.ok) throw new ProgramError('invalid_scoping', scopingCheck.error);
  const scoping = scopingCheck.value;
  const cloneFrom = input.seed?.cloneFrom;
  if (cloneFrom !== undefined && cloneFrom !== null && typeof cloneFrom !== 'string') throw new ProgramError('program_not_found', 'Program to clone from not found');

  // The source must be a program of this tenant (another tenant's id is as unknown as a made-up one)
  const source = cloneFrom ? await requireProgram(tenantId, cloneFrom) : null;
  if (await isNameTaken(tenantId, name)) throw nameTaken();
  if ((await listPrograms(tenantId, { includeArchived: true })).length >= MAX_PROGRAMS_PER_TENANT) {
    throw new ProgramError('program_limit', `A tenant holds at most ${MAX_PROGRAMS_PER_TENANT} programs`);
  }

  const description = typeof input.description === 'string' ? input.description : '';
  const systemBoundarySummary = typeof input.systemBoundarySummary === 'string' ? input.systemBoundarySummary : '';
  const by = createdBy ? createdBy.slice(0, 255) : null;
  const who: ProgramActor = { actor: by ?? cloner?.actor ?? 'System', userId: cloner?.userId ?? null };
  let program: Program;
  if (isMemory()) {
    const now = nextMemoryCreatedAt();
    // decided and stored with no await in between: two concurrent creations cannot both become the default
    const isDefault = ![...memoryPrograms.values()].some((p) => p.tenantId === tenantId && p.isDefault && p.archivedAt === null);
    program = {
      id: crypto.randomUUID(), tenantId, name, description, frameworkId, baseline, privacyBaseline, systemBoundarySummary,
      scoping, vmTarget: false, isDefault, archivedAt: null, createdBy: by, createdAt: now, updatedAt: now,
    };
    memoryPrograms.set(program.id, program);
    pushMemoryEvent(tenantId, program.id, 'scoping_set', who, null, scoping);
  } else {
    // the program and its first event in one transaction: a program never exists without the record of how it was scoped.
    // It is the default when the tenant has no active default yet; a concurrent first creation loses on unq_programs_default and retries as a plain program.
    const insert = (mayBeDefault: boolean): Promise<Program> =>
      inTenantTx(tenantId, async (q) => {
        const res = await q(
          `INSERT INTO programs (tenant_id, name, description, framework_id, baseline, privacy_baseline, system_boundary_summary, scoping, created_by, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::boolean AND NOT EXISTS (SELECT 1 FROM programs WHERE tenant_id = $1 AND is_default))
           RETURNING *`,
          [tenantId, name, description, frameworkId, baseline, privacyBaseline, systemBoundarySummary, JSON.stringify(scoping), by, mayBeDefault]
        );
        const created = rowToProgram(res.rows[0]);
        await insertEventTx(q, tenantId, created.id, 'scoping_set', who, null, scoping);
        return created;
      });
    try {
      try {
        program = await insert(true);
      } catch (err) {
        if ((err as { code?: string; constraint?: string })?.code !== '23505' || (err as { constraint?: string }).constraint !== 'unq_programs_default') throw err;
        program = await insert(false);
      }
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw nameTaken();
      throw err;
    }
  }
  if (program.isDefault) await adoptLegacyRowsOnce(tenantId); // a first program takes over the rows written before programs existed
  if (source) {
    try {
      await cloneProgramContent(source, program, cloner ?? { source: 'clone', actor: by ?? 'System', userId: null });
    } catch (err) {
      await deleteProgram(tenantId, program.id).catch(() => undefined); // do not leave a half-seeded program behind
      throw err;
    }
  }
  return program;
}

/** The controls a program's framework and baseline define (the whole catalog without a baseline), the privacy baseline's included when it has one. */
function catalogIds(program: Program): Set<string> {
  const controls = program.privacyBaseline
    ? programFrameworkControls({ framework: program.frameworkId as ComplianceFramework, baseline: program.baseline, privacyBaseline: true }, {} as OverlayFilters)
    : getFrameworkControls(program.frameworkId, program.baseline ?? 'ALL_CONTROLS');
  return new Set(controls.map((c) => c.id));
}

const DEFAULT_ROLE = 'IT / Security Lead';

/**
 * Seeds `target` from `source` (both programs of one tenant): the implementation notes (vulnerability-management snapshot blocks
 * stripped) and the responsible role of each control, with the status reset to NOT_STARTED. A control of the target's catalog is copied
 * when the source's catalog has the same id, or when exactly one control of the source's catalog is an EXACT / EQUIVALENT crosswalk
 * match for it (the copy is then written under the target's id). Nothing else is copied: no evidence, SSP imports or POA&M items, and
 * nothing for a control with neither notes nor a role of its own. Each copied row records a history event with source 'clone' and the actor of `who`. Returns how many
 * controls were copied. When both programs have the same framework the assessment objectives' narratives are copied too (status reset,
 * no evidence links; see cloneObjectives).
 */
export async function cloneProgramContent(source: Program, target: Program, who: ControlChangeActor): Promise<number> {
  if (source.tenantId !== target.tenantId) throw new ProgramError('program_not_found', 'Program not found');
  const tenantId = target.tenantId;
  const cloneActor: ControlChangeActor = { source: 'clone', actor: who.actor, userId: who.userId };
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
      cloneActor
    );
    copied++;
  }
  // The assessment objectives follow only a clone of the same framework (their ids belong to it): the narratives, never the status or evidence links.
  if (source.frameworkId === target.frameworkId) {
    const inTarget = catalogIds(target);
    await cloneObjectives({ tenantId, programId: source.id }, { tenantId, programId: target.id }, { source: 'clone', actor: who.actor, userId: who.userId }, (id) => inTarget.has(id));
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
  // the overlays of the program narrow the count (the card matches the matrix); a clone still copies the whole catalog (catalogIds)
  const catalog = PROGRAM_SCOPING_KEYS.some((k) => program.scoping[k])
    ? new Set(
        programFrameworkControls(
          { framework: program.frameworkId as ComplianceFramework, baseline: program.baseline, privacyBaseline: program.privacyBaseline },
          scopingToOverlays(program.scoping)
        ).map((c) => c.id)
      )
    : catalogIds(program);
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

/**
 * Edits the name, description, boundary summary and scoping. The framework and the baseline cannot change; an archived program takes no
 * writes. A scoping that differs from the stored one records a `scoping_changed` event (old and new switches, `who`); one that does not
 * records nothing.
 */
export async function updateProgram(tenantId: string, id: string, patch: ProgramPatch, who: ProgramActor = { actor: 'System', userId: null }): Promise<Program> {
  const current = await requireProgram(tenantId, id);
  if (current.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be edited');
  let wantedScoping: ProgramScoping | null = null; // null: leave the scoping as it is
  if (patch.scoping !== undefined) {
    const check = normalizeProgramScoping(patch.scoping, current);
    if (!check.ok) throw new ProgramError('invalid_scoping', check.error);
    wantedScoping = check.value;
  }
  let expected: ProgramScoping | null = null; // null: no stale-write check
  if (patch.expectedScoping !== undefined) {
    const check = normalizeProgramScoping(patch.expectedScoping, current);
    if (!check.ok) throw new ProgramError('invalid_scoping', check.error);
    expected = check.value;
  }
  if (patch.frameworkId !== undefined && programFramework(patch.frameworkId) !== current.frameworkId) {
    throw new ProgramError('framework_immutable', 'The framework of a program cannot be changed after creation');
  }
  if (patch.baseline !== undefined) {
    const wanted = typeof patch.baseline === 'string' ? (patch.baseline.trim().toUpperCase() || null) : patch.baseline;
    if (wanted !== current.baseline) throw new ProgramError('invalid_baseline', 'The baseline of a program cannot be changed after creation');
  }
  if (patch.privacyBaseline !== undefined && (patch.privacyBaseline === true) !== current.privacyBaseline) {
    throw new ProgramError('invalid_baseline', 'The privacy baseline cannot be changed after creation');
  }
  const name = patch.name === undefined ? current.name : validName(patch.name);
  if (name.toLowerCase() !== current.name.toLowerCase() && (await isNameTaken(tenantId, name, id))) throw nameTaken();
  const description = typeof patch.description === 'string' ? patch.description : current.description;
  const summary = typeof patch.systemBoundarySummary === 'string' ? patch.systemBoundarySummary : current.systemBoundarySummary;

  if (isMemory()) {
    const fresh = memoryPrograms.get(id) ?? current; // no await between this read and the set: the compare-and-write is atomic
    if (expected && !sameScoping(fresh.scoping, expected)) throw new ProgramError('scoping_conflict', 'The overlays of this program changed meanwhile');
    const scoping = wantedScoping ?? fresh.scoping;
    const next: Program = { ...fresh, name, description, systemBoundarySummary: summary, scoping, updatedAt: new Date().toISOString() };
    memoryPrograms.set(id, next);
    if (!sameScoping(fresh.scoping, scoping)) pushMemoryEvent(tenantId, id, 'scoping_changed', who, fresh.scoping, scoping);
    return next;
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const locked = await q('SELECT * FROM programs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
      if (!locked.rows[0]) throw new ProgramError('program_not_found', 'Program not found');
      const before = rowToProgram(locked.rows[0]);
      if (before.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be edited');
      if (expected && !sameScoping(before.scoping, expected)) throw new ProgramError('scoping_conflict', 'The overlays of this program changed meanwhile');
      const scoping = wantedScoping ?? before.scoping;
      const res = await q(
        `UPDATE programs SET name = $3, description = $4, system_boundary_summary = $5, scoping = $6::jsonb, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, id, name, description, summary, JSON.stringify(scoping)]
      );
      if (!sameScoping(before.scoping, scoping)) await insertEventTx(q, tenantId, id, 'scoping_changed', who, before.scoping, scoping);
      return rowToProgram(res.rows[0]);
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw nameTaken();
    throw err;
  }
}

/** The program that takes over as the organization default when there is none: the oldest active one (ties by id), or null. */
const successorOf = (programs: Program[]): Program | null =>
  programs.filter((p) => p.archivedAt === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;

/** Memory: when the tenant has no active default, the oldest active program becomes it. No await: callers rely on it being atomic. */
function promoteSuccessorInMemory(tenantId: string): void {
  const programs = [...memoryPrograms.values()].filter((p) => p.tenantId === tenantId);
  if (programs.some((p) => p.isDefault && p.archivedAt === null)) return;
  const next = successorOf(programs);
  if (next) memoryPrograms.set(next.id, { ...next, isDefault: true, updatedAt: new Date().toISOString() });
}

/** PostgreSQL, inside a tenant transaction that holds the program rows locked: the same promotion as promoteSuccessorInMemory. */
async function promoteSuccessorTx(q: Query, tenantId: string): Promise<void> {
  const programs = (await q('SELECT * FROM programs WHERE tenant_id = $1', [tenantId])).rows.map(rowToProgram);
  if (programs.some((p) => p.isDefault && p.archivedAt === null)) return;
  const next = successorOf(programs);
  if (next) await q('UPDATE programs SET is_default = TRUE, updated_at = NOW() WHERE tenant_id = $1 AND id = $2', [tenantId, next.id]);
}

async function setArchived(tenantId: string, id: string, archived: boolean): Promise<Program> {
  const current = await requireProgram(tenantId, id);
  if (archived && current.vmTarget) throw new ProgramError('program_is_vm_target', 'The VM target program cannot be archived: choose another target first');
  if ((current.archivedAt !== null) === archived) return current;
  await adoptLegacyRowsOnce(tenantId); // before the default can move: the legacy rows follow the default program
  if (isMemory()) {
    const fresh = memoryPrograms.get(id) ?? current; // no await from here on: the whole change is atomic
    const now = new Date().toISOString();
    if (archived) {
      // is_default is cleared in the same step (an archived program is never the default), then the oldest active program takes over
      memoryPrograms.set(id, { ...fresh, archivedAt: now, isDefault: false, updatedAt: now });
      promoteSuccessorInMemory(tenantId);
      return memoryPrograms.get(id) as Program;
    }
    const hasDefault = [...memoryPrograms.values()].some((p) => p.tenantId === tenantId && p.isDefault && p.archivedAt === null);
    const next: Program = { ...fresh, archivedAt: null, isDefault: !hasDefault, updatedAt: now };
    memoryPrograms.set(id, next);
    return next;
  }
  return inTenantTx(tenantId, async (q) => {
    const rows = (await q('SELECT * FROM programs WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows.map(rowToProgram);
    const locked = rows.find((p) => p.id === id);
    if (!locked) throw new ProgramError('program_not_found', 'Program not found');
    if ((locked.archivedAt !== null) === archived) return locked;
    if (archived) {
      // clear is_default in the same UPDATE (CHECK programs_default_not_archived), then promote: the unique index allows one default
      await q('UPDATE programs SET archived_at = NOW(), is_default = FALSE, updated_at = NOW() WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      await promoteSuccessorTx(q, tenantId);
      return rowToProgram((await q('SELECT * FROM programs WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0]);
    }
    const hasDefault = rows.some((p) => p.isDefault && p.archivedAt === null);
    const res = await q('UPDATE programs SET archived_at = NULL, is_default = $3, updated_at = NOW() WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId, id, !hasDefault]);
    return rowToProgram(res.rows[0]);
  });
}

/**
 * Archive is the normal way to retire a program: its data stays readable and takes no writes. Archiving the default program (or the last
 * active one) is allowed: the oldest active program takes over as the default, or the tenant is left with none. Unarchiving a program
 * when no active default exists makes it the default.
 */
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
 * Deletes a program that holds nothing: never one with evidence, SSP imports or POA&M items (the foreign keys are RESTRICT for those
 * as well). Its control answers go with it; the history events stay as invisible history. Deleting the default program promotes the
 * oldest active one (or leaves the tenant with none); the users' personal defaults pointing at it go with it.
 */
export async function deleteProgram(tenantId: string, id: string): Promise<void> {
  const current = await requireProgram(tenantId, id);
  if (current.vmTarget) throw new ProgramError('program_is_vm_target', 'The VM target program cannot be deleted: choose another target first');
  const usage = await countProgramUsage({ tenantId, programId: id });
  if (usage.evidence + usage.imports + usage.poam > 0) {
    throw new ProgramError('program_not_empty', 'The program still holds evidence, SSP imports or POA&M items', { ...usage });
  }
  if (isMemory()) {
    // the answers of the program go with it (in PostgreSQL the foreign key cascades); the history events stay
    await queryWithProgram({ tenantId, programId: id }, 'DELETE FROM control_assessments WHERE tenant_id = $1 AND program_id = $2', [tenantId, id]);
    __deleteProgramObjectivesForMemory({ tenantId, programId: id });
    __deleteProgramSspMetadataForMemory({ tenantId, programId: id });
    __deleteUserDefaultsForProgramMemory(tenantId, id);
    memoryPrograms.delete(id);
    promoteSuccessorInMemory(tenantId);
    return;
  }
  await adoptLegacyRowsOnce(tenantId);
  try {
    await inTenantTx(tenantId, async (q) => {
      await q('SELECT id FROM programs WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
      await q('DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [tenantId, id]); // user_program_defaults cascades
      await promoteSuccessorTx(q, tenantId);
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23503') throw new ProgramError('program_not_empty', 'The program still holds evidence, SSP imports or POA&M items', { ...usage });
    throw err;
  }
}

/**
 * Makes a program the organization default (the fallback landing program; one per tenant). The program must exist (program_not_found)
 * and not be archived (program_archived). Choosing the program that already is the default changes nothing.
 */
export async function setTenantDefaultProgram(tenantId: string, id: string): Promise<Program> {
  const chosen = await requireProgram(tenantId, id);
  if (chosen.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be the default');
  if (chosen.isDefault) return chosen;
  await adoptLegacyRowsOnce(tenantId); // the legacy rows follow the default program: they go to the old one before it moves
  if (isMemory()) {
    const fresh = memoryPrograms.get(id) ?? chosen; // no await from here on: the move is atomic
    if (fresh.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be the default');
    const now = new Date().toISOString();
    for (const p of [...memoryPrograms.values()]) if (p.tenantId === tenantId && p.isDefault && p.id !== id) memoryPrograms.set(p.id, { ...p, isDefault: false, updatedAt: now });
    const next: Program = { ...fresh, isDefault: true, updatedAt: now };
    memoryPrograms.set(id, next);
    return next;
  }
  return inTenantTx(tenantId, async (q) => {
    const rows = (await q('SELECT * FROM programs WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows.map(rowToProgram);
    const locked = rows.find((p) => p.id === id);
    if (!locked) throw new ProgramError('program_not_found', 'Program not found');
    if (locked.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be the default');
    // clear first: the unique index allows one default per tenant
    await q('UPDATE programs SET is_default = FALSE, updated_at = NOW() WHERE tenant_id = $1 AND is_default AND id <> $2', [tenantId, id]);
    const res = await q('UPDATE programs SET is_default = TRUE, updated_at = NOW() WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId, id]);
    return rowToProgram(res.rows[0]);
  });
}

/** Frameworks whose programs can receive vulnerability-management snapshots (the snapshot control set is CMMC). */
const VM_TARGET_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2'];

/**
 * The program that receives the tenant's vulnerability-management data: the active program flagged `vmTarget` (`explicit: true`), else
 * the organization default (`explicit: false`) but only when that is a CMMC Level 1 / Level 2 program. Null when neither exists (no
 * program yet, or the default is another framework and none is flagged): the data is then kept tenant-wide and nothing is written to a
 * program. Adopts the legacy rows on first use. Never creates a program.
 */
export async function resolveVmTargetProgram(tenantId: string): Promise<{ program: Program; explicit: boolean } | null> {
  await adoptLegacyRowsOnce(tenantId);
  const target = (await listPrograms(tenantId)).find((p) => p.vmTarget);
  if (target) return { program: target, explicit: true };
  const fallback = await getTenantDefaultProgram(tenantId);
  return fallback && VM_TARGET_FRAMEWORKS.includes(fallback.frameworkId) ? { program: fallback, explicit: false } : null;
}

/**
 * Makes a program the tenant's VM target (one per tenant: the flag of any other program is cleared). The program must exist, not be
 * archived (program_archived) and be CMMC_L1 / CMMC_L2 (invalid_vm_target); the default program qualifies when it is one. Existing
 * evidence, notes and POA&M items stay in the previous target: `openPoamInPrevious` counts that program's open items, so the caller can
 * warn. Records `vm_target_set` in the new target and `vm_target_cleared` in the program that lost the flag. Choosing the program that
 * already is the target changes and records nothing. `previousId` is the program that received the data until now (the default
 * program when no target was set), null when that is the program chosen or when there was no target at all.
 */
export async function setVmTargetProgram(
  tenantId: string,
  id: string,
  who: ProgramActor
): Promise<{ program: Program; previousId: string | null; openPoamInPrevious: number }> {
  const chosen = await requireProgram(tenantId, id);
  if (chosen.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be the VM target');
  if (!VM_TARGET_FRAMEWORKS.includes(chosen.frameworkId)) {
    throw new ProgramError('invalid_vm_target', 'Only a CMMC Level 1 or Level 2 program can be the VM target');
  }
  const before = await resolveVmTargetProgram(tenantId);
  const previousId = !before || before.program.id === id ? null : before.program.id;
  let program: Program;
  if (isMemory()) {
    if (chosen.vmTarget) return { program: chosen, previousId: null, openPoamInPrevious: 0 };
    const now = new Date().toISOString();
    const cleared = [...memoryPrograms.values()].filter((p) => p.tenantId === tenantId && p.vmTarget && p.id !== id);
    for (const p of cleared) memoryPrograms.set(p.id, { ...p, vmTarget: false, updatedAt: now });
    program = { ...chosen, vmTarget: true, updatedAt: now };
    memoryPrograms.set(id, program);
    pushMemoryEvent(tenantId, id, 'vm_target_set', who, { vmTarget: false }, { vmTarget: true });
    for (const p of cleared) pushMemoryEvent(tenantId, p.id, 'vm_target_cleared', who, { vmTarget: true }, { vmTarget: false });
  } else {
    const changed = await inTenantTx(tenantId, async (q) => {
      const rows = (await q('SELECT * FROM programs WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows.map(rowToProgram);
      const locked = rows.find((p) => p.id === id);
      if (!locked) throw new ProgramError('program_not_found', 'Program not found');
      if (locked.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be the VM target');
      if (locked.vmTarget) return { program: locked, cleared: [] as Program[], same: true };
      const cleared = rows.filter((p) => p.vmTarget && p.id !== id);
      // clear first: the unique index allows one target per tenant
      await q('UPDATE programs SET vm_target = FALSE, updated_at = NOW() WHERE tenant_id = $1 AND vm_target AND id <> $2', [tenantId, id]);
      const res = await q('UPDATE programs SET vm_target = TRUE, updated_at = NOW() WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId, id]);
      await insertEventTx(q, tenantId, id, 'vm_target_set', who, { vmTarget: false }, { vmTarget: true });
      for (const p of cleared) await insertEventTx(q, tenantId, p.id, 'vm_target_cleared', who, { vmTarget: true }, { vmTarget: false });
      return { program: rowToProgram(res.rows[0]), cleared, same: false };
    });
    if (changed.same) return { program: changed.program, previousId: null, openPoamInPrevious: 0 };
    program = changed.program;
  }
  const openPoamInPrevious = previousId ? await countOpenPoamItems({ tenantId, programId: previousId }) : 0;
  return { program, previousId, openPoamInPrevious };
}
