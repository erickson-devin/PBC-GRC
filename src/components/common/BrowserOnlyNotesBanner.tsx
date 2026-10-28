import React, { useState } from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { OBJECTIVES_NEED_OWNER_MESSAGE } from '../../data/objectiveSync';
import { ObjectiveReviewDialog } from '../matrix/ObjectiveReviewDialog';
import { ErrorNotice } from './ErrorNotice';
import { errorMessage } from '../../utils/errors';

/**
 * Persistent (not dismissable) notice for a tenant that exists only in this browser: its implementation notes and objective
 * narratives have no other copy. The button is the same "Move to server" action as LegacyTenantNotice (migrateLocalTenantToServer, with the
 * same two-step inline confirmation) and is shown only to users who can edit a configured tenant.
 *
 * For a server-backed tenant it shows the other notice instead: a viewer or assessor whose browser still holds objective narratives
 * the server does not have (an owner moves them by opening the organization), and mounts the dialog where owners settle conflicts.
 */
export const BrowserOnlyNotesBanner: React.FC = () => {
  const { currentTenant, canEdit, migrateLocalTenantToServer } = useTenant();
  const { objectivesNeedOwner } = useAssessment();
  const [stage, setStage] = useState<'idle' | 'confirm' | 'moving'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (currentTenant.serverBacked) {
    return (
      <>
        {objectivesNeedOwner && (
          <div
            role="region"
            aria-label="Objective narratives are waiting in this browser"
            className="max-w-7xl mx-auto mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
          >
            <p className="flex min-w-0 items-center gap-2 text-amber-200">
              <CloudUpload className="h-4 w-4 shrink-0 text-amber-300" />
              <span>{OBJECTIVES_NEED_OWNER_MESSAGE}</span>
            </p>
          </div>
        )}
        <ObjectiveReviewDialog />
      </>
    );
  }

  const canMove = canEdit && currentTenant.isConfigured !== false;

  const move = async () => {
    setStage('moving');
    setError(null);
    try {
      await migrateLocalTenantToServer(currentTenant.id);
      setStage('idle');
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not move the tenant to the server.');
      setStage('confirm');
    }
  };

  return (
    <div
      role="region"
      aria-label="Implementation notes and objective narratives are stored only in this browser"
      className="max-w-7xl mx-auto mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex min-w-0 items-center gap-2 text-amber-200">
          <CloudUpload className="h-4 w-4 shrink-0 text-amber-300" />
          <span>This tenant&apos;s implementation notes and objective narratives exist only in this browser. Move it to the server to keep them safe and shared.</span>
        </p>
        {canMove && (
          <div className="flex shrink-0 items-center gap-2">
            {stage === 'idle' && (
              <button type="button" onClick={() => setStage('confirm')} className="btn-primary px-3 py-1.5 text-xs">
                <CloudUpload className="h-3.5 w-3.5" />
                <span>Move to server</span>
              </button>
            )}
            {stage === 'confirm' && (
              <>
                <button type="button" onClick={() => { setStage('idle'); setError(null); }} className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white">
                  Cancel
                </button>
                <button type="button" onClick={move} className="btn-primary px-3 py-1.5 text-xs">
                  <span>Confirm move</span>
                </button>
              </>
            )}
            {stage === 'moving' && (
              <span className="inline-flex items-center gap-2 text-amber-200" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                Moving…
              </span>
            )}
          </div>
        )}
      </div>
      <ErrorNotice message={error} className="mt-2" />
    </div>
  );
};

export default BrowserOnlyNotesBanner;
