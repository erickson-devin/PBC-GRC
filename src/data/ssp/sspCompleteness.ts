// What the SSP still lacks, section by section (#238): one registry of items with their requiredness per framework, used by the builder nav,
// the export readiness check and later dashboards. Pure: types and the register's item rules (sections 1.3 and 1.4, inventory/sspInventory.ts) only.
// A suggested categorization never counts as filled.

import type { SSPMetadata } from '../../types/cmmc';
import type { Program } from '../../types/program';
import type { ReportMetadata } from '../../types/report';
import type { SspMetadataFields } from '../../types/sspMetadata';
import type { SspProfile, SspRoleKey, SspSectionReviewState } from '../../types/sspProfile';
import type { Tenant } from '../../types/tenant';
import { SSP_ROLE_LABELS, SSP_SECTIONS, effectiveSspRoles, type SspSectionId } from './sspSections';
import { inventoryCompletenessItems, type SspInventoryCompletenessInput } from '../inventory/sspInventory';

export type SspItemSeverity = 'required' | 'advisory';

export interface SspItemStatus {
  /** e.g. 'systemName', 'role:isso_ciso', 'maintenance:exceptions'. */
  id: string;
  sectionId: SspSectionId;
  label: string;
  severity: SspItemSeverity;
  missing: boolean;
  /** The ReportMetadata field this item is the source of, when the export modal has one. */
  reportField?: keyof ReportMetadata;
}

export interface SspSectionStatus {
  sectionId: SspSectionId;
  number: string;
  title: string;
  items: SspItemStatus[];
  requiredTotal: number;
  requiredMissing: number;
  advisoryMissing: number;
  complete: boolean;
  /**
   * False for 1.3 and 1.4 when the Tools and Services register is not available (a browser-only organization, or nothing loaded): the section then has
   * no items and counts toward no total. Every other section is always available.
   */
  available: boolean;
}

export interface SspCompleteness {
  sections: SspSectionStatus[];
  requiredMissing: number;
  advisoryMissing: number;
  complete: boolean;
}

export interface SspCompletenessInput {
  framework: string;
  metadata: SspMetadataFields;
  profile: SspProfile | null;
  /** Stands in for a blank boundary text (the program's boundary summary, then the tenant's). */
  boundaryFallback?: string | null;
  /**
   * The Tools and Services register and the data inventory (sections 1.3 and 1.4). Without it, or when `supported` is false, both sections are
   * unavailable: no items, nothing counted. With it, a CMMC Level 2 program must select at least one CUI category (required); missing user counts are advisory.
   */
  inventory?: SspInventoryCompletenessInput;
}

/** Not a string, or whitespace only. */
export const isBlank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

/** cmmc2: CMMC Level 2 (CUI); strict: CMMC Level 1 and NIST SP 800-53; light: SOC 2, HIPAA and anything else. */
type FrameworkClass = 'cmmc2' | 'strict' | 'light';

function classOf(framework: string): FrameworkClass {
  if (framework === 'CMMC_L2') return 'cmmc2';
  if (framework === 'CMMC_L1' || framework === 'NIST_800_53_REV5' || framework === 'nist-800-53-r5') return 'strict';
  return 'light';
}

const sev = (required: boolean): SspItemSeverity => (required ? 'required' : 'advisory');

const MAINTENANCE_ANSWERS = [
  ['hardwareMaintainedByOrg', 'Hardware is maintained by the organization'],
  ['hardwareOwnedByOrg', 'Hardware is owned by the organization'],
  ['softwareMaintainedByOrg', 'Software is maintained by the organization'],
  ['softwareOwnedByOrg', 'Software is owned by the organization'],
] as const;

const ROLE_ITEM_KEYS = (Object.keys(SSP_ROLE_LABELS) as SspRoleKey[]).filter((k) => k !== 'custom');

function itemsFor(input: SspCompletenessInput): SspItemStatus[] {
  const cls = classOf(input.framework);
  const strictish = cls !== 'light';
  const m = input.metadata ?? {};
  const p = input.profile;
  const items: SspItemStatus[] = [];
  const add = (item: SspItemStatus) => items.push(item);

  // 1.1 identification
  add({ id: 'systemName', sectionId: 'identification', label: 'System name', severity: 'required', missing: isBlank(m.systemName), reportField: 'systemName' });
  add({ id: 'organizationName', sectionId: 'identification', label: 'Organization name', severity: 'required', missing: isBlank(m.organizationName), reportField: 'organizationName' });
  add({ id: 'authorName', sectionId: 'identification', label: 'Assessor or author', severity: 'required', missing: isBlank(m.authorName), reportField: 'primaryAssessor' });
  add({ id: 'cageCode', sectionId: 'identification', label: 'CAGE code', severity: 'advisory', missing: isBlank(m.cageCode), reportField: 'cageCode' });
  add({ id: 'samStatus', sectionId: 'identification', label: 'SAM.gov registration status', severity: 'advisory', missing: isBlank(m.samStatus), reportField: 'samStatus' });
  add({ id: 'systemIdentifier', sectionId: 'identification', label: 'System unique identifier', severity: sev(strictish), missing: isBlank(p?.systemIdentifier) });
  add({ id: 'confidentialityImpact', sectionId: 'identification', label: 'Confidentiality impact', severity: sev(strictish), missing: !p?.confidentialityImpact });
  add({ id: 'integrityImpact', sectionId: 'identification', label: 'Integrity impact', severity: sev(strictish), missing: !p?.integrityImpact });
  add({ id: 'availabilityImpact', sectionId: 'identification', label: 'Availability impact', severity: sev(strictish), missing: !p?.availabilityImpact });

  // 1.2 roles (a custom role is extra and never an item)
  const roles = effectiveSspRoles(p, m.systemOwner);
  for (const key of ROLE_ITEM_KEYS) {
    const required = key === 'system_owner' || (key === 'isso_ciso' && strictish) || (key === 'ir_reporting_primary' && cls === 'cmmc2');
    add({
      id: `role:${key}`,
      sectionId: 'roles',
      label: SSP_ROLE_LABELS[key],
      severity: sev(required),
      missing: !roles.some((r) => r.roleKey === key && !isBlank(r.name)),
      ...(key === 'system_owner' ? { reportField: 'systemOwner' as const } : {}),
    });
  }

  // 2.1 environment
  add({ id: 'systemBoundaryScope', sectionId: 'environment', label: 'System boundary description', severity: 'required', missing: isBlank(m.systemBoundaryScope) && isBlank(input.boundaryFallback), reportField: 'boundaryDescription' });
  add({ id: 'systemEnvironment', sectionId: 'environment', label: 'System environment', severity: 'advisory', missing: isBlank(m.systemEnvironment) });
  add({ id: 'cloudServiceProviders', sectionId: 'environment', label: 'Cloud service providers', severity: 'advisory', missing: isBlank(m.cloudServiceProviders) });
  if (input.framework === 'SOC_2_TYPE_II') {
    add({ id: 'serviceCommitments', sectionId: 'environment', label: 'Principal service commitments', severity: 'advisory', missing: isBlank(m.serviceCommitments) });
  }

  // 2.3 maintenance (the exceptions are asked for only when an answer is No)
  const mt = p?.maintenance;
  for (const [key, label] of MAINTENANCE_ANSWERS) {
    add({ id: `maintenance:${key}`, sectionId: 'maintenance', label, severity: sev(strictish), missing: typeof mt?.[key] !== 'boolean' });
  }
  if (MAINTENANCE_ANSWERS.some(([key]) => mt?.[key] === false)) {
    add({ id: 'maintenance:exceptions', sectionId: 'maintenance', label: 'Maintenance and ownership exceptions', severity: 'required', missing: isBlank(mt?.exceptions) });
  }

  // 1.3 system details and 1.4 information types (from the Tools and Services register; nothing without it)
  if (input.inventory) for (const item of inventoryCompletenessItems(input.framework, input.inventory)) add(item);
  return items;
}

export function computeSspCompleteness(input: SspCompletenessInput): SspCompleteness {
  const all = itemsFor(input);
  const inventorySupported = input.inventory?.supported === true;
  const sections: SspSectionStatus[] = SSP_SECTIONS.map((def) => {
    const available = (def.id !== 'system_details' && def.id !== 'data_inventory') || inventorySupported;
    const items = available ? all.filter((i) => i.sectionId === def.id) : [];
    const requiredMissing = items.filter((i) => i.severity === 'required' && i.missing).length;
    return {
      sectionId: def.id,
      number: def.number,
      title: def.title,
      items,
      requiredTotal: items.filter((i) => i.severity === 'required').length,
      requiredMissing,
      advisoryMissing: items.filter((i) => i.severity === 'advisory' && i.missing).length,
      complete: requiredMissing === 0,
      available,
    };
  });
  const requiredMissing = sections.reduce((n, s) => n + s.requiredMissing, 0);
  return {
    sections,
    requiredMissing,
    advisoryMissing: sections.reduce((n, s) => n + s.advisoryMissing, 0),
    complete: requiredMissing === 0,
  };
}

/** The same fallback chain the export modal uses to prefill its form (saved value, then the tenant, then the program). */
export function resolveSspCompletenessInput(a: {
  meta: Partial<SSPMetadata>;
  tenant: Pick<Tenant, 'systemName' | 'name' | 'cageCode' | 'samStatus' | 'systemOwner' | 'systemBoundaryScope'>;
  program: Pick<Program, 'boundarySummary' | 'framework'> | null;
  framework: string;
  profile: SspProfile | null;
}): SspCompletenessInput {
  const { meta, tenant, program } = a;
  const metadata: SspMetadataFields = {
    systemName: meta.systemName || tenant.systemName || '',
    organizationName: meta.organizationName || tenant.name || '',
    cageCode: meta.cageCode || tenant.cageCode || '',
    samStatus: meta.samStatus || tenant.samStatus || '',
    systemOwner: meta.systemOwner || tenant.systemOwner || '',
    authorName: meta.authorName || '',
    systemBoundaryScope: meta.systemBoundaryScope || '',
    systemEnvironment: meta.systemEnvironment || '',
    cloudServiceProviders: meta.cloudServiceProviders || '',
    serviceCommitments: meta.serviceCommitments || '',
  };
  return {
    framework: a.framework,
    metadata,
    profile: a.profile,
    boundaryFallback: program?.boundarySummary || tenant.systemBoundaryScope || null,
  };
}

/** The completeness input of an export form's values (ReportMetadata) and the program's profile. */
export function sspCompletenessFromReport(meta: Partial<ReportMetadata>, profile: SspProfile | null, inventory?: SspInventoryCompletenessInput): SspCompletenessInput {
  return {
    framework: meta.framework ?? '',
    metadata: {
      systemName: meta.systemName ?? '',
      organizationName: meta.organizationName ?? '',
      cageCode: meta.cageCode ?? '',
      samStatus: meta.samStatus ?? '',
      systemOwner: meta.systemOwner ?? '',
      authorName: meta.primaryAssessor ?? '',
      systemBoundaryScope: meta.boundaryDescription ?? '',
      systemEnvironment: meta.systemEnvironment ?? '',
      cloudServiceProviders: meta.cloudServiceProviders ?? '',
      serviceCommitments: meta.serviceCommitments ?? '',
    },
    profile,
    ...(inventory ? { inventory } : {}),
  };
}

export type SspReviewStatus = 'unavailable' | 'not_reviewed' | 'reviewed' | 'changed_since_review';

/** The review chip of a section: unavailable without a server-backed organization; changed when a review exists but its digest is no longer current. */
export function sectionReviewStatus(state: SspSectionReviewState | null | undefined, supported: boolean): SspReviewStatus {
  if (!supported) return 'unavailable';
  if (!state || !state.latest) return 'not_reviewed';
  return state.reviewed ? 'reviewed' : 'changed_since_review';
}
