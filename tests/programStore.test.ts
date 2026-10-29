import './testEnv';
import { __resetMemoryTenantsForTests, __seedLegacyRowForTests, createTenantWithOwner, queryWithProgram, queryWithTenant } from '../server/db';
import { listControlAssessmentEvents } from '../server/controlAssessments';
import {
  DEFAULT_PROGRAM_NAME,
  MAX_PROGRAMS_PER_TENANT,
  ProgramError,
  __resetProgramsForTests,
  archiveProgram,
  countProgramUsage,
  createProgram,
  deleteProgram,
  ensureDefaultProgram,
  getProgram,
  getProgramMetrics,
  listProgramEvents,
  listPrograms,
  migrateTenantToPrograms,
  resolveVmTargetProgram,
  setVmTargetProgram,
  unarchiveProgram,
  updateProgram,
} from '../server/programs';
import { PROGRAM_FRAMEWORK_IDS } from '../server/schema';
import { FRAMEWORK_REGISTRY } from '../src/data/frameworks/frameworkRegistry';
import { programFrameworkControls } from '../src/data/programScope';
import type { OverlayFilters } from '../src/types/framework';

/**
 * The program (authorization boundary) data layer in the in-memory store: no server, no database. Covers the default program and its
 * framework / baseline, the validation codes, the 50-program cap, archive and delete rules, tenant isolation of getProgram, the lazy
 * backfill of legacy rows (migrateTenantToPrograms) and queryWithProgram isolation. The PostgreSQL side is covered by the DDL checks
 * in tests/dbSchema.test.ts and, against a real database, by `npm run db:verify-rls`.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

/** The ProgramError code a promise rejects with, or null when it resolves. */
async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ProgramError ? e.code : `unexpected: ${(e as Error).message}`;
  }
}

const owner = { userId: 'owner-1', email: 'owner@example.com', name: 'Owner' };
const mkTenant = (id: string, primaryFramework: string, enabledFrameworks: string[]) =>
  createTenantWithOwner({ id, name: id, systemName: `${id} system`, systemOwner: 'Owner', enabledFrameworks, primaryFramework }, owner);

const control = (tenantId: string, programId: string, controlId: string, status: string) =>
  [
    `INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes, responsible_role, updated_by, program_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, control_id) DO NOTHING RETURNING *`,
    [tenantId, controlId, status, `notes of ${programId}`, 'IT / Security Lead', 'tester', programId],
  ] as const;
const evidenceInsert = (tenantId: string, programId: string, id: string) =>
  [
    `INSERT INTO evidence_metadata (id, tenant_id, control_id, file_name, file_size, mime_type, gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12) RETURNING *`,
    [id, tenantId, 'AC.L1-3.1.1', 'e.pdf', 10, 'application/pdf', `/vault/${id}`, 'abc', 'local_storage', 'evidence', 'tester', programId],
  ] as const;

async function main() {
  __resetMemoryTenantsForTests();
  __resetProgramsForTests();

  console.log('--- The five framework ids are the registry ids ---');
  const registryIds = Object.keys(FRAMEWORK_REGISTRY).filter((k) => FRAMEWORK_REGISTRY[k].id === k);
  assert(JSON.stringify([...PROGRAM_FRAMEWORK_IDS].sort()) === JSON.stringify([...registryIds].sort()), 'PROGRAM_FRAMEWORK_IDS equals the canonical registry ids', registryIds);

  console.log('\n--- ensureDefaultProgram ---');
  const d1 = await ensureDefaultProgram('t1');
  const d1b = await ensureDefaultProgram('t1');
  const listed = await listPrograms('t1');
  assert(d1.id === d1b.id, 'twice -> the same program id');
  assert(listed.length === 1 && listed[0].id === d1.id, 'the tenant has exactly one program');
  assert(d1.isDefault === true && d1.name === DEFAULT_PROGRAM_NAME && d1.name === 'Default Authorization Boundary' && d1.archivedAt === null, 'it is the default, named Default Authorization Boundary, not archived', d1);
  assert(d1.tenantId === 't1' && /^[A-Za-z0-9_-]{1,64}$/.test(d1.id), 'it belongs to the tenant and its id is a valid identifier', d1.id);
  assert(d1.frameworkId === 'CMMC_L1' && d1.baseline === null, 'a tenant with no tenant record gets CMMC_L1 and no baseline', d1);
  await mkTenant('t-l2', 'CMMC_L2', ['CMMC_L2']);
  const dl2 = await ensureDefaultProgram('t-l2');
  assert(dl2.frameworkId === 'CMMC_L2' && dl2.baseline === null, 'a CMMC_L2 tenant gets CMMC_L2 and no baseline', dl2);
  await mkTenant('t-nist', 'NIST_800_53_REV5', ['NIST_800_53_REV5']);
  const dn = await ensureDefaultProgram('t-nist');
  assert(dn.frameworkId === 'NIST_800_53_REV5' && dn.baseline === 'MODERATE', 'a NIST tenant gets NIST_800_53_REV5 and baseline MODERATE', dn);

  console.log('\n--- createProgram validation ---');
  await mkTenant('t-val', 'CMMC_L2', ['CMMC_L2', 'NIST_800_53_REV5']);
  const base = { frameworkId: 'CMMC_L2' };
  assert((await codeOf(createProgram('t-val', { ...base, name: '' }, 'u'))) === 'invalid_name', "an empty name -> invalid_name");
  assert((await codeOf(createProgram('t-val', { ...base, name: '   ' }, 'u'))) === 'invalid_name', 'a blank name -> invalid_name');
  assert((await codeOf(createProgram('t-val', { ...base, name: 'x'.repeat(256) }, 'u'))) === 'invalid_name', 'a name of 256 characters -> invalid_name');
  assert((await codeOf(createProgram('t-val', { name: 'Soc', frameworkId: 'SOC_2_TYPE_II' }, 'u'))) === 'framework_not_enabled', 'a framework the tenant has not enabled -> framework_not_enabled');
  assert((await codeOf(createProgram('t-val', { name: 'Odd', frameworkId: 'NOT_A_FRAMEWORK' }, 'u'))) === 'framework_not_enabled', 'an unknown framework -> framework_not_enabled');
  assert((await codeOf(createProgram('t-val', { name: 'Priv', frameworkId: 'NIST_800_53_REV5', baseline: 'PRIVACY' }, 'u'))) === 'invalid_baseline', 'NIST with the PRIVACY baseline -> invalid_baseline');
  assert((await codeOf(createProgram('t-val', { name: 'Low', frameworkId: 'CMMC_L2', baseline: 'LOW' }, 'u'))) === 'invalid_baseline', 'CMMC_L2 with a baseline -> invalid_baseline');
  assert((await codeOf(createProgram('t-val', { name: 'Clone', frameworkId: 'CMMC_L2', seed: { cloneFrom: 'no-such-program' } }, 'u'))) === 'program_not_found', 'a clone seed naming an unknown source program -> program_not_found');
  const a = await createProgram('t-val', { name: '  Boundary A  ', frameworkId: 'CMMC_L2', description: 'd', systemBoundarySummary: 's' }, 'alice');
  assert(a.name === 'Boundary A' && a.frameworkId === 'CMMC_L2' && a.baseline === null && a.isDefault === false && a.createdBy === 'alice' && a.description === 'd' && a.systemBoundarySummary === 's', 'a valid program is created (name trimmed)', a);
  assert((await codeOf(createProgram('t-val', { ...base, name: 'boundary a' }, 'u'))) === 'program_name_taken', "'boundary a' after 'Boundary A' -> program_name_taken");
  assert((await codeOf(createProgram('t-val', { ...base, name: DEFAULT_PROGRAM_NAME.toUpperCase() }, 'u'))) === 'program_name_taken', 'the default program name is taken too');
  const n1 = await createProgram('t-val', { name: 'Nist High', frameworkId: 'NIST_800_53_REV5', baseline: 'high' }, 'u');
  const n2 = await createProgram('t-val', { name: 'Nist Default Baseline', frameworkId: 'nist-800-53-r5' }, 'u');
  assert(n1.baseline === 'HIGH' && n2.frameworkId === 'NIST_800_53_REV5' && n2.baseline === 'MODERATE', 'NIST takes LOW, MODERATE or HIGH (any case), MODERATE when omitted, and the registry alias is accepted', [n1.baseline, n2.baseline, n2.frameworkId]);
  assert((await listPrograms('t-val')).length === 4 && (await listPrograms('t-val'))[0].isDefault, 'the default program was created with the first program and is listed first');

  console.log('\n--- the 50-program cap ---');
  await mkTenant('t-cap', 'CMMC_L2', ['CMMC_L2']);
  await ensureDefaultProgram('t-cap');
  for (let i = 1; i < MAX_PROGRAMS_PER_TENANT; i++) await createProgram('t-cap', { name: `P${i}`, frameworkId: 'CMMC_L2' }, 'u');
  assert((await listPrograms('t-cap')).length === 50, 'default + 49 = 50 programs');
  assert((await codeOf(createProgram('t-cap', { name: 'P51', frameworkId: 'CMMC_L2' }, 'u'))) === 'program_limit', 'the 51st -> program_limit');

  console.log('\n--- update, archive, delete ---');
  const dVal = await ensureDefaultProgram('t-val');
  assert((await codeOf(archiveProgram('t-val', dVal.id))) === 'program_is_default', 'archiveProgram(default) -> program_is_default');
  assert((await codeOf(deleteProgram('t-val', dVal.id))) === 'program_is_default', 'deleteProgram(default) -> program_is_default');
  assert((await codeOf(archiveProgram('t-val', 'nope'))) === 'program_not_found', 'an unknown program -> program_not_found');
  const renamed = await updateProgram('t-val', a.id, { name: 'Boundary A2', description: 'new', systemBoundarySummary: 'sum' });
  assert(renamed.name === 'Boundary A2' && renamed.description === 'new' && renamed.systemBoundarySummary === 'sum' && renamed.frameworkId === 'CMMC_L2', 'name, description and summary can change', renamed);
  assert((await codeOf(updateProgram('t-val', a.id, { name: 'nist high' }))) === 'program_name_taken', 'a rename onto another program name (ignoring case) -> program_name_taken');
  assert((await codeOf(updateProgram('t-val', a.id, { name: '' }))) === 'invalid_name', 'an empty rename -> invalid_name');
  assert((await codeOf(updateProgram('t-val', a.id, { frameworkId: 'NIST_800_53_REV5' }))) === 'framework_immutable', 'changing the framework -> framework_immutable');
  assert((await codeOf(updateProgram('t-val', a.id, { frameworkId: 'CMMC_L2', name: 'Boundary A3' }))) === null, 'posting the same framework back is fine');
  assert((await codeOf(updateProgram('t-val', n1.id, { baseline: 'LOW' }))) === 'invalid_baseline', 'changing the baseline -> invalid_baseline');
  const archived = await archiveProgram('t-val', a.id);
  assert(archived.archivedAt !== null && (await listPrograms('t-val')).every((p) => p.id !== a.id), 'archiving sets archivedAt and hides the program from the default listing');
  assert((await listPrograms('t-val', { includeArchived: true })).some((p) => p.id === a.id), 'includeArchived lists it');
  assert((await codeOf(updateProgram('t-val', a.id, { description: 'x' }))) === 'program_archived', 'an archived program takes no edits -> program_archived');
  assert((await getProgram('t-val', a.id))?.archivedAt !== null, 'an archived program can still be read');
  assert((await unarchiveProgram('t-val', a.id)).archivedAt === null, 'unarchiveProgram clears archivedAt');
  assert((await codeOf(createProgram('t-val', { ...base, name: 'boundary a3' }, 'u'))) === 'program_name_taken', 'an archived or restored program keeps its name reserved');

  const [firstEvSql, firstEvParams] = evidenceInsert('t-val', a.id, 'ev-1');
  await queryWithProgram({ tenantId: 't-val', programId: a.id }, firstEvSql, [...firstEvParams]);
  const used = await countProgramUsage({ tenantId: 't-val', programId: a.id });
  assert(used.evidence === 1 && used.imports === 0 && used.poam === 0, 'countProgramUsage counts the evidence file', used);
  assert((await codeOf(deleteProgram('t-val', a.id))) === 'program_not_empty', 'a program with evidence cannot be deleted -> program_not_empty');
  assert((await getProgram('t-val', a.id)) !== null, 'and it is still there');
  assert((await codeOf(deleteProgram('t-val', n1.id))) === null && (await getProgram('t-val', n1.id)) === null, 'an empty program is deleted');

  console.log('\n--- tenant isolation of getProgram ---');
  assert((await getProgram('t2', d1.id)) === null, "getProgram('t2', idOfT1) -> null");
  assert((await getProgram('t1', d1.id))?.id === d1.id, 'the owner tenant reads it');
  assert((await getProgram('t1', '')) === null, 'an empty id -> null');
  assert((await codeOf(updateProgram('t2', d1.id, { name: 'Hijack' }))) === 'program_not_found', 'another tenant cannot edit it');
  assert((await codeOf(archiveProgram('t2', a.id))) === 'program_not_found' && (await codeOf(deleteProgram('t2', a.id))) === 'program_not_found', 'another tenant cannot archive or delete it');

  console.log('\n--- legacy rows are adopted by the default program ---');
  __resetProgramsForTests();
  const legacyTenant = 'legacy-1';
  // rows written before programs existed: no program_id (the fail-closed store refuses such a write, so the test hook seeds them)
  __seedLegacyRowForTests(legacyTenant, 'control_assessments', { control_id: 'AC.L1-3.1.1', status: 'MET', implementation_notes: 'legacy notes', updated_by: 'tester' });
  __seedLegacyRowForTests(legacyTenant, 'evidence_metadata', { id: 'ev-legacy', control_id: 'AC.L1-3.1.1', file_name: 'old.pdf', file_size: 5, mime_type: 'application/pdf', gcs_path: '/vault/old', file_hash: 'h', description: 'old', uploaded_by: 'tester' });
  const before = (await queryWithTenant(legacyTenant, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [legacyTenant])).rows;
  assert(before.length === 0, 'a legacy row (no program) is invisible to a tenant-only query: the program policy fails closed', before);
  const counts1 = await migrateTenantToPrograms(legacyTenant);
  const def = (await listPrograms(legacyTenant))[0];
  const defScope = { tenantId: legacyTenant, programId: def.id };
  const after = (await queryWithProgram(defScope, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [legacyTenant])).rows;
  const evAfter = (await queryWithProgram(defScope, 'SELECT * FROM evidence_metadata WHERE tenant_id = $1', [legacyTenant])).rows;
  assert(Boolean(def?.isDefault) && after[0]?.program_id === def.id && evAfter.length >= 1 && evAfter.every((r) => r.program_id === def.id), "after migrateTenantToPrograms the rows' program_id is the default program (evidence and its inherited copies)", [def?.id, after[0]?.program_id, evAfter.map((r) => r.program_id)]);
  assert(counts1.control_assessments === 1 && counts1.evidence_metadata === evAfter.length && counts1.total === 1 + evAfter.length, 'the first run reports the rows it adopted (one answer, every evidence row)', counts1);
  const counts2 = await migrateTenantToPrograms(legacyTenant);
  assert(counts2.total === 0 && counts2.control_assessments === 0 && counts2.evidence_metadata === 0, 'a second run changes 0 rows', counts2);
  assert((await listPrograms(legacyTenant)).length === 1, 'the migration created no second program');
  const other = await migrateTenantToPrograms('legacy-2');
  assert(other.total === 0, "one tenant's migration touches nothing of another tenant");
  assert((await queryWithProgram(defScope, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [legacyTenant])).rows.length === 1, 'the adopted row is still the only row');
  await ensureDefaultProgram('legacy-3'); // runs the migration once; a legacy row written afterwards stays until it is migrated again
  __seedLegacyRowForTests('legacy-3', 'control_assessments', { control_id: 'AC.L1-3.1.2', status: 'NOT_STARTED', updated_by: 'tester' });
  const late = await migrateTenantToPrograms('legacy-3');
  assert(late.control_assessments === 1, 'migrateTenantToPrograms can be called again to adopt a row written after the first run', late);

  console.log('\n--- queryWithProgram isolation (in memory) ---');
  await mkTenant('t-iso', 'CMMC_L2', ['CMMC_L2']);
  await mkTenant('t-iso2', 'CMMC_L2', ['CMMC_L2']);
  const pa = await createProgram('t-iso', { name: 'Iso A', frameworkId: 'CMMC_L2' }, 'u');
  const pb = await createProgram('t-iso', { name: 'Iso B', frameworkId: 'CMMC_L2' }, 'u');
  const scopeA = { tenantId: 't-iso', programId: pa.id };
  const scopeB = { tenantId: 't-iso', programId: pb.id };
  const [insertSql, insertParams] = control('t-iso', pa.id, 'X.1', 'MET');
  const inserted = await queryWithProgram(scopeA, insertSql, [...insertParams]);
  assert(inserted.rows.length === 1 && inserted.rows[0].program_id === pa.id, "an insert under A stores A's program id", inserted.rows);
  const select = 'SELECT * FROM control_assessments WHERE tenant_id = $1';
  assert((await queryWithProgram(scopeA, select, ['t-iso'])).rows.some((r) => r.control_id === 'X.1'), 'A sees its own row');
  assert(!(await queryWithProgram(scopeB, select, ['t-iso'])).rows.some((r) => r.control_id === 'X.1'), "B does not see A's row");
  assert((await queryWithProgram({ tenantId: 't-iso2', programId: pa.id }, select, ['t-iso2'])).rows.length === 0, "a second tenant, even with A's program id, sees nothing");
  assert((await queryWithProgram({ tenantId: 't-iso2', programId: pa.id }, select, ['t-iso'])).rows.length === 0, "a second tenant asking for the first tenant's id still sees nothing");
  assert((await queryWithTenant('t-iso', select, ['t-iso'])).rows.length === 0, 'a tenant-only query sees nothing (fails closed)');
  const [, mismatchParams] = control('t-iso', pa.id, 'X.2', 'MET');
  const mismatch = await queryWithProgram(scopeB, insertSql, [...mismatchParams]);
  assert(mismatch.rowCount === 0 && mismatch.rows.length === 0, "an insert under B for A's program id is refused");
  assert(!(await queryWithProgram(scopeA, select, ['t-iso'])).rows.some((r) => r.control_id === 'X.2'), 'and nothing was written');
  const [bSql, bParams] = control('t-iso', pb.id, 'X.1', 'NOT_MET');
  await queryWithProgram(scopeB, bSql, [...bParams]);
  const aRow = (await queryWithProgram(scopeA, select, ['t-iso'])).rows.find((r) => r.control_id === 'X.1');
  const bRow = (await queryWithProgram(scopeB, select, ['t-iso'])).rows.find((r) => r.control_id === 'X.1');
  assert(aRow?.status === 'MET' && bRow?.status === 'NOT_MET', 'the same control id holds one row per program', [aRow?.status, bRow?.status]);

  const evSelect = 'SELECT * FROM evidence_metadata WHERE tenant_id = $1';
  const [evSql, evParams] = evidenceInsert('t-iso', pa.id, 'ev-a');
  await queryWithProgram(scopeA, evSql, [...evParams]);
  const evA = (await queryWithProgram(scopeA, evSelect, ['t-iso'])).rows;
  assert(evA.some((r) => r.id === 'ev-a') && evA.length > 1 && evA.every((r) => r.program_id === pa.id), 'evidence under A, with its inherited copies, carries A', evA.map((r) => r.id));
  assert((await queryWithProgram(scopeB, evSelect, ['t-iso'])).rows.length === 0, "B sees none of A's evidence, inherited copies included");
  let refused = false;
  try {
    await queryWithProgram(scopeB, evSql, [...evParams]);
  } catch {
    refused = true;
  }
  assert(refused, "an evidence insert under B for A's program id is refused");

  console.log('\n--- the privacy baseline (issue #20) ---');
  await mkTenant('t-priv', 'NIST_800_53_REV5', ['NIST_800_53_REV5', 'CMMC_L2']);
  const privDefault = await ensureDefaultProgram('t-priv');
  assert(privDefault.privacyBaseline === false && d1.privacyBaseline === false, 'a default program has no privacy baseline', [privDefault.privacyBaseline, d1.privacyBaseline]);
  const mp = await createProgram('t-priv', { name: 'MOD plus privacy', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: true }, 'u');
  const mod = await createProgram('t-priv', { name: 'MOD plain', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE' }, 'u');
  const modNull = await createProgram('t-priv', { name: 'MOD null', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: null }, 'u');
  const modFalse = await createProgram('t-priv', { name: 'MOD false', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: false }, 'u');
  assert(mp.privacyBaseline === true && (await getProgram('t-priv', mp.id))?.privacyBaseline === true, 'NIST MODERATE with privacyBaseline true -> true');
  assert(mod.privacyBaseline === false && modNull.privacyBaseline === false && modFalse.privacyBaseline === false, 'NIST without it (or null / false) -> false', [mod.privacyBaseline, modNull.privacyBaseline, modFalse.privacyBaseline]);
  assert((await codeOf(createProgram('t-priv', { name: 'L2 privacy', frameworkId: 'CMMC_L2', privacyBaseline: true }, 'u'))) === 'invalid_baseline', 'CMMC_L2 with privacyBaseline true -> invalid_baseline');
  assert((await codeOf(createProgram('t-priv', { name: 'Yes', frameworkId: 'NIST_800_53_REV5', privacyBaseline: 'yes' as unknown as boolean }, 'u'))) === 'invalid_baseline', "a non-boolean ('yes') -> invalid_baseline");
  assert((await codeOf(updateProgram('t-priv', mp.id, { privacyBaseline: false }))) === 'invalid_baseline', 'update: false on a privacy program -> invalid_baseline');
  assert((await codeOf(updateProgram('t-priv', mod.id, { privacyBaseline: true }))) === 'invalid_baseline', 'update: true on a program without it -> invalid_baseline');
  assert((await codeOf(updateProgram('t-priv', mp.id, { privacyBaseline: true, name: 'MOD plus privacy 2' }))) === null && (await getProgram('t-priv', mp.id))?.privacyBaseline === true, 'update: the same value is a no-op (the form can post the whole program back)');
  assert((await codeOf(updateProgram('t-priv', mod.id, { privacyBaseline: false }))) === null, 'update: false on a program without it is a no-op');

  const union = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: true }, {} as OverlayFilters);
  const plainMod = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE' }, {} as OverlayFilters);
  assert((await getProgramMetrics(mp)).total === union.length && union.length === 340, 'metrics total of a MOD+P program is the union (340)', [(await getProgramMetrics(mp)).total, union.length]);
  assert((await getProgramMetrics(mod)).total === plainMod.length && plainMod.length === 287, 'metrics total of a plain MOD program is unchanged (287)', (await getProgramMetrics(mod)).total);

  const plainIds = new Set(plainMod.map((c) => c.id));
  const privOnlyId = union.find((c) => !plainIds.has(c.id))?.id ?? '';
  assert(privOnlyId !== '', 'the union holds a privacy-only control', privOnlyId);
  const [pSql, pParams] = control('t-priv', mp.id, privOnlyId, 'MET');
  await queryWithProgram({ tenantId: 't-priv', programId: mp.id }, pSql, [...pParams]);
  const clonedPlus = await createProgram('t-priv', { name: 'MOD plus privacy clone', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: true, seed: { cloneFrom: mp.id } }, 'u');
  const clonedPlain = await createProgram('t-priv', { name: 'MOD plain clone', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', seed: { cloneFrom: mp.id } }, 'u');
  const selectIds = async (p: { id: string }) => (await queryWithProgram({ tenantId: 't-priv', programId: p.id }, 'SELECT control_id FROM control_assessments WHERE tenant_id = $1', ['t-priv'])).rows.map((r) => r.control_id);
  assert((await selectIds(clonedPlus)).includes(privOnlyId), 'clone: a note on a privacy-only control is copied MOD+P -> MOD+P', await selectIds(clonedPlus));
  assert(!(await selectIds(clonedPlain)).includes(privOnlyId), 'clone: it is not copied to a plain MOD target', await selectIds(clonedPlain));

  console.log('\n--- scoping (issue #22) ---');
  await mkTenant('t-sc', 'NIST_800_53_REV5', ['NIST_800_53_REV5', 'CMMC_L2']);
  const who = { actor: 'Owner', userId: 'owner-1' };
  const n1s = await createProgram('t-sc', { name: 'N1', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', scoping: { noWireless: true } }, 'u');
  const scEvents = await listProgramEvents({ tenantId: 't-sc', programId: n1s.id });
  assert(JSON.stringify(n1s.scoping) === JSON.stringify({ noWireless: true }) && scEvents.length === 1 && scEvents[0].kind === 'scoping_set', 'S1: a scoped program stores the scoping and records one scoping_set event', [n1s.scoping, scEvents.map((e) => e.kind)]);
  const s2 = await createProgram('t-sc', { name: 'N2', frameworkId: 'NIST_800_53_REV5', scoping: { noWireless: false, nonNetworkedOnly: true } }, 'u');
  assert(JSON.stringify(s2.scoping) === JSON.stringify({ nonNetworkedOnly: true }), 'S2: a false switch is dropped', s2.scoping);
  assert((await codeOf(createProgram('t-sc', { name: 'N3', frameworkId: 'NIST_800_53_REV5', scoping: { bogus: true } }, 'u'))) === 'invalid_scoping', 'S3: an unknown key -> invalid_scoping');
  assert((await codeOf(createProgram('t-sc', { name: 'N4', frameworkId: 'NIST_800_53_REV5', scoping: { noWireless: 'yes' } }, 'u'))) === 'invalid_scoping', 'S4: a non-boolean value -> invalid_scoping');
  assert((await codeOf(createProgram('t-sc', { name: 'N5', frameworkId: 'NIST_800_53_REV5', privacyBaseline: true, scoping: { noPiiProcessing: true } }, 'u'))) === 'invalid_scoping', 'S5: noPiiProcessing on a privacy program -> invalid_scoping');
  assert((await codeOf(createProgram('t-sc', { name: 'L2 scoped', frameworkId: 'CMMC_L2', scoping: { noWireless: true } }, 'u'))) === 'invalid_scoping', 'S6: a true switch on a CMMC program -> invalid_scoping');
  const l2plain = await createProgram('t-sc', { name: 'L2 plain', frameworkId: 'CMMC_L2', scoping: {} }, 'u');
  assert(JSON.stringify(l2plain.scoping) === '{}', 'S6: a CMMC program with an empty scoping is created', l2plain.scoping);
  const s7 = await updateProgram('t-sc', n1s.id, { scoping: { noMobileDevices: true } }, who);
  const ev7 = await listProgramEvents({ tenantId: 't-sc', programId: n1s.id });
  assert(
    JSON.stringify(s7.scoping) === JSON.stringify({ noMobileDevices: true }) && ev7.length === 2 && ev7[0].kind === 'scoping_changed' &&
      JSON.stringify(ev7[0].oldValue) === JSON.stringify({ noWireless: true }) && JSON.stringify(ev7[0].newValue) === JSON.stringify({ noMobileDevices: true }) &&
      ev7[0].actor === 'Owner' && ev7[0].actorUserId === 'owner-1',
    'S7: changing the scoping records scoping_changed with the old and new switches (newest first)', ev7
  );
  await updateProgram('t-sc', n1s.id, { scoping: { noMobileDevices: true } }, who);
  assert((await listProgramEvents({ tenantId: 't-sc', programId: n1s.id })).length === 2, 'S8: the same scoping again records nothing');
  const n1Archived = await createProgram('t-sc', { name: 'N1 archived', frameworkId: 'NIST_800_53_REV5', scoping: { noWireless: true } }, 'u');
  await archiveProgram('t-sc', n1Archived.id);
  assert((await codeOf(updateProgram('t-sc', n1Archived.id, { scoping: { noMobileDevices: true } }, who))) === 'program_archived', 'S9: an archived program takes no scoping change -> program_archived');
  const unscoped = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE' }, {} as OverlayFilters).length;
  const scopedWw = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE' }, { nonNetworkedOnly: false, noWireless: true }).length;
  const wwProgram = await createProgram('t-sc', { name: 'N wireless', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE', scoping: { noWireless: true } }, 'u');
  const wwMetrics = await getProgramMetrics(wwProgram);
  assert(wwMetrics.total === scopedWw && scopedWw < unscoped, 'S10: the metrics total follows the overlays of the program', [wwMetrics.total, scopedWw, unscoped]);
  const dSc = await ensureDefaultProgram('t-sc');
  const resolvedSc = await resolveVmTargetProgram('t-sc');
  assert(JSON.stringify(dSc.scoping) === '{}' && dSc.vmTarget === false && resolvedSc.program.id === dSc.id && resolvedSc.explicit === false, 'S11: the default program has no scoping and is not a target; with no target it is the fallback', [dSc, resolvedSc.explicit]);

  console.log('\n--- the VM target (issue #21) ---');
  await mkTenant('t-vm', 'CMMC_L2', ['CMMC_L2', 'NIST_800_53_REV5']);
  const dVm = await ensureDefaultProgram('t-vm');
  const vmA = await createProgram('t-vm', { name: 'Target A', description: 'secret boundary text', frameworkId: 'CMMC_L2' }, 'u');
  const vmB = await createProgram('t-vm', { name: 'Target B', frameworkId: 'CMMC_L2' }, 'u');
  const vmN = await createProgram('t-vm', { name: 'Target N', frameworkId: 'NIST_800_53_REV5' }, 'u');
  const r1 = await setVmTargetProgram('t-vm', vmA.id, who);
  const res1 = await resolveVmTargetProgram('t-vm');
  assert((await getProgram('t-vm', vmA.id))?.vmTarget === true && res1.program.id === vmA.id && res1.explicit === true && r1.program.vmTarget === true, 'V1: setting a CMMC program makes it the explicit target', [r1.previousId, res1.explicit]);
  assert(r1.previousId === dVm.id, 'V1: the first target replaces the default program as the receiver (previousId)', r1.previousId);
  const r2 = await setVmTargetProgram('t-vm', vmB.id, who);
  const vmEvA = await listProgramEvents({ tenantId: 't-vm', programId: vmA.id });
  const vmEvB = await listProgramEvents({ tenantId: 't-vm', programId: vmB.id });
  assert(
    (await getProgram('t-vm', vmA.id))?.vmTarget === false && (await getProgram('t-vm', vmB.id))?.vmTarget === true && r2.previousId === vmA.id &&
      vmEvA.some((e) => e.kind === 'vm_target_cleared') && vmEvA.some((e) => e.kind === 'vm_target_set') && vmEvB.some((e) => e.kind === 'vm_target_set') && typeof r2.openPoamInPrevious === 'number',
    'V2: switching moves the flag, reports the previous target and records set / cleared events', [r2.previousId, vmEvA.map((e) => e.kind), vmEvB.map((e) => e.kind)]
  );
  const evBBefore = (await listProgramEvents({ tenantId: 't-vm', programId: vmB.id })).length;
  const again = await setVmTargetProgram('t-vm', vmB.id, who);
  assert(again.previousId === null && (await listProgramEvents({ tenantId: 't-vm', programId: vmB.id })).length === evBBefore, 'V2: choosing the current target again records nothing');
  assert((await codeOf(setVmTargetProgram('t-vm', vmN.id, who))) === 'invalid_vm_target', 'V3: a NIST program cannot be the target -> invalid_vm_target');
  const vmArch = await createProgram('t-vm', { name: 'Target Archived', frameworkId: 'CMMC_L2' }, 'u');
  await archiveProgram('t-vm', vmArch.id);
  assert((await codeOf(setVmTargetProgram('t-vm', vmArch.id, who))) === 'program_archived', 'V3: an archived program cannot be the target -> program_archived');
  assert((await codeOf(setVmTargetProgram('t-vm', 'nope', who))) === 'program_not_found', 'V3: an unknown program -> program_not_found');
  assert((await codeOf(archiveProgram('t-vm', vmB.id))) === 'program_is_vm_target' && (await codeOf(deleteProgram('t-vm', vmB.id))) === 'program_is_vm_target', 'V4: the target can be neither archived nor deleted -> program_is_vm_target');
  const r5 = await setVmTargetProgram('t-vm', dVm.id, who);
  const res5 = await resolveVmTargetProgram('t-vm');
  assert(
    r5.program.id === dVm.id && res5.program.id === dVm.id && (await listPrograms('t-vm', { includeArchived: true })).filter((p) => p.vmTarget).length === 1,
    'V5: the default program can be the target and then is the only flagged one', res5.program.id
  );
  const allEvents = (await Promise.all([vmA, vmB, dVm, n1s, wwProgram].map((p) => listProgramEvents({ tenantId: p.tenantId, programId: p.id })))).flat();
  const eventJson = JSON.stringify(allEvents);
  assert(allEvents.length > 0 && !['Target A', 'Target B', 'N wireless', 'secret boundary text', DEFAULT_PROGRAM_NAME].some((s) => eventJson.includes(s)),'V6: events hold no program name or description', allEvents.length);

  console.log('\n--- Clone history source ---');
  await mkTenant('t-clone-src', 'CMMC_L2', ['CMMC_L2']);
  const dClone = await ensureDefaultProgram('t-clone-src');
  await queryWithProgram({ tenantId: 't-clone-src', programId: dClone.id }, ...control('t-clone-src', dClone.id, 'AC.L1-3.1.1', 'MET'));
  const cloned = await createProgram('t-clone-src', { name: 'Clone src', frameworkId: 'CMMC_L2', seed: { cloneFrom: dClone.id } }, 'u');
  const cloneEv = await listControlAssessmentEvents({ tenantId: 't-clone-src', programId: cloned.id }, 'AC.L1-3.1.1', 10);
  assert(
    cloneEv.length === 1 && cloneEv[0].source === 'clone' && cloneEv[0].newStatus === 'NOT_STARTED' && cloneEv[0].actor === 'u' && cloneEv[0].actorUserId === null,
    'C1: a cloned control records one event with source clone, the status reset and the creator as actor', cloneEv
  );
  const srcEv = await listControlAssessmentEvents({ tenantId: 't-clone-src', programId: dClone.id }, 'AC.L1-3.1.1', 10);
  assert(!srcEv.some((e) => e.source === 'clone'), 'C1: the source program has no clone event', srcEv);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
