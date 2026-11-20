import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToolRegister } from './useToolRegister';
import { useProgramInventory } from './useProgramInventory';
import { useDataInventory } from './useDataInventory';
import { loadCuiRegistry } from '../data/cui/cuiRegistryLazy';
import type { CuiRegistry } from '../data/cui/cuiRegistry';
import { buildSspInventoryCompletenessInput, buildSspInventorySnapshot, type SspInventoryCompletenessInput, type SspInventorySnapshot } from '../data/inventory/sspInventory';

/** 'unsupported': a browser-only organization or no open program (1.3 and 1.4 say "not available"); 'loading' also covers a disabled hook. */
export type SspInventoryStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseSspInventory {
  status: SspInventoryStatus;
  /** What the SSP prints of 1.3 and 1.4; `supported: false` until `status` is 'ready'. */
  snapshot: SspInventorySnapshot;
  /** For the completeness check; only when `status` is 'ready' (otherwise 1.3 and 1.4 are unavailable). */
  completenessInput: SspInventoryCompletenessInput | undefined;
  registry: CuiRegistry | null;
  registryStatus: 'loading' | 'ready' | 'error';
  /** Asks for the CUI Registry list again. */
  reloadRegistry: () => void;
  /** Reloads the register, the boundary and the data inventory. */
  reload: () => Promise<void>;
  /** The program's boundary tools that can hold CUI (out-of-scope tools left out), for the data inventory's tool matrix. */
  boundaryTools: { id: string; name: string }[];
}

const NOT_SUPPORTED = buildSspInventorySnapshot({ supported: false, tools: [], program: null, data: null, registry: null });

/**
 * The Tools and Services register and the data inventory of the active program, read-only, as the SSP shows and checks them: the snapshot of 1.3
 * and 1.4 and the completeness input. Composes the register, the program's boundary, the data inventory and the lazily loaded CUI Registry list.
 * With `enabled: false` nothing is loaded. React state only.
 */
export function useSspInventory(options?: { enabled?: boolean }): UseSspInventory {
  const enabled = options?.enabled ?? true;
  const register = useToolRegister({ enabled });
  const program = useProgramInventory({ enabled });
  const data = useDataInventory({ enabled });

  const supported = register.supported && program.supported && program.status !== 'no_program';
  const wantRegistry = enabled && supported;
  const [registry, setRegistry] = useState<CuiRegistry | null>(null);
  const [registryStatus, setRegistryStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [registryTry, setRegistryTry] = useState(0);
  useEffect(() => {
    if (!wantRegistry) return undefined;
    let cancelled = false;
    setRegistryStatus('loading');
    loadCuiRegistry().then(
      (r) => {
        if (cancelled) return;
        setRegistry(r);
        setRegistryStatus('ready');
      },
      () => {
        if (!cancelled) setRegistryStatus('error');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [wantRegistry, registryTry]);
  const reloadRegistry = useCallback(() => setRegistryTry((n) => n + 1), []);

  const parts = [register.status, program.status, data.status];
  const status: SspInventoryStatus = !enabled
    ? 'loading'
    : !supported
    ? 'unsupported'
    : parts.includes('error')
    ? 'error'
    : register.status === 'ready' && program.status === 'ready' && (data.status === 'ready' || data.status === 'stale') && registryStatus !== 'loading'
    ? 'ready'
    : 'loading';

  const ready = status === 'ready';
  const sources = useMemo(
    () => ({ supported: ready, tools: register.tools, program: { declared: program.declared, toolIds: [...program.toolIds] }, data: data.record, registry }),
    [ready, register.tools, program.declared, program.toolIds, data.record, registry]
  );
  const snapshot = useMemo(() => (ready ? buildSspInventorySnapshot(sources) : NOT_SUPPORTED), [ready, sources]);
  const completenessInput = useMemo(() => (ready ? buildSspInventoryCompletenessInput(sources) : undefined), [ready, sources]);
  const boundaryTools = useMemo(() => snapshot.tools.map((t) => ({ id: t.id, name: t.name })), [snapshot]);

  const { reload: reloadRegister } = register;
  const { reload: reloadProgram } = program;
  const { reload: reloadData } = data;
  const reload = useCallback(async (): Promise<void> => {
    await Promise.all([reloadRegister(), reloadProgram(), reloadData()]);
  }, [reloadRegister, reloadProgram, reloadData]);

  return useMemo<UseSspInventory>(
    () => ({ status, snapshot, completenessInput, registry, registryStatus, reloadRegistry, reload, boundaryTools }),
    [status, snapshot, completenessInput, registry, registryStatus, reloadRegistry, reload, boundaryTools]
  );
}
