// A one-shot hand-off between screens: the Living Policy Library asks the Document Register to open one document. Module state only: no storage, no
// logging (the id is not a title, but nothing about a document is kept anywhere that survives a reload).
let pending: string | null = null;

export function requestDocumentFocus(id: string): void {
  pending = id;
}

/** The requested document id, once: the next call returns null. */
export function takeDocumentFocus(): string | null {
  const id = pending;
  pending = null;
  return id;
}
