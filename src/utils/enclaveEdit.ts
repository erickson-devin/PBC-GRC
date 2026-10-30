import type { Tenant } from '../types/tenant';
import type { ComplianceFramework } from '../types/framework';

/**
 * Pure helpers for the "Edit Enclave" form: one save becomes ONE tenant update (so one PATCH for a server-backed
 * tenant, all-or-nothing), carrying the frameworks only when they actually changed.
 */

export interface FrameworkSelection {
  primary: ComplianceFramework;
  enabled: ComplianceFramework[];
}

/** The frameworks a tenant has now, as the form pre-fills them. */
export function currentFrameworkSelection(t: Pick<Tenant, 'primaryFramework' | 'enabledFrameworks'>): FrameworkSelection {
  const primary = t.primaryFramework || 'CMMC_L1';
  const enabled = t.enabledFrameworks && t.enabledFrameworks.length > 0 ? t.enabledFrameworks : [primary];
  return { primary, enabled };
}

/** De-duplicates the enabled list (keeping its order) and makes sure the primary framework is in it, first when added. */
export function normalizeFrameworkSelection(primary: ComplianceFramework, enabled: readonly ComplianceFramework[]): FrameworkSelection {
  const unique = enabled.filter((fw, i) => enabled.indexOf(fw) === i);
  return { primary, enabled: unique.includes(primary) ? unique : [primary, ...unique] };
}

/** True when the primary framework differs or the enabled sets differ (the order of the list does not matter). */
export function frameworksChanged(a: FrameworkSelection, b: FrameworkSelection): boolean {
  const x = normalizeFrameworkSelection(a.primary, a.enabled);
  const y = normalizeFrameworkSelection(b.primary, b.enabled);
  if (x.primary !== y.primary) return true;
  if (x.enabled.length !== y.enabled.length) return true;
  return x.enabled.some((fw) => !y.enabled.includes(fw));
}

/** The "Name (email)" form the SSP shows as the system owner (same rule as TenantContext.updateTenantOwner). */
export function formatSystemOwner(email: string): string {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = cleanEmail.split('@')[0].replace('.', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${cleanName} (${cleanEmail})`;
}

export interface EnclaveEditForm {
  name: string;
  cageCode: string;
  primaryFramework: ComplianceFramework;
  enabledFrameworks: ComplianceFramework[];
  /** The new owner email, or null when the owner was not changed. */
  newOwnerEmail: string | null;
}

/** Everything one save changes, as a single update. The frameworks are included only when they changed. */
export function buildEnclaveEditUpdates(
  tenant: Pick<Tenant, 'primaryFramework' | 'enabledFrameworks'>,
  form: EnclaveEditForm
): { updates: Partial<Tenant>; frameworksChanged: boolean } {
  const updates: Partial<Tenant> = {
    name: form.name.trim(),
    cageCode: (form.cageCode.trim() || 'PENDING').toUpperCase(),
  };
  const next = normalizeFrameworkSelection(form.primaryFramework, form.enabledFrameworks);
  const changed = frameworksChanged(currentFrameworkSelection(tenant), next);
  if (changed) {
    updates.primaryFramework = next.primary;
    updates.enabledFrameworks = next.enabled;
  }
  if (form.newOwnerEmail !== null) updates.systemOwner = formatSystemOwner(form.newOwnerEmail);
  return { updates, frameworksChanged: changed };
}

/** Fixed text for a refused enclave save, by HTTP status only (never the server's text). */
export function enclaveSaveErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 403) return "Your role cannot change this organization's settings, or a chosen framework is not licensed for it. Nothing was saved.";
  if (status === 401) return 'Your session has ended. Sign in again; nothing was saved.';
  if (status === 0) return 'The server could not be reached. Nothing was saved. Try again, or cancel.';
  if (status === 400 || status === 409) return 'The server did not accept these changes. Nothing was saved. Check the name and frameworks, then try again.';
  return 'The changes could not be saved. Nothing was saved. Try again, or cancel.';
}
