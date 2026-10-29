import { useCallback, useEffect, useRef, useState } from 'react';
import { keys as idbKeys, get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { programScopeKey } from '../data/programSync';
import { recordAuditEvent } from '../data/audit/auditLogger';
import {
  LocalEvidenceCopy,
  MoveResult,
  listLocalEvidenceCopies,
  moveLocalEvidenceCopy,
  sha256Hex,
} from '../services/localEvidenceCopies';

export interface LocalEvidenceCopiesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  copies: LocalEvidenceCopy[];
  error: string | null;
  /** The key of the copy being uploaded or discarded, or null. One action at a time. */
  busyKey: string | null;
  refresh: () => void;
  upload: (copy: LocalEvidenceCopy, controlId: string) => Promise<MoveResult>;
  discard: (copy: LocalEvidenceCopy) => Promise<void>;
}

/**
 * Evidence files that sit only in this browser for a server-backed tenant: no program of the tenant holds their id on the server.
 * Listed for the user to upload or discard, never removed automatically. The list lives in React state only.
 */
export function useLocalEvidenceCopies(): LocalEvidenceCopiesState {
  const { currentTenant, activeProgram, programs, programsStatus, liveEvidence, liveScopeKey, canEdit, currentUser, refreshLiveData } = useTenant();
  const [status, setStatus] = useState<LocalEvidenceCopiesState['status']>('idle');
  const [copies, setCopies] = useState<LocalEvidenceCopy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const busyRef = useRef(false);

  const tenantId = currentTenant.id;
  const programId = activeProgram?.id;
  const scope = programScopeKey(tenantId, programId);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!currentTenant.serverBacked || !ApiClient.getToken() || !liveEvidence || liveScopeKey !== scope) {
      setStatus('idle');
      setCopies([]);
      setError(null);
      return;
    }
    if (programsStatus === 'error') {
      // Without the program list the server's ids are unknown: list nothing rather than offer to re-upload files it may hold
      setStatus('error');
      setCopies([]);
      setError('Could not check which files the server holds.');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const ids = new Set<string>(liveEvidence.map(e => e.id));
        const programIds: Array<string | null> = programs.length > 0 ? programs.map(p => p.id) : [null];
        const lists = await Promise.all(programIds.map(id => ApiClient.getEvidence(tenantId, id)));
        for (const list of lists) for (const e of list) ids.add(e.id);
        const found = await listLocalEvidenceCopies({ keys: () => idbKeys(), get: (k) => idbGet(k) }, tenantId, ids);
        if (cancelled) return;
        if (found.length > 0) console.info(`[evidence-local] only in this browser ${found.length}`);
        setCopies(found);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setCopies([]);
        setStatus('error');
        setError('Could not check which files the server holds.');
      }
    })();
    return () => { cancelled = true; };
  }, [currentTenant.serverBacked, tenantId, scope, liveEvidence, liveScopeKey, programs, programsStatus, nonce]);

  const upload = useCallback(async (copy: LocalEvidenceCopy, controlId: string): Promise<MoveResult> => {
    if (!canEdit || activeProgram?.archived || busyRef.current) return { status: 'failed' };
    busyRef.current = true;
    setBusyKey(copy.key);
    const pid = programId ?? null;
    let result: MoveResult;
    try {
      result = await moveLocalEvidenceCopy({
        get: (k) => idbGet(k),
        set: (k, v) => idbSet(k, v),
        del: (k) => idbDel(k),
        hash: sha256Hex,
        requestUploadUrl: (p) => ApiClient.requestUploadUrl(tenantId, p, pid),
        uploadFile: (url, blob, type) => ApiClient.uploadEvidenceFile(url, blob, type, tenantId, pid),
        verify: (id) => ApiClient.verifyEvidenceIntegrity(tenantId, id, pid),
        fetchServerBytes: async (id) => (await ApiClient.getEvidenceFileBlob(tenantId, id, pid)).blob.arrayBuffer(),
        deleteServerRecord: (id) => ApiClient.deleteEvidence(tenantId, id, pid).then(() => undefined),
      }, { key: copy.key, evidenceId: copy.evidenceId, controlId, targetTenantId: tenantId });
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
    console.info(`[evidence-local] upload ${result.status}`);
    if (result.status === 'moved' || result.status === 'uploadedUnverified') {
      try {
        await refreshLiveData();
      } catch {
        // The list below re-checks on its own
      }
      refresh();
    }
    return result;
  }, [canEdit, activeProgram?.archived, programId, tenantId, refreshLiveData, refresh]);

  const discard = useCallback(async (copy: LocalEvidenceCopy): Promise<void> => {
    if (!canEdit || busyRef.current) throw new Error('Discard is not available.');
    busyRef.current = true;
    setBusyKey(copy.key);
    try {
      await idbDel(copy.key);
      // The id and the size only: the file name never enters the ledger
      recordAuditEvent({
        tenantId,
        metadata: { programId: programId ?? null },
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[tenantId] || 'Operator',
        actionType: 'EVIDENCE_DELETED',
        targetEntity: copy.evidenceId,
        newState: { browserCopyOnly: true, sizeBytes: copy.size },
      }).catch(() => {});
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
    refresh();
  }, [canEdit, tenantId, programId, currentUser, refresh]);

  return { status, copies, error, busyKey, refresh, upload, discard };
}
