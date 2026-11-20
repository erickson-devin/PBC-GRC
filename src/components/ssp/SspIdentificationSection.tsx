import React, { useId, useRef } from 'react';
import { Info } from 'lucide-react';
import type { SSPMetadata } from '../../types/cmmc';
import type { ProgramBaseline } from '../../types/program';
import type { SspProfile } from '../../types/sspProfile';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import {
  SSP_BUILDER_TEXT,
  applySuggestion,
  categorizationSuggestionView,
  fieldFlags,
  missingItemsLine,
  overallLine,
  parseImpact,
  setProfileField,
} from '../../data/ssp/sspBuilderView';

interface SspIdentificationSectionProps {
  meta: SSPMetadata;
  canEdit: boolean;
  sspMetadataEditable: boolean;
  updateSSPMetadata: (m: Partial<SSPMetadata>) => void;
  profile: SspProfile | null;
  profileEditable: boolean;
  onProfileChange: (p: SspProfile) => void;
  section?: SspSectionStatus;
  framework: string;
  baseline: ProgramBaseline | null;
}

const INPUT = 'w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70';
const LABEL = 'block text-xs font-semibold text-slate-300 mb-1.5';

const Star: React.FC = () => <span className="text-rose-300" aria-hidden="true"> *</span>;

/** 1.1: the names, the system identifier and the FIPS 199 categorization. A suggested categorization is only ever saved by its Apply button. */
export const SspIdentificationSection: React.FC<SspIdentificationSectionProps> = ({
  meta,
  canEdit,
  sspMetadataEditable,
  updateSSPMetadata,
  profile,
  profileEditable,
  onProfileChange,
  section,
  framework,
  baseline,
}) => {
  const baseId = useId();
  const confidentialityRef = useRef<HTMLSelectElement>(null);
  const missingLine = missingItemsLine(section);
  const suggestion = categorizationSuggestionView({ framework, baseline, profile });
  const flag = (id: string) => fieldFlags(section, id);
  const req = (id: string) => (flag(id).required ? true : undefined);
  const impactSelects = [
    { key: 'confidentialityImpact', label: 'Confidentiality impact', ref: confidentialityRef },
    { key: 'integrityImpact', label: 'Integrity impact', ref: undefined },
    { key: 'availabilityImpact', label: 'Availability impact', ref: undefined },
  ] as const;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">
        Names the system and its security categorization (FIPS 199: the impact of a loss of confidentiality, integrity or availability).
      </p>
      {missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* System Name */}
        <div>
          <label htmlFor={`${baseId}-systemName`} className={LABEL}>
            Information System Name{flag('systemName').required && <Star />}
          </label>
          <input
            id={`${baseId}-systemName`}
            type="text"
            aria-required={req('systemName')}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.systemName}
            onChange={(e) => updateSSPMetadata({ systemName: e.target.value })}
            className={INPUT}
            placeholder="e.g. Defense Contracting Information Network (DCIN)"
          />
        </div>

        {/* Organization Name */}
        <div>
          <label htmlFor={`${baseId}-organizationName`} className={LABEL}>
            Organization / Contractor Name{flag('organizationName').required && <Star />}
          </label>
          <input
            id={`${baseId}-organizationName`}
            type="text"
            aria-required={req('organizationName')}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.organizationName}
            onChange={(e) => updateSSPMetadata({ organizationName: e.target.value })}
            className={INPUT}
            placeholder="e.g. Vanguard Defense Systems LLC"
          />
        </div>

        {/* System Unique Identifier */}
        <div>
          <label htmlFor={`${baseId}-systemIdentifier`} className={LABEL}>
            System Unique Identifier{flag('systemIdentifier').required && <Star />}
          </label>
          <input
            id={`${baseId}-systemIdentifier`}
            type="text"
            maxLength={128}
            aria-required={req('systemIdentifier')}
            disabled={!canEdit || !profileEditable}
            value={profile?.systemIdentifier ?? ''}
            onChange={(e) => onProfileChange(setProfileField(profile, 'systemIdentifier', e.target.value))}
            className={`${INPUT} font-mono`}
            placeholder="e.g. DCIN-001 (the identifier your organization or agency assigns)"
          />
          <p className="mt-1 text-[11px] text-slate-500">Printed in the SSP and in the eMASS export.</p>
        </div>

        {/* CAGE Code */}
        <div>
          <label htmlFor={`${baseId}-cageCode`} className={LABEL}>
            Commercial and Government Entity (CAGE) Code
          </label>
          <input
            id={`${baseId}-cageCode`}
            type="text"
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.cageCode}
            onChange={(e) => updateSSPMetadata({ cageCode: e.target.value.toUpperCase() })}
            className={`${INPUT} font-mono`}
            placeholder="e.g. 8K3R1"
            maxLength={5}
          />
        </div>

        {/* SAM Status */}
        <div>
          <label htmlFor={`${baseId}-samStatus`} className={LABEL}>
            SAM.gov Registration Status
          </label>
          <select
            id={`${baseId}-samStatus`}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.samStatus}
            onChange={(e) => updateSSPMetadata({ samStatus: e.target.value })}
            className={INPUT}
          >
            <option value="ACTIVE">ACTIVE - Compliant for Federal Award</option>
            <option value="EXPIRED">EXPIRED - Renewal Required</option>
            <option value="IN_PROGRESS">IN_PROGRESS - Registration Underway</option>
            <option value="NOT_REGISTERED">NOT_REGISTERED</option>
          </select>
        </div>

        {/* Lead Assessor / Author */}
        <div>
          <label htmlFor={`${baseId}-authorName`} className={LABEL}>
            Lead Assessment Author{flag('authorName').required && <Star />}
          </label>
          <input
            id={`${baseId}-authorName`}
            type="text"
            aria-required={req('authorName')}
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.authorName}
            onChange={(e) => updateSSPMetadata({ authorName: e.target.value })}
            className={INPUT}
            placeholder="e.g. Lead CMMC Assessor / Security Engineer"
          />
        </div>

        {/* Assessment Date */}
        <div>
          <label htmlFor={`${baseId}-assessmentDate`} className={LABEL}>
            Baseline Assessment Date
          </label>
          <input
            id={`${baseId}-assessmentDate`}
            type="date"
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.assessmentDate}
            onChange={(e) => updateSSPMetadata({ assessmentDate: e.target.value })}
            className={INPUT}
          />
        </div>

        {/* Document Version */}
        <div>
          <label htmlFor={`${baseId}-version`} className={LABEL}>
            SSP Version
          </label>
          <input
            id={`${baseId}-version`}
            type="text"
            disabled={!canEdit || !sspMetadataEditable}
            value={meta.version}
            onChange={(e) => updateSSPMetadata({ version: e.target.value })}
            className={INPUT}
            placeholder="e.g. 1.0.0"
          />
        </div>

        <fieldset className="md:col-span-2 rounded-xl border border-slate-800 p-4 space-y-3">
          <legend className="px-1 text-xs font-semibold text-slate-300">Security categorization</legend>
          {suggestion && (
            <div className="rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 p-3 text-xs text-cyan-100 flex flex-col sm:flex-row sm:items-center gap-3">
              <Info className="w-4 h-4 shrink-0 text-cyan-300" aria-hidden="true" />
              <div className="flex-1 min-w-0 space-y-1">
                <p>
                  <span className="mr-2 px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-[10px] font-bold uppercase tracking-wide text-cyan-200">Suggestion</span>
                  {suggestion.text}
                </p>
                <p className="text-[11px] text-cyan-200/80">{SSP_BUILDER_TEXT.suggestionNotSaved}</p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  disabled={!profileEditable}
                  onClick={() => {
                    onProfileChange(applySuggestion(profile, suggestion));
                    confidentialityRef.current?.focus();
                  }}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-100 border border-cyan-500/40 text-xs font-semibold whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Apply suggestion
                </button>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {impactSelects.map((s) => (
              <div key={s.key}>
                <label htmlFor={`${baseId}-${s.key}`} className={LABEL}>
                  {s.label}{flag(s.key).required && <Star />}
                </label>
                <select
                  id={`${baseId}-${s.key}`}
                  ref={s.ref}
                  aria-required={req(s.key)}
                  disabled={!canEdit || !profileEditable}
                  value={profile?.[s.key] ?? ''}
                  onChange={(e) => onProfileChange(setProfileField(profile, s.key, parseImpact(e.target.value)))}
                  className={INPUT}
                >
                  <option value="">Not set</option>
                  <option value="LOW">Low</option>
                  <option value="MODERATE">Moderate</option>
                  <option value="HIGH">High</option>
                </select>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-300">{overallLine(profile)}</p>
        </fieldset>
      </div>
    </div>
  );
};
