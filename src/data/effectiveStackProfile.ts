import type { Program } from '../types/program';
import type { EnclaveStackProfile, Tenant } from '../types/tenant';

/**
 * The enclave stack profile in force (#230): the program's own when it has one, else the tenant's. Pure: nothing is mutated.
 */

export function effectiveStackProfile(tenant: Pick<Tenant, 'stackProfile'>, program?: Pick<Program, 'stackProfile'> | null): EnclaveStackProfile | undefined {
  return program?.stackProfile ?? tenant.stackProfile ?? undefined;
}

/** The tenant carrying the effective profile (for the policy generator); the very same object when nothing changes. */
export function withEffectiveStack<T extends Pick<Tenant, 'stackProfile'>>(tenant: T, program?: Pick<Program, 'stackProfile'> | null): T {
  const eff = effectiveStackProfile(tenant, program);
  return eff === tenant.stackProfile ? tenant : { ...tenant, stackProfile: eff };
}
