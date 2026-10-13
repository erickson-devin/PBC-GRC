import { ApiClient, ApiError } from './apiClient';
import {
  addEnclaveAsset,
  buildSimulatedDiscoveryBatch,
  deleteEnclaveAsset,
  getEnclaveAssets,
  importAssetsFromCsv,
  ingestAccretionDiscoveryPayload,
  syncAssetScanResult,
  updateEnclaveAsset,
} from '../data/telemetry/assetRegistry';
import { AssetInput, parseAssetsCsv } from '../data/telemetry/assetScope';
import { NO_FIPS, normalizeFips, resolveFips } from '../data/telemetry/fipsValidation';
import { computeSha256 } from '../data/audit/cryptoUtils';
import { recordAuditEvent } from '../data/audit/auditLogger';
import type {
  AccretionDiscoveryItem,
  AccretionIngestResult,
  CmmcAssetCategory,
  EnclaveAsset,
} from '../types/telemetry';

/**
 * Where an enclave's asset inventory lives.
 *  - 'server'       a tenant that exists on the server: the API is the source of truth (RLS-isolated, role-checked).
 *  - 'local-legacy' a live tenant that has not been moved to the server yet: browser-local and empty until used.
 *                   "Move to server" carries its assets over.
 */
export type AssetBackendMode = 'server' | 'local-legacy';

export function assetBackendMode(tenant: { serverBacked?: boolean }): AssetBackendMode {
  return tenant.serverBacked ? 'server' : 'local-legacy';
}

export interface AssetBackend {
  mode: AssetBackendMode;
  list(): Promise<EnclaveAsset[]>;
  create(input: AssetInput): Promise<EnclaveAsset>;
  update(assetId: string, patch: AssetInput): Promise<EnclaveAsset>;
  remove(assetId: string): Promise<void>;
  /** Assigns the final CMMC category to a discovered asset and confirms it. */
  classify(assetId: string, category: CmmcAssetCategory): Promise<EnclaveAsset>;
  importCsv(csv: string): Promise<{ imported: number; skipped: string[] }>;
  ingest(items: AccretionDiscoveryItem[]): Promise<AccretionIngestResult>;
  simulateDiscovery(): Promise<AccretionIngestResult>;
  /** Stores the outcome of a scan against the matching asset (by host name or IP), if there is one. */
  recordScan(hostName: string, ipAddress: string, score: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------- change notification

type Listener = (tenantId: string) => void;
const listeners = new Set<Listener>();

/** Lets every component that shows assets (inventory, scan console, SSP export) refresh when any of them changes one. */
export function subscribeAssets(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const notifyAssetsChanged = (tenantId: string): void => listeners.forEach((l) => l(tenantId));

// ---------------------------------------------------------------------------------------------- helpers

const nameKey = (n: string): string => n.trim().toLowerCase();

async function auditDiscovery(tenantId: string, created: EnclaveAsset[]): Promise<void> {
  for (const asset of created) {
    recordAuditEvent({
      tenantId,
      actorId: `accretion_${asset.accretionMetadata?.agentId ?? 'sensor'}`,
      actorEmail: `accretion-sensor@${asset.accretionMetadata?.agentId ?? 'sensor'}.local`,
      actorRole: 'Network Discovery Sensor',
      actionType: 'TELEMETRY_INGESTED',
      targetEntity: `EnclaveAsset:${asset.id}`,
      newState: { hostName: asset.hostName, ipAddress: asset.ipAddress, macAddress: asset.macAddress, discoveryStatus: asset.discoveryStatus },
      metadata: { sensor: 'Event Horizon: Accretion' },
    });
  }
}

const withoutId = (input: AssetInput): AssetInput => {
  const { id: _id, tenantId: _tenant, ...rest } = input as AssetInput & { id?: string; tenantId?: string };
  return rest;
};

// ---------------------------------------------------------------------------------------------- server backend

function serverBackend(tenantId: string): AssetBackend {
  const changed = <T>(value: T): T => {
    notifyAssetsChanged(tenantId);
    return value;
  };
  const backend: AssetBackend = {
    mode: 'server',
    list: async () => (await ApiClient.listAssets(tenantId)).assets,
    create: async (input) => changed(await ApiClient.createAsset(tenantId, withoutId(input))),
    update: async (id, patch) => changed(await ApiClient.updateAsset(tenantId, id, withoutId(patch))),
    remove: async (id) => changed(await ApiClient.deleteAsset(tenantId, id)),
    classify: (id, category) => backend.update(id, { cmmcAssetCategory: category, discoveryStatus: 'ACTIVE' }),
    importCsv: async (csv) => {
      const parsed = parseAssetsCsv(csv);
      if (parsed.assets.length === 0) return { imported: 0, skipped: parsed.errors };
      const skipped = [...parsed.errors];
      let imported = 0;
      // The server takes at most 500 rows per request
      for (let i = 0; i < parsed.assets.length; i += 500) {
        const result = await ApiClient.createAssetsBulk(tenantId, parsed.assets.slice(i, i + 500));
        imported += result.created.length;
        for (const s of result.skipped) skipped.push(`${s.hostName}: ${s.reason}`);
      }
      return changed({ imported, skipped });
    },
    ingest: async (items) => {
      const result = await ApiClient.ingestDiscovery(tenantId, items);
      await auditDiscovery(tenantId, result.created);
      const digest = await computeSha256(
        JSON.stringify({ tenantId, timestamp: new Date().toISOString(), processedCount: result.totalProcessed, newCount: result.newDiscoveredCount, updatedCount: result.updatedExistingCount })
      );
      const all = (await ApiClient.listAssets(tenantId)).assets;
      return changed({
        totalProcessed: result.totalProcessed,
        newDiscoveredCount: result.newDiscoveredCount,
        updatedExistingCount: result.updatedExistingCount,
        auditHash: digest,
        items: all,
      });
    },
    simulateDiscovery: () => backend.ingest(buildSimulatedDiscoveryBatch()),
    recordScan: async (hostName, ipAddress, score) => {
      const assets = (await ApiClient.listAssets(tenantId)).assets;
      const match = assets.find((a) => nameKey(a.hostName) === nameKey(hostName) || (ipAddress && a.ipAddress === ipAddress));
      if (!match) return;
      await ApiClient.updateAsset(tenantId, match.id, {
        lastScannedAt: new Date().toISOString(),
        complianceScore: score,
        status: score === 100 ? 'ACTIVE' : 'NON_COMPLIANT',
      });
      notifyAssetsChanged(tenantId);
    },
  };
  return backend;
}

// ---------------------------------------------------------------------------------------------- local backend

function localBackend(tenantId: string): AssetBackend {
  const changed = <T>(value: T): T => {
    notifyAssetsChanged(tenantId);
    return value;
  };
  const clash = (name: string | undefined, exceptId?: string): boolean =>
    !!name && getEnclaveAssets(tenantId).some((a) => a.id !== exceptId && nameKey(a.hostName) === nameKey(name));
  const duplicate = (name: string) => new ApiError(409, `An asset named "${name}" already exists in this enclave.`);

  const backend: AssetBackend = {
    mode: 'local-legacy',
    list: async () => getEnclaveAssets(tenantId),
    create: async (input) => {
      if (clash(input.hostName)) throw duplicate(input.hostName as string);
      // The same FIPS rules the server applies
      const fips = normalizeFips(input.cmmcAssetCategory as CmmcAssetCategory, { ...NO_FIPS, ...input });
      if (!fips.ok) throw new ApiError(400, fips.error);
      return changed(addEnclaveAsset(tenantId, { ...withoutId(input), ...fips.fields } as Omit<EnclaveAsset, 'id'>));
    },
    update: async (id, patch) => {
      if (clash(patch.hostName, id)) throw duplicate(patch.hostName as string);
      const current = getEnclaveAssets(tenantId).find((a) => a.id === id);
      if (!current) throw new ApiError(404, 'That asset no longer exists.');
      const fips = resolveFips(current, patch);
      if (!fips.ok) throw new ApiError(400, fips.error);
      return changed(updateEnclaveAsset(id, { ...withoutId(patch), ...(fips.value ?? {}) } as Partial<EnclaveAsset>, tenantId));
    },
    remove: async (id) => {
      deleteEnclaveAsset(id, tenantId);
      changed(undefined);
    },
    classify: (id, category) => backend.update(id, { cmmcAssetCategory: category, discoveryStatus: 'ACTIVE' }),
    importCsv: async (csv) => {
      const { imported, errors } = importAssetsFromCsv(tenantId, csv);
      return changed({ imported: imported.length, skipped: errors });
    },
    ingest: async (items) => changed(await ingestAccretionDiscoveryPayload(tenantId, items)),
    simulateDiscovery: async () => {
      const cleaned = getEnclaveAssets(tenantId).filter((a) => a.sourceOrigin !== 'ACCRETION_DISCOVERY');
      for (const gone of getEnclaveAssets(tenantId)) if (!cleaned.includes(gone)) deleteEnclaveAsset(gone.id, tenantId);
      return backend.ingest(buildSimulatedDiscoveryBatch());
    },
    recordScan: async (hostName, ipAddress, score) => {
      syncAssetScanResult(tenantId, hostName, ipAddress, score);
      notifyAssetsChanged(tenantId);
    },
  };
  return backend;
}

export function getAssetBackend(tenantId: string, mode: AssetBackendMode): AssetBackend {
  return mode === 'server' ? serverBackend(tenantId) : localBackend(tenantId);
}
