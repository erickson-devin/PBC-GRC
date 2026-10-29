import { PROGRAM_FRAMEWORKS } from './tenantFrameworkPolicy';
import type { ComplianceFramework } from '../types/framework';
import type { Program, ProgramBaseline, ProgramInput, ProgramMetrics, ProgramScoping } from '../types/program';
import { normalizeProgramScoping } from './programScope';

/**
 * Programs as the client reads them: the server's list and metrics bodies, the active-program choice, the scope keys that keep one
 * program's data from showing under another, and the create-form validation. Pure: nothing here touches browser storage (the one
 * writer of the active program lives in TenantContext).
 */

export const PROGRAM_NAME_MAX = 255;
export const PROGRAM_TEXT_MAX = 20000;
const ACTIVE_PROGRAM_KEY_PREFIX = 'pbc_active_program_';
const FRAMEWORK_ALIASES: Record<string, ComplianceFramework> = { 'nist-800-53-r5': 'NIST_800_53_REV5' };
const BASELINES: readonly ProgramBaseline[] = ['LOW', 'MODERATE', 'HIGH'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The canonical framework id, or null when it is not one a program may carry. */
export function normalizeProgramFramework(value: unknown): ComplianceFramework | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  const canonical = (FRAMEWORK_ALIASES[id.toLowerCase()] ?? id) as ComplianceFramework;
  return PROGRAM_FRAMEWORKS.includes(canonical) ? canonical : null;
}

/** LOW / MODERATE / HIGH in any case, else null. */
function readBaseline(value: unknown): ProgramBaseline | null {
  if (typeof value !== 'string') return null;
  const b = value.trim().toUpperCase();
  return (BASELINES as readonly string[]).includes(b) ? (b as ProgramBaseline) : null;
}

function parseProgram(raw: unknown): Program | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const framework = normalizeProgramFramework(raw.framework ?? raw.frameworkId ?? raw.framework_id);
  if (!framework) return null;
  const name = text(raw.name).trim();
  const archivedAt = raw.archivedAt ?? raw.archived_at;
  const privacyBaseline = framework === 'NIST_800_53_REV5' && (raw.privacyBaseline ?? raw.privacy_baseline) === true;
  // The server's overlays; one this version cannot read is shown as none (never thrown)
  const scopingResult = normalizeProgramScoping(raw.scoping, { frameworkId: framework, privacyBaseline });
  const scoping: ProgramScoping = scopingResult.ok ? scopingResult.value : {};
  const program: Program = {
    id,
    name: name || 'Untitled program',
    description: text(raw.description),
    framework,
    // Only NIST SP 800-53 carries a baseline.
    baseline: framework === 'NIST_800_53_REV5' ? readBaseline(raw.baseline) : null,
    // The privacy-baseline add-on is NIST SP 800-53 only and true only when the server says so.
    privacyBaseline,
    boundarySummary: text(raw.boundarySummary ?? raw.systemBoundarySummary ?? raw.system_boundary_summary),
    scoping,
    vmTarget: (raw.vmTarget ?? raw.vm_target) === true,
    isDefault: (raw.isDefault ?? raw.is_default) === true,
    archived: raw.archived === true || (typeof archivedAt === 'string' && archivedAt !== ''),
  };
  const createdAt = raw.createdAt ?? raw.created_at;
  const updatedAt = raw.updatedAt ?? raw.updated_at;
  if (typeof createdAt === 'string') program.createdAt = createdAt;
  if (typeof updatedAt === 'string') program.updatedAt = updatedAt;
  return program;
}

/** One program from a create / update / archive response ({ program } or the program itself), or null. */
export function parseProgramResponse(body: unknown): Program | null {
  return parseProgram(isRecord(body) && isRecord(body.program) ? body.program : body);
}

/** The programs of a list response ({ programs: [...] } or a bare array). Entries that are not usable are dropped; never throws. */
export function parseProgramList(body: unknown): Program[] {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.programs) ? body.programs : [];
  const programs: Program[] = [];
  for (const raw of list) {
    const program = parseProgram(raw);
    if (program) programs.push(program);
  }
  return programs;
}

/** GET .../programs/:id/metrics: { documented, total, evidence, openPoam }. Anything missing is null. */
export function parseProgramMetrics(body: unknown): ProgramMetrics {
  const b = isRecord(body) ? body : {};
  const coverage = isRecord(b.coverage) ? b.coverage : {};
  return {
    documented: count(b.documented ?? coverage.documented),
    total: count(b.total ?? coverage.total),
    openPoam: count(b.openPoam ?? b.open_poam),
    evidenceCount: count(b.evidence ?? b.evidenceCount),
  };
}

/**
 * The program to show: the stored choice when it still exists and is not archived, else the default program, else the first
 * program that is not archived. Null when there is none.
 */
export function pickActiveProgramId(storedId: string | null | undefined, programs: ReadonlyArray<Pick<Program, 'id' | 'isDefault' | 'archived'>>): string | null {
  const open = programs.filter((p) => !p.archived);
  if (storedId && open.some((p) => p.id === storedId)) return storedId;
  return (open.find((p) => p.isDefault) ?? open[0])?.id ?? null;
}

/** The browser-storage key of a tenant's active program. */
export function activeProgramStorageKey(tenantId: string): string {
  return `${ACTIVE_PROGRAM_KEY_PREFIX}${tenantId}`;
}

/** Names the data a screen holds: `tenant`, or `tenant::program`. Compared, never parsed. */
export function programScopeKey(tenantId: string, programId: string | null | undefined): string {
  return programId ? `${tenantId}::${programId}` : tenantId;
}

/** The suffix of a program's assessment cache key: null for the default program (it keeps the legacy key), else its id. */
export function programCacheSegment(program: Pick<Program, 'id' | 'isDefault'> | null | undefined): string | null {
  return !program || program.isDefault ? null : program.id;
}

export type ProgramInputField = 'name' | 'framework' | 'baseline' | 'description' | 'boundarySummary' | 'scoping' | 'seed';

export interface ProgramValidation {
  valid: boolean;
  errors: Partial<Record<ProgramInputField, string>>;
  /** The input as it should be sent: trimmed, baseline and privacy baseline stripped unless NIST, seed normalised. */
  value: {
    name: string;
    framework: ComplianceFramework | string;
    baseline: ProgramBaseline | null;
    privacyBaseline: boolean;
    description: string;
    boundarySummary: string;
    /** The overlays that are on (NIST SP 800-53 only); `{}` when none. */
    scoping: ProgramScoping;
    seed: 'blank' | 'clone';
    sourceProgramId: string | null;
  };
}

/**
 * Checks the create form. Name: 1 to 255 characters, unique among the tenant's programs ignoring case (archived ones too; on an
 * edit pass `editingId`). Framework: one the tenant has enabled. Baseline: required for NIST SP 800-53 (LOW, MODERATE or HIGH),
 * dropped for every other framework; the optional privacy baseline is kept only for NIST. Seed: blank, or a clone of an existing program.
 */
export function validateProgramInput(
  input: ProgramInput,
  ctx: { tenantFrameworks: ReadonlyArray<string>; existing: ReadonlyArray<Pick<Program, 'id' | 'name'>>; editingId?: string | null }
): ProgramValidation {
  const errors: ProgramValidation['errors'] = {};
  const name = (input.name ?? '').trim();
  if (!name) errors.name = 'Enter a name for the program.';
  else if (name.length > PROGRAM_NAME_MAX) errors.name = `The name must be ${PROGRAM_NAME_MAX} characters or fewer.`;
  else if (ctx.existing.some((p) => p.id !== ctx.editingId && p.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'A program with this name already exists.';
  }

  const framework = normalizeProgramFramework(input.framework);
  if (!framework || !ctx.tenantFrameworks.some((f) => normalizeProgramFramework(f) === framework)) {
    errors.framework = 'Choose a framework that is enabled for this organization.';
  }

  const isNist = framework === 'NIST_800_53_REV5';
  const baseline = isNist ? readBaseline(input.baseline) : null;
  if (isNist && !baseline) errors.baseline = 'Choose a baseline: Low, Moderate or High.';

  const description = input.description ?? '';
  const boundarySummary = input.boundarySummary ?? '';
  if (description.length > PROGRAM_TEXT_MAX) errors.description = `The description must be ${PROGRAM_TEXT_MAX} characters or fewer.`;
  if (boundarySummary.length > PROGRAM_TEXT_MAX) errors.boundarySummary = `The boundary description must be ${PROGRAM_TEXT_MAX} characters or fewer.`;

  const seed = input.seed === 'clone' ? 'clone' : 'blank';
  const sourceProgramId = seed === 'clone' && typeof input.sourceProgramId === 'string' && input.sourceProgramId.trim() ? input.sourceProgramId.trim() : null;
  if (seed === 'clone' && !sourceProgramId) errors.seed = 'Choose the program to clone from.';

  const privacyBaseline = isNist && input.privacyBaseline === true;
  const scopingResult = normalizeProgramScoping(input.scoping, { frameworkId: framework ?? '', privacyBaseline });
  if (!scopingResult.ok) errors.scoping = 'These overlays cannot be applied to this program: they are for NIST SP 800-53 programs only, and No PII Processing is not available with the privacy baseline.';
  const scoping: ProgramScoping = scopingResult.ok ? scopingResult.value : {};

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    value: { name, framework: framework ?? String(input.framework ?? ''), baseline, privacyBaseline, description, boundarySummary, scoping, seed, sourceProgramId },
  };
}

/** The request body of POST .../programs for a validated input. */
export function programCreateBody(value: ProgramValidation['value']): Record<string, unknown> {
  const body: Record<string, unknown> = { name: value.name, frameworkId: value.framework, description: value.description, systemBoundarySummary: value.boundarySummary };
  if (value.baseline) body.baseline = value.baseline;
  if (value.privacyBaseline) body.privacyBaseline = true;
  if (Object.keys(value.scoping).length > 0) body.scoping = value.scoping;
  if (value.seed === 'clone' && value.sourceProgramId) body.seed = { cloneFrom: value.sourceProgramId };
  return body;
}

/** True when a state loaded for `stateScope` may be saved while `currentScope` is showing (never across programs). */
export function shouldPersistAssessment(stateScope: string | null | undefined, currentScope: string | null | undefined): boolean {
  return Boolean(stateScope) && stateScope === currentScope;
}

/** True when the response of request number `seq` is still the latest one (`current`). */
export function isCurrentResponse(seq: number, current: number): boolean {
  return seq === current;
}
