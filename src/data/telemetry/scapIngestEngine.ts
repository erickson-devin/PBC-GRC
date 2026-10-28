/**
 * Event Horizon: Singularity — Photon SCAP-to-GRC Ingestion Engine
 *
 * Maps incoming OpenSCAP / DISA STIG CCE rule evaluation results to their
 * corresponding CMMC Level 1/2 and NIST SP 800-171 requirement IDs, then
 * automatically propagates compliance status into the AssessmentContext,
 * appends a verified evidence item to the EvidenceVault, and records an
 * immutable SHA-256 chained audit entry marking automated telemetry ingestion.
 */

import {
  ScapScanReport,
  ScapRuleMapping,
  ScapRuleResult,
} from '../../types/telemetry';
import { ControlStatus, EvidenceItem } from '../../types/cmmc';
import { AuditActionType } from '../../types/audit';
import { recordAuditEvent, computeSha256, describeAddressForLedger, describeNotesForLedger } from '../audit/auditLogger';

// ---------------------------------------------------------------------------
// 1. CCE → GRC Control Mapping Table
//    Maps Common Configuration Enumeration IDs (from OpenSCAP benchmarks)
//    to their CMMC and NIST SP 800-171 equivalents.
// ---------------------------------------------------------------------------

export const SCAP_RULE_MAPPINGS: ScapRuleMapping[] = [
  // ── Access Control (AC) ──
  { cceId: 'CCE-27286-4', ruleId: 'sshd_disable_root_login',           cmmcControlId: '3.1.1',  nistControlId: 'AC-2',  title: 'Disable SSH root login' },
  { cceId: 'CCE-27407-6', ruleId: 'accounts_password_pam_minlen',      cmmcControlId: '3.1.1',  nistControlId: 'AC-2',  title: 'Enforce minimum password length' },
  { cceId: 'CCE-80214-1', ruleId: 'no_empty_passwords',                cmmcControlId: '3.1.1',  nistControlId: 'AC-2',  title: 'Prevent empty passwords' },
  { cceId: 'CCE-27445-6', ruleId: 'sshd_set_idle_timeout',             cmmcControlId: '3.1.10', nistControlId: 'AC-11', title: 'SSH idle session timeout' },
  { cceId: 'CCE-80170-5', ruleId: 'screen_locking_enabled',            cmmcControlId: '3.1.10', nistControlId: 'AC-11', title: 'Screen lock on inactivity' },
  { cceId: 'CCE-27363-1', ruleId: 'sshd_disable_x11_forwarding',      cmmcControlId: '3.1.12', nistControlId: 'AC-17', title: 'Disable X11 forwarding over SSH' },
  { cceId: 'CCE-80215-8', ruleId: 'sshd_use_approved_ciphers',         cmmcControlId: '3.1.13', nistControlId: 'AC-17', title: 'Use FIPS-approved SSH ciphers' },
  { cceId: 'CCE-27377-1', ruleId: 'wireless_disable_interfaces',       cmmcControlId: '3.1.16', nistControlId: 'AC-18', title: 'Disable wireless interfaces' },

  // ── Identification & Authentication (IA) ──
  { cceId: 'CCE-27350-8', ruleId: 'accounts_password_pam_dcredit',     cmmcControlId: '3.5.1',  nistControlId: 'IA-2',  title: 'Password complexity: digit requirement' },
  { cceId: 'CCE-27360-7', ruleId: 'accounts_password_pam_ucredit',     cmmcControlId: '3.5.1',  nistControlId: 'IA-2',  title: 'Password complexity: uppercase requirement' },
  { cceId: 'CCE-27345-8', ruleId: 'accounts_password_pam_lcredit',     cmmcControlId: '3.5.1',  nistControlId: 'IA-2',  title: 'Password complexity: lowercase requirement' },
  { cceId: 'CCE-26631-2', ruleId: 'accounts_password_pam_ocredit',     cmmcControlId: '3.5.1',  nistControlId: 'IA-2',  title: 'Password complexity: special character requirement' },
  { cceId: 'CCE-27512-3', ruleId: 'accounts_password_pam_retry',       cmmcControlId: '3.5.7',  nistControlId: 'IA-5',  title: 'Limit password retries' },
  { cceId: 'CCE-80221-6', ruleId: 'accounts_passwords_pam_faillock',   cmmcControlId: '3.5.7',  nistControlId: 'IA-5',  title: 'Account lockout after failed attempts' },

  // ── System & Communications Protection (SC) ──
  { cceId: 'CCE-27557-8', ruleId: 'firewalld_enabled',                 cmmcControlId: '3.13.1', nistControlId: 'SC-7',  title: 'Firewall service enabled' },
  { cceId: 'CCE-80157-2', ruleId: 'iptables_rules_configured',         cmmcControlId: '3.13.1', nistControlId: 'SC-7',  title: 'Network boundary protection rules' },
  { cceId: 'CCE-80220-8', ruleId: 'tls_version_minimum',               cmmcControlId: '3.13.8', nistControlId: 'SC-8',  title: 'Enforce TLS 1.2+ minimum' },

  // ── System & Information Integrity (SI) ──
  { cceId: 'CCE-26648-6', ruleId: 'ensure_antivirus_installed',        cmmcControlId: '3.14.2', nistControlId: 'SI-3',  title: 'Antivirus protection installed' },
  { cceId: 'CCE-27116-3', ruleId: 'aide_installed',                    cmmcControlId: '3.14.2', nistControlId: 'SI-3',  title: 'File integrity monitoring (AIDE) installed' },
  { cceId: 'CCE-80222-4', ruleId: 'dnf_automatic_enabled',             cmmcControlId: '3.14.1', nistControlId: 'SI-2',  title: 'Automatic security updates enabled' },
  { cceId: 'CCE-27328-4', ruleId: 'auditd_enabled',                    cmmcControlId: '3.3.1',  nistControlId: 'AU-2',  title: 'System audit daemon enabled' },

  // ── Media Protection (MP) ──
  { cceId: 'CCE-80356-0', ruleId: 'encrypt_partitions',                cmmcControlId: '3.8.1',  nistControlId: 'MP-2',  title: 'Encrypt storage partitions (LUKS)' },

  // ── Physical Protection (PE) — typically not scanner-verifiable but included for completeness ──
  { cceId: 'CCE-80358-6', ruleId: 'bios_boot_password',                cmmcControlId: '3.10.1', nistControlId: 'PE-2',  title: 'BIOS/UEFI boot password set' },
];

// ---------------------------------------------------------------------------
// 2. Lookup helpers
// ---------------------------------------------------------------------------

/** Build a lookup map from CCE ID → mapping record */
const cceIndex = new Map<string, ScapRuleMapping>(
  SCAP_RULE_MAPPINGS.map(m => [m.cceId, m])
);

/** Build a lookup map from ruleId (partial match key) → mapping record */
const ruleIdIndex = new Map<string, ScapRuleMapping>(
  SCAP_RULE_MAPPINGS.map(m => [m.ruleId, m])
);

/**
 * Resolves the CMMC control ID (e.g. "AC.L1-3.1.1") from a CCE or rule ID.
 * Falls back to partial ruleId substring matching if CCE lookup misses.
 */
export function resolveControlId(cceId: string, ruleId: string): string | null {
  // Try direct CCE lookup first
  const byHcce = cceIndex.get(cceId);
  if (byHcce) return byHcce.cmmcControlId;

  // Fallback: try ruleId key match
  const byRule = ruleIdIndex.get(ruleId);
  if (byRule) return byRule.cmmcControlId;

  // Fallback: partial substring on ruleId
  for (const [key, mapping] of ruleIdIndex) {
    if (ruleId.includes(key) || key.includes(ruleId)) {
      return mapping.cmmcControlId;
    }
  }

  return null;
}

/**
 * Maps a CMMC numeric requirement ID (e.g. "3.1.1") to the framework's
 * control ID format used in AssessmentContext (e.g. "AC.L1-3.1.1").
 */
export function cmmcIdToControlKey(cmmcId: string): string {
  const domainMap: Record<string, string> = {
    '3.1':  'AC',   // Access Control
    '3.3':  'AU',   // Audit & Accountability
    '3.5':  'IA',   // Identification & Authentication
    '3.8':  'MP',   // Media Protection
    '3.10': 'PE',   // Physical Protection
    '3.13': 'SC',   // System & Communications Protection
    '3.14': 'SI',   // System & Information Integrity
  };

  // Extract domain prefix from cmmcId like "3.1.1" → "3.1"
  const parts = cmmcId.split('.');
  const prefix = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : cmmcId;
  const domain = domainMap[prefix] || 'AC';

  return `${domain}.L1-${cmmcId}`;
}

// ---------------------------------------------------------------------------
// 3. Status Resolution Logic
// ---------------------------------------------------------------------------

/**
 * Determines the new ControlStatus based on aggregated SCAP rule results
 * for a given CMMC control. If all mapped rules pass, the control is MET.
 * If any fail, it's IN_PROGRESS (partial). If all error, it stays NOT_MET.
 */
export function resolveControlStatus(
  ruleResults: ScapRuleResult[]
): ControlStatus {
  if (ruleResults.length === 0) return 'NOT_STARTED';

  const passCount = ruleResults.filter(r => r.status === 'PASS').length;
  const failCount = ruleResults.filter(r => r.status === 'FAIL').length;
  const errorCount = ruleResults.filter(r => r.status === 'ERROR').length;

  if (passCount === ruleResults.length) return 'MET';
  if (failCount > 0 || (passCount > 0 && errorCount > 0)) return 'IN_PROGRESS';
  return 'NOT_MET';
}

// ---------------------------------------------------------------------------
// 4. Primary Ingestion Function
// ---------------------------------------------------------------------------

export interface IngestResult {
  /** Number of controls whose status was updated */
  controlsUpdated: number;
  /** Map of controlId → new status */
  statusChanges: Record<string, ControlStatus>;
  /** Evidence item appended to the vault */
  evidenceItem: EvidenceItem;
  /** SHA-256 audit hash for the ingestion event */
  auditHash: string;
  /** Summary of pass/fail counts */
  summary: {
    totalRules: number;
    passed: number;
    failed: number;
    errors: number;
    unmapped: number;
  };
}

/**
 * Ingests an OpenSCAP scan report into the GRC platform:
 * 1. Maps CCE/rule IDs → CMMC/NIST controls
 * 2. Updates control statuses in the assessment state
 * 3. Appends the raw scan as a JSON evidence item
 * 4. Records an immutable SHA-256 chained audit log entry
 *
 * @param report - The SCAP scan report to ingest
 * @param updateControlStatus - Callback to update a control's status in AssessmentContext
 * @param addEvidence - Callback to add evidence to the state's evidenceIndex
 * @param tenantId - Active tenant ID for audit partitioning
 * @param actorEmail - Email of the user/system triggering the ingestion
 * @returns IngestResult with all changes applied
 */
export async function ingestScapScanReport(
  report: ScapScanReport,
  updateControlStatus: (controlId: string, status: ControlStatus) => void,
  addEvidence: (item: EvidenceItem) => void,
  tenantId: string,
  actorEmail: string = 'photon-scanner@singularity.local'
): Promise<IngestResult> {
  // 4a. Group rule results by resolved CMMC control ID
  const controlBuckets = new Map<string, ScapRuleResult[]>();
  let unmappedCount = 0;

  for (const result of report.results) {
    const cmmcId = resolveControlId(result.cceId, result.ruleId);
    if (!cmmcId) {
      unmappedCount++;
      continue;
    }

    const controlKey = cmmcIdToControlKey(cmmcId);
    if (!controlBuckets.has(controlKey)) {
      controlBuckets.set(controlKey, []);
    }
    controlBuckets.get(controlKey)!.push(result);
  }

  // 4b. Determine new status for each mapped control and apply updates
  const statusChanges: Record<string, ControlStatus> = {};

  for (const [controlId, results] of controlBuckets) {
    const newStatus = resolveControlStatus(results);
    statusChanges[controlId] = newStatus;
    updateControlStatus(controlId, newStatus);
  }

  // 4c. Serialize scan report as a verified JSON evidence artifact
  const reportJson = JSON.stringify(report, null, 2);
  const reportHash = await computeSha256(reportJson);

  const evidenceItem: EvidenceItem = {
    id: `ev_scap_${report.scanId}_${Date.now()}`,
    tenantId,
    controlId: 'SCAP_TELEMETRY',
    name: `SCAP_Scan_${report.hostName}_${report.timestamp.replace(/[:.]/g, '-')}.json`,
    fileSize: new Blob([reportJson]).size,
    mimeType: 'application/json',
    uploadedAt: new Date().toISOString(),
    description: `Automated OpenSCAP scan report from ${report.hostName} (${report.targetIp}) — ${report.passedCount} PASS / ${report.failedCount} FAIL across ${report.results.length} rules. OS Profile: ${report.osProfile}. Scanner: ${report.scapVersion}.`,
    hasBlob: false,
    fileHash: reportHash,
    syncStatus: 'local_cached',
    uploadedBy: 'Photon SCAP Engine',
  };

  addEvidence(evidenceItem);

  // 4d. Record immutable SHA-256 chained audit entry
  const auditEntry = await recordAuditEvent({
    tenantId,
    actorId: 'photon-engine',
    actorEmail,
    actorRole: 'Automated Scanner',
    actionType: 'EVIDENCE_UPLOADED' as AuditActionType,
    targetEntity: `SCAP Scan: ${report.scanId}`,
    newState: {
      scanId: report.scanId,
      hostName: await describeNotesForLedger(report.hostName),
      targetIp: await describeAddressForLedger(report.targetIp),
      osProfile: report.osProfile,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      totalRules: report.results.length,
      controlsUpdated: Object.keys(statusChanges).length,
      evidenceHash: reportHash,
    },
    metadata: {
      source: 'photon-scap-ingest-engine',
      scapVersion: report.scapVersion,
      automatedIngestion: true,
    },
  });

  return {
    controlsUpdated: Object.keys(statusChanges).length,
    statusChanges,
    evidenceItem,
    auditHash: auditEntry.sha256Hash,
    summary: {
      totalRules: report.results.length,
      passed: report.passedCount,
      failed: report.failedCount,
      errors: report.results.filter(r => r.status === 'ERROR').length,
      unmapped: unmappedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Simulated Test Scan Generator (for demo/sandbox mode)
// ---------------------------------------------------------------------------

/**
 * Generates a realistic simulated SCAP scan report for demo/testing.
 * Uses real CCE IDs from the mapping table and randomizes pass/fail outcomes.
 */
export function generateSimulatedScanReport(
  tenantId: string,
  hostName: string = 'enclave-node-01',
  targetIp: string = '10.0.50.12',
  osProfile: string = 'rhel9'
): ScapScanReport {
  const results: ScapRuleResult[] = SCAP_RULE_MAPPINGS.map(mapping => {
    // 75% pass rate for realistic simulation
    const rand = Math.random();
    const status = rand < 0.75 ? 'PASS' : rand < 0.92 ? 'FAIL' : 'ERROR';

    return {
      ruleId: mapping.ruleId,
      cceId: mapping.cceId,
      title: mapping.title,
      status: status as 'PASS' | 'FAIL' | 'ERROR',
      severity: (['CAT_I', 'CAT_II', 'CAT_III'] as const)[Math.floor(Math.random() * 3)],
      stigId: `V-${254000 + Math.floor(Math.random() * 999)}`,
      output: status === 'PASS'
        ? `[OK] Rule ${mapping.ruleId} evaluated successfully. All checks passed.`
        : status === 'FAIL'
        ? `[FAIL] Rule ${mapping.ruleId}: Expected configuration not found. Current value does not meet DISA STIG baseline.`
        : `[ERROR] Rule ${mapping.ruleId}: Unable to evaluate — permission denied or target unreachable.`,
    };
  });

  const passedCount = results.filter(r => r.status === 'PASS').length;
  const failedCount = results.filter(r => r.status === 'FAIL').length;

  return {
    scanId: `scan_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    tenantId,
    hostName,
    targetIp,
    osProfile,
    timestamp: new Date().toISOString(),
    scapVersion: 'OpenSCAP 1.3.9 / SCAP Security Guide 0.1.73',
    passedCount,
    failedCount,
    results,
  };
}
