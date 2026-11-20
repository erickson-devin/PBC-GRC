import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileDown, FilePenLine, FilePlus2, FileWarning, Link2, ListChecks, Lock, Sparkles, Unlink, XCircle } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useDocumentRegister } from '../../hooks/useDocumentRegister';
import { useProgramDocuments } from '../../hooks/useProgramDocuments';
import { useExpectedDocuments } from '../../hooks/useExpectedDocuments';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { localDateIso } from '../../data/inventory/inventoryUiView';
import { documentsInProgram } from '../../data/documents/documentRegisterView';
import { expectedStatus, hasUsableCopy, presentCounts, type ExpectedDocument, type ExpectedRow } from '../../data/documents/expectedDocuments';
import {
  EXPECTED_UI_TEXT,
  ROW_STATE_VIEW,
  catalogAsOfLine,
  controlsSummary,
  expectedCsvFileName,
  expectedRowState,
  generateAction,
  generateResultText,
  overdueLine,
  presentLine,
  recommendedLine,
  registerPrefill,
  rowFilterCounts,
  rowMatchesFilter,
  visibleSuggestions,
  type RowFilter,
} from '../../data/documents/expectedChecklistView';
import { DOCUMENT_UI_TEXT, KIND_LABELS, documentErrorMessage, reviewChip, statusChip } from '../../data/documents/documentUiView';
import { expectedDocumentsCsv } from '../../data/reports/documentRegisterCsv';
import type { DocumentInput, GovernanceDocument } from '../../types/documents';
import { ErrorNotice } from '../common/ErrorNotice';
import { downloadCsv } from '../inventory/downloadCsv';
import { DocumentDialog, type DocumentSaveOptions } from './DocumentDialog';

const CHIP = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border';
const TONE = {
  emerald: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  amber: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  rose: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
  slate: 'bg-slate-800 border-slate-700 text-slate-300',
} as const;
const STATE_ICON = { PRESENT: CheckCircle2, DRAFT_ONLY: FilePenLine, NO_COPY: FileWarning, MISSING: XCircle } as const;
const FILTERS: { value: RowFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'MISSING', label: 'Missing' },
  { value: 'NOT_READY', label: 'Not ready' },
  { value: 'PRESENT', label: 'Present' },
];

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const segment = (pressed: boolean): string =>
  `px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
    pressed ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200' : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
  }`;
const iconButton = 'p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * The expected-documents checklist (#250) for the open program: what an assessor usually expects for its framework, checked against the Document Register.
 * A suggested match is only a suggestion until a person confirms it; a generated draft is a register draft and never counts as present. Titles may be
 * CUI: notifications use fixed text and the entry names (our own catalog), and nothing is cached in browser storage or logged.
 */
export const ExpectedDocumentsPanel: React.FC = () => {
  const { currentTenant, canEdit, activeProgram, activeFramework } = useTenant();
  const { state, frameworkControls } = useAssessment();
  const headingId = useId();
  const hintBase = useId();
  const reg = useDocumentRegister();
  const prog = useProgramDocuments();
  const exp = useExpectedDocuments({ enabled: true });

  const [filter, setFilter] = useState<RowFilter>('ALL');
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [pendingUnlink, setPendingUnlink] = useState<{ expectedId: string; documentId: string } | null>(null);
  const [registerFor, setRegisterFor] = useState<{ entry: ExpectedDocument; key: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  const unlinkButtons = useRef(new Map<string, HTMLButtonElement>());
  const dialogCounter = useRef(0);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const programName = activeProgram?.name ?? '';
  const today = localDateIso(new Date());
  const writable = canEdit && prog.status === 'ready' && !prog.archived;
  const displayId = useCallback((id: string): string => cmmcDisplayId(id, activeFramework), [activeFramework]);

  const liveIds = useMemo(() => new Set(state.evidenceIndex.map((e) => e.id)), [state.evidenceIndex]);
  const programDocs = useMemo(() => documentsInProgram(reg.documents, { declared: prog.declared, documentIds: [...prog.documentIds] }), [reg.documents, prog.declared, prog.documentIds]);
  const docsById = useMemo(() => Object.fromEntries(programDocs.map((d) => [d.id, d])), [programDocs]);
  const titlesById = useMemo(() => Object.fromEntries(reg.documents.map((d) => [d.id, d.title])), [reg.documents]);
  const rows = useMemo(() => expectedStatus(exp.entries, programDocs, prog, liveIds, today), [exp.entries, programDocs, prog, liveIds, today]);
  const counts = useMemo(() => presentCounts(rows), [rows]);
  const filterCounts = useMemo(() => rowFilterCounts(rows, docsById), [rows, docsById]);
  const expectedRows = rows.filter((r) => r.entry.requirement === 'EXPECTED' && rowMatchesFilter(expectedRowState(r, docsById), filter));
  const recommendedRows = rows.filter((r) => r.entry.requirement === 'RECOMMENDED' && rowMatchesFilter(expectedRowState(r, docsById), filter));
  const programControlIds = useMemo(() => new Set(frameworkControls.map((c) => c.id)), [frameworkControls]);

  // Another organization's or program's dismissals, confirmations and messages must not carry over
  useEffect(() => {
    setFilter('ALL');
    setDismissed(new Set());
    setPendingUnlink(null);
    setRegisterFor(null);
    setBusyId(null);
    setActionError(null);
    setNotification(null);
  }, [currentTenant.id, activeProgram?.id]);
  useEffect(() => () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
  }, []);

  const showNotification = (msg: string): void => {
    setNotification(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(null), 6000);
  };

  const reloadAll = (): void => {
    exp.reload();
    void reg.reload();
    void prog.reload();
  };

  const exportCsv = (): void => {
    const fileName = expectedCsvFileName(activeFramework, today);
    downloadCsv(fileName, expectedDocumentsCsv(rows, titlesById));
    showNotification(`Exported ${rows.length} expected documents to ${fileName}.`);
  };

  // ---- Link, unlink, dismiss ----

  const confirmMatch = async (row: ExpectedRow, doc: GovernanceDocument): Promise<void> => {
    setActionError(null);
    setBusyId(row.entry.id);
    try {
      await prog.putExpectation(row.entry.id, [...row.satisfiedBy, doc.id], row.satisfiedBy);
      const next = row.present || hasUsableCopy(doc, prog, liveIds) ? 'PRESENT' : doc.status === 'DRAFT' || expectedRowState(row, docsById) === 'DRAFT_ONLY' ? 'DRAFT_ONLY' : 'NO_COPY';
      showNotification(`Linked. ${row.entry.name} now shows as ${ROW_STATE_VIEW[next].text}.`);
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, 'expectation', programName));
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = (row: ExpectedRow, docId: string): void => {
    setDismissed((s) => new Set(s).add(`${row.entry.id}:${docId}`));
    showNotification(EXPECTED_UI_TEXT.suggestionHidden);
  };

  const unlinkKey = (expectedId: string, documentId: string): string => `${expectedId}:${documentId}`;
  const cancelUnlink = (expectedId: string, documentId: string): void => {
    setPendingUnlink(null);
    setTimeout(() => unlinkButtons.current.get(unlinkKey(expectedId, documentId))?.focus(), 0);
  };

  const confirmUnlink = async (row: ExpectedRow, documentId: string): Promise<void> => {
    setActionError(null);
    setBusyId(row.entry.id);
    try {
      await prog.putExpectation(row.entry.id, row.satisfiedBy.filter((id) => id !== documentId), row.satisfiedBy);
      setPendingUnlink(null);
      showNotification('Unlinked. The document stays in the register.');
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, 'expectation', programName));
      setPendingUnlink(null);
    } finally {
      setBusyId(null);
    }
  };

  // ---- Generate a draft ----

  const generateDraft = async (entry: ExpectedDocument, row: ExpectedRow): Promise<void> => {
    const act = generateAction(entry, reg.documents, row, activeFramework);
    if (!act) return;
    setActionError(null);
    setBusyId(entry.id);
    let step: 'register' | 'expectation' = 'register';
    try {
      let id = act.kind === 'link_existing' ? act.documentId : null;
      if (act.kind === 'generate') {
        try {
          id = (await reg.create({ kind: 'POLICY', title: entry.name, origin: 'GENERATED', seedKey: act.seedKey })).id;
        } catch (err: unknown) {
          if ((err as { reason?: unknown })?.reason !== 'duplicate_seed') throw err;
          id = (err as { documentId?: string }).documentId ?? null;
        }
      }
      if (!id) return;
      step = 'expectation';
      if (prog.declared && !prog.documentIds.has(id)) await prog.patchDocuments({ add: [id] });
      await prog.putExpectation(entry.id, [...row.satisfiedBy, id], row.satisfiedBy);
      showNotification(generateResultText(act.kind === 'generate' ? 'created' : 'linked_existing'));
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, step, programName));
    } finally {
      setBusyId(null);
    }
  };

  // ---- Register a document for an entry ----

  const saveRegistered = async (entry: ExpectedDocument, input: DocumentInput & { origin?: 'AI_ASSISTED' }, opts: DocumentSaveOptions): Promise<void> => {
    setActionError(null);
    const row = rows.find((r) => r.entry.id === entry.id);
    const linked = row ? row.satisfiedBy : [];
    const created = await reg.create(input);
    let failure: string | null = null;
    if (prog.declared) {
      try {
        await prog.patchDocuments({ add: [created.id] });
      } catch (err: unknown) {
        failure = `The document was added, but adding it to ${programName} failed: ${documentErrorMessage(err, 'membership', programName)}`;
      }
    }
    if (!failure && opts.linkControlIds.length > 0) {
      try {
        await prog.putControls(created.id, opts.linkControlIds, []);
      } catch (err: unknown) {
        failure = `The document was added, but linking its controls failed: ${documentErrorMessage(err, 'links', programName)}`;
      }
    }
    if (!failure) {
      try {
        await prog.putExpectation(entry.id, [...linked, created.id], linked);
      } catch (err: unknown) {
        failure = `The document was added, but linking it to ${entry.name} failed: ${documentErrorMessage(err, 'expectation', programName)}`;
      }
    }
    if (failure) setActionError(failure);
    else showNotification(`Registered and linked. ${entry.name} shows as Draft only until a person approves the document.`);
  };

  // ---- Render ----

  const unlinkConfirm = (row: ExpectedRow, documentId: string): React.ReactNode => (
    <div
      role="group"
      aria-label="Unlink this document?"
      className="flex flex-wrap items-center gap-3 text-xs w-full"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelUnlink(row.entry.id, documentId);
        }
      }}
    >
      <span className="flex-1 min-w-[14rem] text-slate-200">{EXPECTED_UI_TEXT.unlinkConfirm}</span>
      <button type="button" disabled={busyId === row.entry.id} onClick={() => cancelUnlink(row.entry.id, documentId)} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50">Cancel</button>
      <button type="button" autoFocus disabled={busyId === row.entry.id} onClick={() => void confirmUnlink(row, documentId)} className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50">Unlink</button>
    </div>
  );

  const renderRow = (row: ExpectedRow): React.ReactNode => {
    const entry = row.entry;
    const rowState = expectedRowState(row, docsById);
    const view = ROW_STATE_VIEW[rowState];
    const Icon = STATE_ICON[rowState];
    const summary = controlsSummary(entry.controls, displayId);
    const suggestions = visibleSuggestions(row, dismissed).slice(0, 2).map((id) => docsById[id]).filter((d): d is GovernanceDocument => !!d);
    const gen = generateAction(entry, reg.documents, row, activeFramework);
    const hintId = `${hintBase}-gen-${entry.id}`;
    const busy = busyId === entry.id;
    return (
      <li key={entry.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-white">{entry.name}</span>
          <span className={`${CHIP} ${TONE.slate}`}>{KIND_LABELS[entry.kind]}</span>
          <span className={`${CHIP} ${TONE[view.tone]}`}>
            <Icon className="w-3 h-3" aria-hidden="true" />
            {view.text}
            <span className="sr-only">{`: ${view.detail}`}</span>
          </span>
        </div>
        <p className="text-slate-400">{entry.description}</p>
        <p className="font-mono text-[11px] text-slate-400">
          {summary.shown.join(', ')}
          {summary.more > 0 && <span title={entry.controls.map(displayId).join(', ')}>{` +${summary.more} more`}</span>}
        </p>
        {rowState !== 'PRESENT' && rowState !== 'MISSING' && <p className="text-amber-300">{view.detail}</p>}

        {row.satisfiedBy.length > 0 && (
          <ul aria-label={`Documents linked to ${entry.name}`} className="flex flex-wrap gap-1.5">
            {row.satisfiedBy.map((id) => {
              const doc = docsById[id];
              if (!doc) return null;
              const chip = statusChip(doc);
              const rc = reviewChip(doc, today);
              const confirming = pendingUnlink?.expectedId === entry.id && pendingUnlink.documentId === id;
              return (
                <li key={id} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] flex flex-wrap items-center gap-1.5">
                  <span className="text-white">{doc.title}</span>
                  <span className={`${CHIP} ${TONE[chip.tone]}`}>{chip.text}</span>
                  {rc && doc.reviewBy !== null && <span className={`${CHIP} ${TONE[rc.tone]}`}>{rc.text}</span>}
                  {writable && (
                    <button
                      type="button"
                      aria-label={`Unlink ${doc.title} from ${entry.name}`}
                      aria-expanded={confirming}
                      ref={(el) => {
                        if (el) unlinkButtons.current.set(unlinkKey(entry.id, id), el);
                        else unlinkButtons.current.delete(unlinkKey(entry.id, id));
                      }}
                      onClick={() => setPendingUnlink({ expectedId: entry.id, documentId: id })}
                      className={iconButton}
                    >
                      <Unlink className="w-3 h-3" aria-hidden="true" />
                    </button>
                  )}
                  {confirming && unlinkConfirm(row, id)}
                </li>
              );
            })}
          </ul>
        )}

        {suggestions.length > 0 && (
          <div className="rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 p-2.5 space-y-1.5">
            <p className="text-[11px] text-cyan-200">{EXPECTED_UI_TEXT.suggestionIntro}</p>
            {suggestions.map((doc) => {
              const chip = statusChip(doc);
              return (
                <div key={doc.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-slate-300">Suggested match:</span>
                  <span className="font-semibold text-white">{doc.title}</span>
                  <span className={`${CHIP} ${TONE.slate}`}>{KIND_LABELS[doc.kind]}</span>
                  <span className={`${CHIP} ${TONE[chip.tone]}`}>{chip.text}</span>
                  {writable && (
                    <button type="button" disabled={busy} aria-label={`Confirm ${doc.title} as ${entry.name}`} onClick={() => void confirmMatch(row, doc)} className={`${secondaryButton} !px-2.5 !py-1`}>
                      <Link2 className="w-3 h-3 text-cyan-400" aria-hidden="true" />
                      <span>Confirm</span>
                    </button>
                  )}
                  <button type="button" aria-label={`Not this one: ${doc.title}`} onClick={() => dismiss(row, doc.id)} className="text-slate-400 hover:text-white underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">
                    Not this one
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {writable && rowState !== 'PRESENT' && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} aria-haspopup="dialog" onClick={() => setRegisterFor({ entry, key: ++dialogCounter.current })} className={secondaryButton}>
              <FilePlus2 className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
              <span>Register</span>
            </button>
            {gen && (
              <>
                <button type="button" disabled={busy} aria-busy={busy || undefined} aria-describedby={hintId} onClick={() => void generateDraft(entry, row)} className={secondaryButton}>
                  <Sparkles className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
                  <span>{busy ? 'Generating…' : gen.kind === 'generate' ? 'Generate draft' : 'Link the generated draft'}</span>
                </button>
                <span id={hintId} className="text-[11px] text-slate-400 max-w-md">{EXPECTED_UI_TEXT.generateHint}</span>
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  const loading = exp.status === 'loading' || reg.status === 'loading' || prog.status === 'loading';
  const failed = exp.status === 'error' || reg.status === 'error' || prog.status === 'error';
  const ready = reg.supported && exp.status === 'ready' && reg.status === 'ready' && prog.status === 'ready';
  const overdueText = overdueLine(counts.overdue);
  const recommendedText = recommendedLine(counts);

  const registerEntry = registerFor?.entry ?? null;
  const registerRow = registerEntry ? rows.find((r) => r.entry.id === registerEntry.id) ?? null : null;
  const registerControls = registerEntry
    ? registerEntry.controls
        .filter((id) => programControlIds.has(id))
        .map((id) => ({ id, displayId: displayId(id), title: frameworkControls.find((c) => c.id === id)?.title ?? '' }))
    : [];

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex items-start gap-2.5">
        <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
          <ListChecks className="w-5 h-5" aria-hidden="true" />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="text-base font-bold text-white">{EXPECTED_UI_TEXT.title}</h2>
            {activeProgram && <span className="text-xs text-slate-400">{`${activeProgram.name} · ${frameworkLabel(activeFramework)}`}</span>}
          </div>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">{EXPECTED_UI_TEXT.intro}</p>
        </div>
      </div>

      {!reg.supported ? (
        <p role="note" className="text-xs text-slate-400">{EXPECTED_UI_TEXT.unsupported}</p>
      ) : exp.status === 'no_program' || prog.status === 'no_program' ? (
        <p className="text-xs text-slate-400">{EXPECTED_UI_TEXT.noProgram}</p>
      ) : loading ? (
        <p role="status" className="text-xs text-slate-400">{EXPECTED_UI_TEXT.loading}</p>
      ) : failed ? (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={EXPECTED_UI_TEXT.loadFailed} className="flex-1" />
          <button type="button" onClick={reloadAll} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
        </div>
      ) : exp.entries.length === 0 ? (
        <p className="text-xs text-slate-400">{EXPECTED_UI_TEXT.none}</p>
      ) : null}

      {reg.supported && !canEdit && ready && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
          <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
          <span>{EXPECTED_UI_TEXT.readOnly}</span>
        </div>
      )}
      {ready && prog.archived && (
        <div role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">{DOCUMENT_UI_TEXT.archived}</div>
      )}
      <ErrorNotice message={actionError} />
      {notification && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <span>{notification}</span>
        </div>
      )}
      <p role="status" className="sr-only">{notification ?? ''}</p>

      {ready && exp.entries.length > 0 && (
        <>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-bold text-white">{presentLine(counts)}</p>
              <button type="button" onClick={exportCsv} className={secondaryButton}>
                <FileDown className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                <span>Export CSV</span>
              </button>
            </div>
            <div
              role="progressbar"
              aria-label="Expected documents present"
              aria-valuemin={0}
              aria-valuemax={counts.total}
              aria-valuenow={counts.present}
              className="h-2 rounded-full bg-slate-800 overflow-hidden"
            >
              <div className="h-full bg-emerald-500" style={{ width: `${counts.total ? Math.round((counts.present / counts.total) * 100) : 0}%` }} />
            </div>
            {recommendedText && <p className="text-slate-400">{recommendedText}</p>}
            {overdueText && <p className="text-rose-300">{overdueText}</p>}
            <p className="text-[11px] text-slate-400">{catalogAsOfLine(exp.asOf)}</p>
            {exp.verified === false && <p role="note" className="text-[11px] text-amber-300">{EXPECTED_UI_TEXT.unverified}</p>}
            {exp.notice && <p className="text-[11px] text-slate-500">{exp.notice}</p>}
          </div>

          <div role="group" aria-label="Checklist filter" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)} className={segment(filter === f.value)}>
                {`${f.label} (${filterCounts[f.value]})`}
              </button>
            ))}
          </div>

          <div className="space-y-2 text-xs">
            <h3 className="text-sm font-bold text-white">{`Expected (${expectedRows.length})`}</h3>
            <ul className="space-y-2">{expectedRows.map(renderRow)}</ul>
          </div>
          {rows.some((r) => r.entry.requirement === 'RECOMMENDED') && (
            <div className="space-y-2 text-xs">
              <h3 className="text-sm font-bold text-white">{`Recommended (${recommendedRows.length})`}</h3>
              <p className="text-slate-400">{EXPECTED_UI_TEXT.recommendedHint}</p>
              <ul className="space-y-2">{recommendedRows.map(renderRow)}</ul>
            </div>
          )}
        </>
      )}

      {registerEntry && registerRow && activeProgram && (
        <DocumentDialog
          key={registerFor?.key}
          initial={null}
          prefill={registerPrefill(registerEntry)}
          programName={activeProgram.name}
          offerProgram={false}
          linkOffer={{ entryName: registerEntry.name, controls: registerControls }}
          primaryInProgram={false}
          canEdit={writable}
          onSave={(input, opts) => saveRegistered(registerEntry, input, opts)}
          onStatus={() => Promise.reject(new Error('unsupported'))}
          onApprove={() => undefined}
          latest={(id) => reg.documents.find((d) => d.id === id) ?? null}
          onClose={() => setRegisterFor(null)}
        />
      )}
    </section>
  );
};

export default ExpectedDocumentsPanel;
