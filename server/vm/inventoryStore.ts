import type pg from 'pg';
import { getDbMode } from '../db';
import type { VmObservedHost, VmObservedSoftware, VmSourceKind } from '../../src/types/vm';
import type { NormalizedInventory, NormalizedSoftwareItem } from './inventory';
import { withVmTenantTx } from './findingsStore';
import { listSources } from './store';

/**
 * Persistence of the host inventory the scanners report (docs/VULNERABILITY_MANAGEMENT.md, section 5.6): PostgreSQL (the worker's tenant
 * transaction, via withVmTenantTx) or process memory when DB_MODE=memory. Only the CURRENT view of a host from one source is kept: each run
 * that reports a host replaces its hardware and package list, keeping the first-seen time of every package that is still there. A report
 * older than the stored one is ignored. Nothing here writes an asset; the worker does that through server/assets.ts.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Rows per multi-row INSERT: keeps every statement far below the 65535 bind-parameter limit. */
const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const placeholders = (rows: number, width: number): string =>
  Array.from({ length: rows }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`).join(',');

interface MemoryHost {
  tenantId: string;
  assetId: string;
  sourceId: string;
  agentId: string;
  hostname: string;
  ipAddress: string;
  macAddress: string;
  os: { name: string; version: string; platform: string; kernel: string };
  hardware: NonNullable<VmObservedHost['hardware']> | null;
  softwareReported: boolean;
  softwareCount: number;
  collectedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRunId: string;
}
interface MemorySoftware extends NormalizedSoftwareItem {
  firstSeenAt: string;
  lastSeenAt: string;
}

const hostKey = (tenantId: string, assetId: string, sourceId: string): string => JSON.stringify([tenantId, assetId, sourceId]);
const itemKey = (s: { name: string; version: string; architecture: string }): string => JSON.stringify([s.name, s.version, s.architecture]);

const memoryHosts = new Map<string, MemoryHost>(); // key: tenant, asset, source
const memorySoftware = new Map<string, Map<string, MemorySoftware>>(); // key as memoryHosts, then name|version|architecture

/** Test hook. */
export function __resetVmInventoryForTests(): void {
  memoryHosts.clear();
  memorySoftware.clear();
}

function need(client: pg.PoolClient | null): pg.PoolClient {
  if (!client) throw new Error('A PostgreSQL client is required outside memory mode');
  return client;
}

export interface HostInventoryDraft {
  assetId: string;
  agentId: string;
  hostname: string;
  inv: NormalizedInventory;
}

// ------------------------------------------------------------------------------------------------ writing

/**
 * Stores what a run reported about its hosts, replacing the source's earlier view of each. Runs inside the worker's transaction (the client
 * is null in memory mode). A host whose stored view is newer than `collectedAt` is left alone (an older run reprocessed late must not roll the
 * view back). Hardware is replaced only when the host sent hardware, the package list only when it sent one. Returns the number of
 * software items stored.
 */
export async function replaceHostInventory(
  tenantId: string,
  run: { id: string; sourceId: string },
  collectedAt: string,
  drafts: HostInventoryDraft[],
  client: pg.PoolClient | null,
): Promise<number> {
  const seen = new Set<string>();
  const unique = drafts.filter((d) => (seen.has(d.assetId) ? false : (seen.add(d.assetId), true)));
  const at = new Date(collectedAt).toISOString();
  let stored = 0;

  if (isMemory()) {
    for (const d of unique) {
      const key = hostKey(tenantId, d.assetId, run.sourceId);
      const prev = memoryHosts.get(key);
      if (prev && Date.parse(prev.collectedAt) > Date.parse(at)) continue;
      const hw = d.inv.hardware;
      memoryHosts.set(key, {
        tenantId,
        assetId: d.assetId,
        sourceId: run.sourceId,
        agentId: d.agentId,
        hostname: d.hostname,
        ipAddress: d.inv.ip,
        macAddress: d.inv.mac,
        os: { ...d.inv.os },
        hardware: hw ? { ...hw } : (prev?.hardware ?? null),
        softwareReported: d.inv.software !== null || (prev?.softwareReported ?? false),
        softwareCount: d.inv.software !== null ? d.inv.software.length : (prev?.softwareCount ?? 0),
        collectedAt: at,
        firstSeenAt: prev?.firstSeenAt ?? at,
        lastSeenAt: at,
        lastRunId: run.id,
      });
      if (d.inv.software !== null) {
        const before = memorySoftware.get(key) ?? new Map<string, MemorySoftware>();
        const next = new Map<string, MemorySoftware>();
        for (const s of d.inv.software) next.set(itemKey(s), { ...s, firstSeenAt: before.get(itemKey(s))?.firstSeenAt ?? at, lastSeenAt: at });
        memorySoftware.set(key, next);
        stored += d.inv.software.length;
      }
    }
    return stored;
  }

  const c = need(client);
  for (const d of unique) {
    const hw = d.inv.hardware;
    const sw = d.inv.software;
    const upsert = await c.query(
      `INSERT INTO vm_host_inventory
         (tenant_id, asset_id, source_id, agent_id, hostname, ip_address, mac_address, os_name, os_version, os_platform, os_kernel,
          architecture, cpu_name, cpu_cores, cpu_mhz, memory_bytes, serial_number, hardware_reported, software_reported, software_count,
          collected_at, first_seen_at, last_seen_at, last_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$21,$22)
       ON CONFLICT (tenant_id, asset_id, source_id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         hostname = EXCLUDED.hostname,
         ip_address = EXCLUDED.ip_address,
         mac_address = EXCLUDED.mac_address,
         os_name = EXCLUDED.os_name,
         os_version = EXCLUDED.os_version,
         os_platform = EXCLUDED.os_platform,
         os_kernel = EXCLUDED.os_kernel,
         architecture = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.architecture ELSE vm_host_inventory.architecture END,
         cpu_name = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.cpu_name ELSE vm_host_inventory.cpu_name END,
         cpu_cores = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.cpu_cores ELSE vm_host_inventory.cpu_cores END,
         cpu_mhz = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.cpu_mhz ELSE vm_host_inventory.cpu_mhz END,
         memory_bytes = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.memory_bytes ELSE vm_host_inventory.memory_bytes END,
         serial_number = CASE WHEN EXCLUDED.hardware_reported THEN EXCLUDED.serial_number ELSE vm_host_inventory.serial_number END,
         hardware_reported = vm_host_inventory.hardware_reported OR EXCLUDED.hardware_reported,
         software_reported = vm_host_inventory.software_reported OR EXCLUDED.software_reported,
         software_count = CASE WHEN EXCLUDED.software_reported THEN EXCLUDED.software_count ELSE vm_host_inventory.software_count END,
         collected_at = EXCLUDED.collected_at,
         last_seen_at = EXCLUDED.last_seen_at,
         last_run_id = EXCLUDED.last_run_id
       WHERE vm_host_inventory.collected_at <= EXCLUDED.collected_at
       RETURNING 1`,
      [
        tenantId, d.assetId, run.sourceId, d.agentId, d.hostname, d.inv.ip, d.inv.mac, d.inv.os.name, d.inv.os.version, d.inv.os.platform,
        d.inv.os.kernel, hw?.architecture ?? '', hw?.cpuName ?? '', hw?.cpuCores ?? null, hw?.cpuMhz ?? null, hw?.memoryBytes ?? null,
        hw?.serialNumber ?? '', hw !== null, sw !== null, sw?.length ?? 0, at, run.id,
      ],
    );
    if (upsert.rowCount === 0 || sw === null) continue; // a newer view is stored, or no package list was sent
    const old = await c.query(
      'SELECT name, version, architecture, first_seen_at FROM vm_host_software WHERE tenant_id = $1 AND asset_id = $2 AND source_id = $3',
      [tenantId, d.assetId, run.sourceId],
    );
    const firstSeen = new Map<string, string>();
    for (const r of old.rows) firstSeen.set(itemKey(r), new Date(r.first_seen_at).toISOString());
    await c.query('DELETE FROM vm_host_software WHERE tenant_id = $1 AND asset_id = $2 AND source_id = $3', [tenantId, d.assetId, run.sourceId]);
    for (const part of chunks(sw)) {
      await c.query(
        `INSERT INTO vm_host_software (tenant_id, asset_id, source_id, name, version, architecture, vendor, type, installed_at, first_seen_at, last_seen_at)
         VALUES ${placeholders(part.length, 11)}`,
        part.flatMap((s) => [tenantId, d.assetId, run.sourceId, s.name, s.version, s.architecture, s.vendor, s.type, s.installedAt, firstSeen.get(itemKey(s)) ?? at, at]),
      );
    }
    stored += sw.length;
  }
  return stored;
}

// ------------------------------------------------------------------------------------------------ reading

function memoryToObserved(h: MemoryHost, kinds: Map<string, { kind: VmSourceKind; label: string }>): VmObservedHost {
  const src = kinds.get(h.sourceId);
  return {
    sourceId: h.sourceId,
    sourceKind: src?.kind ?? 'WAZUH',
    sourceLabel: src?.label ?? '',
    hostname: h.hostname,
    ipAddress: h.ipAddress,
    macAddress: h.macAddress,
    os: { ...h.os },
    hardware: h.hardware ? { ...h.hardware } : null,
    softwareReported: h.softwareReported,
    softwareCount: h.softwareCount,
    collectedAt: h.collectedAt,
    firstSeenAt: h.firstSeenAt,
    lastSeenAt: h.lastSeenAt,
  };
}

function rowToObserved(r: pg.QueryResultRow): VmObservedHost {
  const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    sourceId: r.source_id,
    sourceKind: r.source_kind as VmSourceKind,
    sourceLabel: r.source_label ?? '',
    hostname: r.hostname ?? '',
    ipAddress: r.ip_address ?? '',
    macAddress: r.mac_address ?? '',
    os: { name: r.os_name ?? '', version: r.os_version ?? '', platform: r.os_platform ?? '', kernel: r.os_kernel ?? '' },
    hardware: r.hardware_reported
      ? {
          architecture: r.architecture ?? '',
          cpuName: r.cpu_name ?? '',
          cpuCores: int(r.cpu_cores),
          cpuMhz: int(r.cpu_mhz),
          memoryBytes: int(r.memory_bytes), // BIGINT arrives as a string; the contract caps it at 2^53 - 1
          serialNumber: r.serial_number ?? '',
        }
      : null,
    softwareReported: r.software_reported === true,
    softwareCount: Number(r.software_count ?? 0),
    collectedAt: iso(r.collected_at) as string,
    firstSeenAt: iso(r.first_seen_at) as string,
    lastSeenAt: iso(r.last_seen_at) as string,
  };
}

const newestFirst = (a: VmObservedHost, b: VmObservedHost): number =>
  Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** What each source currently reports about the asset, most recently seen first. */
export async function getObservedHosts(tenantId: string, assetId: string): Promise<VmObservedHost[]> {
  if (isMemory()) {
    const sources = new Map((await listSources(tenantId)).map((s) => [s.id, { kind: s.kind, label: s.label }]));
    return [...memoryHosts.values()]
      .filter((h) => h.tenantId === tenantId && h.assetId === assetId)
      .map((h) => memoryToObserved(h, sources))
      .sort(newestFirst);
  }
  return withVmTenantTx(tenantId, async (client) => {
    const { rows } = await need(client).query(
      `SELECT i.*, s.kind AS source_kind, s.label AS source_label
         FROM vm_host_inventory i
         JOIN vm_sources s ON s.tenant_id = i.tenant_id AND s.id = i.source_id
        WHERE i.tenant_id = $1 AND i.asset_id = $2
        ORDER BY i.last_seen_at DESC, i.source_id`,
      [tenantId, assetId],
    );
    return rows.map(rowToObserved);
  });
}

export interface ObservedSoftwareFilter {
  sourceId?: string;
  limit: number;
}

/** The packages the sources report for the asset, by name then version. `totalCount` is the size of the filtered set before the limit. */
export async function listObservedSoftware(
  tenantId: string,
  assetId: string,
  f: ObservedSoftwareFilter,
): Promise<{ totalCount: number; items: VmObservedSoftware[] }> {
  if (isMemory()) {
    const all: VmObservedSoftware[] = [];
    for (const [key, items] of memorySoftware) {
      const h = memoryHosts.get(key);
      if (!h || h.tenantId !== tenantId || h.assetId !== assetId || (f.sourceId && h.sourceId !== f.sourceId)) continue;
      for (const s of items.values()) {
        all.push({ sourceId: h.sourceId, name: s.name, version: s.version, vendor: s.vendor, architecture: s.architecture, type: s.type, installedAt: s.installedAt, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt });
      }
    }
    all.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
    });
    return { totalCount: all.length, items: all.slice(0, f.limit) };
  }
  return withVmTenantTx(tenantId, async (client) => {
    const params: unknown[] = [tenantId, assetId];
    let where = 'tenant_id = $1 AND asset_id = $2';
    if (f.sourceId) {
      params.push(f.sourceId);
      where += ` AND source_id = $${params.length}`;
    }
    const c = need(client);
    const count = await c.query(`SELECT count(*)::int AS n FROM vm_host_software WHERE ${where}`, params);
    params.push(f.limit);
    const { rows } = await c.query(
      `SELECT * FROM vm_host_software WHERE ${where} ORDER BY lower(name), version, source_id, architecture LIMIT $${params.length}`,
      params,
    );
    return {
      totalCount: Number(count.rows[0]?.n ?? 0),
      items: rows.map((r) => ({
        sourceId: r.source_id,
        name: r.name,
        version: r.version ?? '',
        vendor: r.vendor ?? '',
        architecture: r.architecture ?? '',
        type: r.type ?? '',
        installedAt: iso(r.installed_at),
        firstSeenAt: iso(r.first_seen_at) as string,
        lastSeenAt: iso(r.last_seen_at) as string,
      })),
    };
  });
}
