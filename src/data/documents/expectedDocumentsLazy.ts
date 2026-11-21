import type { ExpectedDocumentCatalog } from './expectedDocuments';

let loading: Promise<ExpectedDocumentCatalog> | null = null;

/** Loads the expected documents catalog into the browser, once, as a separate file (own chunk, see vite.config.ts). A failed load is not kept: the next call tries again. */
export function loadExpectedDocuments(): Promise<ExpectedDocumentCatalog> {
  loading ??= import('./expectedDocuments.json').then(
    (m) => m.default as unknown as ExpectedDocumentCatalog,
    (err: unknown) => {
      loading = null;
      throw err;
    }
  );
  return loading;
}
