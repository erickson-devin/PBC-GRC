import { ControlState, EvidenceItem } from '../types/cmmc';
import { ComplianceFramework, BaselineTier, OverlayParameter, ControlMapping, FrameworkSummary } from '../types/framework';

const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';
const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || (typeof process !== 'undefined' && process.env?.VITE_API_URL) || '';

export interface UploadUrlResponse {
  message: string;
  uploadUrl: string;
  gcsPath: string;
  evidenceId: string;
  evidence: EvidenceItem;
}

export type AuthMode = 'firebase' | 'local';

export interface LocalLoginResponse {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
  expiresIn: number;
  user: { id: string; email: string; name: string };
}

export const ApiClient = {
  /**
   * GET /api/v1/auth/config
   * Which identity provider the server uses. Returns null if the server cannot be reached.
   */
  async getAuthMode(): Promise<AuthMode | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/config`);
      if (!res.ok) return null;
      const data = (await res.json()) as { mode?: string };
      return data.mode === 'local' ? 'local' : 'firebase';
    } catch {
      return null;
    }
  },

  /**
   * POST /api/v1/auth/login  (air-gapped installs, AUTH_MODE=local)
   * Throws an Error carrying the server's message (e.g. invalid credentials, account locked).
   */
  async localLogin(email: string, password: string): Promise<LocalLoginResponse> {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `Sign-in failed (HTTP ${res.status})`);
    }
    return data as LocalLoginResponse;
  },

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
  async getFrameworks(): Promise<FrameworkSummary[]> {
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
  async getControlMappings(controlId?: string): Promise<ControlMapping[]> {
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
   * GET /api/v1/evidence/config/storage-info
   * Reports the server's active evidence storage provider (local disk or GCS).
   */
  async getStorageInfo(
    tenantId: string
  ): Promise<{ provider: string; localStoragePath: string; isAirGapped: boolean } | null> {
    const res = await fetch(`${API_BASE_URL}/api/v1/evidence/config/storage-info`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });
    if (!res.ok) return null;
    return await res.json();
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
   * Uploads binary file directly to Local Enclave Storage or GCS via Signed URL
   */
  async uploadFileToGcs(signedUrl: string, file: File | Blob, mimeType: string, tenantId?: string): Promise<void> {
    const isServerRelative = signedUrl.startsWith('/');
    const targetUrl = isServerRelative && API_BASE_URL ? `${API_BASE_URL}${signedUrl}` : signedUrl;
    const headers: Record<string, string> = {
      'Content-Type': mimeType || 'application/octet-stream',
    };
    // Only our own API receives credentials; a GCS signed URL carries its own signature.
    if (isServerRelative) {
      if (tenantId) {
        headers['x-tenant-id'] = tenantId;
      }
      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const res = await fetch(targetUrl, {
      method: 'PUT',
      headers,
      body: file,
    });

    if (!res.ok) {
      throw new Error(`Evidence upload failed with status ${res.status}: ${res.statusText}`);
    }
  },
};
