/**
 * NIST SP 800-171A Assessment Objectives Registry & Pre-Filled Best-Practice Narrative Templates
 * 
 * Provides official determination statements [a], [b], [c]... from NIST SP 800-171A
 * ("Assessing Security Requirements for Controlled Unclassified Information") alongside
 * DoD CMMC Level 2 audit-ready pre-filled implementation narratives tailored for
 * Microsoft 365 GCC High / **Entra ID**, **Microsoft Intune**, **Active Directory**, **DISA STIG**s, and Linux baselines.
 */

import { AssessmentObjective, ObjectiveStatus, ControlObjectiveRollup } from '../../types/assessment';
import { nist80053ObjectiveTemplate } from './nist80053/objectives';

export interface ObjectiveDefinitionTemplate {
  letter: string;
  text: string;
  prefilledTemplate: string;
  scapRuleId?: string;
  isAutoVerifiedByTelemetry?: boolean;
  odpParameters?: { id: string; label: string; defaultValue: string; currentValue?: string }[];
}

export interface ControlObjectivesTemplate {
  controlNumber: string; // e.g. "3.1.1"
  family: string;        // e.g. "AC"
  title: string;
  objectives: ObjectiveDefinitionTemplate[];
}

/**
 * Normalizes any control ID (e.g. 'AC.L2-3.1.1', 'AC.L1-3.1.1', 'AC.L1-b.1.i', '3.1.1')
 */
export function normalizeControlNumber(controlId: string): string {
  if (!controlId) return '';
  const trimmed = controlId.trim();

  // Check FAR pattern like AC.L1-b.1.i -> b.1.i
  const farMatch = trimmed.match(/[A-Z]{2}\.L1-(b\.\d+\.[a-z]+)/i);
  if (farMatch) return farMatch[1].toLowerCase();

  // Check 800-171 pattern like AC.L1-3.1.1 or AC.L2-3.1.1 -> 3.1.1
  const match = trimmed.match(/(?:[A-Z]{2}\.L[12]-)?(\d+\.\d+\.\d+)/);
  if (match) return match[1];

  return trimmed.replace(/^[A-Z]{2}\.L[12]-/, '');
}

/**
 * Mapping between FAR 52.204-21 clause identifiers, CMMC Level 1 control IDs, and NIST SP 800-171 numbers
 */
export const FAR_L1_TO_800_171_MAP: Record<string, string> = {
  // Access Control (AC)
  'ac.l1-b.1.i': 'AC.L1-b.1.i',
  'b.1.i': 'AC.L1-b.1.i',
  'ac.l1-3.1.1': 'AC.L1-b.1.i',
  'ac.l1-b.1.ii': 'AC.L1-b.1.ii',
  'b.1.ii': 'AC.L1-b.1.ii',
  'ac.l1-3.1.2': 'AC.L1-b.1.ii',
  'ac.l1-b.1.iii': 'AC.L1-b.1.iii',
  'b.1.iii': 'AC.L1-b.1.iii',
  'ac.l1-3.1.20': 'AC.L1-b.1.iii',
  'ac.l1-b.1.iv': 'AC.L1-b.1.iv',
  'b.1.iv': 'AC.L1-b.1.iv',
  'ac.l1-3.1.22': 'AC.L1-b.1.iv',

  // Identification & Authentication (IA)
  'ia.l1-b.1.v': 'IA.L1-b.1.v',
  'b.1.v': 'IA.L1-b.1.v',
  'ia.l1-3.5.1': 'IA.L1-b.1.v',
  'ia.l1-b.1.vi': 'IA.L1-b.1.vi',
  'b.1.vi': 'IA.L1-b.1.vi',
  'ia.l1-3.5.2': 'IA.L1-b.1.vi',

  // Media Protection (MP)
  'mp.l1-b.1.vii': 'MP.L1-b.1.vii',
  'b.1.vii': 'MP.L1-b.1.vii',
  'mp.l1-3.8.3': 'MP.L1-b.1.vii',

  // Physical Protection (PE)
  'pe.l1-b.1.viii': 'PE.L1-b.1.viii',
  'b.1.viii': 'PE.L1-b.1.viii',
  'pe.l1-3.10.1': 'PE.L1-b.1.viii',
  'pe.l1-b.1.ix': 'PE.L1-b.1.ix',
  'b.1.ix': 'PE.L1-b.1.ix',
  'pe.l1-3.10.3': '3.10.3',
  '3.10.3': '3.10.3',
  'pe.l1-3.10.4': '3.10.4',
  '3.10.4': '3.10.4',
  'pe.l1-3.10.5': '3.10.5',
  '3.10.5': '3.10.5',

  // System & Communications Protection (SC)
  'sc.l1-b.1.x': 'SC.L1-b.1.x',
  'b.1.x': 'SC.L1-b.1.x',
  'sc.l1-3.13.1': 'SC.L1-b.1.x',
  'sc.l1-b.1.xi': 'SC.L1-b.1.xi',
  'b.1.xi': 'SC.L1-b.1.xi',
  'sc.l1-3.13.5': 'SC.L1-b.1.xi',
  '3.13.5': 'SC.L1-b.1.xi',

  // System & Information Integrity (SI)
  'si.l1-b.1.xii': 'SI.L1-b.1.xii',
  'b.1.xii': 'SI.L1-b.1.xii',
  'si.l1-3.14.1': 'SI.L1-b.1.xii',
  'si.l1-b.1.xiii': 'SI.L1-b.1.xiii',
  'b.1.xiii': 'SI.L1-b.1.xiii',
  'si.l1-3.14.2': 'SI.L1-b.1.xiii',
  'si.l1-b.1.xiv': 'SI.L1-b.1.xiv',
  'b.1.xiv': 'SI.L1-b.1.xiv',
  'si.l1-3.14.4': 'SI.L1-b.1.xiv',
  '3.14.4': 'SI.L1-b.1.xiv',
  'si.l1-b.1.xv': 'SI.L1-b.1.xv',
  'b.1.xv': 'SI.L1-b.1.xv',
  'si.l1-3.14.5': 'SI.L1-b.1.xv',
  '3.14.5': 'SI.L1-b.1.xv',
};

/**
 * NIST SP 800-171A Determination Statement Registry
 */
export const NIST_800_171A_REGISTRY: Record<string, ControlObjectivesTemplate> = {
  // ──────────────────────────────────────────────────────────────────────────
  // ACCESS CONTROL (AC)
  // ──────────────────────────────────────────────────────────────────────────
  '3.1.1': {
    controlNumber: '3.1.1',
    family: 'AC',
    title: 'Authorized System Access',
    objectives: [
      {
        letter: 'a',
        text: 'authorized users are identified',
        prefilledTemplate: 'Authorized enclave users are uniquely identified via **Microsoft Entra ID** (Azure AD P2) and local **Active Directory** Domain Services. Each user is assigned an individual User Principal Name (UPN) formatted as username@defense.company.com following formal HR onboarding and security clearance sponsorship. Shared, guest, or anonymous accounts are strictly prohibited.',
        scapRuleId: 'accounts_password_pam_minlen',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'processes acting on behalf of authorized users are identified',
        prefilledTemplate: 'Automated processes and service accounts executing on behalf of users are identified via Managed Service Accounts (gMSAs) and **Entra ID** Service Principals with defined certificate-based authentication and restricted API permission grants documented in the Enclave IAM Register.',
        isAutoVerifiedByTelemetry: false,
        odpParameters: [{ id: 'ac_3_1_8_window', label: 'Observation Window', defaultValue: '15 minutes' }],
      },
      {
        letter: 'c',
        text: 'devices (and other systems) authorized to connect to the system are identified',
        prefilledTemplate: 'Devices authorized to access the enclave boundary are registered in **Microsoft Intune** and verified as Entra Hybrid Joined. Network access control is enforced via 802.1X EAP-TLS with machine certificates issued by the internal enterprise PKI; unmanaged or rogue MAC addresses are blocked at the switch port / firewall level.',
        scapRuleId: 'sshd_disable_root_login',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'd',
        text: 'system access is limited to authorized users',
        prefilledTemplate: 'Access to the enclave systems and CUI repositories is restricted to authenticated users matching **Entra ID** Conditional Access policies requiring compliant enrolled hardware, **FIDO2 YubiKey**, and trusted geopolitical boundary IP addresses.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'e',
        text: 'system access is limited to processes acting on behalf of authorized users',
        prefilledTemplate: 'Background services and scheduled automated tasks operate under least-privilege service accounts with Deny Interactive Logon rights, strictly scoped to authorized folder paths and monitored via Sysmon event ID 1 (Process Creation).',
        isAutoVerifiedByTelemetry: false,
        odpParameters: [
          { id: 'si_3_14_1_crit', label: 'Critical Patch SLA', defaultValue: '7 days' },
          { id: 'si_3_14_1_high', label: 'High Patch SLA', defaultValue: '30 days' }
        ],
      },
      {
        letter: 'f',
        text: 'system access is limited to authorized devices (including other systems)',
        prefilledTemplate: 'Hardware access is limited via **Intune** Device Compliance policies requiring Secure Boot, BitLocker encryption (XTS-AES 256), and Defender for Endpoint healthy status. Non-compliant devices are automatically isolated from enclave resources.',
        scapRuleId: 'wireless_disable_interfaces',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  '3.1.2': {
    controlNumber: '3.1.2',
    family: 'AC',
    title: 'Access Enforcement & Transaction Limits',
    objectives: [
      {
        letter: 'a',
        text: 'the types of transactions and functions that authorized users are permitted to execute are defined',
        prefilledTemplate: 'Job descriptions and the Enclave RBAC Matrix define authorized transactions per role (e.g. System Admin, Compliance Auditor, Engineering Lead, Standard Operator). Privileged operations are restricted to dedicated administrative security groups.',
        isAutoVerifiedByTelemetry: false,
        odpParameters: [{ id: 'ac_3_1_8_attempts', label: 'Max Invalid Attempts', defaultValue: '3 attempts' }],
      },
      {
        letter: 'b',
        text: 'system access is limited to the defined types of transactions and functions for authorized users',
        prefilledTemplate: 'Role-Based Access Control (RBAC) is enforced through Entra Privileged Identity Management (PIM) and Windows NTFS/Share permissions. Standard users do not possess local administrative rights, preventing execution of unauthorized software or privileged transactions.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_retry',
      },
    ],
  },

  '3.1.3': {
    controlNumber: '3.1.3',
    family: 'AC',
    title: 'Information Flow Enforcement',
    objectives: [
      {
        letter: 'a',
        text: 'approved authorizations for controlling the flow of CUI are defined',
        prefilledTemplate: 'The Enclave Boundary Interconnect Agreement (ISA) and Data Flow Policy define approved egress and ingress pathways for Controlled Unclassified Information. Flow between trust zones requires explicit firewall protocol inspection.',
        isAutoVerifiedByTelemetry: false,
        odpParameters: [
          { id: 'ac_3_1_11_max_duration', label: 'Max Session Duration', defaultValue: '12 hours' },
          { id: 'ac_3_1_11_idle', label: 'Idle Timeout', defaultValue: '30 minutes' }
        ],
      },
      {
        letter: 'b',
        text: 'the flow of CUI is controlled in accordance with approved authorizations',
        prefilledTemplate: '**Palo Alto** Next-Generation Firewalls enforce Layer 7 App-ID routing and **Microsoft Purview** Data Loss Prevention (DLP) blocks unauthorized exfiltration of CUI labels over email, web uploads, or unapproved cloud storage sinks.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'iptables_rules_configured',
      },
    ],
  },

  '3.1.4': {
    controlNumber: '3.1.4',
    family: 'AC',
    title: 'Separation of Duties',
    objectives: [
      {
        letter: 'a',
        text: 'duties of individuals requiring separation are defined',
        prefilledTemplate: 'The Organizational Security Policy defines separation between System Administration (infrastructure modification), Security Auditing (log review), and Key Management duties to prevent collusion and single-point malevolent changes.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'responsibilities of individuals are separated to reduce the opportunity for malevolent activity',
        prefilledTemplate: 'Administrators managing servers cannot modify or purge audit logs in **Azure Log Analytics** / Sentinel; audit leads have read-only access to operational systems. Two-person authorization is required for firewall rule updates and PKI root revocations.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  '3.1.5': {
    controlNumber: '3.1.5',
    family: 'AC',
    title: 'Least Privilege',
    objectives: [
      {
        letter: 'a',
        text: 'privileged accounts are identified',
        prefilledTemplate: 'All privileged accounts (Domain Admins, Global Admins, Enterprise Admins, local administrators) are cataloged in the Enclave Privileged Account Registry. Privileged accounts use a dedicated naming standard (e.g. adm_username) distinct from standard accounts.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'access to privileged accounts is authorized in accordance with the principle of least privilege',
        prefilledTemplate: 'Privileged access is governed via Entra PIM with Just-In-Time (JIT) activation, maximum 8-hour session windows, mandatory ticketing justifications, and peer approval workflows.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'c',
        text: 'other security functions are identified',
        prefilledTemplate: 'Security functions including firewall administration, EDR console management, backup maintenance, and SIEM monitoring are assigned dedicated granular RBAC roles rather than blanket administrative grants.',
        isAutoVerifiedByTelemetry: false,
        odpParameters: [{ id: 'ac_3_1_8_lockout', label: 'Lockout Duration', defaultValue: '30 minutes' }],
      },
      {
        letter: 'd',
        text: 'access to other security functions is authorized in accordance with the principle of least privilege',
        prefilledTemplate: 'Security analysts are restricted to read-only incident triage roles in **Microsoft Defender** and Sentinel without endpoint execution privileges, strictly limiting functional exposure.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  '3.1.6': {
    controlNumber: '3.1.6',
    family: 'AC',
    title: 'Non-Privileged Account Usage',
    objectives: [
      {
        letter: 'a',
        text: 'nonsecurity functions are identified',
        prefilledTemplate: 'Non-security functions include standard day-to-day work tasks such as email communications (Exchange Online), office productivity suites, and general web browsing.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'non-privileged accounts or roles are used when accessing nonsecurity functions',
        prefilledTemplate: 'Personnel are issued standard non-privileged accounts for daily computing. Administrative accounts (adm_*) are barred from receiving inbound external email and cannot launch standard web browsers or office software via AppLocker / Software Restriction Policies.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_disable_root_login',
      },
    ],
  },

  '3.1.7': {
    controlNumber: '3.1.7',
    family: 'AC',
    title: 'Prevent Non-Privileged Execution of Privileged Functions',
    objectives: [
      {
        letter: 'a',
        text: 'privileged functions are identified',
        prefilledTemplate: 'Privileged functions include installation of kernel-mode drivers, modifying network adapters, editing registry security policies, stopping security daemons, and accessing raw file system volumes.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'non-privileged users are prevented from executing privileged functions',
        prefilledTemplate: 'User Account Control (UAC) is enforced at the highest level (Always Notify). End-user workstations run with standard user tokens; attempts to invoke privileged APIs or sudo/runas prompts require valid administrative credentials not available to standard personnel.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_minlen',
      },
      {
        letter: 'c',
        text: 'the execution of privileged functions is captured in audit logs',
        prefilledTemplate: 'All privileged invocations, UAC elevations, Windows Event IDs 4672 (Special privileges assigned) and 4673 (Privileged service called), and Linux sudo invocations are ingested in real-time into the central SIEM.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'auditd_enabled',
      },
    ],
  },

  '3.1.8': {
    controlNumber: '3.1.8',
    family: 'AC',
    title: 'Unsuccessful Logon Attempts',
    objectives: [
      {
        letter: 'a',
        text: 'the number of consecutive invalid logon attempts allowed is defined',
        prefilledTemplate: 'In accordance with **DISA Windows and Linux STIG** baselines, the maximum allowed consecutive invalid logon attempts is defined as [ODP: 3 attempts].',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'the time period for the allowed number of consecutive invalid logon attempts is defined',
        prefilledTemplate: 'The observation window for counting invalid logon attempts is configured to [ODP: 15 minutes] before the counter resets.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'the action to be taken when the allowed number of consecutive invalid logon attempts is exceeded is defined',
        prefilledTemplate: 'Upon exceeding 3 invalid attempts, the account is locked for a duration of [ODP: 30 minutes], requiring administrative help desk verification or automated Entra Smart Lockout step-up challenge to unlock.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'the number of consecutive invalid logon attempts is limited in accordance with the definition',
        prefilledTemplate: 'Group Policy Objects (GPOs) and **Entra ID** Smart Lockout settings enforce Account Lockout Threshold = [ODP: 3 attempts], Lockout Duration = [ODP: 30 minutes], and Reset Lockout Counter After = [ODP: 15 minutes] across all enclave hosts.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_passwords_pam_faillock',
        odpParameters: [
          { id: 'ac_3_1_8_attempts', label: 'Max Invalid Attempts', defaultValue: '3 attempts' },
          { id: 'ac_3_1_8_lockout', label: 'Lockout Duration', defaultValue: '30 minutes' },
          { id: 'ac_3_1_8_window', label: 'Observation Window', defaultValue: '15 minutes' }
        ],
      },
    ],
  },

  '3.1.9': {
    controlNumber: '3.1.9',
    family: 'AC',
    title: 'Privacy and Security Notices',
    objectives: [
      {
        letter: 'a',
        text: 'privacy and security notices consistent with applicable CUI rules are provided',
        prefilledTemplate: 'Standard DoD Warning Banners are configured on all Windows and Linux logon screens via GPO and /etc/issue.net. The banner explicitly states that the system is for authorized use only, communications are monitored, and unauthorized access is subject to criminal prosecution.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  '3.1.10': {
    controlNumber: '3.1.10',
    family: 'AC',
    title: 'Session Lock',
    objectives: [
      {
        letter: 'a',
        text: 'session lock after a defined period of inactivity is initiated',
        prefilledTemplate: '**Microsoft Intune** Configuration Profiles and **DISA STIG** GPOs enforce an automated screen lock threshold of [ODP: 15 minutes (900 seconds)] of inactivity across all workstations, servers, and virtual desktop sessions.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'screen_locking_enabled',
        odpParameters: [{ id: 'ac_3_1_10_timeout', label: 'Inactivity Lock Period', defaultValue: '15 minutes (900 seconds)' }],
      },
      {
        letter: 'b',
        text: 'pattern-hiding display is used during session lock',
        prefilledTemplate: 'The screen lock replaces all desktop content with an opaque, pattern-hiding display (blank screen or standard Windows lock screen) concealing all underlying CUI and application data until re-authenticated with user PIN/MFA.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_set_idle_timeout',
      },
    ],
  },

  '3.1.11': {
    controlNumber: '3.1.11',
    family: 'AC',
    title: 'Session Termination',
    objectives: [
      {
        letter: 'a',
        text: 'conditions for automatic session termination are defined',
        prefilledTemplate: 'Session termination conditions are defined in the Enclave Access Policy: VPN and SSH sessions terminate after [ODP: 12 hours] of total duration or [ODP: 30 minutes] of idle inactivity; Web application tokens expire after 8 hours.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'user sessions are automatically terminated when the defined conditions are met',
        prefilledTemplate: 'Firewall VPN gateways, SSH daemons (ClientAliveInterval 300 / ClientAliveCountMax 2), and **Entra ID** Conditional Access Session Lifetime controls automatically tear down network sessions upon reaching defined time limits.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_set_idle_timeout',
      },
    ],
  },

  '3.1.12': {
    controlNumber: '3.1.12',
    family: 'AC',
    title: 'Monitor and Control Remote Access',
    objectives: [
      {
        letter: 'a',
        text: 'remote access sessions are monitored',
        prefilledTemplate: 'All remote access sessions through the secure VPN gateway and Azure Virtual Desktop are continuously monitored. Session telemetry, source IP, authenticated UPN, and byte transfer rates are logged to SIEM in real time.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_disable_x11_forwarding',
      },
      {
        letter: 'b',
        text: 'remote access sessions are controlled',
        prefilledTemplate: 'Remote access is routed exclusively through managed gateways enforcing **FIDO2 YubiKey** MFA, endpoint posture validation (**Intune** compliance), and split tunneling prohibition. Unmanaged direct RDP or SSH across the boundary is blocked.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_disable_x11_forwarding',
      },
    ],
  },

  '3.1.20': {
    controlNumber: '3.1.20',
    family: 'AC',
    title: 'External Connections & Authorized Systems',
    objectives: [
      {
        letter: 'a',
        text: 'connections to external systems are verified',
        prefilledTemplate: 'All connections from external third-party partner systems require formal Interconnection Security Agreements (ISAs). Certificates and IP blocks are verified before firewall whitelist insertion.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'connections to external systems are controlled/limited',
        prefilledTemplate: 'boundary firewalls (**Palo Alto NGFW**) employ default-deny ingress filtering, restricting external inbound traffic strictly to authorized DoD / FedRAMP Moderate partner CIDR blocks over encrypted IPSec / TLS tunnels.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'iptables_rules_configured',
      },
      {
        letter: 'c',
        text: 'the use of external systems is verified',
        prefilledTemplate: 'Cloud SaaS applications and external repositories are reviewed against the FedRAMP Marketplace to confirm Moderate baseline equivalence prior to authorizing employee data transfer.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'the use of external systems is controlled/limited',
        prefilledTemplate: 'Cloud App Security (Defender for Cloud Apps) enforces proxy-level tenant restrictions, preventing enclave devices from authenticating to unauthorized personal cloud storage or external tenants.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  '3.1.22': {
    controlNumber: '3.1.22',
    family: 'AC',
    title: 'Publicly Accessible Content Control',
    objectives: [
      {
        letter: 'a',
        text: 'individuals authorized to post information on publicly accessible systems are identified',
        prefilledTemplate: 'Only the Corporate Communications Director and designated Public Affairs Officers are authorized to approve and publish marketing, web content, or press releases.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'procedures to ensure that CUI is not posted on publicly accessible systems are identified',
        prefilledTemplate: 'The Public Information Release Procedure requires a two-stage security review and explicit written CUI clearance before any documentation, white paper, or press statement is published.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'authorized individuals review the proposed content of information prior to posting',
        prefilledTemplate: 'The Facility Security Officer (FSO) conducts technical redaction and markings reviews on all proposed public releases to verify that no defense technical data or CUI markings are present.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'CUI is not posted on publicly accessible systems',
        prefilledTemplate: 'The public website is hosted on an isolated, separate external infrastructure with zero physical or logical connectivity to the CUI enclave boundary. Automated web scrapers check for accidental disclosures.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // IDENTIFICATION & AUTHENTICATION (IA)
  // ──────────────────────────────────────────────────────────────────────────
  '3.5.1': {
    controlNumber: '3.5.1',
    family: 'IA',
    title: 'User and Device Identification',
    objectives: [
      {
        letter: 'a',
        text: 'system users are uniquely identified',
        prefilledTemplate: 'All system users are assigned unique User Principal Names (UPN) in **Microsoft Entra ID**. Shared or generic accounts (e.g. admin, user, test) are disabled by automated security policies.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_minlen',
      },
      {
        letter: 'b',
        text: 'processes acting on behalf of users are uniquely identified',
        prefilledTemplate: 'Background services and scheduled scripts execute under unique Managed Service Accounts (gMSAs) or Entra App Registrations, each with isolated cryptographic credentials and specific role assignments.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'devices accessing the system are uniquely identified',
        prefilledTemplate: 'Endpoints accessing the enclave are uniquely identified by device GUID and machine certificate in **Microsoft Intune**, with hardware SHA-256 fingerprints recorded in the Accretion asset ledger.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_disable_root_login',
      },
    ],
  },

  '3.5.2': {
    controlNumber: '3.5.2',
    family: 'IA',
    title: 'Authenticate Users, Processes, and Devices',
    objectives: [
      {
        letter: 'a',
        text: 'user identities are authenticated before system access is allowed',
        prefilledTemplate: 'Users must authenticate via **Entra ID** using **FIDO2 YubiKey** or Windows Hello for Business with TPM 2.0 attestation before receiving access tokens to any enclave resource.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'no_empty_passwords',
      },
      {
        letter: 'b',
        text: 'process identities are authenticated before system access is allowed',
        prefilledTemplate: 'Processes and API integrations authenticate using mutual TLS (mTLS) with enterprise CA certificates or OAuth 2.0 client credentials validated against the identity provider.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'device identities are authenticated before system access is allowed',
        prefilledTemplate: 'Device identities are authenticated at the network edge using 802.1X EAP-TLS certificates issued to the machine and verified by Microsoft NPS / Cisco ISE before network admission.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  '3.5.3': {
    controlNumber: '3.5.3',
    family: 'IA',
    title: 'Multifactor Authentication (MFA)',
    objectives: [
      {
        letter: 'a',
        text: 'multifactor authentication is used for local access to privileged accounts',
        prefilledTemplate: 'Local and console logons to servers and workstations for privileged administrative accounts require smart card / FIDO2 YubiKey** YubiKey** hardware tokens or Windows Hello for Business PIN backed by physical TPM.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'multifactor authentication is used for network access to privileged accounts',
        prefilledTemplate: 'All network access (SSH, PowerShell Remoting, Windows Admin Center, Azure Portal) for privileged accounts strictly mandates phishing-resistant MFA enforced via **Entra ID** Conditional Access Authentication Strengths.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'c',
        text: 'multifactor authentication is used for network access to non-privileged accounts',
        prefilledTemplate: 'All non-privileged user network access, including VPN connections, email access, and file share access, requires MFA via Microsoft Authenticator number matching or **FIDO2 YubiKey**.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // CONFIGURATION MANAGEMENT (CM)
  // ──────────────────────────────────────────────────────────────────────────
  '3.4.1': {
    controlNumber: '3.4.1',
    family: 'CM',
    title: 'Baseline Configurations & Inventories',
    objectives: [
      {
        letter: 'a',
        text: 'baseline configurations of organizational systems are established',
        prefilledTemplate: 'Gold image baselines for Windows 11 Enterprise and Rocky Linux 9 are established based strictly on **DISA STIG** and CIS Benchmark Level 2 standards. Hardening scripts are maintained in a version-controlled Git repository.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'screen_locking_enabled',
      },
      {
        letter: 'b',
        text: 'baseline configurations of organizational systems are maintained',
        prefilledTemplate: 'Configuration drift is continuously monitored and corrected via **Microsoft Intune** proactive remediation scripts and Ansible automation playbooks, enforcing automated re-alignment within 24 hours of drift detection.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'c',
        text: 'inventories of organizational systems under configuration control are established',
        prefilledTemplate: 'A unified hardware and software inventory is maintained in the Accretion asset ledger, tracking device hostname, MAC address, serial number, OS build, and assigned custodian.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'd',
        text: 'inventories of organizational systems under configuration control are maintained',
        prefilledTemplate: 'Asset inventories are updated automatically through daily **Intune** synchronization and Photon subnet telemetry scans, recording decommissioned and newly provisioned assets in real time.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  '3.4.2': {
    controlNumber: '3.4.2',
    family: 'CM',
    title: 'Enforce Security Configuration Settings',
    objectives: [
      {
        letter: 'a',
        text: 'security configuration settings for information technology products employed in organizational systems are established',
        prefilledTemplate: 'Security configuration benchmarks are documented in the Enclave Systems Configuration Standard, adopting **DISA STIG**s for Windows Server, Windows 11, Red Hat/Rocky Linux, and Edge/Chrome browsers.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'security configuration settings for information technology products employed in organizational systems are enforced',
        prefilledTemplate: 'Security settings are enforced via **Active Directory** GPOs and **Intune** Endpoint Security baselines. Local overrides are blocked, and weekly OpenSCAP scans verify compliance rates against the benchmark.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_disable_root_login',
      },
    ],
  },

  '3.4.7': {
    controlNumber: '3.4.7',
    family: 'CM',
    title: 'Restrict Nonessential Programs & Services',
    objectives: [
      {
        letter: 'a',
        text: 'nonessential programs, functions, ports, protocols, and services are identified',
        prefilledTemplate: 'The Enclave Port and Protocol Exception List (PPEL) defines all required operational ports (e.g. 443, 802.1X, DNS). Unnecessary services such as Telnet, FTP, TFTP, and SMBv1 are classified as nonessential.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'nonessential programs, functions, ports, protocols, and services are restricted, disabled, or prevented',
        prefilledTemplate: 'Host-based firewalls (Windows Defender Firewall and Linux firewalld) block all non-whitelisted ports. Disabling nonessential Windows services (e.g. Xbox Live, Remote Registry) is enforced via **DISA STIG** policy.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewalld_enabled',
      },
    ],
  },

  '3.4.8': {
    controlNumber: '3.4.8',
    family: 'CM',
    title: 'Software Whitelisting / Deny-by-Default',
    objectives: [
      {
        letter: 'a',
        text: 'software allowed to execute is identified',
        prefilledTemplate: 'Authorized business and security applications are cataloged in the Approved Software List, verified with digital code-signing publisher certificates and SHA-256 executable hashes.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'deny-by-default policy is applied for software allowed to execute',
        prefilledTemplate: 'Windows Defender Application Control (WDAC) and AppLocker enforce a strict deny-all, permit-by-exception execution policy in Enforce mode. Unsigned scripts and user-writable executables are blocked from running.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AUDIT AND ACCOUNTABILITY (AU)
  // ──────────────────────────────────────────────────────────────────────────
  '3.3.1': {
    controlNumber: '3.3.1',
    family: 'AU',
    title: 'System Audit Logging',
    objectives: [
      {
        letter: 'a',
        text: 'system audit logs and records are created to enable monitoring, analysis, investigation, and reporting of unlawful, unauthorized, or inappropriate system activity',
        prefilledTemplate: 'Advanced Windows Audit Policies and Linux auditd are configured according to **DISA STIG** recommendations to log logon/logoff events, privilege use, file/object access, process creation with command-line arguments, and policy modifications.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'auditd_enabled',
      },
      {
        letter: 'b',
        text: 'system audit logs and records are retained to enable monitoring, analysis, investigation, and reporting of unlawful, unauthorized, or inappropriate system activity',
        prefilledTemplate: 'Audit logs are forwarded in near-real-time to an immutable, WORM-configured **Microsoft Sentinel** workspace with a [ODP: 3 years total, 1 year online] retention policy meeting DoD CMMC requirements.',
        isAutoVerifiedByTelemetry: true,
        odpParameters: [{ id: 'au_3_3_1_retention', label: 'Log Retention SLA', defaultValue: '3 years total, 1 year online' }],
      },
    ],
  },

  '3.3.2': {
    controlNumber: '3.3.2',
    family: 'AU',
    title: 'Audit Record User Traceability',
    objectives: [
      {
        letter: 'a',
        text: 'the actions of individual system users are uniquely traced to those users',
        prefilledTemplate: 'Every generated audit record contains the unique UPN, SID, or UID of the invoking user, client IP address, and workstation hostname. Generic accounts are prohibited, preventing non-attributable actions.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'auditd_enabled',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM & COMMUNICATIONS PROTECTION (SC)
  // ──────────────────────────────────────────────────────────────────────────
  '3.13.1': {
    controlNumber: '3.13.1',
    family: 'SC',
    title: 'Boundary Protection & Network Segmentation',
    objectives: [
      {
        letter: 'a',
        text: 'external boundaries of the system are identified',
        prefilledTemplate: 'The boundary between the corporate enclave, the public Internet, and cloud providers is formally documented in the System Security Plan (SSP) network topology diagram and firewall interface maps.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'key internal boundaries of the system are identified',
        prefilledTemplate: 'Internal security zones (e.g. CUI Management VLAN, Workstation Subnet, DMZ, IT Administration VLAN) are segregated using 802.1Q VLANs and internal segmentation firewalls.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'organizational communications are monitored at external boundaries',
        prefilledTemplate: 'External traffic is continuously monitored by **Palo Alto** Next-Gen Firewall threat prevention and Cloudflare DDoS/WAF systems with automated alerts dispatched to the SOC for anomaly detection.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'iptables_rules_configured',
      },
      {
        letter: 'd',
        text: 'organizational communications are monitored at key internal boundaries',
        prefilledTemplate: 'Inter-VLAN traffic across internal security zones is inspected using deep packet inspection (DPI) and NetFlow collectors reporting to the centralized SIEM.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'e',
        text: 'organizational communications are controlled at external boundaries',
        prefilledTemplate: 'External ingress is denied by default; egress is strictly limited to authorized outbound ports (80/443) via a secure web proxy enforcing SSL/TLS decryption and URL reputation filtering.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewalld_enabled',
      },
      {
        letter: 'f',
        text: 'organizational communications are controlled at key internal boundaries',
        prefilledTemplate: 'Access between internal subnets is controlled via Layer 4/7 access control lists (ACLs) permitting only authorized protocols between specific host endpoints.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'g',
        text: 'organizational communications are protected at external boundaries',
        prefilledTemplate: 'External boundary transmissions utilize cryptographic encapsulation via IPsec VPN tunnels using **FIPS 140-3** validated AES-256 encryption algorithms.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'tls_version_minimum',
      },
      {
        letter: 'h',
        text: 'organizational communications are protected at key internal boundaries',
        prefilledTemplate: 'Internal data in transit between enclave services mandates **TLS 1.3** or SMB 3.1.1 encryption with AES-128-GCM / AES-256 cipher suites.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'tls_version_minimum',
      },
    ],
  },

  '3.13.11': {
    controlNumber: '3.13.11',
    family: 'SC',
    title: 'FIPS-Validated Cryptography',
    objectives: [
      {
        letter: 'a',
        text: 'FIPS-validated cryptography is employed to protect the confidentiality of CUI',
        prefilledTemplate: 'The confidentiality of CUI at rest and in transit is protected by cryptographic modules validated under **FIPS 140-3**, and operating systems run in FIPS mode (fips=1 in GRUB on Linux, FIPSMode enabled via Windows GPO).',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  '3.13.8': {
    controlNumber: '3.13.8',
    family: 'SC',
    title: 'Data in Transit Cryptography',
    objectives: [
      {
        letter: 'a',
        text: 'cryptographic mechanisms are identified to prevent unauthorized disclosure of CUI during transmission',
        prefilledTemplate: '**FIPS 140-3** validated cryptography mechanisms (**TLS 1.3**, IPsec ESP with AES-256, SSHv2 with ed25519 or ecdsa-sha2-nistp384) are formally specified in the Cryptographic Standards Policy.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'identified cryptographic mechanisms are implemented to prevent unauthorized disclosure of CUI during transmission',
        prefilledTemplate: 'All endpoints and web services enforce TLS 1.2+ minimum with legacy SSLv3, TLS 1.0, and TLS 1.1 disabled via Schannel registry settings. Insecure cleartext protocols (HTTP, Telnet, FTP) are blocked.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'tls_version_minimum',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM & INFORMATION INTEGRITY (SI)
  // ──────────────────────────────────────────────────────────────────────────
  '3.14.1': {
    controlNumber: '3.14.1',
    family: 'SI',
    title: 'Flaw Remediation & Patch Management',
    objectives: [
      {
        letter: 'a',
        text: 'the time period within which to identify system flaws is specified',
        prefilledTemplate: 'The Vulnerability Management Policy defines flaw identification as continuous through Defender for Endpoint Threat & Vulnerability Management (TVM), with weekly automated scans.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'system flaws are identified within the specified time period',
        prefilledTemplate: 'Endpoint vulnerability assessments run automatically every 24 hours, surfacing CVEs and missing security updates into the centralized vulnerability dashboard.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'dnf_automatic_enabled',
      },
      {
        letter: 'c',
        text: 'the time period within which to report system flaws is specified',
        prefilledTemplate: 'Critical and High severity vulnerabilities (CVSS >= 7.0) must be reported to the IT Security Officer within 24 hours of discovery; medium/low within 7 business days.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'system flaws are reported within the specified time period',
        prefilledTemplate: 'Automated webhook alerts deliver critical CVE notifications immediately to the security team Slack/Teams channel and create an automated Jira/ServiceNow remediation ticket.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'e',
        text: 'the time period within which to correct system flaws is specified',
        prefilledTemplate: 'Flaw correction SLAs are defined: Critical CVEs (CVSS 9.0+) within [ODP: 7 days], High (7.0-8.9) within [ODP: 30 days], Medium within 60 days, and Low within 90 days of release.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'f',
        text: 'system flaws are corrected within the specified time period',
        prefilledTemplate: 'Windows Updates are deployed automatically via **Microsoft Intune** rings (Pilot, Broad); Linux servers are patched via Ansible playbooks using dnf-automatic, verifying patch compliance within defined SLAs.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'dnf_automatic_enabled',
      },
    ],
  },

  '3.14.2': {
    controlNumber: '3.14.2',
    family: 'SI',
    title: 'Malicious Code Protection',
    objectives: [
      {
        letter: 'a',
        text: 'malicious code protection mechanisms are employed at system entry and exit points',
        prefilledTemplate: '**Microsoft Defender** for Office 365 Safe Links and Safe Attachments scan all inbound and outbound email at the mail gateway boundary, quarantining malicious payloads before mailbox delivery.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'ensure_antivirus_installed',
      },
      {
        letter: 'b',
        text: 'malicious code protection mechanisms are employed at system endpoints',
        prefilledTemplate: '**Microsoft Defender for Endpoint** (EDR) is installed and active on all Windows and Linux systems with Real-Time Protection, Cloud-Delivered Protection, and Tamper Protection permanently enabled.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'ensure_antivirus_installed',
      },
      {
        letter: 'c',
        text: 'malicious code protection mechanisms are updated as new releases are available',
        prefilledTemplate: 'Antivirus signature definitions are updated automatically multiple times daily directly from Microsoft Cloud Security Intelligence without requiring user intervention.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'aide_installed',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // MEDIA PROTECTION (MP)
  // ──────────────────────────────────────────────────────────────────────────
  '3.8.3': {
    controlNumber: '3.8.3',
    family: 'MP',
    title: 'Media Sanitization & Destruction',
    objectives: [
      {
        letter: 'a',
        text: 'system media containing CUI is sanitized or destroyed before disposal',
        prefilledTemplate: 'All storage media containing CUI (NVMe/SATA SSDs, magnetic disks) is degaussed and mechanically shredded in accordance with NIST SP 800-88 Rev 1 Guidelines for Media Sanitization by a certified NAID AAA vendor with signed destruction certificates.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'system media containing CUI is sanitized before release for reuse',
        prefilledTemplate: 'Internal media reuse requires cryptographic erase followed by multi-pass cryptographic wipe (ATA Secure Erase / blkdiscard) verified by the IT Security Lead before re-allocation.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'encrypt_partitions',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PHYSICAL PROTECTION (PE)
  // ──────────────────────────────────────────────────────────────────────────
  '3.10.1': {
    controlNumber: '3.10.1',
    family: 'PE',
    title: 'Limit Physical Access',
    objectives: [
      {
        letter: 'a',
        text: 'physical access to organizational systems is limited to authorized individuals',
        prefilledTemplate: 'Physical access to enclave hardware, server racks, and network closets is restricted to personnel on the approved Physical Access List. Entrance requires badge keycard access with dual-factor biometric verification.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'physical access to equipment is limited to authorized individuals',
        prefilledTemplate: 'Server racks and patch panels are locked inside a dedicated, climate-controlled telecommunications room. Keys are stored in an electronic key control cabinet with logged check-out/check-in.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'bios_boot_password',
      },
      {
        letter: 'c',
        text: 'physical access to the operating environments is limited to authorized individuals',
        prefilledTemplate: 'The facility perimeter is protected with 24/7 CCTV surveillance, electronic access control doors, and visitor escort procedures. Security cameras retain footage for at least 90 days.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AWARENESS & TRAINING (AT)
  // ──────────────────────────────────────────────────────────────────────────
  '3.2.1': {
    controlNumber: '3.2.1',
    family: 'AT',
    title: 'Security Awareness Training',
    objectives: [
      {
        letter: 'a',
        text: 'managers of organizational systems are made aware of the security risks associated with their activities',
        prefilledTemplate: 'Managers receive annual executive cybersecurity briefings and role-based training covering insider threat awareness, CUI handling responsibilities, and supply chain risk management.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'systems administrators of organizational systems are made aware of the security risks associated with their activities',
        prefilledTemplate: 'System and network administrators complete annual technical role-based security training focusing on secure administration, credential hygiene, and incident reporting obligations.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'users of organizational systems are made aware of the security risks associated with their activities',
        prefilledTemplate: 'All employees undergo mandatory initial cybersecurity onboarding and annual refresher training covering phishing, social engineering, password security, and clean desk procedures.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'managers, systems administrators, and users are made aware of applicable policies, standards, and procedures',
        prefilledTemplate: 'All personnel review and sign the Acceptable Use Policy and CUI Protection Guide annually, with completion tracked in the LMS compliance dashboard.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // RISK ASSESSMENT (RA)
  // ──────────────────────────────────────────────────────────────────────────
  '3.11.2': {
    controlNumber: '3.11.2',
    family: 'RA',
    title: 'Vulnerability Scanning',
    objectives: [
      {
        letter: 'a',
        text: 'the frequency of vulnerability scans is defined',
        prefilledTemplate: 'The Enclave Vulnerability Management Standard defines vulnerability scanning as continuous (real-time telemetry agent evaluations) with formal weekly authenticated credentialed network scans.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'vulnerabilities in organizational systems and applications are scanned with the defined frequency',
        prefilledTemplate: 'Automated OpenSCAP benchmarks and Defender for Endpoint TVM scan all enrolled servers, endpoints, and network appliances weekly against the latest CVE definitions.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'dnf_automatic_enabled',
      },
      {
        letter: 'c',
        text: 'vulnerabilities in organizational systems and applications are scanned when new vulnerabilities affecting those systems are identified',
        prefilledTemplate: 'Ad-hoc scans are triggered within 24 hours of CISA Known Exploited Vulnerabilities (KEV) catalog updates or zero-day disclosures affecting enclave technologies.',
        isAutoVerifiedByTelemetry: true,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SECURITY ASSESSMENT (CA)
  // ──────────────────────────────────────────────────────────────────────────
  '3.12.1': {
    controlNumber: '3.12.1',
    family: 'CA',
    title: 'Security Control Assessments',
    objectives: [
      {
        letter: 'a',
        text: 'the frequency of security control assessments is defined',
        prefilledTemplate: 'The Enclave Continuous Monitoring Strategy defines an annual comprehensive security control assessment cycle, supplemented by monthly continuous automated telemetry audits.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'security controls in organizational systems are assessed with the defined frequency to determine if they are effective',
        prefilledTemplate: 'Internal compliance assessors and third-party certified C3PAO assessors conduct annual examinations, interviews, and automated technical tests across all 110 NIST SP 800-171 controls to verify operational effectiveness.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },
  // ──────────────────────────────────────────────────────────────────────────
  // PHYSICAL PROTECTION (PE) - ADDITIONAL LEVEL 1 / 800-171 CONTROLS
  // ──────────────────────────────────────────────────────────────────────────
  '3.10.3': {
    controlNumber: '3.10.3',
    family: 'PE',
    title: 'Escort Visitors and Monitor Visitor Activity',
    objectives: [
      {
        letter: 'a',
        text: 'visitors are escorted within facility areas containing organizational systems',
        prefilledTemplate: 'All non-cleared visitors, maintenance staff, and guests are required to check in at facility reception, display visitor badges, and remain under continuous physical escort by designated personnel while within areas containing systems processing FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'visitor activity is continuously monitored within facility areas containing organizational systems',
        prefilledTemplate: 'Escorting personnel maintain active continuous line-of-sight monitoring of visitor activity at all times while in proximity to corporate workstations, network equipment, or FCI print areas.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },
  '3.10.4': {
    controlNumber: '3.10.4',
    family: 'PE',
    title: 'Maintain Physical Access Audit Logs',
    objectives: [
      {
        letter: 'a',
        text: 'audit logs of physical access by visitors are maintained',
        prefilledTemplate: 'A centralized visitor sign-in/out log (capturing visitor name, signature, organization, verified government photo ID, arrival/departure timestamps, and host employee) is maintained at reception.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'physical access audit logs are retained for compliance review',
        prefilledTemplate: 'Physical visitor access registers and electronic badge check-in records are archived and retained for a minimum of 12 months for compliance audit inspection.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },
  '3.10.5': {
    controlNumber: '3.10.5',
    family: 'PE',
    title: 'Control Physical Access Devices',
    objectives: [
      {
        letter: 'a',
        text: 'physical access devices are identified and inventoried',
        prefilledTemplate: 'All facility brass keys, electronic RFID keycards, and access fobs are serialized, assigned to specific authorized personnel, and tracked in a Master Key Control Inventory.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'physical access devices are controlled and managed throughout their lifecycle',
        prefilledTemplate: 'Physical access devices are audited semi-annually. Lost or stolen badges are revoked immediately in the access control system, and keys/badges are surrendered upon employee offboarding.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM & COMMUNICATIONS PROTECTION (SC) - LEVEL 1 / 800-171 CONTROLS
  // ──────────────────────────────────────────────────────────────────────────
  '3.13.5': {
    controlNumber: '3.13.5',
    family: 'SC',
    title: 'Subnetwork Isolation for Public Systems',
    objectives: [
      {
        letter: 'a',
        text: 'publicly accessible system components are identified',
        prefilledTemplate: 'Publicly reachable services—including the corporate marketing website, DNS services, and guest Wi-Fi—are identified in the asset architecture and segregated from internal systems holding FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'subnetworks for publicly accessible system components are separated from internal organizational networks',
        prefilledTemplate: 'Public web workloads are hosted externally on third-party cloud infrastructure. On-premises guest Wi-Fi runs on an isolated VLAN (VLAN 20) with client isolation and no routing into the internal corporate network.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'guest_wifi_isolation_vlan',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM & INFORMATION INTEGRITY (SI) - LEVEL 1 / 800-171 CONTROLS
  // ──────────────────────────────────────────────────────────────────────────
  '3.14.4': {
    controlNumber: '3.14.4',
    family: 'SI',
    title: 'Update Malicious Code Protection',
    objectives: [
      {
        letter: 'a',
        text: 'malicious code protection mechanisms are updated as new releases are available',
        prefilledTemplate: 'Antivirus signatures and cloud-delivered EDR intelligence definitions are configured to update automatically every 4 hours via **Microsoft Defender** Cloud Protection, with administrator alerts if endpoints remain out-of-date past 48 hours.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'antivirus_definitions_updated_daily',
      },
    ],
  },
  '3.14.5': {
    controlNumber: '3.14.5',
    family: 'SI',
    title: 'Perform Periodic and Real-Time System Scans',
    objectives: [
      {
        letter: 'a',
        text: 'the frequency for malicious code scans is defined',
        prefilledTemplate: 'The Endpoint Security Policy defines mandatory daily quick antivirus scans at 12:00 PM and comprehensive weekly deep scans every Friday evening at 7:00 PM across all endpoints processing FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'malicious code scans are performed with the defined frequency',
        prefilledTemplate: 'Automated scan schedules are enforced through **Microsoft Intune** / EDR policies, running silently without user interference and logging scan completion telemetry to the central console.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'defender_scheduled_scan_weekly',
      },
      {
        letter: 'c',
        text: 'real-time malicious code scans of files from external sources are performed as files are downloaded, opened, or executed',
        prefilledTemplate: 'Real-time on-access scanning automatically inspects all internet downloads, email attachments, and inserted USB drives upon access, blocking and quarantining malicious code prior to execution.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'defender_realtime_on_access_scan',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // CMMC LEVEL 1 / FAR 52.204-21 CANONICAL CONTROLS (FCI BASELINES)
  // ──────────────────────────────────────────────────────────────────────────
  'AC.L1-b.1.i': {
    controlNumber: 'AC.L1-b.1.i',
    family: 'AC',
    title: 'Limit System Access to Authorized Users, Processes, and Devices',
    objectives: [
      {
        letter: 'a',
        text: 'authorized users are identified',
        prefilledTemplate: 'All corporate personnel requiring access to systems processing, storing, or transmitting Federal Contract Information (FCI) are provisioned individual named user accounts in **Microsoft Entra ID** / Google Workspace. Generic, guest, and shared accounts are strictly prohibited across all endpoints and cloud tenants.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'account_unique_id',
      },
      {
        letter: 'b',
        text: 'processes acting on behalf of authorized users are identified',
        prefilledTemplate: 'Automated background services, system processes, and scheduled tasks operating on systems processing FCI execute exclusively under designated, unprivileged service accounts or managed identities with explicit justification and auditable process ownership.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'process_service_accounts',
      },
      {
        letter: 'c',
        text: 'devices (and other systems) authorized to connect to systems are identified',
        prefilledTemplate: 'Corporate-managed laptops and workstations authorized to connect to the internal network or access FCI repositories are inventoried in **Microsoft Intune** / MDM with corporate asset tags and verified hardware compliance before connection.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'device_inventory_enrolled',
      },
      {
        letter: 'd',
        text: 'system access is limited to authorized users, processes acting on behalf of authorized users, and devices (and other systems)',
        prefilledTemplate: 'System access to endpoints and cloud storage containing FCI is strictly restricted to authenticated, compliant company-owned devices operated by active employees via Entra Conditional Access and endpoint login policies. Unregistered personal devices (BYOD) are blocked.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'access_conditional_enforced',
      },
    ],
  },
  'AC.L1-b.1.ii': {
    controlNumber: 'AC.L1-b.1.ii',
    family: 'AC',
    title: 'Limit System Access to Permitted Transactions and Functions',
    objectives: [
      {
        letter: 'a',
        text: 'the types of transactions and functions that authorized users are permitted to execute are defined',
        prefilledTemplate: 'Role-Based Access Control (RBAC) policies and job descriptions define permissible transactional functions for each employee role. Standard employees are restricted to standard user permissions, and administrative capabilities are cataloged and restricted to IT operations.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'system access is limited to the defined types of transactions and functions',
        prefilledTemplate: 'Standard corporate user accounts are stripped of local administrator privileges on all Windows/macOS endpoints handling FCI. Administrative operations require separate dedicated administrator credentials (e.g., admin-user) used solely for maintenance tasks.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'no_standard_user_admin_rights',
      },
    ],
  },
  'AC.L1-b.1.iii': {
    controlNumber: 'AC.L1-b.1.iii',
    family: 'AC',
    title: 'Verify and Control External Connections',
    objectives: [
      {
        letter: 'a',
        text: 'connections to external systems are identified',
        prefilledTemplate: 'All external network connections—including encrypted remote work VPN gateways, cloud service provider interconnects, and third-party SaaS applications handling FCI—are identified and documented in the system network architecture diagram.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'connections to external systems are verified',
        prefilledTemplate: 'External connections are verified using cryptographic authentication, **TLS 1.3** certificates, and IPsec/WireGuard VPN encryption prior to establishing communications session with internal network resources.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'external_connection_encryption',
      },
      {
        letter: 'c',
        text: 'connections to external systems are authorized',
        prefilledTemplate: 'Every external connection and cloud SaaS integration is reviewed and authorized by the Security Officer. Direct inbound remote desktop (RDP 3389) and unauthenticated external services are blocked at the boundary firewall.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'inbound_rdp_disabled',
      },
      {
        letter: 'd',
        text: 'the use of external connections is monitored',
        prefilledTemplate: 'Firewall gateway logs, VPN connection events, and cloud audit logs continuously monitor external connection traffic, tracking session timestamps, originating IP addresses, and data transfer volumes for anomalous access.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'external_connection_logging',
      },
      {
        letter: 'e',
        text: 'the use of external connections is controlled',
        prefilledTemplate: 'External connections are controlled through egress filtering, web content filtering, and split-tunneling restrictions that enforce DNS inspection and block unauthorized file transfer destinations for endpoints handling FCI.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewall_egress_filtering',
      },
    ],
  },
  'AC.L1-b.1.iv': {
    controlNumber: 'AC.L1-b.1.iv',
    family: 'AC',
    title: 'Control Public Information Posting',
    objectives: [
      {
        letter: 'a',
        text: 'individuals authorized to post or process information onto publicly accessible systems are identified',
        prefilledTemplate: 'Only authorized members of the Communications and Executive Leadership teams are permitted to publish content onto the corporate public website, marketing platforms, and social media channels.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'procedures to review information prior to posting onto publicly accessible systems are established',
        prefilledTemplate: 'A formal Public Release Review Procedure is documented, mandating that all public-facing materials, press releases, technical whitepapers, and web content undergo pre-publication review to verify that no Federal Contract Information (FCI) or sensitive operational details are included.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'procedures to review information prior to posting onto publicly accessible systems are implemented',
        prefilledTemplate: 'The review workflow is enforced prior to publishing: draft materials require written or digital sign-off from the Contract Administrator or Security Lead confirming absence of FCI before CMS publishing credentials can push live.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },
  'IA.L1-b.1.v': {
    controlNumber: 'IA.L1-b.1.v',
    family: 'IA',
    title: 'Identify System Users and Devices',
    objectives: [
      {
        letter: 'a',
        text: 'system users are uniquely identified',
        prefilledTemplate: 'Every employee, contractor, and administrator accessing systems containing FCI is assigned a unique User Principal Name (UPN) formatted as firstname.lastname@company.com. Shared, group, or generic user credentials are strictly prohibited and disabled in **Microsoft Entra ID** / directory services.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'unique_user_identifiers',
      },
      {
        letter: 'b',
        text: 'processes acting on behalf of users are identified',
        prefilledTemplate: 'Automated background scripts, system daemons, and application processes inherit the unique identity of the authorized user invoking them, or operate under uniquely named service accounts with documented owners.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'service_account_naming',
      },
      {
        letter: 'c',
        text: 'devices accessing organizational systems are uniquely identified',
        prefilledTemplate: 'All corporate laptops, desktops, and mobile devices are enrolled in central endpoint management (**Microsoft Intune** / MDM) with unique device hostnames, serial numbers, and device certificates that uniquely identify the hardware.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'device_unique_naming',
      },
    ],
  },
  'IA.L1-b.1.vi': {
    controlNumber: 'IA.L1-b.1.vi',
    family: 'IA',
    title: 'Authenticate Users and Devices',
    objectives: [
      {
        letter: 'a',
        text: 'the identity of each user is authenticated (or verified) as a prerequisite to allowing system access',
        prefilledTemplate: 'All users must authenticate before gaining access to endpoints and cloud systems processing FCI. User authentication requires strong passwords (minimum 14 characters) and mandatory phishing-resistant Multi-Factor Authentication (MFA) via Microsoft Authenticator number matching or **FIDO2 YubiKey** security keys.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'mfa_enforced_cloud_endpoints',
      },
      {
        letter: 'b',
        text: 'the identity of each process acting on behalf of a user is authenticated (or verified) as a prerequisite to allowing system access',
        prefilledTemplate: 'Automated processes and API integrations authenticate using certificate-based credentials, managed identities, or encrypted OAuth 2.0 tokens before access is granted to internal databases or FCI file repositories.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'process_authentication_tokens',
      },
      {
        letter: 'c',
        text: 'the identity of each device is authenticated (or verified) as a prerequisite to allowing system access',
        prefilledTemplate: 'Endpoints authenticating to the corporate network or cloud tenant are verified via device certificates issued by **Intune**/MDM and hardware-bound TPM 2.0 attestation before network access or single sign-on tokens are granted.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'device_certificate_authentication',
      },
    ],
  },
  'MP.L1-b.1.vii': {
    controlNumber: 'MP.L1-b.1.vii',
    family: 'MP',
    title: 'Sanitize or Destroy Media Containing FCI',
    objectives: [
      {
        letter: 'a',
        text: 'system media containing Federal Contract Information is sanitized or destroyed before disposal',
        prefilledTemplate: 'Physical paper records containing Federal Contract Information (FCI) are shredded using DIN 66399 Level P-4 cross-cut shredders. Digital storage devices (hard drives, SSDs) undergo cryptographic erasure or physical destruction by a certified NAID recycling vendor prior to disposal, with serialized certificates of destruction retained.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'system media containing Federal Contract Information is sanitized or destroyed before release for reuse',
        prefilledTemplate: 'Before endpoints or storage media containing FCI are reassigned or released for reuse, full cryptographic sanitization is performed in accordance with NIST SP 800-88 Rev 1 (Clear/Purge), followed by OS re-imaging to guarantee no residual FCI remains.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'drive_sanitization_bitlocker',
      },
    ],
  },
  'PE.L1-b.1.viii': {
    controlNumber: 'PE.L1-b.1.viii',
    family: 'PE',
    title: 'Limit Physical Access to Authorized Individuals',
    objectives: [
      {
        letter: 'a',
        text: 'physical access to organizational systems is limited to authorized individuals',
        prefilledTemplate: 'Physical access to company offices and facilities where systems process FCI is restricted 24/7 to vetted employees using electronic RFID keycards or commercial deadbolts. Unvetted individuals cannot gain unescorted physical entry.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'physical access to equipment is limited to authorized individuals',
        prefilledTemplate: 'Servers, network switches, and patch panels are housed inside a dedicated IT server room or locked equipment cabinet accessible only by authorized IT personnel with physical keys or biometric/card credentials.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'physical access to operating environments is limited to authorized individuals',
        prefilledTemplate: 'Operating environments (workstations, desk areas, printer stations) require clean desk practices and automated workstation screen lock policies (10-minute inactivity timeout) to protect FCI from unauthorized physical observation.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'screen_lock_timeout_10min',
      },
    ],
  },
  'PE.L1-b.1.ix': {
    controlNumber: 'PE.L1-b.1.ix',
    family: 'PE',
    title: 'Escort Visitors, Maintain Physical Audit Logs, and Control Access Devices',
    objectives: [
      {
        letter: 'a',
        text: 'visitors are escorted within facility areas containing organizational systems',
        prefilledTemplate: 'All visitors, maintenance personnel, and contractors must check in at reception, display a visible visitor badge, and remain under continuous escort by an authorized employee throughout their time inside areas housing systems with FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'visitor activity is continuously monitored within facility areas containing organizational systems',
        prefilledTemplate: 'Designated employee hosts are trained to maintain direct line of sight of visitors at all times in work areas and server rooms to prevent unauthorized access or tampering with equipment.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'c',
        text: 'audit logs of physical access by visitors are maintained',
        prefilledTemplate: 'A physical or electronic visitor log is maintained at the facility reception desk capturing visitor full name, government ID verification, organization, date, arrival/departure timestamps, and host employee name. Logs are retained for a minimum of one year.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'physical access devices (keys, keycards, fobs) are controlled and managed throughout their lifecycle',
        prefilledTemplate: 'All physical brass keys, RFID keycards, and access fobs are recorded in a centralized Key Control Register. Issuance requires supervisor sign-off, and all access devices are surrendered and deactivated during employee offboarding.',
        isAutoVerifiedByTelemetry: false,
      },
    ],
  },
  'SC.L1-b.1.x': {
    controlNumber: 'SC.L1-b.1.x',
    family: 'SC',
    title: 'Monitor, Control, and Protect Communications at Boundaries',
    objectives: [
      {
        letter: 'a',
        text: 'organizational communications are monitored at external boundaries of the systems',
        prefilledTemplate: 'A commercial perimeter Next-Generation Firewall (NGFW) continuously monitors all ingress and egress network traffic traversing the boundary between the internal corporate network and the public internet.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewall_boundary_monitoring',
      },
      {
        letter: 'b',
        text: 'organizational communications are controlled at external boundaries of the systems',
        prefilledTemplate: 'Perimeter firewalls enforce a default-deny rule on all incoming network connections. Only stateful outbound established sessions and explicitly authorized application ports are permitted to cross the network boundary.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewall_default_deny_inbound',
      },
      {
        letter: 'c',
        text: 'organizational communications are protected at external boundaries of the systems',
        prefilledTemplate: 'All remote communications traversing external boundaries (such as telework connections) are encrypted using industry-standard protocols (**TLS 1.3**, IPsec, WireGuard) to safeguard FCI in transit.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'transit_encryption_tls13',
      },
      {
        letter: 'd',
        text: 'key internal boundaries of the systems are identified',
        prefilledTemplate: 'Internal network boundaries between general employee workstations, server/storage segments, guest Wi-Fi networks, and IoT equipment are identified and documented in the network topology diagram.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'e',
        text: 'organizational communications are monitored at key internal boundaries of the systems',
        prefilledTemplate: 'Managed network switches and router interfaces monitor intra-VLAN and inter-VLAN communications to detect unauthorized connection attempts across internal network boundaries.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'internal_boundary_logging',
      },
      {
        letter: 'f',
        text: 'organizational communications are controlled at key internal boundaries of the systems',
        prefilledTemplate: 'Internal boundary access control lists (ACLs) and endpoint host-based firewalls (Windows Defender Firewall) are active on all network profiles, controlling communication between internal subnets.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'windows_firewall_all_profiles',
      },
    ],
  },
  'SC.L1-b.1.xi': {
    controlNumber: 'SC.L1-b.1.xi',
    family: 'SC',
    title: 'Subnetwork Isolation for Publicly Accessible Systems',
    objectives: [
      {
        letter: 'a',
        text: 'publicly accessible system components are identified',
        prefilledTemplate: 'All publicly accessible system components—such as the marketing website, DNS resolvers, and guest wireless networks—are identified in the asset inventory and network architecture documentation.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'subnetworks for publicly accessible system components are separated from internal organizational networks',
        prefilledTemplate: 'Public web services are hosted entirely on third-party cloud infrastructure outside the corporate network. Guest Wi-Fi access operates on an isolated VLAN (VLAN 20) with client isolation enabled and zero routing or connectivity into the corporate internal subnet containing FCI.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'guest_wifi_isolation_vlan',
      },
    ],
  },
  'SI.L1-b.1.xii': {
    controlNumber: 'SI.L1-b.1.xii',
    family: 'SI',
    title: 'Flaw Remediation and Patch Management',
    objectives: [
      {
        letter: 'a',
        text: 'the time frame within which to identify information system flaws is defined',
        prefilledTemplate: 'The Patch Management Policy defines a weekly schedule for reviewing vendor security bulletins (Microsoft Patch Tuesday, CISA KEV alerts, Apple security advisories) to identify flaws affecting enclave systems.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'information system flaws are identified within the defined time frame',
        prefilledTemplate: 'Endpoint management telemetry (**Microsoft Intune** / RMM) and automated vulnerability tracking identify missing OS patches and vulnerable software packages across all endpoints on a weekly cadence.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'vulnerability_detection_cadence',
      },
      {
        letter: 'c',
        text: 'the time frame within which to report information system flaws is defined',
        prefilledTemplate: 'The Incident Response and Maintenance Policy establishes that critical security flaws and unpatched zero-days must be reported to IT management within 24 hours of identification.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'd',
        text: 'information system flaws are reported within the defined time frame',
        prefilledTemplate: 'Automated compliance alerts in the endpoint management portal notify system administrators immediately whenever an endpoint falls out of compliance due to uninstalled critical patches.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'patch_reporting_alerts',
      },
      {
        letter: 'e',
        text: 'the time frame within which to correct information system flaws is defined',
        prefilledTemplate: 'Correction SLAs mandate that Critical and High security patches must be installed within 14 calendar days of vendor release, with emergency zero-day patches deployed within 72 hours.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'f',
        text: 'information system flaws are corrected within the defined time frame',
        prefilledTemplate: 'Automated patch deployment rings in **Microsoft Intune** / Windows Update for Business enforce installation of security updates across 100% of workstations within the 14-day SLA, enforcing automatic reboot during maintenance windows.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'patch_sla_compliance_14days',
      },
    ],
  },
  'SI.L1-b.1.xiii': {
    controlNumber: 'SI.L1-b.1.xiii',
    family: 'SI',
    title: 'Malicious Code Protection (Antivirus / EDR)',
    objectives: [
      {
        letter: 'a',
        text: 'designated locations within organizational systems are identified for malicious code protection',
        prefilledTemplate: 'Designated locations for antivirus/EDR deployment are identified as 100% of corporate endpoints (workstations, laptops, and virtual machines), email mailboxes, and network firewalls handling FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'malicious code protection is provided at designated locations within organizational systems',
        prefilledTemplate: '**Microsoft Defender** for Endpoint / commercial EDR is installed and operational across 100% of company workstations. Real-time file inspection, cloud-delivered behavioral monitoring, and automated threat quarantine are enforced via MDM configuration profiles.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'antivirus_realtime_protection_enabled',
      },
    ],
  },
  'SI.L1-b.1.xiv': {
    controlNumber: 'SI.L1-b.1.xiv',
    family: 'SI',
    title: 'Update Malicious Code Protection Mechanisms',
    objectives: [
      {
        letter: 'a',
        text: 'malicious code protection mechanisms are updated as new releases are available',
        prefilledTemplate: 'Antivirus engine and threat intelligence signature updates are configured to download and apply automatically via **Microsoft Defender** Cloud Protection. Workstations check for definition updates every 4 hours, and administrators receive alerts if signatures become more than 48 hours outdated.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'antivirus_definitions_updated_daily',
      },
    ],
  },
  'SI.L1-b.1.xv': {
    controlNumber: 'SI.L1-b.1.xv',
    family: 'SI',
    title: 'Perform Periodic and Real-Time System Scans',
    objectives: [
      {
        letter: 'a',
        text: 'the frequency for malicious code scans is defined',
        prefilledTemplate: 'The Endpoint Security Policy defines mandatory daily quick scans at 12:00 PM and a comprehensive weekly full system scan scheduled every Friday at 7:00 PM for all endpoints handling FCI.',
        isAutoVerifiedByTelemetry: false,
      },
      {
        letter: 'b',
        text: 'malicious code scans are performed with the defined frequency',
        prefilledTemplate: 'Scheduled scans are enforced by **Microsoft Intune** MDM policies, executing automatically without user interference and logging completion results to the centralized security center.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'defender_scheduled_scan_weekly',
      },
      {
        letter: 'c',
        text: 'real-time malicious code scans of files from external sources are performed as files are downloaded, opened, or executed',
        prefilledTemplate: 'On-access real-time scanning inspects all files downloaded from the internet, web browser downloads, email attachments, and external USB flash drives upon connection, blocking and quarantining malicious payloads immediately.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'defender_realtime_on_access_scan',
      },
    ],
  },
  // ──────────────────────────────────────────────────────────────────────────
  // NIST SP 800-53 REV. 5 / 800-53A RMF CONTROLS & ATO NARRATIVE BASELINES
  // ──────────────────────────────────────────────────────────────────────────
  'AC-1': {
    "controlNumber": "AC-1",
    "family": "AC",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "an access control policy is developed, documented, and disseminated to designated personnel",
        "prefilledTemplate": "The organization develops and disseminates an official Access Control Policy addressing purpose, scope, roles, responsibilities, management commitment, and compliance across [ODP: **Azure Gov** and **AWS GovCloud** enclaves].",
        "odpParameters": [
          {
            "id": "ac1_scope",
            "label": "Cloud Enclave Scope",
            "defaultValue": "**Azure Gov** and **AWS GovCloud** enclaves"
          }
        ]
      },
      {
        "letter": "b",
        "text": "access control procedures are developed, documented, and disseminated to facilitate implementation of policy",
        "prefilledTemplate": "Access control standard operating procedures (SOPs) detailing identity provisioning, privilege escalation, and session revocation are maintained in the central compliance documentation repository."
      },
      {
        "letter": "c",
        "text": "the access control policy and procedures are reviewed and updated at the defined frequency",
        "prefilledTemplate": "The Access Control Policy and procedures are reviewed and updated [ODP: annually] or following major architectural changes by the ISSO and CISO.",
        "odpParameters": [
          {
            "id": "ac1_freq",
            "label": "Review Frequency",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'AC-2': {
    "controlNumber": "AC-2",
    "family": "AC",
    "title": "Account Management",
    "objectives": [
      {
        "letter": "a",
        "text": "the types of system accounts to support organizational missions and business functions are identified and selected",
        "prefilledTemplate": "The organization defines and documents approved system account types in the Access Control Policy, encompassing individual employee accounts, privileged administrative accounts, automated service principals, and emergency break-glass credentials in [ODP: **Azure Gov** and **AWS GovCloud** enclaves].",
        "odpParameters": [
          {
            "id": "ac2_account_types",
            "label": "Cloud Enclave Scope",
            "defaultValue": "**Azure Gov** and **AWS GovCloud** enclaves"
          }
        ]
      },
      {
        "letter": "b",
        "text": "account managers for system accounts are assigned",
        "prefilledTemplate": "Identity lifecycle management is assigned to the designated IT Identity & Access Management (IAM) Lead and Systems Engineering Team, with automated SCIM synchronization governed through **Microsoft Entra ID** Governance and AWS IAM Identity Center."
      },
      {
        "letter": "c",
        "text": "prerequisites for system access are established and validated",
        "prefilledTemplate": "Prior to account provisioning, HR and Security Officers validate prerequisite background screening (Tier 1/Tier 3 federal investigation), completion of mandatory cyber awareness training, and signed Rules of Behavior (AUP) within [ODP: 30 days of start date].",
        "odpParameters": [
          {
            "id": "ac2_prereq_timeframe",
            "label": "Onboarding Screening Window",
            "defaultValue": "30 days of start date"
          }
        ]
      },
      {
        "letter": "d",
        "text": "system accounts are authorized based on valid access authorizations, intended system usage, and other attributes required by the organization",
        "prefilledTemplate": "All user account requests require supervisor approval and ISSO sign-off via formal ticketing in ServiceNow. Role-Based Access Control (RBAC) groups determine default permissions according to least privilege.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "account_unique_id"
      },
      {
        "letter": "e",
        "text": "system accounts are reviewed for compliance with account management requirements with the defined frequency",
        "prefilledTemplate": "Privileged and standard user account access reviews are performed [ODP: semi-annually] by system owners. Automated Entra Access Reviews prompt managers to certify or revoke access for inactive or transferred personnel.",
        "odpParameters": [
          {
            "id": "ac2_review_freq",
            "label": "Account Review Frequency",
            "defaultValue": "semi-annually"
          }
        ]
      },
      {
        "letter": "f",
        "text": "system accounts are disabled within the defined time period when accounts have expired, are no longer required, or when individuals are terminated",
        "prefilledTemplate": "Accounts are immediately disabled upon employee departure via automated HR webhook triggers within [ODP: 4 hours of notification]. Inactive accounts are automatically disabled after [ODP: 35 days of inactivity].",
        "odpParameters": [
          {
            "id": "ac2_term_disable",
            "label": "Termination Deprovisioning SLA",
            "defaultValue": "4 hours of notification"
          },
          {
            "id": "ac2_inactivity_disable",
            "label": "Inactivity Threshold",
            "defaultValue": "35 days of inactivity"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "account_disable_post_pw_expiration"
      },
      {
        "letter": "g",
        "text": "system accounts are removed after the defined time period following account deactivation or expiration",
        "prefilledTemplate": "Disabled user accounts are permanently purged or archived to cold compliance retention storage after [ODP: 90 days following deactivation].",
        "odpParameters": [
          {
            "id": "ac2_purge_period",
            "label": "Account Retention Post-Disable",
            "defaultValue": "90 days following deactivation"
          }
        ]
      }
    ]
  },
  'AC-3': {
    "controlNumber": "AC-3",
    "family": "AC",
    "title": "Access Enforcement",
    "objectives": [
      {
        "letter": "a",
        "text": "the system enforces approved authorizations for logical access to information and system resources in accordance with applicable access control policies",
        "prefilledTemplate": "Logical access enforcement is executed through **Microsoft Entra ID** Conditional Access, Azure RBAC, and Linux POSIX/sudoers configurations following **DISA RHEL 9 STIG** rules. Default-deny policies block all unauthorized resource operations.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "file_permissions_unauthorized_write"
      },
      {
        "letter": "b",
        "text": "access control policies are enforced over designated subject and object types according to specified access criteria",
        "prefilledTemplate": "Subjects (authenticated users, managed identities, automated services) access objects (virtual machines, S3 buckets, SQL databases, REST APIs) strictly through cryptographic access tokens evaluated against security group membership and conditional device health posture."
      }
    ]
  },
  'AC-4': {
    "controlNumber": "AC-4",
    "family": "AC",
    "title": "Information Flow Enforcement",
    "objectives": [
      {
        "letter": "a",
        "text": "information flow control policies are enforced for approved authorizations between interconnected systems and internal enclaves",
        "prefilledTemplate": "Flow control policies are enforced at perimeter and inter-VNet boundaries using **Azure NSGs** and AWS Security Groups. Cross-boundary data flows require inspection via Next-Gen Firewalls and **Palo Alto** Panorama appliances.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "firewalld_sshd_port_enabled"
      },
      {
        "letter": "b",
        "text": "the system regulates data transfers using flow control mechanisms to prevent unauthorized exfiltration or leakage",
        "prefilledTemplate": "Egress traffic is routed through TLS-decrypting proxies with automated Data Loss Prevention (DLP) filters blocking unauthorized CUI/FCI transfers to external endpoints."
      }
    ]
  },
  'AC-6': {
    "controlNumber": "AC-6",
    "family": "AC",
    "title": "Least Privilege",
    "objectives": [
      {
        "letter": "a",
        "text": "the principle of least privilege is employed for specific categories of users and processes acting on behalf of users",
        "prefilledTemplate": "The enclave enforces least privilege by assigning users non-privileged standard accounts for everyday productivity. Administrative roles (Global Admin, Subscription Owner) are strictly managed via **Entra ID** Privileged Identity Management (PIM) with just-in-time (JIT) activation.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "sudo_remove_nopasswd"
      },
      {
        "letter": "b",
        "text": "privileged access is authorized only for designated personnel performing specific security or administrative functions",
        "prefilledTemplate": "Elevated administrative privileges require explicit justification, multi-factor re-authentication, and ticket approval. Standing administrative access is zero-tolerated across production subscriptions."
      },
      {
        "letter": "c",
        "text": "non-privileged user accounts are used when accessing non-security or general operational functions",
        "prefilledTemplate": "Engineers maintain separate accounts: user@defense.company.com for web/email/productivity, and admin-user@defense.company.com restricted strictly to administrative consoles."
      },
      {
        "letter": "d",
        "text": "privileged role sessions expire automatically after the defined time limit",
        "prefilledTemplate": "PIM elevation grants automatically expire after [ODP: 4 hours], requiring re-justification and MFA challenge for subsequent operational windows.",
        "odpParameters": [
          {
            "id": "ac6_pim_duration",
            "label": "Maximum JIT Elevation Window",
            "defaultValue": "4 hours"
          }
        ]
      }
    ]
  },
  'AC-7': {
    "controlNumber": "AC-7",
    "family": "AC",
    "title": "Unsuccessful Logon Attempts",
    "objectives": [
      {
        "letter": "a",
        "text": "the system enforces a limit of consecutive invalid logon attempts by a user during the defined time period",
        "prefilledTemplate": "The system enforces a threshold of [ODP: 3 consecutive invalid logon attempts] within a [ODP: 15-minute sliding window] across cloud identity providers and RHEL/Windows endpoints.",
        "odpParameters": [
          {
            "id": "ac7_attempts",
            "label": "Consecutive Invalid Logon Limit",
            "defaultValue": "3 consecutive invalid logon attempts"
          },
          {
            "id": "ac7_window",
            "label": "Detection Window",
            "defaultValue": "15-minute sliding window"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_passwords_pam_faillock_deny"
      },
      {
        "letter": "b",
        "text": "the system automatically locks the account until released by an administrator or until the defined time period elapses",
        "prefilledTemplate": "Upon exceeding 3 failed attempts, pam_faillock locks the account for [ODP: 30 minutes] or until explicitly unlocked by an authorized Systems Administrator.",
        "odpParameters": [
          {
            "id": "ac7_lockout_duration",
            "label": "Account Lockout Duration",
            "defaultValue": "30 minutes"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_passwords_pam_faillock_unlock_time"
      }
    ]
  },
  'AC-8': {
    "controlNumber": "AC-8",
    "family": "AC",
    "title": "System Use Notification",
    "objectives": [
      {
        "letter": "a",
        "text": "the system displays an approved system use notification message or banner before granting access",
        "prefilledTemplate": "A federally approved DoD/USG warning banner is presented prior to login across SSH (/etc/issue), Windows interactive logon (LegalNoticeText GPO), and **Microsoft Entra ID** tenant branding.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "banner_etc_issue"
      },
      {
        "letter": "b",
        "text": "the notification informs users of monitoring, no expectation of privacy, and consent to administrative inspection",
        "prefilledTemplate": "The banner text explicitly notifies users that the system is for authorized federal contractor use only, user activity is continuously monitored and audited, there is no expectation of privacy, and unauthorized access is subject to criminal prosecution."
      }
    ]
  },
  'AC-11': {
    "controlNumber": "AC-11",
    "family": "AC",
    "title": "Device Lock",
    "objectives": [
      {
        "letter": "a",
        "text": "the system initiates a session lock after the defined period of inactivity or upon receiving a request from a user",
        "prefilledTemplate": "Endpoints and servers initiate an automated session lock after [ODP: 15 minutes of inactivity] enforced via **Microsoft Intune** Configuration Profiles and Linux /etc/profile.d/autologout.sh (TMOUT=900).",
        "odpParameters": [
          {
            "id": "ac11_lock_timeout",
            "label": "Inactivity Lock Period",
            "defaultValue": "15 minutes of inactivity"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_tmout"
      },
      {
        "letter": "b",
        "text": "the session lock conceals previously visible information with a publicly viewable screen display",
        "prefilledTemplate": "Session lock immediately blanks the screen or displays a locked screen saver requiring user re-authentication via password or **FIDO2 YubiKey** before resuming operational state."
      }
    ]
  },
  'AC-14': {
    "controlNumber": "AC-14",
    "family": "AC",
    "title": "Permitted Actions without Identification or Authentication",
    "objectives": [
      {
        "letter": "a",
        "text": "the actions that can be performed on the system without identification or authentication are identified and documented",
        "prefilledTemplate": "The organization identifies and documents permitted unauthenticated actions: accessing public marketing web pages, viewing the login warning banner, and resolving public DNS A records."
      },
      {
        "letter": "b",
        "text": "the system allows user access without identification and authentication only for approved and documented actions",
        "prefilledTemplate": "All system endpoints, APIs, and administrative interfaces enforce mandatory identification and authentication; unauthenticated actions are restricted solely to the documented public landing gateway."
      }
    ]
  },
  'AC-17': {
    "controlNumber": "AC-17",
    "family": "AC",
    "title": "Remote Access",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization authorizes, monitors, and controls remote access sessions to the information system",
        "prefilledTemplate": "Remote access is restricted to corporate-managed laptops establishing an encrypted tunnel through GlobalProtect VPN with machine certificate verification and **Entra ID** Conditional Access evaluation."
      },
      {
        "letter": "b",
        "text": "the system enforces encryption of remote access sessions using approved cryptography",
        "prefilledTemplate": "All remote access traffic is encrypted in transit using **FIPS 140-3** validated IPsec (AES-256) or **TLS 1.3** ciphersuites. Split tunneling is strictly disabled by gateway profile policy.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "sshd_use_approved_ciphers"
      },
      {
        "letter": "c",
        "text": "remote access sessions are terminated automatically after the defined period of inactivity",
        "prefilledTemplate": "Remote VPN and bastion sessions automatically disconnect after [ODP: 30 minutes of idle inactivity] and require full re-authentication for reconnect.",
        "odpParameters": [
          {
            "id": "ac17_idle_disconnect",
            "label": "Remote Session Idle Disconnect",
            "defaultValue": "30 minutes of idle inactivity"
          }
        ]
      }
    ]
  },
  'AC-18': {
    "controlNumber": "AC-18",
    "family": "AC",
    "title": "Wireless Access",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization authorizes wireless access to the system prior to connection",
        "prefilledTemplate": "Corporate wireless connectivity is authorized exclusively on the PBC-SECURE WPA3-Enterprise SSID. Personal, guest, or unmanaged wireless connections to the enclave network are prohibited."
      },
      {
        "letter": "b",
        "text": "the system enforces authentication and encryption of wireless sessions using approved cryptographic protocols",
        "prefilledTemplate": "Wireless access requires 802.1X EAP-TLS certificate-based authentication using **Intune**-deployed device certificates and **AES-256** GCM encryption."
      },
      {
        "letter": "c",
        "text": "rogue wireless access points are scanned and detected at the defined frequency",
        "prefilledTemplate": "Automated Wireless Intrusion Prevention Systems (WIPS) continuously scan physical facility spectrum [ODP: continuously 24/7] and alert security on rogue broadcast transmitters.",
        "odpParameters": [
          {
            "id": "ac18_wips_cadence",
            "label": "Wireless Rogue Scan Frequency",
            "defaultValue": "continuously 24/7"
          }
        ]
      }
    ]
  },
  'AC-19': {
    "controlNumber": "AC-19",
    "family": "AC",
    "title": "Access Control for Mobile Devices",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization authorizes mobile device connections to organizational networks and systems",
        "prefilledTemplate": "Only government-furnished or enterprise-owned mobile devices enrolled in **Microsoft Intune** Mobile Device Management (MDM) are authorized to access corporate resources."
      },
      {
        "letter": "b",
        "text": "the system enforces full-disk encryption and containerized workspace isolation on mobile devices",
        "prefilledTemplate": "Mobile device policies mandate iOS/Android device encryption (**AES-256**), 6-digit biometric passcodes, remote-wipe enablement, and containerized Microsoft Outlook/Teams via **Intune** App Protection Policies."
      }
    ]
  },
  'AC-20': {
    "controlNumber": "AC-20",
    "family": "AC",
    "title": "Use of External Systems",
    "objectives": [
      {
        "letter": "a",
        "text": "terms and conditions for the use of external systems to access organizational information are established",
        "prefilledTemplate": "The organization defines Acceptable Use terms prohibiting the processing or storage of organizational CUI on unapproved personal devices (BYOD) or commercial public cloud services."
      },
      {
        "letter": "b",
        "text": "the organization verifies that external systems satisfy required security controls prior to authorizing connection",
        "prefilledTemplate": "External vendor portals and contractor laptops must provide verified Attestation of Compliance (FedRAMP Moderate or SOC 2 Type II) before SAML federation or API access is approved."
      }
    ]
  },
  'AC-22': {
    "controlNumber": "AC-22",
    "family": "AC",
    "title": "Publicly Accessible Content",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization designates individuals authorized to post information on publicly accessible systems",
        "prefilledTemplate": "Only designated Communications and Compliance officers are authorized to publish content to external-facing websites following formal multi-party review."
      },
      {
        "letter": "b",
        "text": "publicly accessible content is reviewed prior to posting to ensure non-public and controlled unclassified information is not included",
        "prefilledTemplate": "Content undergoes mandatory OPSEC and CUI screening prior to publishing. Automated scanners check web public repositories for accidental credential, PII, or CUI disclosure [ODP: weekly].",
        "odpParameters": [
          {
            "id": "ac22_scan_cadence",
            "label": "Public Repo Content Scan",
            "defaultValue": "weekly"
          }
        ]
      }
    ]
  },
  'AT-1': {
    "controlNumber": "AT-1",
    "family": "AT",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a security awareness and training policy",
        "prefilledTemplate": "The organization publishes the Security Awareness and Training Policy establishing mandatory training cadences, role-specific curriculum, and compliance tracking across the workforce."
      },
      {
        "letter": "b",
        "text": "the organization develops and disseminates security training procedures",
        "prefilledTemplate": "Training procedures detail LMS onboarding enrollment, automated overdue escalations, and mandatory remediation for failed simulated phishing assessments."
      },
      {
        "letter": "c",
        "text": "the awareness and training policy and procedures are reviewed and updated at the defined frequency",
        "prefilledTemplate": "The policy and procedures are reviewed and revised [ODP: annually] by the Director of Information Security.",
        "odpParameters": [
          {
            "id": "at1_rev_freq",
            "label": "Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'AT-2': {
    "controlNumber": "AT-2",
    "family": "AT",
    "title": "Security Awareness Training",
    "objectives": [
      {
        "letter": "a",
        "text": "basic security awareness training is provided to system users within the defined time period after onboarding",
        "prefilledTemplate": "All new personnel complete mandatory cybersecurity awareness training within [ODP: 30 days of hire] prior to granting production enclave access.",
        "odpParameters": [
          {
            "id": "at2_onboarding_window",
            "label": "New Hire Training SLA",
            "defaultValue": "30 days of hire"
          }
        ]
      },
      {
        "letter": "b",
        "text": "security awareness training is provided to system users with the defined recurring frequency thereafter",
        "prefilledTemplate": "All active employees and contractors complete annual refresher security training [ODP: annually] covering social engineering, insider threat, and incident reporting.",
        "odpParameters": [
          {
            "id": "at2_annual_freq",
            "label": "Recurring Training Frequency",
            "defaultValue": "annually"
          }
        ]
      },
      {
        "letter": "c",
        "text": "practical exercises including simulated social engineering and phishing are conducted at the defined frequency",
        "prefilledTemplate": "Simulated phishing campaigns are executed [ODP: monthly] using KnowBe4. Users failing tests are automatically enrolled in targeted micro-learning modules.",
        "odpParameters": [
          {
            "id": "at2_phish_cadence",
            "label": "Simulated Phishing Frequency",
            "defaultValue": "monthly"
          }
        ]
      }
    ]
  },
  'AT-3': {
    "controlNumber": "AT-3",
    "family": "AT",
    "title": "Role-Based Training",
    "objectives": [
      {
        "letter": "a",
        "text": "role-based cybersecurity training is provided to personnel with assigned security roles and responsibilities",
        "prefilledTemplate": "Systems administrators, security engineers, and developers complete role-based training (e.g., OWASP Top 10, Cloud Security Alliance CCSK, **DISA STIG** hardening) within [ODP: 60 days of assuming role].",
        "odpParameters": [
          {
            "id": "at3_role_window",
            "label": "Role-Based Completion Window",
            "defaultValue": "60 days of assuming role"
          }
        ]
      },
      {
        "letter": "b",
        "text": "role-based security training is provided with the defined recurring frequency thereafter",
        "prefilledTemplate": "Privileged IT and security personnel complete specialized continuing education [ODP: annually] to maintain active administrative role certifications.",
        "odpParameters": [
          {
            "id": "at3_recurring_cadence",
            "label": "Specialized Training Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'AU-1': {
    "controlNumber": "AU-1",
    "family": "AU",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates an audit and accountability policy",
        "prefilledTemplate": "The Audit and Accountability Policy establishes log generation baselines, SIEM retention obligations, and administrative audit monitoring procedures."
      },
      {
        "letter": "b",
        "text": "the audit and accountability policy and procedures are reviewed and updated at the defined frequency",
        "prefilledTemplate": "Audit policies and SIEM logging rules are reviewed and updated [ODP: annually] or after major system re-authorizations.",
        "odpParameters": [
          {
            "id": "au1_review_cadence",
            "label": "Audit Policy Review Frequency",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'AU-2': {
    "controlNumber": "AU-2",
    "family": "AU",
    "title": "Event Logging",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization identifies the types of events that the system must log to support auditing requirements",
        "prefilledTemplate": "The organization defines auditable event types in the Enclave Logging Standard, including user authentication, privilege escalation, file access to sensitive datastores, firewall rule changes, and system administration activities in [ODP: **Microsoft Sentinel** and **Splunk Cloud Gov**].",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "service_auditd_enabled",
        "odpParameters": [
          {
            "id": "au2_siem_platform",
            "label": "SIEM Logging Platform",
            "defaultValue": "**Microsoft Sentinel** and **Splunk Cloud Gov**"
          }
        ]
      },
      {
        "letter": "b",
        "text": "the system logs the identified auditable events with the required level of detail",
        "prefilledTemplate": "Audit daemon (auditd) on Linux and Windows Advanced Audit Policies forward full event telemetry via Azure Monitor Agent to centralized SIEM workspaces.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "auditd_service_enabled"
      },
      {
        "letter": "c",
        "text": "the organization reviews and updates the list of auditable events at the defined frequency",
        "prefilledTemplate": "The list of auditable events and SIEM correlation rules is reviewed and adjusted [ODP: semi-annually] based on emerging threat intelligence and CISA advisories.",
        "odpParameters": [
          {
            "id": "au2_review_freq",
            "label": "Auditable Event Review Cadence",
            "defaultValue": "semi-annually"
          }
        ]
      }
    ]
  },
  'AU-3': {
    "controlNumber": "AU-3",
    "family": "AU",
    "title": "Content of Audit Records",
    "objectives": [
      {
        "letter": "a",
        "text": "audit records contain information that establishes what type of event occurred",
        "prefilledTemplate": "Audit records explicitly establish the event type, unique event identifier (e.g., Windows Event ID, Linux syscall, syslog facility), and severity level.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "audit_rules_syslog"
      },
      {
        "letter": "b",
        "text": "audit records contain information that establishes when the event occurred, where the event occurred, the source of the event, the outcome of the event, and the identity of any individuals or subjects associated with the event",
        "prefilledTemplate": "Every log entry includes an authoritative UTC timestamp synchronized via NTP, source/destination IP addresses, process IDs, target resource identifiers, success or failure code, and authenticated user principal or service account identity."
      }
    ]
  },
  'AU-6': {
    "controlNumber": "AU-6",
    "family": "AU",
    "title": "Audit Record Review, Analysis, and Reporting",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization reviews and analyzes system audit records for indications of unusual or suspicious activity at the defined frequency",
        "prefilledTemplate": "Security Operations Center (SOC) analysts and automated SIEM analytics review audit logs [ODP: continuously 24/7 with daily automated digest reporting] for anomalies, brute-force indicators, and privilege abuse.",
        "odpParameters": [
          {
            "id": "au6_review_cadence",
            "label": "Log Review Frequency",
            "defaultValue": "continuously 24/7 with daily automated digest reporting"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "service_auditd_enabled"
      },
      {
        "letter": "b",
        "text": "the organization reports suspicious activities and findings to designated personnel within the defined time period",
        "prefilledTemplate": "Confirmed security anomalies or elevated threat indicators are alerted to the Incident Response Lead within [ODP: 15 minutes of correlation] via automated PagerDuty and Teams SOC webhooks.",
        "odpParameters": [
          {
            "id": "au6_escalation_window",
            "label": "Suspicious Activity Escalation SLA",
            "defaultValue": "15 minutes of correlation"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the system integrates audit review, analysis, and reporting with overall organizational monitoring processes",
        "prefilledTemplate": "Log correlation is integrated into Microsoft Sentinel SOAR playbooks, triggering automated isolation of compromised compute instances and identity token revocation upon alert confirmation."
      }
    ]
  },
  'AU-9': {
    "controlNumber": "AU-9",
    "family": "AU",
    "title": "Protection of Audit Information",
    "objectives": [
      {
        "letter": "a",
        "text": "the system protects audit records against unauthorized access, modification, and deletion",
        "prefilledTemplate": "Audit logs are forwarded in near-real-time to immutable Write-Once-Read-Many (WORM) cloud storage with Azure Immutable Blob Storage policies preventing modification or deletion by any account, including root/Global Administrators.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "file_permissions_var_log_audit"
      },
      {
        "letter": "b",
        "text": "audit logs are retained for the defined compliance retention period",
        "prefilledTemplate": "Audit records are retained for a minimum of [ODP: 3 years total, 1 year online] in accordance with OMB M-21-31 and FedRAMP Moderate guidelines.",
        "odpParameters": [
          {
            "id": "au9_retention_period",
            "label": "Audit Log Retention Mandate",
            "defaultValue": "3 years total, 1 year online"
          }
        ]
      }
    ]
  },
  'CA-1': {
    "controlNumber": "CA-1",
    "family": "CA",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a security assessment and authorization policy",
        "prefilledTemplate": "The Assessment, Authorization, and Monitoring Policy defines RMF lifecycle stages, independent assessment criteria, and Authorizing Official (AO) engagement."
      },
      {
        "letter": "b",
        "text": "the policy and procedures are reviewed and updated at the defined frequency",
        "prefilledTemplate": "The policy is reviewed and updated [ODP: annually] by the Lead Compliance Assessor and CISO.",
        "odpParameters": [
          {
            "id": "ca1_review_cadence",
            "label": "CA Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'CA-2': {
    "controlNumber": "CA-2",
    "family": "CA",
    "title": "Control Assessments",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization assesses security controls in the information system to determine the extent to which the controls are implemented correctly",
        "prefilledTemplate": "Independent C3PAO and internal audit teams assess all NIST SP 800-53 Rev. 5 controls prior to initial Authority to Operate (ATO) issuance and on a recurring schedule."
      },
      {
        "letter": "b",
        "text": "the organization produces a security assessment report (SAR) documenting assessment findings",
        "prefilledTemplate": "Formal Security Assessment Reports (SAR) documenting test procedures, evidence artifacts, and control deficiencies are compiled following every comprehensive audit."
      },
      {
        "letter": "c",
        "text": "security control assessments are conducted with the defined recurring frequency",
        "prefilledTemplate": "Full independent control assessments are executed [ODP: annually, with a 3-year full re-authorization cycle].",
        "odpParameters": [
          {
            "id": "ca2_assessment_frequency",
            "label": "Assessment Frequency",
            "defaultValue": "annually, with a 3-year full re-authorization cycle"
          }
        ]
      }
    ]
  },
  'CA-7': {
    "controlNumber": "CA-7",
    "family": "CA",
    "title": "Continuous Monitoring",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops a continuous monitoring strategy and implements a continuous monitoring program",
        "prefilledTemplate": "The organization executes a Continuous Monitoring (ConMon) plan integrating automated vulnerability scans, STIG compliance checks, configuration change audits, and monthly security metric reports."
      },
      {
        "letter": "b",
        "text": "the organization establishes continuous monitoring metrics to be tracked and evaluated",
        "prefilledTemplate": "Key metrics include mean-time-to-remediate (MTTR) critical flaws, patch compliance percentage, unauthorized privileged events, and MFA adoption rates."
      },
      {
        "letter": "c",
        "text": "continuous monitoring results are reported to the Authorizing Official (AO) at the defined frequency",
        "prefilledTemplate": "ConMon reports and updated POA&Ms are submitted to the Authorizing Official [ODP: monthly].",
        "odpParameters": [
          {
            "id": "ca7_reporting_cadence",
            "label": "AO ConMon Reporting Cadence",
            "defaultValue": "monthly"
          }
        ]
      }
    ]
  },
  'CM-1': {
    "controlNumber": "CM-1",
    "family": "CM",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a configuration management policy",
        "prefilledTemplate": "The Configuration Management Policy establishes baselines, change control board (CCB) charters, and automated drift prevention standards."
      },
      {
        "letter": "b",
        "text": "configuration management policy and procedures are reviewed at the defined frequency",
        "prefilledTemplate": "The policy and procedures are reviewed [ODP: annually] by the Configuration Manager.",
        "odpParameters": [
          {
            "id": "cm1_rev_cadence",
            "label": "CM Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'CM-2': {
    "controlNumber": "CM-2",
    "family": "CM",
    "title": "Baseline Configuration",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and maintains under configuration control, a current baseline configuration of the system",
        "prefilledTemplate": "The organization develops and maintains hardened baseline configurations for virtual machines, container images, and network components derived from [ODP: **DISA STIG**s and CIS Benchmark Level 2]. Baseline templates are codified as **Terraform/Ansible IaC**.",
        "odpParameters": [
          {
            "id": "cm2_baseline_standard",
            "label": "Hardening Standard",
            "defaultValue": "**DISA STIG**s and CIS Benchmark Level 2"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "aide_periodic_checking_systemd_timer"
      },
      {
        "letter": "b",
        "text": "the baseline configuration is reviewed and updated at the defined frequency",
        "prefilledTemplate": "System baseline images are updated and re-certified [ODP: monthly following Microsoft/Red Hat patch cycles or immediately after critical zero-day disclosures].",
        "odpParameters": [
          {
            "id": "cm2_baseline_update_freq",
            "label": "Baseline Refresh Cadence",
            "defaultValue": "monthly following Microsoft/Red Hat patch cycles"
          }
        ]
      },
      {
        "letter": "c",
        "text": "baseline configurations are retained to support rollback and disaster recovery operations",
        "prefilledTemplate": "Versioned golden AMI/VHD images and Git commits are retained in the Azure Container Registry and Git repository with automated rollback capabilities."
      }
    ]
  },
  'CM-3': {
    "controlNumber": "CM-3",
    "family": "CM",
    "title": "Configuration Change Control",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization determines the types of changes to the system that are configuration-controlled",
        "prefilledTemplate": "All changes to operating systems, firewall rules, security group policies, identity roles, and core application code require formal change control tickets in Jira Service Management."
      },
      {
        "letter": "b",
        "text": "the organization approves configuration-controlled changes to the system with the explicit consideration of security impact analyses",
        "prefilledTemplate": "Security Impact Analyses (SIAs) are performed by the ISSO prior to approving changes. The Change Control Board (CCB) reviews and signs off on high-impact changes weekly."
      },
      {
        "letter": "c",
        "text": "the organization documents and approves configuration change decisions",
        "prefilledTemplate": "Approved change tickets document risk evaluation, test results in staging, rollback steps, and designated implementation windows."
      },
      {
        "letter": "d",
        "text": "the organization tests, validates, and documents changes to the system prior to implementing changes in production",
        "prefilledTemplate": "All configuration changes are staged and automated CI/CD unit and integration tests validate security controls before production promotion."
      }
    ]
  },
  'CM-7': {
    "controlNumber": "CM-7",
    "family": "CM",
    "title": "Least Functionality",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization configures the system to provide only essential capabilities and prohibits or restricts the use of functions, ports, protocols, and services",
        "prefilledTemplate": "Servers and containers are stripped of non-essential packages (compilers, Telnet, FTP, games). Unused ports and listening daemons are blocked by default via host firewalls and network security group access lists.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "package_telnet_removed"
      },
      {
        "letter": "b",
        "text": "the organization reviews the system at the defined frequency to identify and eliminate unnecessary functions, ports, protocols, and services",
        "prefilledTemplate": "Automated OpenSCAP and Tenable vulnerability scans audit open ports and services [ODP: weekly], alerting on unauthorized listening sockets.",
        "odpParameters": [
          {
            "id": "cm7_scan_cadence",
            "label": "Unnecessary Port Scan Cadence",
            "defaultValue": "weekly"
          }
        ]
      },
      {
        "letter": "c",
        "text": "unauthorized or unapproved software execution is prevented using software restriction mechanisms",
        "prefilledTemplate": "Application Whitelisting / AppLocker and Linux fapolicyd restrict execution strictly to digitally signed binaries and approved system directories.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "service_fapolicyd_enabled"
      }
    ]
  },
  'CM-8': {
    "controlNumber": "CM-8",
    "family": "CM",
    "title": "Information System Component Inventory",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops and documents an inventory of system components that reflects the current system",
        "prefilledTemplate": "An automated component inventory tracks all hardware, virtual machines, cloud PaaS resources, and network equipment in the Asset Inventory module, integrating Azure Resource Graph and AWS Config.",
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the component inventory is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The inventory is updated [ODP: continuously via cloud API webhooks and audited monthly] by the IT Infrastructure Lead.",
        "odpParameters": [
          {
            "id": "cm8_inventory_audit_freq",
            "label": "Inventory Audit Cadence",
            "defaultValue": "continuously via cloud API webhooks and audited monthly"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the inventory includes relevant component details such as manufacturer, model, OS, MAC/IP address, and system ownership",
        "prefilledTemplate": "Every component record includes UUID, hostname, IP address, MAC, operating system patch level, physical/logical location, and responsible administrator."
      }
    ]
  },
  'CP-1': {
    "controlNumber": "CP-1",
    "family": "CP",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a contingency planning policy",
        "prefilledTemplate": "The Contingency Planning Policy establishes business continuity goals, maximum tolerable downtime (MTD), and disaster recovery mandates."
      },
      {
        "letter": "b",
        "text": "the contingency planning policy and procedures are reviewed at the defined frequency",
        "prefilledTemplate": "Contingency policies are reviewed [ODP: annually] by the Business Continuity Steering Committee.",
        "odpParameters": [
          {
            "id": "cp1_review_cadence",
            "label": "CP Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'CP-2': {
    "controlNumber": "CP-2",
    "family": "CP",
    "title": "Contingency Plan",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops a contingency plan for the system that addresses system restoration without compromising security",
        "prefilledTemplate": "The System Contingency Plan (CP) details roles, disaster recovery procedures, alternate site activation, and step-by-step restoration sequences for cloud infrastructure."
      },
      {
        "letter": "b",
        "text": "the contingency plan is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The Contingency Plan is reviewed, updated, and re-approved by executive leadership [ODP: annually] or after significant infrastructure refactoring.",
        "odpParameters": [
          {
            "id": "cp2_review_cadence",
            "label": "Contingency Plan Review Cadence",
            "defaultValue": "annually"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the contingency plan establishes recovery objectives including Recovery Time Objective (RTO) and Recovery Point Objective (RPO)",
        "prefilledTemplate": "The plan codifies an RTO of [ODP: 4 hours] and an RPO of [ODP: 1 hour] for critical CUI datastores.",
        "odpParameters": [
          {
            "id": "cp2_rto",
            "label": "Recovery Time Objective (RTO)",
            "defaultValue": "4 hours"
          },
          {
            "id": "cp2_rpo",
            "label": "Recovery Point Objective (RPO)",
            "defaultValue": "1 hour"
          }
        ]
      }
    ]
  },
  'CP-4': {
    "controlNumber": "CP-4",
    "family": "CP",
    "title": "Contingency Plan Testing",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization tests the contingency plan for the system at the defined frequency using approved test methods",
        "prefilledTemplate": "The organization executes a simulated disaster recovery failover drill and tabletop exercise [ODP: annually] involving all primary and alternate incident response team members.",
        "odpParameters": [
          {
            "id": "cp4_test_cadence",
            "label": "Disaster Recovery Exercise Cadence",
            "defaultValue": "annually"
          }
        ]
      },
      {
        "letter": "b",
        "text": "the organization documents test results in a contingency plan test report",
        "prefilledTemplate": "After Action Reports (AARs) document test timing, simulated failover success, identified communication gaps, and necessary plan revisions."
      },
      {
        "letter": "c",
        "text": "the organization updates the contingency plan to address shortcomings identified during testing",
        "prefilledTemplate": "Remediation action items from tests are logged in the POA&M and incorporated into the Contingency Plan within [ODP: 30 days of test completion].",
        "odpParameters": [
          {
            "id": "cp4_update_window",
            "label": "Plan Revision SLA Post-Test",
            "defaultValue": "30 days of test completion"
          }
        ]
      }
    ]
  },
  'CP-9': {
    "controlNumber": "CP-9",
    "family": "CP",
    "title": "System Backup",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization conducts backups of user-level information and system-level information at the defined frequency",
        "prefilledTemplate": "System backups execute [ODP: daily incremental and weekly full backups] managed via Azure Backup Services and AWS Backup across all storage volumes and SQL databases.",
        "odpParameters": [
          {
            "id": "cp9_backup_cadence",
            "label": "Backup Schedule",
            "defaultValue": "daily incremental and weekly full backups"
          }
        ],
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the organization protects the confidentiality, integrity, and availability of backup information at storage locations",
        "prefilledTemplate": "Backups are encrypted in transit and at rest using **FIPS 140-3** validated **AES-256** keys. Geo-redundant storage (GRS) replicates backups to an alternate federal region separated by >500 miles."
      },
      {
        "letter": "c",
        "text": "the organization tests backup information at the defined frequency to verify media reliability and information integrity",
        "prefilledTemplate": "Automated test restoration of sample database tables and file shares is conducted [ODP: monthly] to validate data integrity without interrupting live production.",
        "odpParameters": [
          {
            "id": "cp9_restore_test_cadence",
            "label": "Test Restoration Cadence",
            "defaultValue": "monthly"
          }
        ]
      }
    ]
  },
  'IA-1': {
    "controlNumber": "IA-1",
    "family": "IA",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates an identification and authentication policy",
        "prefilledTemplate": "The Identification and Authentication Policy establishes mandatory MFA requirements, cryptographic authenticator lifecycles, and prohibited credential sharing."
      },
      {
        "letter": "b",
        "text": "the identification and authentication policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by the Chief Information Security Officer.",
        "odpParameters": [
          {
            "id": "ia1_review_cadence",
            "label": "IA Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'IA-2': {
    "controlNumber": "IA-2",
    "family": "IA",
    "title": "Identification and Authentication (Organizational Users)",
    "objectives": [
      {
        "letter": "a",
        "text": "the system uniquely identifies and authenticates organizational users or processes acting on behalf of organizational users",
        "prefilledTemplate": "Every user is assigned an individual, non-shared User Principal Name (UPN) formatted as user@defense.company.com managed through **Microsoft Entra ID** Government and synced to **Active Directory**.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_password_pam_minlen"
      },
      {
        "letter": "b",
        "text": "the system implements multi-factor authentication (MFA) for network access to privileged and non-privileged accounts",
        "prefilledTemplate": "Conditional Access enforces mandatory Multi-Factor Authentication (MFA) using Microsoft Authenticator (number matching enabled) or **FIDO2 YubiKey** hardware security keys for all network logon sessions.",
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "c",
        "text": "the system implements phishing-resistant multi-factor authentication for privileged administrative access",
        "prefilledTemplate": "Privileged administrative roles require phishing-resistant **FIDO2 YubiKey** hardware tokens (YubiKey 5 FIPS) or DoD Common Access Cards (CAC) / PIV credentials. SMS and voice phone calls are disabled."
      },
      {
        "letter": "d",
        "text": "the system implements multi-factor authentication for local access to privileged accounts",
        "prefilledTemplate": "Local console access on servers requires smartcard/PIV authentication or Duo MFA hardware tokens; static local administrator passwords are stored in Azure Key Vault with 12-hour automated rotation."
      }
    ]
  },
  'IA-5': {
    "controlNumber": "IA-5",
    "family": "IA",
    "title": "Authenticator Management",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization manages system authenticators by establishing initial authenticator distribution procedures",
        "prefilledTemplate": "Temporary passwords are randomly generated with high entropy, distributed securely out-of-band via encrypted SMS/voice verification, and forced to change upon first logon."
      },
      {
        "letter": "b",
        "text": "the system enforces minimum password length and complexity requirements",
        "prefilledTemplate": "Passphrases must be a minimum of [ODP: 15 characters] containing uppercase, lowercase, numbers, and symbols, enforced via Entra Password Protection and Linux pam_pwquality.",
        "odpParameters": [
          {
            "id": "ia5_min_password_len",
            "label": "Minimum Password Length",
            "defaultValue": "15 characters"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_password_pam_minlen"
      },
      {
        "letter": "c",
        "text": "the system enforces password lifetime and expiration at the defined frequency when MFA is not utilized",
        "prefilledTemplate": "Where legacy authenticators exist without **FIDO2 YubiKey**, passwords expire every [ODP: 90 days]. Where phishing-resistant MFA is strictly enforced, password expirations follow NIST SP 800-63B guidelines prohibiting arbitrary expiration.",
        "odpParameters": [
          {
            "id": "ia5_password_rotation_cadence",
            "label": "Password Rotation Cadence",
            "defaultValue": "90 days"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_password_pam_maxindays"
      },
      {
        "letter": "d",
        "text": "the system prohibits password reuse for the defined number of generations",
        "prefilledTemplate": "The system remembers previous passwords and prohibits reuse for [ODP: 24 password generations] via pam_pwhistory and **Active Directory** GPO.",
        "odpParameters": [
          {
            "id": "ia5_password_history",
            "label": "Password History Buffer",
            "defaultValue": "24 password generations"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "accounts_password_pam_remember"
      }
    ]
  },
  'IR-1': {
    "controlNumber": "IR-1",
    "family": "IR",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates an incident response policy",
        "prefilledTemplate": "The Incident Response Policy establishes incident severities, escalation chains of command, and federal reporting thresholds."
      },
      {
        "letter": "b",
        "text": "the incident response policy and procedures are reviewed at the defined frequency",
        "prefilledTemplate": "The IR policy is reviewed and updated [ODP: annually] by the Incident Response Commander.",
        "odpParameters": [
          {
            "id": "ir1_review_cadence",
            "label": "IR Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'IR-4': {
    "controlNumber": "IR-4",
    "family": "IR",
    "title": "Incident Handling",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization implements an incident handling capability for security incidents that includes preparation, detection, containment, eradication, and recovery",
        "prefilledTemplate": "The organization maintains an Incident Response Team (IRT) supported by a 24/7 Managed Detection and Response (MDR) provider. Standardized playbooks govern ransomware, credential theft, and unauthorized exfiltration."
      },
      {
        "letter": "b",
        "text": "the organization coordinates incident handling activities with contingency planning personnel",
        "prefilledTemplate": "IR procedures integrate with disaster recovery failover triggers when containment requires isolating critical production workloads."
      },
      {
        "letter": "c",
        "text": "the organization incorporates lessons learned from incident handling activities into incident response procedures and training",
        "prefilledTemplate": "Post-incident reviews (Root Cause Analyses) are conducted within [ODP: 14 days of incident resolution], updating SIEM correlation rules and playbooks.",
        "odpParameters": [
          {
            "id": "ir4_post_incident_window",
            "label": "Post-Mortem Review Window",
            "defaultValue": "14 days of incident resolution"
          }
        ]
      }
    ]
  },
  'IR-6': {
    "controlNumber": "IR-6",
    "family": "IR",
    "title": "Incident Reporting",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization requires personnel to report suspected security incidents to the incident response authority within the defined time period",
        "prefilledTemplate": "Personnel must report suspected incidents to the SOC within [ODP: 1 hour of discovery] via the emergency hotline or the Report Phishing button in Outlook.",
        "odpParameters": [
          {
            "id": "ir6_internal_report_sla",
            "label": "Internal Reporting SLA",
            "defaultValue": "1 hour of discovery"
          }
        ]
      },
      {
        "letter": "b",
        "text": "the organization reports security incidents to designated external authorities within specified timeframes",
        "prefilledTemplate": "Confirmed cyber incidents affecting CUI or federal data are reported to DoD DC3 within [ODP: 72 hours] pursuant to DFARS 252.204-7012 and to US-CERT / CISA within [ODP: 1 hour for major incidents].",
        "odpParameters": [
          {
            "id": "ir6_dod_reporting_window",
            "label": "DoD DC3 Reporting Mandate",
            "defaultValue": "72 hours"
          },
          {
            "id": "ir6_cisa_reporting_window",
            "label": "CISA Emergency Reporting Mandate",
            "defaultValue": "1 hour for major incidents"
          }
        ]
      }
    ]
  },
  'MA-1': {
    "controlNumber": "MA-1",
    "family": "MA",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a system maintenance policy",
        "prefilledTemplate": "The System Maintenance Policy governs preventive maintenance windows, vendor escort protocols, and remote diagnostic session controls."
      },
      {
        "letter": "b",
        "text": "the maintenance policy is reviewed at the defined frequency",
        "prefilledTemplate": "Maintenance policies are reviewed [ODP: annually] by the Director of Cloud Operations.",
        "odpParameters": [
          {
            "id": "ma1_review_cadence",
            "label": "MA Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'MA-2': {
    "controlNumber": "MA-2",
    "family": "MA",
    "title": "Controlled Maintenance",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization schedules, performs, and documents maintenance and repairs on system components in accordance with manufacturer or vendor specifications",
        "prefilledTemplate": "Maintenance is scheduled during off-peak maintenance windows ([ODP: Sundays 02:00-06:00 EST]) and documented in change management tickets.",
        "odpParameters": [
          {
            "id": "ma2_maintenance_window",
            "label": "Scheduled Maintenance Window",
            "defaultValue": "Sundays 02:00-06:00 EST"
          }
        ]
      },
      {
        "letter": "b",
        "text": "the organization approves and monitors all maintenance activities",
        "prefilledTemplate": "On-premise hardware maintenance requires physical escort by an authorized technician. Cloud infrastructure maintenance is monitored via cloud provider trust center notices."
      },
      {
        "letter": "c",
        "text": "the organization inspects maintenance tools prior to connection to the system",
        "prefilledTemplate": "Vendor diagnostic tools and USB keys are checked for malware and approved by the ISSO prior to connecting to any enclave server."
      }
    ]
  },
  'MA-4': {
    "controlNumber": "MA-4",
    "family": "MA",
    "title": "Nonlocal Maintenance",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization authorizes nonlocal maintenance sessions before connections are established",
        "prefilledTemplate": "Remote vendor maintenance sessions require prior authorization and are established strictly via temporary, supervised screen-sharing sessions."
      },
      {
        "letter": "b",
        "text": "the system enforces strong authenticators and encryption for nonlocal maintenance sessions",
        "prefilledTemplate": "Nonlocal maintenance is conducted over **TLS 1.3** encrypted bastion hosts with MFA authentication and full session keystroke recording."
      },
      {
        "letter": "c",
        "text": "the organization monitors and terminates nonlocal maintenance sessions when maintenance is complete",
        "prefilledTemplate": "An internal systems administrator oversees the remote technician session at all times and immediately terminates remote access upon work completion."
      }
    ]
  },
  'MP-1': {
    "controlNumber": "MP-1",
    "family": "MP",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a media protection policy",
        "prefilledTemplate": "The Media Protection Policy establishes markings, transport safeguards, sanitization protocols, and USB restrictions for digital and physical media."
      },
      {
        "letter": "b",
        "text": "the media protection policy is reviewed at the defined frequency",
        "prefilledTemplate": "Media protection policies are reviewed [ODP: annually] by the Compliance Director.",
        "odpParameters": [
          {
            "id": "mp1_review_cadence",
            "label": "MP Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'MP-6': {
    "controlNumber": "MP-6",
    "family": "MP",
    "title": "Media Sanitization",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization sanitizes system media prior to disposal, release out of organizational control, or release for reuse",
        "prefilledTemplate": "All digital media (hard drives, SSDs, backup tapes) are sanitized per **NIST SP 800-88 Rev 1 crypto-wipe**.",
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the organization employs sanitization mechanisms with the strength and integrity commensurate with the security category or classification of the information",
        "prefilledTemplate": "Cloud virtual disks are cryptographically erased upon resource de-allocation via Azure storage crypto-erase mechanisms."
      },
      {
        "letter": "c",
        "text": "the organization verifies and documents media sanitization actions",
        "prefilledTemplate": "Certificates of Destruction detailing drive serial numbers, date, method, and witness signatures are maintained for [ODP: 5 years] in the Compliance Vault.",
        "odpParameters": [
          {
            "id": "mp6_cert_retention",
            "label": "Certificate of Destruction Retention",
            "defaultValue": "5 years"
          }
        ]
      }
    ]
  },
  'PE-1': {
    "controlNumber": "PE-1",
    "family": "PE",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a physical and environmental protection policy",
        "prefilledTemplate": "The Physical Security Policy governs badge access, visitor escorting, HVAC monitoring, and fire suppression for corporate facilities."
      },
      {
        "letter": "b",
        "text": "the physical security policy is reviewed at the defined frequency",
        "prefilledTemplate": "Physical security policies are reviewed [ODP: annually] by the Facilities and Security Manager.",
        "odpParameters": [
          {
            "id": "pe1_review_cadence",
            "label": "PE Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'PE-2': {
    "controlNumber": "PE-2",
    "family": "PE",
    "title": "Physical Access Authorizations",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops and keeps current a list of personnel with authorized access to facilities containing system components",
        "prefilledTemplate": "The organization maintains an access list in the electronic badge system designating authorized personnel for server rooms and sensitive project areas."
      },
      {
        "letter": "b",
        "text": "the organization reviews and updates the physical access authorization list at the defined frequency",
        "prefilledTemplate": "Physical facility access lists are reviewed and reconciled against HR employment rolls [ODP: quarterly].",
        "odpParameters": [
          {
            "id": "pe2_audit_cadence",
            "label": "Physical Access Roster Review",
            "defaultValue": "quarterly"
          }
        ]
      }
    ]
  },
  'PE-3': {
    "controlNumber": "PE-3",
    "family": "PE",
    "title": "Physical Access Control",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization enforces physical access control at entry and exit points to facilities containing system components",
        "prefilledTemplate": "Perimeter doors and internal server spaces enforce **RFID badges** and biometric door locks with anti-passback controls."
      },
      {
        "letter": "b",
        "text": "the organization controls physical access to system components by monitoring physical access logs",
        "prefilledTemplate": "Badge entry attempts are logged to an immutable physical security database and CCTV cameras record all ingress/egress points with [ODP: **90-day CCTV retention**].",
        "odpParameters": [
          {
            "id": "pe3_cctv_retention",
            "label": "CCTV Footage Retention",
            "defaultValue": "**90-day CCTV retention**"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the organization escorts visitors and monitors visitor activity in sensitive areas",
        "prefilledTemplate": "Visitors must present government ID, sign the physical visitor ledger, wear visitor badges, and remain under continuous escort by cleared personnel."
      }
    ]
  },
  'PL-1': {
    "controlNumber": "PL-1",
    "family": "PL",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a security and privacy planning policy",
        "prefilledTemplate": "The Security Planning Policy establishes System Security Plan (SSP) authoring standards, boundary scoping, and Authorizing Official coordination."
      },
      {
        "letter": "b",
        "text": "the planning policy is reviewed at the defined frequency",
        "prefilledTemplate": "Planning policies are reviewed [ODP: annually] by the Principal GRC Architect.",
        "odpParameters": [
          {
            "id": "pl1_review_cadence",
            "label": "PL Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'PL-2': {
    "controlNumber": "PL-2",
    "family": "PL",
    "title": "System Security and Privacy Plan",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops a System Security and Privacy Plan (SSP) that describes system boundaries, operational environment, and control implementations",
        "prefilledTemplate": "The organization authors and maintains a comprehensive System Security Plan (SSP) in the Singularity GRC platform detailing cloud and on-premise security boundaries."
      },
      {
        "letter": "b",
        "text": "the system security plan is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The SSP is reviewed, updated, and re-approved by the Authorizing Official [ODP: annually or upon significant system modification].",
        "odpParameters": [
          {
            "id": "pl2_update_cadence",
            "label": "SSP Review Cadence",
            "defaultValue": "annually or upon significant system modification"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the system security plan is distributed to designated individuals with authorization and need-to-know",
        "prefilledTemplate": "The SSP is stored in the encrypted Singularity repository with RBAC restricting read/edit access strictly to authorized compliance officers and federal auditors."
      }
    ]
  },
  'PL-4': {
    "controlNumber": "PL-4",
    "family": "PL",
    "title": "Rules of Behavior",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization establishes rules of behavior for individuals accessing the system",
        "prefilledTemplate": "The Acceptable Use Policy / Rules of Behavior (RoB) outlines user responsibilities, authorized device handling, password standards, and social media constraints."
      },
      {
        "letter": "b",
        "text": "the organization verifies that individuals sign an acknowledgment indicating they have read and agree to abide by the rules of behavior before granting access and at the defined frequency thereafter",
        "prefilledTemplate": "Users sign electronic RoB acknowledgments during initial onboarding and [ODP: annually thereafter] as part of cybersecurity awareness training.",
        "odpParameters": [
          {
            "id": "pl4_rob_signature_freq",
            "label": "Rules of Behavior Re-signing Cadence",
            "defaultValue": "annually thereafter"
          }
        ]
      }
    ]
  },
  'PM-1': {
    "controlNumber": "PM-1",
    "family": "PM",
    "title": "Information Security Program Plan",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops and disseminates an organization-wide information security program plan",
        "prefilledTemplate": "The Executive Leadership team approves an Information Security Program Plan defining governance structures, budget allocation, and executive accountability."
      },
      {
        "letter": "b",
        "text": "the information security program plan is reviewed at the defined frequency",
        "prefilledTemplate": "The Information Security Program Plan is reviewed and updated [ODP: biennially (every 2 years)] by the CISO and Board of Directors.",
        "odpParameters": [
          {
            "id": "pm1_review_cadence",
            "label": "Program Plan Review Cadence",
            "defaultValue": "biennially (every 2 years)"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the information security program plan is updated to reflect organizational changes and emerging cybersecurity priorities",
        "prefilledTemplate": "Updates reflect evolving federal mandates (e.g., CMMC 2.0, NIST SP 800-53 Rev. 5, OMB memoranda)."
      }
    ]
  },
  'PM-9': {
    "controlNumber": "PM-9",
    "family": "PM",
    "title": "Risk Management Strategy",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops a comprehensive risk management strategy that addresses risk tolerance, identification, and mitigation",
        "prefilledTemplate": "The enterprise Risk Management Strategy outlines threat likelihood scoring, impact matrices, and formal risk acceptance thresholds for CUI and operational systems."
      },
      {
        "letter": "b",
        "text": "the risk management strategy is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The Risk Management Strategy is reviewed and refreshed [ODP: annually] by the Enterprise Risk Committee.",
        "odpParameters": [
          {
            "id": "pm9_review_cadence",
            "label": "Risk Strategy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the strategy is integrated into the organizational System Development Life Cycle (SDLC) and procurement processes",
        "prefilledTemplate": "Risk assessments are mandatory gates in software deployment pipelines and vendor acquisition onboarding."
      }
    ]
  },
  'PS-1': {
    "controlNumber": "PS-1",
    "family": "PS",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a personnel security policy",
        "prefilledTemplate": "The Personnel Security Policy defines background check standards, employee transfer processes, and immediate access termination mandates."
      },
      {
        "letter": "b",
        "text": "the personnel security policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by Human Resources and the Chief Compliance Officer.",
        "odpParameters": [
          {
            "id": "ps1_review_cadence",
            "label": "PS Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'PS-2': {
    "controlNumber": "PS-2",
    "family": "PS",
    "title": "Position Risk Designation",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization assigns a risk designation to all organizational positions",
        "prefilledTemplate": "Every job role is categorized as High, Moderate, or Low Risk based on access to privileged credentials, financial systems, or Controlled Unclassified Information (CUI)."
      },
      {
        "letter": "b",
        "text": "the organization establishes screening criteria for individuals filling positions of differing risk levels",
        "prefilledTemplate": "High-risk positions mandate **Tier 1/3/5 background checks**."
      }
    ]
  },
  'PS-3': {
    "controlNumber": "PS-3",
    "family": "PS",
    "title": "Personnel Screening",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization screens individuals prior to authorizing access to the system",
        "prefilledTemplate": "Candidates undergo comprehensive criminal background, credit, drug screening, and identity verification before account credentials are provisioned."
      },
      {
        "letter": "b",
        "text": "the organization rescreens personnel at the defined frequency",
        "prefilledTemplate": "Personnel in sensitive or privileged roles undergo recurring background rescreening every [ODP: 5 years] or upon assignment to classified defense contracts.",
        "odpParameters": [
          {
            "id": "ps3_rescreen_period",
            "label": "Rescreening Frequency",
            "defaultValue": "5 years"
          }
        ]
      }
    ]
  },
  'PS-4': {
    "controlNumber": "PS-4",
    "family": "PS",
    "title": "Personnel Termination",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization disables system access within the defined time period upon termination of employment",
        "prefilledTemplate": "HR ticketing triggers automated deprovisioning in **Entra ID**, revoking all tokens, active sessions, and VPN access within [ODP: 4 hours of notification] (or immediately for involuntary terminations).",
        "odpParameters": [
          {
            "id": "ps4_termination_sla",
            "label": "Deprovisioning SLA Upon Separation",
            "defaultValue": "4 hours of notification"
          }
        ],
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the organization conducts exit interviews and retrieves all organizational property",
        "prefilledTemplate": "HR conducts formal exit interviews, reviews continuing NDA/CUI obligations, and retrieves corporate laptops, security keys, and building badges."
      },
      {
        "letter": "c",
        "text": "the organization retains termination records to verify timely deprovisioning compliance",
        "prefilledTemplate": "Completed termination checklists with audit timestamps are stored in the employee HR compliance file."
      }
    ]
  },
  'PT-1': {
    "controlNumber": "PT-1",
    "family": "PT",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a PII processing and transparency policy",
        "prefilledTemplate": "The Privacy and PII Protection Policy governs collection, processing, retention, and lawful disclosure of personally identifiable information."
      },
      {
        "letter": "b",
        "text": "the PII processing and transparency policy is reviewed at the defined frequency",
        "prefilledTemplate": "The privacy policy is reviewed [ODP: annually] by the Chief Privacy Officer.",
        "odpParameters": [
          {
            "id": "pt1_review_cadence",
            "label": "Privacy Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'PT-2': {
    "controlNumber": "PT-2",
    "family": "PT",
    "title": "Authority to Process Personally Identifiable Information",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization determines and documents the legal authority that permits the processing of PII",
        "prefilledTemplate": "The organization maintains legal and contractual documentation establishing lawful basis for processing employee and contractor personal data under federal guidelines."
      },
      {
        "letter": "b",
        "text": "the organization maintains an inventory of all PII processing systems",
        "prefilledTemplate": "Privacy Impact Assessments (PIAs) document data flow, storage endpoints, and access boundaries for any enclave storing PII."
      }
    ]
  },
  'PT-3': {
    "controlNumber": "PT-3",
    "family": "PT",
    "title": "Privacy Notice",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization provides a privacy notice to individuals regarding the processing of PII",
        "prefilledTemplate": "A prominent Privacy Notice is published on all public web interfaces and in employee onboarding portals detailing collected data, purpose, and rights."
      },
      {
        "letter": "b",
        "text": "the privacy notice is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The Privacy Notice is reviewed and updated [ODP: annually] or upon changes in data collection practices.",
        "odpParameters": [
          {
            "id": "pt3_review_cadence",
            "label": "Privacy Notice Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'RA-1': {
    "controlNumber": "RA-1",
    "family": "RA",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a risk assessment policy",
        "prefilledTemplate": "The Risk Assessment Policy defines vulnerability scanning cadences, threat modeling methodologies, and risk mitigation SLAs."
      },
      {
        "letter": "b",
        "text": "the risk assessment policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by the Information System Security Manager (ISSM).",
        "odpParameters": [
          {
            "id": "ra1_review_cadence",
            "label": "RA Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'RA-3': {
    "controlNumber": "RA-3",
    "family": "RA",
    "title": "Risk Assessment",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization assesses the risk, including the likelihood and magnitude of harm, from the unauthorized access, use, disclosure, disruption, modification, or destruction of the system and the information it processes",
        "prefilledTemplate": "Formal risk assessments evaluate internal and external threat actors against NIST SP 800-30 Rev. 1 criteria, scoring threats by likelihood and operational impact."
      },
      {
        "letter": "b",
        "text": "the organization conducts risk assessments at the defined frequency or upon significant architectural changes",
        "prefilledTemplate": "Risk assessments are conducted [ODP: annually or prior to deploying major infrastructure changes].",
        "odpParameters": [
          {
            "id": "ra3_frequency",
            "label": "Risk Assessment Cadence",
            "defaultValue": "annually or prior to deploying major infrastructure changes"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the organization documents risk assessment results in a formal risk assessment report",
        "prefilledTemplate": "Results are documented in the Security Assessment Report (SAR) and tracked via the Singularity POA&M dashboard."
      }
    ]
  },
  'RA-5': {
    "controlNumber": "RA-5",
    "family": "RA",
    "title": "Vulnerability Monitoring and Scanning",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization monitors for vulnerabilities in the system and application components using automated scanning tools at the defined frequency",
        "prefilledTemplate": "Automated vulnerability scans are performed [ODP: weekly for operating systems and containers, and monthly for web applications] using Tenable Nessus and **Microsoft Defender** for Cloud.",
        "odpParameters": [
          {
            "id": "ra5_scan_cadence",
            "label": "Vulnerability Scanning Cadence",
            "defaultValue": "weekly for operating systems and containers, and monthly for web applications"
          }
        ],
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the organization analyzes vulnerability scan reports and results from other sources",
        "prefilledTemplate": "Scan results are triaged within 24 hours of scan completion. False positives are validated and documented with ISSO approval."
      },
      {
        "letter": "c",
        "text": "the organization remediates legitimate vulnerabilities in accordance with organizational risk assessments and defined remediation timeframes",
        "prefilledTemplate": "Critical vulnerabilities are remediated within [ODP: 15 days], High within [ODP: 30 days], and Moderate within [ODP: 90 days] in alignment with FedRAMP standards.",
        "odpParameters": [
          {
            "id": "ra5_crit_sla",
            "label": "Critical Vulnerability SLA",
            "defaultValue": "15 days"
          },
          {
            "id": "ra5_high_sla",
            "label": "High Vulnerability SLA",
            "defaultValue": "30 days"
          },
          {
            "id": "ra5_mod_sla",
            "label": "Moderate Vulnerability SLA",
            "defaultValue": "90 days"
          }
        ]
      },
      {
        "letter": "d",
        "text": "the organization shares vulnerability information with designated personnel and collaborative security entities",
        "prefilledTemplate": "Discovered zero-days and active exploit attempts are shared with CISA and vendor threat research groups."
      }
    ]
  },
  'SA-1': {
    "controlNumber": "SA-1",
    "family": "SA",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a system and services acquisition policy",
        "prefilledTemplate": "The Acquisition Security Policy establishes vendor vetting criteria, FedRAMP authorization mandates, and supply chain integrity requirements."
      },
      {
        "letter": "b",
        "text": "the acquisition policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by the Procurement and Security Officers.",
        "odpParameters": [
          {
            "id": "sa1_review_cadence",
            "label": "SA Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SA-4': {
    "controlNumber": "SA-4",
    "family": "SA",
    "title": "Acquisition Process",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization includes security and privacy requirements in acquisition contracts based on risk assessments",
        "prefilledTemplate": "Procurement contracts mandate adherence to NIST SP 800-171, FedRAMP Moderate, and DFARS 252.204-7012 for all cloud service providers and software vendors."
      },
      {
        "letter": "b",
        "text": "the organization requires developers of systems or system components to implement security controls throughout the SDLC",
        "prefilledTemplate": "Third-party software vendors must provide software bill of materials (SBOM) and verified clean static code analysis reports prior to software acceptance."
      }
    ]
  },
  'SA-9': {
    "controlNumber": "SA-9",
    "family": "SA",
    "title": "External System Services",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization requires that external service providers comply with organizational security requirements and establish of a monitoring process",
        "prefilledTemplate": "All cloud service providers (CSPs) hosting CUI must possess an active FedRAMP Moderate or High Joint Authorization Board (JAB) / Agency ATO."
      },
      {
        "letter": "b",
        "text": "the organization monitors provider compliance with security requirements at the defined frequency",
        "prefilledTemplate": "Vendor SOC 2 Type II reports and FedRAMP continuous monitoring deliverables are reviewed [ODP: annually] by the GRC team.",
        "odpParameters": [
          {
            "id": "sa9_vendor_review_freq",
            "label": "External Provider Audit Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SC-1': {
    "controlNumber": "SC-1",
    "family": "SC",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a system and communications protection policy",
        "prefilledTemplate": "The System and Communications Protection Policy establishes network segmentation rules, encryption standards, and cryptographic key management lifecycles."
      },
      {
        "letter": "b",
        "text": "the system and communications protection policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by the Principal Network Security Architect.",
        "odpParameters": [
          {
            "id": "sc1_review_cadence",
            "label": "SC Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SC-7': {
    "controlNumber": "SC-7",
    "family": "SC",
    "title": "Boundary Protection",
    "objectives": [
      {
        "letter": "a",
        "text": "the system monitors and controls communications at the external boundary of the system and at key internal boundaries within the system",
        "prefilledTemplate": "Network boundaries are protected via **Azure NSGs**, AWS Security Groups, and **Palo Alto NGFW** with intrusion prevention systems (IPS) actively blocking unauthorized ingress and egress traffic.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "firewalld_service_enabled"
      },
      {
        "letter": "b",
        "text": "the system connects to external networks only through managed interfaces consisting of boundary protection devices arranged in accordance with organizational security architecture",
        "prefilledTemplate": "All external network connectivity routes through a central egress DMZ hub inspecting outbound traffic with SSL/TLS decryption and Deep Packet Inspection (DPI)."
      },
      {
        "letter": "c",
        "text": "the system isolates security-critical system components into separate subnets or virtual local area networks",
        "prefilledTemplate": "Database tiers, identity controllers, and public-facing gateways reside in dedicated, micro-segmented subnets with zero direct internet routability."
      }
    ]
  },
  'SC-7(7)': {
    "controlNumber": "SC-7(7)",
    "family": "SC",
    "title": "Prevent Split Tunneling for Remote Devices",
    "objectives": [
      {
        "letter": "a",
        "text": "the system prevents remote devices from simultaneously establishing non-remote connections with the system and communicating with external systems",
        "prefilledTemplate": "GlobalProtect and Azure VPN clients enforce a strict full-tunnel configuration pushed via **Intune** GPO. Split-tunneling is blocked at the kernel network driver level, preventing dual-homed routing to the public internet.",
        "isAutoVerifiedByTelemetry": true
      },
      {
        "letter": "b",
        "text": "the remote connection configuration is verified and validated continuously",
        "prefilledTemplate": "Endpoint compliance policies monitor the active routing table and disconnect corporate sessions if an unencrypted adapter or secondary physical NIC is activated."
      }
    ]
  },
  'SC-8': {
    "controlNumber": "SC-8",
    "family": "SC",
    "title": "Transmission Confidentiality and Integrity",
    "objectives": [
      {
        "letter": "a",
        "text": "the system protects the confidentiality and integrity of transmitted information",
        "prefilledTemplate": "All sensitive data and network communications in transit are encrypted using **FIPS 140-3** validated **TLS 1.3** / IPsec tunnels with AES-256 ciphers. Deprecated ciphers (SSLv3, TLS 1.0, TLS 1.1, RC4, 3DES) are disabled.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "sshd_use_approved_ciphers"
      },
      {
        "letter": "b",
        "text": "the system enforces cryptographic mechanisms to detect data transmission tampering",
        "prefilledTemplate": "Network message integrity is validated through HMAC-SHA-256 and authenticated GCM tags verifying tamper-free delivery."
      }
    ]
  },
  'SC-12': {
    "controlNumber": "SC-12",
    "family": "SC",
    "title": "Cryptographic Key Establishment and Management",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization establishes and manages cryptographic keys for required cryptography in accordance with key management procedures",
        "prefilledTemplate": "Cryptographic keys are generated and protected within **FIPS 140-3** Level 3 Hardware Security Modules (HSMs) using Azure Key Vault and AWS KMS with dual-custody access controls."
      },
      {
        "letter": "b",
        "text": "the organization rotates cryptographic keys at the defined frequency",
        "prefilledTemplate": "Encryption keys and TLS certificates are automatically rotated [ODP: annually] via automated Key Vault certificate renewal triggers.",
        "odpParameters": [
          {
            "id": "sc12_key_rotation_freq",
            "label": "Cryptographic Key Rotation Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SC-13': {
    "controlNumber": "SC-13",
    "family": "SC",
    "title": "Cryptographic Protection",
    "objectives": [
      {
        "letter": "a",
        "text": "the system implements FIPS-validated cryptographic modules in accordance with applicable federal laws and policies",
        "prefilledTemplate": "Operating systems operate in FIPS mode (fips=1 in GRUB on Linux, FIPSMode enabled via Windows GPO). All encryption libraries are certified under NIST Cryptographic Module Validation Program (CMVP).",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "enable_fips_mode"
      },
      {
        "letter": "b",
        "text": "cryptographic mechanisms comply with designated cryptographic key lengths and algorithm standards",
        "prefilledTemplate": "Algorithms adhere to NIST SP 800-131A Rev. 2 guidelines: RSA >= 3072 bits, ECDSA >= 256 bits, and AES >= 256 bits."
      }
    ]
  },
  'SC-28': {
    "controlNumber": "SC-28",
    "family": "SC",
    "title": "Protection of Information at Rest",
    "objectives": [
      {
        "letter": "a",
        "text": "the system protects the confidentiality and integrity of information at rest",
        "prefilledTemplate": "All information at rest is encrypted using **AES-256** BitLocker on Windows endpoints, dm-crypt/LUKS on Linux systems, and cloud storage server-side encryption with customer-managed keys (CMK).",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "encrypt_partitions"
      },
      {
        "letter": "b",
        "text": "cryptographic mechanisms used for information at rest protection are managed to prevent unauthorized access or disclosure",
        "prefilledTemplate": "BitLocker recovery keys and LUKS key material are backed up to **Entra ID** with access restricted to authorized Tier 3 Systems Administrators."
      }
    ]
  },
  'SI-1': {
    "controlNumber": "SI-1",
    "family": "SI",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a system and information integrity policy",
        "prefilledTemplate": "The System and Information Integrity Policy establishes patch timelines, antivirus/EDR mandates, SIEM alerting rules, and flaw remediation criteria."
      },
      {
        "letter": "b",
        "text": "the system and information integrity policy is reviewed at the defined frequency",
        "prefilledTemplate": "The policy is reviewed [ODP: annually] by the Chief Technology Officer.",
        "odpParameters": [
          {
            "id": "si1_review_cadence",
            "label": "SI Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SI-2': {
    "controlNumber": "SI-2",
    "family": "SI",
    "title": "Flaw Remediation",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization identifies, reports, and corrects system flaws",
        "prefilledTemplate": "Flaws and vulnerabilities are tracked in Jira and remediated through automated patch management using **Microsoft Intune** and Ansible Automation Platform.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "security_patches_up_to_date"
      },
      {
        "letter": "b",
        "text": "the organization tests software and firmware updates related to flaw remediation for effectiveness and potential side effects before installation",
        "prefilledTemplate": "Patches are tested in a non-production staging environment for [ODP: 72 hours] to verify stability before production roll-out.",
        "odpParameters": [
          {
            "id": "si2_testing_window",
            "label": "Patch Staging Validation Window",
            "defaultValue": "72 hours"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the organization installs security-relevant software and firmware updates within the defined time period of release",
        "prefilledTemplate": "Security patches are deployed within Critical/Zero-Day vulnerabilities within [ODP: 7 days], and High/Medium vulnerabilities within [ODP: 30 days]..",
        "odpParameters": [
          {
            "id": "si2_patch_critical",
            "label": "Critical Patch SLA",
            "defaultValue": "7 days"
          },
          {
            "id": "si2_patch_high",
            "label": "High Patch SLA",
            "defaultValue": "30 days"
          }
        ]
      }
    ]
  },
  'SI-3': {
    "controlNumber": "SI-3",
    "family": "SI",
    "title": "Malicious Code Protection",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization employs malicious code protection mechanisms at system entry and exit points and on endpoint devices",
        "prefilledTemplate": "Endpoint Detection and Response (EDR) via **Microsoft Defender for Endpoint** is active on all Windows, macOS, and Linux endpoints, with cloud-delivered protection and automated behavioral heuristics blocking malware execution.",
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "service_defender_active"
      },
      {
        "letter": "b",
        "text": "the organization updates malicious code protection mechanisms with signature and behavioral definitions at the defined frequency",
        "prefilledTemplate": "Antivirus and EDR definition updates download automatically [ODP: multiple times daily (every 4 hours)] directly from cloud intelligence backends.",
        "odpParameters": [
          {
            "id": "si3_def_update_freq",
            "label": "Antivirus Definition Update Cadence",
            "defaultValue": "multiple times daily (every 4 hours)"
          }
        ]
      },
      {
        "letter": "c",
        "text": "the system performs real-time and periodic scans of the system for malicious code",
        "prefilledTemplate": "On-access real-time scanning inspects all file read/write operations, downloads, and USB attachments; full endpoint scans run [ODP: weekly on Sundays].",
        "odpParameters": [
          {
            "id": "si3_scan_cadence",
            "label": "Full System Antivirus Scan Cadence",
            "defaultValue": "weekly on Sundays"
          }
        ]
      }
    ]
  },
  'SI-4': {
    "controlNumber": "SI-4",
    "family": "SI",
    "title": "System Monitoring",
    "objectives": [
      {
        "letter": "a",
        "text": "the system monitors for attacks and indicators of potential compromise at strategic locations",
        "prefilledTemplate": "Microsoft Sentinel, Azure Network Watcher, and Sysmon continuously ingest network flow logs, DNS queries, and endpoint telemetry across [ODP: **Azure Gov** and **AWS GovCloud** enclaves].",
        "odpParameters": [
          {
            "id": "si4_monitored_enclave",
            "label": "Monitored Cloud Enclaves",
            "defaultValue": "**Azure Gov** and **AWS GovCloud** enclaves"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "service_syslog_enabled"
      },
      {
        "letter": "b",
        "text": "the system detects inbound and outbound network traffic for unauthorized connections and malicious behavior",
        "prefilledTemplate": "Intrusion Detection/Prevention Systems (IDS/IPS) detect unauthorized outbound C2 beacons and block port scans in real time."
      },
      {
        "letter": "c",
        "text": "the organization heightened system monitoring activities during times of heightened threat risk",
        "prefilledTemplate": "SOC engineers adjust Sentinel detection sensitivity and increase packet capture buffer retention during CISA Shields Up alerts or active attack campaigns."
      },
      {
        "letter": "d",
        "text": "the system alerts designated personnel of detected anomalous behavior within the defined time period",
        "prefilledTemplate": "High-severity detection rules trigger automated incident alerts [ODP: within 15 minutes of detection to the SOC] via PagerDuty and secure messaging.",
        "odpParameters": [
          {
            "id": "si4_incident_alert_sla",
            "label": "SOC Escalation Notification SLA",
            "defaultValue": "within 15 minutes of detection to the SOC"
          }
        ],
        "isAutoVerifiedByTelemetry": true,
        "scapRuleId": "soar_alerting_sla_configured"
      }
    ]
  },
  'SI-5': {
    "controlNumber": "SI-5",
    "family": "SI",
    "title": "Security Alerts, Advisories, and Directives",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization receives system security alerts, advisories, and directives from external organizations on an ongoing basis",
        "prefilledTemplate": "Security leads subscribe to CISA Cyber Bulletins, US-CERT automated feeds, Microsoft Security Response Center (MSRC), and Red Hat Security Advisories."
      },
      {
        "letter": "b",
        "text": "the organization generates internal security advisories and takes directive actions within the defined time period",
        "prefilledTemplate": "Internal security advisories are issued within [ODP: 24 hours of receiving critical CVE disclosures], prompting patch deployment or compensating firewall mitigations.",
        "odpParameters": [
          {
            "id": "si5_advisory_sla",
            "label": "Internal Advisory SLA",
            "defaultValue": "24 hours of receiving critical CVE disclosures"
          }
        ]
      }
    ]
  },
  'SR-1': {
    "controlNumber": "SR-1",
    "family": "SR",
    "title": "Policy and Procedures",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops, documents, and disseminates a supply chain risk management policy",
        "prefilledTemplate": "The Supply Chain Risk Management (SCRM) Policy establishes vendor integrity vetting, counterfeit part prevention, and foreign ownership control checks."
      },
      {
        "letter": "b",
        "text": "the supply chain risk management policy is reviewed at the defined frequency",
        "prefilledTemplate": "The SCRM policy is reviewed [ODP: annually] by the Supply Chain Security Council.",
        "odpParameters": [
          {
            "id": "sr1_review_cadence",
            "label": "SCRM Policy Review Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SR-2': {
    "controlNumber": "SR-2",
    "family": "SR",
    "title": "Supply Chain Risk Management Plan",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization develops a plan for managing supply chain risks associated with the research, development, design, manufacturing, acquisition, delivery, integration, operations, and disposal of system components",
        "prefilledTemplate": "The organization maintains a formal SCRM Plan detailing supplier tier mapping, third-party dependency scanning, **SBOM generation**, and hardware provenance verification."
      },
      {
        "letter": "b",
        "text": "the supply chain risk management plan is reviewed and updated at the defined frequency",
        "prefilledTemplate": "The SCRM Plan is reviewed and updated [ODP: annually] to incorporate **NDAA 889/5949 compliance**.",
        "odpParameters": [
          {
            "id": "sr2_update_cadence",
            "label": "SCRM Plan Update Cadence",
            "defaultValue": "annually"
          }
        ]
      }
    ]
  },
  'SR-3': {
    "controlNumber": "SR-3",
    "family": "SR",
    "title": "Supply Chain Controls and Processes",
    "objectives": [
      {
        "letter": "a",
        "text": "the organization establishes a supply chain risk management process that identifies and assesses supply chain risks",
        "prefilledTemplate": "Vendors providing hardware, software, or services must complete third-party risk questionnaires and verify absence of prohibited foreign components (e.g., Huawei, ZTE, Dahua, Hikvision, Kaspersky)."
      },
      {
        "letter": "b",
        "text": "the organization implements processes to verify that acquired hardware, software, and firmware are authentic and not counterfeit",
        "prefilledTemplate": "Hardware is purchased exclusively through authorized manufacturer distribution channels with tamper-evident seals and cryptographic serial verification."
      }
    ]
  },
};

/**
 * Creates standardized determination statements for controls that are not explicitly
 * detailed in the hardcoded registry by leveraging their parsed assessmentObjectives
 * from the framework definitions or standard 800-171A determination language.
 */

/**
 * Exported alias containing complete NIST SP 800-53A Rev. 5 determination statements and baseline templates
 */
export const NIST_800_53A_OBJECTIVES: Record<string, ControlObjectivesTemplate> = Object.fromEntries(
  Object.entries(NIST_800_171A_REGISTRY).filter(([k]) => k.includes('-') && !k.includes('.L'))
);

export function getAssessmentObjectivesForControl(
  controlId: string,
  controlTitle?: string,
  existingObjectives?: string[],
  customStore?: Record<string, AssessmentObjective>
): AssessmentObjective[] {
  const trimmed = controlId.trim();
  const lower = trimmed.toLowerCase();
  const normNum = normalizeControlNumber(trimmed);

  // Check FAR Level 1 map first (e.g. ac.l1-3.1.1 or ac.l1-b.1.i -> AC.L1-b.1.i)
  const mappedKey =
    FAR_L1_TO_800_171_MAP[lower] ||
    FAR_L1_TO_800_171_MAP[normNum.toLowerCase()];

  const upper = trimmed.toUpperCase();
  // SP 800-53 controls and enhancements: the official SP 800-53A objectives (once loaded) come before the older hand-written ones
  const official = nist80053ObjectiveTemplate(trimmed);
  const registered =
    official ||
    (mappedKey ? NIST_800_171A_REGISTRY[mappedKey] : undefined) ||
    NIST_800_171A_REGISTRY[trimmed] ||
    NIST_800_171A_REGISTRY[upper] ||
    NIST_800_171A_REGISTRY[lower] ||
    NIST_800_171A_REGISTRY[normNum] ||
    NIST_800_171A_REGISTRY[normNum.toUpperCase()];

  // 1. If explicit NIST SP 800-171A determination statements exist in registry
  if (registered && registered.objectives.length > 0) {
    return registered.objectives.map((objDef) => {
      const objId = `${controlId}[${objDef.letter}]`;
      const existing = customStore?.[objId];

      if (existing) {
        return {
          ...existing,
          text: objDef.text, // ensure latest determination text
          prefilledTemplate: objDef.prefilledTemplate,
          scapRuleId: objDef.scapRuleId,
          odpParameters: existing.odpParameters || objDef.odpParameters,
        };
      }

      return {
        id: objId,
        controlId,
        letter: objDef.letter,
        text: objDef.text,
        status: 'NOT_STARTED' as ObjectiveStatus,
        prefilledTemplate: objDef.prefilledTemplate,
        implementationNarrative: '',
        linkedEvidenceIds: [],
        isAutoVerifiedByTelemetry: Boolean(objDef.isAutoVerifiedByTelemetry),
        scapRuleId: objDef.scapRuleId,
        odpParameters: objDef.odpParameters,
      };
    });
  }

  // 2. Synthesize objectives from framework control definition if provided
  if (existingObjectives && existingObjectives.length > 0) {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    return existingObjectives.map((rawText, idx) => {
      const letter = letters[idx] || `${idx + 1}`;
      const objId = `${controlId}[${letter}]`;
      const existing = customStore?.[objId];
      const cleanText = rawText.replace(/^Determine if\s+/i, '').trim();

      const synthesizedTemplate = `The enclave implementation satisfies requirement ${normNum}[${letter}] (${cleanText}). Compliance is enforced across cloud identity (**Microsoft Entra ID**), endpoint baselines (**Microsoft Intune** / **DISA STIG**s), and network perimeter controls with verified operational configurations.`;

      if (existing) {
        return {
          ...existing,
          text: cleanText,
          prefilledTemplate: synthesizedTemplate,
        };
      }

      return {
        id: objId,
        controlId,
        letter,
        text: cleanText,
        status: 'NOT_STARTED' as ObjectiveStatus,
        prefilledTemplate: synthesizedTemplate,
        implementationNarrative: '',
        linkedEvidenceIds: [],
        isAutoVerifiedByTelemetry: false,
      };
    });
  }

  // 3. Fallback: standard dual determination statements [a] and [b]
  const letters = ['a', 'b'];
  const titles = [
    `the requirements for ${controlTitle || controlId} are defined and established`,
    `the defined requirements for ${controlTitle || controlId} are implemented and enforced`,
  ];

  return letters.map((letter, idx) => {
    const objId = `${controlId}[${letter}]`;
    const existing = customStore?.[objId];
    const text = titles[idx];
    const template = `The enclave implementation satisfies requirement ${controlId}[${letter}]. Policies, configuration baselines, and technical safeguards have been established and operationally validated to satisfy this determination statement under NIST SP 800-171A.`;

    if (existing) {
      return {
        ...existing,
        text,
        prefilledTemplate: template,
      };
    }

    return {
      id: objId,
      controlId,
      letter,
      text,
      status: 'NOT_STARTED' as ObjectiveStatus,
      prefilledTemplate: template,
      implementationNarrative: '',
      linkedEvidenceIds: [],
      isAutoVerifiedByTelemetry: false,
    };
  });
}

export const getObjectivesForControl = getAssessmentObjectivesForControl;

/**
 * Calculates Rollup status for a set of objectives following C3PAO evaluation logic:
 * - If ALL objectives are MET or NOT_APPLICABLE -> 'MET'
 * - If ANY objective is NOT_MET -> 'NOT_MET'
 * - If all objectives are NOT_STARTED -> 'NOT_STARTED'
 * - Otherwise -> 'IN_PROGRESS'
 */
export function calculateControlRollup(objectives: AssessmentObjective[]): ControlObjectiveRollup {
  if (!objectives || objectives.length === 0) {
    return {
      controlId: '',
      totalObjectives: 0,
      metCount: 0,
      notMetCount: 0,
      inProgressCount: 0,
      notStartedCount: 0,
      notApplicableCount: 0,
      calculatedStatus: 'NOT_STARTED',
      isSatisfied: false,
    };
  }

  const controlId = objectives[0].controlId;
  const totalObjectives = objectives.length;
  let metCount = 0;
  let notMetCount = 0;
  let inProgressCount = 0;
  let notStartedCount = 0;
  let notApplicableCount = 0;

  for (const obj of objectives) {
    switch (obj.status) {
      case 'MET':
        metCount++;
        break;
      case 'NOT_MET':
        notMetCount++;
        break;
      case 'IN_PROGRESS':
        inProgressCount++;
        break;
      case 'NOT_APPLICABLE':
        notApplicableCount++;
        break;
      case 'NOT_STARTED':
      default:
        notStartedCount++;
        break;
    }
  }

  let calculatedStatus: 'MET' | 'NOT_MET' | 'IN_PROGRESS' | 'NOT_STARTED';

  // C3PAO Assessment Method Rules:
  // 1. If ANY objective is NOT_MET -> NOT_MET
  if (notMetCount > 0) {
    calculatedStatus = 'NOT_MET';
  }
  // 2. If ALL objectives are MET or N/A -> MET
  else if (metCount + notApplicableCount === totalObjectives && totalObjectives > 0) {
    calculatedStatus = 'MET';
  }
  // 3. If all objectives are NOT_STARTED -> NOT_STARTED
  else if (notStartedCount === totalObjectives) {
    calculatedStatus = 'NOT_STARTED';
  }
  // 4. Otherwise -> IN_PROGRESS
  else {
    calculatedStatus = 'IN_PROGRESS';
  }

  return {
    controlId,
    totalObjectives,
    metCount,
    notMetCount,
    inProgressCount,
    notStartedCount,
    notApplicableCount,
    calculatedStatus,
    isSatisfied: calculatedStatus === 'MET',
  };
}

/**
 * Evaluates individual objectives to determine overall control status (MET, NOT_MET, IN_PROGRESS, NOT_STARTED).
 * Fully aligned with NIST SP 800-53A Rev. 5 and NIST SP 800-171A C3PAO assessment methods.
 */
export function recalculateControlStatusFromObjectives(objectives: AssessmentObjective[]): ObjectiveStatus {
  return calculateControlRollup(objectives).calculatedStatus;
}
