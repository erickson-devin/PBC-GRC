/**
 * Configuration rule map (issue #103): which XCCDF rule (and CCE) bears on which CMMC practice and NIST SP 800-53 control.
 * Shared by the server (suggestions, results API) and the client. It is deliberately small: a rule that is not listed
 * here is stored and shown, but it never produces a suggestion.
 *
 * Matching is exact. A rule is found by its CCE (case-insensitive), then by its rule id once the SCAP Security Guide
 * prefix is removed. There is no substring match: an empty or partial id must never land on a control.
 */

export interface ConfigRuleMapping {
  cce: string;
  /** SCAP Security Guide short id, without the xccdf_org.ssgproject.content_rule_ prefix. */
  ruleId: string;
  /** Full CMMC catalog id (domain, level and requirement), as found in the CMMC Level 1 / Level 2 catalogs. */
  controlId: string;
  /** NIST SP 800-171 requirement number. */
  requirement: string;
  /** NIST SP 800-53 Rev. 5 control id. */
  nist80053: string;
  title: string;
}

export const XCCDF_RULE_PREFIX = 'xccdf_org.ssgproject.content_rule_';

export const CONFIG_RULE_MAPPINGS: readonly ConfigRuleMapping[] = [
  // Access Control (AC)
  { cce: 'CCE-27286-4', ruleId: 'sshd_disable_root_login', controlId: 'AC.L1-3.1.1', requirement: '3.1.1', nist80053: 'AC-2', title: 'Disable SSH root login' },
  { cce: 'CCE-27407-6', ruleId: 'accounts_password_pam_minlen', controlId: 'AC.L1-3.1.1', requirement: '3.1.1', nist80053: 'AC-2', title: 'Enforce minimum password length' },
  { cce: 'CCE-80214-1', ruleId: 'no_empty_passwords', controlId: 'AC.L1-3.1.1', requirement: '3.1.1', nist80053: 'AC-2', title: 'Prevent empty passwords' },
  { cce: 'CCE-27445-6', ruleId: 'sshd_set_idle_timeout', controlId: 'AC.L2-3.1.10', requirement: '3.1.10', nist80053: 'AC-11', title: 'SSH idle session timeout' },
  { cce: 'CCE-80170-5', ruleId: 'screen_locking_enabled', controlId: 'AC.L2-3.1.10', requirement: '3.1.10', nist80053: 'AC-11', title: 'Screen lock on inactivity' },
  { cce: 'CCE-27363-1', ruleId: 'sshd_disable_x11_forwarding', controlId: 'AC.L2-3.1.12', requirement: '3.1.12', nist80053: 'AC-17', title: 'Disable X11 forwarding over SSH' },
  { cce: 'CCE-80215-8', ruleId: 'sshd_use_approved_ciphers', controlId: 'AC.L2-3.1.13', requirement: '3.1.13', nist80053: 'AC-17', title: 'Use FIPS-approved SSH ciphers' },
  { cce: 'CCE-27377-1', ruleId: 'wireless_disable_interfaces', controlId: 'AC.L2-3.1.16', requirement: '3.1.16', nist80053: 'AC-18', title: 'Disable wireless interfaces' },

  // Identification and Authentication (IA)
  { cce: 'CCE-27350-8', ruleId: 'accounts_password_pam_dcredit', controlId: 'IA.L1-3.5.1', requirement: '3.5.1', nist80053: 'IA-2', title: 'Password complexity: digit requirement' },
  { cce: 'CCE-27360-7', ruleId: 'accounts_password_pam_ucredit', controlId: 'IA.L1-3.5.1', requirement: '3.5.1', nist80053: 'IA-2', title: 'Password complexity: uppercase requirement' },
  { cce: 'CCE-27345-8', ruleId: 'accounts_password_pam_lcredit', controlId: 'IA.L1-3.5.1', requirement: '3.5.1', nist80053: 'IA-2', title: 'Password complexity: lowercase requirement' },
  { cce: 'CCE-26631-2', ruleId: 'accounts_password_pam_ocredit', controlId: 'IA.L1-3.5.1', requirement: '3.5.1', nist80053: 'IA-2', title: 'Password complexity: special character requirement' },
  { cce: 'CCE-27512-3', ruleId: 'accounts_password_pam_retry', controlId: 'IA.L2-3.5.7', requirement: '3.5.7', nist80053: 'IA-5', title: 'Limit password retries' },
  { cce: 'CCE-80221-6', ruleId: 'accounts_passwords_pam_faillock', controlId: 'IA.L2-3.5.7', requirement: '3.5.7', nist80053: 'IA-5', title: 'Account lockout after failed attempts' },

  // System and Communications Protection (SC)
  { cce: 'CCE-27557-8', ruleId: 'firewalld_enabled', controlId: 'SC.L1-3.13.1', requirement: '3.13.1', nist80053: 'SC-7', title: 'Firewall service enabled' },
  { cce: 'CCE-80157-2', ruleId: 'iptables_rules_configured', controlId: 'SC.L1-3.13.1', requirement: '3.13.1', nist80053: 'SC-7', title: 'Network boundary protection rules' },
  { cce: 'CCE-80220-8', ruleId: 'tls_version_minimum', controlId: 'SC.L2-3.13.8', requirement: '3.13.8', nist80053: 'SC-8', title: 'Enforce TLS 1.2+ minimum' },

  // System and Information Integrity (SI)
  { cce: 'CCE-26648-6', ruleId: 'ensure_antivirus_installed', controlId: 'SI.L1-3.14.2', requirement: '3.14.2', nist80053: 'SI-3', title: 'Antivirus protection installed' },
  { cce: 'CCE-27116-3', ruleId: 'aide_installed', controlId: 'SI.L1-3.14.2', requirement: '3.14.2', nist80053: 'SI-3', title: 'File integrity monitoring (AIDE) installed' },
  { cce: 'CCE-80222-4', ruleId: 'dnf_automatic_enabled', controlId: 'SI.L1-3.14.1', requirement: '3.14.1', nist80053: 'SI-2', title: 'Automatic security updates enabled' },
  { cce: 'CCE-27328-4', ruleId: 'auditd_enabled', controlId: 'AU.L2-3.3.1', requirement: '3.3.1', nist80053: 'AU-2', title: 'System audit daemon enabled' },

  // Media Protection (MP)
  { cce: 'CCE-80356-0', ruleId: 'encrypt_partitions', controlId: 'MP.L2-3.8.1', requirement: '3.8.1', nist80053: 'MP-2', title: 'Encrypt storage partitions (LUKS)' },

  // Physical Protection (PE): rarely scanner-verifiable, kept for completeness
  { cce: 'CCE-80358-6', ruleId: 'bios_boot_password', controlId: 'PE.L1-3.10.1', requirement: '3.10.1', nist80053: 'PE-2', title: 'BIOS/UEFI boot password set' },
];

const BY_CCE = new Map<string, ConfigRuleMapping>(CONFIG_RULE_MAPPINGS.map((m) => [m.cce.toUpperCase(), m]));
const BY_RULE = new Map<string, ConfigRuleMapping>(CONFIG_RULE_MAPPINGS.map((m) => [m.ruleId, m]));

/** Removes the SCAP Security Guide prefix; any other id is returned as it is. */
export function normalizeRuleId(ruleId: string): string {
  return ruleId.startsWith(XCCDF_RULE_PREFIX) ? ruleId.slice(XCCDF_RULE_PREFIX.length) : ruleId;
}

export interface ConfigRuleRef {
  ruleId: string;
  cce?: string | null;
}

/** Exact CCE first (case-insensitive), then exact normalized rule id; null when neither is in the table. */
export function mapConfigRule(rule: ConfigRuleRef): ConfigRuleMapping | null {
  if (rule.cce) {
    const byCce = BY_CCE.get(rule.cce.trim().toUpperCase());
    if (byCce) return byCce;
  }
  return BY_RULE.get(normalizeRuleId(rule.ruleId)) ?? null;
}

/**
 * The control ids a rule bears on in one framework: the CMMC catalog id for CMMC Level 1 (Level 1 practices only) and Level 2,
 * the 800-53 id for NIST SP 800-53 Rev. 5, and nothing for any other framework.
 */
export function controlsForRule(rule: ConfigRuleRef, framework: string): string[] {
  const m = mapConfigRule(rule);
  if (!m) return [];
  if (framework === 'CMMC_L2') return [m.controlId];
  if (framework === 'CMMC_L1') return m.controlId.includes('.L1-') ? [m.controlId] : [];
  if (framework === 'NIST_800_53_REV5') return [m.nist80053];
  return [];
}
