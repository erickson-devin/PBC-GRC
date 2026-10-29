/**
 * Enclave offboarding handover, per program (issue #27): one package per program of the tenant, or all of them in one bundle file.
 * The server's answers (controls, notes, evidence) are fetched one program at a time and handed to the engine, which reads no
 * browser cache for a program. Ids, counts and the package content only: nothing is logged.
 */

import type { Tenant } from '../../types/tenant';
import type { Program } from '../../types/program';
import type { ControlState, EvidenceItem } from '../../types/cmmc';
import type { EnclaveAsset } from '../../types/telemetry';
import { computeSha256, canonicalJson } from '../audit/auditLogger';
import { generateEnclaveHandoverPackage, type EnclaveHandoverPackage } from './offboardingEngine';

export type HandoverSelection = { kind: 'all' } | { kind: 'program'; programId: string };

/** What the builder reads from the server; the dashboard binds these to ApiClient. */
export interface HandoverDeps {
  listPrograms: (tenantId: string, options: { includeArchived: boolean }) => Promise<Program[]>;
  getControls: (tenantId: string, programId: string) => Promise<ControlState[]>;
  getEvidence: (tenantId: string, programId: string) => Promise<EvidenceItem[]>;
}

export interface EnclaveHandoverBundle {
  bundleSchemaVersion: '1.0.0';
  bundleType: 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER_BUNDLE';
  bundleId: string;
  exportTimestamp: string;
  tenantId: string;
  programCount: number;
  packages: EnclaveHandoverPackage[];
  integrityChecksum: string;
}

export interface HandoverResult {
  packages: EnclaveHandoverPackage[];
  /** Set when every program was chosen: the one file that holds the packages. */
  bundle: EnclaveHandoverBundle | null;
}

/**
 * Builds the handover for one program, or for every program (archived ones included, flagged in their package) of a
 * tenant. One program downloads its package; "all" downloads one bundle file (browsers block several downloads in a row).
 * Each package states the tenant-wide asset inventory. An unknown program id rejects with "Program not found".
 */
export async function buildProgramHandover(
  tenant: Tenant,
  selection: HandoverSelection,
  assets: ReadonlyArray<EnclaveAsset> | undefined,
  deps: HandoverDeps
): Promise<HandoverResult> {
  const all = await deps.listPrograms(tenant.id, { includeArchived: true });
  // The default program first, then the order the server gave
  const ordered = [...all.filter((p) => p.isDefault), ...all.filter((p) => !p.isDefault)];
  const chosen = selection.kind === 'all' ? ordered : ordered.filter((p) => p.id === selection.programId);
  if (chosen.length === 0) throw new Error(selection.kind === 'all' ? 'The tenant has no programs to hand over' : 'Program not found');

  const single = selection.kind === 'program';
  const packages: EnclaveHandoverPackage[] = [];
  for (const program of chosen) {
    const list = await deps.getControls(tenant.id, program.id);
    const evidence = await deps.getEvidence(tenant.id, program.id);
    const states = Object.fromEntries(list.map((c) => [c.id, c]));
    packages.push(await generateEnclaveHandoverPackage(tenant.id, tenant, assets, states, evidence, { program, download: single }));
  }
  if (single) return { packages, bundle: null };

  const now = new Date().toISOString();
  const raw = {
    bundleSchemaVersion: '1.0.0' as const,
    bundleType: 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER_BUNDLE' as const,
    bundleId: `BUNDLE-OFFBOARD-${tenant.id.toUpperCase()}-${Date.now()}`,
    exportTimestamp: now,
    tenantId: tenant.id,
    programCount: packages.length,
    packages,
  };
  const bundle: EnclaveHandoverBundle = { ...raw, integrityChecksum: await computeSha256(canonicalJson(raw)) };
  downloadHandoverBundle(bundle);
  return { packages, bundle };
}

/** Downloads the bundle as one JSON file. */
export function downloadHandoverBundle(bundle: EnclaveHandoverBundle): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (bundle.packages[0]?.tenant.name || bundle.tenantId).toLowerCase().replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `${safeName}_compliance_offboarding_bundle_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
