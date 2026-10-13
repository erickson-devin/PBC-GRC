import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { ApiClient } from '../../services/apiClient';
import { getFrameworkControls } from '../../data/frameworks';
import { canRoleReviewSspImports } from '../../utils/roles';
import { errorMessage } from '../../utils/errors';
import {
  SSP_JOB_TERMINAL,
  type SspCapabilities,
  type SspCommitOutcome,
  type SspImportFramework,
  type SspImportJob,
  type SspJobStatus,
  type SspMatchKind,
  type SspReviewState,
  type StagedControlView,
} from '../../types/sspImport';

/**
 * SSP import: upload a System Security Plan (PDF / Word), see which controls it describes, and review each suggestion next
 * to the control's current answer. Nothing here changes a control until a Tenant Owner / MSP Admin commits the suggestions
 * they accepted. Assessors can read everything but cannot accept, edit or commit.
 */

const STATUS_LABEL: Record<SspJobStatus, string> = {
  QUEUED: 'Queued',
  EXTRACTING: 'Reading the document',
  ANALYZING: 'Mapping to controls',
  READY_FOR_REVIEW: 'Ready for review',
  COMMITTED: 'Committed',
  FAILED: 'Failed',
};

const STATE_LABEL: Record<SspReviewState, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  EDITED: 'Edited',
  REJECTED: 'Rejected',
  COMMITTED: 'Committed',
  CONFLICT: 'Conflict',
};

const STATE_CLASS: Record<SspReviewState, string> = {
  PENDING: 'bg-slate-800 text-slate-300 border-slate-700',
  ACCEPTED: 'bg-emerald-950/50 text-emerald-300 border-emerald-800/60',
  EDITED: 'bg-cyan-950/50 text-cyan-300 border-cyan-800/60',
  REJECTED: 'bg-slate-900 text-slate-400 border-slate-700',
  COMMITTED: 'bg-brand-950/50 text-brand-300 border-brand-800/60',
  CONFLICT: 'bg-rose-950/50 text-rose-300 border-rose-800/60',
};

const MATCH_HELP: Record<SspMatchKind, string> = {
  CMMC_ID_SECTION: 'A section of the document is headed by this control’s CMMC identifier.',
  NIST_NUMBER_SECTION: 'A section starts with this control’s NIST SP 800-171 number. Check that it is not just the document’s own numbering.',
  MENTION: 'The control is only referred to inside another section; the document has no section describing it.',
};

type Filter = 'all' | 'pending' | 'accepted' | 'rejected' | 'attention';
type Tab = 'suggestions' | 'missing' | 'unmapped';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Accepted / edited' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'attention', label: 'Needs attention' },
];

const CONTROL_TITLES: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const fw of ['CMMC_L2', 'CMMC_L1'] as const) for (const c of getFrameworkControls(fw)) m.set(c.id, c.title);
  return m;
})();

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '');
const isTerminal = (s: SspJobStatus): boolean => SSP_JOB_TERMINAL.includes(s);

const StateBadge: React.FC<{ state: SspReviewState }> = ({ state }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
);

export const SspImportView: React.FC = () => {
  const { currentTenant, currentRole } = useTenant();
  const tenantId = currentTenant.id;
  const ids = { framework: useId(), file: useId(), filter: useId(), notes: useId() };

  const [caps, setCaps] = useState<SspCapabilities | null>(null);
  const [jobs, setJobs] = useState<SspImportJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ job: SspImportJob; staged: StagedControlView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [framework, setFramework] = useState<SspImportFramework>('CMMC_L1');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('suggestions');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [outcome, setOutcome] = useState<SspCommitOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const canView = canRoleReviewSspImports(currentRole);
  const canWrite = Boolean(caps?.canUpload);

  // ---- loading
  const loadJobs = useCallback(async () => {
    try {
      setJobs(await ApiClient.sspListJobs(tenantId));
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not load the imports.');
    }
  }, [tenantId]);

  const loadDetail = useCallback(
    async (jobId: string) => {
      try {
        const d = await ApiClient.sspGetStaged(tenantId, jobId);
        setDetail(d);
        setSelectedId((prev) => (prev && d.staged.some((s) => s.id === prev) ? prev : d.staged[0]?.id ?? null));
      } catch (err: unknown) {
        setError(errorMessage(err) || 'Could not load the import.');
      }
    },
    [tenantId]
  );

  useEffect(() => {
    setDetail(null);
    setSelectedJobId(null);
    setOutcome(null);
    if (!canView) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [c, j] = await Promise.all([ApiClient.sspCapabilities(tenantId), ApiClient.sspListJobs(tenantId)]);
        if (cancelled) return;
        setCaps(c);
        setJobs(j);
        if (c.frameworks.length > 0) setFramework((prev) => (c.frameworks.includes(prev) ? prev : c.frameworks[0]));
        if (j[0]) setSelectedJobId(j[0].id);
      } catch (err: unknown) {
        if (!cancelled) setError(errorMessage(err) || 'Could not load SSP imports.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, canView]);

  useEffect(() => {
    if (selectedJobId) void loadDetail(selectedJobId);
  }, [selectedJobId, loadDetail]);

  // Follow a job that is still being processed
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? detail?.job ?? null;
  const processing = jobs.some((j) => !isTerminal(j.status));
  useEffect(() => {
    if (!processing) return undefined;
    const t = window.setInterval(() => {
      void loadJobs();
      if (selectedJobId && selectedJob && !isTerminal(selectedJob.status)) void loadDetail(selectedJobId);
    }, 1500);
    return () => window.clearInterval(t);
  }, [processing, selectedJobId, selectedJob, loadJobs, loadDetail]);

  // ---- actions
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setOutcome(null);
    setUploading(true);
    try {
      const job = await ApiClient.sspUpload(tenantId, file, framework);
      await loadJobs();
      setSelectedJobId(job.id);
      setTab('suggestions');
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The upload failed.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const staged = detail?.staged ?? [];
  const current = staged.find((s) => s.id === selectedId) ?? null;
  const open = detail?.job.status === 'READY_FOR_REVIEW';

  const decide = async (item: StagedControlView, state: SspReviewState) => {
    if (!detail) return;
    setBusyId(item.id);
    setError(null);
    try {
      const notes = drafts[item.id];
      const updated = await ApiClient.sspReview(tenantId, detail.job.id, item.id, {
        reviewState: state,
        ...(state === 'ACCEPTED' || state === 'EDITED' ? { editedNotes: notes ?? item.editedNotes ?? item.suggestedNotes } : {}),
      });
      setDetail((d) => (d ? { ...d, staged: d.staged.map((s) => (s.id === item.id ? { ...s, ...updated } : s)) } : d));
      setDrafts((d) => {
        const next = { ...d };
        delete next[item.id];
        return next;
      });
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not save the decision.');
    } finally {
      setBusyId(null);
    }
  };

  const toCommit = staged.filter((s) => s.reviewState === 'ACCEPTED' || s.reviewState === 'EDITED');
  const commit = async () => {
    if (!detail) return;
    setCommitting(true);
    setError(null);
    try {
      const result = await ApiClient.sspCommit(tenantId, detail.job.id);
      setOutcome(result);
      setConfirmCommit(false);
      await Promise.all([loadJobs(), loadDetail(detail.job.id)]);
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The commit failed.');
      await loadDetail(detail.job.id);
    } finally {
      setCommitting(false);
    }
  };

  const remove = async (jobId: string) => {
    setError(null);
    try {
      await ApiClient.sspDelete(tenantId, jobId);
      setConfirmDelete(null);
      if (selectedJobId === jobId) {
        setSelectedJobId(null);
        setDetail(null);
      }
      await loadJobs();
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not delete the import.');
    }
  };

  const download = async (job: SspImportJob) => {
    try {
      const url = await ApiClient.sspDownloadUrl(tenantId, job.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = job.fileName;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not download the document.');
    }
  };

  const visible = useMemo(
    () =>
      staged.filter((s) => {
        if (filter === 'pending') return s.reviewState === 'PENDING';
        if (filter === 'accepted') return s.reviewState === 'ACCEPTED' || s.reviewState === 'EDITED' || s.reviewState === 'COMMITTED';
        if (filter === 'rejected') return s.reviewState === 'REJECTED';
        if (filter === 'attention') return s.reviewState === 'CONFLICT' || s.changedSinceStaged || s.gapAnalysis.gaps.length > 0;
        return true;
      }),
    [staged, filter]
  );

  const counts = useMemo(() => {
    const c: Record<SspReviewState, number> = { PENDING: 0, ACCEPTED: 0, EDITED: 0, REJECTED: 0, COMMITTED: 0, CONFLICT: 0 };
    for (const s of staged) c[s.reviewState]++;
    return c;
  }, [staged]);

  // ---- render
  if (!canView) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        <h2 className="text-lg font-bold text-white mb-2">SSP Import</h2>
        Your role cannot see SSP imports. Ask a Tenant Owner for access.
      </section>
    );
  }

  return (
    <section aria-labelledby="ssp-import-heading" className="space-y-5">
      <header>
        <h2 id="ssp-import-heading" className="text-xl font-bold text-white flex items-center gap-2">
          <FileUp className="w-5 h-5 text-brand-400" aria-hidden="true" /> SSP Import
        </h2>
        <p className="text-sm text-slate-400 mt-1 max-w-3xl">
          Upload an existing System Security Plan to see which controls it describes. Suggestions are held here for review: <strong className="text-slate-200">nothing changes in your controls until suggestions you accepted are committed.</strong>{' '}
          Matching is rule-based (it looks for control identifiers); it does not judge whether a practice is met.
        </p>
      </header>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-sm">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="btn-base btn-ghost px-2 py-0.5 text-xs">Dismiss</button>
        </div>
      )}

      {caps && !canWrite && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm" role="note">
          You can review imports, but only a Tenant Owner or MSP Admin can upload, accept, edit or commit suggestions.
        </div>
      )}

      {/* Upload */}
      {canWrite && caps && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
          <h3 className="text-sm font-bold text-white mb-3">Import a document</h3>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <label htmlFor={ids.framework} className="block text-xs font-semibold text-slate-300 mb-1.5">Map it to</label>
              <select id={ids.framework} value={framework} onChange={(e) => setFramework(e.target.value as SspImportFramework)} className="px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-xl text-white focus-visible:ring-2 focus-visible:ring-brand-400/60">
                {caps.frameworks.map((f) => (
                  <option key={f} value={f}>{f === 'CMMC_L1' ? 'CMMC Level 1' : 'CMMC Level 2'}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor={ids.file} className="block text-xs font-semibold text-slate-300 mb-1.5">PDF or Word (.docx), up to {Math.round(caps.maxUploadBytes / 1024 / 1024)} MB</label>
              <input
                ref={fileInput}
                id={ids.file}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={uploading || caps.frameworks.length === 0}
                onChange={(e) => void upload(e.target.files?.[0])}
                className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-500"
              />
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2" aria-live="polite">
            {uploading ? 'Uploading…' : 'The original is kept in the evidence vault under policies/uploaded. Scanned documents (images of text) cannot be read yet.'}
          </p>
        </div>
      )}

      {loading ? (
        <p role="status" className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-5">
          {/* Jobs */}
          <nav aria-label="Imports" className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Imports</h3>
            {jobs.length === 0 && <p className="text-sm text-slate-400">No documents imported yet.</p>}
            <ul className="flex gap-2 overflow-x-auto pb-1">
              {jobs.map((j) => (
                <li key={j.id} className="min-w-[15rem] max-w-[18rem] shrink-0">
                  <button
                    type="button"
                    onClick={() => { setSelectedJobId(j.id); setTab('suggestions'); setOutcome(null); setConfirmCommit(false); }}
                    aria-current={j.id === selectedJobId ? 'true' : undefined}
                    className={`w-full text-left rounded-xl border p-3 transition-colors ${j.id === selectedJobId ? 'border-brand-500/60 bg-brand-950/30' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'}`}
                  >
                    <span className="block text-sm font-semibold text-white truncate">{j.fileName}</span>
                    <span className="block text-xs text-slate-400 mt-0.5">
                      {j.framework === 'CMMC_L1' ? 'Level 1' : 'Level 2'} · {formatDate(j.createdAt)}
                    </span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-xs">
                      {!isTerminal(j.status) && <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-cyan-400" aria-hidden="true" />}
                      {j.status === 'FAILED' && <XCircle className="w-3 h-3 text-rose-400" aria-hidden="true" />}
                      {j.status === 'COMMITTED' && <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />}
                      <span className="text-slate-300">{STATUS_LABEL[j.status]}</span>
                      {j.coverage && <span className="text-slate-500">· {j.coverage.foundControls}/{j.coverage.totalControls} found</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Review */}
          <div className="min-w-0 space-y-4">
            {!detail && !selectedJob && <p className="text-sm text-slate-400">Select an import to review it.</p>}

            {detail && (
              <>
                <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{detail.job.fileName}</p>
                    <p className="text-xs text-slate-400">
                      Uploaded by {detail.job.createdBy} · SHA-256 <span className="font-mono">{detail.job.fileSha256.slice(0, 12)}…</span>
                      {detail.job.pageCount ? ` · ${detail.job.pageCount} pages` : ''} · {detail.job.analyzer} (rule-based)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void download(detail.job)} className="btn-base btn-secondary px-3 py-1.5 text-xs"><Download className="w-3.5 h-3.5" aria-hidden="true" /> Original</button>
                    {canWrite && (confirmDelete === detail.job.id ? (
                      <>
                        <button type="button" onClick={() => void remove(detail.job.id)} className="btn-base btn-danger px-3 py-1.5 text-xs">Delete import and document</button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="btn-base btn-ghost px-3 py-1.5 text-xs">Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(detail.job.id)} disabled={!isTerminal(detail.job.status)} className="btn-base btn-ghost px-3 py-1.5 text-xs"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete</button>
                    ))}
                  </div>
                </div>

                {!isTerminal(detail.job.status) && (
                  <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-cyan-300">
                    <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> {STATUS_LABEL[detail.job.status]}…
                  </p>
                )}
                {detail.job.status === 'FAILED' && (
                  <div role="alert" className="p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-sm">
                    <strong>This document could not be imported.</strong> {detail.job.error}
                  </div>
                )}

                {outcome && (
                  <div role="status" className={`p-3 rounded-xl border text-sm ${outcome.conflicts.length ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-emerald-950/40 border-emerald-800/50 text-emerald-200'}`}>
                    Committed {outcome.committed.length} control{outcome.committed.length === 1 ? '' : 's'}.
                    {outcome.conflicts.length > 0 && ` ${outcome.conflicts.length} not committed because the control changed after the suggestion was made (see Conflict): review it again against the current answer.`}
                  </div>
                )}

                {detail.job.coverage && (
                  <>
                    <div className="flex flex-wrap gap-2 text-xs" aria-label="Summary">
                      {(['PENDING', 'ACCEPTED', 'EDITED', 'REJECTED', 'CONFLICT', 'COMMITTED'] as SspReviewState[]).map((s) => (
                        <span key={s} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1 text-slate-300">
                          <StateBadge state={s} /> {counts[s]}
                        </span>
                      ))}
                    </div>

                    <div role="tablist" aria-label="Import results" className="flex gap-1 border-b border-slate-800">
                      {([
                        ['suggestions', `Suggestions (${staged.length})`],
                        ['missing', `Not found in the document (${detail.job.coverage.missing.length})`],
                        ['unmapped', `Other references (${detail.job.unmapped.length})`],
                      ] as Array<[Tab, string]>).map(([id, label]) => (
                        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === id ? 'border-brand-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
                          {label}
                        </button>
                      ))}
                    </div>

                    {tab === 'missing' && (
                      <div role="tabpanel" className="text-sm text-slate-300 space-y-2">
                        <p>{detail.job.coverage.missing.length === 0 ? 'The document mentions every control in scope.' : 'The document never mentions these controls. They may need to be written up, or the document may use different identifiers.'}</p>
                        <ul className="grid gap-1 sm:grid-cols-2">
                          {detail.job.coverage.missing.map((id) => (
                            <li key={id} className="rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1.5"><span className="font-mono text-cyan-300">{id}</span> <span className="text-slate-400">{CONTROL_TITLES.get(id)}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {tab === 'unmapped' && (
                      <div role="tabpanel" className="text-sm text-slate-300 space-y-2">
                        <p>{detail.job.unmapped.length === 0 ? 'No other control references were found.' : 'References to controls that are not part of this import. They are listed for your information and are never staged.'}</p>
                        <ul className="space-y-1.5">
                          {detail.job.unmapped.map((u) => (
                            <li key={u.reference} className="rounded-lg bg-slate-900 border border-slate-800 px-3 py-2">
                              <span className="font-mono text-cyan-300">{u.reference}</span>{' '}
                              <span className="text-xs text-slate-400">{u.reason === 'OUT_OF_SCOPE' ? 'belongs to another level than the one you mapped to' : 'is not a CMMC practice'}{u.page ? ` · page ${u.page}` : ''}</span>
                              <p className="text-xs text-slate-400 mt-1">&ldquo;{u.excerpt}&rdquo;</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {tab === 'suggestions' && (
                      <div role="tabpanel" className="space-y-4">
                        <div className="flex items-center gap-2">
                          <label htmlFor={ids.filter} className="text-xs font-semibold text-slate-300">Show</label>
                          <select id={ids.filter} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="px-2.5 py-1.5 text-sm bg-slate-900 border border-slate-700 rounded-lg text-white">
                            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                          </select>
                          <span className="text-xs text-slate-500">{visible.length} of {staged.length}</span>
                        </div>

                        {staged.length === 0 ? (
                          <p className="text-sm text-slate-400">No control identifiers were found in this document, so there is nothing to review.</p>
                        ) : (
                          <div className="grid gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
                            <ul aria-label="Suggestions" className="space-y-1.5 max-h-[34rem] overflow-y-auto pr-1">
                              {visible.map((s) => (
                                <li key={s.id}>
                                  <button type="button" onClick={() => setSelectedId(s.id)} aria-current={s.id === selectedId ? 'true' : undefined} className={`w-full text-left rounded-lg border px-3 py-2 ${s.id === selectedId ? 'border-brand-500/60 bg-brand-950/30' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'}`}>
                                    <span className="flex items-center justify-between gap-2">
                                      <span className="font-mono text-sm text-cyan-300">{s.controlId}</span>
                                      <StateBadge state={s.reviewState} />
                                    </span>
                                    <span className="block text-xs text-slate-400 truncate">{CONTROL_TITLES.get(s.controlId)}</span>
                                    <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                      {Math.round(s.confidence * 100)}% match
                                      {(s.changedSinceStaged || s.reviewState === 'CONFLICT') && <AlertTriangle className="w-3 h-3 text-amber-400" aria-label="The control changed since this was staged" />}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>

                            {current && (
                              <article aria-label={`Suggestion for ${current.controlId}`} className="min-w-0 space-y-3">
                                <div>
                                  <h4 className="text-base font-bold text-white"><span className="font-mono text-cyan-300">{current.controlId}</span> {CONTROL_TITLES.get(current.controlId)}</h4>
                                  <p className="text-xs text-slate-400 mt-0.5">{MATCH_HELP[current.matchKind]}</p>
                                </div>

                                {(current.reviewState === 'CONFLICT' || current.changedSinceStaged) && current.reviewState !== 'COMMITTED' && (
                                  <p role="note" className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm">
                                    <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                                    This control&rsquo;s answer is not what it was when the suggestion was made. It will not be overwritten: if you commit, this suggestion is held back as a conflict. Reset it to Pending to review it against the current answer.
                                  </p>
                                )}

                                <div className="grid gap-3 lg:grid-cols-2">
                                  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                                    <h5 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">Current in the app</h5>
                                    {current.current ? (
                                      <>
                                        <p className="text-xs text-slate-400 mb-1.5">Status: <span className="font-semibold text-slate-200">{current.current.status.replace(/_/g, ' ')}</span></p>
                                        <p className="whitespace-pre-wrap text-sm text-slate-200">{current.current.notes || <span className="text-slate-500">No implementation notes yet.</span>}</p>
                                      </>
                                    ) : (
                                      <p className="text-sm text-slate-500">No answer recorded yet.</p>
                                    )}
                                  </div>
                                  <div className="rounded-xl border border-brand-800/50 bg-brand-950/20 p-3">
                                    <label htmlFor={ids.notes} className="block text-xs font-bold uppercase tracking-wider text-brand-300 mb-1.5">Suggested from the document</label>
                                    <textarea
                                      id={ids.notes}
                                      rows={9}
                                      readOnly={!canWrite || !open || current.reviewState === 'COMMITTED'}
                                      value={drafts[current.id] ?? current.editedNotes ?? current.suggestedNotes}
                                      onChange={(e) => setDrafts((d) => ({ ...d, [current.id]: e.target.value }))}
                                      className="w-full text-sm bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-100 focus-visible:ring-2 focus-visible:ring-brand-400/60"
                                    />
                                    {canWrite && open && current.reviewState !== 'COMMITTED' && (
                                      <div className="flex flex-wrap gap-2 mt-2">
                                        <button type="button" disabled={busyId === current.id} onClick={() => void decide(current, 'ACCEPTED')} className="btn-base btn-success px-3 py-1.5 text-xs">Accept{(drafts[current.id] ?? current.suggestedNotes) !== current.suggestedNotes ? ' with my edits' : ''}</button>
                                        <button type="button" disabled={busyId === current.id} onClick={() => void decide(current, 'REJECTED')} className="btn-base btn-secondary px-3 py-1.5 text-xs">Reject</button>
                                        <button type="button" disabled={busyId === current.id || current.reviewState === 'PENDING'} onClick={() => void decide(current, 'PENDING')} className="btn-base btn-ghost px-3 py-1.5 text-xs"><RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset to pending</button>
                                      </div>
                                    )}
                                    <p className="text-xs text-slate-400 mt-2">Accepting changes the implementation notes only, never the status: the document is not evidence that the practice is met.</p>
                                  </div>
                                </div>

                                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                                  <h5 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">Automated checks <span className="normal-case font-normal text-slate-500">(simple text checks, not an assessment)</span></h5>
                                  <p className="text-sm text-slate-300">{current.gapAnalysis.summary}</p>
                                  {current.gapAnalysis.gaps.length > 0 && (
                                    <ul className="mt-2 space-y-1.5">
                                      {current.gapAnalysis.gaps.map((g, i) => (
                                        <li key={i} className="text-sm text-slate-200"><span className={`text-xs font-bold mr-1.5 ${g.severity === 'HIGH' ? 'text-rose-300' : g.severity === 'MEDIUM' ? 'text-amber-300' : 'text-slate-400'}`}>{g.severity}</span><strong>{g.missingElement}.</strong> <span className="text-slate-300">{g.recommendation}</span></li>
                                      ))}
                                    </ul>
                                  )}
                                </div>

                                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                                  <h5 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">Where it came from</h5>
                                  <ul className="space-y-1.5">
                                    {current.sourceQuotes.map((q, i) => (
                                      <li key={i} className="text-xs text-slate-300">
                                        <span className="text-slate-500">{q.page ? `Page ${q.page}` : 'Document'}{q.verified ? ' · verbatim' : ''}:</span> <q className="italic">{q.quote.replace(/\s+/g, ' ')}</q>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </article>
                            )}
                          </div>
                        )}

                        {canWrite && open && staged.length > 0 && (
                          <div className="sticky bottom-2 rounded-xl border border-slate-700 bg-slate-950/95 backdrop-blur p-3 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm text-slate-300" aria-live="polite">{toCommit.length} accepted suggestion{toCommit.length === 1 ? '' : 's'} ready to commit</p>
                            {confirmCommit ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-amber-200">This replaces the implementation notes of {toCommit.length} control{toCommit.length === 1 ? '' : 's'}.</span>
                                <button type="button" disabled={committing} onClick={() => void commit()} className="btn-base btn-primary px-3 py-1.5 text-xs">{committing ? 'Committing…' : 'Confirm commit'}</button>
                                <button type="button" onClick={() => setConfirmCommit(false)} className="btn-base btn-ghost px-3 py-1.5 text-xs">Cancel</button>
                              </div>
                            ) : (
                              <button type="button" disabled={toCommit.length === 0} onClick={() => setConfirmCommit(true)} className="btn-base btn-primary px-3 py-1.5 text-xs">Commit {toCommit.length} to controls…</button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
