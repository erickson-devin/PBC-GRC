import { AssessmentState, ControlState, SSPMetadata, EvidenceItem } from '../types/cmmc';
import { Tenant } from '../types/tenant';
import { CMMC_LEVEL_1_CONTROLS } from '../data/cmmcLevel1Controls';
import { GcsService, DEFAULT_GCP_CONFIG } from './gcsService';

const STORAGE_KEY_PREFIX = 'pbc_cmmc_assessment_v3_';

export function createInitialControlsState(tenantId?: string): Record<string, ControlState> {
  const initial: Record<string, ControlState> = {};
  for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
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
    systemName: tenant.systemName || 'Defense Contracting Information Network (DCIN)',
    organizationName: tenant.name,
    cageCode: tenant.cageCode,
    samStatus: tenant.samStatus,
    systemOwner: tenant.systemOwner || 'Alex Mercer, CMMC CCA',
    authorName: 'Compliance & Audit Assessment Team',
    assessmentDate: new Date().toISOString().split('T')[0],
    systemBoundaryScope: `The boundary for ${tenant.name} includes all corporate Microsoft 365 / Google Cloud tenant services, identity infrastructure, corporate managed endpoints (Windows 11 Enterprise laptops), internal facility network (VLAN 10), and Next-Generation Boundary Firewalls used for processing, storing, or transmitting Federal Contract Information (FCI).`,
    systemEnvironment: 'Hybrid Cloud: SaaS / Cloud Identity + Corporate Facility On-Premises Network.',
    cloudServiceProviders: 'Microsoft 365, Google Cloud Platform (Cloud Storage / Cloud SQL), Cloudflare (DNS/DDoS).',
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
  };
}

export function createInitialState(tenant: Tenant): AssessmentState {
  return {
    version: '2.0.0',
    tenantId: tenant.id,
    sspMetadata: createDefaultSspMetadata(tenant),
    controls: createInitialControlsState(tenant.id),
    evidenceIndex: [],
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Creates 100% compliant SPRS-ready demo state (17/17 controls MET) with SHA-256 evidence
 */
export function createDemoState(tenant: Tenant): AssessmentState {
  const controls: Record<string, ControlState> = {};
  const evidenceIndex: EvidenceItem[] = [];

  for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
    const template = ctrl.starterTemplates[0];
    controls[ctrl.id] = {
      id: ctrl.id,
      tenantId: tenant.id,
      status: 'MET', // 100% SPRS Ready for Vanguard Defense Systems
      implementationNotes: template ? template.narrative : 'Control requirements fully documented and verified in accordance with CMMC Level 1 standards.',
      responsibleRole: ctrl.domain === 'PE' ? 'Facilities Manager' : 'CISO / IT Director',
      lastUpdated: new Date().toISOString(),
      tags: ['Verified', 'Audit-Ready', 'GCP-Backed'],
      updatedBy: 'Alex Mercer, CMMC CCA (Lead Assessor)',
    };

    if (template && template.recommendedEvidence) {
      template.recommendedEvidence.slice(0, 2).forEach((filename, idx) => {
        const fileId = `demo_${ctrl.id.replace(/[^a-zA-Z0-9]/g, '_')}_${idx + 1}`;
        const gcsPath = GcsService.generateGcsPath(tenant.id, ctrl.id, fileId, filename);
        // Pre-computed representative SHA-256 hash
        const demoHash = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8${(idx + 10).toString(16)}`;

        evidenceIndex.push({
          id: fileId,
          tenantId: tenant.id,
          controlId: ctrl.id,
          name: filename,
          fileSize: Math.floor(Math.random() * 350000) + 75000,
          mimeType: filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.png') ? 'image/png' : filename.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          uploadedAt: new Date(Date.now() - (idx * 86400000 * 3) - 3600000).toISOString(),
          description: `GCS Audit Artifact verifying ${ctrl.id} implementation statement`,
          hasBlob: false,
          gcsPath,
          fileHash: demoHash,
          syncStatus: 'gcs_synced',
          uploadedBy: 'Compliance Assessor',
        });
      });
    }
  }

  return {
    version: '2.0.0',
    tenantId: tenant.id,
    sspMetadata: {
      ...createDefaultSspMetadata(tenant),
      organizationName: tenant.name,
      cageCode: tenant.cageCode,
      systemName: tenant.systemName,
    },
    controls,
    evidenceIndex,
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Creates partial in-progress demo state (e.g. 10/17 MET) for Company B
 */
export function createPartialDemoState(tenant: Tenant): AssessmentState {
  const controls: Record<string, ControlState> = {};
  const evidenceIndex: EvidenceItem[] = [];

  CMMC_LEVEL_1_CONTROLS.forEach((ctrl, idx) => {
    const isMet = idx < 10;
    const isInProgress = idx >= 10 && idx < 14;
    const template = ctrl.starterTemplates[0];

    controls[ctrl.id] = {
      id: ctrl.id,
      tenantId: tenant.id,
      status: isMet ? 'MET' : isInProgress ? 'IN_PROGRESS' : 'NOT_STARTED',
      implementationNotes: isMet && template
        ? template.narrative
        : isInProgress
        ? `Remediation in progress. Drafting technical procedures for ${ctrl.title}.`
        : '',
      responsibleRole: ctrl.domain === 'PE' ? 'Facilities Lead' : 'Security Engineer',
      lastUpdated: new Date().toISOString(),
      tags: isMet ? ['In Review'] : isInProgress ? ['Pending Evidence'] : [],
      updatedBy: 'MSP Consultant',
    };

    if (isMet && template && template.recommendedEvidence.length > 0) {
      const filename = template.recommendedEvidence[0];
      const fileId = `b_demo_${ctrl.id.replace(/[^a-zA-Z0-9]/g, '_')}_1`;
      evidenceIndex.push({
        id: fileId,
        tenantId: tenant.id,
        controlId: ctrl.id,
        name: filename,
        fileSize: 124500,
        mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        uploadedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
        description: `Preliminary audit artifact for ${ctrl.id}`,
        hasBlob: false,
        gcsPath: GcsService.generateGcsPath(tenant.id, ctrl.id, fileId, filename),
        fileHash: `7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069`,
        syncStatus: 'gcs_synced',
        uploadedBy: 'MSP Consultant',
      });
    }
  });

  return {
    version: '2.0.0',
    tenantId: tenant.id,
    sspMetadata: createDefaultSspMetadata(tenant),
    controls,
    evidenceIndex,
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
  loadAssessment(tenant: Tenant): AssessmentState {
    try {
      const key = this.getTenantKey(tenant.id);
      const data = localStorage.getItem(key);
      if (data) {
        const parsed = JSON.parse(data) as AssessmentState;
        // Ensure all 17 controls are present
        for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
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

      // Check if this is the primary 100% compliant demo tenant
      if (tenant.id === 'tenant-vanguard-01' || tenant.id === 'tenant-apex-01') {
        const demoState = createDemoState(tenant);
        this.saveAssessment(tenant.id, demoState);
        return demoState;
      }

      // Check if this is the in-progress secondary tenant
      if (tenant.id === 'tenant-apex-02' || tenant.id === 'tenant-vanguard-02') {
        const partialState = createPartialDemoState(tenant);
        this.saveAssessment(tenant.id, partialState);
        return partialState;
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
   * Export formatted NIST SP 800-171 / FAR 52.204-21 Markdown SSP
   */
  exportMarkdown(state: AssessmentState): void {
    const meta = state.sspMetadata;
    let md = `# SYSTEM SECURITY PLAN (SSP) - CMMC LEVEL 1\n\n`;
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
    md += `## 3. 17 CMMC Level 1 Security Requirements Matrix (FAR 52.204-21)\n\n`;

    for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
      const cState = state.controls[ctrl.id];
      const ctrlEvidence = state.evidenceIndex.filter(e => e.controlId === ctrl.id);
      md += `### ${ctrl.id}: ${ctrl.title}\n`;
      md += `- **FAR Reference:** ${ctrl.farReference}\n`;
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
    a.download = `CMMC_Level1_SSP_${orgSlug}_${new Date().toISOString().split('T')[0]}.md`;
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
