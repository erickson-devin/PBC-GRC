// Shared (browser + server) shape and limits of the per-program SSP profile (#238, #241, #242, #246): the structured SSP fields
// (system identifier, security categorization, responsible roles, maintenance and ownership) and the section sign-offs.
// Pure: no imports. Errors name a path and never echo a value (it can be CUI).

export const IMPACT_LEVELS = ['LOW', 'MODERATE', 'HIGH'] as const;
export type ImpactLevel = typeof IMPACT_LEVELS[number];

export const SSP_ROLE_KEYS = [
  'information_owner',
  'system_owner',
  'isso_ciso',
  'ir_reporting_primary',
  'ir_reporting_alternate',
  'ir_lead',
  'ssp_accountable',
  'independent_tester',
  'custom',
] as const;
export type SspRoleKey = typeof SSP_ROLE_KEYS[number];

export interface SspRoleEntry {
  /** UI row key only: ^[A-Za-z0-9_-]{1,64}$. */
  id: string;
  roleKey: SspRoleKey;
  /** At most 128 characters; required when (and only when) roleKey is 'custom'. */
  customTitle?: string;
  /** A team member's user id (same pattern as the members API); absent for a free-text holder. */
  memberUserId?: string | null;
  /** At most 128 characters. */
  name: string;
  /** '' or an email address of at most 120 characters. */
  email: string;
  /** Incident-reporting roles only: a DIBNet medium-assurance certificate is on file (a boolean, never certificate data). */
  certificateOnFile?: boolean | null;
}

export interface SspMaintenance {
  hardwareMaintainedByOrg: boolean | null;
  hardwareOwnedByOrg: boolean | null;
  softwareMaintainedByOrg: boolean | null;
  softwareOwnedByOrg: boolean | null;
  /** At most 20000 characters. */
  exceptions: string;
}

export interface SspProfile {
  /** At most 128 characters. */
  systemIdentifier?: string;
  confidentialityImpact?: ImpactLevel | null;
  integrityImpact?: ImpactLevel | null;
  availabilityImpact?: ImpactLevel | null;
  /** At most 40 entries. */
  roles?: SspRoleEntry[];
  maintenance?: SspMaintenance;
}

export const SSP_PROFILE_KEYS = [
  'systemIdentifier',
  'confidentialityImpact',
  'integrityImpact',
  'availabilityImpact',
  'roles',
  'maintenance',
] as const;

export const SSP_PROFILE_MAX_BYTES = 262144;
export const SSP_PROFILE_MAX_ROLES = 40;

export interface SspProfileRecord {
  profile: SspProfile | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SspSectionReview {
  id: string;
  sectionId: string;
  contentSha256: string;
  reviewerUserId: string;
  reviewerName: string;
  reviewerRole: string;
  createdAt: string;
}

export interface SspSectionReviewState {
  sectionId: string;
  currentDigest: string;
  latest: SspSectionReview | null;
  reviewed: boolean;
}

export interface SspReviewsResponse {
  sections: SspSectionReviewState[];
  /** Newest first, at most 200. */
  history: SspSectionReview[];
}

export type SspProfileValidation =
  | { ok: true; value: SspProfile }
  | { ok: false; error: string };

const ROLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const MAX_IDENTIFIER_CHARS = 128;
const MAX_TITLE_CHARS = 128;
const MAX_NAME_CHARS = 128;
const MAX_EMAIL_CHARS = 120;
const MAX_EXCEPTIONS_CHARS = 20000;

const IMPACT_FIELDS = ['confidentialityImpact', 'integrityImpact', 'availabilityImpact'] as const;
const MAINTENANCE_BOOLEANS = ['hardwareMaintainedByOrg', 'hardwareOwnedByOrg', 'softwareMaintainedByOrg', 'softwareOwnedByOrg'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function validateRole(raw: unknown, path: string): { ok: true; value: SspRoleEntry } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return fail(`${path} must be an object`);
  const allowed = new Set(['id', 'roleKey', 'customTitle', 'memberUserId', 'name', 'email', 'certificateOnFile']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return fail(`${path} has an unknown field`);
  }
  const { id, roleKey, customTitle, memberUserId, name, email, certificateOnFile } = raw;
  if (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id)) return fail(`${path}.id is not a valid id`);
  if (typeof roleKey !== 'string' || !(SSP_ROLE_KEYS as readonly string[]).includes(roleKey)) return fail(`${path}.roleKey is not a known role`);
  const entry: SspRoleEntry = { id, roleKey: roleKey as SspRoleKey, name: '', email: '' };
  if (customTitle !== undefined) {
    if (typeof customTitle !== 'string') return fail(`${path}.customTitle must be a string`);
    if (customTitle.length > MAX_TITLE_CHARS) return fail(`${path}.customTitle is too long`);
  }
  if (roleKey === 'custom') {
    if (typeof customTitle !== 'string' || customTitle.trim() === '') return fail(`${path}.customTitle is required for a custom role`);
    entry.customTitle = customTitle;
  } else if (typeof customTitle === 'string' && customTitle !== '') {
    return fail(`${path}.customTitle is only for a custom role`);
  }
  if (memberUserId !== undefined && memberUserId !== null) {
    if (typeof memberUserId !== 'string' || !USER_ID_PATTERN.test(memberUserId)) return fail(`${path}.memberUserId is not a valid user id`);
    entry.memberUserId = memberUserId;
  } else if (memberUserId === null) {
    entry.memberUserId = null;
  }
  if (typeof name !== 'string') return fail(`${path}.name must be a string`);
  if (name.length > MAX_NAME_CHARS) return fail(`${path}.name is too long`);
  entry.name = name;
  if (typeof email !== 'string') return fail(`${path}.email must be a string`);
  if (email.length > MAX_EMAIL_CHARS) return fail(`${path}.email is too long`);
  if (email !== '' && !EMAIL_PATTERN.test(email)) return fail(`${path}.email is not an email address`);
  entry.email = email;
  if (certificateOnFile !== undefined && certificateOnFile !== null) {
    if (typeof certificateOnFile !== 'boolean') return fail(`${path}.certificateOnFile must be true or false`);
    if (roleKey !== 'ir_reporting_primary' && roleKey !== 'ir_reporting_alternate') return fail(`${path}.certificateOnFile is only for an incident-reporting role`);
    entry.certificateOnFile = certificateOnFile;
  } else if (certificateOnFile === null) {
    entry.certificateOnFile = null;
  }
  return { ok: true, value: entry };
}

function validateMaintenance(raw: unknown): { ok: true; value: SspMaintenance } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return fail('maintenance must be an object');
  const allowed = new Set<string>([...MAINTENANCE_BOOLEANS, 'exceptions']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return fail('maintenance has an unknown field');
  }
  const value: SspMaintenance = {
    hardwareMaintainedByOrg: null,
    hardwareOwnedByOrg: null,
    softwareMaintainedByOrg: null,
    softwareOwnedByOrg: null,
    exceptions: '',
  };
  for (const key of MAINTENANCE_BOOLEANS) {
    const entry = raw[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'boolean') return fail(`maintenance.${key} must be true, false or null`);
    value[key] = entry;
  }
  const exceptions = raw.exceptions;
  if (exceptions !== undefined) {
    if (typeof exceptions !== 'string') return fail('maintenance.exceptions must be a string');
    if (exceptions.length > MAX_EXCEPTIONS_CHARS) return fail('maintenance.exceptions is too long');
    value.exceptions = exceptions;
  }
  return { ok: true, value };
}

export function validateSspProfile(raw: unknown): SspProfileValidation {
  if (!isPlainObject(raw)) return fail('profile must be an object');
  const allowed = new Set<string>(SSP_PROFILE_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return fail('Unknown profile field');
  }
  const value: SspProfile = {};
  if (raw.systemIdentifier !== undefined) {
    if (typeof raw.systemIdentifier !== 'string') return fail('systemIdentifier must be a string');
    if (raw.systemIdentifier.length > MAX_IDENTIFIER_CHARS) return fail('systemIdentifier is too long');
    value.systemIdentifier = raw.systemIdentifier;
  }
  for (const key of IMPACT_FIELDS) {
    const entry = raw[key];
    if (entry === undefined) continue;
    if (entry !== null && (typeof entry !== 'string' || !(IMPACT_LEVELS as readonly string[]).includes(entry))) {
      return fail(`${key} must be LOW, MODERATE or HIGH`);
    }
    value[key] = entry as ImpactLevel | null;
  }
  if (raw.roles !== undefined) {
    if (!Array.isArray(raw.roles)) return fail('roles must be a list');
    if (raw.roles.length > SSP_PROFILE_MAX_ROLES) return fail('roles has too many entries');
    const roles: SspRoleEntry[] = [];
    for (let i = 0; i < raw.roles.length; i++) {
      const r = validateRole(raw.roles[i], `roles[${i}]`);
      if (!r.ok) return r;
      roles.push(r.value);
    }
    value.roles = roles;
  }
  if (raw.maintenance !== undefined) {
    const m = validateMaintenance(raw.maintenance);
    if (!m.ok) return m;
    value.maintenance = m.value;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > SSP_PROFILE_MAX_BYTES) return fail('profile is too large');
  return { ok: true, value };
}
