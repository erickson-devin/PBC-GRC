/**
 * Event Horizon: Singularity - Enclave Offboarding & NIST SP 800-88 Cryptographic Destruction Engine
 * 
 * Provides automated offboarding data compilation:
 * 1. Contract Handover Package: Aggregates SSP, POA&M, evidence index, and SHA-256 audit ledger into an immutable export.
 * 2. Cryptographic Wipe & Destruction: Executes NIST SP 800-88 Rev 1 Clear & Purge overwriting protocols,
 *    purges database/cache records, and generates an official signed Certificate of Destruction.
 */

import { Tenant } from '../../types/tenant';
import { AssessmentState, ControlState, EvidenceItem } from '../../types/cmmc';
import { CompiledDocument, POAMEntry } from '../../types/report';
import { CertificateOfDestruction, AuditLogEntry } from '../../types/audit';
import { StorageService } from '../../services/storageService';
import { FLEET_KEY_PREFIX } from '../../services/browserStorageScrub';
import { loadLedger, computeSha256, canonicalJson } from '../audit/auditLogger';
import { compileNistSSP, generatePOAMEntries } from '../reports/documentCompilers';
import { summarizeScope } from '../telemetry/assetScope';
import { collectFipsModules } from '../telemetry/fipsValidation';
import type { EnclaveAsset } from '../../types/telemetry';
import { getFrameworkControls } from '../frameworks';
import { programFrameworkControls, scopingToOverlays } from '../programScope';
import type { Program } from '../../types/program';
import type { OverlayFilters } from '../../types/framework';
import { browserTenantOverlays } from '../browserOverlays';
import { purgeTenantData, downloadCertificateOfDestruction } from './retentionPolicy';
import { EvidenceVault } from '../../services/evidenceVault';

export interface EnclaveHandoverPackage {
  schemaVersion: '2.0.0';
  packageId: string;
  packageType: 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER';
  exportTimestamp: string;
  retentionStandard: string;
  tenant: {
    id: string;
    name: string;
    cageCode: string;
    samStatus: string;
    systemName: string;
    systemOwner: string;
    industry: string;
    domain?: string;
    primaryFramework: string;
    enabledFrameworks: string[];
    createdAt: string;
    offboardedAt: string;
  };
  complianceSummary: {
    totalControls: number;
    metCount: number;
    inProgressCount: number;
    notMetCount: number;
    completionPercentage: number;
    evidenceItemsCount: number;
    poamEntriesCount: number;
    auditLogCount: number;
  };
  reports: {
    systemSecurityPlan: CompiledDocument;
    poamMatrix: POAMEntry[];
  };
  evidenceIndex: EvidenceItem[];
  auditLedger: AuditLogEntry[];
  /** Present when the package holds ONE program of the tenant (its controls, notes and evidence); absent for the tenant's default-program package. */
  program?: {
    id: string;
    name: string;
    framework: string;
    baseline: string | null;
    privacyBaseline: boolean;
    scoping: Program['scoping'];
    isDefault: boolean;
    archived: boolean;
  };
  integrityChecksum: string;
}

/** The part of a program a handover package needs. */
export type HandoverProgramRef = Pick<Program, 'id' | 'name' | 'framework' | 'baseline' | 'privacyBaseline' | 'scoping' | 'boundarySummary' | 'isDefault' | 'archived'>;

export interface HandoverOptions {
  /** Build the package for this program: its framework, baseline and overlays, its boundary text; no browser cache is read or written. */
  program?: HandoverProgramRef;
  /** Download the package file (default true). A caller that bundles several packages passes false. */
  download?: boolean;
  /** A browser-only tenant's overlays, as its matrix uses them; ignored when `program` is set. */
  overlays?: OverlayFilters;
}

/** Thrown (and shown to the operator as is) when the evidence files cannot be cleared; it holds no tenant data. */
export const EVIDENCE_CLEAR_FAILED_MESSAGE = 'Could not clear the enclave\'s evidence files from this browser; no Certificate of Destruction was issued.';

/**
 * Resolves a Tenant entity by ID from storage if not provided directly
 */
function resolveTenant(tenantId: string, tenantData?: Tenant): Tenant {
  if (tenantData) return tenantData;

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const liveStr = window.localStorage.getItem('pbc_live_tenants_v4');
      if (liveStr) {
        const liveList: Tenant[] = JSON.parse(liveStr);
        const match = liveList.find(t => t.id === tenantId);
        if (match) return match;
      }
      const demoStr = window.localStorage.getItem('pbc_demo_tenants_v4');
      if (demoStr) {
        const demoList: Tenant[] = JSON.parse(demoStr);
        const match = demoList.find(t => t.id === tenantId);
        if (match) return match;
      }
    } catch {}
  }

  return {
    id: tenantId,
    name: 'Defense Industrial Base Contractor',
    cageCode: 'N/A',
    samStatus: 'ACTIVE',
    systemName: 'Corporate Operations Enclave',
    systemOwner: 'Contract Security Officer',
    industry: 'Defense Industrial Base (DIB)',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    primaryFramework: 'CMMC_L1',
    enabledFrameworks: ['CMMC_L1'],
  };
}

/**
 * Compiles a comprehensive enclave offboarding handover package:
 * Aggregates live SSP, POA&M matrix, evidence items, and cryptographic audit ledger into a single archive.
 * Also triggers browser download of the structured JSON package.
 */
export async function generateEnclaveHandoverPackage(
  tenantId: string,
  tenantData?: Tenant,
  /** The enclave's asset inventory, when the caller has it (the server holds it for live tenants): states the CMMC scope in the SSP. */
  assets?: ReadonlyArray<EnclaveAsset>,
  /** The server's control states (the source of truth for live tenants, including implementation notes the browser cache may lack). Overrides the cached controls per id. */
  controlStates?: Record<string, ControlState>,
  /** The server's evidence list (the browser cache of a live tenant no longer holds it). Used instead of the cached list. */
  evidenceIndex?: ReadonlyArray<EvidenceItem>,
  /** One program of the tenant (its own controls and boundary text, no browser cache) and whether to download. Without it: the tenant's primary framework, as before. */
  options: HandoverOptions = {}
): Promise<EnclaveHandoverPackage> {
  const tenant = resolveTenant(tenantId, tenantData);
  const program = options.program;
  // A program's package is built from the server's answers only: the browser cache is neither read nor (as loadAssessment would) written
  const state: AssessmentState | null = program ? null : StorageService.loadAssessment(tenant);
  const evidenceForPackage: ReadonlyArray<EvidenceItem> = evidenceIndex ?? state?.evidenceIndex ?? [];
  const ledger: AuditLogEntry[] = loadLedger(tenantId);

  const primaryFw = tenant.primaryFramework || 'CMMC_L1';
  const controls = program ? programFrameworkControls(program, scopingToOverlays(program.scoping)) : getFrameworkControls(primaryFw, 'ALL_CONTROLS', browserTenantOverlays(primaryFw, options.overlays));
  const controlsForReport = { ...state?.controls, ...controlStates };

  // Compile official NIST SP 800-18 / NIST SP 800-171 System Security Plan
  const sspDocument = compileNistSSP(
    {
      systemName: tenant.systemName,
      organizationName: tenant.name,
      cageCode: tenant.cageCode,
      samStatus: tenant.samStatus,
      systemOwner: tenant.systemOwner,
      primaryAssessor: 'Pitch Black Cyber GRC Engine',
      boundaryDescription: program?.boundarySummary ||tenant.systemBoundaryScope || `${tenant.name} operations and compliance boundary.`,
      systemEnvironment: 'Hybrid Defense Cloud & Managed Boundary',
      operationalStatus: 'Operational',
      cloudServiceProviders: 'Google Cloud Platform (Cloud SQL / GCS), Identity Provider',
      classificationLevel: 'UNCLASSIFIED // CUI',
      assessmentDate: new Date().toISOString().split('T')[0],
      version: '1.0.0-OFFBOARDING',
      framework: program ? program.framework : primaryFw,
      assetScope: assets ? summarizeScope(assets) : undefined,
      cryptoModules: assets ? collectFipsModules(assets) : undefined,
    },
    controls,
    controlsForReport,
    [...evidenceForPackage]
  );

  // Generate structured POA&M entries
  const poamMatrix = generatePOAMEntries(controls, controlsForReport);

  const now = new Date().toISOString();
  const rawPayload = {
    schemaVersion: '2.0.0' as const,
    packageId: `PKG-OFFBOARD-${tenant.id.toUpperCase()}-${program ? `${program.id.slice(0, 8).toUpperCase()}-` : ''}${Date.now()}`,
    packageType: 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER' as const,
    exportTimestamp: now,
    retentionStandard: 'DFARS 252.204-7012 / FAR 4.703 (3-Year Audit Retention Archive)',
    tenant: {
      id: tenant.id,
      name: tenant.name,
      cageCode: tenant.cageCode,
      samStatus: tenant.samStatus,
      systemName: tenant.systemName,
      systemOwner: tenant.systemOwner,
      industry: tenant.industry,
      domain: tenant.domain,
      primaryFramework: primaryFw,
      enabledFrameworks: tenant.enabledFrameworks || [primaryFw],
      createdAt: tenant.createdAt,
      offboardedAt: now,
    },
    complianceSummary: {
      totalControls: sspDocument.summaryMetrics.totalControls,
      metCount: sspDocument.summaryMetrics.metCount,
      inProgressCount: sspDocument.summaryMetrics.inProgressCount,
      notMetCount: sspDocument.summaryMetrics.notMetCount,
      completionPercentage: sspDocument.summaryMetrics.completionPercentage,
      evidenceItemsCount: evidenceForPackage.length,
      poamEntriesCount: poamMatrix.length,
      auditLogCount: ledger.length,
    },
    reports: {
      systemSecurityPlan: sspDocument,
      poamMatrix,
    },
    evidenceIndex: [...evidenceForPackage],
    auditLedger: ledger,
    ...(program
      ? {
          program: {
            id: program.id,
            name: program.name,
            framework: program.framework,
            baseline: program.baseline,
            privacyBaseline: program.privacyBaseline,
            scoping: program.scoping,
            isDefault: program.isDefault,
            archived: program.archived,
          },
        }
      : {}),
  };

  const canonicalString = canonicalJson(rawPayload);
  const integrityChecksum = await computeSha256(canonicalString);

  const handoverPackage: EnclaveHandoverPackage = {
    ...rawPayload,
    integrityChecksum,
  };

  // Automatically trigger download of the package file
  if (options.download !== false) downloadHandoverPackage(handoverPackage);

  return handoverPackage;
}

/**
 * Downloads the offboarding handover package as a verified JSON file.
 */
export function downloadHandoverPackage(pkg: EnclaveHandoverPackage): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (pkg.tenant.name || pkg.tenant.id)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  const programSlug = pkg.program ? `_${pkg.program.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)}` : '';
  a.href = url;
  a.download = `${safeName}${programSlug}_compliance_offboarding_package_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Performs NIST SP 800-88 cryptographic sanitization & purge on tenant records:
 * 1. Executes 3-pass overwrite and key revocation via purgeTenantData().
 * 2. Overwrites and removes all local database/cache keys.
 * 3. Issues and downloads an official Certificate of Destruction JSON artifact.
 */
export async function executeCryptographicDestruction(params: {
  tenantId: string;
  systemName?: string;
  cageCode?: string;
  actorName: string;
  actorEmail: string;
  state?: AssessmentState;
  /** Clears the tenant's evidence files from the browser (IndexedDB). Defaults to EvidenceVault.clearTenantStrict (rejects on failure); injectable for tests. */
  clearEvidenceFiles?: (tenantId: string) => Promise<void>;
}): Promise<CertificateOfDestruction> {
  const tenant = resolveTenant(params.tenantId);
  const state = params.state || StorageService.loadAssessment(tenant);

  // 0. Fail closed: evidence files live in IndexedDB. If they cannot be cleared this throws, so no certificate
  //    is issued or downloaded for a deletion that did not happen.
  const clearEvidenceFiles = params.clearEvidenceFiles
    ?? (typeof indexedDB !== 'undefined'
      ? (id: string) => EvidenceVault.clearTenantStrict(id, (state.evidenceIndex || []).map((e) => e.id))
      : undefined);
  if (clearEvidenceFiles) {
    try {
      await clearEvidenceFiles(params.tenantId);
    } catch {
      throw new Error(EVIDENCE_CLEAR_FAILED_MESSAGE);
    }
  }

  // 1. Execute formal NIST SP 800-88 cryptographic wipe and ledger recording
  const cert = await purgeTenantData({
    tenantId: params.tenantId,
    systemName: params.systemName || tenant.systemName,
    cageCode: params.cageCode || tenant.cageCode,
    actorName: params.actorName,
    actorEmail: params.actorEmail,
    state,
  });

  // 2. Clear all local storage records for this tenant
  if (typeof window !== 'undefined' && window.localStorage) {
    const keysToPurge = [
      `pbc_cmmc_assessment_v3_${params.tenantId}`,
      `pbc_assessment_${params.tenantId}`,
      `pbc_audit_ledger_${params.tenantId}`,
      `${FLEET_KEY_PREFIX}${params.tenantId}`,
      // every other program's assessment cache (pbc_cmmc_assessment_v3_<tenant>::<program>) and the active-program choice
      ...StorageService.listProgramKeys(params.tenantId),
    ];

    keysToPurge.forEach(key => {
      try {
        // Multi-pass noise fill before removal
        window.localStorage.setItem(key, JSON.stringify({ wiped: '0'.repeat(512) }));
        window.localStorage.removeItem(key);
      } catch {}
    });
  }

  // 3. Automatically download signed Certificate of Destruction
  downloadCertificateOfDestruction(cert);

  return cert;
}
