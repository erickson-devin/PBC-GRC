import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { applicableExpected, type ExpectedDocument, type ExpectedDocumentCatalog } from '../data/documents/expectedDocuments';
import { loadExpectedDocuments } from '../data/documents/expectedDocumentsLazy';
import { programFrameworkControls, scopingToOverlays } from '../data/programScope';
import type { Program } from '../types/program';

/** 'unsupported': a browser-only organization; 'no_program': no open program; 'loading' also covers a disabled hook. */
export type ExpectedDocumentsStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error';

export interface UseExpectedDocuments {
  status: ExpectedDocumentsStatus;
  /** The catalog entries that apply to the active program (at least one of their controls is in its catalog), in catalog order. */
  entries: ExpectedDocument[];
  /** The catalog's own provenance notice, to show beside the checklist; '' until loaded. */
  notice: string;
  /** When the catalog was written (ISO date) and whether a person has verified its control mapping; null until loaded. */
  asOf: string | null;
  verified: boolean | null;
  /** Asks for the catalog again after a failed load. */
  reload: () => void;
}

const NO_ENTRIES: ExpectedDocument[] = [];

/**
 * The control ids of a program's catalog, as the server counts them when it checks an expected-document link: its framework's catalog narrowed by the
 * baseline (and the privacy baseline), with no overlay applied.
 */
export function programCatalogIdSet(program: Pick<Program, 'framework' | 'baseline'> & { privacyBaseline?: boolean }): Set<string> {
  return new Set(programFrameworkControls(program, scopingToOverlays({})).map((c) => c.id));
}

/**
 * The expected documents that apply to the active program (#250). The catalog is a separate lazy file, loaded once the checklist is wanted. React state
 * only; the catalog is static shipped data and nothing about the program leaves the browser.
 */
export function useExpectedDocuments(options?: { enabled?: boolean }): UseExpectedDocuments {
  const enabled = options?.enabled ?? true;
  const { currentTenant, activeProgram, programsStatus } = useTenant();
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const hasProgram = activeProgram !== null;
  const want = enabled && supported && hasProgram;

  const [catalog, setCatalog] = useState<ExpectedDocumentCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!want) return undefined;
    let cancelled = false;
    setFailed(false);
    loadExpectedDocuments().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [want, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const framework = activeProgram?.framework ?? null;
  const baseline = activeProgram?.baseline ?? null;
  const privacyBaseline = activeProgram?.privacyBaseline === true;
  const entries = useMemo<ExpectedDocument[]>(() => {
    if (!catalog || !framework) return NO_ENTRIES;
    return applicableExpected(catalog, framework, programCatalogIdSet({ framework, baseline, privacyBaseline }));
  }, [catalog, framework, baseline, privacyBaseline]);

  const status: ExpectedDocumentsStatus = !supported
    ? 'unsupported'
    : programsStatus === 'ready' && !hasProgram
    ? 'no_program'
    : !want
    ? 'loading'
    : failed
    ? 'error'
    : catalog
    ? 'ready'
    : 'loading';
  return useMemo<UseExpectedDocuments>(
    () => ({ status, entries, notice: catalog?._meta.notice ?? '', asOf: catalog?._meta.asOf ?? null, verified: catalog ? catalog._meta.verified : null, reload }),
    [status, entries, catalog, reload]
  );
}
