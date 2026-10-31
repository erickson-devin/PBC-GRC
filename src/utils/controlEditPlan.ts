import type { AssessmentState, ControlState, ControlStatus } from '../types/cmmc';
import type { FailingAssetInfo } from '../types/telemetry';

// What a control edit does, worked out from the current controls before anything is set, sent or recorded. A state updater must stay
// pure (StrictMode runs it twice), so the ledger entry and the server save are made once, outside it, from these plans.

export interface ControlEditContext {
  tenantId: string;
  updatedBy: string;
  timestamp: string;
}

/** A control nobody has touched yet. */
export function baseControlState(
  controls: Record<string, ControlState>,
  controlId: string,
  tenantId: string,
  timestamp: string
): ControlState {
  return controls[controlId] || {
    id: controlId,
    tenantId,
    status: 'NOT_STARTED',
    implementationNotes: '',
    responsibleRole: 'IT / Security Lead',
    lastUpdated: timestamp,
    tags: [],
  };
}

export interface StarterTemplatePlan {
  next: ControlState;
  serverUpdate: Partial<ControlState>;
  auditNewState: { status: 'IN_PROGRESS'; templateLength: number };
}

export function planStarterTemplate(
  controls: Record<string, ControlState>,
  controlId: string,
  narrative: string,
  ctx: ControlEditContext
): StarterTemplatePlan {
  const current = baseControlState(controls, controlId, ctx.tenantId, ctx.timestamp);
  const starting = current.status === 'NOT_STARTED';
  // Only the fields that change go to the server
  const serverUpdate: Partial<ControlState> = { implementationNotes: narrative, updatedBy: ctx.updatedBy };
  if (starting) serverUpdate.status = 'IN_PROGRESS';
  return {
    next: {
      ...current,
      implementationNotes: narrative,
      status: starting ? 'IN_PROGRESS' : current.status,
      lastUpdated: ctx.timestamp,
      updatedBy: ctx.updatedBy,
    },
    serverUpdate,
    auditNewState: { status: 'IN_PROGRESS', templateLength: narrative.length },
  };
}

export function planControlStatus(
  controls: Record<string, ControlState>,
  controlId: string,
  status: ControlStatus,
  failingAssets: FailingAssetInfo[] | undefined,
  ctx: ControlEditContext
): { next: ControlState; previousStatus: ControlStatus } {
  const current = baseControlState(controls, controlId, ctx.tenantId, ctx.timestamp);
  return {
    next: {
      ...current,
      status,
      failingAssets: failingAssets !== undefined ? failingAssets : current.failingAssets,
      lastUpdated: ctx.timestamp,
      updatedBy: ctx.updatedBy,
    },
    previousStatus: current.status,
  };
}

export function planControlRole(
  controls: Record<string, ControlState>,
  controlId: string,
  role: string,
  ctx: ControlEditContext
): { next: ControlState; previousRole: string } {
  const current = baseControlState(controls, controlId, ctx.tenantId, ctx.timestamp);
  return {
    next: { ...current, responsibleRole: role, lastUpdated: ctx.timestamp, updatedBy: ctx.updatedBy },
    previousRole: current.responsibleRole,
  };
}

/** The updater body: puts a planned control into the state. */
export function applyControlNext(prev: AssessmentState, controlId: string, next: ControlState): AssessmentState {
  return { ...prev, controls: { ...prev.controls, [controlId]: next } };
}
