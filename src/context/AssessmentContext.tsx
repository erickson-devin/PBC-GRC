import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  AssessmentState,
  ControlStatus,
  DomainCode,
  EvidenceItem,
  SSPMetadata,
  ComplianceMetrics,
} from '../types/cmmc';
import { CMMC_LEVEL_1_CONTROLS } from '../data/cmmcLevel1Controls';
import { StorageService, createInitialState, createDemoState } from '../services/storageService';
import { EvidenceVault } from '../services/evidenceVault';
import { GcsService } from '../services/gcsService';
import { useTenant } from './TenantContext';

export type NavigationTab = 'dashboard' | 'controls' | 'ssp' | 'vault' | 'guidance';

interface AssessmentContextType {
  state: AssessmentState;
  metrics: ComplianceMetrics;
  activeTab: NavigationTab;
  setActiveTab: (tab: NavigationTab) => void;
  selectedControlId: string | null;
  setSelectedControlId: (id: string | null) => void;
  selectedDomainFilter: DomainCode | 'ALL';
  setSelectedDomainFilter: (domain: DomainCode | 'ALL') => void;
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
  updateSSPMetadata: (metadata: Partial<SSPMetadata>) => void;
  uploadEvidence: (controlId: string, file: File, description?: string) => Promise<EvidenceItem>;
  removeEvidence: (evidenceId: string) => Promise<void>;
  loadDemoScenario: () => void;
  resetAssessment: () => Promise<void>;
  importAssessmentJSON: (file: File) => Promise<boolean>;
  exportAssessmentJSON: () => void;
  exportAssessmentMarkdown: () => void;
}

const AssessmentContext = createContext<AssessmentContextType | undefined>(undefined);

export const AssessmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentTenant, canEdit, currentUser } = useTenant();

  // Load tenant-isolated assessment state
  const [state, setState] = useState<AssessmentState>(() => StorageService.loadAssessment(currentTenant));
  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [selectedDomainFilter, setSelectedDomainFilter] = useState<DomainCode | 'ALL'>('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<ControlStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [previewEvidence, setPreviewEvidence] = useState<EvidenceItem | null>(null);

  // When active tenant changes, dynamically reload that tenant's partitioned assessment
  useEffect(() => {
    const tenantState = StorageService.loadAssessment(currentTenant);
    setState(tenantState);
  }, [currentTenant.id]);

  // Auto-save state changes under tenant partition
  useEffect(() => {
    if (state.tenantId === currentTenant.id) {
      StorageService.saveAssessment(currentTenant.id, state);
    }
  }, [state, currentTenant.id]);

  // Calculate Real-time Compliance Metrics dynamically for all 17 controls
  const metrics: ComplianceMetrics = useMemo(() => {
    const totalControls = CMMC_LEVEL_1_CONTROLS.length; // Exactly 17 controls
    let metCount = 0;
    let inProgressCount = 0;
    let notStartedCount = 0;
    let notMetCount = 0;

    const domainStats: Record<DomainCode, {
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

    for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
      const cState = state.controls[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      const dCode = ctrl.domain;

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
    (Object.keys(domainStats) as DomainCode[]).forEach(d => {
      const stat = domainStats[d];
      stat.percentage = stat.total > 0 ? Math.round((stat.met / stat.total) * 100) : 0;
    });

    const completionPercentage = totalControls > 0 ? Math.round((metCount / totalControls) * 100) : 0;
    // CMMC Level 1 SPRS Readiness strictly requires 100% (17 of 17) MET
    const isSprsReady = metCount === totalControls && totalControls === 17;

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
  }, [state]);

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

    const evidenceId = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const gcsPath = GcsService.generateGcsPath(currentTenant.id, controlId, evidenceId, file.name);
    const fileHash = await GcsService.computeSha256(file);

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

    setState(prev => ({
      ...prev,
      evidenceIndex: [newItem, ...prev.evidenceIndex],
    }));

    return newItem;
  }, [canEdit, currentTenant.id, currentUser.name]);

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
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    loadDemoScenario,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,
  }), [
    state,
    metrics,
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
    updateSSPMetadata,
    uploadEvidence,
    removeEvidence,
    loadDemoScenario,
    resetAssessment,
    importAssessmentJSON,
    exportAssessmentJSON,
    exportAssessmentMarkdown,
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
