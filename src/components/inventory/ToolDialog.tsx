import React, { useId, useRef, useState } from 'react';
import { Wrench, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import {
  DEPLOYMENT_LABELS,
  FEDRAMP_LABELS,
  INVENTORY_UI_TEXT,
  TOOL_TYPE_LABELS,
  fedrampDateApplies,
  localDateIso,
  rebaseToolForm,
  toolErrorMessage,
  toolFormFrom,
  validateToolForm,
  type ToolForm,
  type ToolFormField,
} from '../../data/inventory/inventoryUiView';
import { FEDRAMP_STATUSES, TOOL_DEPLOYMENTS, TOOL_TYPES, type FedrampStatus, type InventoryTool, type InventoryVendor, type ToolDeployment, type ToolInput, type ToolType } from '../../types/inventory';
import type { CmmcAssetCategory } from '../../types/telemetry';

interface ToolDialogProps {
  /** The tool being edited, or null to add one. */
  initial: InventoryTool | null;
  /** Values for a new tool (used only when `initial` is null). */
  prefill?: Partial<ToolInput>;
  vendors: InventoryVendor[];
  showCost: boolean;
  programName: string | null;
  /** The open program is loaded and has declared its tools: offer to add a new tool to its boundary. */
  offerBoundary: boolean;
  /** Saves the tool; rejects with the ApiError when the server refuses it (the dialog then stays open). */
  onSave: (input: ToolInput, opts: { expectedUpdatedAt?: string; addToBoundary: boolean }) => Promise<void>;
  /** The tool as the register holds it now (after a reload), or null when it is gone. */
  latest: (id: string) => InventoryTool | null;
  onClose: () => void;
  /** Opened over another dialog: drawn above it. */
  stacked?: boolean;
}

const inputClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const conflictClass = 'border-amber-500/60';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';
const NOTES_MAX = 4000;
const CHOOSE_CATEGORY = 'Choose the category this tool falls under in the CMMC scope.';

/** Add / edit dialog of the Tools and Services register. Names, missions and notes may be CUI: nothing here is logged or stored in the browser. */
export const ToolDialog: React.FC<ToolDialogProps> = ({ initial, prefill, vendors, showCost, programName, offerBoundary, onSave, latest, onClose, stacked }) => {
  const [form, setForm] = useState<ToolForm>(() => toolFormFrom(initial, prefill));
  const [base, setBase] = useState<InventoryTool | null>(initial);
  const [errors, setErrors] = useState<Partial<Record<ToolFormField, string>>>({});
  const [conflicts, setConflicts] = useState<ToolFormField[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addToBoundary, setAddToBoundary] = useState(false);
  const refs = useRef(new Map<ToolFormField, HTMLElement>());
  const bannerRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const hint = (k: string): string => `${uid}-${k}-hint`;
  const err = (k: string): string => `${uid}-${k}-err`;

  const setField = <K extends ToolFormField>(k: K, v: ToolForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const reg = (k: ToolFormField) => (el: HTMLElement | null) => {
    if (el) refs.current.set(k, el);
    else refs.current.delete(k);
  };
  const describedBy = (k: ToolFormField, hintId?: string): string | undefined => {
    const ids = [hintId, errors[k] ? err(k) : undefined].filter(Boolean).join(' ');
    return ids || undefined;
  };
  const fieldClass = (k: ToolFormField, extra = ''): string => `${inputClass} ${extra} ${conflicts.includes(k) ? conflictClass : ''}`.replace(/\s+/g, ' ').trim();
  const fieldNote = (k: ToolFormField): React.ReactNode => (
    <>
      {errors[k] && <p id={err(k)} role="alert" className="mt-1 text-rose-300">{errors[k]}</p>}
      {conflicts.includes(k) && <p className="mt-1 text-amber-300">{INVENTORY_UI_TEXT.conflictField}</p>}
    </>
  );

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || gone) return;
    const res = validateToolForm(form, localDateIso(new Date()), showCost);
    setErrors(res.errors);
    if (!res.input) {
      const order = Array.from(refs.current.keys());
      const first = order.find((k) => res.errors[k]);
      if (first) refs.current.get(first)?.focus();
      return;
    }
    setBanner(null);
    setSaving(true);
    try {
      await onSave(res.input, { expectedUpdatedAt: base?.updatedAt, addToBoundary: !base && offerBoundary && addToBoundary });
      onClose();
    } catch (error: unknown) {
      const reason = (error as { reason?: unknown } | null)?.reason;
      if (reason === 'stale_write' && base) {
        const now = latest(base.id);
        if (!now) {
          setGone(true);
          setBanner(INVENTORY_UI_TEXT.toolGone);
        } else {
          const merged = rebaseToolForm(base, now, form, showCost);
          setForm(merged.form);
          setConflicts(merged.conflicts);
          setBase(now);
          setBanner(INVENTORY_UI_TEXT.staleTool);
        }
        setTimeout(() => bannerRef.current?.focus(), 0);
      } else {
        setBanner(toolErrorMessage(error, 'save'));
      }
      setSaving(false);
    }
  };

  const category = form.assetCategory === '' ? undefined : CATEGORY_INFO[form.assetCategory];
  const radioCard = (selected: boolean): string =>
    `flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
      selected ? 'border-cyan-500/60 bg-cyan-500/10 text-white' : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-800'
    }`;

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className={`fixed inset-0 ${stacked ? 'z-[60]' : 'z-50'} flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn`}>
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Wrench className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">
              {initial ? 'Edit tool or service' : 'Add tool or service'}
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

        <div ref={bannerRef} tabIndex={-1} className="outline-none">
          <ErrorNotice message={banner} />
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4 text-xs">
          <div>
            <label htmlFor={id('name')} className={labelClass}>
              Tool or service name <span className="text-rose-400">*</span>
            </label>
            <input
              id={id('name')}
              ref={reg('name')}
              autoFocus
              type="text"
              value={form.name}
              maxLength={255}
              onChange={(e) => setField('name', e.target.value)}
              aria-required="true"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('name')}
              placeholder="e.g. Endpoint protection agent"
              className={fieldClass('name')}
            />
            {fieldNote('name')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('vendorName')} className={labelClass}>
                Vendor or provider <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={id('vendorName')}
                ref={reg('vendorName')}
                type="text"
                value={form.vendorName}
                maxLength={255}
                onChange={(e) => setField('vendorName', e.target.value)}
                aria-describedby={describedBy('vendorName')}
                className={fieldClass('vendorName')}
              />
              {fieldNote('vendorName')}
            </div>
            <div>
              <label htmlFor={id('vendorId')} className={labelClass}>
                Vendor record <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <select
                id={id('vendorId')}
                ref={reg('vendorId')}
                value={form.vendorId}
                onChange={(e) => {
                  const vendorId = e.target.value;
                  const picked = vendors.find((v) => v.id === vendorId);
                  setForm((f) => ({ ...f, vendorId, vendorName: picked && f.vendorName.trim() === '' ? picked.name : f.vendorName }));
                }}
                className={fieldClass('vendorId')}
              >
                <option value="">None</option>
                {form.vendorId !== '' && !vendors.some((v) => v.id === form.vendorId) && <option value={form.vendorId}>Vendor record no longer in the register</option>}
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {fieldNote('vendorId')}
            </div>
          </div>

          <div>
            <label htmlFor={id('mission')} className={labelClass}>
              What it does <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <textarea
              id={id('mission')}
              ref={reg('mission')}
              rows={2}
              value={form.mission}
              maxLength={1000}
              onChange={(e) => setField('mission', e.target.value)}
              aria-describedby={describedBy('mission')}
              className={fieldClass('mission')}
            />
            {fieldNote('mission')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('toolType')} className={labelClass}>Type</label>
              <select
                id={id('toolType')}
                ref={reg('toolType')}
                value={form.toolType}
                onChange={(e) => setField('toolType', e.target.value as ToolType | '')}
                className={fieldClass('toolType')}
              >
                <option value="">Not set</option>
                {TOOL_TYPES.map((t) => (
                  <option key={t} value={t}>{TOOL_TYPE_LABELS[t]}</option>
                ))}
              </select>
              {fieldNote('toolType')}
            </div>
            <div>
              <label htmlFor={id('assetCategory')} className={labelClass}>CMMC asset category</label>
              <select
                id={id('assetCategory')}
                ref={reg('assetCategory')}
                value={form.assetCategory}
                onChange={(e) => setField('assetCategory', e.target.value as CmmcAssetCategory | '')}
                aria-describedby={hint('assetCategory')}
                className={fieldClass('assetCategory')}
              >
                <option value="">Not classified</option>
                {CMMC_ASSET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_INFO[c].label}</option>
                ))}
              </select>
              <p id={hint('assetCategory')} className="mt-1 text-slate-400">{category?.description ?? CHOOSE_CATEGORY}</p>
              {fieldNote('assetCategory')}
            </div>
          </div>

          <fieldset>
            <legend className={labelClass}>Deployment</legend>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              {([...TOOL_DEPLOYMENTS, ''] as (ToolDeployment | '')[]).map((d) => (
                <label key={d || 'none'} className={radioCard(form.deployment === d)}>
                  <input
                    type="radio"
                    name={id('deployment')}
                    value={d}
                    checked={form.deployment === d}
                    onChange={() => setField('deployment', d)}
                    className="accent-cyan-500"
                  />
                  <span>{d === '' ? 'Not set' : DEPLOYMENT_LABELS[d]}</span>
                </label>
              ))}
            </div>
            {fieldNote('deployment')}
          </fieldset>

          <fieldset>
            <legend className={labelClass}>FedRAMP</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={id('fedrampStatus')} className="block text-slate-300 mb-1.5">Status</label>
                <select
                  id={id('fedrampStatus')}
                  ref={reg('fedrampStatus')}
                  value={form.fedrampStatus}
                  onChange={(e) => setField('fedrampStatus', e.target.value as FedrampStatus)}
                  aria-describedby={hint('fedramp')}
                  className={fieldClass('fedrampStatus')}
                >
                  {FEDRAMP_STATUSES.map((s) => (
                    <option key={s} value={s}>{FEDRAMP_LABELS[s]}</option>
                  ))}
                </select>
                {fieldNote('fedrampStatus')}
              </div>
              {fedrampDateApplies(form.fedrampStatus) && (
                <div>
                  <label htmlFor={id('fedrampVerifiedOn')} className="block text-slate-300 mb-1.5">Date you checked</label>
                  <input
                    id={id('fedrampVerifiedOn')}
                    ref={reg('fedrampVerifiedOn')}
                    type="date"
                    value={form.fedrampVerifiedOn}
                    onChange={(e) => setField('fedrampVerifiedOn', e.target.value)}
                    aria-invalid={errors.fedrampVerifiedOn ? true : undefined}
                    aria-describedby={describedBy('fedrampVerifiedOn', hint('fedramp'))}
                    className={fieldClass('fedrampVerifiedOn')}
                  />
                  {fieldNote('fedrampVerifiedOn')}
                </div>
              )}
            </div>
            <p id={hint('fedramp')} className="mt-1.5 text-slate-400">{INVENTORY_UI_TEXT.fedrampHint}</p>
          </fieldset>

          <fieldset>
            <legend className={labelClass}>Customer responsibility matrix (CRM) on file</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(
                [
                  ['yes', 'Yes'],
                  ['no', 'No'],
                  ['unset', 'Not answered'],
                ] as const
              ).map(([v, text]) => (
                <label key={v} className={radioCard(form.crmOnFile === v)}>
                  <input type="radio" name={id('crm')} value={v} checked={form.crmOnFile === v} onChange={() => setField('crmOnFile', v)} className="accent-cyan-500" />
                  <span>{text}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('endUsers')} className={labelClass}>End users</label>
              <input
                id={id('endUsers')}
                ref={reg('endUsers')}
                type="text"
                inputMode="numeric"
                value={form.endUsers}
                onChange={(e) => setField('endUsers', e.target.value)}
                aria-invalid={errors.endUsers ? true : undefined}
                aria-describedby={describedBy('endUsers', hint('users'))}
                className={fieldClass('endUsers')}
              />
              {fieldNote('endUsers')}
            </div>
            <div>
              <label htmlFor={id('privilegedUsers')} className={labelClass}>Privileged users</label>
              <input
                id={id('privilegedUsers')}
                ref={reg('privilegedUsers')}
                type="text"
                inputMode="numeric"
                value={form.privilegedUsers}
                onChange={(e) => setField('privilegedUsers', e.target.value)}
                aria-invalid={errors.privilegedUsers ? true : undefined}
                aria-describedby={describedBy('privilegedUsers', hint('users'))}
                className={fieldClass('privilegedUsers')}
              />
              {fieldNote('privilegedUsers')}
            </div>
          </div>
          <p id={hint('users')} className="-mt-2 text-slate-400">{INVENTORY_UI_TEXT.usersHint}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {showCost && (
              <div>
                <label htmlFor={id('annualCost')} className={labelClass}>Annual cost (USD)</label>
                <input
                  id={id('annualCost')}
                  ref={reg('annualCost')}
                  type="text"
                  inputMode="decimal"
                  value={form.annualCost}
                  onChange={(e) => setField('annualCost', e.target.value)}
                  placeholder="e.g. 12,500.00"
                  aria-invalid={errors.annualCost ? true : undefined}
                  aria-describedby={describedBy('annualCost', hint('cost'))}
                  className={fieldClass('annualCost')}
                />
                <p id={hint('cost')} className="mt-1 text-slate-400">{INVENTORY_UI_TEXT.costHint}</p>
                {fieldNote('annualCost')}
              </div>
            )}
            <div>
              <label htmlFor={id('renewalDate')} className={labelClass}>Renewal date</label>
              <input
                id={id('renewalDate')}
                ref={reg('renewalDate')}
                type="date"
                value={form.renewalDate}
                onChange={(e) => setField('renewalDate', e.target.value)}
                aria-invalid={errors.renewalDate ? true : undefined}
                aria-describedby={describedBy('renewalDate')}
                className={fieldClass('renewalDate')}
              />
              {fieldNote('renewalDate')}
            </div>
          </div>

          <div>
            <label htmlFor={id('notes')} className={labelClass}>
              Notes <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <textarea
              id={id('notes')}
              ref={reg('notes')}
              rows={3}
              value={form.notes}
              maxLength={NOTES_MAX}
              onChange={(e) => setField('notes', e.target.value)}
              className={fieldClass('notes')}
            />
            <p className="mt-1 text-right text-slate-400">{form.notes.length} / {NOTES_MAX}</p>
            {fieldNote('notes')}
          </div>

          {!initial && offerBoundary && programName && (
            <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
              <input type="checkbox" checked={addToBoundary} onChange={(e) => setAddToBoundary(e.target.checked)} className="accent-cyan-500" />
              <span>{`Also add it to ${programName}'s boundary`}</span>
            </label>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold disabled:opacity-50"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving || gone} className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">
              {saving ? 'Saving…' : initial ? 'Save changes' : 'Add tool'}
            </button>
          </div>
        </form>
      </div>
    </DialogOverlay>
  );
};

export default ToolDialog;
