import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { notifyDocumentsChanged, subscribeDocuments } from '../services/documentService';
import { MAX_DOCUMENTS_PER_TENANT, type DocumentInput, type DocumentOrigin, type GovernanceDocument } from '../types/documents';

/** 'unsupported': a tenant stored only in this browser (the register lives on the server). */
export type DocumentRegisterStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface DocumentUsage {
  programs: number;
  controlLinks: number;
  attachments: number;
  expectations: number;
}

export interface UseDocumentRegister {
  /** The register lives on the server: a tenant stored only in this browser has none. */
  supported: boolean;
  status: DocumentRegisterStatus;
  documents: GovernanceDocument[];
  /** The most documents the register holds (2,000). */
  limit: number;
  /** The write roles (TENANT_OWNER, TENANT_ADMIN, MSP_ADMIN): the only roles whose changes the server accepts. */
  canEdit: boolean;
  reload: () => Promise<void>;
  /** Every mutator rejects with the ApiError unchanged (`field` on a 400, `documentId` on a 409 `duplicate_seed`); after a 404 or 409 the list has been reloaded first. */
  create: (input: DocumentInput & { origin?: DocumentOrigin; seedKey?: string }) => Promise<GovernanceDocument>;
  update: (id: string, input: DocumentInput, expectedUpdatedAt: string) => Promise<{ document: GovernanceDocument; changed: boolean; approvalCleared: boolean }>;
  /** `confirmReviewed` only from the person's own tick of "I reviewed and edited this document"; the approver is always the signed-in person. */
  approve: (id: string, approval: { version: string; approvalDate: string; reviewBy: string | null; confirmReviewed?: true }, expectedUpdatedAt: string) => Promise<GovernanceDocument>;
  setStatus: (id: string, status: 'DRAFT' | 'RETIRED', expectedUpdatedAt: string) => Promise<GovernanceDocument>;
  remove: (id: string) => Promise<void>;
  usage: (id: string) => Promise<DocumentUsage>;
}

interface Loaded {
  tenantId: string;
  documents: GovernanceDocument[];
  limit: number;
}

const NO_DOCUMENTS: GovernanceDocument[] = [];

/** The refusals after which what is on screen is out of date: the document is gone, or someone else changed it. */
const isOutOfDate = (err: unknown): boolean => {
  const status = ((err ?? {}) as { status?: unknown }).status;
  return status === 404 || status === 409;
};

/**
 * The active tenant's document register (server-backed tenants only). Does nothing until `enabled`, and for a browser-only tenant.
 * Held in React state only: titles, owners, locations and notes may be CUI and are never cached in browser storage, logged or sent anywhere
 * but the server. Reloads when any other instance (the panel, the checklist, the SSP builder, the export modal) changes the register.
 */
export function useDocumentRegister(options?: { enabled?: boolean }): UseDocumentRegister {
  const enabled = options?.enabled ?? true;
  const { currentTenant, canEdit } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('documentRegister'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) return;
    try {
      const res = await ApiClient.listDocuments(tenantId);
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setLoaded({ tenantId, documents: res.documents, limit: res.limit });
      setFailedFor(null);
    } catch {
      if (request !== latest.current) return;
      setFailedFor(tenantId);
    }
  }, [tenantId, active]);

  useEffect(() => {
    void reload();
    if (!active) return undefined;
    return subscribeDocuments((c) => {
      if (c.tenantId === tenantId && c.kind === 'documents' && c.origin !== origin.current) void reload();
    });
  }, [tenantId, active, reload]);

  // One call goes through here: the list is reloaded after a change (and after a refusal that means it is out of date), then the others are told
  const change = useCallback(
    async <T>(run: () => Promise<T>): Promise<T> => {
      if (!active) throw new Error('The document register is not available.');
      let result: T;
      try {
        result = await run();
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
      await reload();
      notifyDocumentsChanged(tenantId, 'documents', null, origin.current);
      return result;
    },
    [active, tenantId, reload]
  );

  const create = useCallback((input: DocumentInput & { origin?: DocumentOrigin; seedKey?: string }) => change(() => ApiClient.createDocument(tenantId, input)), [change, tenantId]);
  const update = useCallback(
    (id: string, input: DocumentInput, expectedUpdatedAt: string) => change(() => ApiClient.updateDocument(tenantId, id, input, expectedUpdatedAt)),
    [change, tenantId]
  );
  const approve = useCallback(
    (id: string, approval: { version: string; approvalDate: string; reviewBy: string | null; confirmReviewed?: true }, expectedUpdatedAt: string) =>
      change(() => ApiClient.approveDocument(tenantId, id, approval, expectedUpdatedAt)),
    [change, tenantId]
  );
  const setStatus = useCallback(
    (id: string, status: 'DRAFT' | 'RETIRED', expectedUpdatedAt: string) => change(() => ApiClient.setDocumentStatus(tenantId, id, status, expectedUpdatedAt)),
    [change, tenantId]
  );
  const remove = useCallback((id: string) => change(() => ApiClient.deleteDocument(tenantId, id)), [change, tenantId]);
  const usage = useCallback(
    async (id: string): Promise<DocumentUsage> => {
      if (!active) throw new Error('The document register is not available.');
      try {
        return await ApiClient.getDocumentUsage(tenantId, id);
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
    },
    [active, tenantId, reload]
  );

  // Another tenant's documents never show while this one loads
  const mine = loaded && loaded.tenantId === tenantId ? loaded : null;
  const status: DocumentRegisterStatus = !supported ? 'unsupported' : !active ? 'loading' : failedFor === tenantId ? 'error' : mine ? 'ready' : 'loading';
  return useMemo<UseDocumentRegister>(
    () => ({
      supported,
      status,
      documents: active && mine ? mine.documents : NO_DOCUMENTS,
      limit: mine?.limit ?? MAX_DOCUMENTS_PER_TENANT,
      canEdit,
      reload,
      create,
      update,
      approve,
      setStatus,
      remove,
      usage,
    }),
    [supported, status, active, mine, canEdit, reload, create, update, approve, setStatus, remove, usage]
  );
}
