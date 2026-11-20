// ---------------------------------------------------------------------------------------------- change notification
// Every component that shows the Tools and Services register, a program's boundary or its data inventory (the register panel, the SSP builder, the
// always-mounted export modal) follows a change made by any other one. Nothing is stored here: only the fact that something changed travels.

/** 'tools': the register (tools and recovery order); 'vendors': the vendor register; 'program': a program's boundary, links and documents; 'data': its data inventory. */
export type InventoryChangeKind = 'tools' | 'vendors' | 'program' | 'data';

/** `origin` identifies the hook instance that made the change, so it does not reload itself; `programId` is set for 'program' and 'data'. */
type Listener = (change: { tenantId: string; kind: InventoryChangeKind; programId: string | null; origin: symbol | null }) => void;
const listeners = new Set<Listener>();

export function subscribeInventory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const notifyInventoryChanged = (tenantId: string, kind: InventoryChangeKind, programId: string | null = null, origin: symbol | null = null): void =>
  listeners.forEach((l) => l({ tenantId, kind, programId, origin }));
