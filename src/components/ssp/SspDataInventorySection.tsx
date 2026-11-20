import React, { useEffect, useId, useRef, useState } from 'react';
import { Boxes, ExternalLink } from 'lucide-react';
import type { DataInventoryRecord } from '../../types/inventory';
import type { DataInventorySaveError, DataInventoryStatus } from '../../hooks/useDataInventory';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import { categoryLink, type CuiRegistry } from '../../data/cui/cuiRegistry';
import { fieldFlags, missingItemsLine } from '../../data/ssp/sspBuilderView';
import {
  SSP_INVENTORY_TEXT,
  assignmentCount,
  bannerText,
  canUntick,
  cuiRequirementLine,
  dataInventorySaveErrorText,
  designationView,
  fciHint,
  fciValue,
  filterRegistry,
  matrixRows,
  registryEntry,
  registryNote,
  removeCategory,
  removeCategoryConfirmText,
  roleValue,
  setFci,
  setToolRole,
  toggleCategory,
  type CuiRole,
  type DesignationTone,
} from '../../data/ssp/sspInventoryView';
import { ErrorNotice } from '../common/ErrorNotice';

interface SspDataInventorySectionProps {
  framework: string;
  data: { status: DataInventoryStatus; record: DataInventoryRecord; saving: boolean; saveError: DataInventorySaveError | null };
  /** True only for a writer on an open program with the server copy loaded. */
  editable: boolean;
  registry: CuiRegistry | null;
  registryStatus: 'loading' | 'ready' | 'error';
  boundaryTools: { id: string; name: string }[];
  section?: SspSectionStatus;
  onChange: (r: DataInventoryRecord) => void;
  onReload: () => void;
  onRetryRegistry: () => void;
  onOpenRegister: () => void;
}

const FCI_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unset', label: 'Not answered' },
] as const;

const ROLES: ReadonlyArray<{ role: CuiRole; header: string; verb: string }> = [
  { role: 'stores', header: 'Stored', verb: 'stores' },
  { role: 'processes', header: 'Processed', verb: 'processes' },
  { role: 'transmits', header: 'Transmitted', verb: 'transmits' },
];

const PILL: Record<DesignationTone, string> = {
  slate: 'bg-slate-800 text-slate-300 border-slate-700',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
};
const TONE_TEXT = { rose: 'text-rose-300', amber: 'text-amber-300', slate: 'text-slate-400' } as const;
const BUTTON = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed';
const LINK = 'inline-flex items-center gap-1 text-brand-300 hover:text-brand-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded';

const DesignationPill: React.FC<{ designation: string | null | undefined }> = ({ designation }) => {
  const v = designationView(designation);
  return v ? <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${PILL[v.tone]}`}>{v.label}</span> : null;
};

/** A link to the NARA CUI Registry category list. It opens only when clicked: nothing is requested ahead of the click. */
const NaraLink: React.FC<{ href: string; children: React.ReactNode; hidden: string }> = ({ href, children, hidden }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" className={LINK}>
    {children}
    <ExternalLink className="w-3 h-3" aria-hidden="true" />
    <span className="sr-only"> {hidden}</span>
  </a>
);

/** 1.4 Information Types: the FCI answer, the CUI categories of the NARA CUI Registry and the tools that store, process or transmit each. Autosaved by the parent's hook. */
export const SspDataInventorySection: React.FC<SspDataInventorySectionProps> = ({
  framework,
  data,
  editable,
  registry,
  registryStatus,
  boundaryTools,
  section,
  onChange,
  onReload,
  onRetryRegistry,
  onOpenRegister,
}) => {
  const baseId = useId();
  const pickerId = `${baseId}-picker`;
  const hintId = `${baseId}-assigned`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [focusToggle, setFocusToggle] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());

  const { record, status } = data;
  const missingLine = missingItemsLine(section);
  const fci = fieldFlags(section, 'inventory:fci');
  const requirement = cuiRequirementLine(framework, record.categories.length);
  const hint = fciHint(framework, record.handlesFci);
  const body = status === 'ready' || status === 'stale';
  const noToolsTone = framework === 'CMMC_L2' || framework === 'NIST_800_171_R3' ? 'text-rose-300' : 'text-slate-400';

  useEffect(() => {
    if (confirmRemove) confirmRef.current?.focus();
  }, [confirmRemove]);
  useEffect(() => {
    if (!focusToggle) return;
    toggleRef.current?.focus();
    setFocusToggle(false);
  }, [focusToggle]);

  const cancelRemove = (id: string) => {
    setConfirmRemove(null);
    removeRefs.current.get(id)?.focus();
  };
  const requestRemove = (id: string) => {
    if (assignmentCount(record, id) === 0) {
      onChange(removeCategory(record, id));
      setFocusToggle(true);
    } else {
      setConfirmRemove(id);
    }
  };

  const groups = registry && pickerOpen ? filterRegistry(registry, q) : [];

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.dataIntro}</p>
      {body && missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}

      {(status === 'unsupported' || status === 'no_program') && (
        <p role="note" className="p-3 rounded-xl bg-slate-800/60 border border-slate-700 text-xs text-slate-300">
          {status === 'unsupported' ? SSP_INVENTORY_TEXT.unsupported : SSP_INVENTORY_TEXT.noProgram}
        </p>
      )}
      {status === 'loading' && <p role="status" className="text-xs text-slate-400">Loading the data inventory…</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message="The data inventory could not be loaded." />
          <button type="button" onClick={onReload} className={BUTTON}>Try again</button>
        </div>
      )}
      {status === 'stale' && (
        <div role="alert" className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-3">
          <p>{SSP_INVENTORY_TEXT.stale}</p>
          <button type="button" onClick={onReload} className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold">
            Reload the server copy
          </button>
        </div>
      )}
      {body && status !== 'stale' && data.saveError && <ErrorNotice message={dataInventorySaveErrorText(data.saveError)} />}
      {body && <p role="status" className="text-[11px] text-slate-400">{data.saving ? 'Saving…' : ''}</p>}

      {body && (
        <>
          <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-300">
              {SSP_INVENTORY_TEXT.fciQuestion}
              {fci.required && (
                <>
                  <span className="text-rose-300" aria-hidden="true"> *</span>
                  <span className="sr-only"> (required)</span>
                </>
              )}
            </legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
              {FCI_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="radio"
                    name={`${baseId}-fci`}
                    checked={fciValue(record.handlesFci) === o.value}
                    onChange={() => onChange(setFci(record, o.value))}
                    className="accent-brand-500"
                    disabled={!editable}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            {hint && <p className="mt-2 text-xs text-amber-300">{hint}</p>}
          </fieldset>

          {requirement && (
            <p role={requirement.tone === 'rose' ? 'note' : undefined} className={`text-xs ${TONE_TEXT[requirement.tone]}`}>{requirement.text}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-400">
            {registry && <span>{registryNote(registry._meta)}</span>}
            {registry && !registry._meta.verified && (
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] font-semibold text-amber-300">{SSP_INVENTORY_TEXT.unverified}</span>
            )}
            {registry && (
              <NaraLink href={categoryLink(registry)} hidden="(opens in a new tab and leaves this app)">NARA CUI Registry category list</NaraLink>
            )}
            {registryStatus === 'loading' && <span role="status">{SSP_INVENTORY_TEXT.registryLoading}</span>}
            {registryStatus === 'error' && (
              <>
                <span role="alert" className="text-amber-300">{SSP_INVENTORY_TEXT.registryFailed}</span>
                <button type="button" onClick={onRetryRegistry} className={BUTTON}>Try again</button>
              </>
            )}
          </div>

          {record.categories.map((cat) => {
            const id = cat.categoryId;
            const entry = registryEntry(registry, id);
            const name = entry?.category.name ?? id;
            const marking = entry ? bannerText(entry.category) ?? id : id;
            const rows = matrixRows(record, id, boundaryTools);
            const count = assignmentCount(record, id);
            const specified = entry?.category.designation === 'SPECIFIED' || entry?.category.designation === 'BOTH';
            return (
              <fieldset key={id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 sm:p-4 space-y-3">
                <legend className="px-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-200">
                  <span>{name}</span>
                  {marking !== name && <span className="font-mono text-[11px] text-slate-400">{marking}</span>}
                  <DesignationPill designation={entry?.category.designation} />
                  {entry?.groupName && <span className="font-normal text-slate-500">{entry.groupName}</span>}
                </legend>
                {registry && !entry && <p className="text-xs text-amber-300">{SSP_INVENTORY_TEXT.notInRegistry}</p>}
                {specified && <p className="text-[11px] text-slate-400">{SSP_INVENTORY_TEXT.specifiedHint}</p>}
                {registry && entry && (
                  <p className="text-[11px]">
                    <NaraLink href={categoryLink(registry, entry.category)} hidden="(opens in a new tab and leaves this app)">View on NARA</NaraLink>
                  </p>
                )}

                {rows.length === 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.noBoundaryTools}</p>
                    <button type="button" onClick={onOpenRegister} className={BUTTON}>
                      <Boxes className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Open Tools &amp; Services</span>
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs min-w-[28rem]">
                      <caption className="sr-only">{`Tools for ${id}`}</caption>
                      <thead>
                        <tr className="text-left text-slate-400">
                          <th scope="col" className="py-1.5 px-2 font-semibold">Tool</th>
                          {ROLES.map((r) => (
                            <th key={r.role} scope="col" className="py-1.5 px-2 font-semibold">{r.header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {rows.map((tool) => (
                          <tr key={tool.id}>
                            <th scope="row" className={`py-1.5 px-2 text-left font-medium ${tool.outside ? 'text-amber-300' : 'text-slate-200'}`}>{tool.name}</th>
                            {ROLES.map((r) => (
                              <td key={r.role} className="py-1.5 px-2">
                                <input
                                  type="checkbox"
                                  aria-label={`${tool.name} ${r.verb} ${id}`}
                                  checked={roleValue(record, id, tool.id, r.role)}
                                  onChange={(e) => onChange(setToolRole(record, id, tool.id, r.role, e.target.checked))}
                                  disabled={!editable}
                                  className="accent-brand-500"
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {rows.length > 0 && count === 0 && <p className={`text-xs ${noToolsTone}`}>{SSP_INVENTORY_TEXT.noTools}</p>}

                {editable && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) removeRefs.current.set(id, el);
                        else removeRefs.current.delete(id);
                      }}
                      aria-label={`Remove ${id}`}
                      aria-expanded={confirmRemove === id}
                      onClick={() => requestRemove(id)}
                      className="px-2 py-1 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 text-[11px]"
                    >
                      Remove category
                    </button>
                    {confirmRemove === id && (
                      <div
                        role="group"
                        aria-label={`Confirm removing ${id}`}
                        onKeyDown={(e) => {
                          if (e.key !== 'Escape') return;
                          e.stopPropagation();
                          cancelRemove(id);
                        }}
                        className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200"
                      >
                        <p className="flex-1 min-w-[12rem]">{removeCategoryConfirmText(id, count)}</p>
                        <button type="button" onClick={() => cancelRemove(id)} className={BUTTON}>Cancel</button>
                        <button
                          type="button"
                          ref={confirmRef}
                          onClick={() => {
                            setConfirmRemove(null);
                            onChange(removeCategory(record, id));
                            setFocusToggle(true);
                          }}
                          className="btn-danger px-3 py-1.5 rounded-xl text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </fieldset>
            );
          })}

          {editable && registry && (
            <div className="space-y-3">
              <button
                type="button"
                ref={toggleRef}
                aria-expanded={pickerOpen}
                aria-controls={pickerId}
                onClick={() => setPickerOpen((o) => !o)}
                className={BUTTON}
              >
                {pickerOpen ? 'Close the category list' : 'Add CUI categories'}
              </button>
              <div id={pickerId} hidden={!pickerOpen} className="space-y-3">
                {pickerOpen && (
                  <>
                    <p id={hintId} className="sr-only">{SSP_INVENTORY_TEXT.hasAssignments}</p>
                    <input
                      type="search"
                      aria-label="Search CUI categories"
                      placeholder="Search by name, abbreviation or group…"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                    <div role="group" aria-label="CUI categories" className="max-h-96 overflow-y-auto space-y-3">
                      {groups.length === 0 && <p className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.noMatch}</p>}
                      {groups.map((g) => (
                        <div key={g.group.id} className="space-y-1.5">
                          <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{g.group.name} ({g.categories.length})</h5>
                          <ul className="space-y-1">
                            {g.categories.map((c) => {
                              const selected = record.categories.some((x) => x.categoryId === c.id);
                              const locked = selected && !canUntick(record, c.id);
                              const inputId = `${baseId}-cat-${c.id}`;
                              return (
                                <li key={c.id} className="flex items-start gap-2 text-xs">
                                  <input
                                    id={inputId}
                                    type="checkbox"
                                    checked={selected}
                                    disabled={locked}
                                    aria-describedby={locked ? hintId : undefined}
                                    onChange={(e) => onChange(toggleCategory(record, c.id, e.target.checked))}
                                    className="mt-0.5 accent-brand-500"
                                  />
                                  <label htmlFor={inputId} className="flex flex-wrap items-center gap-2 text-slate-200">
                                    <span>{c.name}</span>
                                    {bannerText(c) && <span className="font-mono text-[11px] text-slate-400">{bannerText(c)}</span>}
                                    <DesignationPill designation={c.designation} />
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
