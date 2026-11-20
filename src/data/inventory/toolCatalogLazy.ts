import type { ToolCatalog } from './toolCatalog';

let loading: Promise<ToolCatalog> | null = null;

/** Loads the Quick add catalog into the browser, once, as a separate file (own chunk, see vite.config.ts). */
export function loadToolCatalog(): Promise<ToolCatalog> {
  loading ??= import('./toolCatalog.json').then((m) => m.default as unknown as ToolCatalog);
  return loading;
}
