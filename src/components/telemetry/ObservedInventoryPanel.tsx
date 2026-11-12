import React, { useId } from 'react';
import { Radar } from 'lucide-react';
import type { EnclaveAsset } from '../../types/telemetry';
import type { VmObservedHost } from '../../types/vm';
import { compareRecordedObserved } from '../../data/telemetry/observedInventory';
import type { ObservedComparisonRow, ObservedField } from '../../data/telemetry/observedInventory';
import { NOT_REPORTED, OBSERVED_COPY, OBSERVED_FIELD_LABEL, formatCpuSpeed, formatMemoryBytes, osText } from '../../data/telemetry/observedInventoryView';
import type { ObservedStatus } from '../../hooks/useObservedInventory';

const PROFILE_LABEL: Record<string, string> = {
  rhel9: 'Red Hat Enterprise Linux 9',
  rhel8: 'Red Hat Enterprise Linux 8',
  ubuntu2204: 'Ubuntu 22.04 LTS',
  win2022: 'Windows Server 2022',
  win11: 'Windows 11',
  cisco_ios: 'Cisco IOS / Network Device',
  custom: 'Custom / other',
};

interface ObservedInventoryPanelProps {
  status: ObservedStatus;
  hosts: VmObservedHost[];
  /** What the asset records today (the saved record, not the form). */
  recorded: Pick<EnclaveAsset, 'ipAddress' | 'macAddress' | 'osProfile' | 'serialNumber'>;
  /** The sentence under the heading: it says what the panel does and does not do. */
  note: string;
  onRetry: () => void;
  /** Present only where a value can be copied into a form: it shows "Use scanner value" on a row that differs and is usable. */
  onUseValue?: (row: ObservedComparisonRow) => void;
}

/** An ISO time as a readable date; the raw text is never shown, an unreadable time is "Not reported". */
function Moment({ iso }: { iso: string }): React.ReactElement {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return <>{NOT_REPORTED}</>;
  return <time dateTime={new Date(t).toISOString()}>{new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>;
}

const text = (v: string): string => (v.trim() === '' ? NOT_REPORTED : v);

/**
 * What the scanners last reported for one asset, beside what the asset records. Presentational: the caller loads the data. Every value
 * is rendered as a text node. A value reaches the asset record only through `onUseValue`, which fills a form field the person then saves.
 */
export const ObservedInventoryPanel: React.FC<ObservedInventoryPanelProps> = ({ status, hosts, recorded, note, onRetry, onUseValue }) => {
  const headingId = useId();
  const rows = compareRecordedObserved(recorded, hosts);

  const renderCompared = (host: VmObservedHost, field: ObservedField, observed: string) => {
    const row = rows.find((r) => r.sourceId === host.sourceId && r.field === field);
    const label = OBSERVED_FIELD_LABEL[field];
    const recordedText = row ? (field === 'os' ? PROFILE_LABEL[row.recorded] ?? row.recorded : row.recorded) : '';
    return (
      <div key={field} className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-slate-400">{label}</dt>
        <dd className="text-slate-200 min-w-0">
          <span className="font-mono break-words">{text(observed)}</span>
          {row?.differs && (
            <>
              {' '}
              <span className={`badge px-1.5 py-0.5 rounded text-xs font-semibold border ${row.recorded === '' ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                {row.recorded === '' ? OBSERVED_COPY.blank : OBSERVED_COPY.differs}
              </span>
              {row.recorded !== '' && <span className="block text-xs text-slate-400">Recorded: <span className="font-mono">{recordedText}</span></span>}
              {onUseValue && row.usable && (
                <button
                  type="button"
                  onClick={() => onUseValue(row)}
                  aria-label={`${OBSERVED_COPY.useValue}: ${label} from ${row.sourceLabel || 'the scanner'}`}
                  className="mt-1 px-2 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/40 text-xs font-semibold block"
                >
                  {OBSERVED_COPY.useValue}
                </button>
              )}
            </>
          )}
        </dd>
      </div>
    );
  };

  const plain = (key: string, label: string, value: string) => (
    <div key={key} className="grid grid-cols-[8rem_1fr] gap-x-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-slate-200 font-mono break-words min-w-0">{value}</dd>
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3 text-xs">
      <div>
        <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-bold text-cyan-300">
          <Radar className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{OBSERVED_COPY.heading}</span>
        </h3>
        <p className="text-slate-400 mt-1">{note}</p>
      </div>

      {status === 'loading' || status === 'idle' ? (
        <p role="status" className="text-slate-400">{OBSERVED_COPY.loading}</p>
      ) : status === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
          <span>{OBSERVED_COPY.loadError}</span>
          <button type="button" onClick={onRetry} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0">{OBSERVED_COPY.retry}</button>
        </div>
      ) : status === 'gone' ? (
        <p role="status" className="text-slate-300">{OBSERVED_COPY.gone}</p>
      ) : hosts.length === 0 ? (
        <p className="text-slate-400">{OBSERVED_COPY.empty}</p>
      ) : (
        <ul className="space-y-3">
          {hosts.map((h) => {
            const hw = h.hardware;
            const platform = [h.os.platform, h.os.kernel].map((p) => p.trim()).filter(Boolean).join(' · ');
            return (
              <li key={h.sourceId} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 space-y-2">
                <p className="font-semibold text-slate-200">
                  <span>{h.sourceLabel || 'Scanner'}</span>
                  {h.hostname && <span className="font-mono font-normal text-slate-400"> · {h.hostname}</span>}
                </p>
                <dl className="space-y-1">
                  {renderCompared(h, 'ipAddress', h.ipAddress)}
                  {renderCompared(h, 'macAddress', h.macAddress)}
                  {renderCompared(h, 'os', osText(h))}
                  {plain('platform', 'Platform / kernel', text(platform))}
                  {plain('arch', 'Architecture', text(hw?.architecture ?? ''))}
                  {plain('cpu', 'CPU', text(hw?.cpuName ?? ''))}
                  {plain('cores', 'CPU cores', hw?.cpuCores != null ? String(hw.cpuCores) : NOT_REPORTED)}
                  {plain('speed', 'CPU speed', formatCpuSpeed(hw?.cpuMhz))}
                  {plain('memory', 'Memory', formatMemoryBytes(hw?.memoryBytes))}
                  {renderCompared(h, 'serialNumber', hw?.serialNumber ?? '')}
                  <div className="grid grid-cols-[8rem_1fr] gap-x-3">
                    <dt className="text-slate-400">Installed software</dt>
                    <dd className="text-slate-200 font-mono">{h.softwareReported ? `${h.softwareCount} ${h.softwareCount === 1 ? 'item' : 'items'}` : NOT_REPORTED}</dd>
                  </div>
                  <div className="grid grid-cols-[8rem_1fr] gap-x-3">
                    <dt className="text-slate-400">First seen</dt>
                    <dd className="text-slate-200"><Moment iso={h.firstSeenAt} /></dd>
                  </div>
                </dl>
                {hw === null && <p className="text-slate-400">{OBSERVED_COPY.noHardware}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
