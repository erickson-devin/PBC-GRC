import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Layers, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useTenant } from '../../context/TenantContext';
import { useProgram } from '../../hooks/useProgram';
import { PROGRAM_FRAMEWORKS, frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { PROGRAM_NAME_MAX, PROGRAM_TEXT_MAX, normalizeProgramFramework, validateProgramInput } from '../../data/programSync';
import type { ProgramInputField } from '../../data/programSync';
import { OVERLAY_DETAILS, OVERLAY_KEYS, OVERLAY_TITLES, programOverlayLabels } from '../../data/overlayScoping';
import { scopingToOverlays } from '../../data/programScope';
import type { OverlayFilters } from '../../types/framework';
import type { Program, ProgramBaseline, ProgramSeed } from '../../types/program';
import { errorMessage } from '../../utils/errors';

interface ProgramFormModalProps {
  mode: 'create' | 'edit';
  /** The program being edited (edit mode). */
  program?: Program;
  onClose: () => void;
  /** Called after a successful save with the saved program. */
  onSaved?: (program: Program) => void;
}

const BASELINE_OPTIONS: { value: ProgramBaseline; label: string }[] = [
  { value: 'LOW', label: 'Low' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'HIGH', label: 'High' },
];

const baselineLabel = (b: ProgramBaseline | null | undefined) => BASELINE_OPTIONS.find((o) => o.value === b)?.label ?? 'Not set';

/** The server's refusals, in plain language (the server's own message is used for anything else). */
const SERVER_MESSAGES: Record<string, string> = {
  program_name_taken: 'A program with this name already exists. Names are compared ignoring case; choose another one.',
  framework_not_enabled: 'That framework is not enabled for this organization. Ask a platform administrator or the tenant owner to enable it first.',
  program_limit: 'This organization has reached the maximum number of programs. Archive and delete one that is no longer needed first.',
  framework_immutable: 'The framework and baseline of a program cannot be changed after it is created.',
};

function serverError(err: unknown, fallback: string): string {
  const code = (err as { reason?: unknown; code?: unknown } | null) ?? {};
  const key = typeof code.reason === 'string' ? code.reason : typeof code.code === 'string' ? code.code : '';
  return SERVER_MESSAGES[key] ?? (errorMessage(err) || fallback);
}

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';

/**
 * Create / edit dialog of a program (an authorization boundary). Create: name, framework (among those enabled for the tenant),
 * baseline (NIST SP 800-53 only), descriptions and a seed (blank or a clone of another program). Edit: name and descriptions;
 * the framework and the baseline are fixed at creation and shown read-only. Creating switches to the new program.
 */
export const ProgramFormModal: React.FC<ProgramFormModalProps> = ({ mode, program, onClose, onSaved }) => {
  const { currentTenant } = useTenant();
  const { programs, openPrograms, activeProgram, createProgram, updateProgram, switchProgram } = useProgram();
  const isEdit = mode === 'edit' && Boolean(program);
  const uid = useId();

  // PROGRAM_FRAMEWORKS ∩ the frameworks enabled for the tenant (NIST SP 800-53 appears only when it is enabled)
  const frameworkOptions = useMemo(() => {
    const enabled = currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0
      ? currentTenant.enabledFrameworks
      : [currentTenant.primaryFramework || 'CMMC_L1'];
    const allowed = new Set(enabled.map((f) => normalizeProgramFramework(f)).filter(Boolean));
    return PROGRAM_FRAMEWORKS.filter((f) => allowed.has(f));
  }, [currentTenant.enabledFrameworks, currentTenant.primaryFramework]);

  const [name, setName] = useState(program?.name ?? '');
  const [framework, setFramework] = useState<string>(
    program?.framework ?? (activeProgram && frameworkOptions.includes(activeProgram.framework) ? activeProgram.framework : frameworkOptions[0] ?? '')
  );
  const [baseline, setBaseline] = useState<string>(program?.baseline ?? '');
  const [privacyBaseline, setPrivacyBaseline] = useState(false);
  const [scoping, setScoping] = useState<OverlayFilters>({ nonNetworkedOnly: false });
  const [description, setDescription] = useState(program?.description ?? '');
  const [boundarySummary, setBoundarySummary] = useState(program?.boundarySummary ?? '');
  const [seed, setSeed] = useState<ProgramSeed>('blank');
  const [sourceProgramId, setSourceProgramId] = useState<string>('');
  const [showErrors, setShowErrors] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const validation = validateProgramInput(
    { name, framework, baseline, privacyBaseline, scoping, description, boundarySummary, seed, sourceProgramId },
    {
      // In edit mode the framework is whatever the program carries, even when the tenant no longer lists it
      tenantFrameworks: isEdit && program ? [program.framework] : frameworkOptions,
      existing: programs,
      editingId: isEdit ? program?.id : null,
    }
  );
  // Framework, baseline and seed are not editable on an edit: only the text fields can be wrong
  const errors: Partial<Record<ProgramInputField, string>> = isEdit
    ? { name: validation.errors.name, description: validation.errors.description, boundarySummary: validation.errors.boundarySummary }
    : validation.errors;
  const isNist = framework === 'NIST_800_53_REV5';
  // A clone does not copy overlays on the server: choosing a NIST source prefills its overlays here, where they can still be changed
  const chooseSource = (id: string) => {
    setSourceProgramId(id);
    const source = openPrograms.find((p) => p.id === id);
    if (!isNist || !source || source.framework !== 'NIST_800_53_REV5') return;
    const next = scopingToOverlays(source.scoping);
    setScoping(privacyBaseline ? { ...next, noPiiProcessing: false } : next);
  };
  const shown =(field: ProgramInputField) => (showErrors ? errors[field] : undefined);

  const close = () => {
    if (isSaving) return; // do not abandon a request that is in flight
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setShowErrors(true);
    setSubmitError(null);
    if (Object.values(errors).some(Boolean)) return;

    const value = validation.value;
    setIsSaving(true);
    try {
      let saved: Program;
      if (isEdit && program) {
        saved = await updateProgram(program.id, { name: value.name, description: value.description, boundarySummary: value.boundarySummary });
      } else {
        saved = await createProgram(value);
        switchProgram(saved.id);
      }
      onSaved?.(saved);
      if (mounted.current) onClose();
    } catch (err: unknown) {
      if (mounted.current) setSubmitError(serverError(err, isEdit ? 'Could not save the program. Please try again.' : 'Could not create the program. Please try again.'));
    } finally {
      if (mounted.current) setIsSaving(false);
    }
  };

  const fieldId = (field: string) => `${uid}-${field}`;
  const errorProps = (field: ProgramInputField) => ({
    'aria-invalid': shown(field) ? true : undefined,
    'aria-describedby': shown(field) ? `${fieldId(field)}-error` : undefined,
  });
  const fieldError = (field: ProgramInputField) =>
    shown(field) ? (
      <p id={`${fieldId(field)}-error`} className="mt-1 text-xs text-rose-300">
        {errors[field]}
      </p>
    ) : null;

  return (
    <DialogOverlay onClose={isSaving ? undefined : close} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-brand-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <DialogTitle as="h3" className="text-sm font-bold text-white">
                {isEdit ? 'Edit Program Boundary' : 'New Program / ATO Effort'}
              </DialogTitle>
              <p className="text-xs text-slate-400">
                {isEdit ? 'Rename the program and update its boundary details' : 'An authorization boundary with its own framework, answers and evidence'}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            disabled={isSaving}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
          <div>
            <label htmlFor={fieldId('name')} className="block text-xs font-medium text-slate-300 mb-1">
              Program / Boundary Name <span className="text-rose-400">*</span>
            </label>
            <input
              id={fieldId('name')}
              type="text"
              autoFocus
              required
              maxLength={PROGRAM_NAME_MAX}
              placeholder="e.g. Corporate Enclave ATO 2027"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSaving}
              className={inputClass}
              {...errorProps('name')}
            />
            {fieldError('name')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={fieldId('framework')} className="block text-xs font-medium text-slate-300 mb-1">
                Primary Framework <span className="text-rose-400">*</span>
              </label>
              {isEdit && program ? (
                <div id={fieldId('framework')} className="px-3 py-2 text-xs bg-slate-950/60 border border-slate-800 rounded-xl text-slate-300">
                  {frameworkLabel(program.framework)}
                </div>
              ) : (
                <select
                  id={fieldId('framework')}
                  value={framework}
                  onChange={(e) => {
                    setFramework(e.target.value);
                    setPrivacyBaseline(false);
                    setScoping({ nonNetworkedOnly: false });
                    if (e.target.value !== 'NIST_800_53_REV5') setBaseline('');
                  }}
                  disabled={isSaving}
                  className={inputClass}
                  {...errorProps('framework')}
                >
                  {frameworkOptions.length === 0 && <option value="">No framework enabled</option>}
                  {frameworkOptions.map((f) => (
                    <option key={f} value={f}>{frameworkLabel(f)}</option>
                  ))}
                </select>
              )}
              {fieldError('framework')}
              <p className="mt-1 text-xs text-slate-400">
                {isEdit ? 'Fixed when the program was created.' : 'Cannot be changed after creation.'}
              </p>
            </div>

            {(isNist || (isEdit && program?.framework === 'NIST_800_53_REV5')) && (
              <div>
                <label htmlFor={fieldId('baseline')} className="block text-xs font-medium text-slate-300 mb-1">
                  Baseline <span className="text-rose-400">*</span>
                </label>
                {isEdit && program ? (
                  <div id={fieldId('baseline')} className="px-3 py-2 text-xs bg-slate-950/60 border border-slate-800 rounded-xl text-slate-300">
                    {baselineLabel(program.baseline)}
                  </div>
                ) : (
                  <select
                    id={fieldId('baseline')}
                    value={baseline}
                    onChange={(e) => setBaseline(e.target.value)}
                    disabled={isSaving}
                    className={inputClass}
                    {...errorProps('baseline')}
                  >
                    <option value="">Choose a baseline</option>
                    {BASELINE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                )}
                {fieldError('baseline')}
                {isEdit && program ? (
                  <>
                    <p className="mt-1 text-xs text-slate-400">Privacy baseline: {program.privacyBaseline ? 'Yes' : 'No'}</p>
                    <p className="mt-1 text-xs text-slate-400">Overlays: {programOverlayLabels(program.scoping).join(', ') || 'None'}. Change them from the Overlays menu in the header.</p>
                  </>
                ) : (
                  <label htmlFor={fieldId('privacyBaseline')} className="mt-2 flex items-start gap-2 text-xs text-slate-300">
                    <input
                      id={fieldId('privacyBaseline')}
                      type="checkbox"
                      checked={privacyBaseline}
                      onChange={(e) => { setPrivacyBaseline(e.target.checked); if (e.target.checked) setScoping((s) => ({ ...s, noPiiProcessing: false })); }}
                      disabled={isSaving}
                      className="mt-0.5"
                    />
                    <span>Also apply the SP 800-53B privacy baseline (the system processes PII)</span>
                  </label>
                )}
              </div>
            )}
          </div>

          {!isEdit && isNist && (
            <fieldset className="space-y-2 rounded-xl border border-slate-800 p-3" disabled={isSaving} aria-describedby={`${fieldId('scoping')}-help`}>
              <legend className="px-1 text-xs font-medium text-slate-300">Operational overlays (optional)</legend>
              <p id={`${fieldId('scoping')}-help`} className="text-xs text-slate-400">
                Tick the ones that describe this system. Each removes the controls that cannot apply to it, for everyone who works in this program, and lowers its control count. A Tenant Owner or MSP Admin can change them later from the Overlays menu in the header; every change is recorded.
              </p>
              {OVERLAY_KEYS.map((key) => {
                const piiLocked = key === 'noPiiProcessing' && privacyBaseline;
                const id = fieldId(`overlay-${key}`);
                return (
                  <label key={key} htmlFor={id} className={`flex items-start gap-2 text-xs ${piiLocked ? 'text-slate-400' : 'text-slate-300'}`}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={!piiLocked && Boolean(scoping[key])}
                      disabled={piiLocked}
                      aria-describedby={`${id}-detail`}
                      onChange={(e) => setScoping((s) => ({ ...s, [key]: e.target.checked }))}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-semibold">{OVERLAY_TITLES[key]}</span>
                      <span id={`${id}-detail`} className="block text-slate-400">
                        {piiLocked ? 'Not available with the privacy baseline (the system processes PII).' : OVERLAY_DETAILS[key]}
                      </span>
                    </span>
                  </label>
                );
              })}
              {fieldError('scoping')}
            </fieldset>
          )}

          <div>
            <label htmlFor={fieldId('description')} className="block text-xs font-medium text-slate-300 mb-1">
              Description
            </label>
            <textarea
              id={fieldId('description')}
              rows={2}
              maxLength={PROGRAM_TEXT_MAX}
              placeholder="What this effort covers (plain text)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSaving}
              className={`${inputClass} resize-y`}
              {...errorProps('description')}
            />
            {fieldError('description')}
          </div>

          <div>
            <label htmlFor={fieldId('boundarySummary')} className="block text-xs font-medium text-slate-300 mb-1">
              Boundary Description / System Summary
            </label>
            <textarea
              id={fieldId('boundarySummary')}
              rows={4}
              maxLength={PROGRAM_TEXT_MAX}
              placeholder="What is inside the authorization boundary (plain text)"
              value={boundarySummary}
              onChange={(e) => setBoundarySummary(e.target.value)}
              disabled={isSaving}
              className={`${inputClass} resize-y`}
              {...errorProps('boundarySummary')}
            />
            <p className="mt-1 text-xs text-slate-400 text-right font-mono">{boundarySummary.length} / {PROGRAM_TEXT_MAX}</p>
            {fieldError('boundarySummary')}
          </div>

          {!isEdit && (
            <fieldset className="space-y-2" disabled={isSaving}>
              <legend className="block text-xs font-medium text-slate-300 mb-1">Initial Seed</legend>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="radio" name={`${uid}-seed`} checked={seed === 'blank'} onChange={() => setSeed('blank')} />
                <span>Blank (every control starts not started)</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="radio"
                  name={`${uid}-seed`}
                  checked={seed === 'clone'}
                  disabled={openPrograms.length === 0}
                  onChange={() => {
                    setSeed('clone');
                    if (!sourceProgramId && openPrograms.length > 0) chooseSource(activeProgram?.id ?? openPrograms[0].id);
                  }}
                />
                <span>Clone from an existing program (copies notes and responsible roles, not evidence, imports or POA&M items)</span>
              </label>
              {seed === 'clone' && (
                <div>
                  <label htmlFor={fieldId('source')} className="sr-only">Program to clone from</label>
                  <select
                    id={fieldId('source')}
                    value={sourceProgramId}
                    onChange={(e) => chooseSource(e.target.value)}
                    className={inputClass}
                    {...errorProps('seed')}
                  >
                    <option value="">Choose a program</option>
                    {openPrograms.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({frameworkLabel(p.framework)})</option>
                    ))}
                  </select>
                </div>
              )}
              {fieldError('seed')}
            </fieldset>
          )}

          <ErrorNotice message={submitError} />

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={close}
              disabled={isSaving}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-500 rounded-xl shadow-lg shadow-brand-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Program'}
            </button>
          </div>
        </form>
      </div>
    </DialogOverlay>
  );
};

export default ProgramFormModal;
