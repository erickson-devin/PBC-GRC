import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  AssessmentState,
  ControlStatus,
  EvidenceItem,
  SSPMetadata,
  ComplianceMetrics,
} from '../types/cmmc';
import { CMMC_LEVEL_1_CONTROLS } from '../data/cmmcLevel1Controls';
import { FrameworkControlDefinition } from '../types/framework';
import { ReportDocumentType } from '../types/report';
import { getFrameworkControls, getEquivalentControlIds } from '../data/frameworks';
import { StorageService, createInitialState, createDemoState } from '../services/storageService';
import { EvidenceVault } from '../services/evidenceVault';
import { GcsService } from '../services/gcsService';
import { ApiClient } from '../services/apiClient';
import { useTenant } from './TenantContext';

export type NavigationTab = 'dashboard' | 'controls' | 'ssp' | 'vault' | 'guidance';

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

  // Actions with RBAC enforcement
  updateControlStatus: (controlId: string, status: ControlStatus) => void;
  updateControlNotes: (controlId: string, notes: string) => void;
  updateControlRole: (controlId: string, role: string) => void;
  applyStarterTemplate: (controlId: string, narrative: string) => void;
  bulkApplyStigNarratives: (narratives: Record<string, string>) => number;
  updateSSPMetadata: (metadata: Partial<SSPMetadata>) => void;
  uploadEvidence: (controlId: string, file: File, description?: string) => Promise<EvidenceItem>;
  removeEvidence: (evidenceId: string) => Promise<void>;
  loadDemoScenario: () => void;
  resetAssessment: () => Promise<void>;
  importAssessmentJSON: (file: File) => Promise<boolean>;
  exportAssessmentJSON: () => void;
  exportAssessmentMarkdown: () => void;

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
    isSandboxMode,
    liveControls,
    liveEvidence,
    updateLiveControl,
    createLiveEvidenceUploadUrl,
    activeFramework,
    activeBaselineTier,
    activeOverlayFilters,
  } = useTenant();

  // Dynamically resolve controls for the currently selected framework, baseline, and overlay
  const frameworkControls = useMemo(() => {
    return getFrameworkControls(
      activeFramework,
      activeBaselineTier,
      activeOverlayFilters.nonNetworkedOnly ? 'NON_NETWORKED' : 'NONE'
    );
  }, [activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly]);

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
    if (liveControls && !isSandboxMode && !currentTenant.isDemo) {
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
  }, [liveControls, liveEvidence, isSandboxMode, currentTenant.isDemo, currentTenant.id]);

  // Auto-save state changes under tenant partition
  useEffect(() => {
    if (state.tenantId === currentTenant.id) {
      StorageService.saveAssessment(currentTenant.id, state);
    }
  }, [state, currentTenant.id]);

  // Calculate Real-time Compliance Metrics dynamically for active framework controls
  const metrics: ComplianceMetrics = useMemo(() => {
    const totalControls = frameworkControls.length;
    let metCount = 0;
    let inProgressCount = 0;
    let notStartedCount = 0;
    let notMetCount = 0;

    const domainStats: Record<string, {
      total: number;
      met: number;
      inProgress: number;
      notStarted: number;
      notMet: number;
      percentage: number;
    }> = {
      AC: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
      IA: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
      MP: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
      PE: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
      SC: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
      SI: { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 },
    };

    for (const ctrl of frameworkControls) {
      const cState = state.controls[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      const dCode = ctrl.domain;

      if (!domainStats[dCode]) {
        domainStats[dCode] = { total: 0, met: 0, inProgress: 0, notStarted: 0, notMet: 0, percentage: 0 };
      }

      domainStats[dCode].total += 1;

      if (status === 'MET') {
        metCount += 1;
        domainStats[dCode].met += 1;
      } else if (status === 'IN_PROGRESS') {
        inProgressCount += 1;
        domainStats[dCode].inProgress += 1;
      } else if (status === 'NOT_MET') {
        notMetCount += 1;
        domainStats[dCode].notMet += 1;
      } else {
        notStartedCount += 1;
        domainStats[dCode].notStarted += 1;
      }
    }

    // Calculate domain completion percentages
    Object.keys(domainStats).forEach(d => {
      const stat = domainStats[d];
      stat.percentage = stat.total > 0 ? Math.round((stat.met / stat.total) * 100) : 0;
    });

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
      domainStats: domainStats as any,
    };
  }, [frameworkControls, state.controls]);

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
  const updateControlStatus = useCallback((controlId: string, status: ControlStatus) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify controls for this tenant.');
      return;
    }

    // Sync to Cloud SQL for live non-demo tenants
    if (!isSandboxMode && !currentTenant.isDemo) {
      updateLiveControl(controlId, { status, updatedBy: currentUser.name });
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

      const updated = {
        ...prev,
        controls: {
          ...prev.controls,
          [controlId]: {
            ...current,
            status,
            lastUpdated: new Date().toISOString(),
            updatedBy: currentUser.name,
          },
        },
      };

      // Check if this action achieved 100% SPRS readiness
      const metAfter = Object.entries(updated.controls).filter(
        ([id, c]) => id !== controlId ? c.status === 'MET' : status === 'MET'
      ).length;

      if (metAfter === CMMC_LEVEL_1_CONTROLS.length && status === 'MET') {
        setTimeout(triggerSprsCelebration, 150);
      }

      return updated;
    });
  }, [canEdit, currentTenant.id, currentUser.name, triggerSprsCelebration]);

  // Action: Update Control Notes with RBAC Check
  const updateControlNotes = useCallback((controlId: string, notes: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }

    // Sync to Cloud SQL for live non-demo tenants
    if (!isSandboxMode && !currentTenant.isDemo) {
      updateLiveControl(controlId, { implementationNotes: notes, updatedBy: currentUser.name });
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
  }, [canEdit, currentTenant.id, currentUser.name]);

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
  }, [canEdit, currentTenant.id, currentUser.name]);

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
  }, [canEdit, currentTenant.id, currentUser.name]);

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

        if (!isSandboxMode && !currentTenant.isDemo) {
          updateLiveControl(id, { implementationNotes: newNotes, updatedBy: currentUser.name });
        }

        appliedCount++;
      });

      return {
        ...prev,
        controls: nextControls,
      };
    });

    return appliedCount;
  }, [canEdit, currentTenant.id, currentTenant.isDemo, isSandboxMode, currentUser.name, updateLiveControl]);

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

    // If live tenant, upload via GCS Signed URL and store in Cloud SQL evidence_metadata
    if (!isSandboxMode && !currentTenant.isDemo) {
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
          // Upload binary to GCS via Signed URL
          await ApiClient.uploadFileToGcs(uploadResp.uploadUrl, file, file.type);
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
      } catch (liveUploadErr) {
        console.warn('[AssessmentContext] Live upload error, falling back to local vault:', liveUploadErr);
      }
    }

    // Local sandbox / offline fallback
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

    return newItem;
  }, [canEdit, currentTenant.id, currentTenant.isDemo, currentUser.name, isSandboxMode, createLiveEvidenceUploadUrl]);

  // Action: Remove Evidence
  const removeEvidence = useCallback(async (evidenceId: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to delete evidence.');
      return;
    }

    await EvidenceVault.deleteFile(currentTenant.id, evidenceId);

    setState(prev => ({
      ...prev,
      evidenceIndex: prev.evidenceIndex.filter(e => e.id !== evidenceId),
    }));
  }, [canEdit, currentTenant.id]);

  // Action: Load 100% Demo Scenario
  const loadDemoScenario = useCallback(() => {
    if (!canEdit) {
      alert('Read-Only access: Cannot load demo scenario.');
      return;
    }
    const demo = createDemoState(currentTenant);
    setState(demo);
    setTimeout(triggerSprsCelebration, 200);
  }, [canEdit, currentTenant, triggerSprsCelebration]);

  // Action: Reset Assessment
  const resetAssessment = useCallback(async () => {
    if (!canEdit) {
      alert('Read-Only access: Cannot reset assessment.');
      return;
    }
    await EvidenceVault.clearTenant(currentTenant.id);
    const blank = createInitialState(currentTenant);
    setState(blank);
  }, [canEdit, currentTenant]);

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

      // Ensure all 17 controls are present in imported state
      for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
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
    } catch (err) {
      console.error('Failed to parse assessment JSON:', err);
      alert('Failed to import JSON file. Please ensure it is a valid PBC-GRC backup.');
      return false;
    }
  }, [canEdit, currentTenant.id]);

  // Action: Export JSON
  const exportAssessmentJSON = useCallback(() => {
    StorageService.exportJSON(state);
  }, [state]);

  // Action: Export Markdown
  const exportAssessmentMarkdown = useCallback(() => {
    StorageService.exportMarkdown(state);
  }, [state]);

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

    updateControlStatus,
    updateControlNotes,
    updateControlRole,
    applyStarterTemplate,
    bulkApplyStigNarratives,
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    loadDemoScenario,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,

    isExportModalOpen,
    setIsExportModalOpen,
    exportModalInitialDocType,
    openExportModal,
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
    updateControlStatus,
    updateControlNotes,
    updateControlRole,
    applyStarterTemplate,
    bulkApplyStigNarratives,
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    loadDemoScenario,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,
    isExportModalOpen,
    exportModalInitialDocType,
    openExportModal,
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
