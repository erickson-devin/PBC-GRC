import type { Program } from '../types/program';
import { nextOrganizationDefault } from './programDefaultChoice';

/**
 * What the Programs page says and does around the vulnerability target (the program that receives the scanner data and the
 * vulnerability POA&M items). Pure: no storage, no logging, program names and counts only.
 */

export const VM_TARGET_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2']; // mirrors server/programs.ts

/** Decision D2 flip point: true = items left in an earlier target are still completed automatically while that program is not archived. */
export const VM_TARGET_PREVIOUS_AUTOCOMPLETE = true;

type P = Pick<Program, 'id' | 'name' | 'vmTarget' | 'isDefault' | 'archived' | 'framework'> & { createdAt?: string };

/** Mirrors resolveVmTargetProgram (server/programs.ts): the open program flagged as target, else the organization default when it is CMMC Level 1 / 2. */
export function resolveVmTargetProgramId(programs: ReadonlyArray<P>): { programId: string; explicit: boolean } | null {
  const flagged = programs.find((p) => p.vmTarget && !p.archived);
  if (flagged) return { programId: flagged.id, explicit: true };
  const fallback = programs.find((p) => p.isDefault && !p.archived);
  return fallback && VM_TARGET_FRAMEWORKS.includes(fallback.framework) ? { programId: fallback.id, explicit: false } : null;
}

const REASON_ARCHIVED = 'Restore this program before it can be the vulnerability target.';
const REASON_FRAMEWORK = 'Only a CMMC Level 1 or Level 2 program can be the vulnerability target.';

/** Why the program cannot be chosen as the vulnerability target (null when it can). */
export function vmTargetIneligibleReason(p: Pick<Program, 'framework' | 'archived'>): string | null {
  if (p.archived) return REASON_ARCHIVED;
  return VM_TARGET_FRAMEWORKS.includes(p.framework) ? null : REASON_FRAMEWORK;
}

/** The sentence on the card of the program that is the vulnerability target. */
export function vmTargetCardNote(o: { explicit: boolean; canManage: boolean }): string {
  if (!o.explicit) return 'This program receives the scanner data and the vulnerability POA&M items because it is the organization default and no vulnerability target is chosen.';
  return `This program receives the scanner data and the vulnerability POA&M items.${o.canManage ? ' Choose another vulnerability target before archiving it.' : ''}`;
}

export interface VmTargetPreviewFacts {
  eligible: boolean;
  ineligibleReason: 'invalid_vm_target' | 'program_archived' | null;
  openPoamInCurrent: number;
  overdueWithoutItem: number;
  autocreateEnabled: boolean;
}

export interface VmTargetConfirmLine { tone: 'info' | 'warn'; text: string }

/** The confirmation of "Set as Vulnerability Target": what changes, with the server's counts; a missing preview says what is unknown. */
export function vmTargetConfirmLines(i: {
  programName: string;
  preview: VmTargetPreviewFacts | null;
  current: { name: string; explicit: boolean } | null;
  previousAutoComplete?: boolean;
}): VmTargetConfirmLine[] {
  const { programName, preview, current } = i;
  const previousAutoComplete = i.previousAutoComplete ?? VM_TARGET_PREVIOUS_AUTOCOMPLETE;
  const lines: VmTargetConfirmLine[] = [];
  lines.push({ tone: 'info', text: `From the next processed scan, ${programName} receives the scanner data and new vulnerability POA&M items. Nothing moves before then.` });

  if (!preview) {
    lines.push({ tone: 'warn', text: 'The number of overdue vulnerabilities that would get an item could not be loaded. You can still continue.' });
  } else if (!preview.autocreateEnabled) {
    lines.push({ tone: 'info', text: `Automatic POA&M items are turned off on this server (VM_POAM_AUTOCREATE), so no items are created in ${programName}.` });
  } else {
    const n = preview.overdueWithoutItem;
    lines.push({
      tone: 'info',
      text: n > 0
        ? `About ${n} open ${n === 1 ? 'vulnerability is' : 'vulnerabilities are'} past ${n === 1 ? 'its' : 'their'} deadline without a POA&M item in ${programName}. ${n === 1 ? 'It gets' : 'They get'} an item there at that scan; the number grows if more deadlines pass first.`
        : `No open vulnerability is past its deadline without an item in ${programName} right now.`,
    });
  }

  if (!current) {
    lines.push({ tone: 'info', text: 'No program receives the vulnerability data today.' });
  } else {
    const cur = current.name;
    const n = preview ? preview.openPoamInCurrent : null;
    let text = n === null ? `${cur} keeps its open vulnerability POA&M items.` : n === 0 ? `${cur} has no open vulnerability POA&M items.` : `${cur} keeps its ${n} open vulnerability POA&M ${n === 1 ? 'item' : 'items'}.`;
    if (n !== 0) {
      const one = n === 1;
      text += previousAutoComplete
        ? ` ${one ? 'It is' : 'They are'} still completed automatically when a scan confirms the fix, unless ${cur} is archived.`
        : ` ${one ? 'It is' : 'They are'} no longer completed automatically; a person completes them in ${cur}.`;
    }
    lines.push({ tone: 'info', text });
    lines.push({
      tone: 'info',
      text: current.explicit
        ? `${cur} is no longer the vulnerability target, so it can be archived afterwards.`
        : `${cur} stays the organization default; only the vulnerability target changes.`,
    });
  }

  if (preview && !preview.eligible) {
    lines.push({ tone: 'warn', text: preview.ineligibleReason === 'program_archived' ? REASON_ARCHIVED : REASON_FRAMEWORK });
  }
  return lines;
}

/** For the archive dialog: only when the program is the implicit target (the organization default); an explicit target cannot be archived. */
export function vmTargetArchiveLine(program: P, programs: ReadonlyArray<P>): string | null {
  const target = resolveVmTargetProgramId(programs);
  if (!target || target.explicit || target.programId !== program.id) return null;
  const next = nextOrganizationDefault(programs, program.id);
  const head = next && VM_TARGET_FRAMEWORKS.includes(next.framework)
    ? `It receives the vulnerability data as the organization default. ${next.name} becomes the organization default and the vulnerability target.`
    : 'It receives the vulnerability data as the organization default. After archiving, no program receives new vulnerability POA&M items until a CMMC program is chosen as the vulnerability target.';
  return `${head} Its open vulnerability POA&M items stay in it and are no longer completed automatically.`;
}

export const VM_TARGET_COPY = {
  badge: 'Vulnerability target',
  action: 'Set as Vulnerability Target',
  previewLoading: 'Loading what changes…',
  previewRetry: 'Load the numbers again',
  failed: 'Could not change the vulnerability target. Please try again.',
  announced: (name: string): string => `${name} is now the vulnerability target. New vulnerability POA&M items go to it from the next processed scan.`,
};
