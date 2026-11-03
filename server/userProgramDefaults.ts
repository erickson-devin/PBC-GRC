import { getDbMode, queryWithTenant } from './db';
import { ProgramError, getProgram, getTenantDefaultProgram, listPrograms } from './programs';

/**
 * Per-user default program: the program a user lands in when the browser has not chosen one. A preference only (ids, no CUI), one per
 * user and tenant; the organization default (programs.is_default) stays the fallback for everyone without one.
 *
 * PostgreSQL: user_program_defaults (tenant RLS, cascades when the program is deleted). Memory (DB_MODE=memory): a process Map.
 */

const memoryDefaults = new Map<string, string>(); // key: tenantId + '\n' + userId -> program id

const keyOf = (tenantId: string, userId: string): string => `${tenantId}\n${userId}`;
const isMemory = (): boolean => getDbMode() === 'memory';

/** Test hook. */
export function __resetUserProgramDefaultsForTests(): void {
  memoryDefaults.clear();
}

/** Memory only: a deleted program takes the users' defaults pointing at it along (in PostgreSQL the foreign key cascades). */
export function __deleteUserDefaultsForProgramMemory(tenantId: string, programId: string): void {
  for (const [key, id] of [...memoryDefaults]) if (id === programId && key.startsWith(`${tenantId}\n`)) memoryDefaults.delete(key);
}

/** The program id the user picked as their default in this tenant (it may be archived), or null when they have none. */
export async function getUserDefaultProgramId(tenantId: string, userId: string): Promise<string | null> {
  if (!userId) return null;
  if (isMemory()) return memoryDefaults.get(keyOf(tenantId, userId)) ?? null;
  const res = await queryWithTenant(tenantId, 'SELECT program_id FROM user_program_defaults WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
  return res.rows[0] ? String(res.rows[0].program_id) : null;
}

/**
 * Sets (or with null clears) the user's default program. The program must be a program of the tenant (program_not_found, the same for
 * another tenant's) and active (program_archived).
 */
export async function setUserDefaultProgram(tenantId: string, userId: string, programId: string | null): Promise<void> {
  if (programId === null) {
    if (isMemory()) memoryDefaults.delete(keyOf(tenantId, userId));
    else await queryWithTenant(tenantId, 'DELETE FROM user_program_defaults WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    return;
  }
  const program = await getProgram(tenantId, programId);
  if (!program) throw new ProgramError('program_not_found', 'Program not found');
  if (program.archivedAt) throw new ProgramError('program_archived', 'An archived program cannot be a default');
  if (isMemory()) {
    memoryDefaults.set(keyOf(tenantId, userId), program.id);
    return;
  }
  await queryWithTenant(
    tenantId,
    `INSERT INTO user_program_defaults (tenant_id, user_id, program_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET program_id = EXCLUDED.program_id, updated_at = NOW()`,
    [tenantId, userId, program.id]
  );
}

/** Removes the user's default when they leave the tenant (no foreign key to the members: a platform admin may have no membership row). */
export async function clearUserProgramDefault(tenantId: string, userId: string): Promise<void> {
  await setUserDefaultProgram(tenantId, userId, null);
}

/**
 * The program a user lands in: their own default when it is still active, else the organization default, else the oldest active
 * program, else null (the tenant has no active program).
 */
export async function resolveLandingProgramId(tenantId: string, userId: string): Promise<string | null> {
  const own = await getUserDefaultProgramId(tenantId, userId);
  if (own) {
    const program = await getProgram(tenantId, own);
    if (program && program.archivedAt === null) return program.id;
  }
  const fallback = await getTenantDefaultProgram(tenantId);
  if (fallback) return fallback.id;
  return (await listPrograms(tenantId))[0]?.id ?? null; // active programs only, oldest first
}
