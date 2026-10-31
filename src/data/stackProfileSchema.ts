// Validation of the enclave stack profile stored on tenants.stack_profile (#84).
// Pure: shared by the server route and the browser sync. Errors never echo a value.
import type { EnclaveStackProfile } from '../types/tenant';

export const STACK_PROFILE_ENUMS = {
  identityProvider: ['ENTRA_ID_GOV', 'ENTRA_ID_COMMERCIAL', 'OKTA', 'ACTIVE_DIRECTORY'],
  edrSolution: ['CROWDSTRIKE_FALCON', 'DEFENDER_FOR_ENDPOINT', 'SENTINELONE', 'GENERIC_AV'],
  infrastructure: ['AZURE_GOV', 'AWS_GOVCLOUD', 'ON_PREM_RHEL', 'HYBRID_CLOUD'],
  mdmSolution: ['INTUNE', 'JAMF', 'WORKSPACE_ONE', 'MANUAL_GPO'],
  siemSolution: ['SENTINEL', 'SPLUNK_GOV', 'ELASTIC', 'LOCAL_AUDITD'],
} as const;

export const STACK_PROFILE_ENUM_KEYS = Object.keys(STACK_PROFILE_ENUMS) as Array<keyof typeof STACK_PROFILE_ENUMS>;

export const STACK_PROFILE_MAX_BYTES = 16384;
export const STACK_PROFILE_MAX_PARAMS = 50;
export const STACK_PROFILE_MAX_PARAM_CHARS = 1000;

const ODP_KEY = /^[A-Z0-9_]{1,64}$/;

export type StackProfileValidation =
  | { ok: true; value: EnclaveStackProfile }
  | { ok: false; error: string };

export function validateStackProfile(raw: unknown): StackProfileValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'stackProfile must be an object' };
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set<string>([...STACK_PROFILE_ENUM_KEYS, 'odpParams']);
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
  if (new TextEncoder().encode(JSON.stringify(value)).length > STACK_PROFILE_MAX_BYTES) {
    return { ok: false, error: 'stackProfile is too large' };
  }
  return { ok: true, value: value as unknown as EnclaveStackProfile };
}
