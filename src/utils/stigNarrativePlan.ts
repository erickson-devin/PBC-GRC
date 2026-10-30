import type { ControlState } from '../types/cmmc';

export interface StigNarrativeChange {
  id: string;
  next: ControlState;
  serverUpdate: Partial<ControlState>;
}

/**
 * Pure: what a bulk STIG narrative fill changes. Same rules as before #79: append under a header,
 * keep text already present, NOT_STARTED -> IN_PROGRESS.
 */
export function planStigNarratives(
  controls: Readonly<Record<string, ControlState>>,
  narratives: Readonly<Record<string, string>>,
  ctx: { tenantId: string; updatedBy: string; timestamp: string }
): StigNarrativeChange[] {
  const out: StigNarrativeChange[] = [];
  for (const id of Object.keys(narratives)) {
    const text = narratives[id];
    if (!text) continue;

    const current: ControlState = controls[id] ?? {
      id,
      tenantId: ctx.tenantId,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: ctx.timestamp,
      tags: [],
    };

    const existing = current.implementationNotes;
    const notes = existing && existing.trim()
      ? (existing.includes(text) ? existing : `${existing}\n\n[STIG Baseline Implementation]:\n${text}`)
      : text;

    const serverUpdate: Partial<ControlState> = { implementationNotes: notes, updatedBy: ctx.updatedBy };
    if (current.status === 'NOT_STARTED') serverUpdate.status = 'IN_PROGRESS';

    out.push({
      id,
      serverUpdate,
      next: {
        ...current,
        implementationNotes: notes,
        status: current.status === 'NOT_STARTED' ? 'IN_PROGRESS' : current.status,
        lastUpdated: ctx.timestamp,
        updatedBy: ctx.updatedBy,
      },
    });
  }
  return out;
}
