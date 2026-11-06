// Draft state of the Enclave Stack Survey wizard. Pure: nothing is chosen until the user chooses it, so no step and no
// organization-defined parameter (ODP) is filled in with a default behind their back.
import type { EnclaveStackProfile } from '../types/tenant';
import { STACK_PROFILE_ENUM_KEYS, validateStackProfile } from './stackProfileSchema';

export type StackKey = (typeof STACK_PROFILE_ENUM_KEYS)[number];

export type StackDraft = Partial<Omit<EnclaveStackProfile, 'odpParams' | 'customLabels'>> & {
  odpParams: Record<string, string>;
  customLabels: Record<string, string>;
};

/** Suggested ODP values. Shown as placeholders / "Use default" buttons; never saved unless the user enters them. */
export const DEFAULT_ODP_PARAMS: Record<string, string> = {
  INACTIVITY_TIMEOUT: '15 minutes',
  LOCKOUT_LIMIT: '3 consecutive invalid logon attempts',
  LOCKOUT_DURATION: '30 minutes or until administrator unlock',
  AUDIT_RETENTION_PERIOD: '365 calendar days (1 year)',
  CRITICAL_PATCH_SLA: '14 calendar days',
  HIGH_PATCH_SLA: '30 calendar days',
  ACCESS_REVIEW_CADENCE: 'Quarterly (every 90 days)',
  BACKUP_CADENCE: 'Daily incremental with weekly full offsite replication',
  LOG_REVIEW_FREQUENCY: 'Weekly automated alert review with monthly manual audit',
};

export const CUSTOM_STACK_LABEL = 'Custom solution';

const VALUE_LABELS: Record<StackKey, Record<string, string>> = {
  identityProvider: {
    ENTRA_ID_GOV: 'Entra ID Gov',
    ENTRA_ID_COMMERCIAL: 'Entra ID Commercial',
    OKTA: 'Okta',
    ACTIVE_DIRECTORY: 'Active Directory',
  },
  edrSolution: {
    CROWDSTRIKE_FALCON: 'CrowdStrike',
    DEFENDER_FOR_ENDPOINT: 'Defender Plan 2',
    SENTINELONE: 'SentinelOne',
    GENERIC_AV: 'Commercial AV',
  },
  infrastructure: {
    AZURE_GOV: 'Azure Gov',
    AWS_GOVCLOUD: 'AWS GovCloud',
    HYBRID_CLOUD: 'Hybrid Cloud',
    ON_PREM_RHEL: 'Air-Gapped RHEL',
  },
  mdmSolution: {
    INTUNE: 'Intune',
    JAMF: 'Jamf Pro',
    WORKSPACE_ONE: 'Workspace ONE',
    MANUAL_GPO: 'Manual GPO',
  },
  siemSolution: {
    SENTINEL: 'Sentinel',
    SPLUNK_GOV: 'Splunk Gov',
    ELASTIC: 'Elastic',
    LOCAL_AUDITD: 'Syslog / Auditd',
  },
};

/** The draft a wizard session starts from: the saved profile only (nothing for a tenant without one). */
export function draftFromSaved(saved?: EnclaveStackProfile | null): StackDraft {
  return {
    identityProvider: saved?.identityProvider,
    edrSolution: saved?.edrSolution,
    infrastructure: saved?.infrastructure,
    mdmSolution: saved?.mdmSolution,
    siemSolution: saved?.siemSolution,
    odpParams: { ...(saved?.odpParams ?? {}) },
    customLabels: { ...(saved?.customLabels ?? {}) },
  };
}

/** The five steps that have a value (a CUSTOM value only counts with a label). */
export function chosenStepCount(d: StackDraft): number {
  return STACK_PROFILE_ENUM_KEYS.filter((k) => {
    const v = d[k];
    if (!v) return false;
    return v !== 'CUSTOM' || (d.customLabels[k] ?? '').trim().length > 0;
  }).length;
}

export function isDraftComplete(d: StackDraft): boolean {
  return chosenStepCount(d) === STACK_PROFILE_ENUM_KEYS.length;
}

/** The profile to save, or null when the draft is incomplete or invalid. Blank ODP values are dropped; labels are trimmed. */
export function draftToProfile(d: StackDraft): EnclaveStackProfile | null {
  if (!isDraftComplete(d)) return null;
  const odpParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.odpParams)) {
    if (v.trim().length > 0) odpParams[k] = v;
  }
  const customLabels: Record<string, string> = {};
  for (const k of STACK_PROFILE_ENUM_KEYS) {
    if (d[k] === 'CUSTOM') customLabels[k] = (d.customLabels[k] ?? '').trim();
  }
  const candidate: Record<string, unknown> = {
    identityProvider: d.identityProvider,
    edrSolution: d.edrSolution,
    infrastructure: d.infrastructure,
    mdmSolution: d.mdmSolution,
    siemSolution: d.siemSolution,
    odpParams,
  };
  if (Object.keys(customLabels).length > 0) candidate.customLabels = customLabels;
  const checked = validateStackProfile(candidate);
  return checked.ok ? checked.value : null;
}

/** What a step shows: the option's short name, the custom label for CUSTOM, null while unset. Never falls through to another option. */
export function stackValueLabel(key: StackKey, value: string | undefined, customLabels?: Partial<Record<string, string>>): string | null {
  if (!value) return null;
  if (value === 'CUSTOM') {
    const label = customLabels?.[key]?.trim();
    return label ? label : CUSTOM_STACK_LABEL;
  }
  return VALUE_LABELS[key][value] ?? null;
}

/** ODP tab summary: how many values the user entered. */
export function odpSummaryLabel(params: Record<string, string> | undefined): string {
  const n = Object.values(params ?? {}).filter((v) => v.trim().length > 0).length;
  return n === 0 ? 'none entered' : `${n} entered`;
}
