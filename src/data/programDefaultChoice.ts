import type { Program } from '../types/program';

/**
 * What the screens say and do around "which program is the default" and "there is no program yet". Pure: no browser storage, no logging.
 * The organization default (`isDefault`) is where people land when they have not chosen; "My default" (`isMyDefault`) is one person's own
 * choice. A tenant starts with no program at all: the first one is created by a tenant owner or MSP administrator.
 */

type ProgramLike = Pick<Program, 'id' | 'name' | 'archived' | 'isDefault'> & { isMyDefault?: boolean; createdAt?: string };

/** The tabs whose data belongs to a program: without an active program they show a notice instead. */
export const PROGRAM_SCOPED_TABS: ReadonlySet<string> = new Set([
  'dashboard',
  'matrix',
  'controls',
  'evidence',
  'vault',
  'ssp',
  'sspimport',
  'configresults',
  'poam',
  'export',
]);

export type ProgramGateKind = 'none' | 'all-archived';
export interface ProgramGate {
  kind: ProgramGateKind;
  /** The viewer may create a program (tenant owner or MSP administrator). */
  canCreate: boolean;
}

interface GateInput {
  programsStatus: string;
  programs: ReadonlyArray<Pick<Program, 'archived'>>;
  canManagePrograms: boolean;
}

/** Null while the programs are loading or a program is open; else why the program-scoped pages have nothing to show. */
export function programGate(input: GateInput): ProgramGate | null {
  if (input.programsStatus !== 'ready') return null;
  if (input.programs.some((p) => !p.archived)) return null;
  return { kind: input.programs.length === 0 ? 'none' : 'all-archived', canCreate: input.canManagePrograms };
}

/** True when the "Create Your First Program" form should be open: no program at all, the viewer can create one, and nothing else is in the way. */
export function shouldPromptFirstProgram(input: GateInput & { onboardingOpen: boolean; dismissed: boolean }): boolean {
  const gate = programGate(input);
  return gate !== null && gate.kind === 'none' && gate.canCreate && !input.onboardingOpen && !input.dismissed;
}

/** The title and body of the notice shown in place of a program-scoped page. */
export function noProgramCopy(gate: ProgramGate): { title: string; body: string } {
  if (gate.kind === 'none') {
    return gate.canCreate
      ? {
          title: 'Create your first program',
          body: 'Answers, evidence, SSP imports and POA&M items all belong to a program (an authorization boundary). Create one to start.',
        }
      : {
          title: 'No program yet',
          body: 'A tenant owner or an MSP administrator creates the first program. Until then there are no controls, evidence or plans to show.',
        };
  }
  return gate.canCreate
    ? { title: 'No active program', body: 'Every program is archived. Restore one on the Programs page, or create a new one.' }
    : { title: 'No active program', body: 'Every program is archived. Ask a tenant owner or an MSP administrator to restore one or create a new one.' };
}

const createdTime = (p: { createdAt?: string }): number => {
  const t = p.createdAt ? Date.parse(p.createdAt) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** The program that becomes the organization default when `leavingId` is archived or deleted: the oldest other open program. Null when none. */
export function nextOrganizationDefault<T extends { id: string; archived: boolean; createdAt?: string }>(programs: ReadonlyArray<T>, leavingId: string): T | null {
  let next: T | null = null;
  for (const p of programs) {
    if (p.archived || p.id === leavingId) continue;
    if (!next || createdTime(p) < createdTime(next)) next = p;
  }
  return next;
}

/** True when creating a program now makes it the organization default (no open program is one). */
export function createsOrganizationDefault(programs: ReadonlyArray<Pick<Program, 'archived' | 'isDefault'>>): boolean {
  return !programs.some((p) => !p.archived && p.isDefault);
}

export interface ArchiveImpactLine {
  tone: 'info' | 'warn';
  text: string;
}

/** What archiving `program` changes beyond the program itself, for the confirmation dialog. */
export function archiveImpactLines(program: ProgramLike, programs: ReadonlyArray<ProgramLike>): ArchiveImpactLine[] {
  const lines: ArchiveImpactLine[] = [];
  const next = nextOrganizationDefault(programs, program.id);
  if (program.isDefault && next) {
    lines.push({ tone: 'info', text: `It is the organization default. ${next.name} (the oldest remaining active program) becomes the organization default.` });
  }
  if (program.isMyDefault && next) {
    lines.push({ tone: 'info', text: 'It is your default program. You will land on the organization default when you sign in, until you choose another.' });
  }
  if (!next) {
    lines.push({
      tone: 'warn',
      text: 'It is the only active program. Archiving it leaves the organization with no active program: the control matrix, evidence, SSP and POA&M pages stay empty until a program is created or restored.',
    });
  }
  return lines;
}
