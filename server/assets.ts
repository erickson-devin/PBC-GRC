import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from './db';
import { CMMC_ASSET_CATEGORIES, isCmmcAssetCategory } from '../src/data/telemetry/assetScope';
import { FipsFields, NO_FIPS, isFipsStandard, isFipsStatus, normalizeFips, resolveFips, FIPS_STANDARDS, FIPS_STATUSES } from '../src/data/telemetry/fipsValidation';
import type {
  AccretionDiscoveryItem,
  AccretionMetadata,
  AssetDiscoveryStatus,
  AssetSourceOrigin,
  CmmcAssetCategory,
  EnclaveAsset,
  EnclaveAssetStatus,
} from '../src/types/telemetry';

/**
 * CMMC asset scoping store: the enclave's asset inventory, each asset carrying its CMMC category.
 *
 * Column / API naming: the table uses asset_name, description, cmmc_category, owner. The API speaks the client's
 * EnclaveAsset shape, so asset_name <-> hostName, description <-> notes, cmmc_category <-> cmmcAssetCategory.
 *
 * Tenant isolation: every PostgreSQL statement runs in a transaction that sets app.current_tenant_id, and
 * enclave_assets has FORCE ROW LEVEL SECURITY with that tenant policy (see schema.ts), so a statement cannot reach
 * another tenant's rows even if the WHERE clause were wrong. The in-memory store (DB_MODE=memory) filters by tenant id.
 */

export type AssetErrorCode = 'not_found' | 'duplicate' | 'limit' | 'invalid';

export class AssetError extends Error {
  readonly code: AssetErrorCode;
  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

export const MAX_ASSETS_PER_TENANT = 5000;
export const MAX_BULK_ASSETS = 500;
export const MAX_DISCOVERY_ITEMS = 500;

const STATUSES: readonly EnclaveAssetStatus[] = ['ACTIVE', 'INACTIVE', 'NON_COMPLIANT', 'NEVER_SCANNED'];
const ORIGINS: readonly AssetSourceOrigin[] = ['MANUAL_ENTRY', 'ACCRETION_DISCOVERY', 'PHOTON_AGENT', 'CSV_IMPORT'];
const DISCOVERY: readonly AssetDiscoveryStatus[] = ['ACTIVE', 'STALE', 'UNCONFIRMED_DISCOVERY', 'DECOMMISSIONED'];

// ------------------------------------------------------------------------------------------------ validation

/** The writable fields of an asset (everything else is server-managed). */
export interface AssetFields extends FipsFields {
  hostName: string;
  notes: string;
  cmmcAssetCategory: CmmcAssetCategory;
  owner: string;
  ipAddress: string;
  macAddress: string;
  osProfile: string;
  status: EnclaveAssetStatus;
  sourceOrigin: AssetSourceOrigin;
  discoveryStatus: AssetDiscoveryStatus;
  accretionMetadata: AccretionMetadata | null;
  lastScannedAt: string | null;
  complianceScore: number | null;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const NETWORK_ADDRESS = /^[A-Za-z0-9.:_/%-]{0,64}$/;
const MAC_ADDRESS = /^[0-9A-Fa-f:.-]{0,32}$/;
const OS_PROFILE = /^[A-Za-z0-9 ._()/+-]{1,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(body: Record<string, unknown>, key: string, max: number, label: string, multiline = false): Validation<string | undefined> {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be text` };
  const value = raw.trim();
  if (value.length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
  if (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) : CONTROL_CHARS.test(value)) {
    return { ok: false, error: `${label} contains control characters` };
  }
  return { ok: true, value };
}

/**
 * Validates an asset request body. With `partial` (PUT) only the fields present are returned and none are required;
 * otherwise (POST) a name and a CMMC category are required and the rest get defaults.
 */
export function validateAssetInput(body: unknown, partial: boolean): Validation<Partial<AssetFields>> {
  if (!isRecord(body)) return { ok: false, error: 'Request body must be a JSON object' };
  const out: Partial<AssetFields> = {};

  const name = text(body, 'hostName', 255, 'Asset name');
  if (!name.ok) return name;
  if (name.value !== undefined) {
    if (name.value === '') return { ok: false, error: 'Asset name is required' };
    out.hostName = name.value;
  } else if (!partial) {
    return { ok: false, error: 'Asset name is required' };
  }

  // `description` is accepted as an alias of `notes`
  const notesKey = body.notes !== undefined ? 'notes' : 'description';
  const notes = text(body, notesKey, 4000, 'Description', true);
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;

  const owner = text(body, 'owner', 255, 'Owner');
  if (!owner.ok) return owner;
  if (owner.value !== undefined) out.owner = owner.value;

  if (body.cmmcAssetCategory !== undefined) {
    if (!isCmmcAssetCategory(body.cmmcAssetCategory)) {
      return { ok: false, error: `CMMC category must be one of: ${CMMC_ASSET_CATEGORIES.join(', ')}` };
    }
    out.cmmcAssetCategory = body.cmmcAssetCategory;
  } else if (!partial) {
    return { ok: false, error: `CMMC category is required (one of: ${CMMC_ASSET_CATEGORIES.join(', ')})` };
  }

  const ip = text(body, 'ipAddress', 64, 'IP address');
  if (!ip.ok) return ip;
  if (ip.value !== undefined) {
    if (!NETWORK_ADDRESS.test(ip.value)) return { ok: false, error: 'IP address contains invalid characters' };
    out.ipAddress = ip.value;
  }
  const mac = text(body, 'macAddress', 32, 'MAC address');
  if (!mac.ok) return mac;
  if (mac.value !== undefined) {
    if (!MAC_ADDRESS.test(mac.value)) return { ok: false, error: 'MAC address contains invalid characters' };
    out.macAddress = mac.value;
  }
  const os = text(body, 'osProfile', 64, 'OS profile');
  if (!os.ok) return os;
  if (os.value !== undefined) {
    if (!OS_PROFILE.test(os.value)) return { ok: false, error: 'OS profile contains invalid characters' };
    out.osProfile = os.value;
  }

  const enumField = <T extends string>(key: string, allowed: readonly T[], label: string): Validation<T | undefined> => {
    const v = body[key];
    if (v === undefined) return { ok: true, value: undefined };
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return { ok: false, error: `${label} must be one of: ${allowed.join(', ')}` };
    return { ok: true, value: v as T };
  };
  const status = enumField('status', STATUSES, 'Status');
  if (!status.ok) return status;
  if (status.value) out.status = status.value;
  const origin = enumField('sourceOrigin', ORIGINS, 'Source origin');
  if (!origin.ok) return origin;
  if (origin.value) out.sourceOrigin = origin.value;
  const discovery = enumField('discoveryStatus', DISCOVERY, 'Discovery status');
  if (!discovery.ok) return discovery;
  if (discovery.value) out.discoveryStatus = discovery.value;

  if (body.complianceScore !== undefined) {
    const s = body.complianceScore;
    if (s === null) out.complianceScore = null;
    else if (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 100) out.complianceScore = s;
    else return { ok: false, error: 'Compliance score must be a whole number from 0 to 100, or null' };
  }
  if (body.lastScannedAt !== undefined) {
    const t = body.lastScannedAt;
    if (t === null) out.lastScannedAt = null;
    else if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) out.lastScannedAt = new Date(t).toISOString();
    else return { ok: false, error: 'Last scanned time must be an ISO date or null' };
  }
  if (body.accretionMetadata !== undefined) {
    const m = body.accretionMetadata;
    if (m === null) out.accretionMetadata = null;
    else if (isRecord(m) && JSON.stringify(m).length <= 8000) out.accretionMetadata = m as unknown as AccretionMetadata;
    else return { ok: false, error: 'Discovery metadata must be an object of at most 8 KB' };
  }

  const fips = readFips(body);
  if (!fips.ok) return fips;
  Object.assign(out, fips.value);
  if (!partial) {
    // A new asset has no earlier state: the whole record is checked now
    const checked = normalizeFips(out.cmmcAssetCategory as CmmcAssetCategory, { ...NO_FIPS, ...fips.value });
    if (!checked.ok) return { ok: false, error: checked.error };
    Object.assign(out, checked.fields);
  }

  return { ok: true, value: out };
}

/** Reads the raw FIPS fields of a request body. Combination rules (status vs. certificate, category) are in normalizeFips. */
function readFips(body: Record<string, unknown>): Validation<Partial<FipsFields>> {
  const out: Partial<FipsFields> = {};
  if (body.fipsValidationStatus !== undefined) {
    const v = body.fipsValidationStatus;
    if (v !== null && !isFipsStatus(v)) return { ok: false, error: `FIPS validation status must be one of: ${FIPS_STATUSES.join(', ')}` };
    out.fipsValidationStatus = v;
  }
  if (body.fipsStandard !== undefined) {
    const v = body.fipsStandard;
    if (v !== null && !isFipsStandard(v)) return { ok: false, error: `FIPS standard must be one of: ${FIPS_STANDARDS.join(', ')}` };
    out.fipsStandard = v;
  }
  if (body.fipsCertificateNumber !== undefined) {
    const v = body.fipsCertificateNumber;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') return { ok: false, error: 'The CMVP certificate number must be digits' };
    out.fipsCertificateNumber = v === null ? null : String(v);
  }
  if (body.fipsModuleName !== undefined) {
    const v = body.fipsModuleName;
    if (v !== null && typeof v !== 'string') return { ok: false, error: 'The cryptographic module name must be text' };
    out.fipsModuleName = v;
  }
  return { ok: true, value: out };
}

const withDefaults = (f: Partial<AssetFields>): AssetFields => ({
  hostName: f.hostName as string,
  notes: f.notes ?? '',
  cmmcAssetCategory: f.cmmcAssetCategory as CmmcAssetCategory,
  owner: f.owner ?? '',
  ipAddress: f.ipAddress ?? '',
  macAddress: f.macAddress ?? '',
  osProfile: f.osProfile ?? 'custom',
  status: f.status ?? 'NEVER_SCANNED',
  sourceOrigin: f.sourceOrigin ?? 'MANUAL_ENTRY',
  discoveryStatus: f.discoveryStatus ?? 'ACTIVE',
  accretionMetadata: f.accretionMetadata ?? null,
  lastScannedAt: f.lastScannedAt ?? null,
  complianceScore: f.complianceScore ?? null,
  fipsValidationStatus: f.fipsValidationStatus ?? null,
  fipsCertificateNumber: f.fipsCertificateNumber ?? null,
  fipsModuleName: f.fipsModuleName ?? null,
  fipsStandard: f.fipsStandard ?? null,
});

// ------------------------------------------------------------------------------------------------ record shape

export type AssetRecord = EnclaveAsset & { owner: string; createdAt: string; updatedAt: string } & FipsFields;

interface MemoryAsset extends AssetFields {
  id: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}
const memoryAssets = new Map<string, MemoryAsset>(); // key: id

const toRecord = (m: MemoryAsset): AssetRecord => ({
  id: m.id,
  tenantId: m.tenantId,
  hostName: m.hostName,
  ipAddress: m.ipAddress,
  macAddress: m.macAddress,
  osProfile: m.osProfile,
  cmmcAssetCategory: m.cmmcAssetCategory,
  status: m.status,
  sourceOrigin: m.sourceOrigin,
  discoveryStatus: m.discoveryStatus,
  ...(m.accretionMetadata ? { accretionMetadata: m.accretionMetadata } : {}),
  lastScannedAt: m.lastScannedAt,
  complianceScore: m.complianceScore,
  notes: m.notes,
  owner: m.owner,
  fipsValidationStatus: m.fipsValidationStatus,
  fipsCertificateNumber: m.fipsCertificateNumber,
  fipsModuleName: m.fipsModuleName,
  fipsStandard: m.fipsStandard,
  isManuallyAdded: m.sourceOrigin === 'MANUAL_ENTRY' || m.sourceOrigin === 'CSV_IMPORT',
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

function rowToRecord(row: pg.QueryResultRow): AssetRecord {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return toRecord({
    id: row.id,
    tenantId: row.tenant_id,
    hostName: row.asset_name,
    notes: row.description ?? '',
    cmmcAssetCategory: row.cmmc_category,
    owner: row.owner ?? '',
    fipsValidationStatus: row.fips_validation_status ?? null,
    fipsCertificateNumber: row.fips_certificate_number ?? null,
    fipsModuleName: row.fips_module_name ?? null,
    fipsStandard: row.fips_standard ?? null,
    ipAddress: row.ip_address ?? '',
    macAddress: row.mac_address ?? '',
    osProfile: row.os_profile ?? 'custom',
    status: row.status,
    sourceOrigin: row.source_origin,
    discoveryStatus: row.discovery_status,
    accretionMetadata: row.accretion_metadata ?? null,
    lastScannedAt: iso(row.last_scanned_at),
    complianceScore: row.compliance_score ?? null,
    createdBy: row.created_by ?? '',
    createdAt: iso(row.created_at) as string,
    updatedBy: row.updated_by ?? '',
    updatedAt: iso(row.updated_at) as string,
  });
}

/** Test hook. */
export function __resetMemoryAssetsForTests(): void {
  memoryAssets.clear();
}

// ------------------------------------------------------------------------------------------------ helpers

const isMemory = (): boolean => getDbMode() === 'memory';
const nameKey = (name: string): string => name.trim().toLowerCase();

async function inTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === '23505';
const duplicate = (name: string): AssetError => new AssetError('duplicate', `An asset named "${name}" already exists in this enclave`);

const INSERT_SQL = `INSERT INTO enclave_assets
  (tenant_id, asset_name, description, cmmc_category, owner, ip_address, mac_address, os_profile, status, source_origin,
   discovery_status, accretion_metadata, last_scanned_at, compliance_score, created_by, updated_by,
   fips_validation_status, fips_certificate_number, fips_module_name, fips_standard)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19) RETURNING *`;

const insertParams = (tenantId: string, f: AssetFields, actor: string): unknown[] => [
  tenantId, f.hostName, f.notes, f.cmmcAssetCategory, f.owner, f.ipAddress, f.macAddress, f.osProfile, f.status,
  f.sourceOrigin, f.discoveryStatus, f.accretionMetadata ? JSON.stringify(f.accretionMetadata) : null,
  f.lastScannedAt, f.complianceScore, actor, f.fipsValidationStatus, f.fipsCertificateNumber, f.fipsModuleName, f.fipsStandard,
];

// ------------------------------------------------------------------------------------------------ operations

export async function listAssets(tenantId: string): Promise<AssetRecord[]> {
  if (isMemory()) {
    return [...memoryAssets.values()]
      .filter((m) => m.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.hostName.localeCompare(b.hostName))
      .map(toRecord);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM enclave_assets WHERE tenant_id = $1 ORDER BY created_at DESC, asset_name LIMIT $2', [tenantId, MAX_ASSETS_PER_TENANT]);
    return res.rows.map(rowToRecord);
  });
}

export async function getAsset(tenantId: string, id: string): Promise<AssetRecord | null> {
  if (isMemory()) {
    const m = memoryAssets.get(id);
    return m && m.tenantId === tenantId ? toRecord(m) : null;
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM enclave_assets WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  });
}

export async function createAsset(tenantId: string, input: Partial<AssetFields>, actor: string): Promise<AssetRecord> {
  const fields = withDefaults(input);
  if (isMemory()) {
    const mine = [...memoryAssets.values()].filter((m) => m.tenantId === tenantId);
    if (mine.length >= MAX_ASSETS_PER_TENANT) throw new AssetError('limit', 'This enclave has reached the maximum number of assets');
    if (mine.some((m) => nameKey(m.hostName) === nameKey(fields.hostName))) throw duplicate(fields.hostName);
    const now = new Date().toISOString();
    const record: MemoryAsset = { ...fields, id: crypto.randomUUID(), tenantId, createdBy: actor, createdAt: now, updatedBy: actor, updatedAt: now };
    memoryAssets.set(record.id, record);
    return toRecord(record);
  }
  return inTenantTx(tenantId, async (client) => {
    const count = await client.query('SELECT count(*)::int AS n FROM enclave_assets WHERE tenant_id = $1', [tenantId]);
    if (count.rows[0].n >= MAX_ASSETS_PER_TENANT) throw new AssetError('limit', 'This enclave has reached the maximum number of assets');
    try {
      const res = await client.query(INSERT_SQL, insertParams(tenantId, fields, actor));
      return rowToRecord(res.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate(fields.hostName);
      throw err;
    }
  });
}

export async function updateAsset(tenantId: string, id: string, patch: Partial<AssetFields>, actor: string): Promise<AssetRecord> {
  if (isMemory()) {
    const m = memoryAssets.get(id);
    if (!m || m.tenantId !== tenantId) throw new AssetError('not_found', 'Asset not found');
    if (patch.hostName && nameKey(patch.hostName) !== nameKey(m.hostName)) {
      const clash = [...memoryAssets.values()].some((o) => o.tenantId === tenantId && o.id !== id && nameKey(o.hostName) === nameKey(patch.hostName as string));
      if (clash) throw duplicate(patch.hostName);
    }
    const fips = resolveFips(m, patch);
    if (!fips.ok) throw new AssetError('invalid', fips.error);
    Object.assign(m, patch, fips.value ?? {}, { updatedBy: actor, updatedAt: new Date().toISOString() });
    return toRecord(m);
  }

  const columns: Record<Exclude<keyof AssetFields, never>, string> = {
    hostName: 'asset_name', notes: 'description', cmmcAssetCategory: 'cmmc_category', owner: 'owner', ipAddress: 'ip_address',
    macAddress: 'mac_address', osProfile: 'os_profile', status: 'status', sourceOrigin: 'source_origin',
    discoveryStatus: 'discovery_status', accretionMetadata: 'accretion_metadata', lastScannedAt: 'last_scanned_at',
    complianceScore: 'compliance_score', fipsValidationStatus: 'fips_validation_status', fipsCertificateNumber: 'fips_certificate_number',
    fipsModuleName: 'fips_module_name', fipsStandard: 'fips_standard',
  };
  return inTenantTx(tenantId, async (client) => {
    // Lock the stored row so the FIPS rules are checked against what will actually be there
    const current = await client.query('SELECT * FROM enclave_assets WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
    if (!current.rows[0]) throw new AssetError('not_found', 'Asset not found');
    const fips = resolveFips(rowToRecord(current.rows[0]), patch);
    if (!fips.ok) throw new AssetError('invalid', fips.error);
    const effective: Partial<AssetFields> = { ...patch, ...(fips.value ?? {}) };

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(columns) as Array<keyof AssetFields>) {
      if (effective[key] === undefined) continue;
      params.push(key === 'accretionMetadata' && effective[key] ? JSON.stringify(effective[key]) : effective[key]);
      sets.push(`${columns[key]} = $${params.length}`);
    }
    params.push(actor);
    sets.push(`updated_by = $${params.length}`, 'updated_at = NOW()');
    params.push(id, tenantId);
    try {
      const res = await client.query(`UPDATE enclave_assets SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`, params);
      return rowToRecord(res.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate(patch.hostName ?? 'that name');
      throw err;
    }
  });
}

export async function deleteAsset(tenantId: string, id: string): Promise<boolean> {
  if (isMemory()) {
    const m = memoryAssets.get(id);
    if (!m || m.tenantId !== tenantId) return false;
    memoryAssets.delete(id);
    return true;
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('DELETE FROM enclave_assets WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  });
}

export interface BulkResult {
  created: AssetRecord[];
  skipped: Array<{ index: number; hostName: string; reason: string }>;
}

/** Creates many assets; one that clashes with an existing name is skipped (and reported), not fatal. */
export async function createAssetsBulk(tenantId: string, inputs: Array<Partial<AssetFields>>, actor: string): Promise<BulkResult> {
  const result: BulkResult = { created: [], skipped: [] };
  for (let index = 0; index < inputs.length; index++) {
    try {
      result.created.push(await createAsset(tenantId, inputs[index], actor));
    } catch (err) {
      if (err instanceof AssetError && err.code !== 'not_found') {
        result.skipped.push({ index, hostName: inputs[index].hostName ?? '', reason: err.message });
        if (err.code === 'limit') break;
      } else {
        throw err;
      }
    }
  }
  return result;
}

export interface DiscoveryResult {
  totalProcessed: number;
  newDiscoveredCount: number;
  updatedExistingCount: number;
  created: AssetRecord[];
}

export function validateDiscoveryItems(body: unknown): Validation<AccretionDiscoveryItem[]> {
  const items = isRecord(body) ? body.items : undefined;
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'items must be a non-empty list' };
  if (items.length > MAX_DISCOVERY_ITEMS) return { ok: false, error: `At most ${MAX_DISCOVERY_ITEMS} discovered devices per request` };
  const out: AccretionDiscoveryItem[] = [];
  for (const [i, raw] of items.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `items[${i}] must be an object` };
    const mac = typeof raw.macAddress === 'string' ? raw.macAddress.trim() : '';
    const ip = typeof raw.ipAddress === 'string' ? raw.ipAddress.trim() : '';
    if (!MAC_ADDRESS.test(mac) || !NETWORK_ADDRESS.test(ip) || (!mac && !ip)) return { ok: false, error: `items[${i}] needs a valid MAC or IP address` };
    const connection = ['ETHERNET', 'WIRELESS', 'VIRTUAL', 'VPN'].includes(raw.connectionType as string) ? (raw.connectionType as AccretionDiscoveryItem['connectionType']) : 'ETHERNET';
    const ports = Array.isArray(raw.discoveredPorts) ? raw.discoveredPorts.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 200) : [];
    const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && !CONTROL_CHARS.test(v) ? v.trim().slice(0, max) : undefined);
    const agentId = str(raw.agentId, 128);
    if (!agentId) return { ok: false, error: `items[${i}] needs an agentId` };
    const os = str(raw.osProfile, 64);
    out.push({
      macAddress: mac,
      ipAddress: ip,
      hostName: str(raw.hostName, 255),
      osFingerprint: str(raw.osFingerprint, 255) ?? '',
      osProfile: os && OS_PROFILE.test(os) ? os : undefined,
      discoveredPorts: ports,
      connectionType: connection,
      agentId,
      detectedAt: typeof raw.detectedAt === 'string' && !Number.isNaN(Date.parse(raw.detectedAt)) ? new Date(raw.detectedAt).toISOString() : undefined,
      notes: str(raw.notes, 1000),
    });
  }
  return { ok: true, value: out };
}

/**
 * Network-discovery ingestion. A device matching an existing asset by MAC (L2) or IP (L3) only has its discovery
 * metadata refreshed (its category is never touched). A new device is created UNCONFIRMED_DISCOVERY and defaults to
 * Contractor Risk Managed until an administrator classifies it, and is not counted in the SSP boundary until then.
 */
export async function ingestDiscovery(tenantId: string, items: AccretionDiscoveryItem[], actor: string): Promise<DiscoveryResult> {
  const existing = await listAssets(tenantId);
  const seenNames = new Set(existing.map((a) => nameKey(a.hostName)));
  const result: DiscoveryResult = { totalProcessed: items.length, newDiscoveredCount: 0, updatedExistingCount: 0, created: [] };
  const now = new Date().toISOString();

  for (const item of items) {
    const mac = item.macAddress.toLowerCase();
    const match = existing.find(
      (a) => (mac && a.macAddress.toLowerCase() === mac) || (item.ipAddress && a.ipAddress === item.ipAddress)
    );
    const metadata: AccretionMetadata = {
      agentId: item.agentId,
      discoveredPorts: item.discoveredPorts,
      osFingerprint: item.osFingerprint,
      lastSeenAt: item.detectedAt ?? now,
      connectionType: item.connectionType,
    };
    if (match) {
      const updated = await updateAsset(tenantId, match.id, { accretionMetadata: metadata }, actor);
      existing[existing.indexOf(match)] = updated;
      result.updatedExistingCount += 1;
      continue;
    }

    let name = item.hostName || `accretion-${(item.macAddress || item.ipAddress).replace(/[^A-Za-z0-9]/g, '').slice(-6).toLowerCase()}`;
    for (let n = 2; seenNames.has(nameKey(name)); n++) name = `${item.hostName || 'accretion-device'}-${n}`;
    seenNames.add(nameKey(name));
    const created = await createAsset(
      tenantId,
      {
        hostName: name,
        notes: item.notes ?? `Discovered via Accretion sensor ${item.agentId}. Ports: [${item.discoveredPorts.join(', ')}]`,
        cmmcAssetCategory: 'CONTRACTOR_RISK',
        ipAddress: item.ipAddress,
        macAddress: item.macAddress,
        osProfile: item.osProfile ?? 'custom',
        sourceOrigin: 'ACCRETION_DISCOVERY',
        discoveryStatus: 'UNCONFIRMED_DISCOVERY',
        accretionMetadata: metadata,
      },
      actor
    );
    existing.push(created);
    result.created.push(created);
    result.newDiscoveredCount += 1;
  }
  return result;
}
