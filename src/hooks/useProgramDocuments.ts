import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { notifyDocumentsChanged, subscribeDocuments } from '../services/documentService';
import type { DocumentAttachment, ProgramDocuments } from '../types/documents';

/**
 * 'unsupported': a tenant stored only in this browser (no programs); 'no_program': the organization has no open program, so there is
 * nothing to show; 'loading' also covers a disabled hook.
 */
export type ProgramDocumentsStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error';

export interface UseProgramDocuments {
  supported: boolean;
  status: ProgramDocumentsStatus;
  programId: string | null;
  /** True for an archived program: the server refuses every write (409 `program_archived`). */
  archived: boolean;
  /** False while the program names no document: every register document then applies to it. */
  declared: boolean;
  documentIds: ReadonlySet<string>;
  controlLinks: ProgramDocuments['controlLinks'];
  attachments: DocumentAttachment[];
  expectations: ProgramDocuments['expectations'];
  reload: () => Promise<void>;
  /** Every mutator rejects with the ApiError unchanged (a 409 `document_in_use` carries `inUse`); after a 404 or 409 the state has been reloaded first. */
  patchDocuments: (change: { add?: string[]; remove?: string[]; force?: boolean }) => Promise<void>;
  /** Replaces the document's control links in this program; `expectedControlIds` is the set the caller last saw. Resolves to the ids now stored. */
  putControls: (documentId: string, controlIds: string[], expectedControlIds: string[]) => Promise<string[]>;
  /** Attaches an evidence file of this program (never uploads one); `primary` makes it the primary copy. */
  linkAttachment: (documentId: string, evidenceId: string, primary: boolean) => Promise<{ changed: boolean }>;
  setPrimary: (documentId: string, evidenceId: string, primary: boolean) => Promise<void>;
  /** Removes the link only, never the evidence file. */
  unlinkAttachment: (documentId: string, evidenceId: string) => Promise<void>;
  /** Replaces the documents a person says satisfy an expected document; `expectedDocumentIds` is the set the caller last saw. Resolves to the ids now stored. */
  putExpectation: (expectedId: string, documentIds: string[], expectedDocumentIds: string[]) => Promise<string[]>;
}

interface Loaded {
  scope: string;
  program: ProgramDocuments;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const NO_LINKS: ProgramDocuments['controlLinks'] = [];
const NO_ATTACHMENTS: DocumentAttachment[] = [];
const NO_EXPECTATIONS: ProgramDocuments['expectations'] = [];

const scopeOf = (tenantId: string, programId: string): string => `${tenantId}::${programId}`;

const isOutOfDate = (err: unknown): boolean => {
  const status = ((err ?? {}) as { status?: unknown }).status;
  return status === 404 || status === 409;
};

/**
 * The active program's side of the document register: its declared set (none declared means every register document), the controls each document is
 * linked to, its attachments (evidence ids of this program) and the expected-document links. Server-backed tenants only. Held in React state only.
 * On a program switch the state is cleared at once, then reloaded, so another program's links never show; it also reloads when the register changes
 * (a deleted document leaves every program).
 */
export function useProgramDocuments(options?: { enabled?: boolean }): UseProgramDocuments {
  const enabled = options?.enabled ?? true;
  const { currentTenant, activeProgram, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const programId = activeProgram?.id ?? null;
  const scope = supported && programId ? scopeOf(tenantId, programId) : null;
  const active = enabled && scope !== null;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('programDocuments'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active || !scope || !programId) return;
    try {
      const program = await ApiClient.getProgramDocuments(tenantId, programId);
      if (request !== latest.current) return; // a newer request (or another program) superseded this one
      setLoaded({ scope, program });
      setFailedFor(null);
    } catch {
      if (request !== latest.current) return;
      setFailedFor(scope);
    }
  }, [active, scope, tenantId, programId]);

  useEffect(() => {
    void reload();
    if (!active) return undefined;
    return subscribeDocuments((c) => {
      if (c.tenantId !== tenantId || c.origin === origin.current) return;
      const sameProgram = c.programId === null || c.programId === programId;
      if (c.kind === 'documents' || (c.kind === 'program' && sameProgram)) void reload();
    });
  }, [active, tenantId, programId, reload]);

  const change = useCallback(
    async <T>(run: (id: string) => Promise<T>): Promise<T> => {
      if (!active || !programId) throw new Error('No program is active.');
      let result: T;
      try {
        result = await run(programId);
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
      await reload();
      notifyDocumentsChanged(tenantId, 'program', programId, origin.current);
      return result;
    },
    [active, programId, tenantId, reload]
  );

  const patchDocuments = useCallback(
    async (delta: { add?: string[]; remove?: string[]; force?: boolean }): Promise<void> => {
      if (!delta.add?.length && !delta.remove?.length) return;
      await change((id) => ApiClient.patchProgramDocuments(tenantId, delta, id));
    },
    [change, tenantId]
  );
  const putControls = useCallback(
    async (documentId: string, controlIds: string[], expectedControlIds: string[]): Promise<string[]> => {
      const res = await change((id) => ApiClient.putDocumentControls(tenantId, documentId, controlIds, expectedControlIds, id));
      return res.controlIds;
    },
    [change, tenantId]
  );
  const linkAttachment = useCallback(
    async (documentId: string, evidenceId: string, primary: boolean): Promise<{ changed: boolean }> => {
      const res = await change((id) => ApiClient.linkDocumentAttachment(tenantId, documentId, { evidenceId, primary }, id));
      return { changed: res.changed };
    },
    [change, tenantId]
  );
  const setPrimary = useCallback(
    async (documentId: string, evidenceId: string, primary: boolean): Promise<void> => {
      await change((id) => ApiClient.setDocumentAttachmentPrimary(tenantId, documentId, evidenceId, primary, id));
    },
    [change, tenantId]
  );
  const unlinkAttachment = useCallback(
    async (documentId: string, evidenceId: string): Promise<void> => {
      await change((id) => ApiClient.unlinkDocumentAttachment(tenantId, documentId, evidenceId, id));
    },
    [change, tenantId]
  );
  const putExpectation = useCallback(
    async (expectedId: string, documentIds: string[], expectedDocumentIds: string[]): Promise<string[]> => {
      const res = await change((id) => ApiClient.putDocumentExpectation(tenantId, expectedId, documentIds, expectedDocumentIds, id));
      return res.documentIds;
    },
    [change, tenantId]
  );

  // Another program's (or organization's) links never show while this one loads
  const mine = loaded && scope !== null && loaded.scope === scope ? loaded.program : null;
  const documentIds = useMemo<ReadonlySet<string>>(() => (mine ? new Set(mine.documentIds) : EMPTY_SET), [mine]);
  const status: ProgramDocumentsStatus = !supported
    ? 'unsupported'
    : programsStatus === 'ready' && !activeProgram
    ? 'no_program'
    : !active
    ? 'loading'
    : failedFor === scope
    ? 'error'
    : mine
    ? 'ready'
    : 'loading';
  const archived = activeProgram?.archived === true;
  return useMemo<UseProgramDocuments>(
    () => ({
      supported,
      status,
      programId,
      archived,
      declared: mine?.declared ?? false,
      documentIds,
      controlLinks: mine?.controlLinks ?? NO_LINKS,
      attachments: mine?.attachments ?? NO_ATTACHMENTS,
      expectations: mine?.expectations ?? NO_EXPECTATIONS,
      reload,
      patchDocuments,
      putControls,
      linkAttachment,
      setPrimary,
      unlinkAttachment,
      putExpectation,
    }),
    [supported, status, programId, archived, mine, documentIds, reload, patchDocuments, putControls, linkAttachment, setPrimary, unlinkAttachment, putExpectation]
  );
}
