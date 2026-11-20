import React, { useId } from 'react';
import type { SspProfile } from '../../types/sspProfile';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import {
  MAINTENANCE_QUESTIONS,
  SSP_BUILDER_TEXT,
  emptyMaintenance,
  exceptionsRequired,
  fieldFlags,
  missingItemsLine,
  radioValue,
  setMaintenanceAnswer,
  setMaintenanceExceptions,
} from '../../data/ssp/sspBuilderView';

interface SspMaintenanceSectionProps {
  profile: SspProfile | null;
  canEdit: boolean;
  profileEditable: boolean;
  onProfileChange: (p: SspProfile) => void;
  section?: SspSectionStatus;
  maControls: Array<{ id: string; displayId: string; title: string }>;
  onOpenControl: (id: string) => void;
}

const OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unset', label: 'Not answered' },
] as const;

/** 2.3: who maintains and who owns the hardware and software; an explanation is required when any answer is No. */
export const SspMaintenanceSection: React.FC<SspMaintenanceSectionProps> = ({
  profile,
  canEdit,
  profileEditable,
  onProfileChange,
  section,
  maControls,
  onOpenControl,
}) => {
  const baseId = useId();
  const hintId = `${baseId}-exceptions-hint`;
  const maId = `${baseId}-ma`;
  const m = profile?.maintenance ?? emptyMaintenance();
  const req = exceptionsRequired(m);
  const missingLine = missingItemsLine(section);
  const disabled = !canEdit || !profileEditable;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">Who maintains and who owns the system&apos;s hardware and software. Any No needs an explanation.</p>
      {missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}

      <div className="space-y-3">
        {MAINTENANCE_QUESTIONS.map((q) => {
          const required = fieldFlags(section, `maintenance:${q.key}`).required;
          return (
            <fieldset key={q.key} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <legend className="px-1 text-xs font-semibold text-slate-300">
                {q.label}
                {required && (
                  <>
                    <span className="text-rose-300" aria-hidden="true"> *</span>
                    <span className="sr-only"> (required)</span>
                  </>
                )}
              </legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
                {OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="radio"
                      name={`${baseId}-${q.key}`}
                      checked={radioValue(m[q.key]) === o.value}
                      onChange={() => onProfileChange(setMaintenanceAnswer(profile, q.key, o.value))}
                      className="accent-brand-500"
                      disabled={disabled}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>

      <div>
        <label htmlFor={`${baseId}-exceptions`} className="block text-xs font-semibold text-slate-300 mb-1.5">
          Exceptions{req && <span className="text-rose-300"> (required)</span>}
        </label>
        <textarea
          id={`${baseId}-exceptions`}
          rows={4}
          maxLength={20000}
          aria-required={req || undefined}
          aria-describedby={hintId}
          disabled={disabled}
          value={m.exceptions}
          onChange={(e) => onProfileChange(setMaintenanceExceptions(profile, e.target.value))}
          className="w-full p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
          placeholder="e.g. Leased printers are maintained and owned by the lessor; the ERP is a vendor-hosted subscription."
        />
        <p id={hintId} className={`mt-1 text-[11px] ${req && !m.exceptions.trim() ? 'text-amber-300' : 'text-slate-500'}`}>
          {req ? SSP_BUILDER_TEXT.exceptionsRequired : SSP_BUILDER_TEXT.exceptionsOptional}
        </p>
      </div>

      {maControls.length > 0 && (
        <section aria-labelledby={maId} className="space-y-2">
          <h4 id={maId} className="text-xs font-semibold text-slate-300">Related maintenance (MA) controls</h4>
          <ul className="flex flex-wrap gap-1.5">
            {maControls.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenControl(c.id)}
                  title={c.title}
                  className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {c.displayId}
                  <span className="sr-only">: {c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
