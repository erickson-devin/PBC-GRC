import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import confetti from 'canvas-confetti';
import {
  AssessmentState,
  ControlStatus,
  EvidenceItem,
  SSPMetadata,
  ComplianceMetrics,
  ControlState,
} from '../types/cmmc';
import { AssessmentObjective, ObjectiveStatus } from '../types/assessment';
import { controlIdOfObjective, type ObjectiveInput, type ObjectiveRecord } from '../types/controlObjectives';
import { FrameworkControlDefinition } from '../types/framework';
import { ReportDocumentType } from '../types/report';
import {
  getFrameworkControls,
  getEquivalentControlIds,
  FRAMEWORK_REGISTRY,
  findControlDefinition,
  getAssessmentObjectivesForControl,
  calculateControlRollup,
} from '../data/frameworks';
import { StorageService, createInitialState } from '../services/storageService';
import { EvidenceVault } from '../services/evidenceVault';
import { useEvidenceBlobScrub } from '../hooks/useEvidenceBlobScrub';
import { useLocalAssetScrub } from '../hooks/useLocalAssetScrub';
import { computeSha256 } from '../services/evidenceIntegrity';
import { generateEvidenceObjectPath } from '../data/audit/storageDriver';
import { computeDomainStats } from '../data/frameworks/domainStats';
import { hasNist80053Objectives } from '../data/frameworks/nist80053/objectives';
import { loadNist80053Objectives } from '../data/frameworks/nist80053/objectivesLazy';
import { ApiClient, ApiError } from '../services/apiClient';
import { unsavedControlNotes } from '../services/unsavedText';
import { registerBeforeLock } from '../services/idleLock';
import { useUnsavedTextProvider } from '../hooks/useUnsavedTextProvider';
import { computeNotesStatus, NotesStatus } from '../services/browserStorageScrub';
import { programCacheSegment, programScopeKey, shouldPersistAssessment } from '../data/programSync';
import { programFrameworkControls } from '../data/programScope';
import {
  OBJECTIVE_CASCADE_EVENT,
  applyImportResult,
  mergeServerObjectives,
  objectivesToUpload,
  pruneResolvedReviews,
  reconcileObjectives,
  resolveConflict,
  stackCascadeFill,
  type ObjectiveCascadeDetail,
} from '../data/objectiveSync';
import {
  coalesceSaveFailure,
  controlSaveFailureMessage,
  isStaleWriteError,
  revertFailedControlFields,
  staleWriteMessage,
  type ControlSaveFailure,
} from '../data/controlSave';
import { createNotesAutosave, createSaveChain, createStampedSaveChain, newerStamp, notesKey, type NotesDraft } from '../data/notesAutosave';
import { errorMessage } from '../utils/errors';
import { useTenant } from './TenantContext';
import { recordAuditEvent, describeNotesForLedger } from '../data/audit/auditLogger';
import { planStigNarratives } from '../utils/stigNarrativePlan';
import { applyControlNext, planControlRole, planControlStatus, planStarterTemplate } from '../utils/controlEditPlan';
import {
  AssetTelemetryRecord,
  BoundaryAggregationResult,
  FailingAssetInfo,
} from '../types/telemetry';
import {
  getEnclaveFleet,
  aggregateAssetTelemetry,
  applyBoundaryTelemetryToControls,
  fleetStorageMode,
} from '../data/telemetry/assetTelemetryEngine';

export type NavigationTab =
  | 'dashboard'
  | 'matrix'      // Control Matrix (renamed from 'controls')
  | 'controls'    // Legacy alias → renders same as 'matrix'
  | 'assets'      // Asset Inventory & Fleet
  | 'evidence'    // Evidence Vault (renamed from 'vault')
  | 'vault'       // Legacy alias → renders same as 'evidence'
  | 'policies'    // Living Policy Library
  | 'ssp'         // System Security Plan
  | 'sspimport'   // SSP import: upload an existing plan and review the controls it maps to
  | 'poam'        // Plan of Action & Milestones
  | 'export'      // Export Audit Package
  | 'rbac'        // Team & Role RBAC
  | 'audit_logs'  // Immutable Audit Trail (renamed from 'audit')
  | 'audit'       // Legacy alias → renders same as 'audit_logs'
  | 'guidance'    // Framework Guidance & Authority
  | 'settings'    // Enclave Settings
  | 'programs'    // Programs & Boundaries (the programs page)
  | 'stigs';      // Legacy — now external link, kept for backwards compat

interface AssessmentContextType {
  state: AssessmentState;
  /** Where this tenant's implementation notes come from right now (browser, loading / loaded from the server, or unavailable). */
  notesStatus: NotesStatus;
  /** False while a server-backed tenant's notes are not loaded: editing them would overwrite the server copy blindly. */
  notesEditable: boolean;
  /** The last control edit the server did not save (status, notes or role), with how many failed since it was dismissed. */
  controlSaveError: ControlSaveFailure | null;
  dismissControlSaveError: () => void;
  metrics: ComplianceMetrics;
  frameworkControls: FrameworkControlDefinition[];
  activeTab: NavigationTab;
  setActiveTab: (tab: NavigationTab) => void;
  selectedControlId: string | null;
  setSelectedControlId: (id: string | null) => void;
  selectedDomainFilter: string;
  setSelectedDomainFilter: (domain: string) => void;
  selectedStatusFilter: ControlStatus | 'ALL';
  setSelectedStatusFilter: (status: ControlStatus | 'ALL') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  previewEvidence: EvidenceItem | null;
  setPreviewEvidence: (item: EvidenceItem | null) => void;

  // Boundary Telemetry & Fleet State
  fleetAssets: AssetTelemetryRecord[];
  boundaryAggregation: BoundaryAggregationResult | null;
  refreshBoundaryTelemetry: () => Promise<BoundaryAggregationResult>;

  // Actions with RBAC enforcement
  updateControlStatus: (controlId: string, status: ControlStatus, failingAssets?: FailingAssetInfo[]) => void;
  updateControlNotes: (controlId: string, notes: string) => void;
  /** Sends a control's typed notes to the server now (the notes are otherwise saved a moment after the last keystroke). */
  flushControlNotes: (controlId: string) => void;
  updateControlRole: (controlId: string, role: string) => void;
  applyStarterTemplate: (controlId: string, narrative: string) => void;
  bulkApplyStigNarratives: (narratives: Record<string, string>) => number;
  updateSSPMetadata: (metadata: Partial<SSPMetadata>) => void;
  uploadEvidence: (controlId: string, file: File, description?: string) => Promise<EvidenceItem>;
  /** Resolves true when the evidence was removed, false when it was refused (no permission, or the server could not delete it). */
  removeEvidence: (evidenceId: string) => Promise<boolean>;
  resetAssessment: () => Promise<void>;
  importAssessmentJSON: (file: File) => Promise<boolean>;
  exportAssessmentJSON: () => void;
  exportAssessmentMarkdown: () => void;

  // NIST SP 800-171A Objective-Level Evaluation & Rollup
  getObjectivesForControl: (controlId: string) => AssessmentObjective[];
  updateObjectiveStatus: (objectiveId: string, status: ObjectiveStatus) => void;
  updateObjectiveNarrative: (objectiveId: string, narrative: string) => void;
  applyObjectivePrefilledNarrative: (objectiveId: string) => void;
  applyAllObjectiveTemplatesForControl: (controlId: string) => void;
  linkEvidenceToObjective: (objectiveId: string, evidenceId: string) => void;
  recalculateControlStatusFromObjectives: (controlId: string) => ControlStatus;
  /** True while this browser holds objective narratives that are not on the server and this user cannot move them (an owner has to open the organization). */
  objectivesNeedOwner: boolean;
  /** Objective ids whose cached narrative differs from the server's (owner / MSP only; empty for everybody else). */
  objectivePendingReview: string[];
  /** The server's narrative for an objective ('' when it has none). */
  serverObjectiveNarrative: (objectiveId: string) => string;
  /** Settles one conflict: 'browser' saves this browser's text to the server, 'server' keeps the server's. Rejects when the save fails. */
  resolveObjectiveConflict: (objectiveId: string, choice: 'browser' | 'server') => Promise<void>;

  // Artifact & Compliance Export Center Modal
  isExportModalOpen: boolean;
  setIsExportModalOpen: (open: boolean) => void;
  exportModalInitialDocType?: ReportDocumentType;
  openExportModal: (initialDocType?: ReportDocumentType) => void;
}

const AssessmentContext = createContext<AssessmentContextType | undefined>(undefined);

export const AssessmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    currentTenant,
    canEdit,
    currentUser,
    liveControls,
    liveScopeKey,
    liveEvidence,
    activeProgram,
    syncError,
    updateLiveControl,
    liveObjectives,
    updateLiveObjective,
    updateLiveObjectivesBulk,
    importLiveObjectives,
    createLiveEvidenceUploadUrl,
    deleteLiveEvidence,
    activeFramework,
    activeBaselineTier,
    activeOverlayFilters,
    ciaTriad,
  } = useTenant();

  // What is on screen: the tenant, or tenant::program. Live data, the cache and every save are matched against it.
  const programId = activeProgram?.id;
  const programScope = programScopeKey(currentTenant.id, programId);
  // The default program keeps the legacy cache key; any other program has its own (see StorageService.getAssessmentKey)
  const cacheSegment = programCacheSegment(activeProgram);
  // Every ledger entry says which program it was made in (the ledger itself stays one per tenant)
  const auditMetadata = useMemo(() => ({ programId: programId ?? null }), [programId]);

  // Notes count as loaded only when the live controls are those of this very program (scope keys in both fields)
  const notesStatus = computeNotesStatus({
    serverBacked: Boolean(currentTenant.serverBacked),
    liveControlsTenantId: liveScopeKey,
    tenantId: programScope,
    syncError,
    hasToken: Boolean(ApiClient.getSessionRef()),
  });
  const notesEditable = notesStatus === 'browser' || notesStatus === 'loaded';
  const NOTES_NOT_EDITABLE_MESSAGE =
    'Implementation notes are not loaded from the server, so they cannot be edited right now. They are not kept in this browser.';

  // Dynamically resolve controls for the currently selected framework, baseline/CIA triad, and overlay filters
  const frameworkControls = useMemo(() => {
    const isNist80053 = activeFramework === 'NIST_800_53_REV5' || activeFramework === 'nist-800-53-r5';
    // A NIST program with the privacy baseline adds the SP 800-53B privacy controls to its security baseline (each control once)
    if (isNist80053 && activeProgram) {
      return programFrameworkControls(
        { framework: activeFramework, baseline: activeProgram.baseline ?? null, privacyBaseline: activeProgram.privacyBaseline },
        activeOverlayFilters
      );
    }
    const baseline = isNist80053 ? ciaTriad : activeBaselineTier;
    return getFrameworkControls(
      activeFramework,
      baseline,
      activeOverlayFilters
    );
  }, [activeFramework, activeBaselineTier, ciaTriad, activeOverlayFilters, activeProgram]);

  // Load tenant-isolated assessment state
  // (the program's cache is loaded by the effect below once the program is known; until then this is the tenant / default cache)
  const [state, setState] = useState<AssessmentState>(() => StorageService.loadAssessment(currentTenant));
  // The scope this state was loaded for
  const stateScope = programScopeKey(state.tenantId, state.programId);
  // Latest state for actions that must read it without a state dependency (import diff)
  const stateRef = useRef(state);
  stateRef.current = state;
  // Notes are saved a moment after the last keystroke (one draft per control), and a control's saves go out one at a time. The stamps are
  // the server's updated_at of the last save per control; a control whose save was refused as stale keeps the text on screen.
  const sendNotesRef = useRef<(key: string, draft: NotesDraft) => void>(() => {});
  const notesAutosaveRef = useRef(createNotesAutosave((k, d) => sendNotesRef.current(k, d)));
  const saveChainRef = useRef(createSaveChain());
  const serverStampRef = useRef(new Map<string, string>());
  // Objective saves are queued the same way, one objective at a time, each reusing the stamp the last answer returned
  const objectiveSavesRef = useRef(createStampedSaveChain());
  const staleNotesRef = useRef(new Set<string>());
  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [selectedDomainFilter, setSelectedDomainFilter] = useState<string>('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<ControlStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [previewEvidence, setPreviewEvidence] = useState<EvidenceItem | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [exportModalInitialDocType, setExportModalInitialDocType] = useState<ReportDocumentType | undefined>(undefined);

  // Boundary Telemetry & Fleet State
  const [fleetAssets, setFleetAssets] = useState<AssetTelemetryRecord[]>(() => getEnclaveFleet(currentTenant.id, fleetStorageMode(currentTenant)));
  const [boundaryAggregation, setBoundaryAggregation] = useState<BoundaryAggregationResult | null>(null);

  const refreshBoundaryTelemetry = useCallback(async () => {
    try {
      const boundary = await aggregateAssetTelemetry(currentTenant.id, fleetStorageMode(currentTenant));
      setBoundaryAggregation(boundary);
      setFleetAssets(getEnclaveFleet(currentTenant.id, fleetStorageMode(currentTenant)));

      setState(prev => ({
        ...prev,
        controls: applyBoundaryTelemetryToControls(prev.controls, boundary),
      }));

      return boundary;
    } catch {
      const fallback = await aggregateAssetTelemetry(currentTenant.id, fleetStorageMode(currentTenant));
      return fallback;
    }
  }, [currentTenant.id, currentTenant.serverBacked]);

  // Initial boundary evaluation on mount / tenant switch / program switch (the reloaded program's controls get the telemetry too)
  useEffect(() => {
    refreshBoundaryTelemetry();
  }, [currentTenant.id, programScope, refreshBoundaryTelemetry]);

  const openExportModal = useCallback((initialDocType?: ReportDocumentType) => {
    setExportModalInitialDocType(initialDocType);
    setIsExportModalOpen(true);
  }, []);

  // When the active tenant or program changes, reload that scope's partitioned assessment from its own cache key and reset what
  // was selected in the previous one. (Nothing of the previous program survives in `state`: it is replaced as a whole.)
  useEffect(() => {
    const scopeState = StorageService.loadAssessment(currentTenant, activeProgram?.framework ?? 'CMMC_L1', cacheSegment);
    setState({ ...scopeState, programId });
    setSelectedControlId(null);
    setSelectedDomainFilter('ALL');
    setSelectedStatusFilter('ALL');
    setSearchQuery('');
    setPreviewEvidence(null);
    setIsExportModalOpen(false);
  }, [currentTenant.id, programScope]);

  // Synchronize live backend data into assessment state when received from PostgreSQL. Scoped: only live data of the scope on
  // screen is merged, and only into a state loaded for that same scope (program A's controls never reach program B).
  useEffect(() => {
    if (liveControls && liveScopeKey === programScope) {
      setState(prev => {
        if (programScopeKey(prev.tenantId, prev.programId) !== programScope) return prev;
        const controls = { ...prev.controls, ...liveControls };
        // A control whose notes are being typed, are on their way to the server, or were refused keeps the text on screen: a server
        // copy (an earlier save's answer) must not put older text back over it
        for (const id of Object.keys(liveControls)) {
          const key = notesKey(programScope, id);
          const local = prev.controls[id];
          if (local && (notesAutosaveRef.current.has(key) || saveChainRef.current.busy(key) || staleNotesRef.current.has(key))) {
            controls[id] = { ...controls[id], implementationNotes: local.implementationNotes };
          }
        }
        return {
          ...prev,
          tenantId: currentTenant.id,
          controls,
          evidenceIndex: liveEvidence ? liveEvidence : prev.evidenceIndex,
        };
      });
    }
  }, [liveControls, liveEvidence, liveScopeKey, programScope, stateScope, currentTenant.id]);

  // Server-backed tenants keep evidence files only on the server: remove a leftover browser copy once the server verifies it
  useEvidenceBlobScrub();

  // Same for a leftover browser-local asset list, once the server holds every asset in it
  useLocalAssetScrub();

  // Auto-save state changes under the scope's own cache key. Never save a state under a scope it was not loaded for: while a
  // program switch is settling `state` still belongs to the previous program and must not land in the new program's key.
  useEffect(() => {
    if (shouldPersistAssessment(stateScope, programScope)) {
      // Server-backed tenants never keep implementation notes in this browser (Phase 5.6)
      StorageService.saveAssessment(currentTenant.id, state, { keepNotes: !currentTenant.serverBacked, segment: cacheSegment });
    }
  }, [state, stateScope, programScope, cacheSegment, currentTenant.id, currentTenant.serverBacked]);

  // Calculate Real-time Compliance Metrics dynamically for active framework controls
  const metrics: ComplianceMetrics = useMemo(() => {
    const totalControls = frameworkControls.length;
    const currentFwDef = FRAMEWORK_REGISTRY[activeFramework];
    const domainStats = computeDomainStats(
      frameworkControls,
      state.controls,
      currentFwDef?.domains ? Object.keys(currentFwDef.domains) : []
    );

    let metCount = 0;
    let inProgressCount = 0;
    let notStartedCount = 0;
    let notMetCount = 0;
    for (const stat of Object.values(domainStats)) {
      metCount += stat.met;
      inProgressCount += stat.inProgress;
      notMetCount += stat.notMet;
      notStartedCount += stat.notStarted;
    }

    const completionPercentage = totalControls > 0 ? Math.round((metCount / totalControls) * 100) : 0;
    const isSprsReady = metCount === totalControls && totalControls > 0;

    return {
      totalControls,
      metCount,
      inProgressCount,
      notStartedCount,
      notMetCount,
      completionPercentage,
      isSprsReady,
      domainStats,
    };
  }, [frameworkControls, state.controls, activeFramework]);

  // Celebrate SPRS readiness
  const triggerSprsCelebration = useCallback(() => {
    try {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#0e8ee9', '#10b981', '#f59e0b', '#8b5cf6'],
      });
    } catch {
      // Confetti fallback
    }
  }, []);

  // -------------------------------------------------------------------------
  // Saving control edits. A server-backed tenant's status, notes and role are saved with one PUT each. The screen shows the edit at
  // once; when the server refuses it or cannot be reached the edit is not shown as saved: the status / role go back to the server's
  // value and a notice says what was not saved (it never repeats the text: notes may contain CUI).
  // -------------------------------------------------------------------------
  const liveControlsRef = useRef(liveControls);
  liveControlsRef.current = liveControls;
  // Notes typed but not on the server yet are reported to the unsaved-text rescue (a session the server ends takes them with it).
  // Server-backed tenants only: a browser-only tenant keeps its notes in the browser cache. Read through refs: the rescue runs synchronously.
  const liveScopeKeyRef = useRef(liveScopeKey);
  liveScopeKeyRef.current = liveScopeKey;
  const serverBackedRef = useRef(currentTenant.serverBacked);
  serverBackedRef.current = currentTenant.serverBacked;
  useUnsavedTextProvider(() => {
    const s = stateRef.current;
    if (!serverBackedRef.current || programScopeKey(s.tenantId, s.programId) !== liveScopeKeyRef.current) return [];
    return unsavedControlNotes(s.controls, liveControlsRef.current);
  });
  const programScopeRef = useRef(programScope);
  programScopeRef.current = programScope;
  const [controlSaveError, setControlSaveError] = useState<ControlSaveFailure | null>(null);
  const dismissControlSaveError = useCallback(() => setControlSaveError(null), []);
  // A notice belongs to the program it was raised in
  useEffect(() => {
    setControlSaveError(null);
    serverStampRef.current.clear();
    staleNotesRef.current.clear();
    objectiveSavesRef.current.clear();
  }, [currentTenant.id, programScope]);

  /**
   * Saves a control edit to the server. Never rejects: a failure is shown in the notice. Resolves with how it went. A control's saves
   * go out one at a time, in the order they were made. `opts.programId` is the program a debounced notes save was typed in.
   */
  const saveControl = useCallback(async (
    controlId: string,
    update: Partial<ControlState>,
    opts?: { programId?: string; fromAutosave?: boolean }
  ): Promise<'saved' | 'failed' | 'unreachable'> => {
    // A browser-only tenant keeps its controls in this browser: nothing to send
    if (!currentTenant.serverBacked) return 'saved';
    const hasNotes = 'implementationNotes' in update;
    // The scope the text was typed in (a flush after a program switch still belongs to the old program)
    const scope = opts?.fromAutosave ? programScopeKey(currentTenant.id, opts.programId) : programScope;
    const key = notesKey(scope, controlId);
    // An edit made now supersedes a draft that has not gone out yet
    if (!opts?.fromAutosave && hasNotes) notesAutosaveRef.current.cancel(key);
    return saveChainRef.current.run(key, async (): Promise<'saved' | 'failed' | 'unreachable'> => {
      // After a stale refusal nothing goes out until the page is reloaded: the server's text was not seen
      if (hasNotes && staleNotesRef.current.has(key)) return 'failed';
      try {
        let sendUpdate: Partial<ControlState> & { expectedUpdatedAt?: string | null } = update;
        if (hasNotes) {
          const base = newerStamp(serverStampRef.current.get(key), liveControlsRef.current?.[controlId]?.updatedAt);
          if (base !== undefined) sendUpdate = { ...update, expectedUpdatedAt: base };
        }
        const saved = await updateLiveControl(controlId, sendUpdate, opts?.programId);
        if (saved?.updatedAt) serverStampRef.current.set(key, saved.updatedAt);
        return 'saved';
      } catch (err: unknown) {
        if (isStaleWriteError(err) && hasNotes) staleNotesRef.current.add(key);
        setState(prev => {
          if (programScopeKey(prev.tenantId, prev.programId) !== scope) return prev;
          const local = prev.controls[controlId];
          if (!local) return prev;
          const next = revertFailedControlFields(local, liveControlsRef.current?.[controlId], update);
          return next === local ? prev : { ...prev, controls: { ...prev.controls, [controlId]: next } };
        });
        const message = controlSaveFailureMessage(controlId, update, err);
        if (message !== null) setControlSaveError(p => coalesceSaveFailure(p, message));
        return (err as { status?: unknown } | null)?.status === 0 ? 'unreachable' : 'failed';
      }
    });
  }, [currentTenant.id, currentTenant.serverBacked, programScope, updateLiveControl]);

  // Action: Update Control Status with RBAC Check
  const updateControlStatus = useCallback((
    controlId: string,
    status: ControlStatus,
    failingAssets?: FailingAssetInfo[]
  ) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify controls for this tenant.');
      return;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    // Worked out once from the current controls: the ledger entry and the save are made here, never inside the state updater
    const plan = planControlStatus(
      stateRef.current.controls, controlId, status, failingAssets,
      { tenantId: currentTenant.id, updatedBy: currentUser.name, timestamp: new Date().toISOString() }
    );

    // Sync to the server
    void saveControl(controlId, { status, updatedBy: currentUser.name });

    // Asynchronously append to immutable audit ledger
    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'CONTROL_STATUS_UPDATED',
      targetEntity: controlId,
      previousState: plan.previousStatus,
      newState: status,
    }).catch(() => {});

    // Check if this action achieved 100% SPRS readiness
    const controlsAfter = { ...stateRef.current.controls, [controlId]: plan.next };
    const metAfter = Object.entries(controlsAfter).filter(
      ([id, c]) => id !== controlId ? c.status === 'MET' : status === 'MET'
    ).length;

    const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
    if (metAfter === totalRequired && status === 'MET') {
      setTimeout(triggerSprsCelebration, 150);
    }

    setState(prev => applyControlNext(prev, controlId, plan.next));
  }, [canEdit, notesEditable, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, triggerSprsCelebration, activeFramework, frameworkControls, saveControl]);

  // Notes go to the server a moment after the last keystroke (or on blur / tab hide / unmount), one PUT per burst and one ledger entry
  // per PUT. Assigned in an effect, not in render: the flush on a tenant or program switch runs in the previous render's cleanup, and
  // must still send with the previous tenant's closure.
  useEffect(() => {
    sendNotesRef.current = (_key, d) => {
      // Notes may contain CUI and the ledger sits in localStorage: record a digest and length only, never text
      if (d.previous !== d.text) {
        // The program the text was typed in, which may no longer be the one on screen
        const auditMetadata = { programId: d.programId ?? null };
        Promise.all([describeNotesForLedger(d.previous), describeNotesForLedger(d.text)])
          .then(([previousState, newState]) => recordAuditEvent({
            tenantId: currentTenant.id,
            metadata: auditMetadata,
            actorId: currentUser.id,
            actorEmail: currentUser.email,
            actorRole: currentUser.roles[currentTenant.id] || 'Operator',
            actionType: 'CONTROL_NOTES_UPDATED',
            targetEntity: d.controlId,
            previousState,
            newState,
          }))
          .catch(() => {});
      }
      void saveControl(d.controlId, { implementationNotes: d.text, updatedBy: d.updatedBy }, { programId: d.programId, fromAutosave: true });
    };
  });

  const flushControlNotes = useCallback((controlId: string) => {
    notesAutosaveRef.current.flush(notesKey(programScope, controlId));
  }, [programScope]);

  // Leaving the program or the page sends what is typed; a tab that is hidden sends it too (it may never come back)
  useEffect(() => () => { notesAutosaveRef.current.flushAll(); }, [currentTenant.id, programScope]);
  // The idle lock (#163) ends the server session: typed notes are sent first, and the lock waits for them (it gives up after 3 s)
  useEffect(() => registerBeforeLock('notes', async () => {
    notesAutosaveRef.current.flushAll();
    const giveUpAt = Date.now() + 5000;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (saveChainRef.current.active() > 0 && Date.now() < giveUpAt) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }), []);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') notesAutosaveRef.current.flushAll();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (notesAutosaveRef.current.size() > 0 || saveChainRef.current.active() > 0 || staleNotesRef.current.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // Action: Update Control Notes with RBAC Check
  const updateControlNotes = useCallback((controlId: string, notes: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    // Sync to the server a moment after the last keystroke (a burst of typing is one save)
    notesAutosaveRef.current.push(notesKey(programScope, controlId), {
      controlId,
      programId,
      updatedBy: currentUser.name,
      previous: stateRef.current.controls[controlId]?.implementationNotes ?? '',
      text: notes,
    });

    setState(prev => {
      const current = prev.controls[controlId] || {
        id: controlId,
        tenantId: currentTenant.id,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT / Security Lead',
        lastUpdated: new Date().toISOString(),
        tags: [],
      };

      return {
        ...prev,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...current,
            implementationNotes: notes,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };
    });
  }, [canEdit, notesEditable, currentTenant.id, programScope, programId, currentUser.name]);

  // Action: Update Control Role with RBAC Check
  const updateControlRole = useCallback((controlId: string, role: string) => {
    if (!canEdit) return;
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    const plan = planControlRole(
      stateRef.current.controls, controlId, role,
      { tenantId: currentTenant.id, updatedBy: currentUser.name, timestamp: new Date().toISOString() }
    );

    // Sync to the server (the audited writer records the change)
    void saveControl(controlId, { responsibleRole: role, updatedBy: currentUser.name });

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'CONTROL_ROLE_UPDATED',
      targetEntity: controlId,
      previousState: plan.previousRole,
      newState: role,
    }).catch(() => {});

    setState(prev => applyControlNext(prev, controlId, plan.next));
  }, [canEdit, notesEditable, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, saveControl]);

  // Action: Apply Starter Template
  const applyStarterTemplate = useCallback((controlId: string, narrative: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to apply templates.');
      return;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    const plan = planStarterTemplate(
      stateRef.current.controls, controlId, narrative,
      { tenantId: currentTenant.id, updatedBy: currentUser.name, timestamp: new Date().toISOString() }
    );

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'TEMPLATE_APPLIED',
      targetEntity: controlId,
      newState: plan.auditNewState,
    }).catch(() => {});

    // Save through the audited server writer; only the fields that change
    void saveControl(controlId, plan.serverUpdate);

    setState(prev => applyControlNext(prev, controlId, plan.next));
  }, [canEdit, notesEditable, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, saveControl]);

  // Action: Bulk Apply STIG Policy Narratives across mapped controls
  const bulkApplyStigNarratives = useCallback((narratives: Record<string, string>): number => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return 0;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return 0;
    }

    // Computed once from the state on screen, outside the updater: StrictMode runs updaters twice and React may defer them (#79)
    const changes = planStigNarratives(stateRef.current.controls, narratives, { tenantId: currentTenant.id, updatedBy: currentUser.name, timestamp: new Date().toISOString() });
    if (changes.length === 0) return 0;
    for (const c of changes) void saveControl(c.id, c.serverUpdate);
    setState(prev => {
      const controls = { ...prev.controls };
      for (const c of changes) controls[c.id] = c.next;
      return { ...prev, controls };
    });
    return changes.length;
  }, [canEdit, notesEditable, currentTenant.id, currentUser.name, saveControl]);

  // -------------------------------------------------------------------------
  // NIST SP 800-171A Objective-Level Evaluation & Rollup Engine
  // -------------------------------------------------------------------------

  // The SP 800-53A objectives (1.3 MB) are fetched only once an SP 800-53 program is open
  const [nistObjectivesReady, setNistObjectivesReady] = useState(hasNist80053Objectives());
  useEffect(() => {
    if (nistObjectivesReady || (activeFramework !== 'NIST_800_53_REV5' && activeFramework !== 'nist-800-53-r5')) return;
    let alive = true;
    loadNist80053Objectives().then(() => alive && setNistObjectivesReady(true)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeFramework, nistObjectivesReady]);

  const getObjectivesForControl = useCallback((controlId: string): AssessmentObjective[] => {
    const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
    return getAssessmentObjectivesForControl(
      controlId,
      ctrl?.title,
      ctrl?.assessmentObjectives,
      state.objectives
    );
  }, [frameworkControls, state.objectives, nistObjectivesReady]);

  const recalculateControlStatusFromObjectives = useCallback((controlId: string): ControlStatus => {
    const objectives = getObjectivesForControl(controlId);
    if (!objectives || objectives.length === 0) return 'NOT_STARTED';
    const rollup = calculateControlRollup(objectives);
    return rollup.calculatedStatus;
  }, [getObjectivesForControl]);

  // -------------------------------------------------------------------------
  // Objectives held by the server. A server-backed tenant's objective status, narrative and evidence links live on the server (owner /
  // MSP write, everybody reads); this browser keeps only status, evidence links and times for offline reading. Every writer updates the
  // screen at once and saves through the audited server call: a failed save is reported and rolled back. A browser-only tenant keeps
  // everything in its own cache.
  // -------------------------------------------------------------------------
  const liveObjectivesRef = useRef(liveObjectives);
  liveObjectivesRef.current = liveObjectives;
  // The scope whose cache holds narratives that are not on the server and that this user cannot move (viewer / assessor)
  const [needOwnerScope, setNeedOwnerScope] = useState<string | null>(null);
  const objectivesNeedOwner = Boolean(currentTenant.serverBacked) && needOwnerScope === programScope;
  // The scope an upload is running for: one upload at a time
  const migratingScope = useRef<string | null>(null);

  const isKnownControl = useCallback((controlId: string) => Boolean(findControlDefinition(controlId)), []);

  /** The catalog objective for an id the cache does not hold yet (the server's record is laid over it). */
  const seedObjective = useCallback((objectiveId: string, controlId: string): AssessmentObjective | undefined => {
    const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
    return getAssessmentObjectivesForControl(controlId, ctrl?.title, ctrl?.assessmentObjectives).find(o => o.id === objectiveId);
  }, [frameworkControls]);

  // Merge the server's objectives into the state, only for the scope on screen and only into a state of that scope. The server's
  // narratives reach the state only once the marker is set (or is set in the same step because nothing is left to upload): before that
  // the cache is the only copy of its narratives, and the cache would keep the server's too. Cached objectives that are not on the
  // server yet are uploaded first (owner / MSP), or left alone with a notice (everybody else).
  useEffect(() => {
    if (!currentTenant.serverBacked || !liveObjectives || liveScopeKey !== programScope || stateScope !== programScope) return;
    const reconcileOptions = { canWrite: canEdit, now: new Date().toISOString(), seedFor: seedObjective, isKnownControl };
    const { outcome } = reconcileObjectives(stateRef.current, liveObjectives, reconcileOptions);
    if (outcome === 'blocked') {
      setNeedOwnerScope(programScope);
      return;
    }
    setNeedOwnerScope(null);
    if (outcome === 'merged' || outcome === 'marked') {
      setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== programScope ? prev : reconcileObjectives(prev, liveObjectives, reconcileOptions).state));
      return;
    }

    // Upload what this browser holds. Nothing is stripped unless every chunk went through: a failure leaves the cache as it is and
    // the next load tries again.
    if (migratingScope.current === programScope) return;
    migratingScope.current = programScope;
    const selection = objectivesToUpload(stateRef.current.objectives, isKnownControl);
    void (async () => {
      try {
        const { results, records } = await importLiveObjectives(selection.items);
        setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== programScope ? prev : applyImportResult(prev, results, new Date().toISOString(), selection.unsendable, records)));
      } catch {
        // network or server failure: keep everything, retry on the next load
      } finally {
        if (migratingScope.current === programScope) migratingScope.current = null;
      }
    })();
  }, [currentTenant.serverBacked, liveObjectives, liveScopeKey, programScope, stateScope, state.objectivesMigratedAt, canEdit, seedObjective, isKnownControl, importLiveObjectives]);

  // A browser-only tenant's stack cascade (raised by TenantContext.updateStackProfile): fills the empty narratives of this program's objectives
  useEffect(() => {
    if (currentTenant.serverBacked) return;
    const onCascade = (e: Event) => {
      const detail = (e as CustomEvent<ObjectiveCascadeDetail>).detail;
      if (!detail || detail.scope !== programScope || !canEdit) return;
      const current = stateRef.current.objectives || {};
      const items = stackCascadeFill(frameworkControls.map(c => c.id), detail.profile, id => current[id]?.implementationNarrative ?? '');
      if (items.length === 0) return;
      const now = new Date().toISOString();
      setState(prev => {
        if (programScopeKey(prev.tenantId, prev.programId) !== programScope) return prev;
        const objectives = { ...(prev.objectives || {}) };
        for (const item of items) {
          if ((objectives[item.objectiveId]?.implementationNarrative || '').trim() !== '') continue;
          const base = objectives[item.objectiveId] ?? seedObjective(item.objectiveId, item.controlId);
          if (!base) continue;
          objectives[item.objectiveId] = { ...base, implementationNarrative: item.narrative ?? '', lastUpdated: now, updatedBy: 'Enclave Stack Auto-Cascade' };
        }
        return { ...prev, objectives };
      });
    };
    window.addEventListener(OBJECTIVE_CASCADE_EVENT, onCascade);
    return () => window.removeEventListener(OBJECTIVE_CASCADE_EVENT, onCascade);
  }, [currentTenant.serverBacked, programScope, canEdit, frameworkControls, seedObjective]);

  /** True (after telling the user) when objectives cannot be changed right now: read-only role, or a server-backed tenant whose data is not loaded. */
  const objectiveWriteBlocked = useCallback((what: 'objectives' | 'narratives'): boolean => {
    if (!canEdit) {
      alert(`Read-Only access: You do not have permission to modify ${what} for this tenant.`);
      return true;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return true;
    }
    return false;
  }, [canEdit, notesEditable]);

  /** The state the writers start from, or null while it is not the one on screen (a program switch is settling). */
  const writableState = useCallback((): AssessmentState | null => {
    const s = stateRef.current;
    return programScopeKey(s.tenantId, s.programId) === programScope ? s : null;
  }, [programScope]);

  /** The cached objectives of a control and the catalog objectives over them. */
  const objectivesOf = useCallback((s: AssessmentState, controlId: string): AssessmentObjective[] => {
    const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
    return getAssessmentObjectivesForControl(controlId, ctrl?.title, ctrl?.assessmentObjectives, s.objectives || {});
  }, [frameworkControls]);

  // Narratives may contain CUI and the ledger sits in localStorage: record a digest and length only, never text
  const recordObjectiveNarrativeChange = useCallback((objectiveId: string, previous: string, next: string) => {
    if (previous === next) return;
    Promise.all([describeNotesForLedger(previous), describeNotesForLedger(next)])
      .then(([previousState, newState]) => recordAuditEvent({
        tenantId: currentTenant.id,
        metadata: auditMetadata,
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'OBJECTIVE_NARRATIVE_UPDATED',
        targetEntity: objectiveId,
        previousState,
        newState,
      }))
      .catch(() => {});
  }, [currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles]);

  /** After a failed save: shows the server's records again for these ids. Only once the cache holds no narrative that has not been uploaded. */
  const revertObjectives = useCallback((ids: string[], scope: string) => {
    const live = liveObjectivesRef.current;
    setState(prev => {
      if (!prev.objectivesMigratedAt || programScopeKey(prev.tenantId, prev.programId) !== scope) return prev;
      const objectives = { ...(prev.objectives || {}) };
      const serverSubset: Record<string, ObjectiveRecord> = {};
      for (const id of ids) {
        const record = live?.[id];
        if (record) serverSubset[id] = record;
        else delete objectives[id];
      }
      return { ...prev, objectives: mergeServerObjectives(objectives, serverSubset, { seedFor: seedObjective, pending: prev.objectivesPendingReview }) };
    });
  }, [seedObjective]);

  /** Saves objectives to the server (server-backed tenants), and optionally the rolled-up control change with them. Both calls start now, so both belong to the program on screen at the click. */
  const saveObjectives = useCallback((inputs: Array<ObjectiveInput & { checkStale?: boolean }>, control?: { id: string; update: Partial<ControlState> }) => {
    if (!currentTenant.serverBacked || inputs.length === 0) return;
    const scope = programScope;
    // A queued save goes to the program it was made in, even if another is opened before it runs
    const program = programId ?? null;
    // A single objective's saves go out one at a time, each carrying the stamp the previous answer returned (the server refuses a
    // narrative save made against an older stamp, so back-to-back edits must not reuse the one read at call time)
    const objectiveSave = inputs.length === 1
      ? objectiveSavesRef.current.run(
        notesKey(scope, inputs[0].objectiveId),
        () => liveObjectivesRef.current?.[inputs[0].objectiveId]?.updatedAt ?? null,
        expected => updateLiveObjective(
          inputs[0].objectiveId,
          inputs[0].controlId,
          { status: inputs[0].status, narrative: inputs[0].narrative, linkedEvidenceIds: inputs[0].linkedEvidenceIds, ...(inputs[0].checkStale ? { expectedUpdatedAt: expected ?? null } : {}) },
          program
        )
      )
      : updateLiveObjectivesBulk(inputs);
    // The control part reports its own failure (saveControl never rejects), apart from the objective part
    if (control) void saveControl(control.id, control.update);
    void objectiveSave.catch((err: unknown) => {
      // A 401 means the session has ended: the sign-in screen says so, and an alert here would come after the sign-out
      // A stale write (someone else saved this objective first) is a notice, not an alert; the text stays on screen (nothing to revert to)
      if (isStaleWriteError(err)) {
        setControlSaveError(p => coalesceSaveFailure(p, staleWriteMessage('objective', inputs[0].objectiveId)));
        return;
      }
      if (!(err instanceof ApiError && err.status === 401)) {
        alert(`The objective change could not be saved to the server: ${errorMessage(err) || 'unknown error'}`);
      }
      revertObjectives(inputs.map(i => i.objectiveId), scope);
    });
  }, [currentTenant.serverBacked, programScope, programId, updateLiveObjective, updateLiveObjectivesBulk, saveControl, revertObjectives]);

  // Review of a conflict the one-time upload found: the id keeps its cached narrative until the user picks a text
  // Ids whose cached narrative is empty or equal to the server's need no decision: they are dropped (this heals caches from older builds)
  useEffect(() => {
    if (!currentTenant.serverBacked || !liveObjectives || liveScopeKey !== programScope || stateScope !== programScope) return;
    if (!stateRef.current.objectivesPendingReview?.length) return;
    setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== programScope ? prev : pruneResolvedReviews(prev, liveObjectives)));
  }, [currentTenant.serverBacked, liveObjectives, liveScopeKey, programScope, stateScope, state.objectivesPendingReview]);
  const objectivePendingReview = useMemo(
    () => (canEdit && currentTenant.serverBacked && stateScope === programScope ? state.objectivesPendingReview ?? [] : []),
    [canEdit, currentTenant.serverBacked, stateScope, programScope, state.objectivesPendingReview]
  );
  const serverObjectiveNarrative = useCallback((objectiveId: string): string => liveObjectives?.[objectiveId]?.narrative ?? '', [liveObjectives]);

  const resolveObjectiveConflict = useCallback(async (objectiveId: string, choice: 'browser' | 'server'): Promise<void> => {
    if (!canEdit) throw new Error('Read-Only access: only a tenant owner can resolve this.');
    const s = writableState();
    if (!s) throw new Error('The program on screen changed; open it again.');
    const serverText = liveObjectivesRef.current?.[objectiveId]?.narrative ?? '';
    if (choice === 'browser') {
      const controlId = controlIdOfObjective(objectiveId);
      if (controlId === null) throw new Error('This objective id is not valid, so its text cannot be saved to the server.');
      const browserText = s.objectives?.[objectiveId]?.implementationNarrative ?? '';
      if (browserText.trim() === '') throw new Error('This browser has no text for this objective, so there is nothing to save.');
      // Only the narrative is sent: a stale cached status or evidence list must never overwrite the server's
      await updateLiveObjective(objectiveId, controlId, { narrative: browserText });
      recordObjectiveNarrativeChange(objectiveId, serverText, browserText);
    }
    setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== programScope ? prev : resolveConflict(prev, objectiveId, choice, serverText)));
  }, [canEdit, writableState, programScope, updateLiveObjective, recordObjectiveNarrativeChange]);

  const updateObjectiveStatus = useCallback((objectiveId: string, status: ObjectiveStatus) => {
    if (objectiveWriteBlocked('objectives')) return;
    const s = writableState();
    if (!s) return;

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    const baseObjectives = objectivesOf(s, controlId);
    const target = baseObjectives.find(o => o.id === objectiveId) || {
      id: objectiveId,
      controlId,
      letter: match ? match[2] : 'a',
      text: 'Objective determination',
      status,
      prefilledTemplate: '',
      implementationNarrative: '',
      linkedEvidenceIds: [],
      isAutoVerifiedByTelemetry: false,
    };

    const now = new Date().toISOString();
    const updatedObjective: AssessmentObjective = {
      ...target,
      status,
      lastUpdated: now,
      updatedBy: currentUser.name,
    };

    // Recalculate control status according to rollup spec:
    const allObjs = baseObjectives.map(o => o.id === objectiveId ? updatedObjective : o);
    const rollup = calculateControlRollup(allObjs);
    const rolledStatus: ControlStatus = rollup.calculatedStatus;

    const currentCtrl = s.controls[controlId] || {
      id: controlId,
      tenantId: currentTenant.id,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: now,
      tags: [],
    };

    setState(prev => ({
      ...prev,
      objectives: {
        ...(prev.objectives || {}),
        [objectiveId]: updatedObjective,
      },
      controls: {
        ...prev.controls,
        [controlId]: {
          ...(prev.controls[controlId] || currentCtrl),
          status: rolledStatus,
          lastUpdated: now,
          updatedBy: currentUser.name,
        },
      },
    }));

    if (rolledStatus === 'MET') {
      const metAfter = Object.entries(s.controls).filter(([id, c]) => id !== controlId && c.status === 'MET').length + 1;
      const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
      if (metAfter === totalRequired) {
        setTimeout(triggerSprsCelebration, 150);
      }
    }

    // Save: the objective, and the rolled-up control status when it changed (otherwise the next live merge reverts it)
    if (currentTenant.serverBacked) {
      saveObjectives([{ objectiveId, controlId, status }]);
      if (rolledStatus !== currentCtrl.status) {
        void saveControl(controlId, { status: rolledStatus, updatedBy: currentUser.name });
      }
    }

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'CONTROL_STATUS_UPDATED',
      targetEntity: objectiveId,
      // Both sides are the control's status (the objective click rolls up into it)
      previousState: currentCtrl.status,
      newState: rolledStatus,
    }).catch(() => {});
  }, [objectiveWriteBlocked, writableState, objectivesOf, frameworkControls, currentUser, currentTenant.id, currentTenant.serverBacked, auditMetadata, activeFramework, triggerSprsCelebration, saveObjectives, saveControl]);

  const updateObjectiveNarrative = useCallback((objectiveId: string, narrative: string) => {
    if (objectiveWriteBlocked('narratives')) return;
    const s = writableState();
    if (!s) return;

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    const target = objectivesOf(s, controlId).find(o => o.id === objectiveId);
    if (!target) return;
    const previous = target.implementationNarrative || '';
    if (previous === narrative) return;

    const updatedObjective: AssessmentObjective = {
      ...target,
      implementationNarrative: narrative,
      lastUpdated: new Date().toISOString(),
      updatedBy: currentUser.name,
    };

    setState(prev => ({
      ...prev,
      objectives: {
        ...(prev.objectives || {}),
        [objectiveId]: updatedObjective,
      },
    }));
    recordObjectiveNarrativeChange(objectiveId, previous, narrative);
    // The server refuses the save when someone else changed this objective since this browser read it (null: no record existed yet)
    saveObjectives([{ objectiveId, controlId, narrative, checkStale: true }]);
  }, [objectiveWriteBlocked, writableState, objectivesOf, currentUser, recordObjectiveNarrativeChange, saveObjectives]);

  const applyObjectivePrefilledNarrative = useCallback((objectiveId: string) => {
    if (objectiveWriteBlocked('narratives')) return;
    const s = writableState();
    if (!s) return;

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    const baseObjectives = objectivesOf(s, controlId);
    const target = baseObjectives.find(o => o.id === objectiveId);
    if (!target) return;

    const now = new Date().toISOString();
    const confirmedNarrative = target.prefilledTemplate;
    const updatedObjective: AssessmentObjective = {
      ...target,
      implementationNarrative: confirmedNarrative,
      status: 'MET',
      lastUpdated: now,
      updatedBy: currentUser.name,
    };

    const allObjs = baseObjectives.map(o => o.id === objectiveId ? updatedObjective : o);
    const total = allObjs.length;
    let metOrNaCount = 0;
    let hasNotMet = false;
    for (const obj of allObjs) {
      if (obj.status === 'NOT_MET') hasNotMet = true;
      if (obj.status === 'MET' || obj.status === 'NOT_APPLICABLE') metOrNaCount++;
    }

    const rolledStatus: ControlStatus = hasNotMet
      ? 'NOT_MET'
      : metOrNaCount === total && total > 0
      ? 'MET'
      : 'IN_PROGRESS';

    const currentCtrl = s.controls[controlId] || {
      id: controlId,
      tenantId: currentTenant.id,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: now,
      tags: [],
    };

    let combinedNotes = currentCtrl.implementationNotes || '';
    const sectionHeader = `[Objective ${target.letter.toUpperCase()} - ${target.text}]:\n${confirmedNarrative}`;
    if (!combinedNotes.includes(confirmedNarrative)) {
      combinedNotes = combinedNotes ? `${combinedNotes}\n\n${sectionHeader}` : sectionHeader;
    }

    setState(prev => ({
      ...prev,
      objectives: {
        ...(prev.objectives || {}),
        [objectiveId]: updatedObjective,
      },
      controls: {
        ...prev.controls,
        [controlId]: {
          ...(prev.controls[controlId] || currentCtrl),
          status: rolledStatus,
          implementationNotes: combinedNotes,
          lastUpdated: now,
          updatedBy: currentUser.name,
        },
      },
    }));
    recordObjectiveNarrativeChange(objectiveId, target.implementationNarrative || '', confirmedNarrative);

    // Save through the audited server writers; only the control fields that change
    const controlUpdate: Partial<ControlState> = { updatedBy: currentUser.name };
    if (combinedNotes !== (currentCtrl.implementationNotes || '')) controlUpdate.implementationNotes = combinedNotes;
    if (rolledStatus !== currentCtrl.status) controlUpdate.status = rolledStatus;
    const controlChanged = controlUpdate.implementationNotes !== undefined || controlUpdate.status !== undefined;
    saveObjectives(
      [{ objectiveId, controlId, status: 'MET', narrative: confirmedNarrative }],
      controlChanged ? { id: controlId, update: controlUpdate } : undefined
    );
  }, [objectiveWriteBlocked, writableState, objectivesOf, currentUser, currentTenant.id, recordObjectiveNarrativeChange, saveObjectives]);

  const applyAllObjectiveTemplatesForControl = useCallback((controlId: string) => {
    if (objectiveWriteBlocked('narratives')) return;
    const s = writableState();
    if (!s) return;

    const now = new Date().toISOString();
    const baseObjectives = objectivesOf(s, controlId);
    const nextObjectives = { ...(s.objectives || {}) };
    const narrativeSections: string[] = [];
    const inputs: ObjectiveInput[] = [];

    baseObjectives.forEach(obj => {
      const narrative = obj.prefilledTemplate;
      nextObjectives[obj.id] = {
        ...obj,
        status: 'MET',
        implementationNarrative: narrative,
        lastUpdated: now,
        updatedBy: currentUser.name,
      };
      narrativeSections.push(`[Objective ${obj.letter.toUpperCase()} - ${obj.text}]:\n${narrative}`);
      inputs.push({ objectiveId: obj.id, controlId, status: 'MET', narrative });
      recordObjectiveNarrativeChange(obj.id, obj.implementationNarrative || '', narrative);
    });

    const currentCtrl = s.controls[controlId] || {
      id: controlId,
      tenantId: currentTenant.id,
      status: 'NOT_STARTED',
      implementationNotes: '',
      responsibleRole: 'IT / Security Lead',
      lastUpdated: now,
      tags: [],
    };

    const newNotes = narrativeSections.join('\n\n');
    setState(prev => ({
      ...prev,
      objectives: { ...(prev.objectives || {}), ...nextObjectives },
      controls: {
        ...prev.controls,
        [controlId]: {
          ...(prev.controls[controlId] || currentCtrl),
          status: 'MET' as ControlStatus,
          implementationNotes: newNotes,
          lastUpdated: now,
          updatedBy: currentUser.name,
        },
      },
    }));

    const metAfter = Object.entries(s.controls).filter(([id, c]) => id !== controlId && c.status === 'MET').length + 1;
    const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
    if (metAfter === totalRequired) {
      setTimeout(triggerSprsCelebration, 150);
    }

    // Save through the audited server writers: one bulk write for the objectives, and the control only for the fields that change
    const controlUpdate: Partial<ControlState> = { updatedBy: currentUser.name };
    if (newNotes !== (currentCtrl.implementationNotes || '')) controlUpdate.implementationNotes = newNotes;
    if (currentCtrl.status !== 'MET') controlUpdate.status = 'MET';
    const controlChanged = controlUpdate.implementationNotes !== undefined || controlUpdate.status !== undefined;
    saveObjectives(inputs, controlChanged ? { id: controlId, update: controlUpdate } : undefined);
  }, [objectiveWriteBlocked, writableState, objectivesOf, frameworkControls, currentUser, currentTenant.id, activeFramework, triggerSprsCelebration, recordObjectiveNarrativeChange, saveObjectives]);

  const linkEvidenceToObjective = useCallback((objectiveId: string, evidenceId: string) => {
    if (objectiveWriteBlocked('objectives')) return;
    const s = writableState();
    if (!s) return;

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    const target = objectivesOf(s, controlId).find(o => o.id === objectiveId) || {
      id: objectiveId,
      controlId,
      letter: match ? match[2] : 'a',
      text: 'Objective determination',
      status: 'NOT_STARTED' as ObjectiveStatus,
      prefilledTemplate: '',
      implementationNarrative: '',
      linkedEvidenceIds: [],
      isAutoVerifiedByTelemetry: false,
    };

    const currentLinked = target.linkedEvidenceIds || [];
    const updatedLinked = currentLinked.includes(evidenceId)
      ? currentLinked.filter(id => id !== evidenceId)
      : [...currentLinked, evidenceId];

    setState(prev => ({
      ...prev,
      objectives: {
        ...(prev.objectives || {}),
        [objectiveId]: {
          ...target,
          linkedEvidenceIds: updatedLinked,
          lastUpdated: new Date().toISOString(),
          updatedBy: currentUser.name,
        },
      },
    }));
    saveObjectives([{ objectiveId, controlId, linkedEvidenceIds: updatedLinked }]);
  }, [objectiveWriteBlocked, writableState, objectivesOf, currentUser, saveObjectives]);

  // Action: Update SSP Metadata with RBAC Check
  const updateSSPMetadata = useCallback((metadata: Partial<SSPMetadata>) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to update SSP metadata.');
      return;
    }

    setState(prev => ({
      ...prev,
      sspMetadata: {
        ...prev.sspMetadata,
        ...metadata,
        lastUpdated: new Date().toISOString(),
      },
    }));
  }, [canEdit]);

  // Action: Upload Evidence with Vault Path & SHA-256 Hashing
  const uploadEvidence = useCallback(async (
    controlId: string,
    file: File,
    description?: string
  ): Promise<EvidenceItem> => {
    if (!canEdit) {
      throw new Error('Read-Only access: Evidence uploads are restricted for your role.');
    }

    // The program the upload belongs to is fixed here: a switch while it runs does not move it
    const uploadScope = programScope;
    const fileHash = await computeSha256(file);

    // Upload via the server (signed URL) and record it in evidence_metadata
    try {
      const uploadResp = await createLiveEvidenceUploadUrl({
        controlId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        fileHash,
        description: description || `Audit evidence for control ${controlId}`,
      }, programId ?? null);

      if (uploadResp) {
        // Upload binary to the local evidence vault via the server-relative URL
        await ApiClient.uploadEvidenceFile(uploadResp.uploadUrl, file, file.type, currentTenant.id, programId ?? null);

        // Cross-Framework Evidence Inheritance:
        // Associate upload with mapped controls in local state
        const mappedControlIds = getEquivalentControlIds(controlId);
        const inheritedItems: EvidenceItem[] = mappedControlIds.map(mappedId => ({
          id: `${uploadResp.evidence.id}__inh_${mappedId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          tenantId: currentTenant.id,
          controlId: mappedId,
          name: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          uploadedAt: new Date().toISOString(),
          description: `[Inherited from ${controlId}] ${description || `Audit evidence for ${controlId}`}`,
          hasBlob: true,
          gcsPath: uploadResp.gcsPath,
          fileHash,
          syncStatus: 'local_storage',
          uploadedBy: currentUser.name,
        }));

        // Only into the program the upload was made for (the user may have switched while it ran; the server has the file either way)
        setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== uploadScope ? prev : {
          ...prev,
          evidenceIndex: [uploadResp.evidence, ...inheritedItems, ...prev.evidenceIndex],
        }));

        return uploadResp.evidence;
      }
    } catch {
      // Browser-only tenants fall back to the local vault below
    }
    // A server-backed tenant's file lives only on the server: it is never kept in this browser instead
    if (currentTenant.serverBacked) throw new Error('The evidence file was not saved to the server.');

    // Browser-only tenants: keep the file in the local vault
    const evidenceId = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const gcsPath = generateEvidenceObjectPath(currentTenant.id, controlId, evidenceId, file.name);

    // Store in tenant-partitioned IndexedDB vault
    await EvidenceVault.saveFile(currentTenant.id, evidenceId, file, gcsPath, fileHash);

    const newItem: EvidenceItem = {
      id: evidenceId,
      tenantId: currentTenant.id,
      controlId,
      name: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      description: description || `Audit evidence for control ${controlId}`,
      hasBlob: true,
      gcsPath,
      fileHash,
      syncStatus: 'local_storage',
      uploadedBy: currentUser.name,
    };

    // Cross-Framework Evidence Inheritance in local state
    const mappedControlIds = getEquivalentControlIds(controlId);
    const inheritedItems: EvidenceItem[] = mappedControlIds.map(mappedId => ({
      id: `${newItem.id}__inh_${mappedId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      tenantId: currentTenant.id,
      controlId: mappedId,
      name: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      description: `[Inherited from ${controlId}] ${description || `Audit evidence for ${controlId}`}`,
      hasBlob: true,
      gcsPath,
      fileHash,
      syncStatus: 'local_storage',
      uploadedBy: currentUser.name,
    }));

    setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== uploadScope ? prev : {
      ...prev,
      evidenceIndex: [newItem, ...inheritedItems, ...prev.evidenceIndex],
    }));

    const fileNameDescriptor = await describeNotesForLedger(file.name);
    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'EVIDENCE_UPLOADED',
      targetEntity: newItem.id,
      newState: { controlId, sha256: fileHash, sizeBytes: file.size, fileName: fileNameDescriptor },
    }).catch(() => {});

    return newItem;
  }, [canEdit, currentTenant.id, currentTenant.serverBacked, programId, programScope, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, createLiveEvidenceUploadUrl]);

  // Action: Remove Evidence
  const removeEvidence = useCallback(async (evidenceId: string): Promise<boolean> => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to delete evidence.');
      return false;
    }

    // The server is the home of a server-backed tenant's evidence: it must delete first, and a refusal leaves everything in place
    const deleteScope = programScope;
    let removedIds: string[] = [evidenceId];
    if (currentTenant.serverBacked) {
      try {
        removedIds = (await deleteLiveEvidence(evidenceId, programId ?? null)).removedIds;
      } catch (err) {
        alert(`The evidence could not be deleted on the server: ${errorMessage(err) || 'unknown error'}`);
        return false;
      }
    }

    await EvidenceVault.deleteFile(currentTenant.id, evidenceId).catch(() => undefined);

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'EVIDENCE_DELETED',
      targetEntity: evidenceId,
    }).catch(() => {});

    const gone = new Set(removedIds);
    setState(prev => (programScopeKey(prev.tenantId, prev.programId) !== deleteScope ? prev : {
      ...prev,
      evidenceIndex: prev.evidenceIndex.filter(e => !gone.has(e.id)),
    }));
    return true;
  }, [canEdit, currentTenant.id, currentTenant.serverBacked, programId, programScope, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, deleteLiveEvidence]);

  // Action: Reset Assessment
  const resetAssessment = useCallback(async () => {
    if (!canEdit) {
      alert('Read-Only access: Cannot reset assessment.');
      return;
    }
    // A server-backed tenant's other programs keep their evidence: delete only the files this program's index lists. (A browser-only
    // tenant has a single boundary: its whole vault goes.)
    if (currentTenant.serverBacked) {
      for (const item of stateRef.current.evidenceIndex) await EvidenceVault.deleteFile(currentTenant.id, item.id);
    } else {
      await EvidenceVault.clearTenant(currentTenant.id);
    }

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'ASSESSMENT_RESET',
      targetEntity: `Tenant Enclave (${currentTenant.name})`,
    }).catch(() => {});

    const blank = createInitialState(currentTenant, activeProgram?.framework);
    setState({ ...blank, programId });
  }, [canEdit, currentTenant, activeProgram?.framework, programId, auditMetadata, currentUser.id, currentUser.email, currentUser.roles]);

  // Action: Import Assessment JSON
  const importAssessmentJSON = useCallback(async (file: File): Promise<boolean> => {
    if (!canEdit) {
      alert('Read-Only access: Cannot import data.');
      return false;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return false;
    }

    try {
      const text = await file.text();
      const imported = JSON.parse(text) as AssessmentState;

      if (!imported.controls || !imported.sspMetadata) {
        throw new Error('Invalid assessment JSON structure');
      }

      // Ensure all framework controls are present in imported state
      const targetControls = frameworkControls.length > 0 ? frameworkControls : getFrameworkControls(activeFramework);
      for (const ctrl of targetControls) {
        if (!imported.controls[ctrl.id]) {
          imported.controls[ctrl.id] = {
            id: ctrl.id,
            tenantId: currentTenant.id,
            status: 'NOT_STARTED',
            implementationNotes: '',
            responsibleRole: 'IT / Security Lead',
            lastUpdated: new Date().toISOString(),
            tags: [],
          };
        }
      }

      imported.tenantId = currentTenant.id;
      imported.programId = programId;
      imported.lastSaved = new Date().toISOString();
      // The upload marker and the review list describe this browser's cache, never a backup file's
      imported.objectivesMigratedAt = stateRef.current.objectivesMigratedAt;
      imported.objectivesPendingReview = stateRef.current.objectivesPendingReview;
      if (!imported.objectivesMigratedAt) delete imported.objectivesMigratedAt;
      if (!imported.objectivesPendingReview) delete imported.objectivesPendingReview;

      // A server-backed tenant's notes, status and roles live on the server: send each control that differs from the
      // current state through the audited writer (one PUT per control, sequential, only the changed fields)
      const serverUpdates: Array<[string, Partial<ControlState>]> = [];
      if (currentTenant.serverBacked) {
        for (const [id, next] of Object.entries(imported.controls)) {
          const cur = stateRef.current.controls[id];
          const curNotes = cur?.implementationNotes || '';
          const curStatus = cur?.status || 'NOT_STARTED';
          const curRole = cur?.responsibleRole || 'IT / Security Lead';
          const update: Partial<ControlState> = {};
          if ((next.implementationNotes || '') !== curNotes) update.implementationNotes = next.implementationNotes || '';
          if (next.status && next.status !== curStatus) update.status = next.status;
          if (next.responsibleRole && next.responsibleRole !== curRole) update.responsibleRole = next.responsibleRole;
          if (Object.keys(update).length > 0) serverUpdates.push([id, { ...update, updatedBy: currentUser.name }]);
        }
      }
      setState(imported);
      // Objectives of a server-backed tenant go to the server in chunks of 500 (each chunk all-or-nothing)
      if (currentTenant.serverBacked) {
        const objectiveUploads = objectivesToUpload(imported.objectives, isKnownControl).items;
        if (objectiveUploads.length > 0) {
          updateLiveObjectivesBulk(objectiveUploads).catch((err: unknown) => {
            alert(`The objectives of the imported file could not all be saved to the server: ${errorMessage(err) || 'unknown error'}`);
          });
        }
      }
      if (serverUpdates.length > 0) {
        const IMPORT_PUT_CAP = 1000;
        if (serverUpdates.length > IMPORT_PUT_CAP) {
          console.warn(`Import changes ${serverUpdates.length} controls; only the first ${IMPORT_PUT_CAP} are saved to the server.`);
        }
        const importScope = programScope;
        void (async () => {
          const attempts = serverUpdates.slice(0, IMPORT_PUT_CAP);
          let saved = 0;
          let failed = 0;
          for (const [id, update] of attempts) {
            const outcome = await saveControl(id, update);
            if (outcome === 'saved') saved++;
            else failed++;
            // The server cannot be reached: the rest would fail the same way
            if (outcome === 'unreachable') break;
          }
          // Counts only, never text
          if (failed > 0 && programScopeRef.current === importScope) {
            setControlSaveError({ message: `The import saved ${saved} of ${attempts.length} controls to the server. The others were not saved.`, count: failed });
          }
        })();
      }
      return true;
    } catch {
      alert('Failed to import JSON file. Please ensure it is a valid PBC-GRC backup.');
      return false;
    }
  }, [canEdit, notesEditable, currentTenant.id, currentTenant.serverBacked, programId, currentUser.name, frameworkControls, activeFramework, programScope, saveControl, updateLiveObjectivesBulk, isKnownControl]);

  // Action: Export JSON
  const exportAssessmentJSON = useCallback(() => {
    StorageService.exportJSON(state);
  }, [state]);

  // Action: Export Markdown
  const exportAssessmentMarkdown = useCallback(() => {
    StorageService.exportMarkdown(state, frameworkControls, activeFramework);
  }, [state, frameworkControls, activeFramework]);

  const value = useMemo(() => ({
    state,
    notesStatus,
    notesEditable,
    controlSaveError,
    dismissControlSaveError,
    metrics,
    frameworkControls,
    activeTab,
    setActiveTab,
    selectedControlId,
    setSelectedControlId,
    selectedDomainFilter,
    setSelectedDomainFilter,
    selectedStatusFilter,
    setSelectedStatusFilter,
    searchQuery,
    setSearchQuery,
    previewEvidence,
    setPreviewEvidence,

    fleetAssets,
    boundaryAggregation,
    refreshBoundaryTelemetry,

    updateControlStatus,
    updateControlNotes,
    flushControlNotes,
    updateControlRole,
    applyStarterTemplate,
    bulkApplyStigNarratives,
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,

    isExportModalOpen,
    setIsExportModalOpen,
    exportModalInitialDocType,
    openExportModal,

    // NIST SP 800-171A Objective-Level Evaluation & Rollup
    getObjectivesForControl,
    updateObjectiveStatus,
    updateObjectiveNarrative,
    applyObjectivePrefilledNarrative,
    applyAllObjectiveTemplatesForControl,
    linkEvidenceToObjective,
    recalculateControlStatusFromObjectives,
    objectivesNeedOwner,
    objectivePendingReview,
    serverObjectiveNarrative,
    resolveObjectiveConflict,
  }), [
    state,
    notesStatus,
    notesEditable,
    controlSaveError,
    dismissControlSaveError,
    metrics,
    frameworkControls,
    activeTab,
    selectedControlId,
    selectedDomainFilter,
    selectedStatusFilter,
    searchQuery,
    previewEvidence,
    fleetAssets,
    boundaryAggregation,
    refreshBoundaryTelemetry,
    updateControlStatus,
    updateControlNotes,
    flushControlNotes,
    updateControlRole,
    applyStarterTemplate,
    bulkApplyStigNarratives,
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,
    isExportModalOpen,
    exportModalInitialDocType,
    openExportModal,
    getObjectivesForControl,
    updateObjectiveStatus,
    updateObjectiveNarrative,
    applyObjectivePrefilledNarrative,
    applyAllObjectiveTemplatesForControl,
    linkEvidenceToObjective,
    recalculateControlStatusFromObjectives,
    objectivesNeedOwner,
    objectivePendingReview,
    serverObjectiveNarrative,
    resolveObjectiveConflict,
  ]);

  return (
    <AssessmentContext.Provider value={value}>
      {children}
    </AssessmentContext.Provider>
  );
};

export const useAssessment = (): AssessmentContextType => {
  const context = useContext(AssessmentContext);
  if (!context) {
    throw new Error('useAssessment must be used within an AssessmentProvider');
  }
  return context;
};
