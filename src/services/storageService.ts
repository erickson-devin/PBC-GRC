import { AssessmentState, ControlState, SSPMetadata } from '../types/cmmc';
import { Tenant } from '../types/tenant';
import { FrameworkControlDefinition, ComplianceFramework } from '../types/framework';
import { getFrameworkControls } from '../data/frameworks';
import { DEFAULT_GCP_CONFIG } from './gcsService';

const STORAGE_KEY_PREFIX = 'pbc_cmmc_assessment_v3_';

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

export function createDefaultSspMetadata(tenant: Tenant): SSPMetadata {
  return {
    tenantId: tenant.id,
    systemName: tenant.systemName || '',
    organizationName: tenant.name || '',
    cageCode: tenant.cageCode || '',
    samStatus: tenant.samStatus || 'NOT_REGISTERED',
    systemOwner: tenant.systemOwner || '',
    authorName: 'Compliance & Audit Assessment Team',
    assessmentDate: new Date().toISOString().split('T')[0],
    systemBoundaryScope: tenant.systemBoundaryScope || '',
    systemEnvironment: '',
    cloudServiceProviders: '',
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
  };
}

export function createInitialState(tenant: Tenant): AssessmentState {
  const framework = tenant.primaryFramework || 'CMMC_L1';
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
  getTenantKey(tenantId: string): string {
    return `${STORAGE_KEY_PREFIX}${tenantId}`;
  },

  /**
   * Load isolated assessment for a specific tenant, performing legacy migration if needed
   */
  loadAssessment(tenant: Tenant, framework: ComplianceFramework = 'CMMC_L1'): AssessmentState {
    try {
      const key = this.getTenantKey(tenant.id);
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
        parsed.tenantId = tenant.id;
        return parsed;
      }

      // Default blank state for new tenants
      const blankState = createInitialState(tenant);
      this.saveAssessment(tenant.id, blankState);
      return blankState;
    } catch (err) {
      console.error(`Failed to load assessment for tenant ${tenant.id}:`, err);
      return createInitialState(tenant);
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
   * Save assessment state under strict tenant namespace
   */
  saveAssessment(tenantId: string, state: AssessmentState): void {
    try {
      const payload: AssessmentState = {
        ...state,
        tenantId,
        lastSaved: new Date().toISOString(),
      };
      localStorage.setItem(this.getTenantKey(tenantId), JSON.stringify(payload));
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
    md += `**Cloud Storage (GCS) Enclave:** \`gs://${DEFAULT_GCP_CONFIG.gcsBucketName}/tenants/${state.tenantId}/\`\n\n`;
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
        md += `**GCS Audit Evidence Artifacts:**\n`;
        ctrlEvidence.forEach(e => {
          md += `- **${e.name}** (${Math.round(e.fileSize / 1024)} KB) | GCS: \`${e.gcsPath || 'Local'}\` | SHA-256: \`${e.fileHash || 'N/A'}\`\n`;
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

  /**
   * Clear all storage for a specific tenant
   */
  clearTenant(tenantId: string): void {
    try {
      localStorage.removeItem(this.getTenantKey(tenantId));
    } catch (err) {
      console.error(`Failed to clear storage for tenant ${tenantId}:`, err);
    }
  },
};
