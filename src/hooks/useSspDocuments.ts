import { useCallback, useMemo } from 'react';
import { useAssessment } from '../context/AssessmentContext';
import { useDocumentRegister } from './useDocumentRegister';
import { useProgramDocuments } from './useProgramDocuments';
import { useExpectedDocuments } from './useExpectedDocuments';
import { expectedStatus, presentCounts } from '../data/documents/expectedDocuments';
import { NOT_SUPPORTED_DOCUMENTS, buildSspDocumentsCompletenessInput, buildSspDocumentsSnapshot, type SspDocumentsCompletenessInput, type SspDocumentsSnapshot } from '../data/documents/sspDocuments';
import { localDateIso } from '../data/inventory/inventoryUiView';

/** 'unsupported': a browser-only organization or no open program (1.3.2 says "not available"); 'loading' also covers a disabled hook. */
export type SspDocumentsStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseSspDocuments {
  status: SspDocumentsStatus;
  /** What the SSP prints of 1.3.2; `supported: false` until `status` is 'ready'. */
  snapshot: SspDocumentsSnapshot;
  /** For the completeness check; only when `status` is 'ready' (otherwise 1.3.2 is unavailable). */
  completenessInput: SspDocumentsCompletenessInput | undefined;
  /** Reloads the register and the program's documents. */
  reload: () => Promise<void>;
}

/**
 * The document register of the active program, read-only, as the SSP shows and checks it: the snapshot of 1.3.2 and the completeness input. Composes the
 * register, the program's documents, the expected-documents checklist (its counts only; a checklist that cannot load leaves them out, it never blocks the
 * section) and the program's evidence files. With `enabled: false` nothing is loaded. React state only.
 */
export function useSspDocuments(options?: { enabled?: boolean }): UseSspDocuments {
  const enabled = options?.enabled ?? true;
  const { state } = useAssessment();
  const register = useDocumentRegister({ enabled });
  const program = useProgramDocuments({ enabled });
  const expected = useExpectedDocuments({ enabled });

  const supported = register.supported && program.supported && program.status !== 'no_program';
  const parts = [register.status, program.status];
  const status: SspDocumentsStatus = !enabled
    ? 'loading'
    : !supported
    ? 'unsupported'
    : parts.includes('error')
    ? 'error'
    : register.status === 'ready' && program.status === 'ready' && expected.status !== 'loading'
    ? 'ready'
    : 'loading';

  const today = localDateIso(new Date());
  const evidence = useMemo(() => state.evidenceIndex.filter((e) => !e.id.includes('__inh_')).map((e) => ({ id: e.id, name: e.name })), [state.evidenceIndex]);
  const { documents } = register;
  const { documentIds, declared, controlLinks, attachments, expectations, programId } = program;
  const programDocs = useMemo(
    () => ({ programId: programId ?? '', declared, documentIds: [...documentIds], controlLinks, attachments, expectations }),
    [programId, declared, documentIds, controlLinks, attachments, expectations]
  );
  const counts = useMemo(() => {
    if (status !== 'ready' || expected.status !== 'ready') return null;
    return presentCounts(expectedStatus(expected.entries, documents, programDocs, new Set(evidence.map((e) => e.id)), today));
  }, [status, expected.status, expected.entries, documents, programDocs, evidence, today]);

  const ready = status === 'ready';
  const snapshot = useMemo(
    () => (ready ? buildSspDocumentsSnapshot({ supported: true, documents, program: programDocs, evidence, today, expected: counts }) : NOT_SUPPORTED_DOCUMENTS),
    [ready, documents, programDocs, evidence, today, counts]
  );
  const completenessInput = useMemo(() => (ready ? buildSspDocumentsCompletenessInput(snapshot) : undefined), [ready, snapshot]);

  const { reload: reloadRegister } = register;
  const { reload: reloadProgram } = program;
  const reload = useCallback(async (): Promise<void> => {
    await Promise.all([reloadRegister(), reloadProgram()]);
  }, [reloadRegister, reloadProgram]);

  return useMemo<UseSspDocuments>(() => ({ status, snapshot, completenessInput, reload }), [status, snapshot, completenessInput, reload]);
}
