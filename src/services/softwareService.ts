// ---------------------------------------------------------------------------------------------- change notification

type Listener = (tenantId: string) => void;
const listeners = new Set<Listener>();

/** Lets every component that shows the software inventory (the panel, the Export Center) refresh when any of them changes it. */
export function subscribeSoftware(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const notifySoftwareChanged = (tenantId: string): void => listeners.forEach((l) => l(tenantId));
