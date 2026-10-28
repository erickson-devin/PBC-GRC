import type { ComplianceFramework } from './framework';

/** NIST SP 800-53 baseline of a program, as the server holds it (upper case). Privacy is not a value. */
export type ProgramBaseline = 'LOW' | 'MODERATE' | 'HIGH';

/**
 * A program: one authorization boundary (an ATO effort or project) of a tenant, with one framework and, for NIST SP 800-53,
 * one baseline. Both are fixed at creation. Control answers, evidence, SSP imports and POA&M items belong to one program.
 * Not to be confused with `src/data/programs.ts`, the tenant's licensed frameworks.
 */
export interface Program {
  id: string;
  name: string;
  description: string;
  framework: ComplianceFramework;
  baseline: ProgramBaseline | null;
  boundarySummary: string;
  isDefault: boolean;
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Counts for one program card; null while unknown. */
export interface ProgramMetrics {
  documented: number | null;
  total: number | null;
  openPoam: number | null;
  /** The server's `evidence` field. */
  evidenceCount: number | null;
}

export type ProgramSeed = 'blank' | 'clone';

/** What the create form collects. */
export interface ProgramInput {
  name: string;
  framework: ComplianceFramework | string;
  baseline?: ProgramBaseline | string | null;
  description?: string;
  boundarySummary?: string;
  seed?: ProgramSeed;
  sourceProgramId?: string | null;
}

/** What an edit may change (framework and baseline are immutable). */
export interface ProgramUpdate {
  name?: string;
  description?: string;
  boundarySummary?: string;
}
