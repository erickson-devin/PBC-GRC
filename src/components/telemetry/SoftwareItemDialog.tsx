import React, { useId, useMemo, useRef, useState } from 'react';
import { Package, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  APPROVAL_LABELS,
  ApprovalChoice,
  SOFTWARE_LIMITS,
  approvalChoice,
  approvedFromChoice,
  assetOptions,
  softwareErrorMessage,
  validateSoftwareName,
} from '../../data/softwareInventoryView';
import type { EnclaveAsset } from '../../types/telemetry';
import type { SoftwareItem, SoftwareItemInput } from '../../types/software';

interface SoftwareItemDialogProps {
  /** The entry being edited, or null to add one. */
  initial: SoftwareItem | null;
  assets: EnclaveAsset[];
  assetsLoading: boolean;
  /** Saves the entry; rejects with the ApiError when the server refuses it (the dialog then stays open). */
  onSave: (input: SoftwareItemInput) => Promise<void>;
  onClose: () => void;
  /** Values for a new entry (used only when `initial` is null), e.g. a package copied from the scanner data. */
  prefill?: SoftwareItemInput;
  /** Opened over another dialog: drawn above it. */
  stacked?: boolean;
}

const CHOICES: ApprovalChoice[] = ['APPROVED', 'NOT_APPROVED', 'NOT_REVIEWED'];
const TENANT_WIDE = '';

const inputClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';

/** Add / edit dialog of the software inventory. Names, vendors and notes may be CUI: nothing here is logged or stored in the browser. */
export const SoftwareItemDialog: React.FC<SoftwareItemDialogProps> = ({ initial, assets, assetsLoading, onSave, onClose, prefill, stacked }) => {
  const seed: SoftwareItemInput | null = initial ?? prefill ?? null;
  const [name, setName] = useState(seed?.name ?? '');
  const [version, setVersion] = useState(seed?.version ?? '');
  const [vendor, setVendor] = useState(seed?.vendor ?? '');
  const [choice, setChoice] = useState<ApprovalChoice>(approvalChoice(seed?.approved ?? null));
  const [assetId, setAssetId] = useState<string>(seed?.assetId ?? TENANT_WIDE);
  const [notes, setNotes] = useState(seed?.notes ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameErrorId = useId();
  const approvalNoteId = useId();

  const options = useMemo(() => assetOptions(assets), [assets]);
  // An entry linked to an asset that is no longer in the inventory keeps its link until the user picks another
  const orphan = assetId !== TENANT_WIDE && !assetsLoading && !options.some((o) => o.id === assetId);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    const problem = validateSoftwareName(name);
    setNameError(problem);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        version: version.trim(),
        vendor: vendor.trim(),
        approved: approvedFromChoice(choice),
        assetId: assetId === TENANT_WIDE ? null : assetId,
        notes: notes.trim(),
      });
      onClose();
    } catch (err: unknown) {
      setError(softwareErrorMessage(err, 'save'));
      setSaving(false);
    }
  };

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className={`fixed inset-0 ${stacked ? 'z-[60]' : 'z-50'} flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn`}>
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Package className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">
              {initial ? 'Edit Software Entry' : 'Add Software'}
            </DialogTitle>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!initial && prefill && <p className="text-xs text-slate-400">Filled in from the scanner data. Check the values, then choose the approval.</p>}

        <ErrorNotice message={error} />

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4 text-xs">
          <div>
            <label htmlFor="software-name" className={labelClass}>
              Software name <span className="text-rose-400">*</span>
            </label>
            <input
              id="software-name"
              ref={nameRef}
              autoFocus
              type="text"
              value={name}
              maxLength={SOFTWARE_LIMITS.name}
              onChange={(e) => setName(e.target.value)}
              aria-required="true"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? nameErrorId : undefined}
              placeholder="e.g. LibreOffice"
              className={inputClass}
            />
            {nameError && (
              <p id={nameErrorId} role="alert" className="mt-1 text-rose-300">{nameError}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="software-version" className={labelClass}>
                Version <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id="software-version"
                type="text"
                value={version}
                maxLength={SOFTWARE_LIMITS.version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 7.6.4"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label htmlFor="software-vendor" className={labelClass}>
                Vendor <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id="software-vendor"
                type="text"
                value={vendor}
                maxLength={SOFTWARE_LIMITS.vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="e.g. The Document Foundation"
                className={inputClass}
              />
            </div>
          </div>

          <fieldset aria-describedby={approvalNoteId}>
            <legend className={labelClass}>Approval (CM.L2-3.4.8)</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {CHOICES.map((c) => (
                <label
                  key={c}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    choice === c ? 'border-cyan-500/60 bg-cyan-500/10 text-white' : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <input type="radio" name="software-approval" value={c} checked={choice === c} onChange={() => setChoice(c)} className="accent-cyan-500" />
                  <span>{APPROVAL_LABELS[c]}</span>
                </label>
              ))}
            </div>
            <p id={approvalNoteId} className="mt-1.5 text-slate-400">
              &quot;Not reviewed&quot; means nobody has decided yet; the exported document never reports it as not approved.
            </p>
          </fieldset>

          <div>
            <label htmlFor="software-asset" className={labelClass}>Installed on</label>
            <select
              id="software-asset"
              value={assetId}
              disabled={assetsLoading}
              onChange={(e) => setAssetId(e.target.value)}
              className={inputClass}
            >
              <option value={TENANT_WIDE}>Tenant-wide (no specific asset)</option>
              {orphan && <option value={assetId}>Asset no longer in the inventory</option>}
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="software-notes" className={labelClass}>
              Notes <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <textarea
              id="software-notes"
              rows={3}
              value={notes}
              maxLength={SOFTWARE_LIMITS.notes}
              onChange={(e) => setNotes(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-right text-slate-400">{notes.length} / {SOFTWARE_LIMITS.notes}</p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold disabled:opacity-50"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">
              {saving ? 'Saving…' : initial ? 'Save Changes' : 'Add Software'}
            </button>
          </div>
        </form>
      </div>
    </DialogOverlay>
  );
};

export default SoftwareItemDialog;
