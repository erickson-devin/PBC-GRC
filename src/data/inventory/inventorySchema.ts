// Validation of the Tools and Services register (tools, vendors), the tool-to-control links, the recovery order and the data inventory.
// Pure: shared by the server routes and the client. Errors name the field and never echo a value (names, missions and notes may be CUI).
import { isCmmcAssetCategory } from '../telemetry/assetScope';
import {
  FEDRAMP_STATUSES,
  MAX_BATCH,
  MAX_CUI_TOOL_ROWS_PER_PROGRAM,
  MAX_LINKS_PER_TOOL,
  MAX_TOOLS_PER_TENANT,
  TOOL_DEPLOYMENTS,
  TOOL_TYPES,
  VENDOR_DOCUMENT_KINDS,
  VENDOR_KINDS,
  type CuiToolRole,
  type FedrampStatus,
  type ToolControlLink,
  type ToolInput,
  type VendorDocumentKind,
  type VendorKind,
} from '../../types/inventory';

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** Field caps (the SQL columns are at least this wide). */
export const INVENTORY_LIMITS = {
  name: 255,
  vendorName: 255,
  mission: 1000,
  notes: 4000,
  services: 4000,
  fedrampReference: 128,
  maxCount: 10_000_000,
  maxCostCents: 100_000_000_000,
} as const;

export const INVENTORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CONTROL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const CUI_CATEGORY_ID_PATTERN = /^[A-Z][A-Z0-9_-]{0,47}$/;
export const SEED_KEY_PATTERN = /^(survey|catalog):[A-Za-z0-9_.-]{1,80}$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A real calendar date written YYYY-MM-DD (years 1900 to 2999). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (y < 1900 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

function text(body: Record<string, unknown>, key: string, max: number, multiline = false): Validation<string | undefined> {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return fail(`${key} must be text`);
  const value = raw.trim();
  if (value.length > max) return fail(`${key} must be at most ${max} characters`);
  if ((multiline ? MULTILINE_CONTROL_CHARS : CONTROL_CHARS).test(value)) return fail(`${key} contains control characters`);
  return { ok: true, value };
}

/** Null, or one of the listed values; undefined (absent) passes through. */
function nullableOneOf<T extends string>(body: Record<string, unknown>, key: string, list: readonly T[], isValid?: (v: unknown) => boolean): Validation<T | null | undefined> {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: raw };
  const valid = typeof raw === 'string' && (isValid ? isValid(raw) : (list as readonly string[]).includes(raw));
  return valid ? { ok: true, value: raw as T } : fail(`${key} is not a valid value`);
}

function nullableDate(body: Record<string, unknown>, key: string): Validation<string | null | undefined> {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: raw };
  return isIsoDate(raw) ? { ok: true, value: raw } : fail(`${key} must be a calendar date written YYYY-MM-DD`);
}

function nullableInt(body: Record<string, unknown>, key: string, max: number): Validation<number | null | undefined> {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: raw };
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max ? { ok: true, value: raw } : fail(`${key} must be a whole number from 0 to ${max}`);
}

function nullableBool(body: Record<string, unknown>, key: string): Validation<boolean | null | undefined> {
  const raw = body[key];
  if (raw === undefined || raw === null || typeof raw === 'boolean') return { ok: true, value: raw };
  return fail(`${key} must be true, false or null`);
}

export type ToolInputWithSeed = ToolInput & { seedKey?: string };

/**
 * Validates a tool request body. With `partial` (PUT) only the fields present are returned and none is required; otherwise (POST) a name is
 * required and the store applies the defaults. `allowSeedKey` (the batch) also accepts `seedKey` ('survey:<key>' or 'catalog:<id>').
 * recoveryRank and origin are never taken from a body.
 */
export function validateToolInput(body: unknown, partial: boolean, opts: { allowSeedKey?: boolean } = {}): Validation<ToolInputWithSeed> {
  if (!isRecord(body)) return fail('Request body must be a JSON object');
  const out: ToolInputWithSeed = {};

  const name = text(body, 'name', INVENTORY_LIMITS.name);
  if (!name.ok) return name;
  if (name.value !== undefined) {
    if (name.value === '') return fail('name is required');
    out.name = name.value;
  } else if (!partial) {
    return fail('name is required');
  }

  const vendorName = text(body, 'vendorName', INVENTORY_LIMITS.vendorName);
  if (!vendorName.ok) return vendorName;
  if (vendorName.value !== undefined) out.vendorName = vendorName.value;
  const mission = text(body, 'mission', INVENTORY_LIMITS.mission);
  if (!mission.ok) return mission;
  if (mission.value !== undefined) out.mission = mission.value;
  const notes = text(body, 'notes', INVENTORY_LIMITS.notes, true);
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;

  if (body.vendorId !== undefined) {
    if (body.vendorId !== null && (typeof body.vendorId !== 'string' || !INVENTORY_ID_PATTERN.test(body.vendorId))) return fail('vendorId is invalid');
    out.vendorId = body.vendorId;
  }
  const toolType = nullableOneOf(body, 'toolType', TOOL_TYPES);
  if (!toolType.ok) return toolType;
  if (toolType.value !== undefined) out.toolType = toolType.value;
  const deployment = nullableOneOf(body, 'deployment', TOOL_DEPLOYMENTS);
  if (!deployment.ok) return deployment;
  if (deployment.value !== undefined) out.deployment = deployment.value;
  const category = nullableOneOf(body, 'assetCategory', [] as never[], isCmmcAssetCategory);
  if (!category.ok) return category;
  if (category.value !== undefined) out.assetCategory = category.value as ToolInput['assetCategory'];

  if (body.fedrampStatus !== undefined) {
    if (typeof body.fedrampStatus !== 'string' || !(FEDRAMP_STATUSES as readonly string[]).includes(body.fedrampStatus)) return fail('fedrampStatus is not a valid value');
    out.fedrampStatus = body.fedrampStatus as FedrampStatus;
  }
  const verifiedOn = nullableDate(body, 'fedrampVerifiedOn');
  if (!verifiedOn.ok) return verifiedOn;
  if (verifiedOn.value !== undefined) out.fedrampVerifiedOn = verifiedOn.value;
  const crm = nullableBool(body, 'crmOnFile');
  if (!crm.ok) return crm;
  if (crm.value !== undefined) out.crmOnFile = crm.value;

  const endUsers = nullableInt(body, 'endUsers', INVENTORY_LIMITS.maxCount);
  if (!endUsers.ok) return endUsers;
  if (endUsers.value !== undefined) out.endUsers = endUsers.value;
  const privileged = nullableInt(body, 'privilegedUsers', INVENTORY_LIMITS.maxCount);
  if (!privileged.ok) return privileged;
  if (privileged.value !== undefined) out.privilegedUsers = privileged.value;
  const cost = nullableInt(body, 'annualCostCents', INVENTORY_LIMITS.maxCostCents);
  if (!cost.ok) return cost;
  if (cost.value !== undefined) out.annualCostCents = cost.value;
  const renewal = nullableDate(body, 'renewalDate');
  if (!renewal.ok) return renewal;
  if (renewal.value !== undefined) out.renewalDate = renewal.value;

  if (opts.allowSeedKey && body.seedKey !== undefined && body.seedKey !== null) {
    if (typeof body.seedKey !== 'string' || !SEED_KEY_PATTERN.test(body.seedKey)) return fail('seedKey is invalid');
    out.seedKey = body.seedKey;
  }
  return { ok: true, value: out };
}

export interface VendorInput {
  name?: string;
  kind?: VendorKind;
  services?: string;
  contractStart?: string | null;
  contractEnd?: string | null;
  renewalDate?: string | null;
  fedrampStatus?: FedrampStatus;
  fedrampReference?: string;
  fedrampVerifiedOn?: string | null;
  crmOnFile?: boolean | null;
  lastReviewDate?: string | null;
  notes?: string;
}

/** Validates a vendor / external service provider body (same `partial` meaning as validateToolInput). A contract end before its start is refused. */
export function validateVendorInput(body: unknown, partial: boolean): Validation<VendorInput> {
  if (!isRecord(body)) return fail('Request body must be a JSON object');
  const out: VendorInput = {};

  const name = text(body, 'name', INVENTORY_LIMITS.name);
  if (!name.ok) return name;
  if (name.value !== undefined) {
    if (name.value === '') return fail('name is required');
    out.name = name.value;
  } else if (!partial) {
    return fail('name is required');
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !(VENDOR_KINDS as readonly string[]).includes(body.kind)) return fail('kind is not a valid value');
    out.kind = body.kind as VendorKind;
  }
  const services = text(body, 'services', INVENTORY_LIMITS.services, true);
  if (!services.ok) return services;
  if (services.value !== undefined) out.services = services.value;
  for (const key of ['contractStart', 'contractEnd', 'renewalDate', 'fedrampVerifiedOn', 'lastReviewDate'] as const) {
    const d = nullableDate(body, key);
    if (!d.ok) return d;
    if (d.value !== undefined) out[key] = d.value;
  }
  if (body.fedrampStatus !== undefined) {
    if (typeof body.fedrampStatus !== 'string' || !(FEDRAMP_STATUSES as readonly string[]).includes(body.fedrampStatus)) return fail('fedrampStatus is not a valid value');
    out.fedrampStatus = body.fedrampStatus as FedrampStatus;
  }
  const reference = text(body, 'fedrampReference', INVENTORY_LIMITS.fedrampReference);
  if (!reference.ok) return reference;
  if (reference.value !== undefined) out.fedrampReference = reference.value;
  const crm = nullableBool(body, 'crmOnFile');
  if (!crm.ok) return crm;
  if (crm.value !== undefined) out.crmOnFile = crm.value;
  const notes = text(body, 'notes', INVENTORY_LIMITS.notes, true);
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;

  if (out.contractStart && out.contractEnd && out.contractEnd < out.contractStart) return fail('contractEnd must not be before contractStart');
  return { ok: true, value: out };
}

/** A list of ids (each matching `pattern`), without duplicates. */
function idList(raw: unknown, key: string, pattern: RegExp, max: number): Validation<string[]> {
  if (!Array.isArray(raw)) return fail(`${key} must be a list`);
  if (raw.length > max) return fail(`${key} has too many entries (at most ${max})`);
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || !pattern.test(id)) return fail(`${key} holds an invalid id`);
    if (seen.has(id)) return fail(`${key} holds a duplicate id`);
    seen.add(id);
  }
  return { ok: true, value: [...raw] as string[] };
}

/** Body of PUT /tools/recovery-order: the ranked ids (rank 1..n) and the order the client last saw. */
export function validateRecoveryOrderInput(body: unknown): Validation<{ order: string[]; expectedOrder: string[] }> {
  if (!isRecord(body)) return fail('Request body must be a JSON object');
  const order = idList(body.order, 'order', INVENTORY_ID_PATTERN, MAX_TOOLS_PER_TENANT);
  if (!order.ok) return order;
  const expectedOrder = idList(body.expectedOrder, 'expectedOrder', INVENTORY_ID_PATTERN, MAX_TOOLS_PER_TENANT);
  if (!expectedOrder.ok) return expectedOrder;
  return { ok: true, value: { order: order.value, expectedOrder: expectedOrder.value } };
}

/** Body of PATCH /program-inventory/tools: deltas, not both empty, no id in both lists. */
export function validateToolIdChange(body: unknown): Validation<{ add: string[]; remove: string[]; force: boolean }> {
  const b = isRecord(body) ? body : {};
  const lists: string[][] = [];
  for (const key of ['add', 'remove'] as const) {
    const raw = b[key];
    if (raw === undefined) {
      lists.push([]);
      continue;
    }
    if (Array.isArray(raw) && new Set(raw).size !== raw.length) return fail(`${key} holds a duplicate id`);
    const list = idList(raw, key, INVENTORY_ID_PATTERN, MAX_TOOLS_PER_TENANT);
    if (!list.ok) return list;
    lists.push(list.value);
  }
  const [add, remove] = lists;
  if (add.length + remove.length === 0) return fail('Nothing to change: send add and/or remove with at least one tool id');
  const removing = new Set(remove);
  if (add.some((id) => removing.has(id))) return fail('A tool id cannot be in both add and remove');
  if (b.force !== undefined && typeof b.force !== 'boolean') return fail('force must be true or false');
  return { ok: true, value: { add, remove, force: b.force === true } };
}

/** Body of PUT /program-inventory/tools/:toolId/controls: the whole set of links, and the control ids the client last saw. */
export function validateToolControlsInput(body: unknown): Validation<{ controls: ToolControlLinkInput[]; expectedControlIds: string[] }> {
  if (!isRecord(body)) return fail('Request body must be a JSON object');
  if (!Array.isArray(body.controls)) return fail('controls must be a list');
  if (body.controls.length > MAX_LINKS_PER_TOOL) return fail(`controls has too many entries (at most ${MAX_LINKS_PER_TOOL})`);
  const seen = new Set<string>();
  const controls: ToolControlLinkInput[] = [];
  for (const c of body.controls) {
    if (!isRecord(c) || typeof c.controlId !== 'string' || !CONTROL_ID_PATTERN.test(c.controlId)) return fail('controls holds an invalid control id');
    if (typeof c.evidenceSource !== 'boolean') return fail('evidenceSource must be true or false');
    if (seen.has(c.controlId)) return fail('controls holds a duplicate control id');
    seen.add(c.controlId);
    controls.push({ controlId: c.controlId, evidenceSource: c.evidenceSource });
  }
  const expected = idList(body.expectedControlIds, 'expectedControlIds', CONTROL_ID_PATTERN, MAX_LINKS_PER_TOOL);
  if (!expected.ok) return expected;
  return { ok: true, value: { controls, expectedControlIds: expected.value } };
}

export type ToolControlLinkInput = Pick<ToolControlLink, 'controlId' | 'evidenceSource'>;

/** Body of POST /program-inventory/vendor-documents. */
export function validateVendorDocumentInput(body: unknown): Validation<{ vendorId: string; evidenceId: string; docKind: VendorDocumentKind }> {
  if (!isRecord(body)) return fail('Request body must be a JSON object');
  if (typeof body.vendorId !== 'string' || !INVENTORY_ID_PATTERN.test(body.vendorId)) return fail('vendorId is invalid');
  if (typeof body.evidenceId !== 'string' || !INVENTORY_ID_PATTERN.test(body.evidenceId)) return fail('evidenceId is invalid');
  if (typeof body.docKind !== 'string' || !(VENDOR_DOCUMENT_KINDS as readonly string[]).includes(body.docKind)) return fail('docKind is not a valid value');
  return { ok: true, value: { vendorId: body.vendorId, evidenceId: body.evidenceId, docKind: body.docKind as VendorDocumentKind } };
}

export interface DataInventoryInput {
  handlesFci: boolean | null;
  categories: { categoryId: string; tools: CuiToolRole[] }[];
}

export type DataInventoryValidation =
  | { ok: true; value: DataInventoryInput }
  | { ok: false; error: string; code: 'invalid' | 'unknown_cui_category'; /** Position of the offending category in the request (the id itself is never echoed). */ index?: number };

/**
 * Body of PUT /program-inventory/data-inventory: { handlesFci, categories: [{ categoryId, tools: [{ toolId, stores, processes, transmits }] }] }, a whole
 * replace. A category id must be in `knownCategoryIds` (the shipped registry) or already stored (`storedCategoryIds`: a later registry may drop an id
 * a program still holds); anything else is `unknown_cui_category`. A tool row needs at least one of stores / processes / transmits.
 */
export function validateDataInventoryInput(body: unknown, knownCategoryIds: ReadonlySet<string>, storedCategoryIds: ReadonlySet<string>): DataInventoryValidation {
  const bad = (error: string): DataInventoryValidation => ({ ok: false, error, code: 'invalid' });
  if (!isRecord(body)) return bad('Request body must be a JSON object');
  if (body.handlesFci !== null && typeof body.handlesFci !== 'boolean') return bad('handlesFci must be true, false or null');
  if (!Array.isArray(body.categories)) return bad('categories must be a list');
  if (body.categories.length > Math.max(knownCategoryIds.size, 1) + storedCategoryIds.size) return bad('categories has too many entries');
  const seenCategories = new Set<string>();
  const categories: DataInventoryInput['categories'] = [];
  let rows = 0;
  for (let i = 0; i < body.categories.length; i++) {
    const c = body.categories[i];
    if (!isRecord(c) || typeof c.categoryId !== 'string' || !CUI_CATEGORY_ID_PATTERN.test(c.categoryId)) return bad(`categories[${i}] has an invalid categoryId`);
    if (!knownCategoryIds.has(c.categoryId) && !storedCategoryIds.has(c.categoryId)) {
      return { ok: false, error: `categories[${i}] is not a category of the CUI Registry`, code: 'unknown_cui_category', index: i };
    }
    if (seenCategories.has(c.categoryId)) return bad(`categories[${i}] repeats a category`);
    seenCategories.add(c.categoryId);
    if (!Array.isArray(c.tools)) return bad(`categories[${i}].tools must be a list`);
    const seenTools = new Set<string>();
    const tools: CuiToolRole[] = [];
    for (let j = 0; j < c.tools.length; j++) {
      const t = c.tools[j];
      if (!isRecord(t) || typeof t.toolId !== 'string' || !INVENTORY_ID_PATTERN.test(t.toolId)) return bad(`categories[${i}].tools[${j}] has an invalid toolId`);
      if (typeof t.stores !== 'boolean' || typeof t.processes !== 'boolean' || typeof t.transmits !== 'boolean') return bad(`categories[${i}].tools[${j}] needs stores, processes and transmits as true or false`);
      if (!t.stores && !t.processes && !t.transmits) return bad(`categories[${i}].tools[${j}] must store, process or transmit`);
      if (seenTools.has(t.toolId)) return bad(`categories[${i}].tools[${j}] repeats a tool`);
      seenTools.add(t.toolId);
      if (++rows > MAX_CUI_TOOL_ROWS_PER_PROGRAM) return bad('Too many tool rows');
      tools.push({ toolId: t.toolId, stores: t.stores, processes: t.processes, transmits: t.transmits });
    }
    categories.push({ categoryId: c.categoryId, tools });
  }
  return { ok: true, value: { handlesFci: body.handlesFci, categories } };
}

/** Largest batch the register takes in one request (re-exported so callers need not reach into the types). */
export const MAX_TOOL_BATCH = MAX_BATCH;
