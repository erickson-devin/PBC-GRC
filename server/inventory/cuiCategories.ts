import registry from '../../src/data/cui/cuiRegistry.json';
import type { CuiRegistry } from '../../src/data/cui/cuiRegistry';

/** The shipped CUI Registry, imported statically (the server runs from the copied src/). */
export const CUI_REGISTRY = registry as unknown as CuiRegistry;

/** Every category id a program's data inventory may name. Control and category ids are not CUI. */
export const CUI_CATEGORY_IDS: ReadonlySet<string> = new Set(CUI_REGISTRY.categories.map((c) => c.id));

export const isKnownCuiCategory = (id: unknown): id is string => typeof id === 'string' && CUI_CATEGORY_IDS.has(id);
