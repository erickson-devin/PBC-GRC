import React, { useState } from 'react';
import { CloudUpload, CheckCircle2, Loader2 } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from './ErrorNotice';
import { errorMessage } from '../../utils/errors';
import type { Tenant } from '../../types/tenant';

interface LegacyTenantNoticeProps {
  tenant: Tenant;
  /** `banner` is a full-width call-out; `inline` is a compact block for settings screens. */
  variant?: 'banner' | 'inline';
  /** Called with the new server-assigned tenant id after a successful move. */
  onMoved?: (newTenantId: string) => void;
}

/**
 * Shown for a live tenant that exists only in this browser (created before tenants lived on the server).
 * "Move to server" creates it on the server, ports its assessment and evidence files to the new id, and unlocks team
 * invitations and access from other devices. Two-step inline confirmation; no blocking dialogs.
 */
export const LegacyTenantNotice: React.FC<LegacyTenantNoticeProps> = ({ tenant, variant = 'banner', onMoved }) => {
  const { isSandboxMode, migrateLocalTenantToServer } = useTenant();
  const [stage, setStage] = useState<'idle' | 'confirm' | 'moving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ tenantId: string; evidenceFilesMoved: number; controlsFailed: number } | null>(null);

  const isLegacy = !isSandboxMode && !tenant.serverBacked && tenant.isConfigured !== false;

  if (stage === 'done' && moved) {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-200">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <span>
          <strong className="text-emerald-300">Moved to the server.</strong> Your assessment
          {moved.evidenceFilesMoved > 0 ? ` and ${moved.evidenceFilesMoved} evidence file${moved.evidenceFilesMoved === 1 ? '' : 's'}` : ''} now live
          under the server-assigned tenant. You can invite your team from Team settings.
          {moved.controlsFailed > 0 ? ` Warning: ${moved.controlsFailed} control answer${moved.controlsFailed === 1 ? ' could' : 's could'} not be saved to the server; review them before relying on this assessment.` : ''}
        </span>
      </div>
    );
  }
  if (!isLegacy) return null;

  const move = async () => {
    setStage('moving');
    setError(null);
    try {
      const result = await migrateLocalTenantToServer(tenant.id);
      setMoved(result);
      setStage('done');
      onMoved?.(result.tenantId);
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not move the tenant to the server.');
      setStage('confirm');
    }
  };

  const compact = variant === 'inline';

  return (
    <div
      role="region"
      aria-label="Tenant is stored only in this browser"
      className={`rounded-2xl border border-amber-500/40 bg-amber-500/10 ${compact ? 'p-3.5' : 'p-4 sm:p-5'} text-xs`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <CloudUpload className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div className="min-w-0 space-y-1">
            <p className="font-bold text-amber-200">This enclave is stored only in this browser</p>
            <p className="leading-relaxed text-slate-300">
              It was created before tenants lived on the server, so it can&apos;t be shared, invited into, or opened from another
              device, and the server can&apos;t enforce access to it. Moving it creates the tenant on the server and copies your
              assessment and evidence files to it. Team members and invitations created in this browser aren&apos;t carried
              over: invite them again afterwards.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {stage === 'idle' && (
            <button type="button" onClick={() => setStage('confirm')} className="btn-primary px-4 py-2 text-xs">
              <CloudUpload className="h-3.5 w-3.5" />
              <span>Move to server</span>
            </button>
          )}
          {stage === 'confirm' && (
            <>
              <button type="button" onClick={() => { setStage('idle'); setError(null); }} className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white">
                Cancel
              </button>
              <button type="button" onClick={move} className="btn-primary px-4 py-2 text-xs">
                <span>Confirm move</span>
              </button>
            </>
          )}
          {stage === 'moving' && (
            <span className="inline-flex items-center gap-2 text-amber-200" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Moving…
            </span>
          )}
        </div>
      </div>

      <ErrorNotice message={error} className="mt-3" />
    </div>
  );
};

export default LegacyTenantNotice;
