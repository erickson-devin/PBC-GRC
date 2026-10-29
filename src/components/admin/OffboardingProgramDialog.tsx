import React, { useEffect, useId, useState } from 'react';
import { Download } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { ApiClient, ApiError } from '../../services/apiClient';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import type { Tenant } from '../../types/tenant';
import type { Program } from '../../types/program';
import type { HandoverSelection } from '../../data/storage/offboardingPrograms';

/** The membership check answers 403 for an administrator who is not a member of the tenant. */
export const NOT_MEMBER_MESSAGE =
  'You are not a member of this tenant, so its implementation notes cannot be read. Add yourself to the tenant (or ask an owner to export) before generating the handover package.';

interface OffboardingProgramDialogProps {
  tenant: Tenant;
  onConfirm: (selection: HandoverSelection) => void;
  onClose: () => void;
}

/**
 * Which program's handover package to export: all of them in one file (the default) or one program. Names, frameworks and
 * the default / archived markers only. Opened over the enclave menu (z-50), hence z-[60].
 */
export const OffboardingProgramDialog: React.FC<OffboardingProgramDialogProps> = ({ tenant, onConfirm, onClose }) => {
  const groupName = useId();
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    ApiClient.listPrograms(tenant.id, { includeArchived: true })
      .then((list) => {
        if (cancelled) return;
        setPrograms([...list.filter((p) => p.isDefault), ...list.filter((p) => !p.isDefault)]);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 403 ? NOT_MEMBER_MESSAGE : 'The programs of this enclave could not be loaded from the server.');
      });
    return () => { cancelled = true; };
  }, [tenant.id]);

  const handleConfirm = () => {
    if (!programs) return;
    onConfirm(choice === 'all' ? { kind: 'all' } : { kind: 'program', programId: choice });
  };

  const optionClass = (selected: boolean) =>
    `flex items-start gap-2.5 rounded-xl border p-2.5 cursor-pointer text-xs transition-colors ${
      selected ? 'bg-slate-900/80 border-cyan-500/40 text-white' : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
    }`;

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
          <Download className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          <span>Export offboarding package</span>
        </DialogTitle>
        <p className="text-xs text-slate-300 leading-relaxed">
          Each program of this enclave has its own controls, notes and evidence. Each package states the whole asset inventory of the enclave.
        </p>
        <ErrorNotice message={error} />
        {!programs && !error && <p role="status" className="text-xs text-slate-400">Loading programs…</p>}
        {programs && (
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">Programs to hand over</legend>
            <label className={optionClass(choice === 'all')}>
              <input type="radio" name={groupName} value="all" autoFocus checked={choice === 'all'} onChange={() => setChoice('all')} className="mt-0.5" />
              <span className="font-semibold">All programs ({programs.length}), one file</span>
            </label>
            {programs.map((p) => (
              <label key={p.id} className={optionClass(choice === p.id)}>
                <input type="radio" name={groupName} value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} className="mt-0.5" />
                <span>
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-slate-400"> · {frameworkLabel(p.framework)}{p.isDefault ? ' (default)' : ''}{p.archived ? ' (archived)' : ''}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={!programs}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30">
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default OffboardingProgramDialog;
