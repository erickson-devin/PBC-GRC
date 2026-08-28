import { AssessmentState, ControlState, SSPMetadata, EvidenceItem } from '../types/cmmc';
import { CMMC_LEVEL_1_CONTROLS } from '../data/cmmcLevel1Controls';

const STORAGE_KEY = 'pbc_cmmc_assessment_v1';

export const DEFAULT_SSP_METADATA: SSPMetadata = {
  systemName: 'Corporate Operations Enclave (COE)',
  organizationName: 'Apex Defense Solutions, LLC',
  cageCode: '9X7B4',
  systemOwner: 'Devin Erickson, Chief Information Security Officer',
  authorName: 'Compliance Assessment Team',
  assessmentDate: new Date().toISOString().split('T')[0],
  systemBoundaryScope: 'The boundary includes all corporate Microsoft 365 cloud tenant services, Entra ID identity infrastructure, corporate endpoints (Windows 11 Enterprise laptops), internal office network (VLAN 10), and Next-Generation Boundary Firewalls used for processing, storing, or transmitting Federal Contract Information (FCI).',
  systemEnvironment: 'Hybrid Cloud: Microsoft 365 Commercial Cloud + Corporate HQ On-Premises Network.',
  cloudServiceProviders: 'Microsoft 365 (SaaS), Microsoft Azure (Entra ID IDaaS), Cloudflare (DNS/DDoS).',
  version: '1.0.0',
};

export function createInitialControlsState(): Record<string, ControlState> {
  const initial: Record<string, ControlState> = {};
  for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
    initial[ctrl.id] = {
      id: ctrl.id,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: new Date().toISOString(),
      tags: [],
    };
  }
  return initial;
}

export function createInitialState(): AssessmentState {
  return {
    version: '1.0.0',
    sspMetadata: { ...DEFAULT_SSP_METADATA },
    controls: createInitialControlsState(),
    evidenceIndex: [],
    lastSaved: new Date().toISOString(),
  };
}

export function createDemoState(): AssessmentState {
  const controls: Record<string, ControlState> = {};
  const evidenceIndex: EvidenceItem[] = [];

  for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
    // Pick first starter template
    const template = ctrl.starterTemplates[0];
    controls[ctrl.id] = {
      id: ctrl.id,
      status: 'MET', // 100% SPRS Ready in demo mode
      implementationNotes: template ? template.narrative : 'Control requirements fully satisfied.',
      responsibleRole: ctrl.domain === 'PE' ? 'Facilities Manager' : 'CISO / IT Director',
      lastUpdated: new Date().toISOString(),
      tags: ['Verified', 'Audit-Ready'],
    };

    if (template && template.recommendedEvidence) {
      template.recommendedEvidence.slice(0, 2).forEach((filename, idx) => {
        evidenceIndex.push({
          id: `demo_${ctrl.id}_${idx}`,
          controlId: ctrl.id,
          name: filename,
          fileSize: Math.floor(Math.random() * 400000) + 50000,
          mimeType: filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.png') ? 'image/png' : 'application/octet-stream',
          uploadedAt: new Date(Date.now() - (idx * 86400000 * 2)).toISOString(),
          description: `Audit artifact supporting ${ctrl.id}`,
          hasBlob: false,
        });
      });
    }
  }

  return {
    version: '1.0.0',
    sspMetadata: {
      ...DEFAULT_SSP_METADATA,
      organizationName: 'Apex Defense Technologies, Inc.',
      cageCode: '8K3R1',
      systemName: 'Defense Contracting Information Network (DCIN)',
    },
    controls,
    evidenceIndex,
    lastSaved: new Date().toISOString(),
  };
}

export const StorageService = {
  loadAssessment(): AssessmentState {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) {
        return createInitialState();
      }
      const parsed = JSON.parse(data) as AssessmentState;
      // Ensure all 17 controls are present in case schema changed
      for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
        if (!parsed.controls[ctrl.id]) {
          parsed.controls[ctrl.id] = {
            id: ctrl.id,
            status: 'NOT_STARTED',
            implementationNotes: '',
            responsibleRole: 'IT Lead',
            lastUpdated: new Date().toISOString(),
            tags: [],
          };
        }
      }
      return parsed;
    } catch (err) {
      console.error('Failed to load assessment from localStorage:', err);
      return createInitialState();
    }
  },

  saveAssessment(state: AssessmentState): void {
    try {
      const payload = {
        ...state,
        lastSaved: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error('Failed to save assessment to localStorage:', err);
    }
  },

  exportJSON(state: AssessmentState): void {
    const jsonStr = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CMMC_Level1_Assessment_${state.sspMetadata.cageCode || 'PBC'}_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  exportMarkdown(state: AssessmentState): void {
    let md = `# SYSTEM SECURITY PLAN (SSP) - CMMC LEVEL 1\n`;
    md += `**Organization:** ${state.sspMetadata.organizationName}\n`;
    md += `**CAGE Code:** ${state.sspMetadata.cageCode}\n`;
    md += `**System Name:** ${state.sspMetadata.systemName}\n`;
    md += `**System Owner:** ${state.sspMetadata.systemOwner}\n`;
    md += `**Assessment Date:** ${state.sspMetadata.assessmentDate}\n\n`;
    md += `## 1. System Scope & Boundary\n${state.sspMetadata.systemBoundaryScope}\n\n`;
    md += `## 2. Control Compliance Assessment Matrix\n\n`;

    for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
      const cState = state.controls[ctrl.id];
      const ctrlEvidence = state.evidenceIndex.filter(e => e.controlId === ctrl.id);
      md += `### ${ctrl.id}: ${ctrl.title}\n`;
      md += `- **FAR Reference:** ${ctrl.farReference}\n`;
      md += `- **Status:** **${cState?.status || 'NOT_STARTED'}**\n`;
      md += `- **Responsible Role:** ${cState?.responsibleRole || 'IT Lead'}\n`;
      md += `\n**Implementation Statement:**\n`;
      md += `${cState?.implementationNotes || '_No implementation statement provided._'}\n\n`;
      if (ctrlEvidence.length > 0) {
        md += `**Attached Evidence Artifacts:**\n`;
        ctrlEvidence.forEach(e => {
          md += `- ${e.name} (${Math.round(e.fileSize / 1024)} KB) - Uploaded: ${e.uploadedAt.split('T')[0]}\n`;
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
    a.download = `CMMC_Level1_SSP_${state.sspMetadata.cageCode || 'PBC'}_${new Date().toISOString().split('T')[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  clearAll(): void {
    localStorage.removeItem(STORAGE_KEY);
  },
};
