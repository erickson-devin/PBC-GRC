// The SSP builder's sections (#238, #241, #242, #246): the registry the nav, the completeness check and the server's sign-off digest share,
// the canonical text of each section's saved fields, and the small role and categorization helpers.
// Pure: types only. The digest itself (SHA-256) is computed on the server alone (browser crypto is not reliable on plain HTTP).

import type { ProgramBaseline } from '../../types/program';
import type { SspMetadataFields } from '../../types/sspMetadata';
import type { ImpactLevel, SspProfile, SspRoleEntry, SspRoleKey } from '../../types/sspProfile';

/** Part of every digest: changing it marks every section as changed since its review. */
export const SSP_DIGEST_VERSION = 'ssp-section-v1';

export type SspSectionId = 'identification' | 'roles' | 'system_details' | 'documents' | 'data_inventory' | 'environment' | 'maintenance';

export interface SspSectionDef {
  id: SspSectionId;
  number: string;
  title: string;
  signable: boolean;
}

/**
 * In display order. Numbers follow the NIST SP 800-171 SSP template; `environment` prints 2.1 and 2.2. 1.3 and 1.4 are derived from the Tools and
 * Services register and the data inventory, so they are not signable: they join the nav and the completeness check but never the sign-off digests.
 * 1.3.2 (governance documents) is derived from the document register the same way: not signable, advisory items only.
 */
export const SSP_SECTIONS: readonly SspSectionDef[] = [
  { id: 'identification', number: '1.1', title: 'System identification and categorization', signable: true },
  { id: 'roles', number: '1.2', title: 'Responsible organization and roles', signable: true },
  { id: 'system_details', number: '1.3', title: 'System details: tools, users and privileged users', signable: false },
  { id: 'documents', number: '1.3.2', title: 'Governance documents', signable: false },
  { id: 'data_inventory', number: '1.4', title: 'Information types: FCI and CUI', signable: false },
  { id: 'environment', number: '2.1', title: 'System environment, boundary and cloud services', signable: true },
  { id: 'maintenance', number: '2.3', title: 'Hardware and software maintenance and ownership', signable: true },
];

export const SSP_SIGNABLE_SECTION_IDS: readonly SspSectionId[] = SSP_SECTIONS.filter((s) => s.signable).map((s) => s.id);

export interface SspSectionContentInput {
  metadata: SspMetadataFields;
  profile: SspProfile | null;
}

export const SSP_ROLE_LABELS: Record<SspRoleKey, string> = {
  information_owner: 'Information owner',
  system_owner: 'System owner',
  isso_ciso: 'Information system security officer (ISSO) or CISO',
  ir_reporting_primary: 'Incident reporting, primary',
  ir_reporting_alternate: 'Incident reporting, alternate',
  ir_lead: 'Incident response lead',
  ssp_accountable: 'Person accountable for the SSP',
  independent_tester: 'Independent tester',
  custom: 'Custom role',
};

/** The domain of the controls that bear on maintenance (NIST SP 800-171 3.7 / SP 800-53 MA). */
export const MAINTENANCE_DOMAIN = 'MA';

/** Line breaks to \n and the ends trimmed; a missing value is ''. */
const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '');

/**
 * The roles as the SSP shows and signs them: the stored rows in stored order. A legacy `systemOwner` value (the old free-text field) stands in
 * as a synthesized first `system_owner` row, but only while no `system_owner` row exists.
 */
export function effectiveSspRoles(profile: SspProfile | null, legacySystemOwner?: string): SspRoleEntry[] {
  const rows = profile?.roles ?? [];
  const legacy = text(legacySystemOwner);
  if (legacy !== '' && !rows.some((r) => r.roleKey === 'system_owner')) {
    return [{ id: 'legacy-system-owner', roleKey: 'system_owner', name: legacy, email: '' }, ...rows];
  }
  return rows.slice();
}

/** "Name (email)", or "Name" without an email; '' without a name. */
export function formatRoleHolder(r: Pick<SspRoleEntry, 'name' | 'email'>): string {
  const name = text(r.name);
  const email = text(r.email);
  if (name === '') return '';
  return email === '' ? name : `${name} (${email})`;
}

/**
 * What the legacy `systemOwner` metadata field should hold, derived from the System Owner role row (kept in step so an older image and the
 * SPRS gate still read an owner). null: no write (no row, no name, or the field already holds it).
 */
export function systemOwnerMirror(profile: SspProfile | null, current?: string): string | null {
  const row = (profile?.roles ?? []).find((r) => r.roleKey === 'system_owner');
  if (!row) return null;
  const holder = formatRoleHolder(row);
  if (holder === '') return null;
  return holder === (current ?? '') ? null : holder;
}

/** Only a CMMC Level 2 or NIST SP 800-171 Rev. 3 program holds CUI (Level 1 is FCI only). */
export function isCuiProgram(framework: string | null | undefined): boolean {
  return framework === 'CMMC_L2' || framework === 'NIST_800_171_R3';
}

/** The categorization to suggest (never to store without a click): Moderate across the board for CMMC L2 and NIST SP 800-171 Rev. 3, the baseline for NIST SP 800-53, none otherwise. */
export function suggestedCategorization(p: { framework: string; baseline?: ProgramBaseline | null }): { confidentiality: ImpactLevel; integrity: ImpactLevel; availability: ImpactLevel } | null {
  if (p.framework === 'CMMC_L2' || p.framework === 'NIST_800_171_R3') return { confidentiality: 'MODERATE', integrity: 'MODERATE', availability: 'MODERATE' };
  if ((p.framework === 'NIST_800_53_REV5' || p.framework === 'nist-800-53-r5') && p.baseline) {
    return { confidentiality: p.baseline, integrity: p.baseline, availability: p.baseline };
  }
  return null;
}

const IMPACT_RANK: Record<ImpactLevel, number> = { LOW: 0, MODERATE: 1, HIGH: 2 };

/** The high-water mark of the three impacts; null while any is unset. */
export function overallImpact(profile: SspProfile | null): ImpactLevel | null {
  const levels = [profile?.confidentialityImpact, profile?.integrityImpact, profile?.availabilityImpact];
  if (levels.some((l) => !l)) return null;
  return (levels as ImpactLevel[]).reduce((a, b) => (IMPACT_RANK[b] > IMPACT_RANK[a] ? b : a));
}

/**
 * The canonical text of a section's saved fields: JSON of [key, value] pairs in a fixed order, strings normalized (line breaks, trimmed),
 * missing enums and booleans as null. Excludes `assessmentDate` (not content) and `systemOwner` (a mirror of the roles section).
 * Saved fields only: tenant fallbacks, the program boundary summary, asset counts, controls and evidence are not covered.
 */
export function sectionCanonical(id: SspSectionId, input: SspSectionContentInput): string {
  const m = input.metadata ?? {};
  const p = input.profile;
  let pairs: [string, unknown][];
  switch (id) {
    case 'identification':
      pairs = [
        ['systemName', text(m.systemName)],
        ['organizationName', text(m.organizationName)],
        ['cageCode', text(m.cageCode)],
        ['samStatus', text(m.samStatus)],
        ['authorName', text(m.authorName)],
        ['version', text(m.version)],
        ['systemIdentifier', text(p?.systemIdentifier)],
        ['confidentialityImpact', p?.confidentialityImpact ?? null],
        ['integrityImpact', p?.integrityImpact ?? null],
        ['availabilityImpact', p?.availabilityImpact ?? null],
      ];
      break;
    case 'roles':
      pairs = [[
        'roles',
        effectiveSspRoles(p, m.systemOwner).map((r) => [
          r.roleKey,
          text(r.customTitle),
          text(r.memberUserId),
          text(r.name),
          text(r.email),
          r.certificateOnFile ?? null,
        ]),
      ]];
      break;
    case 'environment':
      pairs = [
        ['systemBoundaryScope', text(m.systemBoundaryScope)],
        ['systemEnvironment', text(m.systemEnvironment)],
        ['cloudServiceProviders', text(m.cloudServiceProviders)],
        ['serviceCommitments', text(m.serviceCommitments)],
      ];
      break;
    case 'system_details':
    case 'documents':
    case 'data_inventory':
      return '[]'; // derived from the register: never signed, never hashed
    case 'maintenance': {
      const mt = p?.maintenance;
      pairs = [
        ['hardwareMaintainedByOrg', mt?.hardwareMaintainedByOrg ?? null],
        ['hardwareOwnedByOrg', mt?.hardwareOwnedByOrg ?? null],
        ['softwareMaintainedByOrg', mt?.softwareMaintainedByOrg ?? null],
        ['softwareOwnedByOrg', mt?.softwareOwnedByOrg ?? null],
        ['exceptions', text(mt?.exceptions)],
      ];
      break;
    }
  }
  return JSON.stringify(pairs);
}
