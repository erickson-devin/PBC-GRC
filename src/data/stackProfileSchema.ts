// Validation of the enclave stack profile stored on tenants.stack_profile (#84).
// Pure: shared by the server route and the browser sync. Errors never echo a value.
import type { EnclaveStackProfile } from '../types/tenant';

export const STACK_PROFILE_ENUMS = {
  identityProvider: ['ENTRA_ID_GOV', 'ENTRA_ID_COMMERCIAL', 'OKTA', 'ACTIVE_DIRECTORY', 'CUSTOM'],
  edrSolution: ['CROWDSTRIKE_FALCON', 'DEFENDER_FOR_ENDPOINT', 'SENTINELONE', 'GENERIC_AV', 'CUSTOM'],
  infrastructure: ['AZURE_GOV', 'AWS_GOVCLOUD', 'ON_PREM_RHEL', 'HYBRID_CLOUD', 'CUSTOM'],
  mdmSolution: ['INTUNE', 'JAMF', 'WORKSPACE_ONE', 'MANUAL_GPO', 'CUSTOM'],
  siemSolution: ['SENTINEL', 'SPLUNK_GOV', 'ELASTIC', 'LOCAL_AUDITD', 'CUSTOM'],
} as const;

export const STACK_PROFILE_ENUM_KEYS = Object.keys(STACK_PROFILE_ENUMS) as Array<keyof typeof STACK_PROFILE_ENUMS>;

export const STACK_PROFILE_MAX_BYTES = 16384;
export const STACK_PROFILE_MAX_PARAMS = 50;
export const STACK_PROFILE_MAX_PARAM_CHARS = 1000;

export const STACK_PROFILE_MAX_LABEL_CHARS = 120;

const ODP_KEY = /^[A-Z0-9_]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type StackProfileValidation =
  | { ok: true; value: EnclaveStackProfile }
  | { ok: false; error: string };

export function validateStackProfile(raw: unknown): StackProfileValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'stackProfile must be an object' };
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set<string>([...STACK_PROFILE_ENUM_KEYS, 'odpParams', 'customLabels']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { ok: false, error: 'Unknown stackProfile field' };
  }
  const value: Record<string, unknown> = {};
  for (const key of STACK_PROFILE_ENUM_KEYS) {
    const entry = input[key];
    if (typeof entry !== 'string' || !(STACK_PROFILE_ENUMS[key] as readonly string[]).includes(entry)) {
      return { ok: false, error: `Invalid ${key}` };
    }
    value[key] = entry;
  }
  if (input.odpParams !== undefined) {
    const params = input.odpParams;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return { ok: false, error: 'odpParams must be an object' };
    }
    const entries = Object.entries(params as Record<string, unknown>);
    if (entries.length > STACK_PROFILE_MAX_PARAMS) return { ok: false, error: 'Too many odpParams' };
    const odp: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!ODP_KEY.test(k)) return { ok: false, error: 'Invalid odpParams key' };
      if (typeof v !== 'string' || v.length > STACK_PROFILE_MAX_PARAM_CHARS) {
        return { ok: false, error: 'Invalid odpParams value' };
      }
      odp[k] = v;
    }
    value.odpParams = odp;
  }
  // A label names the product behind a CUSTOM choice: required for each CUSTOM step, rejected for any other
  const rawLabels = input.customLabels;
  if (rawLabels !== undefined) {
    if (typeof rawLabels !== 'object' || rawLabels === null || Array.isArray(rawLabels)) {
      return { ok: false, error: 'customLabels must be an object' };
    }
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (!(STACK_PROFILE_ENUM_KEYS as readonly string[]).includes(k)) return { ok: false, error: 'Invalid customLabels key' };
      if (value[k] !== 'CUSTOM') return { ok: false, error: 'customLabels is only allowed for a CUSTOM choice' };
      if (typeof v !== 'string' || v.length < 1 || v.length > STACK_PROFILE_MAX_LABEL_CHARS || CONTROL_CHARS.test(v)) {
        return { ok: false, error: 'Invalid customLabels value' };
      }
      labels[k] = v;
    }
    value.customLabels = labels;
  }
  for (const key of STACK_PROFILE_ENUM_KEYS) {
    if (value[key] === 'CUSTOM' && !(value.customLabels as Record<string, string> | undefined)?.[key]) {
      return { ok: false, error: `Missing customLabels for ${key}` };
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > STACK_PROFILE_MAX_BYTES) {
    return { ok: false, error: 'stackProfile is too large' };
  }
  return { ok: true, value: value as unknown as EnclaveStackProfile };
}
