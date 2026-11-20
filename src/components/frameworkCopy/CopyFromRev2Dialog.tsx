import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Loader2, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useProgram } from '../../hooks/useProgram';
import { ApiClient } from '../../services/apiClient';
import { notifyInventoryChanged } from '../../services/inventoryService';
import { notifyDocumentsChanged } from '../../services/documentService';
import type { FrameworkCopyPreview, FrameworkCopySummary } from '../../types/frameworkCopy';
import {
  DEFAULT_INCLUDE,
  INCLUDE_COPY,
  INCLUDE_KEYS,
  TOO_LARGE_TEXT,
  confirmButtonLabel,
  confirmLines,
  copyErrorView,
  copyTotals,
  eligibleSources,
  filterPreviewRows,
  includeValid,
  previewAnnouncement,
  rowsShownText,
  summaryHeadline,
  type CopyInclude,
  type CopyIncludeKey,
} from '../../data/frameworkCopy/copyView';
import { CopyPreviewLists, CopyPreviewTable, CopySummaryView } from './CopyPreviewTable';

type Step = 'source' | 'preview' | 'confirm' | 'summary';
type Busy = null | 'preview' | 'commit';

const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: '1 Source' },
  { id: 'preview', label: '2 Preview' },
  { id: 'confirm', label: '3 Confirm' },
  { id: 'summary', label: '4 Summary' },
];
const inputClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const primaryButton = 'btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed';
const headingClass = 'text-sm font-semibold text-white focus:outline-none';

interface CopyFromRev2DialogProps {
  onClose: () => void;
  /** Called once a copy has been made (the matrix reads the suggestions and the copy history again). */
  onCopied: () => void;
}

/** "Copy from Rev. 2" (#255): choose a CMMC program, preview what would be appended to each Rev. 3 control, confirm, read the summary. Nothing here shows notes, narratives or file names. */
export const CopyFromRev2Dialog: React.FC<CopyFromRev2DialogProps> = ({ onClose, onCopied }) => {
  const { currentTenant, activeProgram, refreshLiveData } = useTenant();
  const { programs, programsStatus, refreshPrograms } = useProgram();
  const { notesNotSaved } = useAssessment();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;

  const [step, setStep] = useState<Step>('source');
  const [sourceId, setSourceId] = useState('');
  const [include, setInclude] = useState<CopyInclude>(DEFAULT_INCLUDE);
  const [plan, setPlan] = useState<FrameworkCopyPreview | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ReturnType<typeof copyErrorView> | null>(null);
  const [onlyWithCopy, setOnlyWithCopy] = useState(true);
  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState<FrameworkCopySummary | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const mounted = useRef(true);
  const seq = useRef(0);
  const openedOn = useRef(`${tenantId}|${programId}`);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const stepHeadingId = useId();
  const sourceFieldId = useId();
  const includeHintId = useId();
  const fieldIds = useId();

  const sources = useMemo(
    () => eligibleSources(programs, programId, currentTenant.enabledFrameworks ?? []),
    [programs, programId, currentTenant.enabledFrameworks]
  );
  const effectiveSource = sources.some((s) => s.id === sourceId) ? sourceId : (sources[0]?.id ?? '');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Another organization or program: the dialog (and anything it has previewed) is closed
  useEffect(() => {
    // compared with the ids the dialog opened on (not a "first run" flag: React's development double-run of effects would close it at once)
    if (openedOn.current === `${tenantId}|${programId}`) return;
    seq.current += 1;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, programId]);

  // The step heading takes focus on every step change; the confirmation and the summary focus their button instead
  useEffect(() => {
    if (step === 'confirm' || step === 'summary') return;
    const raf = requestAnimationFrame(() => stepHeadingRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [step]);

  // After "The chosen program no longer exists": the list of programs is read again
  useEffect(() => {
    if (error?.action === 'refresh_programs') void refreshPrograms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  if (!activeProgram) return null;

  const requestClose = (): void => {
    if (step === 'confirm') { setStep('preview'); setError(null); return; }
    onClose();
  };
  const rows = plan ? filterPreviewRows(plan.items, { onlyWithCopy, query, include }) : [];
  const totals = plan ? copyTotals(plan.items, include) : null;
  const tooLarge = Boolean(plan?.totals.tooLarge) && include.evidence;
  const unsaved = Object.keys(notesNotSaved).length;

  const changeSource = (id: string): void => { setSourceId(id); setPlan(null); setError(null); };
  const toggleInclude = (k: CopyIncludeKey, on: boolean): void => { setInclude((i) => ({ ...i, [k]: on })); setPlan(null); setError(null); };

  const runPreview = async (include2: CopyInclude = include): Promise<void> => {
    if (!effectiveSource || !includeValid(include2) || busy) return;
    const request = ++seq.current;
    setBusy('preview');
    setError(null);
    try {
      const next = await ApiClient.previewFrameworkCopy(tenantId, { sourceProgramId: effectiveSource, include: include2 }, activeProgram.id);
      if (!mounted.current || request !== seq.current) return;
      setPlan(next);
      setQuery('');
      setStep('preview');
      setAnnouncement(previewAnnouncement(copyTotals(next.items, include2), next.items.length));
    } catch (err: unknown) {
      if (!mounted.current || request !== seq.current) return;
      setError(copyErrorView(err, 'preview'));
    } finally {
      if (mounted.current && request === seq.current) setBusy(null);
    }
  };

  const runCommit = async (): Promise<void> => {
    if (!plan || busy) return;
    const request = ++seq.current;
    setBusy('commit');
    setError(null);
    try {
      const result = await ApiClient.commitFrameworkCopy(tenantId, { sourceProgramId: effectiveSource, include, planDigest: plan.planDigest }, activeProgram.id);
      if (!mounted.current || request !== seq.current) return;
      await refreshLiveData().catch(() => undefined);
      notifyInventoryChanged(tenantId, 'program', activeProgram.id);
      notifyDocumentsChanged(tenantId, 'program', activeProgram.id);
      onCopied();
      if (!mounted.current) return;
      setSummary(result.summary);
      setStep('summary');
      setAnnouncement(summaryHeadline(result.summary));
    } catch (err: unknown) {
      if (!mounted.current || request !== seq.current) return;
      setError(copyErrorView(err, 'commit'));
    } finally {
      if (mounted.current && request === seq.current) setBusy(null);
    }
  };

  const errorAction = (): React.ReactNode => {
    if (!error) return null;
    const btn = (label: string, onClick: () => void) => (
      <button type="button" onClick={onClick} disabled={busy !== null} className={secondaryButton}>{label}</button>
    );
    switch (error.action) {
      case 'preview_again': return btn('Preview again', () => void runPreview());
      case 'clear_evidence': return btn('Clear Evidence files and preview again', () => { const next = { ...include, evidence: false }; setInclude(next); setPlan(null); void runPreview(next); });
      case 'retry': return btn('Try again', () => void (step === 'confirm' ? runCommit() : runPreview()));
      default: return null;
    }
  };

  return (
    <DialogOverlay onClose={busy ? undefined : requestClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={busy ? undefined : requestClose} />
      <div className="relative w-full max-w-5xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[90vh] overflow-y-auto" aria-busy={busy !== null}>
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <ArrowLeftRight className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">Copy from Rev. 2</DialogTitle>
              <p className="text-xs text-slate-400 mt-0.5">{`Into "${activeProgram.name}" (NIST SP 800-171 Rev. 3). Copied content is appended for review; nothing is overwritten.`}</p>
            </div>
          </div>
          <button type="button" onClick={requestClose} disabled={busy !== null} aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <ol aria-label="Copy steps" className="flex flex-wrap gap-2 text-[11px] font-semibold">
          {STEPS.map((s) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined}
              className={`px-2 py-0.5 rounded-full border ${s.id === step ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200' : 'border-slate-700 text-slate-400'}`}>
              {s.label}
            </li>
          ))}
        </ol>

        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
        <ErrorNotice message={error?.message} />
        {error && errorAction() && <div className="flex">{errorAction()}</div>}

        {step === 'source' && (
          <form onSubmit={(e) => { e.preventDefault(); void runPreview(); }} className="space-y-4">
            <h3 ref={stepHeadingRef} tabIndex={-1} className={headingClass}>Choose what to copy</h3>
            {programsStatus === 'loading' && (
              <p role="status" className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading programs…
              </p>
            )}
            {programsStatus === 'error' && programs.length === 0 && (
              <div className="space-y-2">
                <ErrorNotice message="The programs could not be loaded." />
                <button type="button" onClick={() => void refreshPrograms()} className={secondaryButton}>Try again</button>
              </div>
            )}
            {sources.length === 0 && programsStatus !== 'loading' && (
              <p className="rounded-xl border border-dashed border-slate-700 p-3 text-xs text-slate-400">
                This organization has no CMMC Level 2 or Level 1 program to copy from. Rev. 2 work lives in a CMMC program: create or restore one on the Programs page.
              </p>
            )}
            <div>
              <label htmlFor={sourceFieldId} className="block text-xs font-medium text-slate-300 mb-1">Copy from</label>
              <select id={sourceFieldId} value={effectiveSource} onChange={(e) => changeSource(e.target.value)} disabled={sources.length === 0} className={`${inputClass} w-full`}>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <fieldset className="space-y-2 rounded-xl border border-slate-800 p-3">
              <legend className="px-1 text-xs font-medium text-slate-300">What to copy</legend>
              {INCLUDE_KEYS.map((k) => (
                <div key={k} className="flex items-start gap-2 text-xs">
                  <input type="checkbox" id={`${fieldIds}-${k}`} checked={include[k]} onChange={(e) => toggleInclude(k, e.target.checked)}
                    aria-describedby={`${fieldIds}-${k}-hint${includeValid(include) ? '' : ` ${includeHintId}`}`} className="mt-0.5 accent-cyan-500" />
                  <label htmlFor={`${fieldIds}-${k}`} className="text-slate-200">
                    <span className="font-semibold">{INCLUDE_COPY[k].label}</span>
                    <span id={`${fieldIds}-${k}-hint`} className="block text-slate-400">{INCLUDE_COPY[k].hint}</span>
                  </label>
                </div>
              ))}
            </fieldset>
            {!includeValid(include) && <p id={includeHintId} className="text-xs text-amber-300">Choose at least one thing to copy.</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button type="button" onClick={onClose} disabled={busy !== null} className={secondaryButton}>Cancel</button>
              <button type="submit" className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50" disabled={!effectiveSource || !includeValid(include) || busy !== null}>
                {busy === 'preview' ? 'Making the preview…' : 'Preview'}
              </button>
            </div>
          </form>
        )}

        {step === 'preview' && plan && totals && (
          <div className="space-y-3">
            <h3 ref={stepHeadingRef} tabIndex={-1} className={headingClass}>Preview</h3>
            <p className="text-xs text-slate-300">
              {`From "${plan.source.name}" · ${INCLUDE_KEYS.filter((k) => include[k]).map((k) => INCLUDE_COPY[k].label).join(', ')}`}{' '}
              <button type="button" onClick={() => { setStep('source'); setError(null); }} className="font-semibold text-cyan-300 underline underline-offset-2">Change</button>
            </p>
            {tooLarge && <ErrorNotice message={TOO_LARGE_TEXT} />}
            {tooLarge && (
              <button type="button" disabled={busy !== null} className={secondaryButton}
                onClick={() => { const next = { ...include, evidence: false }; setInclude(next); setPlan(null); void runPreview(next); }}>
                Clear Evidence files and preview again
              </button>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-xs">
                <input type="checkbox" id={`${fieldIds}-only`} checked={onlyWithCopy} onChange={(e) => setOnlyWithCopy(e.target.checked)} className="accent-cyan-500" />
                <label htmlFor={`${fieldIds}-only`} className="text-slate-200">Only controls with something to copy</label>
              </div>
              <input type="search" aria-label="Find a control" placeholder="Find by Rev. 3 or Rev. 2 ID…" value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputClass} w-64`} />
              <p aria-live="polite" className="text-xs text-slate-400">{rowsShownText(rows.length, plan.items.length)}</p>
            </div>
            <CopyPreviewTable rows={rows} include={include} />
            <CopyPreviewLists plan={plan} />
            {totals.controls === 0 && <p className="text-xs text-slate-400">Nothing new to copy with these settings.</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button type="button" onClick={() => { setStep('source'); setError(null); }} disabled={busy !== null} className={secondaryButton}>Back</button>
              <button type="button" onClick={() => { setStep('confirm'); setError(null); }} disabled={totals.controls === 0 || tooLarge || busy !== null} className={primaryButton}>Continue</button>
            </div>
          </div>
        )}

        {step === 'confirm' && plan && totals && (
          <div role="group" aria-labelledby={stepHeadingId} className="space-y-3 text-xs text-slate-300">
            <h3 id={stepHeadingId} className={headingClass}>Confirm the copy</h3>
            {confirmLines({ totals, include, targetName: activeProgram.name, sourceName: plan.source.name }).map((l, i) => <p key={i}>{l}</p>)}
            {unsaved > 0 && (
              <p className="rounded-xl border border-amber-800/40 bg-amber-950/30 px-3 py-2 text-amber-200">
                {`${unsaved} ${unsaved === 1 ? 'control has' : 'controls have'} notes that are not saved yet. Save or retry them first.`}
              </p>
            )}
            {busy === 'commit' && <p role="status" className="text-xs text-slate-400">Copying. Evidence files are copied one at a time; this can take a few minutes.</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button type="button" onClick={() => { setStep('preview'); setError(null); }} disabled={busy !== null} className={secondaryButton}>Back to preview</button>
              <button type="button" autoFocus onClick={() => void runCommit()} disabled={busy !== null || unsaved > 0 || totals.controls === 0} className={primaryButton}>
                {busy === 'commit' ? <><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Copying…</> : confirmButtonLabel(totals.controls)}
              </button>
            </div>
          </div>
        )}

        {step === 'summary' && summary && (
          <div className="space-y-3">
            <h3 ref={stepHeadingRef} tabIndex={-1} className={headingClass}>{summaryHeadline(summary)}</h3>
            <CopySummaryView summary={summary} />
            <p className="text-xs text-slate-300">
              Review the copied text in each control: it is marked &quot;Copied from NIST SP 800-171 Rev. 2 … review against Rev. 3&quot;. Suggested statuses from Rev. 2 now show on the controls. Nothing was set.
            </p>
            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button type="button" autoFocus onClick={onClose} className={primaryButton}>Done</button>
            </div>
          </div>
        )}
      </div>
    </DialogOverlay>
  );
};
