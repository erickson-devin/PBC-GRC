// ---------------------------------------------------------------------------------------------- change notification
// Every component that shows the document register, a program's documents or the expected-documents checklist (the register panel, the checklist, the SSP
// builder, the always-mounted export modal) follows a change made by any other one. Nothing is stored here: only the fact that something changed travels.

/** 'documents': the register (documents and their lifecycle); 'program': a program's set, control links, attachments and expected-document links. */
export type DocumentChangeKind = 'documents' | 'program';

/** `origin` identifies the hook instance that made the change, so it does not reload itself; `programId` is set for 'program'. */
type Listener = (change: { tenantId: string; kind: DocumentChangeKind; programId: string | null; origin: symbol | null }) => void;
const listeners = new Set<Listener>();

export function subscribeDocuments(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const notifyDocumentsChanged = (tenantId: string, kind: DocumentChangeKind, programId: string | null = null, origin: symbol | null = null): void =>
  listeners.forEach((l) => l({ tenantId, kind, programId, origin }));
