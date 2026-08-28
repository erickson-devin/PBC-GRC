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

  // Actions
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
  const [state, setState] = useState<AssessmentState>(() => StorageService.loadAssessment());
  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [selectedDomainFilter, setSelectedDomainFilter] = useState<DomainCode | 'ALL'>('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<ControlStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [previewEvidence, setPreviewEvidence] = useState<EvidenceItem | null>(null);

  // Auto-save state changes to LocalStorage
  useEffect(() => {
    StorageService.saveAssessment(state);
  }, [state]);

  // Calculate Real-time Compliance Metrics
  const metrics: ComplianceMetrics = useMemo(() => {
    const totalControls = CMMC_LEVEL_1_CONTROLS.length; // 17
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

    // Calculate domain percentages
    (Object.keys(domainStats) as DomainCode[]).forEach(d => {
      const stat = domainStats[d];
      stat.percentage = stat.total > 0 ? Math.round((stat.met / stat.total) * 100) : 0;
    });

    const completionPercentage = Math.round((metCount / totalControls) * 100);
    // CMMC Level 1 SPRS Readiness strictly requires 100% (17 of 17) MET, 0 POA&Ms allowed
    const isSprsReady = metCount === totalControls;

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

  // Confetti effect when reaching 100% SPRS Ready
  const triggerSprsCelebration = useCallback(() => {
    confetti({
      particleCount: 120,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#10b981', '#0e8ee9', '#38aaf7', '#fbbf24'],
    });
  }, []);

  const updateControlStatus = useCallback((controlId: string, status: ControlStatus) => {
    setState(prev => {
      const current = prev.controls[controlId] || {
        id: controlId,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT Lead',
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
          },
        },
      };

      // Check if this action makes SPRS ready
      let allMet = true;
      for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
        const s = ctrl.id === controlId ? status : (prev.controls[ctrl.id]?.status || 'NOT_STARTED');
        if (s !== 'MET') {
          allMet = false;
          break;
        }
      }
      if (allMet && status === 'MET') {
        setTimeout(triggerSprsCelebration, 150);
      }

      return updated;
    });
  }, [triggerSprsCelebration]);

  const updateControlNotes = useCallback((controlId: string, notes: string) => {
    setState(prev => {
      const current = prev.controls[controlId] || {
        id: controlId,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT Lead',
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
          },
        },
      };
    });
  }, []);

  const updateControlRole = useCallback((controlId: string, role: string) => {
    setState(prev => {
      const current = prev.controls[controlId] || {
        id: controlId,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT Lead',
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
          },
        },
      };
    });
  }, []);

  const applyStarterTemplate = useCallback((controlId: string, narrative: string) => {
    setState(prev => {
      const current = prev.controls[controlId] || {
        id: controlId,
        status: 'NOT_STARTED',
        implementationNotes: '',
        responsibleRole: 'IT Lead',
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
          },
        },
      };
    });
  }, []);

  const updateSSPMetadata = useCallback((metadata: Partial<SSPMetadata>) => {
    setState(prev => ({
      ...prev,
      sspMetadata: {
        ...prev.sspMetadata,
        ...metadata,
      },
    }));
  }, []);

  const uploadEvidence = useCallback(async (controlId: string, file: File, description?: string): Promise<EvidenceItem> => {
    const evidenceId = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    // Save to IndexedDB
    await EvidenceVault.saveFile(evidenceId, file);

    const newItem: EvidenceItem = {
      id: evidenceId,
      controlId,
      name: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      description: description || `Audit evidence for ${controlId}`,
      hasBlob: true,
    };

    setState(prev => ({
      ...prev,
      evidenceIndex: [newItem, ...prev.evidenceIndex],
    }));

    return newItem;
  }, []);

  const removeEvidence = useCallback(async (evidenceId: string): Promise<void> => {
    await EvidenceVault.deleteFile(evidenceId);
    setState(prev => ({
      ...prev,
      evidenceIndex: prev.evidenceIndex.filter(e => e.id !== evidenceId),
    }));
  }, []);

  const loadDemoScenario = useCallback(() => {
    const demo = createDemoState();
    setState(demo);
    setTimeout(triggerSprsCelebration, 200);
  }, [triggerSprsCelebration]);

  const resetAssessment = useCallback(async () => {
    await EvidenceVault.clearAll();
    StorageService.clearAll();
    setState(createInitialState());
  }, []);

  const importAssessmentJSON = useCallback(async (file: File): Promise<boolean> => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as AssessmentState;
      if (!parsed.controls || !parsed.sspMetadata) {
        alert('Invalid Assessment JSON file structure.');
        return false;
      }
      setState(parsed);
      return true;
    } catch (err) {
      console.error('Failed to import JSON assessment:', err);
      alert('Error parsing JSON file. Please ensure it is a valid PBC-GRC backup file.');
      return false;
    }
  }, []);

  const exportAssessmentJSON = useCallback(() => {
    StorageService.exportJSON(state);
  }, [state]);

  const exportAssessmentMarkdown = useCallback(() => {
    StorageService.exportMarkdown(state);
  }, [state]);

  return (
    <AssessmentContext.Provider
      value={{
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
      }}
    >
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
