// Shared (browser + server) shape and limits of the per-program SSP metadata (#84).
// Pure: no imports. Errors name the field and never echo a value (it can be CUI).

export const SSP_METADATA_FIELDS = [
  'systemName',
  'organizationName',
  'cageCode',
  'samStatus',
  'systemOwner',
  'authorName',
  'assessmentDate',
  'systemBoundaryScope',
  'systemEnvironment',
  'cloudServiceProviders',
  'version',
] as const;

export type SspField = typeof SSP_METADATA_FIELDS[number];

export const SSP_METADATA_MAX_CHARS: Record<SspField, number> = {
  systemName: 255,
  organizationName: 255,
  systemOwner: 255,
  authorName: 255,
  cageCode: 32,
  samStatus: 32,
  assessmentDate: 32,
  version: 32,
  systemBoundaryScope: 20000,
  systemEnvironment: 20000,
  cloudServiceProviders: 20000,
};

export const SSP_METADATA_MAX_BYTES = 262144;

export type SspMetadataFields = Partial<Record<SspField, string>>;

export interface SspMetadataRecord {
  metadata: SspMetadataFields | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type SspMetadataValidation =
  | { ok: true; value: SspMetadataFields }
  | { ok: false; error: string };

export function validateSspMetadata(raw: unknown): SspMetadataValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'metadata must be an object' };
  }
  const allowed = new Set<string>(SSP_METADATA_FIELDS);
  const value: SspMetadataFields = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) return { ok: false, error: 'Unknown metadata field' };
    if (typeof entry !== 'string') return { ok: false, error: `${key} must be a string` };
    if (entry.length > SSP_METADATA_MAX_CHARS[key as SspField]) {
      return { ok: false, error: `${key} is too long` };
    }
    value[key as SspField] = entry;
  }
  return { ok: true, value };
}
