import React, { useEffect, useMemo, useState } from 'react';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { suggestedControlsForProgram } from '../../data/inventory/toolCatalog';
import { loadToolCatalog } from '../../data/inventory/toolCatalogLazy';
import { INVENTORY_UI_TEXT, toolErrorMessage } from '../../data/inventory/inventoryUiView';
import type { InventoryTool, ToolControlLink } from '../../types/inventory';
import { ControlLinksDialog } from './ControlLinksDialog';

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

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * The controls a tool is linked to in the open program: the shared control-links dialog with the tool's parts (the boundary note, the
 * catalog suggestions and the evidence-source checkbox).
 */
export const ToolControlsEditor: React.FC<ToolControlsEditorProps> = ({
  tool, programName, framework, controls, displayId, links, declared, inBoundary, canEdit, onSave, onAddToBoundary, onClose,
}) => {
  const [suggestedIds, setSuggestedIds] = useState<string[] | null>(null);
  const notInBoundary = declared && !inBoundary;
  const editable = canEdit && !notInBoundary;

  // Suggestions for a tool that came from the catalog: the controls it typically supports that this program has
  useEffect(() => {
    if (!canEdit || !tool.seedKey?.startsWith('catalog:')) return undefined;
    let cancelled = false;
    const entryId = tool.seedKey.slice('catalog:'.length);
    void loadToolCatalog()
      .then((cat) => {
        const entry = cat.tools.find((e) => e.id === entryId);
        if (!cancelled && entry) setSuggestedIds(suggestedControlsForProgram(entry, new Set(controls.map((c) => c.id))));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tool.seedKey, canEdit]);
  const suggestions = useMemo(
    () => (suggestedIds ? { label: 'Suggested for this kind of tool', ids: suggestedIds, hint: INVENTORY_UI_TEXT.quickAddLinkHint } : null),
    [suggestedIds]
  );

  return (
    <ControlLinksDialog
      title={`Controls for ${tool.name}`}
      subtitle={`${programName} (${frameworkLabel(framework)}). ${INVENTORY_UI_TEXT.linksIntro}`}
      controls={controls}
      framework={framework}
      displayId={displayId}
      initial={links}
      canEdit={canEdit}
      readOnlyText={INVENTORY_UI_TEXT.linksReadOnly}
      blocked={
        notInBoundary
          ? ({ saving, setSaving, setBanner }) => (
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
            )
          : undefined
      }
      suggestions={suggestions}
      rowExtra={(l, set) =>
        editable ? (
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={l.evidenceSource === true}
              onChange={(e) => set({ ...l, evidenceSource: e.target.checked })}
              aria-label={`Evidence for ${displayId(l.controlId)} comes from this tool`}
              className="accent-cyan-500"
            />
            <span>Evidence comes from this tool</span>
          </label>
        ) : (
          <span className="text-slate-400">{l.evidenceSource ? 'Evidence comes from this tool' : 'Not an evidence source'}</span>
        )
      }
      staleText={INVENTORY_UI_TEXT.linksStale}
      errorText={(err) => toolErrorMessage(err, 'links', programName)}
      onSave={(next, expectedIds) => onSave(next.map((l) => ({ controlId: l.controlId, evidenceSource: l.evidenceSource === true })), expectedIds)}
      onClose={onClose}
    />
  );
};

export default ToolControlsEditor;
