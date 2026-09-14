import { ControlState, EvidenceItem } from '../types/cmmc';
import { ComplianceFramework, BaselineTier, OverlayParameter } from '../types/framework';

const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || (typeof process !== 'undefined' && process.env?.VITE_API_URL) || '';

export interface UploadUrlResponse {
  message: string;
  uploadUrl: string;
  gcsPath: string;
  evidenceId: string;
  evidence: EvidenceItem;
}

export const ApiClient = {
  /**
   * Retrieve active Firebase ID Token from localStorage
   */
  getToken(): string | null {
    try {
      return localStorage.getItem(AUTH_TOKEN_KEY);
    } catch {
      return null;
    }
  },

  /**
   * Constructs authorization and tenant context headers
   */
  getHeaders(tenantId: string, extraHeaders?: HeadersInit): HeadersInit {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return {
      ...headers,
      ...(extraHeaders as Record<string, string>),
    };
  },

  /**
   * Verify API backend health
   */
  async checkHealth(): Promise<{ status: string; database?: string } | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/health`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * GET /api/v1/controls
   * Fetches controls for the active tenant dynamically based on framework, baseline, and overlay
   */
  async getControls(
    tenantId: string,
    options?: {
      framework?: ComplianceFramework;
      baseline?: BaselineTier;
      overlay?: OverlayParameter;
    }
  ): Promise<ControlState[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error('Not authenticated: ID token not found');
    }

    const query = new URLSearchParams();
    if (options?.framework) query.set('framework_id', options.framework);
    if (options?.baseline) query.set('baseline', options.baseline);
    if (options?.overlay && options.overlay !== 'NONE') query.set('overlay', options.overlay);

    const queryString = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${API_BASE_URL}/api/v1/controls${queryString}`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch controls: ${res.status}`);
    }

    const data = await res.json();
    return data.controls || [];
  },

  /**
   * GET /api/v1/controls/frameworks
   * Fetches all supported compliance framework metadata
   */
  async getFrameworks(): Promise<any[]> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/controls/frameworks`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.frameworks || [];
    } catch {
      return [];
    }
  },

  /**
   * GET /api/v1/controls/mappings
   * Fetches cross-framework control mappings
   */
  async getControlMappings(controlId?: string): Promise<any[]> {
    try {
      const url = controlId
        ? `${API_BASE_URL}/api/v1/controls/mappings?control_id=${encodeURIComponent(controlId)}`
        : `${API_BASE_URL}/api/v1/controls/mappings`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return data.mappings || [];
    } catch {
      return [];
    }
  },

  /**
   * PUT /api/v1/controls/:controlId
   * Updates control implementation statement, status, role, and last updated time
   */
  async updateControl(
    tenantId: string,
    controlId: string,
    updates: Partial<ControlState>
  ): Promise<ControlState> {
    const res = await fetch(`${API_BASE_URL}/api/v1/controls/${encodeURIComponent(controlId)}`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({
        status: updates.status,
        implementationNotes: updates.implementationNotes,
        responsibleRole: updates.responsibleRole,
        updatedBy: updates.updatedBy,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to update control: ${res.status}`);
    }

    const data = await res.json();
    return data.control;
  },

  /**
   * GET /api/v1/evidence
   * Retrieves all evidence artifacts for the active tenant
   */
  async getEvidence(tenantId: string): Promise<EvidenceItem[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error('Not authenticated: ID token not found');
    }

    const res = await fetch(`${API_BASE_URL}/api/v1/evidence`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch evidence: ${res.status}`);
    }

    const data = await res.json();
    return data.evidence || [];
  },

  /**
   * POST /api/v1/evidence/upload-url
   * Requests a GCS Signed URL and registers evidence metadata in Cloud SQL
   */
  async requestUploadUrl(
    tenantId: string,
    payload: {
      controlId: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileHash: string; // SHA-256
      description?: string;
    }
  ): Promise<UploadUrlResponse> {
    const res = await fetch(`${API_BASE_URL}/api/v1/evidence/upload-url`, {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to generate upload URL: ${res.status}`);
    }

    return await res.json();
  },

  /**
   * Uploads binary file directly to GCS via Signed URL
   */
  async uploadFileToGcs(signedUrl: string, file: File | Blob, mimeType: string): Promise<void> {
    // If running with emulated mock token, simulate direct upload
    if (signedUrl.includes('GCS_SECURE_TOKEN_EMULATED')) {
      console.log('[ApiClient] Emulated GCS signed URL upload succeeded.');
      return;
    }

    const res = await fetch(signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: file,
    });

    if (!res.ok) {
      throw new Error(`GCS upload failed with status ${res.status}: ${res.statusText}`);
    }
  },
};
