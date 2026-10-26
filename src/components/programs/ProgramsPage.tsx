import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Layers, Plus, Check, Pencil, Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight, Loader2, Server } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { ProgramFormModal } from './ProgramFormModal';
import { useTenant } from '../../context/TenantContext';
import { useProgram } from '../../hooks/useProgram';
import { ApiClient } from '../../services/apiClient';
import { frameworkLabel } from '../../data/programs';
import type { Program, ProgramMetrics } from '../../types/program';
import { errorMessage } from '../../utils/errors';

/** The server's refusals for archive / restore / delete, in plain language (its own message is used for anything else). */
const ACTION_MESSAGES: Record<string, string> = {
  program_is_default: 'The default program cannot be archived or deleted.',
  program_not_empty: 'This program still holds evidence files, SSP imports or POA&M items. Deleting it would orphan them, so the server refuses. Keep it archived instead.',
  program_not_found: 'This program no longer exists. The list has been refreshed.',
  program_archived: 'An archived program cannot be edited. Restore it first.',
  program_limit: 'This organization has reached the maximum number of programs. Archive and delete one that is no longer needed first.',
};

function actionError(err: unknown, fallback: string): string {
  const code = (err as { reason?: unknown; code?: unknown } | null) ?? {};
  const key = typeof code.reason === 'string' ? code.reason : typeof code.code === 'string' ? code.code : '';
  return ACTION_MESSAGES[key] ?? (errorMessage(err) || fallback);
}

const baselineChip = (program: Pick<Program, 'baseline'>) =>
  program.baseline ? `${program.baseline.charAt(0)}${program.baseline.slice(1).toLowerCase()} baseline` : null;

const badgeClass = 'inline-flex items-center shrink-0 rounded-full px-2.5 py-0.5 text-xs font-mono tracking-tight leading-none whitespace-nowrap font-medium';
const NEUTRAL_BADGE = `${badgeClass} bg-slate-800/60 text-slate-300 border border-slate-700/50`;
const STATUS_BADGE = `${badgeClass} bg-cyan-950/40 text-cyan-400 border border-cyan-800/40`;
const ACCENT_BADGE = `${badgeClass} bg-purple-950/40 text-purple-300 border border-purple-800/40`;
const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON = `${buttonClass} bg-slate-800/60 text-slate-200 border-slate-700 hover:bg-slate-800 hover:text-white`;
const PRIMARY_BUTTON = `${buttonClass} bg-brand-600 text-white border-brand-500/40 hover:bg-brand-500 shadow-lg shadow-brand-500/25`;
const DANGER_BUTTON = `${buttonClass} bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50`;

type MetricsState = ProgramMetrics | 'loading' | 'error';

/**
 * Counts for every program card, read one program at a time. A failed read leaves that card at "—"; nothing is requested after
 * the page is left or the tenant or the list of programs changes.
 */
function useProgramMetrics(tenantId: string, enabled: boolean, programIds: string[]): Record<string, MetricsState> {
  const [metrics, setMetrics] = useState<Record<string, MetricsState>>({});
  const key = programIds.join('|');
  useEffect(() => {
    if (!enabled || programIds.length === 0) {
      setMetrics({});
      return;
    }
    let cancelled = false;
    setMetrics(Object.fromEntries(programIds.map((id) => [id, 'loading' as const])));
    (async () => {
      for (const id of programIds) {
        let next: MetricsState;
        try {
          next = await ApiClient.getProgramMetrics(tenantId, id);
        } catch {
          next = 'error';
        }
        if (cancelled) return;
        setMetrics((prev) => ({ ...prev, [id]: next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // programIds is the list `key` was made from
  }, [tenantId, enabled, key]);
  return metrics;
}

const count = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : '—');

const MetricsRow: React.FC<{ state: MetricsState | undefined }> = ({ state }) => {
  const m = state && typeof state === 'object' ? state : null;
  const coverage = m && m.documented !== null && m.total !== null ? `${m.documented} / ${m.total}` : '—';
  return (
    <dl className="grid grid-cols-3 gap-2" aria-busy={state === 'loading'}>
      <div className="rounded-xl bg-slate-950/50 border border-slate-800 px-3 py-2">
        <dt className="text-xs text-slate-400">Documented</dt>
        <dd className="text-sm font-bold text-white font-mono">{coverage}</dd>
      </div>
      <div className="rounded-xl bg-slate-950/50 border border-slate-800 px-3 py-2">
        <dt className="text-xs text-slate-400">Open POA&amp;M</dt>
        <dd className="text-sm font-bold text-white font-mono">{count(m?.openPoam)}</dd>
      </div>
      <div className="rounded-xl bg-slate-950/50 border border-slate-800 px-3 py-2">
        <dt className="text-xs text-slate-400">Evidence files</dt>
        <dd className="text-sm font-bold text-white font-mono">{count(m?.evidenceCount)}</dd>
      </div>
    </dl>
  );
};

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  /** Disables the confirm button (a refusal, or a name not typed yet). */
  confirmDisabled?: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

/** A confirmation before an archive or a delete: an alertdialog that stays open while the request is in flight. */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ title, confirmLabel, danger, busy, confirmDisabled, error, onConfirm, onCancel, children }) => (
  <DialogOverlay
    role="alertdialog"
    onClose={busy ? undefined : onCancel}
    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
  >
    <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
      <DialogTitle as="h3" className="text-sm font-bold text-white">{title}</DialogTitle>
      <div className="space-y-3 text-xs text-slate-300 leading-relaxed">{children}</div>
      <ErrorNotice message={error} />
      <div className="flex items-center justify-end gap-2.5 pt-1">
        <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={busy || confirmDisabled} className={danger ? DANGER_BUTTON : PRIMARY_BUTTON}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </div>
  </DialogOverlay>
);

type Pending = { kind: 'archive' | 'delete'; program: Program };

/**
 * The programs page (#programs): every program (authorization boundary) of the organization as a card, with its framework,
 * baseline, coverage, open POA&M and evidence counts, and the actions the person may take. Create, edit, archive, restore and
 * delete are for the tenant owner and MSP administrators; everyone else reads. Archived programs are kept in a collapsed list.
 * Programs live on the server: a browser-only organization gets an explanation instead.
 */
export const ProgramsPage: React.FC = () => {
  const { currentTenant } = useTenant();
  const { programs, activeProgram, programsStatus, switchProgram, refreshPrograms, archiveProgram, unarchiveProgram, deleteProgram, canManagePrograms } = useProgram();
  const uid = useId();

  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; program?: Program } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [typedName, setTypedName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const openList = useMemo(() => programs.filter((p) => !p.archived), [programs]);
  const archivedList = useMemo(() => programs.filter((p) => p.archived), [programs]);
  const ready = programsStatus === 'ready';
  const metrics = useProgramMetrics(currentTenant.id, ready, programs.map((p) => p.id));

  const startAction = (kind: Pending['kind'], program: Program) => {
    setDialogError(null);
    setTypedName('');
    setPending({ kind, program });
  };

  const closeDialog = () => {
    if (busyId) return;
    setPending(null);
  };

  const confirm = async () => {
    if (!pending || busyId) return;
    const { kind, program } = pending;
    setBusyId(program.id);
    setDialogError(null);
    try {
      if (kind === 'archive') await archiveProgram(program.id);
      else await deleteProgram(program.id);
      if (mounted.current) setPending(null);
    } catch (err: unknown) {
      if (mounted.current) setDialogError(actionError(err, kind === 'archive' ? 'Could not archive the program. Please try again.' : 'Could not delete the program. Please try again.'));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const restore = async (program: Program) => {
    if (busyId) return;
    setBusyId(program.id);
    setPageError(null);
    try {
      await unarchiveProgram(program.id);
    } catch (err: unknown) {
      if (mounted.current) setPageError(actionError(err, 'Could not restore the program. Please try again.'));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const header = (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-brand-400 shrink-0">
          <Layers className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">Programs &amp; Boundaries</h2>
          <p className="text-xs text-slate-400">
            Each program is one authorization boundary with its own framework, answers, evidence, SSP imports and POA&amp;M items.
          </p>
        </div>
      </div>
      {canManagePrograms && ready && (
        <button type="button" onClick={() => setModal({ mode: 'create' })} className={PRIMARY_BUTTON}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          New Program
        </button>
      )}
    </div>
  );

  // Programs are rows on the server: an organization that only exists in this browser has one implicit boundary
  if (programsStatus === 'unsupported') {
    return (
      <div className="space-y-5">
        {header}
        <div role="status" className="rounded-2xl bg-slate-900/60 border border-slate-800 p-6 flex items-start gap-3">
          <Server className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1.5 text-xs text-slate-300 leading-relaxed">
            <p className="text-sm font-semibold text-white">Programs need the server</p>
            <p>
              This organization is stored only in this browser, so it has a single default boundary. Multiple programs (separate
              boundaries, frameworks and ATO efforts) are kept on the server. Move the organization to the server from the
              organization menu to create more.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (programsStatus === 'idle' || programsStatus === 'loading') {
    return (
      <div className="space-y-5">
        {header}
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Loading programs…
        </div>
      </div>
    );
  }

  if (programsStatus === 'error' && programs.length === 0) {
    return (
      <div className="space-y-5">
        {header}
        <ErrorNotice message="Could not load the programs of this organization." />
        <button type="button" onClick={() => { void refreshPrograms(); }} className={SECONDARY_BUTTON}>Try again</button>
      </div>
    );
  }

  const readOnly = !canManagePrograms;

  const renderCard = (program: Program) => {
    const isActive = activeProgram?.id === program.id;
    const busy = busyId === program.id;
    const baseline = baselineChip(program);
    const nameId = `${uid}-${program.id}`;
    return (
      <li key={program.id} aria-labelledby={nameId} className={`rounded-2xl bg-slate-900/60 border p-5 space-y-4 ${isActive ? 'border-brand-500/40 shadow-sm shadow-brand-500/10' : 'border-slate-800'}`}>
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h3 id={nameId} className="text-sm font-bold text-white break-words min-w-0">{program.name}</h3>
            <div className="flex items-center gap-1.5 shrink-0">
              {isActive && <span className={STATUS_BADGE}>Active</span>}
              {program.isDefault && <span className={ACCENT_BADGE}>Default</span>}
              {program.archived && <span className={NEUTRAL_BADGE}>Archived</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={STATUS_BADGE}>{frameworkLabel(program.framework)}</span>
            {baseline && <span className={NEUTRAL_BADGE}>{baseline}</span>}
          </div>
          {(program.boundarySummary || program.description) && (
            <p className="text-xs text-slate-400 leading-relaxed line-clamp-3 whitespace-pre-line">{program.boundarySummary || program.description}</p>
          )}
        </div>

        <MetricsRow state={metrics[program.id]} />

        <div className="flex flex-wrap items-center gap-2">
          {program.archived ? (
            canManagePrograms && (
              <>
                <button type="button" onClick={() => { void restore(program); }} disabled={Boolean(busyId)} className={SECONDARY_BUTTON}>
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <ArchiveRestore className="w-3.5 h-3.5" aria-hidden="true" />}
                  Restore
                </button>
                {!program.isDefault && (
                  <button type="button" onClick={() => startAction('delete', program)} disabled={Boolean(busyId)} className={DANGER_BUTTON}>
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Delete
                  </button>
                )}
              </>
            )
          ) : (
            <>
              <button type="button" onClick={() => switchProgram(program.id)} disabled={isActive} aria-label={isActive ? `${program.name} is the active program` : `Switch to ${program.name}`} className={isActive ? SECONDARY_BUTTON : PRIMARY_BUTTON}>
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                {isActive ? 'Active' : 'Switch to Program'}
              </button>
              {canManagePrograms && (
                <>
                  <button type="button" onClick={() => setModal({ mode: 'edit', program })} disabled={Boolean(busyId)} className={SECONDARY_BUTTON}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                    Edit Boundary Details
                  </button>
                  <button
                    type="button"
                    onClick={() => startAction('archive', program)}
                    disabled={program.isDefault || Boolean(busyId)}
                    aria-describedby={program.isDefault ? `${nameId}-default` : undefined}
                    className={SECONDARY_BUTTON}
                  >
                    <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                    Archive
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {program.isDefault && canManagePrograms && (
          <p id={`${nameId}-default`} className="text-xs text-slate-400">The default program cannot be archived or deleted.</p>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      {header}

      {readOnly && (
        <p role="note" className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">
          Programs are read-only for your role. The tenant owner or an MSP administrator creates, edits, archives and deletes them.
        </p>
      )}
      {programsStatus === 'error' && <ErrorNotice message="The programs could not be refreshed. The list below may be out of date." />}
      <ErrorNotice message={pageError} />

      {openList.length === 0 ? (
        <div className="rounded-2xl bg-slate-900/60 border border-dashed border-slate-700 p-8 text-center space-y-3">
          <Layers className="w-7 h-7 text-slate-400 mx-auto" aria-hidden="true" />
          <p className="text-sm font-semibold text-white">No programs yet</p>
          <p className="text-xs text-slate-400">
            {canManagePrograms
              ? 'Create a program to give an ATO effort its own framework, answers and evidence.'
              : 'Ask the tenant owner or an MSP administrator to create the first program.'}
          </p>
          {canManagePrograms && (
            <button type="button" onClick={() => setModal({ mode: 'create' })} className={PRIMARY_BUTTON}>
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              New Program
            </button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-4" aria-label="Programs">
          {openList.map(renderCard)}
        </ul>
      )}

      {archivedList.length > 0 && (
        <section aria-label="Archived programs" className="space-y-3">
          <button
            type="button"
            onClick={() => setArchivedOpen((v) => !v)}
            aria-expanded={archivedOpen}
            aria-controls={`${uid}-archived`}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white transition-colors"
          >
            {archivedOpen ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
            Archived ({archivedList.length})
          </button>
          {archivedOpen && (
            <ul id={`${uid}-archived`} className="grid grid-cols-1 xl:grid-cols-2 gap-4" aria-label="Archived programs">
              {archivedList.map(renderCard)}
            </ul>
          )}
        </section>
      )}

      {modal && (
        <ProgramFormModal mode={modal.mode} program={modal.program} onClose={() => setModal(null)} />
      )}

      {pending?.kind === 'archive' && (
        <ConfirmDialog
          title={`Archive "${pending.program.name}"?`}
          confirmLabel="Archive Program"
          busy={busyId === pending.program.id}
          confirmDisabled={pending.program.isDefault}
          error={pending.program.isDefault ? ACTION_MESSAGES.program_is_default : dialogError}
          onConfirm={() => { void confirm(); }}
          onCancel={closeDialog}
        >
          <p>An archived program stays readable, but its answers, evidence and imports can no longer be changed. You can restore it later.</p>
          {pending.program.id === activeProgram?.id && <p>It is the active program: the app moves to another program.</p>}
        </ConfirmDialog>
      )}

      {pending?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete "${pending.program.name}"?`}
          confirmLabel="Delete Program"
          danger
          busy={busyId === pending.program.id}
          confirmDisabled={typedName.trim() !== pending.program.name}
          error={dialogError}
          onConfirm={() => { void confirm(); }}
          onCancel={closeDialog}
        >
          <p>
            Deleting a program permanently deletes its control narratives and answers. It cannot be undone. A program that still holds
            evidence files, SSP imports or POA&amp;M items cannot be deleted: the server refuses until they are gone.
          </p>
          <div>
            <label htmlFor={`${uid}-confirm-name`} className="block font-medium text-slate-300 mb-1">
              Type the program name to confirm
            </label>
            <input
              id={`${uid}-confirm-name`}
              type="text"
              autoFocus
              autoComplete="off"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              disabled={busyId === pending.program.id}
              placeholder={pending.program.name}
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-rose-500 disabled:opacity-60"
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
};

export default ProgramsPage;
