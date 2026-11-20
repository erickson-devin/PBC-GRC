/**
 * CUI Registry (NARA) helpers. Pure: the data (cuiRegistry.json) is injected, so the browser can load it lazily
 * (cuiRegistryLazy.ts) and the server can import it statically (server/inventory/cuiCategories.ts).
 *
 * A category is "specified" when the registry lists a CUI//SP-XXX banner for it, "basic" when it lists a plain CUI banner
 * (or CUI//NETW for Net Worth), "both" when it lists both and "none" when it lists neither (the two NATO rows).
 */
export type CuiDesignation = 'SPECIFIED' | 'BASIC' | 'BOTH' | 'NONE';

export interface CuiIndexGroup {
  id: string;
  name: string;
}

export interface CuiCategory {
  /** Category marking abbreviation when the registry lists one, otherwise a slug of the name. */
  id: string;
  name: string;
  /** Id of an entry in `indexGroups` (page 1 of the registry is the source for the grouping). */
  indexGroup: string;
  /** The registry's category marking abbreviation; null where none is listed. */
  marking: string | null;
  /** Banner marking under specified authorities, for example CUI//SP-CTI; null where not listed. */
  specifiedBanner: string | null;
  /** Banner marking under basic authorities: CUI (CUI//NETW for Net Worth); null where not listed. */
  basicBanner: string | null;
  designation: CuiDesignation;
}

export interface CuiRegistry {
  _meta: {
    title: string;
    source: string;
    sourceUrls: { categoryList: string; markingList: string };
    license: string;
    asOf: string;
    sourceLastReviewed: { categoryList: string; markingList: string };
    verified: boolean;
    verifiedNote: string;
    compiledBy: string;
  };
  indexGroups: CuiIndexGroup[];
  categories: CuiCategory[];
}

export const CUI_DESIGNATIONS: readonly CuiDesignation[] = ['SPECIFIED', 'BASIC', 'BOTH', 'NONE'];
/** The server stores a category id in a column with this pattern CHECK. */
export const CUI_CATEGORY_ID_PATTERN = /^[A-Z][A-Z0-9_-]{0,47}$/;
const SPECIFIED_BANNER = /^CUI\/\/SP-[A-Z]+$/;
const BASIC_BANNER = /^CUI(\/\/[A-Z]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The list of problems found in a raw registry, [] when it is well formed. Never echoes a value that came from the data. */
export function validateCuiRegistry(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ['registry is not an object'];
  const meta = raw._meta;
  if (!isObj(meta)) problems.push('_meta is missing');
  else {
    for (const k of ['title', 'source', 'license', 'asOf', 'verifiedNote', 'compiledBy']) if (typeof meta[k] !== 'string' || !meta[k]) problems.push(`_meta.${k} is missing`);
    if (typeof meta.asOf === 'string' && !ISO_DATE.test(meta.asOf)) problems.push('_meta.asOf is not an ISO date');
    if (typeof meta.verified !== 'boolean') problems.push('_meta.verified is not a boolean');
    const urls = meta.sourceUrls;
    if (!isObj(urls) || typeof urls.categoryList !== 'string' || typeof urls.markingList !== 'string') problems.push('_meta.sourceUrls is incomplete');
    const rev = meta.sourceLastReviewed;
    if (!isObj(rev) || typeof rev.categoryList !== 'string' || typeof rev.markingList !== 'string') problems.push('_meta.sourceLastReviewed is incomplete');
  }
  const groups = raw.indexGroups;
  const cats = raw.categories;
  if (!Array.isArray(groups)) problems.push('indexGroups is not a list');
  if (!Array.isArray(cats)) problems.push('categories is not a list');
  if (!Array.isArray(groups) || !Array.isArray(cats)) return problems;
  const groupIds = new Set<string>();
  groups.forEach((g, i) => {
    if (!isObj(g) || typeof g.id !== 'string' || typeof g.name !== 'string' || !g.id || !g.name) problems.push(`indexGroups[${i}] is malformed`);
    else if (groupIds.has(g.id)) problems.push(`indexGroups[${i}] repeats an id`);
    else groupIds.add(g.id);
  });
  const ids = new Set<string>();
  cats.forEach((c, i) => {
    if (!isObj(c)) {
      problems.push(`categories[${i}] is not an object`);
      return;
    }
    if (typeof c.id !== 'string' || !CUI_CATEGORY_ID_PATTERN.test(c.id)) problems.push(`categories[${i}].id is malformed`);
    else if (ids.has(c.id)) problems.push(`categories[${i}].id repeats an id`);
    else ids.add(c.id);
    if (typeof c.name !== 'string' || !c.name) problems.push(`categories[${i}].name is missing`);
    if (typeof c.indexGroup !== 'string' || !groupIds.has(c.indexGroup)) problems.push(`categories[${i}].indexGroup is not a listed grouping`);
    if (c.marking !== null && typeof c.marking !== 'string') problems.push(`categories[${i}].marking is malformed`);
    if (c.specifiedBanner !== null && (typeof c.specifiedBanner !== 'string' || !SPECIFIED_BANNER.test(c.specifiedBanner))) problems.push(`categories[${i}].specifiedBanner is malformed`);
    if (c.basicBanner !== null && (typeof c.basicBanner !== 'string' || !BASIC_BANNER.test(c.basicBanner))) problems.push(`categories[${i}].basicBanner is malformed`);
    const expected = c.specifiedBanner && c.basicBanner ? 'BOTH' : c.specifiedBanner ? 'SPECIFIED' : c.basicBanner ? 'BASIC' : 'NONE';
    if (c.designation !== expected) problems.push(`categories[${i}].designation does not match its banners`);
  });
  return problems;
}

/** Categories under their index groupings, groupings in registry order, categories in registry order. Empty groupings are kept. */
export function groupCategories(r: CuiRegistry): { group: CuiIndexGroup; categories: CuiCategory[] }[] {
  return r.indexGroups.map((group) => ({ group, categories: r.categories.filter((c) => c.indexGroup === group.id) }));
}

/** Where "View on NARA" goes. Per-category pages were not verified, so every link is the category list page. */
export function categoryLink(r: CuiRegistry, _c?: CuiCategory): string {
  return r._meta.sourceUrls.categoryList;
}
