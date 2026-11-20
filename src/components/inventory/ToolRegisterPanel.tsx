import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  Edit2,
  FileCheck2,
  FileDown,
  ListOrdered,
  ListPlus,
  Lock,
  Plus,
  PlusCircle,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useToolRegister } from '../../hooks/useToolRegister';
import { useVendorRegister } from '../../hooks/useVendorRegister';
import { useProgramInventory } from '../../hooks/useProgramInventory';
import { useToolMemberships } from '../../hooks/useToolMemberships';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { effectiveStackProfile } from '../../data/effectiveStackProfile';
import { statusDisplayLabel } from '../../data/statusLabels';
import { CATEGORY_INFO } from '../../data/telemetry/assetScope';
import { costVisible, rollupByProgram, rollupCosts, upcomingRenewals } from '../../data/inventory/costRollup';
import { seedCandidatesFromStackProfile } from '../../data/inventory/stackSeed';
import {
  boundaryTools,
  controlCountsByTool,
  filterTools,
  hasMissingUserCounts,
  moveInOrder,
  sortForRegister,
  toolEvidenceStatus,
  type ToolFilter,
} from '../../data/inventory/toolRegisterView';
import {
  DEPLOYMENT_LABELS,
  FILTER_LABELS,
  INVENTORY_UI_TEXT,
  ORIGIN_LABELS,
  addToOrder,
  addedToOrderText,
  ariaSort,
  attentionLine,
  boundaryRemoveConfirmText,
  controlsCell,
  declareFirstText,
  filterCounts,
  fedrampCell,
  formatUsd,
  localDateIso,
  moveAnnouncement,
  programPartsMessage,
  registerColumns,
  registerCountCaption,
  registerEmptyMessage,
  removeFromOrder,
  removeToolConfirmText,
  removedFromOrderText,
  renewalBadge,
  sortTools,
  surveyNotice,
  toolErrorMessage,
  triLabel,
  undeclaredNote,
  usersCell,
  type ProgramParts,
  type ToolSortKey,
} from '../../data/inventory/inventoryUiView';
import { toolRegisterCsv } from '../../data/reports/inventoryRegisterCsv';
import type { InventoryTool, ToolInput, ToolUsage } from '../../types/inventory';
import type { CmmcAssetCategory } from '../../types/telemetry';
import { ErrorNotice } from '../common/ErrorNotice';
import { downloadCsv } from './downloadCsv';
import { ToolDialog } from './ToolDialog';
import { ToolControlsEditor } from './ToolControlsEditor';
import { ToolRecoveryOrder } from './ToolRecoveryOrder';
import { ToolEvidenceStatus } from './ToolEvidenceStatus';
import { ToolCostSummary } from './ToolCostSummary';
import { ToolQuickAddDialog } from './ToolQuickAddDialog';
import { SurveySeedDialog } from './SurveySeedDialog';

type View = 'register' | 'recovery' | 'evidence' | 'costs';
type SortState = { key: ToolSortKey; dir: 'asc' | 'desc' };
type BoundaryFilter = 'ALL' | 'IN' | 'NOT_IN';
type PendingBoundary = { anchor: string | null; kind: 'declare' | 'remove'; ids: string[]; inUse?: { controlLinks: number; cuiLinks: number } };
type PendingDelete = { id: string; usage: ToolUsage | null | 'loading' };

const CATEGORY_PILL: Record<CmmcAssetCategory, string> = {
  CUI_ASSET: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  SECURITY_PROTECTION: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  CONTRACTOR_RISK: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  SPECIALIZED_ASSET: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  OUT_OF_SCOPE: 'bg-slate-800 text-slate-400 border-slate-700',
};

const FILTERS: ToolFilter[] = ['ALL', 'ON_PREM', 'CLOUD', 'ESP'];
const SORTABLE: Partial<Record<string, ToolSortKey>> = { tool: 'name', category: 'category', users: 'users', recovery: 'recovery', controls: 'controls', cost: 'cost', renewal: 'renewal' };

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const segment = (pressed: boolean, tone: 'cyan' | 'amber' = 'cyan'): string =>
  `px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
    pressed
      ? tone === 'amber'
        ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
        : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200'
      : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
  }`;
const fieldClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const confirmButton = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50';

/**
 * The organization's Tools and Services register (#239): what each tool does, where it runs, its CMMC asset category and user counts, with the
 * open program's boundary and control links alongside. Server-backed organizations only. Names, missions, notes and cost may be CUI: notifications
 * use fixed text, and nothing is cached in browser storage or logged.
 */
export const ToolRegisterPanel: React.FC = () => {
  const { currentTenant, canEdit, activeProgram, programsStatus, programs, setIsStackSurveyModalOpen, activeFramework } = useTenant();
  const { frameworkControls, state, setSelectedControlId } = useAssessment();
  const tenantId = currentTenant.id;
  const headingId = useId();
  const baseId = useId();

  const [view, setView] = useState<View>('register');
  const reg = useToolRegister();
  const inv = useProgramInventory();
  const vendors = useVendorRegister();
  const costsOn = reg.showCost && costVisible(reg.tools);
  const members = useToolMemberships({ enabled: view === 'costs' && costsOn });

  const [filter, setFilter] = useState<ToolFilter>('ALL');
  const [query, setQuery] = useState('');
  const [boundaryFilter, setBoundaryFilter] = useState<BoundaryFilter>('ALL');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'recovery', dir: 'asc' });
  const [dialog, setDialog] = useState<{ initial: InventoryTool | null; key: number; stacked: boolean } | null>(null);
  const [linksFor, setLinksFor] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedDismissed, setSeedDismissed] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingBoundary, setPendingBoundary] = useState<PendingBoundary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderAnnouncement, setOrderAnnouncement] = useState('');
  const [evidenceTool, setEvidenceTool] = useState('ALL');
  const [includeNonSource, setIncludeNonSource] = useState(false);

  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const boundaryBoxes = useRef(new Map<string, HTMLInputElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const addShownRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const dialogCounter = useRef(0);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const programName = activeProgram?.name ?? '';
  const archived = Boolean(activeProgram?.archived);
  const programParts: ProgramParts = !reg.supported
    ? 'unsupported'
    : programsStatus === 'ready' && !activeProgram
      ? 'no_program'
      : inv.status === 'ready'
        ? 'ready'
        : inv.status === 'error'
          ? 'error'
          : inv.status === 'no_program'
            ? 'no_program'
            : 'loading';
  const programReady = programParts === 'ready';
  const counts = useMemo(() => controlCountsByTool(inv.controlLinks), [inv.controlLinks]);
  const inBoundary = (id: string): boolean => !inv.declared || inv.toolIds.has(id);
  const today = localDateIso(new Date());
  const editorsReady = canEdit && reg.status === 'ready';
  const limitReached = reg.tools.length >= reg.limit;
  const attention = attentionLine(reg.tools);
  const attentionActive = attentionOnly && attention !== null;

  const shown = useMemo(() => {
    let list = filterTools(reg.tools, filter, query);
    if (programReady && boundaryFilter !== 'ALL') {
      list = list.filter((t) => (boundaryFilter === 'IN' ? inBoundary(t.id) : !inBoundary(t.id)));
    }
    if (attentionActive) list = list.filter(hasMissingUserCounts);
    return sortTools(list, sort.key, sort.dir, { controlCounts: counts });
  }, [reg.tools, filter, query, boundaryFilter, attentionActive, sort, counts, programReady, inv.declared, inv.toolIds]);

  const seeds = useMemo(
    () => (canEdit && reg.status === 'ready' ? seedCandidatesFromStackProfile(effectiveStackProfile(currentTenant, activeProgram), reg.tools) : []),
    [canEdit, reg.status, reg.tools, currentTenant, activeProgram]
  );

  const displayId = useCallback((id: string): string => cmmcDisplayId(id, activeFramework), [activeFramework]);
  const catalogIds = useMemo(() => new Set(frameworkControls.map((c) => c.id)), [frameworkControls]);
  const linkedTool = linksFor ? reg.tools.find((t) => t.id === linksFor) ?? null : null;
  const toolLinks = useMemo(() => inv.controlLinks.filter((l) => l.toolId === linksFor), [inv.controlLinks, linksFor]);

  // Another organization's or program's dialogs, confirmations and messages must not carry over
  useEffect(() => {
    setView('register');
    setFilter('ALL');
    setQuery('');
    setBoundaryFilter('ALL');
    setAttentionOnly(false);
    setSort({ key: 'recovery', dir: 'asc' });
    setDialog(null);
    setLinksFor(null);
    setQuickAdd(false);
    setSeedOpen(false);
    setSeedDismissed(false);
    setPendingDelete(null);
    setPendingBoundary(null);
    setActionError(null);
    setNotification(null);
    setOrderError(null);
    setOrderAnnouncement('');
    setEvidenceTool('ALL');
    setIncludeNonSource(false);
  }, [tenantId, activeProgram?.id]);
  useEffect(() => () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
  }, []);
  // A tool removed elsewhere closes its links window
  useEffect(() => {
    if (linksFor && reg.status === 'ready' && !linkedTool) setLinksFor(null);
  }, [linksFor, linkedTool, reg.status]);

  const showNotification = (msg: string): void => {
    setNotification(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(null), 4000);
  };

  const exportCsv = (): void => {
    const fileName = `tools-and-services-${today}.csv`;
    const vendorsById = Object.fromEntries(vendors.vendors.map((v) => [v.id, v.name]));
    downloadCsv(fileName, toolRegisterCsv(shown, { includeCost: reg.showCost, controlCounts: programReady ? counts : undefined, vendorsById }));
    showNotification(`Exported ${shown.length} ${shown.length === 1 ? 'tool' : 'tools'} to ${fileName}.`);
  };

  const clickSort = (key: ToolSortKey): void => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // ---- Add / edit ----

  const saveTool = async (input: ToolInput, opts: { expectedUpdatedAt?: string; addToBoundary: boolean }): Promise<void> => {
    setActionError(null);
    const editing = dialog?.initial ?? null;
    if (editing) {
      await reg.update(editing.id, input, opts.expectedUpdatedAt ?? editing.updatedAt);
      showNotification('Tool updated.');
      return;
    }
    const created = await reg.create(input);
    if (opts.addToBoundary) {
      try {
        await inv.patchTools({ add: [created.id] });
      } catch (err: unknown) {
        setActionError(toolErrorMessage(err, 'boundary', programName));
      }
    }
    showNotification('Tool added.');
  };

  // ---- Remove ----

  const openDelete = (t: InventoryTool): void => {
    setPendingBoundary(null);
    setPendingDelete({ id: t.id, usage: 'loading' });
    reg
      .usage(t.id)
      .then((u) => setPendingDelete((p) => (p && p.id === t.id ? { id: t.id, usage: u } : p)))
      .catch(() => setPendingDelete((p) => (p && p.id === t.id ? { id: t.id, usage: null } : p)));
  };

  const cancelDelete = (id: string): void => {
    setPendingDelete(null);
    setTimeout(() => removeButtons.current.get(id)?.focus(), 0);
  };

  const confirmDelete = async (t: InventoryTool): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await reg.remove(t.id);
      setPendingDelete(null);
      showNotification('Tool removed.');
      searchRef.current?.focus();
    } catch (err: unknown) {
      setActionError(toolErrorMessage(err, 'delete'));
      if ((err as { status?: unknown } | null)?.status === 404) setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  // ---- Boundary ----

  const focusBoundaryBox = (id: string | null): void => {
    setTimeout(() => (id ? boundaryBoxes.current.get(id) : addShownRef.current)?.focus(), 0);
  };

  const toggleBoundary = async (t: InventoryTool, checked: boolean): Promise<void> => {
    setActionError(null);
    if (!inv.declared) {
      if (checked) {
        setPendingDelete(null);
        setPendingBoundary({ anchor: t.id, kind: 'declare', ids: [t.id] });
      }
      return;
    }
    setBusy(true);
    try {
      await inv.patchTools(checked ? { add: [t.id] } : { remove: [t.id] });
    } catch (err: unknown) {
      const inUse = (err as { inUse?: { controlLinks: number; cuiLinks: number } } | null)?.inUse;
      if ((err as { reason?: unknown } | null)?.reason === 'tool_in_use' && inUse) {
        setPendingDelete(null);
        setPendingBoundary({ anchor: t.id, kind: 'remove', ids: [t.id], inUse });
      } else {
        setActionError(toolErrorMessage(err, 'boundary', programName));
      }
    } finally {
      setBusy(false);
    }
  };

  const addShown = async (): Promise<void> => {
    const ids = shown.filter((t) => !inv.declared || !inv.toolIds.has(t.id)).map((t) => t.id);
    if (ids.length === 0) return;
    setActionError(null);
    if (!inv.declared) {
      setPendingDelete(null);
      setPendingBoundary({ anchor: null, kind: 'declare', ids });
      return;
    }
    setBusy(true);
    try {
      await inv.patchTools({ add: ids });
      showNotification(`Added ${ids.length} ${ids.length === 1 ? 'tool' : 'tools'} to the boundary.`);
    } catch (err: unknown) {
      setActionError(toolErrorMessage(err, 'boundary', programName));
    } finally {
      setBusy(false);
    }
  };

  const confirmBoundary = async (p: PendingBoundary): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await inv.patchTools(p.kind === 'declare' ? { add: p.ids } : { remove: p.ids, force: true });
      setPendingBoundary(null);
      showNotification(p.kind === 'declare' ? `Declared ${p.ids.length} ${p.ids.length === 1 ? 'tool' : 'tools'} in the boundary.` : 'Tool removed from the boundary.');
      focusBoundaryBox(p.anchor);
    } catch (err: unknown) {
      setActionError(toolErrorMessage(err, 'boundary', programName));
      setPendingBoundary(null);
    } finally {
      setBusy(false);
    }
  };

  const cancelBoundary = (p: PendingBoundary): void => {
    setPendingBoundary(null);
    focusBoundaryBox(p.anchor);
  };

  // ---- Recovery order ----

  const rankedIds = useMemo(() => sortForRegister(reg.tools.filter((t) => t.recoveryRank !== null)).map((t) => t.id), [reg.tools]);
  const nameOf = (id: string): string => reg.tools.find((t) => t.id === id)?.name ?? '';

  const changeOrder = async (next: string[], announce: string): Promise<boolean> => {
    setOrderBusy(true);
    setOrderError(null);
    try {
      await reg.setOrder(next, rankedIds);
      setOrderAnnouncement(announce);
      return true;
    } catch (err: unknown) {
      setOrderError(toolErrorMessage(err, 'order'));
      return false;
    } finally {
      setOrderBusy(false);
    }
  };

  const moveTool = (id: string, dir: 'up' | 'down'): Promise<boolean> => {
    const next = moveInOrder(rankedIds, id, dir);
    return changeOrder(next, moveAnnouncement(nameOf(id), next.indexOf(id) + 1, next.length));
  };
  const addTool = (id: string): Promise<boolean> => {
    const next = addToOrder(rankedIds, id);
    return changeOrder(next, addedToOrderText(nameOf(id), next.length));
  };
  const removeTool = (id: string): Promise<boolean> => changeOrder(removeFromOrder(rankedIds, id), removedFromOrderText(nameOf(id)));

  // ---- Evidence status and costs ----

  const evidenceRows = useMemo(
    () =>
      view === 'evidence' && programReady
        ? toolEvidenceStatus(
            inv.controlLinks,
            frameworkControls.map((c) => ({ id: c.id, title: c.title, status: state.controls[c.id]?.status ?? 'NOT_STARTED' })),
            state.evidenceIndex,
            { toolId: evidenceTool === 'ALL' ? undefined : evidenceTool, includeNonSource }
          )
        : [],
    [view, programReady, inv.controlLinks, frameworkControls, state.controls, state.evidenceIndex, evidenceTool, includeNonSource]
  );
  const toolNames = useMemo(() => Object.fromEntries(reg.tools.map((t) => [t.id, t.name])), [reg.tools]);
  const toolOptions = useMemo(() => reg.tools.slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((t) => ({ id: t.id, name: t.name })), [reg.tools]);

  const costTotal = useMemo(() => rollupCosts(reg.tools), [reg.tools]);
  const programRollup = useMemo(
    () => (programReady && activeProgram ? { name: activeProgram.name, rollup: rollupCosts(boundaryTools(reg.tools, { declared: inv.declared, toolIds: [...inv.toolIds] })) } : null),
    [programReady, activeProgram, reg.tools, inv.declared, inv.toolIds]
  );
  const renewals = useMemo(() => upcomingRenewals(reg.tools, today, 60).map((r) => ({ ...r, name: toolNames[r.id] ?? '' })), [reg.tools, today, toolNames]);
  const perProgram = useMemo(() => {
    const rollups = rollupByProgram(reg.tools, members.memberships);
    const names = new Map(programs.map((p) => [p.id, p.name]));
    return members.memberships.map((m) => {
      const r = rollups[m.programId];
      return { programId: m.programId, name: names.get(m.programId) ?? 'Program', archived: m.archived, declared: m.declared, toolCount: r.withCost + r.missingCost, totalCents: r.totalCents };
    });
  }, [reg.tools, members.memberships, programs]);

  // ---- Render helpers ----

  const columns = registerColumns({ showCost: reg.showCost, programParts: programReady, canEdit });
  const headerLabel: Record<string, string> = {
    tool: 'Tool or service',
    deployment: 'Deployment',
    category: 'CMMC asset category',
    fedramp: 'FedRAMP',
    crm: 'CRM on file',
    users: 'Users (end / privileged)',
    recovery: 'Recovery',
    controls: `Controls in ${programName}`,
    boundary: `In ${programName}`,
    cost: 'Annual cost',
    renewal: 'Renewal',
    actions: 'Actions',
  };

  const confirmRow = (id: string, content: React.ReactNode): React.ReactNode => (
    <tr key={`${id}-confirm`} id={`${baseId}-confirm-${id}`} className="bg-slate-900/70">
      <td colSpan={columns.length} className="py-3 px-3">{content}</td>
    </tr>
  );

  const renderCell = (col: string, t: InventoryTool): React.ReactNode => {
    switch (col) {
      case 'tool':
        return (
          <td key={col} className="py-3 px-3 sticky left-0 z-10 bg-slate-950 min-w-[14rem]">
            <span className="font-semibold text-white">{t.name}</span>
            {t.origin !== 'MANUAL' && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300">{ORIGIN_LABELS[t.origin]}</span>
            )}
            {t.vendorName && <div className="text-slate-300">{t.vendorName}</div>}
            {t.mission && <div className="text-slate-400 truncate max-w-xs" title={t.mission}>{t.mission}</div>}
          </td>
        );
      case 'deployment':
        return <td key={col} className="py-3 px-3 text-slate-300">{t.deployment ? DEPLOYMENT_LABELS[t.deployment] : <span className="text-slate-400">Not set</span>}</td>;
      case 'category':
        return (
          <td key={col} className="py-3 px-3">
            {t.assetCategory ? (
              <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${CATEGORY_PILL[t.assetCategory]}`} title={CATEGORY_INFO[t.assetCategory].label}>
                {CATEGORY_INFO[t.assetCategory].short}
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full border border-dashed border-slate-600 text-slate-300 text-[11px]">Not classified</span>
            )}
          </td>
        );
      case 'fedramp': {
        const f = fedrampCell(t);
        return (
          <td key={col} className="py-3 px-3 text-slate-300">
            {f.text}
            {f.sub && <div className="text-[11px] text-slate-400">{f.sub}</div>}
            {f.unverified && <div className="text-[11px] text-amber-300">Date checked not recorded</div>}
          </td>
        );
      }
      case 'crm':
        return <td key={col} className="py-3 px-3 text-slate-300">{triLabel(t.crmOnFile)}</td>;
      case 'users': {
        const u = usersCell(t);
        return (
          <td key={col} className="py-3 px-3 text-slate-300">
            {u.missing ? (
              <>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-semibold">
                  <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                  {u.text}
                </span>
                <span className="sr-only"> (needed for SSP 1.3.1)</span>
              </>
            ) : (
              u.text
            )}
          </td>
        );
      }
      case 'recovery':
        return (
          <td key={col} className="py-3 px-3 font-mono text-slate-300">
            {t.recoveryRank !== null ? `#${t.recoveryRank}` : <><span aria-hidden="true">—</span><span className="sr-only">Not in the recovery order</span></>}
          </td>
        );
      case 'controls': {
        const c = controlsCell(counts[t.id] ?? 0, programName);
        return (
          <td key={col} className="py-3 px-3">
            <button
              type="button"
              onClick={() => setLinksFor(t.id)}
              data-links-for={t.id}
              aria-label={`${c.sr} for ${t.name}; open the links`}
              className="px-2 py-0.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 font-mono text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
            >
              {c.text}
            </button>
          </td>
        );
      }
      case 'boundary':
        return (
          <td key={col} className="py-3 px-3">
            {canEdit ? (
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) boundaryBoxes.current.set(t.id, el);
                    else boundaryBoxes.current.delete(t.id);
                  }}
                  checked={inv.declared && inv.toolIds.has(t.id)}
                  disabled={busy || archived}
                  onChange={(e) => void toggleBoundary(t, e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
                />
                <span>In this boundary<span className="sr-only"> ({t.name})</span></span>
              </label>
            ) : (
              <span className="text-slate-300">{!inv.declared ? 'Whole register' : inv.toolIds.has(t.id) ? 'In boundary' : 'Not in boundary'}</span>
            )}
          </td>
        );
      case 'cost':
        return (
          <td key={col} className="py-3 px-3 font-mono text-slate-300">
            {typeof t.annualCostCents === 'number' ? formatUsd(t.annualCostCents) : <><span aria-hidden="true">—</span><span className="sr-only">No cost recorded</span></>}
          </td>
        );
      case 'renewal': {
        const b = renewalBadge(t.renewalDate, today);
        return (
          <td key={col} className="py-3 px-3 text-slate-300">
            {t.renewalDate ?? '—'}
            {b && (
              <span className={`ml-2 px-1.5 py-0.5 rounded-full border text-[11px] font-semibold ${b.tone === 'rose' ? 'bg-rose-500/15 border-rose-500/30 text-rose-300' : 'bg-amber-500/15 border-amber-500/30 text-amber-300'}`}>
                {b.text}
              </span>
            )}
          </td>
        );
      }
      case 'actions':
        return (
          <td key={col} className="py-3 px-3 text-right">
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                disabled={!editorsReady}
                aria-label={`Edit ${t.name}`}
                onClick={() => setDialog({ initial: t, key: ++dialogCounter.current, stacked: false })}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!editorsReady}
                aria-label={`Remove ${t.name}`}
                aria-expanded={pendingDelete?.id === t.id}
                aria-controls={pendingDelete?.id === t.id ? `${baseId}-confirm-${t.id}` : undefined}
                ref={(el) => {
                  if (el) removeButtons.current.set(t.id, el);
                  else removeButtons.current.delete(t.id);
                }}
                onClick={() => openDelete(t)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </td>
        );
      default:
        return null;
    }
  };

  const boundaryConfirm = (p: PendingBoundary): React.ReactNode => (
    <div
      role="group"
      aria-label={p.kind === 'declare' ? 'Declare the boundary?' : 'Take this tool out of the boundary?'}
      className="flex flex-wrap items-center gap-3 text-xs"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelBoundary(p);
        }
      }}
    >
      <span className="flex-1 min-w-[16rem] text-slate-200">
        {p.kind === 'declare' ? declareFirstText(programName, reg.tools.length, p.ids.length) : boundaryRemoveConfirmText(programName, p.inUse ?? { controlLinks: 0, cuiLinks: 0 })}
      </span>
      <button type="button" autoFocus disabled={busy} onClick={() => void confirmBoundary(p)} className="btn-primary px-3 py-1 rounded-lg text-xs disabled:opacity-50">
        {p.kind === 'declare' ? 'Declare and add' : 'Remove from boundary'}
      </button>
      <button type="button" disabled={busy} onClick={() => cancelBoundary(p)} className={confirmButton}>Cancel</button>
    </div>
  );

  const addShownCount = shown.filter((t) => !inv.declared || !inv.toolIds.has(t.id)).length;
  const partsMessage = programPartsMessage(programParts);

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
            <Boxes className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id={headingId} className="text-base font-bold text-white">{INVENTORY_UI_TEXT.panelTitle}</h2>
              {reg.supported && (
                <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-300">{reg.tools.length}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">{INVENTORY_UI_TEXT.panelIntro}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={shown.length === 0 || reg.status !== 'ready'}
            onClick={exportCsv}
            title="Exports the tools currently shown"
            className={secondaryButton}
          >
            <FileDown className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>{`Export CSV (${shown.length})`}</span>
          </button>
          {canEdit && reg.supported && (
            <>
              <button type="button" disabled={!editorsReady || limitReached} onClick={() => setQuickAdd(true)} className={secondaryButton}>
                <ListPlus className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                <span>Quick add</span>
              </button>
              <button
                type="button"
                disabled={!editorsReady || limitReached}
                onClick={() => setDialog({ initial: null, key: ++dialogCounter.current, stacked: false })}
                className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add tool</span>
              </button>
            </>
          )}
        </div>
      </div>

      {!reg.supported ? (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <span>{`${INVENTORY_UI_TEXT.unsupported}${canEdit ? INVENTORY_UI_TEXT.unsupportedMoveHint : ''}.`}</span>
        </div>
      ) : (
        <>
          {!canEdit && (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <span>{INVENTORY_UI_TEXT.readOnly}</span>
            </div>
          )}

          {seeds.length > 0 && !seedDismissed && (
            <div role="note" className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 p-3 text-xs text-cyan-100">
              <Sparkles className="w-4 h-4 shrink-0 text-cyan-300" aria-hidden="true" />
              <p className="flex-1">{surveyNotice(seeds.length)} {INVENTORY_UI_TEXT.surveyHint}</p>
              <button type="button" ref={reviewRef} onClick={() => setSeedOpen(true)} className={secondaryButton}>Review suggestions</button>
              <button type="button" onClick={() => setSeedDismissed(true)} className="px-3 py-1.5 rounded-xl text-cyan-200 hover:bg-slate-800 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">Not now</button>
            </div>
          )}

          <ErrorNotice message={actionError} />
          {reg.status === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={INVENTORY_UI_TEXT.loadFailed} className="flex-1" />
              <button type="button" onClick={() => void reg.reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
            </div>
          )}
          {partsMessage && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <span>{partsMessage}</span>
              {programParts === 'error' && (
                <button type="button" onClick={() => void inv.reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
              )}
            </div>
          )}

          {notification && (
            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{notification}</span>
            </div>
          )}
          <p role="status" className="sr-only">{notification ?? ''}</p>

          {programReady && !inv.declared && activeProgram && (
            <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <p>
                {undeclaredNote(activeProgram.name, reg.tools.length)}
                {canEdit ? INVENTORY_UI_TEXT.undeclaredEditor : INVENTORY_UI_TEXT.undeclaredReader}
              </p>
            </div>
          )}

          <div role="group" aria-label="View" className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={view === 'register'} onClick={() => setView('register')} className={`${segment(view === 'register')} inline-flex items-center gap-1.5`}>
              <Boxes className="w-3.5 h-3.5" aria-hidden="true" />Register
            </button>
            <button type="button" aria-pressed={view === 'recovery'} onClick={() => setView('recovery')} className={`${segment(view === 'recovery')} inline-flex items-center gap-1.5`}>
              <ListOrdered className="w-3.5 h-3.5" aria-hidden="true" />Recovery order
            </button>
            <button type="button" aria-pressed={view === 'evidence'} onClick={() => setView('evidence')} className={`${segment(view === 'evidence')} inline-flex items-center gap-1.5`}>
              <FileCheck2 className="w-3.5 h-3.5" aria-hidden="true" />Evidence status
            </button>
            {costsOn && (
              <button type="button" aria-pressed={view === 'costs'} onClick={() => setView('costs')} className={`${segment(view === 'costs')} inline-flex items-center gap-1.5`}>
                <CircleDollarSign className="w-3.5 h-3.5" aria-hidden="true" />Costs
              </button>
            )}
          </div>

          {view === 'register' && (
            <>
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
                <div role="group" aria-label="Deployment filter" className="flex flex-wrap gap-2">
                  {FILTERS.map((f) => (
                    <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={segment(filter === f)}>
                      {`${FILTER_LABELS[f]} (${filterCounts(reg.tools)[f]})`}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search tools"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by tool, vendor or purpose…"
                    className={`${fieldClass} w-full pl-9 pr-3`}
                  />
                </div>
                {programReady && (
                  <select aria-label="Boundary filter" value={boundaryFilter} onChange={(e) => setBoundaryFilter(e.target.value as BoundaryFilter)} className={fieldClass}>
                    <option value="ALL">All tools (organization register)</option>
                    <option value="IN">{`In ${programName}`}</option>
                    <option value="NOT_IN">{`Not in ${programName}`}</option>
                  </select>
                )}
                {attention && (
                  <button type="button" aria-pressed={attentionActive} onClick={() => setAttentionOnly((v) => !v)} className={segment(attentionActive, 'amber')}>
                    {`${attention} ${attentionActive ? 'Show all' : 'Show only these'}`}
                  </button>
                )}
              </div>

              {canEdit && programReady && (
                <div role="group" aria-label={`Boundary of ${programName}`} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <p className="flex-1 text-xs text-slate-300">
                    Changes apply to <strong className="text-white">{programName}</strong> for everyone who works in it. &quot;Shown&quot; means the tools your filters list.
                  </p>
                  <button
                    type="button"
                    ref={addShownRef}
                    onClick={() => void addShown()}
                    disabled={busy || archived || addShownCount === 0}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                  >
                    <PlusCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    {`Add shown to boundary (${addShownCount})`}
                  </button>
                </div>
              )}
              {pendingBoundary && pendingBoundary.anchor === null && (
                <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">{boundaryConfirm(pendingBoundary)}</div>
              )}

              <p className="text-xs text-slate-400" aria-live="polite">{reg.status === 'loading' ? '' : registerCountCaption(shown.length, reg.tools.length)}</p>

              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                <table aria-busy={reg.status === 'loading' || busy || undefined} className="table w-full min-w-[64rem] text-left text-xs border-collapse">
                  <caption className="sr-only">Tools and services register</caption>
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                      {columns.map((col) => {
                        const key = SORTABLE[col];
                        return (
                          <th
                            key={col}
                            scope="col"
                            aria-sort={key ? ariaSort(key, sort.key, sort.dir) : undefined}
                            className={`py-2.5 px-3 ${col === 'tool' ? 'sticky left-0 z-10 bg-slate-900' : ''} ${col === 'actions' ? 'text-right' : ''}`}
                          >
                            {key ? (
                              <button
                                type="button"
                                onClick={() => clickSort(key)}
                                className="inline-flex items-center gap-1 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded"
                              >
                                {headerLabel[col]}
                                <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                              </button>
                            ) : (
                              headerLabel[col]
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {reg.status === 'loading' ? (
                      <tr>
                        <td colSpan={columns.length} className="py-8 text-center text-slate-400" role="status">{INVENTORY_UI_TEXT.loading}</td>
                      </tr>
                    ) : shown.length === 0 ? (
                      <tr>
                        <td colSpan={columns.length} className="py-8 text-center text-slate-400">
                          <p>{registerEmptyMessage({ total: reg.tools.length, canEdit })}</p>
                          {reg.status === 'ready' && reg.tools.length === 0 && canEdit && seeds.length === 0 && (
                            <button type="button" onClick={() => setIsStackSurveyModalOpen(true)} className={`${secondaryButton} mx-auto mt-3`}>Fill in the technology survey</button>
                          )}
                        </td>
                      </tr>
                    ) : (
                      shown.map((t) => (
                        <React.Fragment key={t.id}>
                          <tr className="hover:bg-slate-800/40 transition-colors">{columns.map((col) => renderCell(col, t))}</tr>
                          {pendingBoundary?.anchor === t.id && confirmRow(t.id, boundaryConfirm(pendingBoundary))}
                          {pendingDelete?.id === t.id &&
                            confirmRow(
                              t.id,
                              <div
                                role="group"
                                aria-label="Remove this tool?"
                                className="flex flex-wrap items-center gap-3 text-xs"
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.stopPropagation();
                                    cancelDelete(t.id);
                                  }
                                }}
                              >
                                {pendingDelete.usage === 'loading' ? (
                                  <p role="status" className="flex-1 min-w-[16rem] text-slate-300">Checking where this tool is used…</p>
                                ) : (
                                  <p className="flex-1 min-w-[16rem] text-slate-200">{removeToolConfirmText(pendingDelete.usage, t.recoveryRank !== null)}</p>
                                )}
                                <button type="button" autoFocus disabled={busy || pendingDelete.usage === 'loading'} onClick={() => void confirmDelete(t)} className="btn-danger px-3 py-1 rounded-lg text-xs disabled:opacity-50">
                                  Remove tool
                                </button>
                                <button type="button" disabled={busy} onClick={() => cancelDelete(t.id)} className={confirmButton}>Cancel</button>
                              </div>
                            )}
                        </React.Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {view === 'recovery' && (
            <ToolRecoveryOrder
              tools={reg.tools}
              canEdit={editorsReady}
              busy={orderBusy}
              error={orderError}
              onMove={moveTool}
              onAdd={addTool}
              onRemove={removeTool}
              announcement={orderAnnouncement}
            />
          )}
          {view === 'evidence' && (
            <ToolEvidenceStatus
              state={programParts}
              programName={activeProgram?.name ?? null}
              rows={evidenceRows}
              toolNames={toolNames}
              tools={toolOptions}
              toolFilter={evidenceTool}
              onToolFilter={setEvidenceTool}
              includeNonSource={includeNonSource}
              onIncludeNonSource={setIncludeNonSource}
              displayId={displayId}
              statusLabel={(s) => statusDisplayLabel(s as Parameters<typeof statusDisplayLabel>[0])}
              onOpenControl={(id) => setSelectedControlId(id)}
            />
          )}
          {view === 'costs' && costsOn && (
            <ToolCostSummary
              total={costTotal}
              program={programRollup}
              renewals={renewals}
              perProgram={{ status: members.status, rows: perProgram }}
              onRetry={() => void members.reload()}
            />
          )}
        </>
      )}

      {dialog && (
        <ToolDialog
          key={dialog.key}
          initial={dialog.initial}
          vendors={vendors.vendors}
          showCost={reg.showCost}
          programName={activeProgram?.name ?? null}
          offerBoundary={programReady && inv.declared && !archived}
          onSave={saveTool}
          latest={(id) => reg.tools.find((t) => t.id === id) ?? null}
          onClose={() => setDialog(null)}
          stacked={dialog.stacked}
        />
      )}
      {linksFor && linkedTool && activeProgram && programReady && (
        <ToolControlsEditor
          tool={linkedTool}
          programName={activeProgram.name}
          framework={activeFramework}
          controls={frameworkControls}
          displayId={displayId}
          links={toolLinks}
          declared={inv.declared}
          inBoundary={inBoundary(linkedTool.id)}
          canEdit={canEdit && !archived}
          onSave={async (next, expected) => {
            const saved = await inv.putControls(linkedTool.id, next, expected);
            showNotification('Control links saved.');
            return saved;
          }}
          onAddToBoundary={() => inv.patchTools({ add: [linkedTool.id] })}
          onClose={() => {
            const id = linkedTool.id;
            setLinksFor(null);
            setTimeout(() => document.querySelector<HTMLElement>(`[data-links-for="${id}"]`)?.focus(), 0);
          }}
        />
      )}
      {quickAdd && (
        <ToolQuickAddDialog
          tools={reg.tools}
          limitLeft={Math.max(0, reg.limit - reg.tools.length)}
          program={programReady && activeProgram ? { name: activeProgram.name, ready: !archived, declared: inv.declared, catalogIds } : null}
          onBatch={reg.createBatch}
          onAddToBoundary={(ids) => inv.patchTools({ add: ids })}
          onLinkControls={async (id, ids) => {
            await inv.putControls(id, ids.map((c) => ({ controlId: c, evidenceSource: false })), []);
          }}
          onAddByHand={() => setDialog({ initial: null, key: ++dialogCounter.current, stacked: true })}
          onDone={(text) => {
            setQuickAdd(false);
            showNotification(text);
          }}
          onClose={() => setQuickAdd(false)}
        />
      )}
      {seedOpen && (
        <SurveySeedDialog
          candidates={seeds}
          sourceLabel={activeProgram?.stackProfile ? `From ${activeProgram.name}'s survey answers` : "From your organization's technology survey"}
          onBatch={reg.createBatch}
          onDone={(text) => {
            setSeedOpen(false);
            showNotification(text);
            setTimeout(() => (reviewRef.current ?? searchRef.current)?.focus(), 0);
          }}
          onClose={() => setSeedOpen(false)}
        />
      )}
    </section>
  );
};

export default ToolRegisterPanel;
