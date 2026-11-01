import { controlsForRule, mapConfigRule, normalizeRuleId } from '../../src/data/telemetry/configRuleMap';
import type { VmConfigResult, VmConfigScan, VmConfigSuggestion, VmConfigSuggestionValue } from '../../src/types/vm';

/**
 * Control suggestions from configuration scan results (issue #103). Pure: no database, no clock. A suggestion is a reading of the
 * latest scans, computed whenever it is asked for and never stored; nothing here touches a control. A person accepts one by editing the
 * control through the ordinary controls API.
 *
 * Meaning: any in-boundary asset failing a mapped rule gives NOT_MET; MET only when every in-scope asset was evaluated and passed;
 * anything else (errors, assets with no scan) gives REVIEW. A rule the map does not know produces no suggestion.
 */

export interface SuggestionAsset {
  id: string;
  discoveryStatus: string;
  cmmcCategory: string;
}

export interface SuggestionBoundary {
  /** True when the program names its assets; false means the whole inventory. Reported back as it is. */
  declared: boolean;
  /** The assets of the boundary (the caller has already applied the program's declared list). */
  assets: SuggestionAsset[];
}

export interface SuggestionResultRow {
  scanId: string;
  ruleId: string;
  cce: string | null;
  result: VmConfigResult;
}

export interface ConfigSuggestionsComputed {
  supported: boolean;
  controls: VmConfigSuggestion[];
  /** Distinct rule ids in the latest scans that the rule map does not know. */
  unmappedRuleCount: number;
  /** Assets of the boundary that count: not decommissioned, not documented as out of scope. */
  inScope: number;
  /** Of those, how many have at least one scan. */
  evaluated: number;
}

/** Frameworks the rule map speaks: CMMC Level 1 and 2 (CMMC ids) and NIST SP 800-53 Rev. 5 (800-53 ids). */
export const CONFIG_SUGGESTION_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'];

/** The newest scan per (asset, source, benchmark, profile): by scan time, then by receipt, then by id. */
export function selectLatestScans(scans: readonly VmConfigScan[]): VmConfigScan[] {
  const latest = new Map<string, VmConfigScan>();
  for (const s of scans) {
    const key = `${s.assetId}|${s.sourceId}|${s.benchmarkId}|${s.profileId}`;
    const cur = latest.get(key);
    if (!cur) {
      latest.set(key, s);
      continue;
    }
    const a = Date.parse(s.scannedAt) - Date.parse(cur.scannedAt) || Date.parse(s.receivedAt) - Date.parse(cur.receivedAt);
    if (a > 0 || (a === 0 && s.id > cur.id)) latest.set(key, s);
  }
  return [...latest.values()];
}

type Outcome = 'PASS' | 'FAIL' | 'ERROR';

const outcomeOf = (result: VmConfigResult): Outcome | null => {
  if (result === 'pass' || result === 'fixed') return 'PASS';
  if (result === 'fail') return 'FAIL';
  if (result === 'error' || result === 'unknown') return 'ERROR';
  return null; // notapplicable, notchecked, notselected, informational: no evidence either way
};

export function computeConfigSuggestions(input: {
  scans: readonly VmConfigScan[];
  results: readonly SuggestionResultRow[];
  boundary: SuggestionBoundary;
  framework: string;
}): ConfigSuggestionsComputed {
  const inScopeAssets = input.boundary.assets.filter((a) => a.discoveryStatus !== 'DECOMMISSIONED' && a.cmmcCategory !== 'OUT_OF_SCOPE');
  const inScopeIds = new Set(inScopeAssets.map((a) => a.id));
  const unconfirmedIds = new Set(inScopeAssets.filter((a) => a.discoveryStatus === 'UNCONFIRMED_DISCOVERY').map((a) => a.id));
  const latest = selectLatestScans(input.scans.filter((s) => inScopeIds.has(s.assetId)));
  const evaluatedAssets = new Set(latest.map((s) => s.assetId));
  const base = { inScope: inScopeIds.size, evaluated: evaluatedAssets.size };
  if (!CONFIG_SUGGESTION_FRAMEWORKS.includes(input.framework)) {
    return { supported: false, controls: [], unmappedRuleCount: 0, ...base };
  }

  const scanById = new Map(latest.map((s) => [s.id, s]));
  interface PerControl {
    outcomes: Map<string, Set<Outcome>>; // asset id -> outcomes seen
    rules: Set<string>;
    failingRules: Set<string>;
    latestScanAt: string | null;
  }
  const byControl = new Map<string, PerControl>();
  const unmapped = new Set<string>();

  for (const row of input.results) {
    const scan = scanById.get(row.scanId);
    if (!scan) continue;
    if (!mapConfigRule({ ruleId: row.ruleId, cce: row.cce })) {
      unmapped.add(normalizeRuleId(row.ruleId));
      continue;
    }
    const outcome = outcomeOf(row.result);
    if (!outcome) continue;
    for (const controlId of controlsForRule({ ruleId: row.ruleId, cce: row.cce }, input.framework)) {
      let c = byControl.get(controlId);
      if (!c) {
        c = { outcomes: new Map(), rules: new Set(), failingRules: new Set(), latestScanAt: null };
        byControl.set(controlId, c);
      }
      const seen = c.outcomes.get(scan.assetId) ?? new Set<Outcome>();
      seen.add(outcome);
      c.outcomes.set(scan.assetId, seen);
      const ruleKey = normalizeRuleId(row.ruleId);
      c.rules.add(ruleKey);
      if (outcome === 'FAIL') c.failingRules.add(ruleKey);
      if (c.latestScanAt === null || scan.scannedAt > c.latestScanAt) c.latestScanAt = scan.scannedAt;
    }
  }

  const controls: VmConfigSuggestion[] = [];
  for (const [controlId, c] of byControl) {
    let failing = 0;
    let passing = 0;
    let error = 0;
    let unconfirmed = 0;
    const failingAssetIds: string[] = [];
    for (const [assetId, seen] of c.outcomes) {
      if (seen.has('FAIL')) {
        failing++;
        failingAssetIds.push(assetId);
      } else if (seen.has('ERROR')) error++;
      else passing++;
    }
    for (const id of unconfirmedIds) if (c.outcomes.has(id)) unconfirmed++;
    const evaluated = failing + passing + error;
    const suggestion: VmConfigSuggestionValue =
      failing > 0 ? 'NOT_MET' : evaluated === inScopeIds.size && passing === inScopeIds.size && inScopeIds.size > 0 ? 'MET' : 'REVIEW';
    controls.push({
      controlId,
      suggestion,
      assets: { inScope: inScopeIds.size, evaluated, failing, passing, error, unconfirmed },
      rules: { mapped: c.rules.size, failing: c.failingRules.size },
      failingAssetIds: failingAssetIds.sort(),
      latestScanAt: c.latestScanAt,
    });
  }
  controls.sort((a, b) => (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0));
  return { supported: true, controls, unmappedRuleCount: unmapped.size, ...base };
}
