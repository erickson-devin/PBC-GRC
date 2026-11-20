import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssessment } from '../context/AssessmentContext';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import type { SspSectionId } from '../data/ssp/sspSections';
import type { SspSectionReview, SspSectionReviewState } from '../types/sspProfile';
import { useSspProfile } from './useSspProfile';

export interface UseSspReviews {
  /** False for a browser-only organization: sign-off needs the server (it records who signed and the content digest). */
  supported: boolean;
  /** 'ready' when `supported` is false. */
  status: 'loading' | 'ready' | 'error';
  sections: Partial<Record<SspSectionId, SspSectionReviewState>>;
  /** Every sign-off of the program, newest first (at most 200). */
  history: SspSectionReview[];
  /** A write role on a server-backed program with its sections loaded and nothing waiting to be saved. */
  canSignOff: boolean;
  /** Signs off a section as the caller. Rejects with the ApiError unchanged (its `status` and `reason`, e.g. 409 `section_changed`, which also reloads). */
  signOff: (id: SspSectionId) => Promise<{ changed: boolean }>;
  reload: () => Promise<void>;
}

/**
 * Section sign-offs (#238) of the active program, server-backed organizations only. Reloads when the saved SSP metadata or profile changes
 * (the server recomputes each section's digest from what it stored). Digests are held only to be sent back with a sign-off; never shown.
 */
export function useSspReviews(): UseSspReviews {
  const { currentTenant, activeProgram, canEdit, liveSspMetadata } = useTenant();
  const { sspMetadataEditable, sspMetadataStatus } = useAssessment();
  const profile = useSspProfile();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked) && programId !== null;

  const [sections, setSections] = useState<Partial<Record<SspSectionId, SspSectionReviewState>>>({});
  const [history, setHistory] = useState<SspSectionReview[]>([]);
  const [status, setStatus] = useState<UseSspReviews['status']>(supported ? 'loading' : 'ready');
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported || !programId) {
      setSections({});
      setHistory([]);
      setStatus('ready');
      return;
    }
    try {
      const res = await ApiClient.getSspReviews(tenantId, programId);
      if (request !== latest.current) return; // a newer request (or another program) superseded this one
      const next: Partial<Record<SspSectionId, SspSectionReviewState>> = {};
      for (const s of res.sections) next[s.sectionId as SspSectionId] = s;
      setSections(next);
      setHistory(res.history);
      setStatus('ready');
    } catch {
      if (request !== latest.current) return;
      setStatus('error');
    }
  }, [supported, tenantId, programId]);

  const metadataStamp = liveSspMetadata?.updatedAt ?? null;
  useEffect(() => {
    // Another program's reviews never show while this one loads
    setSections({});
    setHistory([]);
    setStatus(supported ? 'loading' : 'ready');
  }, [tenantId, programId, supported]);
  useEffect(() => {
    void reload();
  }, [reload, metadataStamp, profile.updatedAt]);

  const signOff = useCallback(async (id: SspSectionId): Promise<{ changed: boolean }> => {
    const digest = sections[id]?.currentDigest;
    if (!supported || !programId || !digest) throw new Error('This section cannot be signed off yet.');
    try {
      const res = await ApiClient.postSspReview(tenantId, id, digest, programId);
      setSections((prev) => ({ ...prev, [id]: res.section }));
      if (res.changed) setHistory((prev) => [res.review, ...prev].slice(0, 200));
      return { changed: res.changed };
    } catch (err: unknown) {
      if ((err as { status?: unknown } | null)?.status === 409) void reload();
      throw err;
    }
  }, [sections, supported, tenantId, programId, reload]);

  const canSignOff = canEdit && !activeProgram?.archived && supported && status === 'ready' && sspMetadataEditable && sspMetadataStatus !== 'saving'
    && profile.status === 'ready' && !profile.saving;
  return useMemo(
    () => ({ supported, status, sections, history, canSignOff, signOff, reload }),
    [supported, status, sections, history, canSignOff, signOff, reload]
  );
}
