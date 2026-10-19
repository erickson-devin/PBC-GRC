import type { AssetDiscoveryStatus } from '../../src/types/telemetry';
import type { VmSourceKind } from '../../src/types/vm';
import type { NormalizedHost } from './adapters/wazuh';

/**
 * Decides which asset each reported host is (docs/VULNERABILITY_MANAGEMENT.md, section 6): the agent's own id first, then the MAC
 * address, then the host name. Pure: the caller loads the candidates and applies the plan.
 */

export interface AgentAssetCandidate {
  id: string;
  hostName: string;
  macAddress: string;
  agentIds: Record<string, string>;
  discoveryStatus: AssetDiscoveryStatus;
  lastVulnSeenAt: string | null;
}

export interface AgentAssetDraft {
  agentId: string;
  hostName: string;
  ipAddress: string;
  macAddress: string;
  osProfile: string;
  notes: string;
  agentIds: Record<string, string>;
  sourceOrigin: 'AGENT_REPORT';
  discoveryStatus: 'UNCONFIRMED_DISCOVERY';
  cmmcAssetCategory: 'CONTRACTOR_RISK';
}

export interface AssetMatchPlan {
  matched: Array<{ agentId: string; assetId: string; by: 'agent_id' | 'mac' | 'hostname'; agentIds: Record<string, string> }>;
  toCreate: AgentAssetDraft[];
  skipped: Array<{ agentId: string; reason: 'asset_limit' }>;
}

/** Key of a source kind inside enclave_assets.agent_ids. */
export const kindKey = (kind: VmSourceKind): string => kind.toLowerCase();

/** Separator- and case-insensitive MAC; empty for a missing or all-zero address (which identifies nothing). */
export function normalizeMac(mac: string): string {
  const m = (mac ?? '').replace(/[:.\-\s]/g, '').toLowerCase();
  return m === '' || /^0+$/.test(m) ? '' : m;
}

const OS_PROFILE = /^[A-Za-z0-9 ._()/+-]{1,64}$/;

export function planAssetMatches(
  hosts: NormalizedHost[],
  candidates: AgentAssetCandidate[],
  kind: VmSourceKind,
  remainingCapacity: number,
): AssetMatchPlan {
  const key = kindKey(kind);
  const plan: AssetMatchPlan = { matched: [], toCreate: [], skipped: [] };
  const claimed = new Set<string>();
  const done = new Set<string>();

  const tier = (
    by: 'agent_id' | 'mac' | 'hostname',
    hostKey: (h: NormalizedHost) => string,
    candKey: (c: AgentAssetCandidate) => string,
  ) => {
    for (const h of hosts) {
      if (done.has(h.agentId)) continue;
      const k = hostKey(h);
      if (k === '') continue;
      const hits = candidates.filter((c) => candKey(c) === k);
      if (hits.length !== 1 || claimed.has(hits[0].id)) continue;
      claimed.add(hits[0].id);
      done.add(h.agentId);
      plan.matched.push({ agentId: h.agentId, assetId: hits[0].id, by, agentIds: { ...hits[0].agentIds, [key]: h.agentId } });
    }
  };

  tier('agent_id', (h) => h.agentId, (c) => c.agentIds[key] ?? '');
  tier('mac', (h) => normalizeMac(h.mac), (c) => normalizeMac(c.macAddress));
  tier('hostname', (h) => h.hostname.trim().toLowerCase(), (c) => c.hostName.trim().toLowerCase());

  const taken = new Set(candidates.map((c) => c.hostName.trim().toLowerCase()));
  let capacity = remainingCapacity;
  for (const h of hosts) {
    if (done.has(h.agentId)) continue;
    if (capacity <= 0) {
      plan.skipped.push({ agentId: h.agentId, reason: 'asset_limit' });
      continue;
    }
    capacity--;
    const base = h.hostname.trim() || `${key}-${h.agentId}`;
    let hostName = base;
    for (let n = 2; taken.has(hostName.toLowerCase()); n++) hostName = `${base}-${n}`;
    taken.add(hostName.toLowerCase());
    plan.toCreate.push({
      agentId: h.agentId,
      hostName,
      ipAddress: h.ip,
      macAddress: h.mac,
      osProfile: OS_PROFILE.test(h.osName) ? h.osName : 'custom',
      notes: `Reported by ${kind} agent ${h.agentId} (${h.osName} ${h.osVersion}). Unconfirmed: classify its CMMC category.`,
      agentIds: { [key]: h.agentId },
      sourceOrigin: 'AGENT_REPORT',
      discoveryStatus: 'UNCONFIRMED_DISCOVERY',
      cmmcAssetCategory: 'CONTRACTOR_RISK',
    });
  }
  return plan;
}
