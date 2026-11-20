import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { CATEGORY_INFO } from '../../data/telemetry/assetScope';
import { INVENTORY_UI_TEXT } from '../../data/inventory/inventoryUiView';
import { sortForRegister } from '../../data/inventory/toolRegisterView';
import type { InventoryTool } from '../../types/inventory';

interface ToolRecoveryOrderProps {
  tools: InventoryTool[];
  canEdit: boolean;
  /** A change is in flight: the buttons stay in place (aria-disabled) so focus is not dropped. */
  busy: boolean;
  error: string | null;
  /** Each resolves to true when the change was saved. */
  onMove: (id: string, dir: 'up' | 'down') => Promise<boolean>;
  onAdd: (id: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  /** Said to screen readers after a change. */
  announcement: string;
}

type Which = 'up' | 'down' | 'add' | 'remove';

const iconButton = 'p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * The recovery order of the register: the order tools are restored after an outage. Moved with Up / Down buttons (no dragging), so it works from
 * the keyboard; every result is announced and focus stays on the tool that moved.
 */
export const ToolRecoveryOrder: React.FC<ToolRecoveryOrderProps> = ({ tools, canEdit, busy, error, onMove, onAdd, onRemove, announcement }) => {
  const hId = useId();
  const ranked = sortForRegister(tools.filter((t) => t.recoveryRank !== null));
  const unranked = sortForRegister(tools.filter((t) => t.recoveryRank === null));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [pendingFocus, setPendingFocus] = useState<{ id: string; which: Which } | null>(null);

  // After the list reloads, put focus where the person was working
  useEffect(() => {
    if (!pendingFocus) return;
    const { id, which } = pendingFocus;
    const idx = ranked.findIndex((t) => t.id === id);
    let target: string | null = null;
    if (which === 'up' || which === 'down') {
      const sameDisabled = which === 'up' ? idx === 0 : idx === ranked.length - 1;
      target = `${id}:${sameDisabled ? (which === 'up' ? 'down' : 'up') : which}`;
    } else if (which === 'add') target = `${id}:up`;
    else target = `${id}:add`;
    const el = refs.current.get(target);
    if (el) {
      el.focus();
      setPendingFocus(null);
    }
  }, [tools]);

  const run = async (id: string, which: Which): Promise<void> => {
    if (busy) return;
    setPendingFocus({ id, which });
    const ok = which === 'up' || which === 'down' ? await onMove(id, which) : which === 'add' ? await onAdd(id) : await onRemove(id);
    if (!ok) setPendingFocus(null);
  };

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  const pill = (t: InventoryTool): React.ReactNode =>
    t.assetCategory ? (
      <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300" title={CATEGORY_INFO[t.assetCategory].label}>
        {CATEGORY_INFO[t.assetCategory].short}
      </span>
    ) : null;

  return (
    <section aria-labelledby={hId} className="space-y-4">
      <h3 id={hId} className="text-sm font-bold text-white">Recovery order</h3>
      <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.recoveryIntro}</p>
      {!canEdit && <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.recoveryReadOnly}</p>}
      <ErrorNotice message={error} />
      <p role="status" className="sr-only">{announcement}</p>
      {ranked.length === 0 ? (
        <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.recoveryEmpty}</p>
      ) : (
        <ol className="space-y-1.5">
          {ranked.map((t, i) => (
            <li key={t.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
              <span className="w-8 shrink-0 font-mono text-xs text-slate-400" aria-hidden="true">{i + 1}.</span>
              <span className="flex-1 min-w-0 text-xs">
                <span className="font-semibold text-white">{t.name}</span>
                {pill(t)}
              </span>
              {canEdit && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    ref={setRef(`${t.id}:up`)}
                    aria-label={`Move ${t.name} up`}
                    disabled={i === 0}
                    aria-disabled={busy || undefined}
                    onClick={() => void run(t.id, 'up')}
                    className={iconButton}
                  >
                    <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    ref={setRef(`${t.id}:down`)}
                    aria-label={`Move ${t.name} down`}
                    disabled={i === ranked.length - 1}
                    aria-disabled={busy || undefined}
                    onClick={() => void run(t.id, 'down')}
                    className={iconButton}
                  >
                    <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    ref={setRef(`${t.id}:remove`)}
                    aria-label={`Remove ${t.name} from the recovery order`}
                    aria-disabled={busy || undefined}
                    onClick={() => void run(t.id, 'remove')}
                    className="px-2 py-1 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 text-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <h4 className="text-xs font-semibold text-slate-300">Not in the recovery order ({unranked.length})</h4>
      <ul className="space-y-1">
        {unranked.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/40">
            <span className="min-w-0 truncate">{t.name}</span>
            {canEdit && (
              <button
                type="button"
                ref={setRef(`${t.id}:add`)}
                aria-label={`Add ${t.name} to the recovery order`}
                aria-disabled={busy || undefined}
                onClick={() => void run(t.id, 'add')}
                className={secondaryButton}
              >
                Add to order
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ToolRecoveryOrder;
