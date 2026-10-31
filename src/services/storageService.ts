import { AssessmentState, ControlState, SSPMetadata } from '../types/cmmc';
import { Tenant } from '../types/tenant';
import { SSP_METADATA_FIELDS } from '../types/sspMetadata';
import { FrameworkControlDefinition, ComplianceFramework } from '../types/framework';
import { getFrameworkControls } from '../data/frameworks';
import {
  ASSESSMENT_KEY_PREFIX,
  stripEvidenceIndexForCache,
  stripFailingAssetsForCache,
  stripImplementationNotesForCache,
  stripObjectiveNarrativesForCache,
  stripSspMetadataForCache,
} from './browserStorageScrub';
import { activeProgramStorageKey } from '../data/programSync';

const STORAGE_KEY_PREFIX = ASSESSMENT_KEY_PREFIX;

export function createInitialControlsState(
  tenantId?: string,
  framework: ComplianceFramework = 'CMMC_L1',
  controls?: FrameworkControlDefinition[]
): Record<string, ControlState> {
  const targetControls = controls && controls.length > 0 ? controls : getFrameworkControls(framework);
  const initial: Record<string, ControlState> = {};
  for (const ctrl of targetControls) {
    initial[ctrl.id] = {
      id: ctrl.id,
      tenantId,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: new Date().toISOString(),
      tags: [],
    };
  }
  return initial;
}

/**
 * #151: the old export form seeded invented values and "Save & Sync Metadata" wrote them into the SSP metadata.
 * An exact match of one of those strings is treated as never recorded. Pure: returns the input when nothing matches.
 */
export function scrubInventedMetadata(meta: SSPMetadata): SSPMetadata {
  if (!meta) return meta;
  const boundary = meta.systemBoundaryScope || '';
  const invented =
    meta.organizationName === 'Organization Enclave' ||
    meta.authorName === 'Compliance & Audit Assessment Team' ||
    meta.authorName === 'Lead Compliance Assessor' ||
    boundary.startsWith('The system boundary encompasses corporate identity tenants');
  if (!invented) return meta;
  return {
    ...meta,
    organizationName: meta.organizationName === 'Organization Enclave' ? '' : meta.organizationName,
    authorName: meta.authorName === 'Compliance & Audit Assessment Team' || meta.authorName === 'Lead Compliance Assessor' ? '' : meta.authorName,
    systemBoundaryScope: boundary.startsWith('The system boundary encompasses corporate identity tenants') ? '' : meta.systemBoundaryScope,
  };
}

export function createDefaultSspMetadata(tenant: Tenant): SSPMetadata {
  return {
    tenantId: tenant.id,
    systemName: tenant.systemName || '',
    organizationName: tenant.name || '',
    cageCode: tenant.cageCode || '',
    samStatus: tenant.samStatus || 'NOT_REGISTERED',
    systemOwner: tenant.systemOwner || '',
    authorName: '',
    assessmentDate: new Date().toISOString().split('T')[0],
    systemBoundaryScope: tenant.systemBoundaryScope || '',
    systemEnvironment: '',
    cloudServiceProviders: '',
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
  };
}

export function createInitialState(tenant: Tenant, frameworkOverride?: ComplianceFramework): AssessmentState {
  const framework = frameworkOverride || tenant.primaryFramework || 'CMMC_L1';
  return {
    version: '2.0.0',
    tenantId: tenant.id,
    sspMetadata: createDefaultSspMetadata(tenant),
    controls: createInitialControlsState(tenant.id, framework),
    evidenceIndex: [],
    lastSaved: new Date().toISOString(),
  };
}

export const StorageService = {
  /**
   * The cache key of one tenant's assessment. `segment` names a program other than the default one: that program's cache is
   * `<tenant key>::<segment>`. The default program (and any browser-only tenant) passes null and keeps the legacy key.
   */
  getAssessmentKey(tenantId: string, segment: string | null | undefined): string {
    return segment ? `${STORAGE_KEY_PREFIX}${tenantId}::${segment}` : `${STORAGE_KEY_PREFIX}${tenantId}`;
  },

  /** The legacy (default program) cache key of a tenant. */
  getTenantKey(tenantId: string): string {
    return this.getAssessmentKey(tenantId, null);
  },

  /**
   * Load isolated assessment for a specific tenant, performing legacy migration if needed. `segment` selects a non-default
   * program's cache (see getAssessmentKey); a program that has no cache yet starts blank for `framework`.
   */
  loadAssessment(tenant: Tenant, framework: ComplianceFramework = 'CMMC_L1', segment: string | null = null): AssessmentState {
    try {
      const key = this.getAssessmentKey(tenant.id, segment);
      const data = localStorage.getItem(key);
      if (data) {
        const parsed = JSON.parse(data) as AssessmentState;
        const targetControls = getFrameworkControls(framework);
        // Ensure all framework controls are present
        for (const ctrl of targetControls) {
          if (!parsed.controls[ctrl.id]) {
            parsed.controls[ctrl.id] = {
              id: ctrl.id,
              tenantId: tenant.id,
              status: 'NOT_STARTED',
              implementationNotes: '',
              responsibleRole: 'IT / Security Lead',
              lastUpdated: new Date().toISOString(),
              tags: [],
            };
          }
        }
        // Server-backed tenants keep notes on the server only: the cache never holds them, so the editors start empty
        // until the server copy loads. Browser-only tenants keep their (only) copy.
        for (const ctrl of Object.values(parsed.controls)) {
          ctrl.implementationNotes = tenant.serverBacked ? '' : typeof ctrl.implementationNotes === 'string' ? ctrl.implementationNotes : '';
          // Failing-asset lists (host names, IPs, scan output) are session-only for a live tenant
          if (tenant.serverBacked) delete ctrl.failingAssets;
        }
        // The evidence list (file names, descriptions) is likewise server-only for a live tenant; the live list replaces it.
        if (tenant.serverBacked) parsed.evidenceIndex = [];
        if (parsed.sspMetadata) parsed.sspMetadata = scrubInventedMetadata(parsed.sspMetadata);
        // Once the server holds this program's SSP metadata the cache holds none of it (#84); the server copy fills it in.
        if (tenant.serverBacked && parsed.sspMetadataMigratedAt && parsed.sspMetadata) {
          for (const field of SSP_METADATA_FIELDS) (parsed.sspMetadata as unknown as Record<string, unknown>)[field] = '';
        }
        parsed.tenantId = tenant.id;
        return parsed;
      }

      // Default blank state for new tenants
      const blankState = createInitialState(tenant, segment ? framework : undefined);
      this.saveAssessment(tenant.id, blankState, { segment });
      return blankState;
    } catch (err) {
      console.error(`Failed to load assessment for tenant ${tenant.id}:`, err);
      return createInitialState(tenant, segment ? framework : undefined);
    }
  },

  /**
   * Moves a tenant's locally stored assessment (controls, narratives, evidence index, SSP metadata) to a new
   * tenant id, rewriting every embedded tenantId, and removes the old copy. Used when a browser-only tenant is
   * migrated to a server-created tenant. Returns the migrated state.
   */
  migrateAssessment(from: Tenant, toTenantId: string): AssessmentState {
    const old = this.loadAssessment(from);
    const controls: AssessmentState['controls'] = {};
    for (const [id, c] of Object.entries(old.controls)) controls[id] = { ...c, tenantId: toTenantId };
    const migrated: AssessmentState = {
      ...old,
      tenantId: toTenantId,
      controls,
      evidenceIndex: old.evidenceIndex.map((e) => ({ ...e, tenantId: toTenantId })),
      sspMetadata: { ...old.sspMetadata, tenantId: toTenantId },
    };
    this.saveAssessment(toTenantId, migrated);
    try {
      if (from.id !== toTenantId) localStorage.removeItem(this.getTenantKey(from.id));
    } catch {
      // storage unavailable: the old copy simply stays
    }
    return migrated;
  },

  /**
   * Save assessment state under strict tenant namespace. Implementation notes (possible CUI) are stripped from the
   * cache unless `keepNotes` is set, which only browser-only tenants may do (their cache is the only copy).
   */
  saveAssessment(tenantId: string, state: AssessmentState, options: { keepNotes?: boolean; segment?: string | null } = {}): void {
    try {
      const base: AssessmentState = options.keepNotes ? state : stripEvidenceIndexForCache(stripSspMetadataForCache(stripObjectiveNarrativesForCache(stripFailingAssetsForCache(stripImplementationNotesForCache(state)))));
      const payload: AssessmentState = {
        ...base,
        tenantId,
        lastSaved: new Date().toISOString(),
      };
      localStorage.setItem(this.getAssessmentKey(tenantId, options.segment), JSON.stringify(payload));
    } catch (err) {
      console.error(`Failed to save assessment for tenant ${tenantId}:`, err);
    }
  },

  /**
   * Export single tenant assessment to JSON
   */
  exportJSON(state: AssessmentState): void {
    const jsonStr = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const orgSlug = (state.sspMetadata.organizationName || 'Tenant').replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `CMMC_L1_${orgSlug}_${state.sspMetadata.cageCode || 'CAGE'}_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Export formatted Markdown SSP for the active framework
   */
  exportMarkdown(
    state: AssessmentState,
    controls?: FrameworkControlDefinition[],
    framework: ComplianceFramework = 'CMMC_L1'
  ): void {
    const meta = state.sspMetadata;
    const fwTitle = framework === 'CMMC_L1' ? 'CMMC LEVEL 1' : framework.replace(/_/g, ' ');
    let md = `# SYSTEM SECURITY PLAN (SSP) - ${fwTitle.toUpperCase()}\n\n`;
    md += `**Document Version:** ${meta.version || '1.0.0'}\n`;
    md += `**Organization:** ${meta.organizationName}\n`;
    md += `**CAGE Code:** ${meta.cageCode || 'N/A'}\n`;
    md += `**SAM.gov Status:** ${meta.samStatus || 'Active'}\n`;
    md += `**System Name:** ${meta.systemName}\n`;
    md += `**System Owner:** ${meta.systemOwner}\n`;
    md += `**Lead Assessor:** ${meta.authorName}\n`;
    md += `**Assessment Date:** ${meta.assessmentDate}\n`;
    md += `**Evidence vault (local):** \`tenants/${state.tenantId}/\`\n\n`;
    md += `## 1. System Scope & Boundary Description\n${meta.systemBoundaryScope}\n\n`;
    md += `## 2. Operating Environment & Cloud Service Providers (CSPs)\n`;
    md += `- **Environment:** ${meta.systemEnvironment}\n`;
    md += `- **Authorized CSPs:** ${meta.cloudServiceProviders}\n\n`;

    const activeControls: FrameworkControlDefinition[] =
      controls && controls.length > 0 ? controls : getFrameworkControls(framework);
    md += `## 3. ${activeControls.length} Controls Security Requirements Matrix\n\n`;

    for (const ctrl of activeControls) {
      const cState = state.controls[ctrl.id];
      const ctrlEvidence = state.evidenceIndex.filter(e => e.controlId === ctrl.id);
      const authority = ctrl.authorityReference || '';
      md += `### ${ctrl.id}: ${ctrl.title}\n`;
      if (authority) md += `- **Authority Reference:** ${authority}\n`;
      md += `- **Domain:** ${ctrl.domain} - ${ctrl.plainEnglishSummary}\n`;
      md += `- **Evaluation Status:** **${cState?.status || 'NOT_STARTED'}**\n`;
      md += `- **Responsible Role:** ${cState?.responsibleRole || 'IT / Security Lead'}\n`;
      md += `\n**Implementation Statement:**\n`;
      md += `${cState?.implementationNotes || '_No implementation narrative provided._'}\n\n`;

      if (ctrlEvidence.length > 0) {
        md += `**Audit Evidence Artifacts:**\n`;
        ctrlEvidence.forEach(e => {
          md += `- **${e.name}** (${Math.round(e.fileSize / 1024)} KB) | SHA-256: \`${e.fileHash || 'N/A'}\`\n`;
        });
      } else {
        md += `_No evidence files attached._\n`;
      }
      md += `\n---\n\n`;
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const orgSlug = (meta.organizationName || 'Tenant').replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `${framework}_SSP_${orgSlug}_${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /** Every browser-storage key of a tenant's non-default programs (`<tenant key>::<program>`), plus its active-program choice. */
  listProgramKeys(tenantId: string): string[] {
    const prefix = `${this.getTenantKey(tenantId)}::`;
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      const activeKey = activeProgramStorageKey(tenantId);
      if (localStorage.getItem(activeKey) !== null) keys.push(activeKey);
    } catch {
      // storage unavailable: nothing to list
    }
    return keys;
  },

  /**
   * Clear all storage for a specific tenant: the legacy (default program) cache, every other program's cache, and the
   * active-program choice
   */
  clearTenant(tenantId: string): void {
    try {
      for (const key of this.listProgramKeys(tenantId)) localStorage.removeItem(key);
      localStorage.removeItem(this.getTenantKey(tenantId));
    } catch (err) {
      console.error(`Failed to clear storage for tenant ${tenantId}:`, err);
    }
  },
};
