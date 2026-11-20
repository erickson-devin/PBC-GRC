import React, { useId } from 'react';
import type { SSPMetadata } from '../../types/cmmc';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import { SSP_BUILDER_TEXT, fieldFlags, missingItemsLine } from '../../data/ssp/sspBuilderView';

interface SspEnvironmentSectionProps {
  meta: SSPMetadata;
  canEdit: boolean;
  sspMetadataEditable: boolean;
  updateSSPMetadata: (m: Partial<SSPMetadata>) => void;
  section?: SspSectionStatus;
  /** The program's boundary summary: used only to decide whether to say it stands in for a blank boundary text, never shown here. */
  boundaryFallback: string;
}

const LABEL = 'block text-xs font-semibold text-slate-300 mb-1.5';

/** 2.1 and 2.2: the boundary, the operating environment and the cloud service providers (and the SOC 2 service commitments). */
export const SspEnvironmentSection: React.FC<SspEnvironmentSectionProps> = ({
  meta,
  canEdit,
  sspMetadataEditable,
  updateSSPMetadata,
  section,
  boundaryFallback,
}) => {
  const baseId = useId();
  const missingLine = missingItemsLine(section);
  const boundaryRequired = fieldFlags(section, 'systemBoundaryScope').required;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">Where the system runs, what its boundary includes, and the cloud services it uses.</p>
      {missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Boundary Scope */}
        <div className="md:col-span-2">
          <label htmlFor={`${baseId}-boundary`} className={LABEL}>
            System Boundary & Scope Description{boundaryRequired && <span className="text-rose-300" aria-hidden="true"> *</span>}
          </label>
          <textarea
            id={`${baseId}-boundary`}
            rows={4}
            aria-required={boundaryRequired || undefined}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.systemBoundaryScope}
            onChange={(e) => updateSSPMetadata({ systemBoundaryScope: e.target.value })}
            className="w-full p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
            placeholder="Describe the operational boundary, physical facilities, cloud tenants, and components..."
          />
          {!meta.systemBoundaryScope.trim() && boundaryFallback.trim() && (
            <p className="mt-1 text-[11px] text-slate-400">{SSP_BUILDER_TEXT.boundaryFallback}</p>
          )}
        </div>

        {/* Operating Environment */}
        <div>
          <label htmlFor={`${baseId}-environment`} className={LABEL}>
            System Operating Environment
          </label>
          <input
            id={`${baseId}-environment`}
            type="text"
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.systemEnvironment}
            onChange={(e) => updateSSPMetadata({ systemEnvironment: e.target.value })}
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
            placeholder="e.g. Hybrid Cloud: Microsoft 365 + On-Premises HQ"
          />
        </div>

        {/* Cloud Service Providers */}
        <div>
          <label htmlFor={`${baseId}-csps`} className={LABEL}>
            Authorized Cloud Service Providers (CSPs)
          </label>
          <input
            id={`${baseId}-csps`}
            type="text"
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.cloudServiceProviders}
            onChange={(e) => updateSSPMetadata({ cloudServiceProviders: e.target.value })}
            className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
            placeholder="e.g. Microsoft 365 GCC High (leave empty if none)"
          />
        </div>

        {/* Service Commitments (SOC 2) */}
        <div className="md:col-span-2">
          <label htmlFor="ssp-service-commitments" className={LABEL}>
            Principal service commitments and system requirements (SOC 2)
          </label>
          <textarea
            id="ssp-service-commitments"
            rows={4}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.serviceCommitments ?? ''}
            onChange={(e) => updateSSPMetadata({ serviceCommitments: e.target.value })}
            className="w-full p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
            placeholder="Commitments made to customers (SLAs, security and privacy commitments) and the system requirements that support them. Used by the SOC 2 system description."
          />
        </div>
      </div>
    </div>
  );
};
