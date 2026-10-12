import type { AssetDiscoveryStatus, CmmcAssetCategory } from '../../types/telemetry';

/**
 * Cryptographic module validation (FIPS 140-2 / 140-3, NIST CMVP) tracking for enclave assets. Pure: shared by the
 * server (validation), the asset form, the policy compiler and the SSP.
 *
 * NIST SP 800-171 3.13.11 requires FIPS-validated cryptography wherever CUI is protected. What an assessor asks for is
 * the CMVP certificate number of each module, so that is what the inventory records and the documents cite.
 */
export type FipsValidationStatus = 'VALIDATED' | 'PENDING' | 'NOT_APPLICABLE';
export const FIPS_STATUSES: readonly FipsValidationStatus[] = ['VALIDATED', 'PENDING', 'NOT_APPLICABLE'];

/** Which FIPS 140 revision the certificate was issued under. Optional: documents say plain "FIPS 140" without it. */
export type FipsStandard = '140-2' | '140-3';
export const FIPS_STANDARDS: readonly FipsStandard[] = ['140-2', '140-3'];

/** Categories that can carry cryptographic-module details: those that protect or process CUI. */
export const FIPS_ELIGIBLE_CATEGORIES: readonly CmmcAssetCategory[] = ['SECURITY_PROTECTION', 'CUI_ASSET'];
export const isFipsEligibleCategory = (c: CmmcAssetCategory): boolean => FIPS_ELIGIBLE_CATEGORIES.includes(c);

export const FIPS_STATUS_LABELS: Record<FipsValidationStatus, string> = {
  VALIDATED: 'Validated (CMVP certificate)',
  PENDING: 'Pending validation',
  NOT_APPLICABLE: 'Not applicable (no cryptography)',
};

export interface FipsFields {
  fipsValidationStatus: FipsValidationStatus | null;
  /** CMVP certificate number, digits only (e.g. "4211"). */
  fipsCertificateNumber: string | null;
  fipsModuleName: string | null;
  fipsStandard: FipsStandard | null;
}

export const NO_FIPS: FipsFields = { fipsValidationStatus: null, fipsCertificateNumber: null, fipsModuleName: null, fipsStandard: null };

export const isFipsStatus = (v: unknown): v is FipsValidationStatus => typeof v === 'string' && (FIPS_STATUSES as readonly string[]).includes(v);
export const isFipsStandard = (v: unknown): v is FipsStandard => typeof v === 'string' && (FIPS_STANDARDS as readonly string[]).includes(v);

/** "#4211", "cert 4211" and "4211" all mean 4211. Null when it is not a 1-6 digit CMVP certificate number. */
export function normalizeCertificateNumber(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).trim().replace(/^(?:certificate|cert)?\s*(?:no\.?|number)?\s*#?\s*/i, '');
  return /^\d{1,6}$/.test(digits) ? String(Number(digits)) : null;
}

export type FipsCheck = { ok: true; fields: FipsFields } | { ok: false; error: string };

/**
 * Checks a complete FIPS record against its asset's category and returns the canonical form to store.
 *  - an ineligible category (Out-of-Scope, CRMA, SA) carries no FIPS details: they are cleared, not rejected, so that
 *    reclassifying an asset never needs a second step;
 *  - VALIDATED needs a certificate number (a validation claim without its evidence is not recorded);
 *  - a certificate number or module name needs VALIDATED or PENDING; NOT_APPLICABLE and "unset" carry neither.
 */
export function normalizeFips(category: CmmcAssetCategory, input: Partial<FipsFields>): FipsCheck {
  if (!isFipsEligibleCategory(category)) return { ok: true, fields: { ...NO_FIPS } };

  const status = input.fipsValidationStatus ?? null;
  if (status !== null && !isFipsStatus(status)) return { ok: false, error: `FIPS validation status must be one of: ${FIPS_STATUSES.join(', ')}` };
  const standard = input.fipsStandard ?? null;
  if (standard !== null && !isFipsStandard(standard)) return { ok: false, error: `FIPS standard must be one of: ${FIPS_STANDARDS.join(', ')}` };

  const rawCert = input.fipsCertificateNumber;
  const cert = rawCert === null || rawCert === undefined || String(rawCert).trim() === '' ? null : normalizeCertificateNumber(rawCert);
  if (rawCert !== null && rawCert !== undefined && String(rawCert).trim() !== '' && cert === null) {
    return { ok: false, error: 'The CMVP certificate number must be 1 to 6 digits (for example 4211)' };
  }
  const moduleName = typeof input.fipsModuleName === 'string' && input.fipsModuleName.trim() !== '' ? input.fipsModuleName.trim() : null;
  if (moduleName !== null && (moduleName.length > 255 || /[\u0000-\u001f\u007f]/.test(moduleName))) {
    return { ok: false, error: 'The cryptographic module name must be plain text of at most 255 characters' };
  }

  if (status === 'VALIDATED' && cert === null) return { ok: false, error: 'A validated module needs its CMVP certificate number' };
  if ((status === null || status === 'NOT_APPLICABLE') && (cert !== null || moduleName !== null)) {
    return { ok: false, error: 'Set the validation status to Validated or Pending to record a certificate number or module name' };
  }
  if (status === 'PENDING' && cert !== null) return { ok: false, error: 'A pending module has no certificate yet: set the status to Validated once it has one' };

  return { ok: true, fields: { fipsValidationStatus: status, fipsCertificateNumber: cert, fipsModuleName: moduleName, fipsStandard: status === 'NOT_APPLICABLE' || status === null ? null : standard } };
}

// ------------------------------------------------------------------------------------------------ documents

export interface FipsModuleRef {
  assetName: string;
  moduleName: string | null;
  certificateNumber: string;
  standard: FipsStandard | null;
}

type InventoryAsset = {
  hostName: string;
  cmmcAssetCategory: CmmcAssetCategory;
  discoveryStatus?: AssetDiscoveryStatus;
  fipsValidationStatus?: FipsValidationStatus | null;
  fipsCertificateNumber?: string | null;
  fipsModuleName?: string | null;
  fipsStandard?: FipsStandard | null;
};

/**
 * The validated cryptographic modules the documents may cite: Security Protection Assets with status VALIDATED and a
 * certificate number. Unclassified discovered assets and decommissioned ones are never cited. The same certificate on
 * several assets (one module deployed many times) is listed once. Sorted by certificate number.
 */
export function collectFipsModules(assets: ReadonlyArray<InventoryAsset>, categories: readonly CmmcAssetCategory[] = ['SECURITY_PROTECTION']): FipsModuleRef[] {
  const seen = new Set<string>();
  const out: FipsModuleRef[] = [];
  for (const a of assets) {
    if (!categories.includes(a.cmmcAssetCategory)) continue;
    if (a.discoveryStatus === 'UNCONFIRMED_DISCOVERY' || a.discoveryStatus === 'DECOMMISSIONED') continue;
    if (a.fipsValidationStatus !== 'VALIDATED' || !a.fipsCertificateNumber) continue;
    const key = `${a.fipsStandard ?? ''}#${a.fipsCertificateNumber}|${(a.fipsModuleName ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ assetName: a.hostName, moduleName: a.fipsModuleName ?? null, certificateNumber: a.fipsCertificateNumber, standard: a.fipsStandard ?? null });
  }
  return out.sort((x, y) => Number(x.certificateNumber) - Number(y.certificateNumber) || x.assetName.localeCompare(y.assetName));
}

/** "FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)". Without a revision: "FIPS 140 Certificate #4211 (...)". */
export function describeFipsModule(m: Pick<FipsModuleRef, 'moduleName' | 'certificateNumber' | 'standard'>): string {
  return `FIPS ${m.standard ?? '140'} Certificate #${m.certificateNumber}${m.moduleName ? ` (${m.moduleName})` : ''}`;
}

const joinList = (items: string[]): string =>
  items.length <= 1 ? items.join('') : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

/** The modules as running text: "FIPS 140-2 Certificate #4211 (CrowdStrike Falcon) and FIPS 140-3 Certificate #4802 (...)". */
export const describeFipsModules = (modules: ReadonlyArray<FipsModuleRef>): string => joinList(modules.map(describeFipsModule));

/** Matches the generic "FIPS 140-3" / "FIPS 140-2" text of a template, with or without bold markers. */
const GENERIC_FIPS = /\*\*FIPS 140-[23]\*\*|FIPS 140-[23]/g;

/**
 * Writes the inventory's validated modules into a requirement narrative (3.13.11). `bold: false` for plain-text cells (SSP).
 *  - modules recorded: generic "FIPS 140-x" text is replaced by the certificates; if the template has none, a sentence
 *    listing them is appended;
 *  - none recorded: the template is kept and an explicit, visible gap note is appended, so a document never implies
 *    validation that the inventory cannot show.
 */
export function applyFipsModules(narrative: string, modules: ReadonlyArray<FipsModuleRef>, options: { bold?: boolean } = {}): string {
  if (modules.length === 0) {
    return `${narrative} [No FIPS-validated cryptographic module is recorded in the asset inventory for the Security Protection Assets. Record the CMVP certificate number of each module to evidence this requirement.]`;
  }
  const text = describeFipsModules(modules);
  const list = options.bold === false ? text : `**${text}**`;
  if (GENERIC_FIPS.test(narrative)) {
    GENERIC_FIPS.lastIndex = 0;
    return narrative.replace(GENERIC_FIPS, () => list);
  }
  GENERIC_FIPS.lastIndex = 0;
  return `${narrative} Cryptographic modules protecting CUI are validated under the NIST Cryptographic Module Validation Program: ${list}.`;
}

/** True for the requirement id in any of its spellings (SC.L2-3.13.11, 3.13.11, SC-13 style is NOT matched). */
export const isCryptographicProtectionControl = (controlId: string): boolean => /(?:^|[^\d.])3\.13\.11(?:$|[^\d])/.test(controlId);

/**
 * What to write for the FIPS fields when `patch` is applied to `existing`, or null when the patch touches neither a FIPS
 * field nor the category. The result is always a complete, canonical set (see normalizeFips). Used by the server and by
 * the browser-local store, so both apply the same rules.
 */
export function resolveFips(
  existing: { cmmcAssetCategory: CmmcAssetCategory } & Partial<FipsFields>,
  patch: { cmmcAssetCategory?: CmmcAssetCategory } & Partial<FipsFields>
): { ok: true; value: FipsFields | null } | { ok: false; error: string } {
  const touched =
    patch.cmmcAssetCategory !== undefined || patch.fipsValidationStatus !== undefined || patch.fipsCertificateNumber !== undefined ||
    patch.fipsModuleName !== undefined || patch.fipsStandard !== undefined;
  if (!touched) return { ok: true, value: null };
  const merged: Partial<FipsFields> = {
    fipsValidationStatus: patch.fipsValidationStatus !== undefined ? patch.fipsValidationStatus : existing.fipsValidationStatus ?? null,
    fipsCertificateNumber: patch.fipsCertificateNumber !== undefined ? patch.fipsCertificateNumber : existing.fipsCertificateNumber ?? null,
    fipsModuleName: patch.fipsModuleName !== undefined ? patch.fipsModuleName : existing.fipsModuleName ?? null,
    fipsStandard: patch.fipsStandard !== undefined ? patch.fipsStandard : existing.fipsStandard ?? null,
  };
  const checked = normalizeFips(patch.cmmcAssetCategory ?? existing.cmmcAssetCategory, merged);
  return checked.ok ? { ok: true, value: checked.fields } : { ok: false, error: checked.error };
}
