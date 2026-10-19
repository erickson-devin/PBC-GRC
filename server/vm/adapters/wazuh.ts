import type { IngestPayload } from '../ingestSchema';
import { VM_SEVERITIES, type VmSeverity } from '../../../src/types/vm';
import { worstSeverity } from '../transitions';

/**
 * Wazuh adapter: turns a validated ingest payload into one record per host and canonical vulnerability id
 * (docs/VULNERABILITY_MANAGEMENT.md, section 6). Pure: no database, no filesystem.
 */

export interface NormalizedPackage {
  name: string;
  version: string;
  fixedVersion: string | null;
}

export interface NormalizedFinding {
  vulnId: string;
  severity: VmSeverity;
  /** The (rechecked) severity of each payload entry that was merged into this finding, in payload order. */
  reportedSeverities: VmSeverity[];
  title: string;
  cvssV3: number | null;
  detectedAt: string | null;
  publishedAt: string | null;
  refs: string[];
  packages: NormalizedPackage[];
}

export interface NormalizedHost {
  agentId: string;
  hostname: string;
  ip: string;
  mac: string;
  osName: string;
  osVersion: string;
  findings: NormalizedFinding[];
}

const MAX_REFS = 20;

/** CVE ids compare upper-case; other identifiers (vendor advisories) keep their spelling. */
export function canonicalVulnId(id: string): string {
  return /^cve-/i.test(id) ? id.toUpperCase() : id;
}

export function severityFromCvss(score: number | null | undefined): VmSeverity {
  if (typeof score !== 'number' || !(score > 0)) return 'UNKNOWN';
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  return 'LOW';
}

/** A reported severity is never overridden, except that UNKNOWN is graded from a usable CVSS score. */
export function recheckSeverity(reported: string, cvss: number | null | undefined): VmSeverity {
  if (!(VM_SEVERITIES as readonly string[]).includes(reported)) throw new Error(`Unknown severity: ${reported}`);
  const sev = reported as VmSeverity;
  if (sev === 'UNKNOWN' && typeof cvss === 'number' && cvss > 0) return severityFromCvss(cvss);
  return sev;
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function normalizeWazuh(payload: IngestPayload): NormalizedHost[] {
  return payload.hosts.map((h) => {
    const groups = new Map<string, NormalizedFinding>();
    for (const f of h.findings) {
      const vulnId = canonicalVulnId(f.vuln_id);
      const severity = recheckSeverity(f.severity, f.cvss_v3);
      const detectedAt = iso(f.detected_at);
      let g = groups.get(vulnId);
      if (!g) {
        g = {
          vulnId,
          severity,
          reportedSeverities: [],
          title: '',
          cvssV3: null,
          detectedAt: null,
          publishedAt: null,
          refs: [],
          packages: [],
        };
        groups.set(vulnId, g);
      }
      g.severity = worstSeverity(g.severity, severity);
      g.reportedSeverities.push(severity);
      if (!g.title && f.title) g.title = f.title;
      if (typeof f.cvss_v3 === 'number' && (g.cvssV3 === null || f.cvss_v3 > g.cvssV3)) g.cvssV3 = f.cvss_v3;
      if (detectedAt && (g.detectedAt === null || Date.parse(detectedAt) < Date.parse(g.detectedAt))) g.detectedAt = detectedAt;
      if (g.publishedAt === null) g.publishedAt = iso(f.published_at);
      for (const r of f.refs ?? []) {
        if (g.refs.length < MAX_REFS && !g.refs.includes(r)) g.refs.push(r);
      }
      if (f.package) {
        const version = f.package.version ?? '';
        const fixed = f.package.fixed_version ?? null;
        const known = g.packages.find((p) => p.name === f.package!.name && p.version === version);
        if (!known) g.packages.push({ name: f.package.name, version, fixedVersion: fixed });
        else if (known.fixedVersion === null) known.fixedVersion = fixed;
      }
    }
    const findings = [...groups.values()];
    for (const g of findings) g.packages.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
    return {
      agentId: h.agent_id,
      hostname: (h.hostname ?? '').trim(),
      ip: h.ip ?? '',
      mac: h.mac ?? '',
      osName: h.os?.name ?? '',
      osVersion: h.os?.version ?? '',
      findings,
    };
  });
}
