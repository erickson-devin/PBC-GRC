import { useEffect, useRef } from 'react';
import { get, del } from 'idb-keyval';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { runEvidenceBlobScrub } from '../services/evidenceBlobScrub';
import { programScopeKey } from '../data/programSync';
import { sha256Hex } from '../services/localEvidenceCopies';

/**
 * For a server-backed tenant the server is the only home of evidence files, so a browser copy left by an older version is removed,
 * but only after the server confirms it holds the same bytes. Runs once per scope per session, once the live data for exactly the
 * scope on screen has loaded.
 */
export function useEvidenceBlobScrub(): void {
  const { currentTenant, activeProgram, liveEvidence, liveScopeKey } = useTenant();
  const done = useRef<Set<string>>(new Set());

  const programId = activeProgram?.id;
  const scope = programScopeKey(currentTenant.id, programId);

  useEffect(() => {
    if (!currentTenant.serverBacked || !liveEvidence || liveScopeKey !== scope) return;
    if (done.current.has(scope)) return;
    done.current.add(scope);
    const tenantId = currentTenant.id;
    const ids = liveEvidence.map(e => e.id);
    void runEvidenceBlobScrub({
      tenantId,
      get: (key) => get(key),
      del: (key) => del(key),
      verify: (id) => ApiClient.verifyEvidenceIntegrity(tenantId, id, programId ?? null),
      hash: sha256Hex,
      log: (message) => console.info(message),
    }, ids);
  }, [currentTenant.id, currentTenant.serverBacked, liveEvidence, liveScopeKey, scope, programId]);
}
