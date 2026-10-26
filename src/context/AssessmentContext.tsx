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
import { computeSha256 } from '../services/evidenceIntegrity';
import { generateEvidenceObjectPath } from '../data/audit/storageDriver';
import { computeDomainStats } from '../data/frameworks/domainStats';
import { hasNist80053Objectives } from '../data/frameworks/nist80053/objectives';
import { loadNist80053Objectives } from '../data/frameworks/nist80053/objectivesLazy';
import { ApiClient } from '../services/apiClient';
import { computeNotesStatus, NotesStatus } from '../services/browserStorageScrub';
import { programCacheSegment, programScopeKey, shouldPersistAssessment } from '../data/programSync';
import { useTenant } from './TenantContext';
import { recordAuditEvent, describeNotesForLedger } from '../data/audit/auditLogger';
import {
  AssetTelemetryRecord,
  BoundaryAggregationResult,
  FailingAssetInfo,
} from '../types/telemetry';
import {
  getEnclaveFleet,
  aggregateAssetTelemetry,
  applyBoundaryTelemetryToControls,
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
  updateControlRole: (controlId: string, role: string) => void;
  applyStarterTemplate: (controlId: string, narrative: string) => void;
  bulkApplyStigNarratives: (narratives: Record<string, string>) => number;
  updateSSPMetadata: (metadata: Partial<SSPMetadata>) => void;
  uploadEvidence: (controlId: string, file: File, description?: string) => Promise<EvidenceItem>;
  removeEvidence: (evidenceId: string) => Promise<void>;
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
    createLiveEvidenceUploadUrl,
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
    hasToken: Boolean(ApiClient.getToken()),
  });
  const notesEditable = notesStatus === 'browser' || notesStatus === 'loaded';
  const NOTES_NOT_EDITABLE_MESSAGE =
    'Implementation notes are not loaded from the server, so they cannot be edited right now. They are not kept in this browser.';

  // Dynamically resolve controls for the currently selected framework, baseline/CIA triad, and overlay filters
  const frameworkControls = useMemo(() => {
    const isNist80053 = activeFramework === 'NIST_800_53_REV5' || activeFramework === 'nist-800-53-r5';
    const baseline = isNist80053 ? ciaTriad : activeBaselineTier;
    return getFrameworkControls(
      activeFramework,
      baseline,
      activeOverlayFilters
    );
  }, [activeFramework, activeBaselineTier, ciaTriad, activeOverlayFilters]);

  // Load tenant-isolated assessment state
  // (the program's cache is loaded by the effect below once the program is known; until then this is the tenant / default cache)
  const [state, setState] = useState<AssessmentState>(() => StorageService.loadAssessment(currentTenant));
  // The scope this state was loaded for
  const stateScope = programScopeKey(state.tenantId, state.programId);
  // Latest state for actions that must read it without a state dependency (import diff)
  const stateRef = useRef(state);
  stateRef.current = state;
  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [selectedDomainFilter, setSelectedDomainFilter] = useState<string>('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<ControlStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [previewEvidence, setPreviewEvidence] = useState<EvidenceItem | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [exportModalInitialDocType, setExportModalInitialDocType] = useState<ReportDocumentType | undefined>(undefined);

  // Boundary Telemetry & Fleet State
  const [fleetAssets, setFleetAssets] = useState<AssetTelemetryRecord[]>(() => getEnclaveFleet(currentTenant.id));
  const [boundaryAggregation, setBoundaryAggregation] = useState<BoundaryAggregationResult | null>(null);

  const refreshBoundaryTelemetry = useCallback(async () => {
    try {
      const boundary = await aggregateAssetTelemetry(currentTenant.id);
      setBoundaryAggregation(boundary);
      setFleetAssets(getEnclaveFleet(currentTenant.id));

      setState(prev => ({
        ...prev,
        controls: applyBoundaryTelemetryToControls(prev.controls, boundary),
      }));

      return boundary;
    } catch {
      const fallback = await aggregateAssetTelemetry(currentTenant.id);
      return fallback;
    }
  }, [currentTenant.id]);

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
        return {
          ...prev,
          tenantId: currentTenant.id,
          controls: {
            ...prev.controls,
            ...liveControls,
          },
          evidenceIndex: liveEvidence ? liveEvidence : prev.evidenceIndex,
        };
      });
    }
  }, [liveControls, liveEvidence, liveScopeKey, programScope, stateScope, currentTenant.id]);

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

    // Sync to the server
    updateLiveControl(controlId, { status, updatedBy: currentUser.name });

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

      const updated = {
        ...prev,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...current,
            status,
            failingAssets: failingAssets !== undefined ? failingAssets : current.failingAssets,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };

      // Asynchronously append to immutable audit ledger
      recordAuditEvent({
        tenantId: currentTenant.id,
        metadata: auditMetadata,
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'CONTROL_STATUS_UPDATED',
        targetEntity: controlId,
        previousState: current.status,
        newState: status,
      }).catch(() => {});

      // Check if this action achieved 100% SPRS readiness
      const metAfter = Object.entries(updated.controls).filter(
        ([id, c]) => id !== controlId ? c.status === 'MET' : status === 'MET'
      ).length;

      const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
      if (metAfter === totalRequired && status === 'MET') {
        setTimeout(triggerSprsCelebration, 150);
      }

      return updated;
    });
  }, [canEdit, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, triggerSprsCelebration, activeFramework, frameworkControls]);

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

    // Sync to the server
    updateLiveControl(controlId, { implementationNotes: notes, updatedBy: currentUser.name });

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

      // Record audit event for narrative change
      // Notes may contain CUI and the ledger sits in localStorage: record a digest and length only, never text
      const previousNotes = current.implementationNotes || '';
      Promise.all([describeNotesForLedger(previousNotes), describeNotesForLedger(notes)])
        .then(([previousState, newState]) => recordAuditEvent({
          tenantId: currentTenant.id,
          metadata: auditMetadata,
          actorId: currentUser.id,
          actorEmail: currentUser.email,
          actorRole: currentUser.roles[currentTenant.id] || 'Operator',
          actionType: 'CONTROL_NOTES_UPDATED',
          targetEntity: controlId,
          previousState,
          newState,
        }))
        .catch(() => {});

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
  }, [canEdit, notesEditable, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, updateLiveControl]);

  // Action: Update Control Role with RBAC Check
  const updateControlRole = useCallback((controlId: string, role: string) => {
    if (!canEdit) return;

    // Sync to the server (the audited writer records the change)
    updateLiveControl(controlId, { responsibleRole: role, updatedBy: currentUser.name });

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

      recordAuditEvent({
        tenantId: currentTenant.id,
        metadata: auditMetadata,
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'CONTROL_ROLE_UPDATED',
        targetEntity: controlId,
        previousState: current.responsibleRole,
        newState: role,
      }).catch(() => {});

      return {
        ...prev,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...current,
            responsibleRole: role,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };
    });
  }, [canEdit, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, updateLiveControl]);

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

    // StrictMode runs updaters twice: send the change to the server once per call
    let sent = false;
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

      recordAuditEvent({
        tenantId: currentTenant.id,
        metadata: auditMetadata,
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'TEMPLATE_APPLIED',
        targetEntity: controlId,
        newState: { status: 'IN_PROGRESS', templateLength: narrative.length },
      }).catch(() => {});

      // Save through the audited server writer; only the fields that change
      if (!sent) {
        sent = true;
        const serverUpdate: Partial<ControlState> = { implementationNotes: narrative, updatedBy: currentUser.name };
        if (current.status === 'NOT_STARTED') serverUpdate.status = 'IN_PROGRESS';
        updateLiveControl(controlId, serverUpdate);
      }

      return {
        ...prev,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...current,
            implementationNotes: narrative,
            status: current.status === 'NOT_STARTED' ? 'IN_PROGRESS' : current.status,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };
    });
  }, [canEdit, notesEditable, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, updateLiveControl]);

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

    const controlIds = Object.keys(narratives);
    if (controlIds.length === 0) return 0;

    let appliedCount = 0;

    setState(prev => {
      const nextControls = { ...prev.controls };
      const timestamp = new Date().toISOString();

      controlIds.forEach(id => {
        const text = narratives[id];
        if (!text) return;

        const current = nextControls[id] || {
          id,
          tenantId: currentTenant.id,
          status: 'NOT_STARTED',
          implementationNotes: '',
          responsibleRole: 'IT / Security Lead',
          lastUpdated: timestamp,
          tags: [],
        };

        let newNotes = text;
        if (current.implementationNotes && current.implementationNotes.trim()) {
          if (!current.implementationNotes.includes(text)) {
            newNotes = `${current.implementationNotes}\n\n[STIG Baseline Implementation]:\n${text}`;
          } else {
            newNotes = current.implementationNotes;
          }
        }

        nextControls[id] = {
          ...current,
          implementationNotes: newNotes,
          status: current.status === 'NOT_STARTED' ? 'IN_PROGRESS' : current.status,
          lastUpdated: timestamp,
          updatedBy: currentUser.name,
        };

        const serverUpdate: Partial<ControlState> = { implementationNotes: newNotes, updatedBy: currentUser.name };
        if (current.status === 'NOT_STARTED') serverUpdate.status = 'IN_PROGRESS';
        updateLiveControl(id, serverUpdate);

        appliedCount++;
      });

      return {
        ...prev,
        controls: nextControls,
      };
    });

    return appliedCount;
  }, [canEdit, notesEditable, currentTenant.id, currentUser.name, updateLiveControl]);

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

  const updateObjectiveStatus = useCallback((objectiveId: string, status: ObjectiveStatus) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify objectives for this tenant.');
      return;
    }

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    setState(prev => {
      const existingObjectives = prev.objectives || {};
      const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
      const baseObjectives = getAssessmentObjectivesForControl(
        controlId,
        ctrl?.title,
        ctrl?.assessmentObjectives,
        existingObjectives
      );

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

      const updatedObjective: AssessmentObjective = {
        ...target,
        status,
        lastUpdated: new Date().toISOString(),
        updatedBy: currentUser.name,
      };

      const nextObjectives: Record<string, AssessmentObjective> = {
        ...existingObjectives,
        [objectiveId]: updatedObjective,
      };

      // Recalculate control status according to rollup spec:
      const allObjs = baseObjectives.map(o => o.id === objectiveId ? updatedObjective : o);
      const rollup = calculateControlRollup(allObjs);
      const rolledStatus: ControlStatus = rollup.calculatedStatus;

      const currentCtrl = prev.controls[controlId] || {
        id: controlId,
        tenantId: currentTenant.id,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT / Security Lead',
        lastUpdated: new Date().toISOString(),
        tags: [],
      };

      const updatedControls = {
        ...prev.controls,
        [controlId]: {
          ...currentCtrl,
          status: rolledStatus,
          lastUpdated: new Date().toISOString(),
          updatedBy: currentUser.name,
        },
      };

      if (rolledStatus === 'MET') {
        const metAfter = Object.entries(updatedControls).filter(
          ([id, c]) => id !== controlId ? c.status === 'MET' : true
        ).length;
        const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
        if (metAfter === totalRequired) {
          setTimeout(triggerSprsCelebration, 150);
        }
      }

      return {
        ...prev,
        objectives: nextObjectives,
        controls: updatedControls,
      };
    });

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'CONTROL_STATUS_UPDATED',
      targetEntity: objectiveId,
      previousState: 'STATUS_UPDATE',
      newState: status,
    }).catch(() => {});
  }, [canEdit, frameworkControls, currentUser, currentTenant.id, auditMetadata, activeFramework, triggerSprsCelebration]);

  const updateObjectiveNarrative = useCallback((objectiveId: string, narrative: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    setState(prev => {
      const existingObjectives = prev.objectives || {};
      const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
      const baseObjectives = getAssessmentObjectivesForControl(
        controlId,
        ctrl?.title,
        ctrl?.assessmentObjectives,
        existingObjectives
      );

      const target = baseObjectives.find(o => o.id === objectiveId);
      if (!target) return prev;

      const updatedObjective: AssessmentObjective = {
        ...target,
        implementationNarrative: narrative,
        lastUpdated: new Date().toISOString(),
        updatedBy: currentUser.name,
      };

      return {
        ...prev,
        objectives: {
          ...existingObjectives,
          [objectiveId]: updatedObjective,
        },
      };
    });
  }, [canEdit, frameworkControls, currentUser]);

  const applyObjectivePrefilledNarrative = useCallback((objectiveId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }

    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    // StrictMode runs updaters twice: send the change to the server once per call
    let sent = false;
    setState(prev => {
      const existingObjectives = prev.objectives || {};
      const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
      const baseObjectives = getAssessmentObjectivesForControl(
        controlId,
        ctrl?.title,
        ctrl?.assessmentObjectives,
        existingObjectives
      );

      const target = baseObjectives.find(o => o.id === objectiveId);
      if (!target) return prev;

      const confirmedNarrative = target.prefilledTemplate;
      const updatedObjective: AssessmentObjective = {
        ...target,
        implementationNarrative: confirmedNarrative,
        status: 'MET',
        lastUpdated: new Date().toISOString(),
        updatedBy: currentUser.name,
      };

      const nextObjectives: Record<string, AssessmentObjective> = {
        ...existingObjectives,
        [objectiveId]: updatedObjective,
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

      const currentCtrl = prev.controls[controlId] || {
        id: controlId,
        tenantId: currentTenant.id,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT / Security Lead',
        lastUpdated: new Date().toISOString(),
        tags: [],
      };

      let combinedNotes = currentCtrl.implementationNotes || '';
      const sectionHeader = `[Objective ${target.letter.toUpperCase()} - ${target.text}]:\n${confirmedNarrative}`;
      if (!combinedNotes.includes(confirmedNarrative)) {
        combinedNotes = combinedNotes ? `${combinedNotes}\n\n${sectionHeader}` : sectionHeader;
      }

      // Save through the audited server writer; only the fields that change
      if (!sent) {
        sent = true;
        const serverUpdate: Partial<ControlState> = { updatedBy: currentUser.name };
        if (combinedNotes !== (currentCtrl.implementationNotes || '')) serverUpdate.implementationNotes = combinedNotes;
        if (rolledStatus !== currentCtrl.status) serverUpdate.status = rolledStatus;
        if (serverUpdate.implementationNotes !== undefined || serverUpdate.status !== undefined) {
          updateLiveControl(controlId, serverUpdate);
        }
      }

      return {
        ...prev,
        objectives: nextObjectives,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...currentCtrl,
            status: rolledStatus,
            implementationNotes: combinedNotes,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };
    });
  }, [canEdit, notesEditable, frameworkControls, currentUser, currentTenant.id, updateLiveControl]);

  const applyAllObjectiveTemplatesForControl = useCallback((controlId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }
    if (!notesEditable) {
      alert(NOTES_NOT_EDITABLE_MESSAGE);
      return;
    }

    // StrictMode runs updaters twice: send the change to the server once per call
    let sent = false;
    setState(prev => {
      const existingObjectives = prev.objectives || {};
      const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
      const baseObjectives = getAssessmentObjectivesForControl(
        controlId,
        ctrl?.title,
        ctrl?.assessmentObjectives,
        existingObjectives
      );

      const nextObjectives = { ...existingObjectives };
      const narrativeSections: string[] = [];

      baseObjectives.forEach(obj => {
        const narrative = obj.prefilledTemplate;
        nextObjectives[obj.id] = {
          ...obj,
          status: 'MET',
          implementationNarrative: narrative,
          lastUpdated: new Date().toISOString(),
          updatedBy: currentUser.name,
        };
        narrativeSections.push(`[Objective ${obj.letter.toUpperCase()} - ${obj.text}]:\n${narrative}`);
      });

      const currentCtrl = prev.controls[controlId] || {
        id: controlId,
        tenantId: currentTenant.id,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT / Security Lead',
        lastUpdated: new Date().toISOString(),
        tags: [],
      };

      const updatedControls = {
        ...prev.controls,
        [controlId]: {
          ...currentCtrl,
          status: 'MET' as ControlStatus,
          implementationNotes: narrativeSections.join('\n\n'),
          lastUpdated: new Date().toISOString(),
          updatedBy: currentUser.name,
        },
      };

      const metAfter = Object.entries(updatedControls).filter(
        ([id, c]) => id !== controlId ? c.status === 'MET' : true
      ).length;
      const totalRequired = FRAMEWORK_REGISTRY[activeFramework]?.totalControls || frameworkControls.length;
      if (metAfter === totalRequired) {
        setTimeout(triggerSprsCelebration, 150);
      }

      // Save through the audited server writer; only the fields that change
      if (!sent) {
        sent = true;
        const newNotes = narrativeSections.join('\n\n');
        const serverUpdate: Partial<ControlState> = { updatedBy: currentUser.name };
        if (newNotes !== (currentCtrl.implementationNotes || '')) serverUpdate.implementationNotes = newNotes;
        if (currentCtrl.status !== 'MET') serverUpdate.status = 'MET';
        if (serverUpdate.implementationNotes !== undefined || serverUpdate.status !== undefined) {
          updateLiveControl(controlId, serverUpdate);
        }
      }

      return {
        ...prev,
        objectives: nextObjectives,
        controls: updatedControls,
      };
    });
  }, [canEdit, notesEditable, frameworkControls, currentUser, currentTenant.id, activeFramework, triggerSprsCelebration, updateLiveControl]);

  const linkEvidenceToObjective = useCallback((objectiveId: string, evidenceId: string) => {
    if (!canEdit) return;

    const match = objectiveId.match(/^(.+?)\[([a-z0-9]+)\]$/i);
    const controlId = match ? match[1] : objectiveId;

    setState(prev => {
      const existingObjectives = prev.objectives || {};
      const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
      const baseObjectives = getAssessmentObjectivesForControl(
        controlId,
        ctrl?.title,
        ctrl?.assessmentObjectives,
        existingObjectives
      );

      const target = baseObjectives.find(o => o.id === objectiveId) || {
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

      return {
        ...prev,
        objectives: {
          ...existingObjectives,
          [objectiveId]: {
            ...target,
            linkedEvidenceIds: updatedLinked,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };
    });
  }, [canEdit, frameworkControls, currentUser]);

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
        // Save in local IndexedDB vault for client-side preview
        await EvidenceVault.saveFile(currentTenant.id, uploadResp.evidenceId, file, uploadResp.gcsPath, fileHash);

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
      // Fallback to local vault
    }

    // Offline fallback: keep the file in the local vault
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

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'EVIDENCE_UPLOADED',
      targetEntity: file.name,
      newState: { controlId, sha256: fileHash, sizeBytes: file.size },
    }).catch(() => {});

    return newItem;
  }, [canEdit, currentTenant.id, programId, programScope, auditMetadata, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, createLiveEvidenceUploadUrl]);

  // Action: Remove Evidence
  const removeEvidence = useCallback(async (evidenceId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to delete evidence.');
      return;
    }

    await EvidenceVault.deleteFile(currentTenant.id, evidenceId);

    recordAuditEvent({
      tenantId: currentTenant.id,
      metadata: auditMetadata,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'EVIDENCE_DELETED',
      targetEntity: evidenceId,
    }).catch(() => {});

    setState(prev => ({
      ...prev,
      evidenceIndex: prev.evidenceIndex.filter(e => e.id !== evidenceId),
    }));
  }, [canEdit, currentTenant.id, auditMetadata, currentUser.id, currentUser.email, currentUser.roles]);

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
      if (serverUpdates.length > 0) {
        const IMPORT_PUT_CAP = 1000;
        if (serverUpdates.length > IMPORT_PUT_CAP) {
          console.warn(`Import changes ${serverUpdates.length} controls; only the first ${IMPORT_PUT_CAP} are saved to the server.`);
        }
        void (async () => {
          for (const [id, update] of serverUpdates.slice(0, IMPORT_PUT_CAP)) {
            await updateLiveControl(id, update);
          }
        })();
      }
      return true;
    } catch {
      alert('Failed to import JSON file. Please ensure it is a valid PBC-GRC backup.');
      return false;
    }
  }, [canEdit, notesEditable, currentTenant.id, currentTenant.serverBacked, programId, currentUser.name, frameworkControls, activeFramework, updateLiveControl]);

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
  }), [
    state,
    notesStatus,
    notesEditable,
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
