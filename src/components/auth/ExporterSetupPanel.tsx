import React, { useId, useMemo, useState } from 'react';
import { Terminal, Copy, Check, Download, ChevronRight } from 'lucide-react';
import { copyText } from '../../utils/clipboard';
import {
  DEFAULT_ENV_PATH, DEFAULT_LABELS, EXPORTER_ENV_FILENAME, EXPORTER_SETUP_COPY, EXPORTER_SOURCES, TROUBLESHOOTING,
  buildExporterEnv, checkCommand, dryRunCommand, installCommand, runCommand,
} from '../../data/telemetry/exporterSetup';
import type { ExporterSource, WazuhMode } from '../../data/telemetry/exporterSetup';

/**
 * Exporter setup: a generated env file and the install / check / dry-run / run commands for pbc-vm-exporter. The service token is never part
 * of this text (the panel does not receive it): the person pastes the token they copied. Everything is rendered as text; nothing is logged,
 * stored or sent anywhere.
 */
const INPUT_CLASS = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus:border-brand-500';
const LABEL_CLASS = 'block text-xs font-semibold text-slate-300 mb-1';
const SMALL_BUTTON_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

const CopyButton: React.FC<{ text: string; label: string; caption?: string }> = ({ text, label, caption }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onCopy = () => {
    void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'));
  };
  return (
    <>
      <button type="button" onClick={onCopy} aria-label={label} className={SMALL_BUTTON_CLASS}>
        {state === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        <span>{state === 'copied' ? EXPORTER_SETUP_COPY.copied : (caption ?? 'Copy')}</span>
      </button>
      <span role="status" aria-live="polite" className={state === 'failed' ? 'text-amber-200 text-xs' : 'sr-only'}>
        {state === 'failed' ? EXPORTER_SETUP_COPY.copyFailed : ''}
      </span>
    </>
  );
};

const CommandRow: React.FC<{ heading: string; command: string }> = ({ heading, command }) => (
  <div className="space-y-1">
    <p className="text-slate-300 font-semibold">{heading}</p>
    <div className="flex items-start gap-2">
      <pre tabIndex={0} aria-label={heading} className="flex-1 min-w-0 p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 font-mono text-xs text-brand-300 overflow-x-auto whitespace-pre focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">{command}</pre>
      <CopyButton text={command} label={`Copy command: ${heading}`} />
    </div>
  </div>
);

export const ExporterSetupPanel: React.FC = () => {
  const [source, setSource] = useState<ExporterSource>('wazuh');
  const [wazuhMode, setWazuhMode] = useState<WazuhMode>('indexer');
  const [pbcUrl, setPbcUrl] = useState(() => (typeof window !== 'undefined' ? window.location.origin : ''));
  const [label, setLabel] = useState('');
  const headingId = useId();
  const sourceId = useId();
  const modeId = useId();
  const urlId = useId();
  const labelId = useId();

  const envText = useMemo(() => buildExporterEnv({ source, pbcUrl, label, wazuhMode }), [source, pbcUrl, label, wazuhMode]);

  const onDownload = () => {
    const blob = new Blob([envText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = EXPORTER_ENV_FILENAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3 text-xs pt-4 border-t border-slate-800">
      <div>
        <h3 id={headingId} className="text-sm font-bold text-white flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />{EXPORTER_SETUP_COPY.heading}
        </h3>
        <p className="text-slate-400 leading-relaxed mt-1">{EXPORTER_SETUP_COPY.intro}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={sourceId} className={LABEL_CLASS}>{EXPORTER_SETUP_COPY.sourceLabel}</label>
          <select id={sourceId} value={source} onChange={(e) => setSource(e.target.value as ExporterSource)} className={INPUT_CLASS}>
            {EXPORTER_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        {source === 'wazuh' && (
          <div>
            <label htmlFor={modeId} className={LABEL_CLASS}>{EXPORTER_SETUP_COPY.modeLabel}</label>
            <select id={modeId} value={wazuhMode} onChange={(e) => setWazuhMode(e.target.value as WazuhMode)} className={INPUT_CLASS}>
              <option value="indexer">{EXPORTER_SETUP_COPY.modeIndexer}</option>
              <option value="api">{EXPORTER_SETUP_COPY.modeApi}</option>
            </select>
          </div>
        )}
        <div>
          <label htmlFor={urlId} className={LABEL_CLASS}>{EXPORTER_SETUP_COPY.urlLabel}</label>
          <input id={urlId} type="text" value={pbcUrl} onChange={(e) => setPbcUrl(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${urlId}-help`} className={INPUT_CLASS} />
          <p id={`${urlId}-help`} className="mt-1 text-slate-400">{EXPORTER_SETUP_COPY.urlHelp}</p>
        </div>
        <div>
          <label htmlFor={labelId} className={LABEL_CLASS}>{EXPORTER_SETUP_COPY.labelLabel}</label>
          <input id={labelId} type="text" value={label} placeholder={DEFAULT_LABELS[source]} onChange={(e) => setLabel(e.target.value)} maxLength={128} autoComplete="off" spellCheck={false} aria-describedby={`${labelId}-help`} className={INPUT_CLASS} />
          <p id={`${labelId}-help`} className="mt-1 text-slate-400">{EXPORTER_SETUP_COPY.labelHelp}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-slate-300 font-semibold">{EXPORTER_SETUP_COPY.envHeading}</p>
        <p className="text-slate-400">{EXPORTER_SETUP_COPY.envNote}</p>
        <pre tabIndex={0} aria-label={EXPORTER_SETUP_COPY.envHeading} className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 font-mono text-xs text-brand-300 overflow-x-auto whitespace-pre max-h-64 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">{envText}</pre>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={envText} label="Copy the settings file text" caption={EXPORTER_SETUP_COPY.copyEnv} />
          <button type="button" onClick={onDownload} aria-label={EXPORTER_SETUP_COPY.download} className={SMALL_BUTTON_CLASS}>
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{EXPORTER_SETUP_COPY.download}</span>
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-slate-300 font-semibold">{EXPORTER_SETUP_COPY.commandsHeading}</p>
        <p className="text-slate-400">{EXPORTER_SETUP_COPY.commandsNote}</p>
        <CommandRow heading={EXPORTER_SETUP_COPY.stepInstall} command={installCommand()} />
        <CommandRow heading={EXPORTER_SETUP_COPY.stepCheck} command={checkCommand(DEFAULT_ENV_PATH, source)} />
        <CommandRow heading={EXPORTER_SETUP_COPY.stepDryRun} command={dryRunCommand(DEFAULT_ENV_PATH, source)} />
        <CommandRow heading={EXPORTER_SETUP_COPY.stepRun} command={runCommand(DEFAULT_ENV_PATH, source)} />
      </div>

      <details className="group rounded-xl border border-slate-800 bg-slate-900/50">
        <summary className="cursor-pointer select-none list-none flex items-center gap-1.5 px-3 py-2 text-slate-200 font-semibold rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" aria-hidden="true" />
          {EXPORTER_SETUP_COPY.troubleshooting}
        </summary>
        <dl className="px-3 pb-3 space-y-2.5">
          {TROUBLESHOOTING.map((row) => (
            <div key={row.symptom}>
              <dt className="font-semibold text-slate-200">{row.symptom}</dt>
              <dd className="text-slate-400 leading-relaxed">{row.fix}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
};
