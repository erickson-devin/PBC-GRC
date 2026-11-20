import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { notifyInventoryChanged, subscribeInventory } from '../services/inventoryService';
import type { ProgramInventory, ToolControlLink, VendorDocumentKind, VendorDocumentLink } from '../types/inventory';

/**
 * 'unsupported': a tenant stored only in this browser (no programs); 'no_program': the organization has no open program, so there is
 * no boundary to show; 'loading' also covers a disabled hook.
 */
export type ProgramInventoryStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error';

export interface UseProgramInventory {
  supported: boolean;
  status: ProgramInventoryStatus;
  programId: string | null;
  /** False while the program names no tool: its boundary is then the whole register. */
  declared: boolean;
  toolIds: ReadonlySet<string>;
  controlLinks: ToolControlLink[];
  vendorDocuments: VendorDocumentLink[];
  reload: () => Promise<void>;
  /** Every mutator rejects with the ApiError unchanged (a 409 `tool_in_use` carries `inUse`); after a 404 or 409 the state has been reloaded first. */
  patchTools: (change: { add?: string[]; remove?: string[]; force?: boolean }) => Promise<void>;
  /** Replaces the tool's links in this program; `expectedControlIds` is the set the caller last saw. Resolves to the links now stored. */
  putControls: (toolId: string, controls: { controlId: string; evidenceSource: boolean }[], expectedControlIds: string[]) => Promise<ToolControlLink[]>;
  linkDocument: (vendorId: string, evidenceId: string, docKind: VendorDocumentKind) => Promise<{ changed: boolean }>;
  unlinkDocument: (vendorId: string, evidenceId: string) => Promise<void>;
}

interface Loaded {
  scope: string;
  inventory: ProgramInventory;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const NO_LINKS: ToolControlLink[] = [];
const NO_DOCUMENTS: VendorDocumentLink[] = [];

const scopeOf = (tenantId: string, programId: string): string => `${tenantId}::${programId}`;

const isOutOfDate = (err: unknown): boolean => {
  const status = ((err ?? {}) as { status?: unknown }).status;
  return status === 404 || status === 409;
};

/**
 * The active program's side of the register: its declared boundary (none declared means the whole register), the controls each tool is linked to
 * and its vendor documents. Server-backed tenants only. Held in React state only. On a program switch the state is cleared at once, then reloaded,
 * so another program's links never show; it also reloads when the register changes (a deleted tool leaves every program).
 */
export function useProgramInventory(options?: { enabled?: boolean }): UseProgramInventory {
  const enabled = options?.enabled ?? true;
  const { currentTenant, activeProgram, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const programId = activeProgram?.id ?? null;
  const scope = supported && programId ? scopeOf(tenantId, programId) : null;
  const active = enabled && scope !== null;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('programInventory'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active || !scope || !programId) return;
    try {
      const inventory = await ApiClient.getProgramInventory(tenantId, programId);
      if (request !== latest.current) return; // a newer request (or another program) superseded this one
      setLoaded({ scope, inventory });
      setFailedFor(null);
    } catch {
      if (request !== latest.current) return;
      setFailedFor(scope);
    }
  }, [active, scope, tenantId, programId]);

  useEffect(() => {
    void reload();
    if (!active) return undefined;
    return subscribeInventory((c) => {
      if (c.tenantId !== tenantId || c.origin === origin.current) return;
      const sameProgram = c.programId === null || c.programId === programId;
      if (c.kind === 'tools' || (c.kind === 'program' && sameProgram)) void reload();
    });
  }, [active, tenantId, programId, reload]);

  const change = useCallback(
    async <T>(run: (id: string) => Promise<T>): Promise<T> => {
      if (!active || !programId) throw new Error('No program is active.');
      let result: T;
      try {
        result = await run(programId);
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
      await reload();
      notifyInventoryChanged(tenantId, 'program', programId, origin.current);
      return result;
    },
    [active, programId, tenantId, reload]
  );

  const patchTools = useCallback(
    async (delta: { add?: string[]; remove?: string[]; force?: boolean }): Promise<void> => {
      if (!delta.add?.length && !delta.remove?.length) return;
      await change((id) => ApiClient.patchProgramTools(tenantId, delta, id));
    },
    [change, tenantId]
  );
  const putControls = useCallback(
    async (toolId: string, controls: { controlId: string; evidenceSource: boolean }[], expectedControlIds: string[]): Promise<ToolControlLink[]> => {
      const res = await change((id) => ApiClient.putToolControls(tenantId, toolId, controls, expectedControlIds, id));
      return res.controls.map((c) => ({ toolId, controlId: c.controlId, evidenceSource: c.evidenceSource }));
    },
    [change, tenantId]
  );
  const linkDocument = useCallback(
    async (vendorId: string, evidenceId: string, docKind: VendorDocumentKind): Promise<{ changed: boolean }> => {
      const res = await change((id) => ApiClient.linkVendorDocument(tenantId, { vendorId, evidenceId, docKind }, id));
      return { changed: res.changed };
    },
    [change, tenantId]
  );
  const unlinkDocument = useCallback(
    async (vendorId: string, evidenceId: string): Promise<void> => {
      await change((id) => ApiClient.unlinkVendorDocument(tenantId, vendorId, evidenceId, id));
    },
    [change, tenantId]
  );

  // Another program's (or organization's) boundary never shows while this one loads
  const mine = loaded && scope !== null && loaded.scope === scope ? loaded.inventory : null;
  const toolIds = useMemo<ReadonlySet<string>>(() => (mine ? new Set(mine.toolIds) : EMPTY_SET), [mine]);
  const status: ProgramInventoryStatus = !supported
    ? 'unsupported'
    : programsStatus === 'ready' && !activeProgram
    ? 'no_program'
    : !active
    ? 'loading'
    : failedFor === scope
    ? 'error'
    : mine
    ? 'ready'
    : 'loading';
  return useMemo<UseProgramInventory>(
    () => ({
      supported,
      status,
      programId,
      declared: mine?.declared ?? false,
      toolIds,
      controlLinks: mine?.controlLinks ?? NO_LINKS,
      vendorDocuments: mine?.vendorDocuments ?? NO_DOCUMENTS,
      reload,
      patchTools,
      putControls,
      linkDocument,
      unlinkDocument,
    }),
    [supported, status, programId, mine, toolIds, reload, patchTools, putControls, linkDocument, unlinkDocument]
  );
}
