import type { CuiRegistry } from './cuiRegistry';

let loading: Promise<CuiRegistry> | null = null;

/** Loads the CUI Registry into the browser, once, as a separate file (own chunk, see vite.config.ts). A failed load is not kept: the next call tries again. */
export function loadCuiRegistry(): Promise<CuiRegistry> {
  loading ??= import('./cuiRegistry.json').then(
    (m) => m.default as unknown as CuiRegistry,
    (err: unknown) => {
      loading = null;
      throw err;
    }
  );
  return loading;
}
