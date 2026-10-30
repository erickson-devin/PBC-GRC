/**
 * Sends browser-local assets to the server (used when a browser-only tenant is moved, and to retry the ones that failed).
 * Pure module: the ApiClient calls are injected. Never logs.
 */

import type { EnclaveAsset } from '../types/telemetry';
import { isMachineAssetOrigin, type AssetInput } from '../data/telemetry/assetScope';

export const toAssetInput = (a: EnclaveAsset): AssetInput => ({
  hostName: a.hostName, ipAddress: a.ipAddress, macAddress: a.macAddress, osProfile: a.osProfile,
  cmmcAssetCategory: a.cmmcAssetCategory, status: a.status,
  // browser-held data is not machine-attested; the server refuses machine origins from people
  sourceOrigin: isMachineAssetOrigin(a.sourceOrigin) ? 'MANUAL_ENTRY' : a.sourceOrigin,
  discoveryStatus: a.discoveryStatus, accretionMetadata: a.accretionMetadata, lastScannedAt: a.lastScannedAt,
  complianceScore: a.complianceScore, notes: a.notes, owner: a.owner ?? '',
  fipsValidationStatus: a.fipsValidationStatus, fipsCertificateNumber: a.fipsCertificateNumber,
  fipsModuleName: a.fipsModuleName, fipsStandard: a.fipsStandard,
});

export interface AssetPushDeps {
  bulk(tenantId: string, inputs: AssetInput[]): Promise<{ created: unknown[]; skipped: unknown[] }>;
  single(tenantId: string, input: AssetInput): Promise<unknown>;
}

export async function pushAssetsToServer(
  deps: AssetPushDeps,
  tenantId: string,
  assets: ReadonlyArray<EnclaveAsset>
): Promise<{ moved: number; failed: number }> {
  let moved = 0;
  let failed = 0;
  for (let i = 0; i < assets.length; i += 500) {
    const chunk = assets.slice(i, i + 500);
    try {
      const res = await deps.bulk(tenantId, chunk.map(toAssetInput));
      moved += res.created.length;
      failed += res.skipped.length;
    } catch {
      // one malformed row rejects the whole request: retry one by one so the good ones still move
      for (const a of chunk) {
        try {
          await deps.single(tenantId, toAssetInput(a));
          moved++;
        } catch {
          failed++;
        }
      }
    }
  }
  return { moved, failed };
}
