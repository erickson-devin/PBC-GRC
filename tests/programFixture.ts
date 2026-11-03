import { createProgram, type Program } from '../server/programs';

/**
 * A tenant starts with no program: nothing creates one for it. A suite that needs the program every program-scoped request runs in
 * (controls, evidence, SSP imports, POA&M items) creates one with this helper after it has set the tenant up. The first program of a
 * tenant is its organization default, so requests without an x-program-id header resolve to it.
 */
export async function firstProgram(tenantId: string, frameworkId = 'CMMC_L1'): Promise<Program> {
  return createProgram(tenantId, { name: 'Test Boundary', frameworkId }, 'test');
}
