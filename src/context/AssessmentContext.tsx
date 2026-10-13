import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  AssessmentState,
  ControlStatus,
  EvidenceItem,
  SSPMetadata,
  ComplianceMetrics,
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
import { GcsService } from '../services/gcsService';
import { computeDomainStats } from '../data/frameworks/domainStats';
import { ApiClient } from '../services/apiClient';
import { useTenant } from './TenantContext';
import { recordAuditEvent } from '../data/audit/auditLogger';
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
  | 'poam'        // Plan of Action & Milestones
  | 'export'      // Export Audit Package
  | 'rbac'        // Team & Role RBAC
  | 'audit_logs'  // Immutable Audit Trail (renamed from 'audit')
  | 'audit'       // Legacy alias → renders same as 'audit_logs'
  | 'guidance'    // Framework Guidance & Authority
  | 'settings'    // Enclave Settings
  | 'stigs';      // Legacy — now external link, kept for backwards compat

interface AssessmentContextType {
  state: AssessmentState;
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
    liveEvidence,
    updateLiveControl,
    createLiveEvidenceUploadUrl,
    activeFramework,
    activeBaselineTier,
    activeOverlayFilters,
    ciaTriad,
  } = useTenant();

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
  const [state, setState] = useState<AssessmentState>(() => StorageService.loadAssessment(currentTenant));
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

  // Initial boundary evaluation on mount / tenant switch
  useEffect(() => {
    refreshBoundaryTelemetry();
  }, [currentTenant.id, refreshBoundaryTelemetry]);

  const openExportModal = useCallback((initialDocType?: ReportDocumentType) => {
    setExportModalInitialDocType(initialDocType);
    setIsExportModalOpen(true);
  }, []);

  // When active tenant changes, dynamically reload that tenant's partitioned assessment
  useEffect(() => {
    const tenantState = StorageService.loadAssessment(currentTenant);
    setState(tenantState);
  }, [currentTenant.id]);

  // Synchronize live backend data into assessment state when received from Cloud SQL
  useEffect(() => {
    if (liveControls) {
      setState(prev => ({
        ...prev,
        tenantId: currentTenant.id,
        controls: {
          ...prev.controls,
          ...liveControls,
        },
        evidenceIndex: liveEvidence ? liveEvidence : prev.evidenceIndex,
      }));
    }
  }, [liveControls, liveEvidence, currentTenant.id]);

  // Auto-save state changes under tenant partition
  useEffect(() => {
    if (state.tenantId === currentTenant.id) {
      StorageService.saveAssessment(currentTenant.id, state);
    }
  }, [state, currentTenant.id]);

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
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, triggerSprsCelebration, activeFramework, frameworkControls]);

  // Action: Update Control Notes with RBAC Check
  const updateControlNotes = useCallback((controlId: string, notes: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
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
      recordAuditEvent({
        tenantId: currentTenant.id,
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'CONTROL_NOTES_UPDATED',
        targetEntity: controlId,
        previousState: current.implementationNotes ? `${current.implementationNotes.substring(0, 60)}...` : '',
        newState: notes ? `${notes.substring(0, 60)}...` : '',
      }).catch(() => {});

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
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, updateLiveControl]);

  // Action: Update Control Role with RBAC Check
  const updateControlRole = useCallback((controlId: string, role: string) => {
    if (!canEdit) return;

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
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles, currentUser.name]);

  // Action: Apply Starter Template
  const applyStarterTemplate = useCallback((controlId: string, narrative: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to apply templates.');
      return;
    }

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
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        actorRole: currentUser.roles[currentTenant.id] || 'Operator',
        actionType: 'TEMPLATE_APPLIED',
        targetEntity: controlId,
        newState: { status: 'IN_PROGRESS', templateLength: narrative.length },
      }).catch(() => {});

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
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles, currentUser.name]);

  // Action: Bulk Apply STIG Policy Narratives across mapped controls
  const bulkApplyStigNarratives = useCallback((narratives: Record<string, string>): number => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
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

        updateLiveControl(id, { implementationNotes: newNotes, updatedBy: currentUser.name });

        appliedCount++;
      });

      return {
        ...prev,
        controls: nextControls,
      };
    });

    return appliedCount;
  }, [canEdit, currentTenant.id, currentUser.name, updateLiveControl]);

  // -------------------------------------------------------------------------
  // NIST SP 800-171A Objective-Level Evaluation & Rollup Engine
  // -------------------------------------------------------------------------

  const getObjectivesForControl = useCallback((controlId: string): AssessmentObjective[] => {
    const ctrl = frameworkControls.find(c => c.id === controlId) || findControlDefinition(controlId);
    return getAssessmentObjectivesForControl(
      controlId,
      ctrl?.title,
      ctrl?.assessmentObjectives,
      state.objectives
    );
  }, [frameworkControls, state.objectives]);

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
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'CONTROL_STATUS_UPDATED',
      targetEntity: objectiveId,
      previousState: 'STATUS_UPDATE',
      newState: status,
    }).catch(() => {});
  }, [canEdit, frameworkControls, currentUser, currentTenant.id, activeFramework, triggerSprsCelebration]);

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
  }, [canEdit, frameworkControls, currentUser, currentTenant.id]);

  const applyAllObjectiveTemplatesForControl = useCallback((controlId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }

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

      return {
        ...prev,
        objectives: nextObjectives,
        controls: updatedControls,
      };
    });
  }, [canEdit, frameworkControls, currentUser, currentTenant.id, activeFramework, triggerSprsCelebration]);

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

  // Action: Upload Evidence with GCS Path & SHA-256 Hashing
  const uploadEvidence = useCallback(async (
    controlId: string,
    file: File,
    description?: string
  ): Promise<EvidenceItem> => {
    if (!canEdit) {
      throw new Error('Read-Only access: Evidence uploads are restricted for your role.');
    }

    const fileHash = await GcsService.computeSha256(file);

    // Upload via the server (signed URL) and record it in evidence_metadata
    try {
      const uploadResp = await createLiveEvidenceUploadUrl({
        controlId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        fileHash,
        description: description || `Audit evidence for control ${controlId}`,
      });

      if (uploadResp) {
        // Upload binary to Local Enclave Storage or GCS via Signed URL
        await ApiClient.uploadFileToGcs(uploadResp.uploadUrl, file, file.type, currentTenant.id);
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
          syncStatus: 'gcs_synced',
          uploadedBy: currentUser.name,
        }));

        setState(prev => ({
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
    const gcsPath = GcsService.generateGcsPath(currentTenant.id, controlId, evidenceId, file.name);

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
      syncStatus: 'gcs_synced',
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
      syncStatus: 'gcs_synced',
      uploadedBy: currentUser.name,
    }));

    setState(prev => ({
      ...prev,
      evidenceIndex: [newItem, ...inheritedItems, ...prev.evidenceIndex],
    }));

    recordAuditEvent({
      tenantId: currentTenant.id,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'EVIDENCE_UPLOADED',
      targetEntity: file.name,
      newState: { controlId, sha256: fileHash, sizeBytes: file.size },
    }).catch(() => {});

    return newItem;
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles, currentUser.name, createLiveEvidenceUploadUrl]);

  // Action: Remove Evidence
  const removeEvidence = useCallback(async (evidenceId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to delete evidence.');
      return;
    }

    await EvidenceVault.deleteFile(currentTenant.id, evidenceId);

    recordAuditEvent({
      tenantId: currentTenant.id,
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
  }, [canEdit, currentTenant.id, currentUser.id, currentUser.email, currentUser.roles]);

  // Action: Reset Assessment
  const resetAssessment = useCallback(async () => {
    if (!canEdit) {
      alert('Read-Only access: Cannot reset assessment.');
      return;
    }
    await EvidenceVault.clearTenant(currentTenant.id);

    recordAuditEvent({
      tenantId: currentTenant.id,
      actorId: currentUser.id,
      actorEmail: currentUser.email,
      actorRole: currentUser.roles[currentTenant.id] || 'Operator',
      actionType: 'ASSESSMENT_RESET',
      targetEntity: `Tenant Enclave (${currentTenant.name})`,
    }).catch(() => {});

    const blank = createInitialState(currentTenant);
    setState(blank);
  }, [canEdit, currentTenant, currentUser.id, currentUser.email, currentUser.roles]);

  // Action: Import Assessment JSON
  const importAssessmentJSON = useCallback(async (file: File): Promise<boolean> => {
    if (!canEdit) {
      alert('Read-Only access: Cannot import data.');
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
      imported.lastSaved = new Date().toISOString();
      setState(imported);
      return true;
    } catch {
      alert('Failed to import JSON file. Please ensure it is a valid PBC-GRC backup.');
      return false;
    }
  }, [canEdit, currentTenant.id, frameworkControls, activeFramework]);

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
