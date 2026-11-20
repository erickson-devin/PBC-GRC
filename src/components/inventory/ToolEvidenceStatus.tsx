import React, { useId } from 'react';
import { ErrorNotice } from '../common/ErrorNotice';
import { INVENTORY_UI_TEXT, type ProgramParts } from '../../data/inventory/inventoryUiView';
import type { EvidenceStatusRow } from '../../data/inventory/toolRegisterView';

interface ToolEvidenceStatusProps {
  state: ProgramParts;
  programName: string | null;
  rows: EvidenceStatusRow[];
  toolNames: Record<string, string>;
  tools: { id: string; name: string }[];
  /** 'ALL' or a tool id. */
  toolFilter: string;
  onToolFilter: (id: string) => void;
  includeNonSource: boolean;
  onIncludeNonSource: (on: boolean) => void;
  displayId: (id: string) => string;
  statusLabel: (s: string) => string;
  onOpenControl: (id: string) => void;
}

const inputClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500';

/** For each control a tool is linked to in the open program: the control's status and how many evidence files it has. Presentational. */
export const ToolEvidenceStatus: React.FC<ToolEvidenceStatusProps> = ({
  state, programName, rows, toolNames, tools, toolFilter, onToolFilter, includeNonSource, onIncludeNonSource, displayId, statusLabel, onOpenControl,
}) => {
  const hId = useId();
  const checkId = useId();

  let body: React.ReactNode;
  if (state === 'no_program' || state === 'unsupported') {
    body = <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.evidenceNoProgram}</p>;
  } else if (state === 'loading') {
    body = <p role="status" className="text-xs text-slate-400">Loading the control links…</p>;
  } else if (state === 'error') {
    body = <ErrorNotice message={INVENTORY_UI_TEXT.programFailed} />;
  } else {
    body = (
      <>
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
          <select aria-label="Tool" value={toolFilter} onChange={(e) => onToolFilter(e.target.value)} className={inputClass}>
            <option value="ALL">All tools</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <label htmlFor={checkId} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input id={checkId} type="checkbox" checked={includeNonSource} onChange={(e) => onIncludeNonSource(e.target.checked)} className="accent-cyan-500" />
            <span>Include links not marked as an evidence source</span>
          </label>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
          <table className="table w-full text-left text-xs border-collapse min-w-[40rem]">
            <caption className="sr-only">Evidence status by tool</caption>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                <th scope="col" className="py-2.5 px-3">Tool</th>
                <th scope="col" className="py-2.5 px-3">Control</th>
                <th scope="col" className="py-2.5 px-3">Status</th>
                <th scope="col" className="py-2.5 px-3">Evidence files</th>
                <th scope="col" className="py-2.5 px-3">Evidence source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">{INVENTORY_UI_TEXT.evidenceEmpty}</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={`${r.toolId}:${r.controlId}`} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-3 font-semibold text-white">{toolNames[r.toolId] ?? ''}</td>
                    <td className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => onOpenControl(r.controlId)}
                        aria-label={`Open control ${displayId(r.controlId)}`}
                        className="text-left text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded"
                      >
                        <span className="font-mono">{displayId(r.controlId)}</span> {r.controlTitle}
                      </button>
                    </td>
                    <td className="py-3 px-3 text-slate-300">{statusLabel(r.status)}</td>
                    <td className="py-3 px-3">
                      <span className="font-mono text-slate-200">{r.evidenceCount}</span>
                      {r.evidenceCount === 0 && (
                        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-semibold">No evidence</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-slate-300">{r.evidenceSource ? 'Yes' : 'No'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby={hId} className="space-y-4">
      <h3 id={hId} className="text-sm font-bold text-white">Evidence status{programName ? ` in ${programName}` : ''}</h3>
      <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.evidenceIntro}</p>
      {body}
    </section>
  );
};

export default ToolEvidenceStatus;
