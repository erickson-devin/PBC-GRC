import React, { useId, useMemo, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { evidenceChoices } from '../../data/inventory/vendorRegisterView';
import type { EvidenceItem } from '../../types';

export interface EvidenceAttachFieldsetProps {
  /** The fieldset legend, e.g. `Attach a document`. */
  legend: string;
  /** The program's evidence files to pick from. */
  evidence: Pick<EvidenceItem, 'id' | 'name' | 'controlId'>[];
  displayId: (id: string) => string;
  /** The controls a new file can be filed under. */
  uploadControls: Array<{ id: string; label: string }>;
  defaultControlId: string | null;
  uploadHint: string;
  /** When set, uploading is not offered: the radio is disabled and this reason is shown under it. */
  uploadDisabledReason?: string | null;
  /** Evidence files that are already attached: shown in the list but not selectable. */
  disabledEvidenceIds?: ReadonlySet<string>;
  /** Rendered above the source choice (the vendor's document-type select, or a "primary" checkbox). */
  extra?: React.ReactNode;
  submitLabel: string;
  busy: boolean;
  /** Resolve to clear the entries; reject to keep them. The caller shows its own errors and status. */
  onAttachExisting: (evidenceId: string) => Promise<void>;
  onUpload: (controlId: string, file: File) => Promise<void>;
}

type Source = 'existing' | 'upload';

const fieldClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';

/**
 * The "attach a file" form of a program's Evidence Vault: pick a file that is already there, or upload one filed under a control. It only
 * collects the choice; the caller does the upload and the link, and decides what a failure says. File names are shown, never logged.
 */
export const EvidenceAttachFieldset: React.FC<EvidenceAttachFieldsetProps> = ({
  legend, evidence, displayId, uploadControls, defaultControlId, uploadHint, uploadDisabledReason, disabledEvidenceIds, extra, submitLabel, busy, onAttachExisting, onUpload,
}) => {
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const [source, setSource] = useState<Source>('existing');
  const [evidenceId, setEvidenceId] = useState('');
  const [controlId, setControlId] = useState(defaultControlId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const choices = useMemo(() => evidenceChoices(evidence), [evidence]);
  const uploadOff = !!uploadDisabledReason;
  const complete = source === 'existing' ? evidenceId !== '' : controlId !== '' && file !== null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !complete) return;
    try {
      if (source === 'upload' && file) await onUpload(controlId, file);
      else await onAttachExisting(evidenceId);
      setEvidenceId('');
      setFile(null);
      setFileKey((k) => k + 1);
    } catch {
      // the caller already showed the error; the entries stay so the person can try again
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="text-xs">
      <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
        <legend className="px-1 font-semibold text-slate-300">{legend}</legend>
        {extra}

        <fieldset>
          <legend className={labelClass}>Source</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(
              [
                ['existing', 'A file already in the Evidence Vault'],
                ['upload', 'Upload a new file'],
              ] as const
            ).map(([v, text]) => {
              const off = v === 'upload' && uploadOff;
              return (
                <div key={v}>
                  <label
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
                      off ? 'border-slate-800 bg-slate-800/30 text-slate-500 cursor-not-allowed' : 'cursor-pointer'
                    } ${
                      off ? '' : source === v ? 'border-cyan-500/60 bg-cyan-500/10 text-white' : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <input
                      type="radio"
                      name={id('source')}
                      value={v}
                      checked={source === v}
                      disabled={off}
                      aria-describedby={off ? id('uploadOff') : undefined}
                      onChange={() => setSource(v)}
                      className="accent-cyan-500"
                    />
                    <span>{text}</span>
                  </label>
                  {off && <p id={id('uploadOff')} className="mt-1 text-[11px] text-slate-400">{uploadDisabledReason}</p>}
                </div>
              );
            })}
          </div>
        </fieldset>

        {source === 'existing' ? (
          choices.length === 0 ? (
            <p className="text-slate-400">This program has no evidence files yet.</p>
          ) : (
            <div>
              <label htmlFor={id('file')} className={labelClass}>File</label>
              <select id={id('file')} value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} className={fieldClass}>
                <option value="">Choose a file</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id} disabled={disabledEvidenceIds?.has(c.id) === true}>{`${c.name} (${displayId(c.controlId)})`}</option>
                ))}
              </select>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor={id('control')} className={labelClass}>File it under control</label>
              <select id={id('control')} value={controlId} onChange={(e) => setControlId(e.target.value)} aria-describedby={id('uploadHint')} className={fieldClass}>
                <option value="">Choose a control</option>
                {uploadControls.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <p id={id('uploadHint')} className="mt-1 text-slate-400">{uploadHint}</p>
            </div>
            <div>
              <label htmlFor={id('upload')} className={labelClass}>File to upload</label>
              <input
                key={fileKey}
                id={id('upload')}
                type="file"
                aria-describedby={id('uploadHint')}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:text-slate-200 file:text-xs"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={busy || !complete} className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
            <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{busy ? 'Attaching…' : submitLabel}</span>
          </button>
        </div>
      </fieldset>
    </form>
  );
};

export default EvidenceAttachFieldset;
