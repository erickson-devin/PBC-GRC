import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link2, Plus, Unlink, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks/frameworkRegistry';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { suggestedControlsForProgram } from '../../data/inventory/toolCatalog';
import { loadToolCatalog } from '../../data/inventory/toolCatalogLazy';
import {
  INVENTORY_UI_TEXT,
  linkDiff,
  linkDiffText,
  rebaseLinks,
  searchControls,
  searchLimitLine,
  toolErrorMessage,
} from '../../data/inventory/inventoryUiView';
import type { InventoryTool, ToolControlLink } from '../../types/inventory';

interface ToolControlsEditorProps {
  tool: InventoryTool;
  programName: string;
  framework: string;
  controls: Array<{ id: string; title: string; domain: string }>;
  displayId: (id: string) => string;
  /** This tool's links in the open program. */
  links: ToolControlLink[];
  declared: boolean;
  inBoundary: boolean;
  canEdit: boolean;
  /** Saves the links; `expectedIds` is the set of control ids the editor last saw. Rejects with the ApiError. */
  onSave: (next: { controlId: string; evidenceSource: boolean }[], expectedIds: string[]) => Promise<ToolControlLink[]>;
  onAddToBoundary: () => Promise<void>;
  onClose: () => void;
}

const inputClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const sig = (links: ToolControlLink[]): string =>
  links.map((l) => `${l.controlId}:${l.evidenceSource ? 1 : 0}`).sort().join('|');

/**
 * The controls a tool is linked to in the open program. A link says the tool helps meet the control (a compliance assertion), so nothing is added
 * for the person except a suggestion they choose to apply; the footer says what Save will change.
 */
export const ToolControlsEditor: React.FC<ToolControlsEditorProps> = ({
  tool, programName, framework, controls, displayId, links, declared, inBoundary, canEdit, onSave, onAddToBoundary, onClose,
}) => {
  const [draft, setDraft] = useState<ToolControlLink[]>(links);
  const [baseIds, setBaseIds] = useState<string[]>(() => links.map((l) => l.controlId));
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('ALL');
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const uid = useId();
  const linksRef = useRef(links);
  linksRef.current = links;
  const baseIdsRef = useRef(baseIds);
  baseIdsRef.current = baseIds;
  const pendingRebase = useRef<string | null>(null);
  const savedLinks = useRef<ToolControlLink[]>(links);

  const notInBoundary = declared && !inBoundary;
  const editable = canEdit && !notInBoundary;
  const byId = useMemo(() => new Map(controls.map((c) => [c.id, c])), [controls]);
  const domains = useMemo(() => Object.values(FRAMEWORK_REGISTRY[framework]?.domains ?? {}), [framework]);
  const draftIds = useMemo(() => new Set(draft.map((l) => l.controlId)), [draft]);
  const diff = linkDiff(savedLinks.current, draft);
  const diffCount = diff.added + diff.removed + diff.changed;
  const search = useMemo(() => searchControls(controls, q, domain, displayId), [controls, q, domain, displayId]);
  const limitLine = searchLimitLine(search.shown.length, search.total);

  // Suggestions for a tool that came from the catalog: the controls it typically supports that this program has
  useEffect(() => {
    if (!canEdit || !tool.seedKey?.startsWith('catalog:')) return undefined;
    let cancelled = false;
    const entryId = tool.seedKey.slice('catalog:'.length);
    void loadToolCatalog()
      .then((cat) => {
        const entry = cat.tools.find((e) => e.id === entryId);
        if (!cancelled && entry) setSuggestions(suggestedControlsForProgram(entry, new Set(controls.map((c) => c.id))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tool.seedKey, canEdit]);
  const newSuggestions = (suggestions ?? []).filter((id) => !draftIds.has(id));

  const doRebase = (server: ToolControlLink[]): void => {
    if (pendingRebase.current === null) return;
    pendingRebase.current = null;
    setDraft((d) => rebaseLinks(baseIdsRef.current, server, d));
    setBaseIds(server.map((l) => l.controlId));
    savedLinks.current = server;
  };

  // After a stale write the hook reloads the program's links: take them as the new base once they arrive
  useEffect(() => {
    if (pendingRebase.current !== null && sig(links) !== pendingRebase.current) doRebase(links);
  }, [links]);

  const save = async (): Promise<void> => {
    if (saving || diffCount === 0) return;
    setSaving(true);
    setBanner(null);
    try {
      await onSave(draft.map((l) => ({ controlId: l.controlId, evidenceSource: l.evidenceSource })), baseIds);
      onClose();
    } catch (err: unknown) {
      if ((err as { reason?: unknown } | null)?.reason === 'stale_write') {
        pendingRebase.current = sig(linksRef.current);
        setBanner(INVENTORY_UI_TEXT.linksStale);
        setTimeout(() => doRebase(linksRef.current), 1500);
      } else {
        setBanner(toolErrorMessage(err, 'links', programName));
      }
      setSaving(false);
    }
  };

  const requestClose = (): void => {
    if (canEdit && diffCount > 0) setConfirmDiscard(true);
    else onClose();
  };

  const setEvidence = (id: string, on: boolean): void => setDraft((d) => d.map((l) => (l.controlId === id ? { ...l, evidenceSource: on } : l)));
  const unlink = (id: string): void => setDraft((d) => d.filter((l) => l.controlId !== id));
  const toggle = (id: string, on: boolean): void =>
    setDraft((d) => (on ? (d.some((l) => l.controlId === id) ? d : [...d, { toolId: tool.id, controlId: id, evidenceSource: false }]) : d.filter((l) => l.controlId !== id)));
  const addSuggested = (): void =>
    setDraft((d) => [...d, ...newSuggestions.filter((id) => !d.some((l) => l.controlId === id)).map((id) => ({ toolId: tool.id, controlId: id, evidenceSource: false }))]);

  return (
    <DialogOverlay onClose={saving ? undefined : requestClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : requestClose} />
      <div className="relative w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Link2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">{`Controls for ${tool.name}`}</DialogTitle>
              <p className="text-xs text-slate-400 mt-0.5">{`${programName} (${frameworkLabel(framework)}). ${INVENTORY_UI_TEXT.linksIntro}`}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <ErrorNotice message={banner} />

        {notInBoundary && (
          <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <span>{INVENTORY_UI_TEXT.linksNotInBoundary}</span>
            {canEdit && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  setBanner(null);
                  onAddToBoundary()
                    .catch((err: unknown) => setBanner(toolErrorMessage(err, 'boundary', programName)))
                    .finally(() => setSaving(false));
                }}
                className={secondaryButton}
              >
                Add to boundary
              </button>
            )}
          </div>
        )}
        {!canEdit && <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.linksReadOnly}</p>}

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-300">{`Linked controls (${draft.length})`}</h3>
          {draft.length === 0 ? (
            <p className="text-xs text-slate-400">No controls linked yet.</p>
          ) : (
            <ul className="space-y-1.5 max-h-60 overflow-y-auto">
              {draft.map((l) => {
                const c = byId.get(l.controlId);
                return (
                  <li key={l.controlId} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs">
                    <span className="flex-1 min-w-[12rem]">
                      <span className="font-mono text-slate-200">{displayId(l.controlId)}</span>
                      {c && <span className="ml-2 text-slate-400">{c.title}</span>}
                      {!c && <span className="ml-2 text-amber-300 text-[11px]">Not in this program&apos;s catalog</span>}
                    </span>
                    {editable ? (
                      <>
                        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={l.evidenceSource}
                            onChange={(e) => setEvidence(l.controlId, e.target.checked)}
                            aria-label={`Evidence for ${displayId(l.controlId)} comes from this tool`}
                            className="accent-cyan-500"
                          />
                          <span>Evidence comes from this tool</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => unlink(l.controlId)}
                          aria-label={`Unlink ${displayId(l.controlId)}`}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                        >
                          <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <span className="text-slate-400">{l.evidenceSource ? 'Evidence comes from this tool' : 'Not an evidence source'}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {canEdit && newSuggestions.length > 0 && (
          <div className="rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 p-3 text-xs text-cyan-100 flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="flex-1">
              {`Suggested for this kind of tool (${newSuggestions.length}). ${INVENTORY_UI_TEXT.quickAddLinkHint}`}
            </p>
            <button type="button" disabled={!editable || saving} onClick={addSuggested} className={secondaryButton}>
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add suggested links</span>
            </button>
          </div>
        )}

        {canEdit && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="search"
                aria-label="Search controls"
                value={q}
                disabled={!editable}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by control ID or title…"
                className={`${inputClass} flex-1`}
              />
              <select aria-label="Control family" value={domain} disabled={!editable} onChange={(e) => setDomain(e.target.value)} className={inputClass}>
                <option value="ALL">All families</option>
                {domains.map((d) => (
                  <option key={d.code} value={d.code}>{`${d.code} - ${d.name}`}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-slate-400" aria-live="polite">{limitLine ?? ''}</p>
            <ul className="max-h-72 overflow-y-auto divide-y divide-slate-800/60 rounded-xl border border-slate-800 bg-slate-950/60">
              {search.shown.length === 0 ? (
                <li className="px-3 py-4 text-xs text-slate-400">No controls match.</li>
              ) : (
                search.shown.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <input
                      id={`${uid}-c-${c.id}`}
                      type="checkbox"
                      checked={draftIds.has(c.id)}
                      disabled={!editable}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                      className="mt-0.5 accent-cyan-500"
                    />
                    <label htmlFor={`${uid}-c-${c.id}`} className="cursor-pointer text-slate-300">
                      <span className="font-mono text-slate-200">{displayId(c.id)}</span> {c.title}
                    </label>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {confirmDiscard ? (
          <div
            role="group"
            aria-label="Discard unsaved changes?"
            className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-800 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setConfirmDiscard(false);
              }
            }}
          >
            <span className="flex-1 text-slate-200">{`Discard ${diffCount} unsaved ${diffCount === 1 ? 'change' : 'changes'}?`}</span>
            <button type="button" autoFocus onClick={() => setConfirmDiscard(false)} className={secondaryButton}>Keep editing</button>
            <button type="button" onClick={onClose} className="btn-danger px-3 py-1.5 rounded-xl text-xs">Discard</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-800 text-xs">
            <p className="flex-1 text-slate-300" aria-live="polite">{canEdit ? linkDiffText(diff) : ''}</p>
            <button type="button" onClick={requestClose} disabled={saving} className={secondaryButton}>{canEdit ? 'Cancel' : 'Close'}</button>
            {canEdit && (
              <button type="button" onClick={() => void save()} disabled={saving || !editable || diffCount === 0} className="btn-primary px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">
                {saving ? 'Saving…' : 'Save links'}
              </button>
            )}
          </div>
        )}
      </div>
    </DialogOverlay>
  );
};

export default ToolControlsEditor;
