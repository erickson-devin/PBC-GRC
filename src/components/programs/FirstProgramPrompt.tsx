import React, { useRef, useState } from 'react';
import { ProgramFormModal } from './ProgramFormModal';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { shouldPromptFirstProgram } from '../../data/programDefaultChoice';
import type { Program } from '../../types/program';

/**
 * "Create Your First Program": opens by itself for a tenant owner or MSP administrator when the organization has no program yet
 * (never while onboarding is open). The name and the boundary description start from the onboarding answers; the framework is
 * not preselected. "Not Now" closes it for this visit only (memory, not storage): it comes back on reload while there is no program.
 */
export const FirstProgramPrompt: React.FC = () => {
  const { currentTenant, programs, programsStatus, canManagePrograms, isOnboardingModalOpen, needsOnboarding } = useTenant();
  const { setActiveTab } = useAssessment();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const created = useRef(false);

  const open = shouldPromptFirstProgram({
    programsStatus,
    programs,
    canManagePrograms,
    onboardingOpen: isOnboardingModalOpen || needsOnboarding,
    dismissed: dismissedFor === currentTenant.id,
  });

  // The dialog is gone by now: put the keyboard focus on the page content, not on the page body
  const focusMain = () => {
    setTimeout(() => document.getElementById('app-main')?.focus(), 0);
  };

  const handleSaved = (program: Program) => {
    created.current = true;
    setAnnouncement(`${program.name} was created and is the organization default.`);
    focusMain();
  };

  const handleClose = () => {
    setDismissedFor(currentTenant.id);
    // Dismissed without a program: the programs page explains what to do next
    if (!created.current) setActiveTab('programs');
    focusMain();
  };

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {open && (
        <ProgramFormModal
          mode="create"
          variant="first"
          initial={{ name: currentTenant.systemName, boundarySummary: currentTenant.systemBoundaryScope }}
          onSaved={handleSaved}
          onClose={handleClose}
        />
      )}
    </>
  );
};

export default FirstProgramPrompt;
