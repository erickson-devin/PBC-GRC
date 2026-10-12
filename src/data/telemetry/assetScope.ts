import type { AssetDiscoveryStatus, CmmcAssetCategory, EnclaveAsset } from '../../types/telemetry';

/**
 * CMMC 2.0 asset scoping (32 CFR 170.19 / the CMMC Scoping Guides). Pure: shared by the server (validation), the
 * asset inventory UI (labels, filters) and the SSP generator (boundary summary).
 */
export const CMMC_ASSET_CATEGORIES: readonly CmmcAssetCategory[] = [
  'CUI_ASSET',
  'SECURITY_PROTECTION',
  'CONTRACTOR_RISK',
  'SPECIALIZED_ASSET',
  'OUT_OF_SCOPE',
];

export interface CategoryInfo {
  /** Full, explicit name shown in the UI and the SSP. */
  label: string;
  /** Compact form for pills and chart legends. */
  short: string;
  /** One line explaining what belongs here. */
  description: string;
  /** In scope for the assessment boundary (everything except Out-of-Scope). */
  inScope: boolean;
}

export const CATEGORY_INFO: Record<CmmcAssetCategory, CategoryInfo> = {
  CUI_ASSET: {
    label: 'CUI Asset',
    short: 'CUI',
    description: 'Processes, stores, or transmits CUI',
    inScope: true,
  },
  SECURITY_PROTECTION: {
    label: 'Security Protection Asset (SPA)',
    short: 'SPA',
    description: 'Provides security functions for the CUI environment: firewall, SIEM, IAM, bastion',
    inScope: true,
  },
  CONTRACTOR_RISK: {
    label: 'Contractor Risk Managed Asset (CRMA)',
    short: 'CRMA',
    description: 'Can, but is not intended to, handle CUI; managed under the contractor\'s risk-based security policies',
    inScope: true,
  },
  SPECIALIZED_ASSET: {
    label: 'Specialized Asset (SA)',
    short: 'SA',
    description: 'Government property, IoT/OT, restricted information systems and test equipment',
    inScope: true,
  },
  OUT_OF_SCOPE: {
    label: 'Out-of-Scope Asset',
    short: 'Out of scope',
    description: 'Cannot process, store, or transmit CUI and is logically or physically separated from it',
    inScope: false,
  },
};

export const isCmmcAssetCategory = (value: unknown): value is CmmcAssetCategory =>
  typeof value === 'string' && (CMMC_ASSET_CATEGORIES as readonly string[]).includes(value);

/** Lenient parser for CSV cells and free text ("spa", "Contractor Risk", "out of scope", ...). Null when unrecognised. */
export function parseAssetCategory(raw: string | null | undefined): CmmcAssetCategory | null {
  const v = (raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!v) return null;
  if (isCmmcAssetCategory(v)) return v;
  if (v === 'CUI' || v.includes('CUI')) return 'CUI_ASSET';
  if (v === 'SPA' || v.includes('SECURITY')) return 'SECURITY_PROTECTION';
  if (v === 'CRMA' || v.includes('RISK') || v.includes('CONTRACTOR')) return 'CONTRACTOR_RISK';
  if (v === 'SA' || v === 'SPA_SPECIALIZED' || v.includes('SPECIALIZED')) return 'SPECIALIZED_ASSET';
  if (v.includes('OUT') || v.includes('SCOPE')) return 'OUT_OF_SCOPE';
  return null;
}

export interface AssetScopeSummary {
  /** Assets counted in the boundary: every non-decommissioned asset (classified or awaiting classification). */
  total: number;
  /** Classified assets per category. Discovered assets awaiting an administrator's decision are NOT in here. */
  byCategory: Record<CmmcAssetCategory, number>;
  /** In the assessment boundary and classified: CUI + SPA + CRMA + SA. */
  inScope: number;
  /** Discovered by the network sensor but not yet classified (they default to CRMA until someone decides). */
  unconfirmed: number;
  /** Retired assets, kept for history and excluded from every count above. */
  decommissioned: number;
}

export function emptyScopeSummary(): AssetScopeSummary {
  return {
    total: 0,
    byCategory: { CUI_ASSET: 0, SECURITY_PROTECTION: 0, CONTRACTOR_RISK: 0, SPECIALIZED_ASSET: 0, OUT_OF_SCOPE: 0 },
    inScope: 0,
    unconfirmed: 0,
    decommissioned: 0,
  };
}

export function summarizeScope(
  assets: ReadonlyArray<{ cmmcAssetCategory: CmmcAssetCategory; discoveryStatus?: AssetDiscoveryStatus }>
): AssetScopeSummary {
  const summary = emptyScopeSummary();
  for (const a of assets) {
    if (a.discoveryStatus === 'DECOMMISSIONED') {
      summary.decommissioned += 1;
      continue;
    }
    summary.total += 1;
    if (a.discoveryStatus === 'UNCONFIRMED_DISCOVERY') {
      summary.unconfirmed += 1;
      continue;
    }
    summary.byCategory[a.cmmcAssetCategory] += 1;
    if (CATEGORY_INFO[a.cmmcAssetCategory].inScope) summary.inScope += 1;
  }
  return summary;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The plain-language boundary statement for the SSP (section 1.2). */
export function boundaryNarrative(summary: AssetScopeSummary): string {
  if (summary.total === 0) {
    return 'No assets have been registered in the asset inventory yet, so the assessment boundary has not been defined.';
  }
  const c = summary.byCategory;
  const sentences = [
    `The assessment boundary contains ${plural(summary.inScope, 'in-scope asset', 'in-scope assets')}: ` +
      `${plural(c.CUI_ASSET, 'CUI Asset', 'CUI Assets')}, ` +
      `${plural(c.SECURITY_PROTECTION, 'Security Protection Asset (SPA)', 'Security Protection Assets (SPA)')}, ` +
      `${plural(c.CONTRACTOR_RISK, 'Contractor Risk Managed Asset (CRMA)', 'Contractor Risk Managed Assets (CRMA)')} and ` +
      `${plural(c.SPECIALIZED_ASSET, 'Specialized Asset (SA)', 'Specialized Assets (SA)')}.`,
    `${c.OUT_OF_SCOPE === 1 ? '1 asset is' : `${c.OUT_OF_SCOPE} assets are`} documented as out of scope.`,
  ];
  if (summary.unconfirmed > 0) {
    sentences.push(
      `${plural(summary.unconfirmed, 'discovered asset has', 'discovered assets have')} not yet been classified and ` +
        `${summary.unconfirmed === 1 ? 'is' : 'are'} excluded from these counts until an administrator assigns a category.`
    );
  }
  return sentences.join(' ');
}

/** What the client may send when creating or changing an asset (the server owns id, tenant and timestamps). */
export type AssetInput = Partial<Omit<EnclaveAsset, 'id' | 'tenantId' | 'isManuallyAdded'>>;

/** Parses the asset list a server response carries; entries that are not a usable asset are dropped. */
export function parseServerAssets(raw: unknown): EnclaveAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: EnclaveAsset[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const a = r as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.hostName !== 'string' || !isCmmcAssetCategory(a.cmmcAssetCategory)) continue;
    out.push({
      id: a.id,
      tenantId: String(a.tenantId ?? ''),
      hostName: a.hostName,
      ipAddress: String(a.ipAddress ?? ''),
      macAddress: String(a.macAddress ?? ''),
      osProfile: String(a.osProfile ?? 'custom'),
      cmmcAssetCategory: a.cmmcAssetCategory,
      status: (a.status as EnclaveAsset['status']) ?? 'NEVER_SCANNED',
      sourceOrigin: (a.sourceOrigin as EnclaveAsset['sourceOrigin']) ?? 'MANUAL_ENTRY',
      discoveryStatus: (a.discoveryStatus as EnclaveAsset['discoveryStatus']) ?? 'ACTIVE',
      ...(a.accretionMetadata && typeof a.accretionMetadata === 'object' ? { accretionMetadata: a.accretionMetadata as EnclaveAsset['accretionMetadata'] } : {}),
      lastScannedAt: typeof a.lastScannedAt === 'string' ? a.lastScannedAt : null,
      complianceScore: typeof a.complianceScore === 'number' ? a.complianceScore : null,
      notes: String(a.notes ?? ''),
      owner: String(a.owner ?? ''),
      isManuallyAdded: a.isManuallyAdded === true,
    });
  }
  return out;
}

export interface CsvParseResult {
  assets: AssetInput[];
  /** One message per row that could not be used (the row is skipped, never guessed). */
  errors: string[];
}

/**
 * Parses an asset CSV (header: hostName, ipAddress, osProfile, cmmcAssetCategory, macAddress, notes[, owner]).
 * Columns are found by name, in any order. A row with a missing or unrecognised CMMC category is reported and skipped:
 * a scoping decision is never defaulted silently (an asset wrongly left in, or out of, scope changes the boundary).
 */
export function parseAssetsCsv(csv: string): CsvParseResult {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const result: CsvParseResult = { assets: [], errors: [] };
  if (lines.length < 2) {
    result.errors.push('The CSV needs a header line and at least one row.');
    return result;
  }
  const cells = (line: string): string[] => line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
  const headers = cells(lines[0]).map((h) => h.toLowerCase());
  // Anchored patterns: a loose substring match would take "hostName" for an OS column (it contains "os")
  const find = (pattern: RegExp): number => headers.findIndex((h) => pattern.test(h));
  const hostIdx = find(/^(host|name|asset)/);
  const ipIdx = find(/^ip/);
  const macIdx = find(/^mac/);
  const osIdx = find(/^(os|platform|operating)|profile/);
  const catIdx = find(/category|cmmc|scope/);
  const ownerIdx = find(/owner/);
  const notesIdx = find(/note|desc/);
  if (catIdx < 0) {
    result.errors.push('The CSV has no cmmcAssetCategory column. Every asset needs an explicit CMMC category.');
    return result;
  }

  for (let i = 1; i < lines.length; i++) {
    const row = cells(lines[i]);
    const hostName = (hostIdx >= 0 ? row[hostIdx] : row[0]) || '';
    if (!hostName) {
      result.errors.push(`Row ${i + 1}: no host name.`);
      continue;
    }
    const category = parseAssetCategory(row[catIdx]);
    if (!category) {
      result.errors.push(`Row ${i + 1} (${hostName}): "${row[catIdx] ?? ''}" is not a CMMC category (use CUI_ASSET, SECURITY_PROTECTION, CONTRACTOR_RISK, SPECIALIZED_ASSET or OUT_OF_SCOPE).`);
      continue;
    }
    const rawOs = (osIdx >= 0 ? row[osIdx] : '').toLowerCase();
    let osProfile = 'custom';
    if (rawOs.includes('ubuntu')) osProfile = 'ubuntu2204';
    else if (rawOs.includes('win11') || rawOs.includes('windows 11')) osProfile = 'win11';
    else if (rawOs.includes('win') || rawOs.includes('server')) osProfile = 'win2022';
    else if (rawOs.includes('rhel8')) osProfile = 'rhel8';
    else if (rawOs.includes('rhel') || rawOs.includes('red hat')) osProfile = 'rhel9';
    else if (rawOs.includes('cisco') || rawOs.includes('ios')) osProfile = 'cisco_ios';
    result.assets.push({
      hostName,
      ipAddress: (ipIdx >= 0 ? row[ipIdx] : '') || '',
      macAddress: (macIdx >= 0 ? row[macIdx] : '') || '',
      osProfile,
      cmmcAssetCategory: category,
      owner: (ownerIdx >= 0 ? row[ownerIdx] : '') || '',
      notes: (notesIdx >= 0 ? row[notesIdx] : '') || 'Imported via CSV bulk onboarding',
      sourceOrigin: 'CSV_IMPORT',
    });
  }
  return result;
}
