import catalog from '../../src/data/documents/expectedDocuments.json';
import type { ExpectedDocument, ExpectedDocumentCatalog } from '../../src/data/documents/expectedDocuments';

/** The shipped expected documents catalog, imported statically (the server runs from the copied src/). Ids are not CUI. */
export const EXPECTED_CATALOG = catalog as unknown as ExpectedDocumentCatalog;

/** The entries of one framework ([] for a framework without a list). */
export function expectedFor(framework: string): ExpectedDocument[] {
  return (EXPECTED_CATALOG.frameworks as Record<string, ExpectedDocument[] | undefined>)[framework] ?? [];
}

/** Every expected document id of every framework (ids carry their framework: cmmc-l2-..., nist-80053-...). */
export const EXPECTED_IDS: ReadonlySet<string> = new Set(Object.values(EXPECTED_CATALOG.frameworks).flatMap((list) => (list ?? []).map((e) => e.id)));

export const isKnownExpectedId = (id: unknown): id is string => typeof id === 'string' && EXPECTED_IDS.has(id);
