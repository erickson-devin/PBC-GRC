import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ListPlus, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import { catalogEntryToInput, searchCatalog, suggestedControlsForProgram, type ToolCatalog, type ToolCatalogEntry } from '../../data/inventory/toolCatalog';
import { loadToolCatalog } from '../../data/inventory/toolCatalogLazy';
import {
  DEPLOYMENT_LABELS,
  INVENTORY_UI_TEXT,
  TOOL_TYPE_LABELS,
  batchResultText,
  catalogMarker,
  toolErrorMessage,
} from '../../data/inventory/inventoryUiView';
import type { ToolInputWithSeed } from '../../data/inventory/inventorySchema';
import { MAX_BATCH, type InventoryTool, type ToolBatchResult, type ToolDeployment, type ToolType } from '../../types/inventory';
import type { CmmcAssetCategory } from '../../types/telemetry';

interface ToolQuickAddDialogProps {
  tools: InventoryTool[];
  /** How many more tools the register can hold. */
  limitLeft: number;
  /** The open program: its name, whether its boundary and links are loaded, whether it declared its tools, and its control ids. */
  program: { name: string; ready: boolean; declared: boolean; catalogIds: ReadonlySet<string> } | null;
  onBatch: (items: ToolInputWithSeed[]) => Promise<ToolBatchResult>;
  onAddToBoundary: (ids: string[]) => Promise<void>;
  onLinkControls: (toolId: string, controlIds: string[]) => Promise<void>;
  /** Opens the add dialog for a tool that is not in the catalog. */
  onAddByHand: () => void;
  /** Everything went through: the text for the panel's notification. */
  onDone: (text: string) => void;
  onClose: () => void;
}

type Picked = { deployment: ToolDeployment; assetCategory: CmmcAssetCategory };

const inputClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** Quick add: tick tools from the shipped catalog; type, deployment and asset category are suggestions. Nothing is written until Add. */
export const ToolQuickAddDialog: React.FC<ToolQuickAddDialogProps> = ({ tools, limitLeft, program, onBatch, onAddToBoundary, onLinkControls, onAddByHand, onDone, onClose }) => {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const [type, setType] = useState<ToolType | 'ALL'>('ALL');
  const [picked, setPicked] = useState<Map<string, Picked>>(() => new Map());
  const [addToBoundary, setAddToBoundary] = useState(false);
  const [linkSuggested, setLinkSuggested] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const doneRef = useRef<HTMLButtonElement>(null);
  const uid = useId();

  useEffect(() => {
    let cancelled = false;
    setCatalogStatus('loading');
    loadToolCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setCatalogStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setCatalogStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const types = useMemo(() => {
    const present = new Set((catalog?.tools ?? []).map((e) => e.toolType));
    return (Object.keys(TOOL_TYPE_LABELS) as ToolType[]).filter((t) => present.has(t));
  }, [catalog]);
  const shown = useMemo(() => (catalog ? searchCatalog(catalog, q, type === 'ALL' ? undefined : type) : []), [catalog, q, type]);
  const entriesById = useMemo(() => new Map((catalog?.tools ?? []).map((e) => [e.id, e])), [catalog]);
  const pickedEntries = [...picked.keys()].map((id) => entriesById.get(id)).filter((e): e is ToolCatalogEntry => Boolean(e));

  const programReady = Boolean(program?.ready);
  // The links each ticked tool would get in the open program, by the seed key its register entry will carry
  const suggestionsBySeed = useMemo(() => {
    const out = new Map<string, string[]>();
    if (!program?.ready) return out;
    for (const e of pickedEntries) out.set(`catalog:${e.id}`, suggestedControlsForProgram(e, program.catalogIds));
    return out;
  }, [picked, entriesById, program]);
  const linkCount = [...suggestionsBySeed.values()].reduce((n, ids) => n + ids.length, 0);
  const linkDisabled = Boolean(program?.declared) && !addToBoundary;

  const cap = Math.min(MAX_BATCH, limitLeft);
  const overCap = picked.size > cap;
  const locked = saving || result !== null;

  const toggle = (e: ToolCatalogEntry, on: boolean): void =>
    setPicked((m) => {
      const next = new Map(m);
      if (on) next.set(e.id, { deployment: e.deployments[0], assetCategory: e.defaultAssetCategory });
      else next.delete(e.id);
      return next;
    });
  const patch = (id: string, change: Partial<Picked>): void =>
    setPicked((m) => {
      const cur = m.get(id);
      if (!cur) return m;
      return new Map(m).set(id, { ...cur, ...change });
    });

  const submit = async (): Promise<void> => {
    if (locked || picked.size === 0 || overCap) return;
    setSaving(true);
    setError(null);
    try {
      const items = pickedEntries.map((e) => catalogEntryToInput(e, { deployment: picked.get(e.id)?.deployment, assetCategory: picked.get(e.id)?.assetCategory }));
      const res = await onBatch(items);
      const ids = res.created.map((t) => t.id);
      let boundaryFailed = false;
      if (addToBoundary && ids.length > 0) {
        try {
          await onAddToBoundary(ids);
        } catch {
          boundaryFailed = true;
        }
      }
      let linkFailures = 0;
      if (linkSuggested) {
        for (const t of res.created) {
          const ids2 = suggestionsBySeed.get(t.seedKey ?? '') ?? [];
          if (ids2.length === 0) continue;
          try {
            await onLinkControls(t.id, ids2);
          } catch {
            linkFailures++;
          }
        }
      }
      const text = batchResultText(res.created.length, res.skipped, linkFailures) + (boundaryFailed ? " They are in the register but could not be added to the boundary: tick \"In this boundary\" on each tool." : '');
      if (res.skipped.length === 0 && linkFailures === 0 && !boundaryFailed) onDone(text);
      else {
        setResult(text);
        setSaving(false);
        setTimeout(() => doneRef.current?.focus(), 0);
      }
    } catch (err: unknown) {
      setError(toolErrorMessage(err, 'batch'));
      setSaving(false);
    }
  };

  const n = picked.size;

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl text-slate-100 z-10 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-6 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <ListPlus className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">Quick add from the tool catalog</DialogTitle>
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

        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
          <p className="text-slate-400">{INVENTORY_UI_TEXT.quickAddIntro}</p>

          {catalogStatus === 'loading' && <p role="status" className="text-slate-400">{INVENTORY_UI_TEXT.catalogLoading}</p>}
          {catalogStatus === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={INVENTORY_UI_TEXT.catalogFailed} className="flex-1" />
              <button type="button" onClick={() => setAttempt((a) => a + 1)} className={secondaryButton}>Try again</button>
            </div>
          )}

          {catalog && (
            <>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="search"
                  aria-label="Search the catalog"
                  value={q}
                  disabled={locked}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by tool, vendor or alias…"
                  className={`${inputClass} flex-1`}
                />
                <select aria-label="Tool type" value={type} disabled={locked} onChange={(e) => setType(e.target.value as ToolType | 'ALL')} className={inputClass}>
                  <option value="ALL">All types</option>
                  {types.map((t) => (
                    <option key={t} value={t}>{TOOL_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <p aria-live="polite" className="text-slate-400">{`Showing ${shown.length} of ${catalog.tools.length} tools. ${n} ticked.`}</p>

              <ul aria-label="Catalog tools" className="max-h-72 overflow-y-auto divide-y divide-slate-800/60 rounded-xl border border-slate-800 bg-slate-950/60">
                {shown.map((e) => {
                  const inRegister = catalogMarker(e, tools) === 'in_register';
                  const cid = `${uid}-${e.id}`;
                  return (
                    <li key={e.id} className="flex items-start gap-2.5 px-3 py-2">
                      <input
                        id={cid}
                        type="checkbox"
                        checked={picked.has(e.id)}
                        disabled={inRegister || locked}
                        onChange={(ev) => toggle(e, ev.target.checked)}
                        className="mt-0.5 accent-cyan-500"
                      />
                      <label htmlFor={cid} className="flex-1 min-w-0 cursor-pointer">
                        <span className="font-semibold text-white">{e.name}</span>
                        {e.vendor && <span className="ml-2 text-slate-400">{e.vendor}</span>}
                        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[10px] text-slate-300">{TOOL_TYPE_LABELS[e.toolType]}</span>
                        <span className="block text-slate-400">{e.mission}</span>
                      </label>
                      {inRegister && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold">Already in the register</span>
                      )}
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="px-3 py-4 text-slate-400">No catalog tools match.</li>}
              </ul>

              {pickedEntries.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold text-slate-300">{`Ticked (${pickedEntries.length})`}</h3>
                  <ul className="space-y-1.5">
                    {pickedEntries.map((e) => {
                      const p = picked.get(e.id) as Picked;
                      return (
                        <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                          <span className="flex-1 min-w-[10rem] font-semibold text-white">{e.name}</span>
                          <select
                            aria-label={`Deployment of ${e.name}`}
                            value={p.deployment}
                            disabled={locked}
                            onChange={(ev) => patch(e.id, { deployment: ev.target.value as ToolDeployment })}
                            className={inputClass}
                          >
                            {e.deployments.map((d) => (
                              <option key={d} value={d}>{DEPLOYMENT_LABELS[d]}</option>
                            ))}
                          </select>
                          <select
                            aria-label={`CMMC asset category of ${e.name}`}
                            value={p.assetCategory}
                            disabled={locked}
                            onChange={(ev) => patch(e.id, { assetCategory: ev.target.value as CmmcAssetCategory })}
                            className={inputClass}
                          >
                            {CMMC_ASSET_CATEGORIES.map((c) => (
                              <option key={c} value={c}>{`${CATEGORY_INFO[c].label}${c === e.defaultAssetCategory ? ' (suggested)' : ''}`}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            aria-label={`Untick ${e.name}`}
                            disabled={locked}
                            onClick={() => toggle(e, false)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {programReady && program && (
                <div className="space-y-2">
                  {program.declared && (
                    <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={addToBoundary}
                        disabled={locked}
                        onChange={(e) => {
                          setAddToBoundary(e.target.checked);
                          if (!e.target.checked) setLinkSuggested(false);
                        }}
                        className="accent-cyan-500"
                      />
                      <span>{`Add them to ${program.name}'s boundary`}</span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={linkSuggested}
                      disabled={locked || linkDisabled}
                      onChange={(e) => setLinkSuggested(e.target.checked)}
                      aria-describedby={`${uid}-link-hint`}
                      className="accent-cyan-500"
                    />
                    <span>{`Also link their suggested controls in ${program.name} (${linkCount} ${linkCount === 1 ? 'link' : 'links'})`}</span>
                  </label>
                  <p id={`${uid}-link-hint`} className="text-slate-400">
                    {INVENTORY_UI_TEXT.quickAddLinkHint}
                    {linkDisabled ? ` ${INVENTORY_UI_TEXT.quickAddNeedsBoundary}` : ''}
                  </p>
                </div>
              )}
            </>
          )}

          {overCap && <p role="alert" className="text-rose-300">{limitLeft < MAX_BATCH ? INVENTORY_UI_TEXT.limitReached : INVENTORY_UI_TEXT.quickAddMax}</p>}
          <ErrorNotice message={error} />
          {result && <p role="status" className="text-emerald-300">{result}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 p-6 pt-3 border-t border-slate-800">
          <p className="basis-full text-[11px] text-slate-500">{catalog?._meta.notice ?? ''}</p>
          <button type="button" onClick={onAddByHand} disabled={locked} className="mr-auto text-xs text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline disabled:opacity-50">
            Not listed? Add a tool by hand
          </button>
          {result ? (
            <button type="button" ref={doneRef} onClick={onClose} className="btn-primary px-3 py-1.5 rounded-xl text-xs">Done</button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>Cancel</button>
              <button type="button" onClick={() => void submit()} disabled={saving || n === 0 || overCap} className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">
                {saving ? 'Adding…' : `Add ${n} ${n === 1 ? 'tool' : 'tools'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ToolQuickAddDialog;
