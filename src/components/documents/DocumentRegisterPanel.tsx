import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpDown,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Edit2,
  Eye,
  FileDown,
  FilePenLine,
  FileWarning,
  LibraryBig,
  Lock,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useDocumentRegister, type DocumentUsage } from '../../hooks/useDocumentRegister';
import { useProgramDocuments } from '../../hooks/useProgramDocuments';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { localDateIso } from '../../data/inventory/inventoryUiView';
import { controlCountsByDocument, filterDocuments, attachmentCountsByDocument, primarySource } from '../../data/documents/documentRegisterView';
import { parseGeneratedSeed } from '../../data/documents/generatedDrafts';
import {
  DOCUMENT_UI_TEXT,
  KIND_FILTER_LABELS,
  KIND_LABELS,
  ORIGIN_BADGE,
  declareDocumentsText,
  docAriaSort,
  docCountCaption,
  docEmptyMessage,
  documentErrorMessage,
  kindCounts,
  membershipRemoveText,
  primaryCell,
  primaryLabelMap,
  registerCsvFileName,
  removeDocumentConfirmText,
  reviewChip,
  sortDocs,
  statusChip,
  statusMatches,
  summaryCounts,
  summaryLine,
  undeclaredDocumentsNote,
  type DocSortKey,
  type StatusFilter,
} from '../../data/documents/documentUiView';
import { documentRegisterCsv } from '../../data/reports/documentRegisterCsv';
import { DOCUMENT_KINDS, type DocumentInput, type DocumentKind, type GovernanceDocument, type ReviewState } from '../../types/documents';
import { ErrorNotice } from '../common/ErrorNotice';
import { downloadCsv } from '../inventory/downloadCsv';
import { DocumentDialog, type DocumentSaveOptions } from './DocumentDialog';
import { ApproveDocumentDialog, type ApproveValue } from './ApproveDocumentDialog';
import { DocumentControlsEditor } from './DocumentControlsEditor';
import { DocumentAttachmentsDialog } from './DocumentAttachmentsDialog';
import { DocumentLocation } from './DocumentLocation';
import { GeneratedDraftPreview } from './GeneratedDraftPreview';
import { takeDocumentFocus } from './documentFocus';

type SortState = { key: DocSortKey; dir: 'asc' | 'desc' };
type ProgramParts = 'unsupported' | 'no_program' | 'loading' | 'error' | 'ready';
type PendingDelete = { id: string; usage: DocumentUsage | null | 'loading' };
type PendingMembership = { id: string; kind: 'declare' | 'remove'; inUse?: { controlLinks: number; attachments?: number; expectations?: number } };

const CHIP = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border';
const TONE = {
  emerald: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  amber: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  rose: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
  slate: 'bg-slate-800 border-slate-700 text-slate-300',
} as const;

const KIND_FILTERS: (DocumentKind | 'ALL')[] = ['ALL', ...DOCUMENT_KINDS];
const REVIEW_OPTIONS: { value: ReviewState | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All review states' },
  { value: 'OVERDUE', label: 'Review overdue' },
  { value: 'DUE_SOON', label: 'Due within 30 days' },
  { value: 'CURRENT', label: 'Current' },
  { value: 'NOT_SET', label: 'No review date' },
];
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'CURRENT', label: 'Draft and approved' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'RETIRED', label: 'Retired' },
  { value: 'ALL', label: 'All, including retired' },
];

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const segment = (pressed: boolean): string =>
  `px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
    pressed ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200' : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
  }`;
const fieldClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const confirmButton = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50';
const iconButton = 'p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const countButton = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 font-mono text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The organization's Document Register (#240): plans, policies and procedures with their owner, version, approval and next review, and the open
 * program's control links, files and membership alongside. Server-backed organizations only. Titles, owners, locations and notes may be CUI:
 * notifications use fixed text, and nothing is cached in browser storage or logged.
 */
export const DocumentRegisterPanel: React.FC = () => {
  const { currentTenant, canEdit, activeProgram, programsStatus, activeFramework } = useTenant();
  const { state, frameworkControls, setPreviewEvidence, setActiveTab } = useAssessment();
  const tenantId = currentTenant.id;
  const headingId = useId();
  const baseId = useId();
  const reg = useDocumentRegister();
  const prog = useProgramDocuments();

  const [kind, setKind] = useState<DocumentKind | 'ALL'>('ALL');
  const [status, setStatus] = useState<StatusFilter>('CURRENT');
  const [review, setReview] = useState<ReviewState | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'kind', dir: 'asc' });
  const [dialog, setDialog] = useState<{ initial: GovernanceDocument | null; key: number } | null>(null);
  const [approveFor, setApproveFor] = useState<string | null>(null);
  const [linksFor, setLinksFor] = useState<string | null>(null);
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingMembership, setPendingMembership] = useState<PendingMembership | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const memberBoxes = useRef(new Map<string, HTMLInputElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogCounter = useRef(0);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const programName = activeProgram?.name ?? '';
  const today = localDateIso(new Date());
  const programParts: ProgramParts = !reg.supported
    ? 'unsupported'
    : programsStatus === 'ready' && !activeProgram
      ? 'no_program'
      : prog.status === 'ready'
        ? 'ready'
        : prog.status === 'error'
          ? 'error'
          : prog.status === 'no_program'
            ? 'no_program'
            : 'loading';
  const programReady = programParts === 'ready';
  const programWritable = canEdit && programReady && !prog.archived;
  const editorsReady = canEdit && reg.status === 'ready';
  const limitReached = reg.documents.length >= reg.limit;

  const liveIds = useMemo(() => new Set(state.evidenceIndex.map((e) => e.id)), [state.evidenceIndex]);
  const names = useMemo(() => Object.fromEntries(state.evidenceIndex.map((e) => [e.id, e.name])), [state.evidenceIndex]);
  const controlCounts = useMemo(() => controlCountsByDocument(prog.controlLinks), [prog.controlLinks]);
  const fileCounts = useMemo(() => attachmentCountsByDocument(prog.attachments), [prog.attachments]);
  const inProgram = (id: string): boolean => !prog.declared || prog.documentIds.has(id);
  const displayId = useCallback((id: string): string => cmmcDisplayId(id, activeFramework), [activeFramework]);
  const approvedCount = useMemo(() => reg.documents.filter((d) => d.status === 'APPROVED').length, [reg.documents]);
  const summary = useMemo(() => summaryCounts(reg.documents, today), [reg.documents, today]);
  const summaryText = summaryLine(summary);
  const perKind = useMemo(() => kindCounts(reg.documents, status), [reg.documents, status]);
  const statusTotal = perKind.ALL;
  const shown = useMemo(
    () => sortDocs(filterDocuments(reg.documents.filter((d) => statusMatches(d, status)), { kind, review, query }, today), sort.key, sort.dir),
    [reg.documents, status, kind, review, query, today, sort]
  );
  const latest = (id: string): GovernanceDocument | null => reg.documents.find((d) => d.id === id) ?? null;
  const approveDoc = approveFor ? latest(approveFor) : null;
  const linkedDoc = linksFor ? latest(linksFor) : null;
  const filesDoc = filesFor ? latest(filesFor) : null;
  const previewDoc = previewFor ? latest(previewFor) : null;
  const linkedControlIds = useMemo(() => prog.controlLinks.filter((l) => l.documentId === linksFor).map((l) => l.controlId), [prog.controlLinks, linksFor]);
  const hasCopyInProgram = (d: GovernanceDocument): boolean | null => {
    if (!programReady) return null;
    const src = primarySource(d, prog.attachments, liveIds);
    return src !== null && !(src.type === 'attachment' && src.missing);
  };

  // Another organization's or program's dialogs, confirmations and messages must not carry over
  useEffect(() => {
    setKind('ALL');
    setStatus('CURRENT');
    setReview('ALL');
    setQuery('');
    setSort({ key: 'kind', dir: 'asc' });
    setDialog(null);
    setApproveFor(null);
    setLinksFor(null);
    setFilesFor(null);
    setPreviewFor(null);
    setPendingDelete(null);
    setPendingMembership(null);
    setActionError(null);
    setNotification(null);
  }, [tenantId, activeProgram?.id]);
  useEffect(() => () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
  }, []);
  // The Living Policy Library asks for one document: show it with the default filters and, for a writer, open it
  useEffect(() => {
    if (reg.status !== 'ready') return;
    const id = takeDocumentFocus();
    if (!id) return;
    const doc = reg.documents.find((d) => d.id === id);
    if (!doc) return;
    setKind('ALL');
    setStatus('CURRENT');
    setReview('ALL');
    setQuery('');
    if (canEdit) setDialog({ initial: doc, key: ++dialogCounter.current });
  }, [reg.status]);
  // A document removed elsewhere closes its windows
  useEffect(() => {
    if (reg.status !== 'ready') return;
    if (linksFor && !linkedDoc) setLinksFor(null);
    if (filesFor && !filesDoc) setFilesFor(null);
    if (previewFor && !previewDoc) setPreviewFor(null);
    if (approveFor && !approveDoc) setApproveFor(null);
  }, [reg.status, linksFor, linkedDoc, filesFor, filesDoc, previewFor, previewDoc, approveFor, approveDoc]);

  const showNotification = (msg: string): void => {
    setNotification(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(null), 4000);
  };

  const exportCsv = (): void => {
    const fileName = registerCsvFileName(today);
    const primaryLabel = programReady
      ? primaryLabelMap(shown, prog.attachments, state.evidenceIndex, liveIds)
      : Object.fromEntries(shown.map((d) => [d.id, d.locationUrl ?? '']));
    downloadCsv(fileName, documentRegisterCsv(shown, { today, controlCounts: programReady ? controlCounts : {}, primaryLabel }));
    showNotification(`Exported ${shown.length} ${plural(shown.length, 'document', 'documents')} to ${fileName}.`);
  };

  const clickSort = (key: DocSortKey): void => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const openEdit = (d: GovernanceDocument): void => setDialog({ initial: d, key: ++dialogCounter.current });

  // ---- Add / edit ----

  const saveDocument = async (input: DocumentInput & { origin?: 'AI_ASSISTED' }, opts: DocumentSaveOptions): Promise<void> => {
    setActionError(null);
    const editing = dialog?.initial ?? null;
    if (editing) {
      const r = await reg.update(editing.id, input, opts.expectedUpdatedAt ?? editing.updatedAt);
      showNotification(r.approvalCleared ? 'Document saved. Its approval was withdrawn because the version, title, kind or location changed.' : 'Document saved.');
      return;
    }
    const created = await reg.create(input);
    let failure: string | null = null;
    if (opts.addToProgram) {
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
    if (failure) setActionError(failure);
    showNotification('Document added.');
  };

  const dialogStatus = async (next: 'DRAFT' | 'RETIRED'): Promise<GovernanceDocument> => {
    const id = dialog?.initial?.id;
    const cur = id ? latest(id) ?? dialog?.initial ?? null : null;
    if (!cur) throw Object.assign(new Error('gone'), { status: 404, reason: 'not_found' });
    setActionError(null);
    const updated = await reg.setStatus(cur.id, next, cur.updatedAt);
    showNotification(next === 'RETIRED' ? 'Document retired.' : cur.status === 'RETIRED' ? 'Document reinstated as a draft.' : 'Approval withdrawn.');
    return updated;
  };

  // ---- Approve ----

  const approveDocument = async (value: ApproveValue): Promise<void> => {
    if (!approveDoc) return;
    setActionError(null);
    const updated = await reg.approve(approveDoc.id, value, approveDoc.updatedAt);
    showNotification('Document approved.');
    // an open edit dialog for this document starts again from the approved version
    setDialog((d) => (d && d.initial && d.initial.id === updated.id ? { initial: updated, key: ++dialogCounter.current } : d));
  };

  // ---- Remove ----

  const openDelete = (d: GovernanceDocument): void => {
    setPendingMembership(null);
    setPendingDelete({ id: d.id, usage: 'loading' });
    reg
      .usage(d.id)
      .then((u) => setPendingDelete((p) => (p && p.id === d.id ? { id: d.id, usage: u } : p)))
      .catch(() => setPendingDelete((p) => (p && p.id === d.id ? { id: d.id, usage: null } : p)));
  };

  const cancelDelete = (id: string): void => {
    setPendingDelete(null);
    setTimeout(() => removeButtons.current.get(id)?.focus(), 0);
  };

  const confirmDelete = async (d: GovernanceDocument): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await reg.remove(d.id);
      setPendingDelete(null);
      showNotification('Document removed.');
      searchRef.current?.focus();
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, 'delete'));
      if ((err as { status?: unknown } | null)?.status === 404) setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const retireInstead = async (d: GovernanceDocument): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await reg.setStatus(d.id, 'RETIRED', d.updatedAt);
      setPendingDelete(null);
      showNotification('Document retired.');
      searchRef.current?.focus();
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, 'status'));
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  // ---- Program membership ----

  const focusMemberBox = (id: string): void => {
    setTimeout(() => memberBoxes.current.get(id)?.focus(), 0);
  };

  const toggleMembership = async (d: GovernanceDocument, checked: boolean): Promise<void> => {
    setActionError(null);
    if (!prog.declared) {
      if (checked) {
        setPendingDelete(null);
        setPendingMembership({ id: d.id, kind: 'declare' });
      }
      return;
    }
    setBusy(true);
    try {
      await prog.patchDocuments(checked ? { add: [d.id] } : { remove: [d.id] });
    } catch (err: unknown) {
      const inUse = (err as { inUse?: PendingMembership['inUse'] } | null)?.inUse;
      if ((err as { reason?: unknown } | null)?.reason === 'document_in_use' && inUse) {
        setPendingDelete(null);
        setPendingMembership({ id: d.id, kind: 'remove', inUse });
      } else {
        setActionError(documentErrorMessage(err, 'membership', programName));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmMembership = async (p: PendingMembership): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await prog.patchDocuments(p.kind === 'declare' ? { add: [p.id] } : { remove: [p.id], force: true });
      setPendingMembership(null);
      showNotification(p.kind === 'declare' ? `${programName} now declares its documents.` : 'Document removed from the program.');
      focusMemberBox(p.id);
    } catch (err: unknown) {
      setActionError(documentErrorMessage(err, 'membership', programName));
      setPendingMembership(null);
    } finally {
      setBusy(false);
    }
  };

  const cancelMembership = (p: PendingMembership): void => {
    setPendingMembership(null);
    focusMemberBox(p.id);
  };

  // ---- Render helpers ----

  const columns: string[] = ['document', 'kind', 'status', 'version', 'approved', 'reviewBy', 'owner', ...(programReady ? ['primary', 'controls', 'files', 'member'] : ['location']), ...(canEdit ? ['actions'] : [])];
  const headerLabel: Record<string, string> = {
    document: 'Document',
    kind: 'Kind',
    status: 'Status',
    version: 'Version',
    approved: 'Approved',
    reviewBy: 'Review by',
    owner: 'Owner',
    primary: `Primary copy in ${programName}`,
    controls: `Controls in ${programName}`,
    files: `Files in ${programName}`,
    member: `In ${programName}`,
    location: 'Internal location',
    actions: 'Actions',
  };
  const SORTABLE: Partial<Record<string, DocSortKey>> = { document: 'title', kind: 'kind', approved: 'approvalDate', reviewBy: 'reviewBy' };

  const confirmRow = (id: string, content: React.ReactNode): React.ReactNode => (
    <tr key={`${id}-confirm`} id={`${baseId}-confirm-${id}`} className="bg-slate-900/70">
      <td colSpan={columns.length} className="py-3 px-3">{content}</td>
    </tr>
  );

  const renderCell = (col: string, d: GovernanceDocument): React.ReactNode => {
    switch (col) {
      case 'document': {
        const chip = statusChip(d);
        const seed = d.origin === 'GENERATED' ? parseGeneratedSeed(d.seedKey) : null;
        return (
          <td key={col} className={`py-3 px-3 sticky left-0 z-10 bg-slate-950 min-w-[14rem] ${chip.untrusted ? 'border-l-2 border-dashed border-amber-500/60' : ''}`}>
            <span className="font-semibold text-white">{d.title}</span>
            {d.reference && <div className="font-mono text-[11px] text-slate-400">{d.reference}</div>}
            {(d.origin !== 'MANUAL' || seed) && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {d.origin !== 'MANUAL' && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-dashed border-amber-500/40 text-[10px] font-semibold text-amber-300">
                    <Sparkles className="w-3 h-3" aria-hidden="true" />
                    {ORIGIN_BADGE[d.origin]}
                  </span>
                )}
                {seed && (
                  <button type="button" aria-label={`Preview the generated text of ${d.title}`} onClick={() => setPreviewFor(d.id)} className={iconButton}>
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </td>
        );
      }
      case 'kind':
        return <td key={col} className="py-3 px-3 text-slate-300">{KIND_LABELS[d.kind]}</td>;
      case 'status': {
        const chip = statusChip(d);
        const Icon = d.status === 'APPROVED' ? BadgeCheck : d.status === 'RETIRED' ? Archive : chip.untrusted ? FileWarning : FilePenLine;
        return (
          <td key={col} className="py-3 px-3">
            <span className={`${CHIP} ${TONE[chip.tone]}`}>
              <Icon className="w-3 h-3" aria-hidden="true" />
              {chip.text}
            </span>
          </td>
        );
      }
      case 'version':
        return <td key={col} className="py-3 px-3 font-mono text-slate-300">{d.version || <span className="font-sans text-slate-400">Not set</span>}</td>;
      case 'approved':
        return (
          <td key={col} className="py-3 px-3 text-slate-300">
            {d.approvalDate ? (
              <>
                {d.approvalDate}
                {d.approvedBy && <div className="text-[11px] text-slate-400">{`by ${d.approvedBy}`}</div>}
              </>
            ) : (
              <><span aria-hidden="true">—</span><span className="sr-only">Not approved</span></>
            )}
          </td>
        );
      case 'reviewBy': {
        const rc = reviewChip(d, today);
        return (
          <td key={col} className="py-3 px-3 text-slate-300">
            {d.reviewBy ?? <><span aria-hidden="true">—</span><span className="sr-only">No review date</span></>}
            {rc && d.reviewBy !== null && <div className="mt-1"><span className={`${CHIP} ${TONE[rc.tone]}`}>{rc.text}</span></div>}
          </td>
        );
      }
      case 'owner':
        return <td key={col} className="py-3 px-3 text-slate-300">{d.owner || <span className="text-slate-400">Not recorded</span>}</td>;
      case 'primary': {
        const src = primarySource(d, prog.attachments, liveIds);
        const cell = primaryCell(src, names);
        const item = src && src.type === 'attachment' ? state.evidenceIndex.find((e) => e.id === src.evidenceId) : undefined;
        return (
          <td key={col} className="py-3 px-3">
            {cell.kind === 'file' && item ? (
              <button type="button" aria-label={`Open ${cell.text}`} onClick={() => setPreviewEvidence(item)} className="text-cyan-300 hover:text-cyan-200 underline text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">
                {cell.text}
              </button>
            ) : cell.kind === 'removed' ? (
              <span className={`${CHIP} ${TONE.amber}`}>{cell.text}</span>
            ) : cell.kind === 'location' ? (
              <DocumentLocation value={cell.text} compact />
            ) : (
              <span className="text-slate-400">{cell.text}</span>
            )}
          </td>
        );
      }
      case 'location':
        return <td key={col} className="py-3 px-3">{d.locationUrl ? <DocumentLocation value={d.locationUrl} compact /> : <><span aria-hidden="true">—</span><span className="sr-only">No internal location</span></>}</td>;
      case 'controls': {
        const n = controlCounts[d.id] ?? 0;
        return (
          <td key={col} className="py-3 px-3">
            <button
              type="button"
              onClick={() => setLinksFor(d.id)}
              data-links-for={d.id}
              aria-label={`${n} ${plural(n, 'control', 'controls')} linked in ${programName} for ${d.title}; open the links`}
              className={countButton}
            >
              {n}
            </button>
          </td>
        );
      }
      case 'files': {
        const n = fileCounts[d.id] ?? 0;
        return (
          <td key={col} className="py-3 px-3">
            <button
              type="button"
              onClick={() => setFilesFor(d.id)}
              data-files-for={d.id}
              aria-label={`${n} ${plural(n, 'file', 'files')} for ${d.title} in ${programName}; open`}
              className={countButton}
            >
              <Paperclip className="w-3 h-3" aria-hidden="true" />
              {n}
            </button>
          </td>
        );
      }
      case 'member':
        return (
          <td key={col} className="py-3 px-3">
            {programWritable ? (
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) memberBoxes.current.set(d.id, el);
                    else memberBoxes.current.delete(d.id);
                  }}
                  checked={prog.declared && prog.documentIds.has(d.id)}
                  disabled={busy}
                  onChange={(e) => void toggleMembership(d, e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
                />
                <span>In this program<span className="sr-only"> ({d.title})</span></span>
              </label>
            ) : (
              <span className="text-slate-300">{!prog.declared ? 'Whole register' : inProgram(d.id) ? 'In this program' : 'Not in this program'}</span>
            )}
          </td>
        );
      case 'actions':
        return (
          <td key={col} className="py-3 px-3 text-right">
            <div className="inline-flex items-center gap-1">
              <button type="button" disabled={!editorsReady} aria-label={`Edit ${d.title}`} onClick={() => openEdit(d)} className={iconButton}>
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              {d.status === 'DRAFT' && (
                <button type="button" disabled={!editorsReady} aria-label={`Approve ${d.title}`} aria-haspopup="dialog" onClick={() => setApproveFor(d.id)} className={`${secondaryButton} !px-2 !py-1`}>
                  <BadgeCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>Approve</span>
                </button>
              )}
              <button
                type="button"
                disabled={!editorsReady}
                aria-label={`Remove ${d.title}`}
                aria-expanded={pendingDelete?.id === d.id}
                aria-controls={pendingDelete?.id === d.id ? `${baseId}-confirm-${d.id}` : undefined}
                ref={(el) => {
                  if (el) removeButtons.current.set(d.id, el);
                  else removeButtons.current.delete(d.id);
                }}
                onClick={() => openDelete(d)}
                className={`${iconButton} hover:!text-rose-300`}
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </td>
        );
      default:
        return null;
    }
  };

  const membershipConfirm = (p: PendingMembership): React.ReactNode => (
    <div
      role="group"
      aria-label={p.kind === 'declare' ? 'Declare the documents?' : 'Take this document out of the program?'}
      className="flex flex-wrap items-center gap-3 text-xs"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelMembership(p);
        }
      }}
    >
      <span className="flex-1 min-w-[16rem] text-slate-200">
        {p.kind === 'declare' ? declareDocumentsText(programName, approvedCount, 1) : membershipRemoveText(programName, p.inUse ?? { controlLinks: 0 })}
      </span>
      <button type="button" autoFocus disabled={busy} onClick={() => void confirmMembership(p)} className="btn-primary px-3 py-1 rounded-lg text-xs disabled:opacity-50">
        {p.kind === 'declare' ? 'Declare and add' : 'Remove from program'}
      </button>
      <button type="button" disabled={busy} onClick={() => cancelMembership(p)} className={confirmButton}>Cancel</button>
    </div>
  );

  const partsMessage = programParts === 'no_program' ? DOCUMENT_UI_TEXT.noProgram : programParts === 'loading' ? DOCUMENT_UI_TEXT.programLoading : null;
  const reviewChipButton = (pressed: boolean, tone: keyof typeof TONE, onClick: () => void, text: string, icon: React.ReactNode): React.ReactNode => (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={`${CHIP} ${TONE[tone]} focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500`}>
      {icon}
      {text}
    </button>
  );

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
            <LibraryBig className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id={headingId} className="text-base font-bold text-white">{DOCUMENT_UI_TEXT.title}</h2>
              {reg.supported && (
                <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-300">
                  {reg.documents.filter((d) => d.status !== 'RETIRED').length}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">{DOCUMENT_UI_TEXT.intro}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" disabled={shown.length === 0 || reg.status !== 'ready'} onClick={exportCsv} title="Exports the documents currently shown" className={secondaryButton}>
            <FileDown className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>{`Export CSV (${shown.length})`}</span>
          </button>
          {canEdit && reg.supported && (
            <button
              type="button"
              disabled={!editorsReady || limitReached}
              onClick={() => setDialog({ initial: null, key: ++dialogCounter.current })}
              className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add document</span>
            </button>
          )}
        </div>
      </div>

      {!reg.supported ? (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <span>{`${DOCUMENT_UI_TEXT.unsupported}${canEdit ? DOCUMENT_UI_TEXT.unsupportedMoveHint : ''}${DOCUMENT_UI_TEXT.unsupportedTail}`}</span>
        </div>
      ) : (
        <>
          {!canEdit && (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <span>{DOCUMENT_UI_TEXT.readOnly}</span>
            </div>
          )}

          <ErrorNotice message={actionError} />
          {reg.status === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={DOCUMENT_UI_TEXT.loadFailed} className="flex-1" />
              <button type="button" onClick={() => void reg.reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
            </div>
          )}
          {partsMessage && <p className="text-xs text-slate-400">{partsMessage}</p>}
          {programParts === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={DOCUMENT_UI_TEXT.programFailed} className="flex-1" />
              <button type="button" onClick={() => void prog.reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
            </div>
          )}
          {programReady && prog.archived && (
            <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <span>{DOCUMENT_UI_TEXT.archived}</span>
            </div>
          )}

          {notification && (
            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{notification}</span>
            </div>
          )}
          <p role="status" className="sr-only">{notification ?? ''}</p>

          {programReady && !prog.declared && activeProgram && (
            <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <p>
                {undeclaredDocumentsNote(activeProgram.name, approvedCount)}
                {canEdit ? DOCUMENT_UI_TEXT.undeclaredEditor : DOCUMENT_UI_TEXT.undeclaredReader}
              </p>
            </div>
          )}

          {reg.status === 'ready' && summaryText && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {summary.overdue > 0 &&
                reviewChipButton(review === 'OVERDUE', 'rose', () => setReview(review === 'OVERDUE' ? 'ALL' : 'OVERDUE'), `${summary.overdue} review overdue`, <CalendarClock className="w-3 h-3" aria-hidden="true" />)}
              {summary.dueSoon > 0 &&
                reviewChipButton(review === 'DUE_SOON', 'amber', () => setReview(review === 'DUE_SOON' ? 'ALL' : 'DUE_SOON'), `${summary.dueSoon} due within 30 days`, <CalendarClock className="w-3 h-3" aria-hidden="true" />)}
              {summary.needsReview > 0 &&
                reviewChipButton(
                  status === 'DRAFT',
                  'amber',
                  () => setStatus(status === 'DRAFT' ? 'CURRENT' : 'DRAFT'),
                  `${summary.needsReview} generated or AI-assisted ${plural(summary.needsReview, 'draft needs', 'drafts need')} review`,
                  <FileWarning className="w-3 h-3" aria-hidden="true" />
                )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
            <div role="group" aria-label="Kind filter" className="flex flex-wrap gap-2">
              {KIND_FILTERS.map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={segment(kind === k)}>
                  {`${KIND_FILTER_LABELS[k]} (${perKind[k]})`}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search documents"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title, reference or owner…"
                className={`${fieldClass} w-full pl-9 pr-3`}
              />
            </div>
            <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={fieldClass}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select aria-label="Review filter" value={review} onChange={(e) => setReview(e.target.value as ReviewState | 'ALL')} className={fieldClass}>
              {REVIEW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <p className="text-xs text-slate-400" aria-live="polite">{reg.status === 'loading' ? '' : docCountCaption(shown.length, statusTotal)}</p>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table aria-busy={reg.status === 'loading' || busy || undefined} className="table w-full min-w-[72rem] text-left text-xs border-collapse">
              <caption className="sr-only">Document register</caption>
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                  {columns.map((col) => {
                    const key = SORTABLE[col];
                    return (
                      <th
                        key={col}
                        scope="col"
                        aria-sort={key ? docAriaSort(key, sort.key, sort.dir) : undefined}
                        className={`py-2.5 px-3 ${col === 'document' ? 'sticky left-0 z-10 bg-slate-900' : ''} ${col === 'actions' ? 'text-right' : ''}`}
                      >
                        {key ? (
                          <button type="button" onClick={() => clickSort(key)} className="inline-flex items-center gap-1 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">
                            {headerLabel[col]}
                            <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                          </button>
                        ) : (
                          headerLabel[col]
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {reg.status === 'loading' ? (
                  <tr>
                    <td colSpan={columns.length} className="py-8 text-center text-slate-400" role="status">{DOCUMENT_UI_TEXT.loading}</td>
                  </tr>
                ) : shown.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="py-8 text-center text-slate-400">
                      <p>{docEmptyMessage({ total: reg.documents.length, canEdit })}</p>
                      {reg.status === 'ready' && reg.documents.length === 0 && canEdit && (
                        <button type="button" onClick={() => setActiveTab('policies')} className={`${secondaryButton} mx-auto mt-3`}>Open the Living Policy Library</button>
                      )}
                    </td>
                  </tr>
                ) : (
                  shown.map((d) => (
                    <React.Fragment key={d.id}>
                      <tr className="hover:bg-slate-800/40 transition-colors">{columns.map((col) => renderCell(col, d))}</tr>
                      {pendingMembership?.id === d.id && confirmRow(d.id, membershipConfirm(pendingMembership))}
                      {pendingDelete?.id === d.id &&
                        confirmRow(
                          d.id,
                          <div
                            role="group"
                            aria-label="Remove this document?"
                            className="flex flex-wrap items-center gap-3 text-xs"
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.stopPropagation();
                                cancelDelete(d.id);
                              }
                            }}
                          >
                            {pendingDelete.usage === 'loading' ? (
                              <p role="status" className="flex-1 min-w-[16rem] text-slate-300">Checking where this document is used…</p>
                            ) : (
                              <p className="flex-1 min-w-[16rem] text-slate-200">{removeDocumentConfirmText(pendingDelete.usage)}</p>
                            )}
                            <button type="button" disabled={busy} onClick={() => cancelDelete(d.id)} className={confirmButton}>Cancel</button>
                            {d.status !== 'RETIRED' && (
                              <button type="button" disabled={busy} onClick={() => void retireInstead(d)} className={`${secondaryButton} !px-2.5 !py-1`}>Retire instead</button>
                            )}
                            <button
                              type="button"
                              autoFocus
                              disabled={busy || pendingDelete.usage === 'loading'}
                              onClick={() => void confirmDelete(d)}
                              className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50"
                            >
                              Remove document
                            </button>
                          </div>
                        )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {dialog && (
        <DocumentDialog
          key={dialog.key}
          initial={dialog.initial}
          programName={activeProgram?.name ?? null}
          offerProgram={programWritable && prog.declared}
          primaryInProgram={dialog.initial ? hasCopyInProgram(dialog.initial) === true : false}
          canEdit={editorsReady}
          onSave={saveDocument}
          onStatus={dialogStatus}
          onApprove={() => dialog.initial && setApproveFor(dialog.initial.id)}
          latest={latest}
          onClose={() => setDialog(null)}
        />
      )}
      {approveDoc && (
        <ApproveDocumentDialog
          doc={approveDoc}
          programName={activeProgram?.name ?? null}
          hasPrimaryInProgram={hasCopyInProgram(approveDoc)}
          stacked={dialog !== null}
          onApprove={approveDocument}
          onClose={() => setApproveFor(null)}
        />
      )}
      {linksFor && linkedDoc && activeProgram && programReady && (
        <DocumentControlsEditor
          doc={linkedDoc}
          programName={activeProgram.name}
          framework={activeFramework}
          controls={frameworkControls}
          displayId={displayId}
          controlIds={linkedControlIds}
          blocked={prog.declared && !prog.documentIds.has(linkedDoc.id)}
          canEdit={programWritable}
          archived={prog.archived}
          onAddToProgram={() => prog.patchDocuments({ add: [linkedDoc.id] })}
          onSave={async (ids, expected) => {
            const saved = await prog.putControls(linkedDoc.id, ids, expected);
            showNotification('Control links saved.');
            return saved;
          }}
          onClose={() => {
            const id = linkedDoc.id;
            setLinksFor(null);
            setTimeout(() => document.querySelector<HTMLElement>(`[data-links-for="${id}"]`)?.focus(), 0);
          }}
        />
      )}
      {filesFor && filesDoc && activeProgram && programReady && (
        <DocumentAttachmentsDialog
          doc={filesDoc}
          programName={activeProgram.name}
          framework={activeFramework}
          attachments={prog.attachments}
          controlLinks={prog.controlLinks}
          canEdit={programWritable}
          archived={prog.archived}
          displayId={displayId}
          onLink={async (evidenceId, primary) => {
            await prog.linkAttachment(filesDoc.id, evidenceId, primary);
          }}
          onSetPrimary={(evidenceId) => prog.setPrimary(filesDoc.id, evidenceId, true)}
          onUnlink={(evidenceId) => prog.unlinkAttachment(filesDoc.id, evidenceId)}
          onClose={() => {
            const id = filesDoc.id;
            setFilesFor(null);
            setTimeout(() => document.querySelector<HTMLElement>(`[data-files-for="${id}"]`)?.focus(), 0);
          }}
        />
      )}
      {previewFor && previewDoc && <GeneratedDraftPreview doc={previewDoc} onClose={() => setPreviewFor(null)} />}
    </section>
  );
};

export default DocumentRegisterPanel;
