/**
 * scripts/seed80053Objectives.ts
 *
 * Populates src/data/frameworks/assessmentObjectives.ts with complete NIST SP 800-53A Rev. 5
 * determination statements, Federal/DoD ATO implementation narratives, and default Organization-Defined
 * Parameters (ODPs) across all 20 control families:
 * AC, AT, AU, CA, CM, CP, IA, IR, MA, MP, PE, PL, PM, PS, PT, RA, SA, SC, SI, SR.
 *
 * Run: npx tsx scripts/seed80053Objectives.ts
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ObjectiveDefinitionTemplate {
  letter: string;
  text: string;
  prefilledTemplate: string;
  scapRuleId?: string;
  isAutoVerifiedByTelemetry?: boolean;
  odpParameters?: { id: string; label: string; defaultValue: string; currentValue?: string }[];
}

export interface ControlObjectivesTemplate {
  controlNumber: string;
  family: string;
  title: string;
  objectives: ObjectiveDefinitionTemplate[];
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPREHENSIVE NIST SP 800-53A REV. 5 CATALOG (ALL 20 FAMILIES)
// ─────────────────────────────────────────────────────────────────────────────

export const NIST_800_53A_CATALOG: Record<string, ControlObjectivesTemplate> = {
  // ── 1. AC: ACCESS CONTROL ──────────────────────────────────────────────────
  'AC-1': {
    controlNumber: 'AC-1',
    family: 'AC',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'an access control policy is developed, documented, and disseminated to designated personnel',
        prefilledTemplate: 'The organization develops and disseminates an official Access Control Policy addressing purpose, scope, roles, responsibilities, management commitment, and compliance across [ODP: Azure Government and AWS GovCloud enclaves].',
        odpParameters: [{ id: 'ac1_scope', label: 'Cloud Enclave Scope', defaultValue: 'Azure Government and AWS GovCloud enclaves' }],
      },
      {
        letter: 'b',
        text: 'access control procedures are developed, documented, and disseminated to facilitate implementation of policy',
        prefilledTemplate: 'Access control standard operating procedures (SOPs) detailing identity provisioning, privilege escalation, and session revocation are maintained in the central compliance documentation repository.',
      },
      {
        letter: 'c',
        text: 'the access control policy and procedures are reviewed and updated at the defined frequency',
        prefilledTemplate: 'The Access Control Policy and procedures are reviewed and updated [ODP: annually] or following major architectural changes by the ISSO and CISO.',
        odpParameters: [{ id: 'ac1_freq', label: 'Review Frequency', defaultValue: 'annually' }],
      },
    ],
  },
  'AC-2': {
    controlNumber: 'AC-2',
    family: 'AC',
    title: 'Account Management',
    objectives: [
      {
        letter: 'a',
        text: 'the types of system accounts to support organizational missions and business functions are identified and selected',
        prefilledTemplate: 'The organization defines and documents approved system account types in the Access Control Policy, encompassing individual employee accounts, privileged administrative accounts, automated service principals, and emergency break-glass credentials in [ODP: Azure Government and AWS GovCloud enclaves].',
        odpParameters: [{ id: 'ac2_account_types', label: 'Cloud Enclave Scope', defaultValue: 'Azure Government and AWS GovCloud enclaves' }],
      },
      {
        letter: 'b',
        text: 'account managers for system accounts are assigned',
        prefilledTemplate: 'Identity lifecycle management is assigned to the designated IT Identity & Access Management (IAM) Lead and Systems Engineering Team, with automated SCIM synchronization governed through Microsoft Entra ID Governance and AWS IAM Identity Center.',
      },
      {
        letter: 'c',
        text: 'prerequisites for system access are established and validated',
        prefilledTemplate: 'Prior to account provisioning, HR and Security Officers validate prerequisite background screening (Tier 1/Tier 3 federal investigation), completion of mandatory cyber awareness training, and signed Rules of Behavior (AUP) within [ODP: 30 days of start date].',
        odpParameters: [{ id: 'ac2_prereq_timeframe', label: 'Onboarding Screening Window', defaultValue: '30 days of start date' }],
      },
      {
        letter: 'd',
        text: 'system accounts are authorized based on valid access authorizations, intended system usage, and other attributes required by the organization',
        prefilledTemplate: 'All user account requests require supervisor approval and ISSO sign-off via formal ticketing in ServiceNow. Role-Based Access Control (RBAC) groups determine default permissions according to least privilege.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'account_unique_id',
      },
      {
        letter: 'e',
        text: 'system accounts are reviewed for compliance with account management requirements with the defined frequency',
        prefilledTemplate: 'Privileged and standard user account access reviews are performed [ODP: semi-annually] by system owners. Automated Entra Access Reviews prompt managers to certify or revoke access for inactive or transferred personnel.',
        odpParameters: [{ id: 'ac2_review_freq', label: 'Account Review Frequency', defaultValue: 'semi-annually' }],
      },
      {
        letter: 'f',
        text: 'system accounts are disabled within the defined time period when accounts have expired, are no longer required, or when individuals are terminated',
        prefilledTemplate: 'Accounts are immediately disabled upon employee departure via automated HR webhook triggers within [ODP: 4 hours of notification]. Inactive accounts are automatically disabled after [ODP: 35 days of inactivity].',
        odpParameters: [
          { id: 'ac2_term_disable', label: 'Termination Deprovisioning SLA', defaultValue: '4 hours of notification' },
          { id: 'ac2_inactivity_disable', label: 'Inactivity Threshold', defaultValue: '35 days of inactivity' },
        ],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'account_disable_post_pw_expiration',
      },
      {
        letter: 'g',
        text: 'system accounts are removed after the defined time period following account deactivation or expiration',
        prefilledTemplate: 'Disabled user accounts are permanently purged or archived to cold compliance retention storage after [ODP: 90 days following deactivation].',
        odpParameters: [{ id: 'ac2_purge_period', label: 'Account Retention Post-Disable', defaultValue: '90 days following deactivation' }],
      },
    ],
  },
  'AC-3': {
    controlNumber: 'AC-3',
    family: 'AC',
    title: 'Access Enforcement',
    objectives: [
      {
        letter: 'a',
        text: 'the system enforces approved authorizations for logical access to information and system resources in accordance with applicable access control policies',
        prefilledTemplate: 'Logical access enforcement is executed through Microsoft Entra ID Conditional Access, Azure RBAC, and Linux POSIX/sudoers configurations following DISA RHEL 9 STIG rules. Default-deny policies block all unauthorized resource operations.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'file_permissions_unauthorized_write',
      },
      {
        letter: 'b',
        text: 'access control policies are enforced over designated subject and object types according to specified access criteria',
        prefilledTemplate: 'Subjects (authenticated users, managed identities, automated services) access objects (virtual machines, S3 buckets, SQL databases, REST APIs) strictly through cryptographic access tokens evaluated against security group membership and conditional device health posture.',
      },
    ],
  },
  'AC-4': {
    controlNumber: 'AC-4',
    family: 'AC',
    title: 'Information Flow Enforcement',
    objectives: [
      {
        letter: 'a',
        text: 'information flow control policies are enforced for approved authorizations between interconnected systems and internal enclaves',
        prefilledTemplate: 'Flow control policies are enforced at perimeter and inter-VNet boundaries using Azure Network Security Groups (NSGs) and AWS Security Groups. Cross-boundary data flows require inspection via Next-Gen Firewalls and Palo Alto Panorama appliances.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewalld_sshd_port_enabled',
      },
      {
        letter: 'b',
        text: 'the system regulates data transfers using flow control mechanisms to prevent unauthorized exfiltration or leakage',
        prefilledTemplate: 'Egress traffic is routed through TLS-decrypting proxies with automated Data Loss Prevention (DLP) filters blocking unauthorized CUI/FCI transfers to external endpoints.',
      },
    ],
  },
  'AC-6': {
    controlNumber: 'AC-6',
    family: 'AC',
    title: 'Least Privilege',
    objectives: [
      {
        letter: 'a',
        text: 'the principle of least privilege is employed for specific categories of users and processes acting on behalf of users',
        prefilledTemplate: 'The enclave enforces least privilege by assigning users non-privileged standard accounts for everyday productivity. Administrative roles (Global Admin, Subscription Owner) are strictly managed via Entra ID Privileged Identity Management (PIM) with just-in-time (JIT) activation.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sudo_remove_nopasswd',
      },
      {
        letter: 'b',
        text: 'privileged access is authorized only for designated personnel performing specific security or administrative functions',
        prefilledTemplate: 'Elevated administrative privileges require explicit justification, multi-factor re-authentication, and ticket approval. Standing administrative access is zero-tolerated across production subscriptions.',
      },
      {
        letter: 'c',
        text: 'non-privileged user accounts are used when accessing non-security or general operational functions',
        prefilledTemplate: 'Engineers maintain separate accounts: user@defense.company.com for web/email/productivity, and admin-user@defense.company.com restricted strictly to administrative consoles.',
      },
      {
        letter: 'd',
        text: 'privileged role sessions expire automatically after the defined time limit',
        prefilledTemplate: 'PIM elevation grants automatically expire after [ODP: 4 hours], requiring re-justification and MFA challenge for subsequent operational windows.',
        odpParameters: [{ id: 'ac6_pim_duration', label: 'Maximum JIT Elevation Window', defaultValue: '4 hours' }],
      },
    ],
  },
  'AC-7': {
    controlNumber: 'AC-7',
    family: 'AC',
    title: 'Unsuccessful Logon Attempts',
    objectives: [
      {
        letter: 'a',
        text: 'the system enforces a limit of consecutive invalid logon attempts by a user during the defined time period',
        prefilledTemplate: 'The system enforces a threshold of [ODP: 3 consecutive invalid logon attempts] within a [ODP: 15-minute sliding window] across cloud identity providers and RHEL/Windows endpoints.',
        odpParameters: [
          { id: 'ac7_attempts', label: 'Consecutive Invalid Logon Limit', defaultValue: '3 consecutive invalid logon attempts' },
          { id: 'ac7_window', label: 'Detection Window', defaultValue: '15-minute sliding window' },
        ],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_passwords_pam_faillock_deny',
      },
      {
        letter: 'b',
        text: 'the system automatically locks the account until released by an administrator or until the defined time period elapses',
        prefilledTemplate: 'Upon exceeding 3 failed attempts, pam_faillock locks the account for [ODP: 30 minutes] or until explicitly unlocked by an authorized Systems Administrator.',
        odpParameters: [{ id: 'ac7_lockout_duration', label: 'Account Lockout Duration', defaultValue: '30 minutes' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_passwords_pam_faillock_unlock_time',
      },
    ],
  },
  'AC-8': {
    controlNumber: 'AC-8',
    family: 'AC',
    title: 'System Use Notification',
    objectives: [
      {
        letter: 'a',
        text: 'the system displays an approved system use notification message or banner before granting access',
        prefilledTemplate: 'A federally approved DoD/USG warning banner is presented prior to login across SSH (/etc/issue), Windows interactive logon (LegalNoticeText GPO), and Microsoft Entra ID tenant branding.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'banner_etc_issue',
      },
      {
        letter: 'b',
        text: 'the notification informs users of monitoring, no expectation of privacy, and consent to administrative inspection',
        prefilledTemplate: 'The banner text explicitly notifies users that the system is for authorized federal contractor use only, user activity is continuously monitored and audited, there is no expectation of privacy, and unauthorized access is subject to criminal prosecution.',
      },
    ],
  },
  'AC-11': {
    controlNumber: 'AC-11',
    family: 'AC',
    title: 'Device Lock',
    objectives: [
      {
        letter: 'a',
        text: 'the system initiates a session lock after the defined period of inactivity or upon receiving a request from a user',
        prefilledTemplate: 'Endpoints and servers initiate an automated session lock after [ODP: 15 minutes of inactivity] enforced via Microsoft Intune Configuration Profiles and Linux /etc/profile.d/autologout.sh (TMOUT=900).',
        odpParameters: [{ id: 'ac11_lock_timeout', label: 'Inactivity Lock Period', defaultValue: '15 minutes of inactivity' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_tmout',
      },
      {
        letter: 'b',
        text: 'the session lock conceals previously visible information with a publicly viewable screen display',
        prefilledTemplate: 'Session lock immediately blanks the screen or displays a locked screen saver requiring user re-authentication via password or FIDO2 token before resuming operational state.',
      },
    ],
  },
  'AC-14': {
    controlNumber: 'AC-14',
    family: 'AC',
    title: 'Permitted Actions without Identification or Authentication',
    objectives: [
      {
        letter: 'a',
        text: 'the actions that can be performed on the system without identification or authentication are identified and documented',
        prefilledTemplate: 'The organization identifies and documents permitted unauthenticated actions: accessing public marketing web pages, viewing the login warning banner, and resolving public DNS A records.',
      },
      {
        letter: 'b',
        text: 'the system allows user access without identification and authentication only for approved and documented actions',
        prefilledTemplate: 'All system endpoints, APIs, and administrative interfaces enforce mandatory identification and authentication; unauthenticated actions are restricted solely to the documented public landing gateway.',
      },
    ],
  },
  'AC-17': {
    controlNumber: 'AC-17',
    family: 'AC',
    title: 'Remote Access',
    objectives: [
      {
        letter: 'a',
        text: 'the organization authorizes, monitors, and controls remote access sessions to the information system',
        prefilledTemplate: 'Remote access is restricted to corporate-managed laptops establishing an encrypted tunnel through GlobalProtect VPN with machine certificate verification and Entra ID Conditional Access evaluation.',
      },
      {
        letter: 'b',
        text: 'the system enforces encryption of remote access sessions using approved cryptography',
        prefilledTemplate: 'All remote access traffic is encrypted in transit using FIPS 140-3 validated IPsec (AES-256-GCM) or TLS 1.3 ciphersuites. Split tunneling is strictly disabled by gateway profile policy.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_use_approved_ciphers',
      },
      {
        letter: 'c',
        text: 'remote access sessions are terminated automatically after the defined period of inactivity',
        prefilledTemplate: 'Remote VPN and bastion sessions automatically disconnect after [ODP: 30 minutes of idle inactivity] and require full re-authentication for reconnect.',
        odpParameters: [{ id: 'ac17_idle_disconnect', label: 'Remote Session Idle Disconnect', defaultValue: '30 minutes of idle inactivity' }],
      },
    ],
  },
  'AC-18': {
    controlNumber: 'AC-18',
    family: 'AC',
    title: 'Wireless Access',
    objectives: [
      {
        letter: 'a',
        text: 'the organization authorizes wireless access to the system prior to connection',
        prefilledTemplate: 'Corporate wireless connectivity is authorized exclusively on the PBC-SECURE WPA3-Enterprise SSID. Personal, guest, or unmanaged wireless connections to the enclave network are prohibited.',
      },
      {
        letter: 'b',
        text: 'the system enforces authentication and encryption of wireless sessions using approved cryptographic protocols',
        prefilledTemplate: 'Wireless access requires 802.1X EAP-TLS certificate-based authentication using Intune-deployed device certificates and AES-256 GCM encryption.',
      },
      {
        letter: 'c',
        text: 'rogue wireless access points are scanned and detected at the defined frequency',
        prefilledTemplate: 'Automated Wireless Intrusion Prevention Systems (WIPS) continuously scan physical facility spectrum [ODP: continuously 24/7] and alert security on rogue broadcast transmitters.',
        odpParameters: [{ id: 'ac18_wips_cadence', label: 'Wireless Rogue Scan Frequency', defaultValue: 'continuously 24/7' }],
      },
    ],
  },
  'AC-19': {
    controlNumber: 'AC-19',
    family: 'AC',
    title: 'Access Control for Mobile Devices',
    objectives: [
      {
        letter: 'a',
        text: 'the organization authorizes mobile device connections to organizational networks and systems',
        prefilledTemplate: 'Only government-furnished or enterprise-owned mobile devices enrolled in Microsoft Intune Mobile Device Management (MDM) are authorized to access corporate resources.',
      },
      {
        letter: 'b',
        text: 'the system enforces full-disk encryption and containerized workspace isolation on mobile devices',
        prefilledTemplate: 'Mobile device policies mandate iOS/Android device encryption (AES-256), 6-digit biometric passcodes, remote-wipe enablement, and containerized Microsoft Outlook/Teams via Intune App Protection Policies.',
      },
    ],
  },
  'AC-20': {
    controlNumber: 'AC-20',
    family: 'AC',
    title: 'Use of External Systems',
    objectives: [
      {
        letter: 'a',
        text: 'terms and conditions for the use of external systems to access organizational information are established',
        prefilledTemplate: 'The organization defines Acceptable Use terms prohibiting the processing or storage of organizational CUI on unapproved personal devices (BYOD) or commercial public cloud services.',
      },
      {
        letter: 'b',
        text: 'the organization verifies that external systems satisfy required security controls prior to authorizing connection',
        prefilledTemplate: 'External vendor portals and contractor laptops must provide verified Attestation of Compliance (FedRAMP Moderate or SOC 2 Type II) before SAML federation or API access is approved.',
      },
    ],
  },
  'AC-22': {
    controlNumber: 'AC-22',
    family: 'AC',
    title: 'Publicly Accessible Content',
    objectives: [
      {
        letter: 'a',
        text: 'the organization designates individuals authorized to post information on publicly accessible systems',
        prefilledTemplate: 'Only designated Communications and Compliance officers are authorized to publish content to external-facing websites following formal multi-party review.',
      },
      {
        letter: 'b',
        text: 'publicly accessible content is reviewed prior to posting to ensure non-public and controlled unclassified information is not included',
        prefilledTemplate: 'Content undergoes mandatory OPSEC and CUI screening prior to publishing. Automated scanners check web public repositories for accidental credential, PII, or CUI disclosure [ODP: weekly].',
        odpParameters: [{ id: 'ac22_scan_cadence', label: 'Public Repo Content Scan', defaultValue: 'weekly' }],
      },
    ],
  },

  // ── 2. AT: AWARENESS AND TRAINING ──────────────────────────────────────────
  'AT-1': {
    controlNumber: 'AT-1',
    family: 'AT',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a security awareness and training policy',
        prefilledTemplate: 'The organization publishes the Security Awareness and Training Policy establishing mandatory training cadences, role-specific curriculum, and compliance tracking across the workforce.',
      },
      {
        letter: 'b',
        text: 'the organization develops and disseminates security training procedures',
        prefilledTemplate: 'Training procedures detail LMS onboarding enrollment, automated overdue escalations, and mandatory remediation for failed simulated phishing assessments.',
      },
      {
        letter: 'c',
        text: 'the awareness and training policy and procedures are reviewed and updated at the defined frequency',
        prefilledTemplate: 'The policy and procedures are reviewed and revised [ODP: annually] by the Director of Information Security.',
        odpParameters: [{ id: 'at1_rev_freq', label: 'Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'AT-2': {
    controlNumber: 'AT-2',
    family: 'AT',
    title: 'Security Awareness Training',
    objectives: [
      {
        letter: 'a',
        text: 'basic security awareness training is provided to system users within the defined time period after onboarding',
        prefilledTemplate: 'All new personnel complete mandatory cybersecurity awareness training within [ODP: 30 days of hire] prior to granting production enclave access.',
        odpParameters: [{ id: 'at2_onboarding_window', label: 'New Hire Training SLA', defaultValue: '30 days of hire' }],
      },
      {
        letter: 'b',
        text: 'security awareness training is provided to system users with the defined recurring frequency thereafter',
        prefilledTemplate: 'All active employees and contractors complete annual refresher security training [ODP: annually] covering social engineering, insider threat, and incident reporting.',
        odpParameters: [{ id: 'at2_annual_freq', label: 'Recurring Training Frequency', defaultValue: 'annually' }],
      },
      {
        letter: 'c',
        text: 'practical exercises including simulated social engineering and phishing are conducted at the defined frequency',
        prefilledTemplate: 'Simulated phishing campaigns are executed [ODP: monthly] using KnowBe4. Users failing tests are automatically enrolled in targeted micro-learning modules.',
        odpParameters: [{ id: 'at2_phish_cadence', label: 'Simulated Phishing Frequency', defaultValue: 'monthly' }],
      },
    ],
  },
  'AT-3': {
    controlNumber: 'AT-3',
    family: 'AT',
    title: 'Role-Based Training',
    objectives: [
      {
        letter: 'a',
        text: 'role-based cybersecurity training is provided to personnel with assigned security roles and responsibilities',
        prefilledTemplate: 'Systems administrators, security engineers, and developers complete role-based training (e.g., OWASP Top 10, Cloud Security Alliance CCSK, DISA STIG hardening) within [ODP: 60 days of assuming role].',
        odpParameters: [{ id: 'at3_role_window', label: 'Role-Based Completion Window', defaultValue: '60 days of assuming role' }],
      },
      {
        letter: 'b',
        text: 'role-based security training is provided with the defined recurring frequency thereafter',
        prefilledTemplate: 'Privileged IT and security personnel complete specialized continuing education [ODP: annually] to maintain active administrative role certifications.',
        odpParameters: [{ id: 'at3_recurring_cadence', label: 'Specialized Training Cadence', defaultValue: 'annually' }],
      },
    ],
  },

  // ── 3. AU: AUDIT AND ACCOUNTABILITY ────────────────────────────────────────
  'AU-1': {
    controlNumber: 'AU-1',
    family: 'AU',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates an audit and accountability policy',
        prefilledTemplate: 'The Audit and Accountability Policy establishes log generation baselines, SIEM retention obligations, and administrative audit monitoring procedures.',
      },
      {
        letter: 'b',
        text: 'the audit and accountability policy and procedures are reviewed and updated at the defined frequency',
        prefilledTemplate: 'Audit policies and SIEM logging rules are reviewed and updated [ODP: annually] or after major system re-authorizations.',
        odpParameters: [{ id: 'au1_review_cadence', label: 'Audit Policy Review Frequency', defaultValue: 'annually' }],
      },
    ],
  },
  'AU-2': {
    controlNumber: 'AU-2',
    family: 'AU',
    title: 'Event Logging',
    objectives: [
      {
        letter: 'a',
        text: 'the organization identifies the types of events that the system must log to support auditing requirements',
        prefilledTemplate: 'The organization defines auditable event types in the Enclave Logging Standard, including user authentication, privilege escalation, file access to sensitive datastores, firewall rule changes, and system administration activities in [ODP: Microsoft Sentinel and Splunk GovCloud].',
        odpParameters: [{ id: 'au2_siem_platform', label: 'SIEM Logging Platform', defaultValue: 'Microsoft Sentinel and Splunk GovCloud' }],
      },
      {
        letter: 'b',
        text: 'the system logs the identified auditable events with the required level of detail',
        prefilledTemplate: 'Audit daemon (auditd) on Linux and Windows Advanced Audit Policies forward full event telemetry via Azure Monitor Agent to centralized SIEM workspaces.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'auditd_service_enabled',
      },
      {
        letter: 'c',
        text: 'the organization reviews and updates the list of auditable events at the defined frequency',
        prefilledTemplate: 'The list of auditable events and SIEM correlation rules is reviewed and adjusted [ODP: semi-annually] based on emerging threat intelligence and CISA advisories.',
        odpParameters: [{ id: 'au2_review_freq', label: 'Auditable Event Review Cadence', defaultValue: 'semi-annually' }],
      },
    ],
  },
  'AU-3': {
    controlNumber: 'AU-3',
    family: 'AU',
    title: 'Content of Audit Records',
    objectives: [
      {
        letter: 'a',
        text: 'audit records contain information that establishes what type of event occurred',
        prefilledTemplate: 'Audit records explicitly establish the event type, unique event identifier (e.g., Windows Event ID, Linux syscall, syslog facility), and severity level.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'audit_rules_syslog',
      },
      {
        letter: 'b',
        text: 'audit records contain information that establishes when the event occurred, where the event occurred, the source of the event, the outcome of the event, and the identity of any individuals or subjects associated with the event',
        prefilledTemplate: 'Every log entry includes an authoritative UTC timestamp synchronized via NTP, source/destination IP addresses, process IDs, target resource identifiers, success or failure code, and authenticated user principal or service account identity.',
      },
    ],
  },
  'AU-6': {
    controlNumber: 'AU-6',
    family: 'AU',
    title: 'Audit Record Review, Analysis, and Reporting',
    objectives: [
      {
        letter: 'a',
        text: 'the organization reviews and analyzes system audit records for indications of unusual or suspicious activity at the defined frequency',
        prefilledTemplate: 'Security Operations Center (SOC) analysts and automated SIEM analytics review audit logs [ODP: continuously 24/7 with daily automated digest reporting] for anomalies, brute-force indicators, and privilege abuse.',
        odpParameters: [{ id: 'au6_review_cadence', label: 'Log Review Frequency', defaultValue: 'continuously 24/7 with daily automated digest reporting' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'service_auditd_enabled',
      },
      {
        letter: 'b',
        text: 'the organization reports suspicious activities and findings to designated personnel within the defined time period',
        prefilledTemplate: 'Confirmed security anomalies or elevated threat indicators are alerted to the Incident Response Lead within [ODP: 15 minutes of correlation] via automated PagerDuty and Teams SOC webhooks.',
        odpParameters: [{ id: 'au6_escalation_window', label: 'Suspicious Activity Escalation SLA', defaultValue: '15 minutes of correlation' }],
      },
      {
        letter: 'c',
        text: 'the system integrates audit review, analysis, and reporting with overall organizational monitoring processes',
        prefilledTemplate: 'Log correlation is integrated into Microsoft Sentinel SOAR playbooks, triggering automated isolation of compromised compute instances and identity token revocation upon alert confirmation.',
      },
    ],
  },
  'AU-9': {
    controlNumber: 'AU-9',
    family: 'AU',
    title: 'Protection of Audit Information',
    objectives: [
      {
        letter: 'a',
        text: 'the system protects audit records against unauthorized access, modification, and deletion',
        prefilledTemplate: 'Audit logs are forwarded in near-real-time to immutable Write-Once-Read-Many (WORM) cloud storage with Azure Immutable Blob Storage policies preventing modification or deletion by any account, including root/Global Administrators.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'file_permissions_var_log_audit',
      },
      {
        letter: 'b',
        text: 'audit logs are retained for the defined compliance retention period',
        prefilledTemplate: 'Audit records are retained for a minimum of [ODP: 3 years, with 1 year immediately searchable online] in accordance with OMB M-21-31 and FedRAMP Moderate guidelines.',
        odpParameters: [{ id: 'au9_retention_period', label: 'Audit Log Retention Mandate', defaultValue: '3 years, with 1 year immediately searchable online' }],
      },
    ],
  },

  // ── 4. CA: ASSESSMENT, AUTHORIZATION & MONITORING ──────────────────────────
  'CA-1': {
    controlNumber: 'CA-1',
    family: 'CA',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a security assessment and authorization policy',
        prefilledTemplate: 'The Assessment, Authorization, and Monitoring Policy defines RMF lifecycle stages, independent assessment criteria, and Authorizing Official (AO) engagement.',
      },
      {
        letter: 'b',
        text: 'the policy and procedures are reviewed and updated at the defined frequency',
        prefilledTemplate: 'The policy is reviewed and updated [ODP: annually] by the Lead Compliance Assessor and CISO.',
        odpParameters: [{ id: 'ca1_review_cadence', label: 'CA Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'CA-2': {
    controlNumber: 'CA-2',
    family: 'CA',
    title: 'Control Assessments',
    objectives: [
      {
        letter: 'a',
        text: 'the organization assesses security controls in the information system to determine the extent to which the controls are implemented correctly',
        prefilledTemplate: 'Independent C3PAO and internal audit teams assess all NIST SP 800-53 Rev. 5 controls prior to initial Authority to Operate (ATO) issuance and on a recurring schedule.',
      },
      {
        letter: 'b',
        text: 'the organization produces a security assessment report (SAR) documenting assessment findings',
        prefilledTemplate: 'Formal Security Assessment Reports (SAR) documenting test procedures, evidence artifacts, and control deficiencies are compiled following every comprehensive audit.',
      },
      {
        letter: 'c',
        text: 'security control assessments are conducted with the defined recurring frequency',
        prefilledTemplate: 'Full independent control assessments are executed [ODP: annually, with a 3-year full re-authorization cycle].',
        odpParameters: [{ id: 'ca2_assessment_frequency', label: 'Assessment Frequency', defaultValue: 'annually, with a 3-year full re-authorization cycle' }],
      },
    ],
  },
  'CA-7': {
    controlNumber: 'CA-7',
    family: 'CA',
    title: 'Continuous Monitoring',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops a continuous monitoring strategy and implements a continuous monitoring program',
        prefilledTemplate: 'The organization executes a Continuous Monitoring (ConMon) plan integrating automated vulnerability scans, STIG compliance checks, configuration change audits, and monthly security metric reports.',
      },
      {
        letter: 'b',
        text: 'the organization establishes continuous monitoring metrics to be tracked and evaluated',
        prefilledTemplate: 'Key metrics include mean-time-to-remediate (MTTR) critical flaws, patch compliance percentage, unauthorized privileged events, and MFA adoption rates.',
      },
      {
        letter: 'c',
        text: 'continuous monitoring results are reported to the Authorizing Official (AO) at the defined frequency',
        prefilledTemplate: 'ConMon reports and updated POA&Ms are submitted to the Authorizing Official [ODP: monthly].',
        odpParameters: [{ id: 'ca7_reporting_cadence', label: 'AO ConMon Reporting Cadence', defaultValue: 'monthly' }],
      },
    ],
  },

  // ── 5. CM: CONFIGURATION MANAGEMENT ────────────────────────────────────────
  'CM-1': {
    controlNumber: 'CM-1',
    family: 'CM',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a configuration management policy',
        prefilledTemplate: 'The Configuration Management Policy establishes baselines, change control board (CCB) charters, and automated drift prevention standards.',
      },
      {
        letter: 'b',
        text: 'configuration management policy and procedures are reviewed at the defined frequency',
        prefilledTemplate: 'The policy and procedures are reviewed [ODP: annually] by the Configuration Manager.',
        odpParameters: [{ id: 'cm1_rev_cadence', label: 'CM Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'CM-2': {
    controlNumber: 'CM-2',
    family: 'CM',
    title: 'Baseline Configuration',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and maintains under configuration control, a current baseline configuration of the system',
        prefilledTemplate: 'The organization develops and maintains hardened baseline configurations for virtual machines, container images, and network components derived from [ODP: DISA STIGs and CIS Benchmark Level 2]. Baseline templates are codified as Terraform and Ansible infrastructure-as-code (IaC).',
        odpParameters: [{ id: 'cm2_baseline_standard', label: 'Hardening Standard', defaultValue: 'DISA STIGs and CIS Benchmark Level 2' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'aide_periodic_checking_systemd_timer',
      },
      {
        letter: 'b',
        text: 'the baseline configuration is reviewed and updated at the defined frequency',
        prefilledTemplate: 'System baseline images are updated and re-certified [ODP: monthly following Microsoft/Red Hat patch cycles or immediately after critical zero-day disclosures].',
        odpParameters: [{ id: 'cm2_baseline_update_freq', label: 'Baseline Refresh Cadence', defaultValue: 'monthly following Microsoft/Red Hat patch cycles' }],
      },
      {
        letter: 'c',
        text: 'baseline configurations are retained to support rollback and disaster recovery operations',
        prefilledTemplate: 'Versioned golden AMI/VHD images and Git commits are retained in the Azure Container Registry and Git repository with automated rollback capabilities.',
      },
    ],
  },
  'CM-3': {
    controlNumber: 'CM-3',
    family: 'CM',
    title: 'Configuration Change Control',
    objectives: [
      {
        letter: 'a',
        text: 'the organization determines the types of changes to the system that are configuration-controlled',
        prefilledTemplate: 'All changes to operating systems, firewall rules, security group policies, identity roles, and core application code require formal change control tickets in Jira Service Management.',
      },
      {
        letter: 'b',
        text: 'the organization approves configuration-controlled changes to the system with the explicit consideration of security impact analyses',
        prefilledTemplate: 'Security Impact Analyses (SIAs) are performed by the ISSO prior to approving changes. The Change Control Board (CCB) reviews and signs off on high-impact changes weekly.',
      },
      {
        letter: 'c',
        text: 'the organization documents and approves configuration change decisions',
        prefilledTemplate: 'Approved change tickets document risk evaluation, test results in staging, rollback steps, and designated implementation windows.',
      },
      {
        letter: 'd',
        text: 'the organization tests, validates, and documents changes to the system prior to implementing changes in production',
        prefilledTemplate: 'All configuration changes are staged and automated CI/CD unit and integration tests validate security controls before production promotion.',
      },
    ],
  },
  'CM-7': {
    controlNumber: 'CM-7',
    family: 'CM',
    title: 'Least Functionality',
    objectives: [
      {
        letter: 'a',
        text: 'the organization configures the system to provide only essential capabilities and prohibits or restricts the use of functions, ports, protocols, and services',
        prefilledTemplate: 'Servers and containers are stripped of non-essential packages (compilers, Telnet, FTP, games). Unused ports and listening daemons are blocked by default via host firewalls and network security group access lists.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'package_telnet_removed',
      },
      {
        letter: 'b',
        text: 'the organization reviews the system at the defined frequency to identify and eliminate unnecessary functions, ports, protocols, and services',
        prefilledTemplate: 'Automated OpenSCAP and Tenable vulnerability scans audit open ports and services [ODP: weekly], alerting on unauthorized listening sockets.',
        odpParameters: [{ id: 'cm7_scan_cadence', label: 'Unnecessary Port Scan Cadence', defaultValue: 'weekly' }],
      },
      {
        letter: 'c',
        text: 'unauthorized or unapproved software execution is prevented using software restriction mechanisms',
        prefilledTemplate: 'Application Whitelisting / AppLocker and Linux fapolicyd restrict execution strictly to digitally signed binaries and approved system directories.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'service_fapolicyd_enabled',
      },
    ],
  },
  'CM-8': {
    controlNumber: 'CM-8',
    family: 'CM',
    title: 'Information System Component Inventory',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops and documents an inventory of system components that reflects the current system',
        prefilledTemplate: 'An automated component inventory tracks all hardware, virtual machines, cloud PaaS resources, and network equipment in the Asset Inventory module, integrating Azure Resource Graph and AWS Config.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the component inventory is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The inventory is updated [ODP: continuously via cloud API webhooks and audited monthly] by the IT Infrastructure Lead.',
        odpParameters: [{ id: 'cm8_inventory_audit_freq', label: 'Inventory Audit Cadence', defaultValue: 'continuously via cloud API webhooks and audited monthly' }],
      },
      {
        letter: 'c',
        text: 'the inventory includes relevant component details such as manufacturer, model, OS, MAC/IP address, and system ownership',
        prefilledTemplate: 'Every component record includes UUID, hostname, IP address, MAC, operating system patch level, physical/logical location, and responsible administrator.',
      },
    ],
  },

  // ── 6. CP: CONTINGENCY PLANNING ────────────────────────────────────────────
  'CP-1': {
    controlNumber: 'CP-1',
    family: 'CP',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a contingency planning policy',
        prefilledTemplate: 'The Contingency Planning Policy establishes business continuity goals, maximum tolerable downtime (MTD), and disaster recovery mandates.',
      },
      {
        letter: 'b',
        text: 'the contingency planning policy and procedures are reviewed at the defined frequency',
        prefilledTemplate: 'Contingency policies are reviewed [ODP: annually] by the Business Continuity Steering Committee.',
        odpParameters: [{ id: 'cp1_review_cadence', label: 'CP Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'CP-2': {
    controlNumber: 'CP-2',
    family: 'CP',
    title: 'Contingency Plan',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops a contingency plan for the system that addresses system restoration without compromising security',
        prefilledTemplate: 'The System Contingency Plan (CP) details roles, disaster recovery procedures, alternate site activation, and step-by-step restoration sequences for cloud infrastructure.',
      },
      {
        letter: 'b',
        text: 'the contingency plan is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The Contingency Plan is reviewed, updated, and re-approved by executive leadership [ODP: annually] or after significant infrastructure refactoring.',
        odpParameters: [{ id: 'cp2_review_cadence', label: 'Contingency Plan Review Cadence', defaultValue: 'annually' }],
      },
      {
        letter: 'c',
        text: 'the contingency plan establishes recovery objectives including Recovery Time Objective (RTO) and Recovery Point Objective (RPO)',
        prefilledTemplate: 'The plan codifies an RTO of [ODP: 4 hours] and an RPO of [ODP: 1 hour] for critical CUI datastores.',
        odpParameters: [
          { id: 'cp2_rto', label: 'Recovery Time Objective (RTO)', defaultValue: '4 hours' },
          { id: 'cp2_rpo', label: 'Recovery Point Objective (RPO)', defaultValue: '1 hour' },
        ],
      },
    ],
  },
  'CP-4': {
    controlNumber: 'CP-4',
    family: 'CP',
    title: 'Contingency Plan Testing',
    objectives: [
      {
        letter: 'a',
        text: 'the organization tests the contingency plan for the system at the defined frequency using approved test methods',
        prefilledTemplate: 'The organization executes a simulated disaster recovery failover drill and tabletop exercise [ODP: annually] involving all primary and alternate incident response team members.',
        odpParameters: [{ id: 'cp4_test_cadence', label: 'Disaster Recovery Exercise Cadence', defaultValue: 'annually' }],
      },
      {
        letter: 'b',
        text: 'the organization documents test results in a contingency plan test report',
        prefilledTemplate: 'After Action Reports (AARs) document test timing, simulated failover success, identified communication gaps, and necessary plan revisions.',
      },
      {
        letter: 'c',
        text: 'the organization updates the contingency plan to address shortcomings identified during testing',
        prefilledTemplate: 'Remediation action items from tests are logged in the POA&M and incorporated into the Contingency Plan within [ODP: 30 days of test completion].',
        odpParameters: [{ id: 'cp4_update_window', label: 'Plan Revision SLA Post-Test', defaultValue: '30 days of test completion' }],
      },
    ],
  },
  'CP-9': {
    controlNumber: 'CP-9',
    family: 'CP',
    title: 'System Backup',
    objectives: [
      {
        letter: 'a',
        text: 'the organization conducts backups of user-level information and system-level information at the defined frequency',
        prefilledTemplate: 'System backups execute [ODP: daily incremental and weekly full backups] managed via Azure Backup Services and AWS Backup across all storage volumes and SQL databases.',
        odpParameters: [{ id: 'cp9_backup_cadence', label: 'Backup Schedule', defaultValue: 'daily incremental and weekly full backups' }],
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the organization protects the confidentiality, integrity, and availability of backup information at storage locations',
        prefilledTemplate: 'Backups are encrypted in transit and at rest using FIPS 140-3 validated AES-256 keys. Geo-redundant storage (GRS) replicates backups to an alternate federal region separated by >500 miles.',
      },
      {
        letter: 'c',
        text: 'the organization tests backup information at the defined frequency to verify media reliability and information integrity',
        prefilledTemplate: 'Automated test restoration of sample database tables and file shares is conducted [ODP: monthly] to validate data integrity without interrupting live production.',
        odpParameters: [{ id: 'cp9_restore_test_cadence', label: 'Test Restoration Cadence', defaultValue: 'monthly' }],
      },
    ],
  },

  // ── 7. IA: IDENTIFICATION AND AUTHENTICATION ──────────────────────────────
  'IA-1': {
    controlNumber: 'IA-1',
    family: 'IA',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates an identification and authentication policy',
        prefilledTemplate: 'The Identification and Authentication Policy establishes mandatory MFA requirements, cryptographic authenticator lifecycles, and prohibited credential sharing.',
      },
      {
        letter: 'b',
        text: 'the identification and authentication policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by the Chief Information Security Officer.',
        odpParameters: [{ id: 'ia1_review_cadence', label: 'IA Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'IA-2': {
    controlNumber: 'IA-2',
    family: 'IA',
    title: 'Identification and Authentication (Organizational Users)',
    objectives: [
      {
        letter: 'a',
        text: 'the system uniquely identifies and authenticates organizational users or processes acting on behalf of organizational users',
        prefilledTemplate: 'Every user is assigned an individual, non-shared User Principal Name (UPN) formatted as user@defense.company.com managed through Microsoft Entra ID Government and synced to Active Directory.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_minlen',
      },
      {
        letter: 'b',
        text: 'the system implements multi-factor authentication (MFA) for network access to privileged and non-privileged accounts',
        prefilledTemplate: 'Conditional Access enforces mandatory Multi-Factor Authentication (MFA) using Microsoft Authenticator (number matching enabled) or FIDO2 hardware security keys for all network logon sessions.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'c',
        text: 'the system implements phishing-resistant multi-factor authentication for privileged administrative access',
        prefilledTemplate: 'Privileged administrative roles require phishing-resistant FIDO2 hardware tokens (YubiKey 5 FIPS) or DoD Common Access Cards (CAC) / PIV credentials. SMS and voice phone calls are disabled.',
      },
      {
        letter: 'd',
        text: 'the system implements multi-factor authentication for local access to privileged accounts',
        prefilledTemplate: 'Local console access on servers requires smartcard/PIV authentication or Duo MFA hardware tokens; static local administrator passwords are stored in Azure Key Vault with 12-hour automated rotation.',
      },
    ],
  },
  'IA-5': {
    controlNumber: 'IA-5',
    family: 'IA',
    title: 'Authenticator Management',
    objectives: [
      {
        letter: 'a',
        text: 'the organization manages system authenticators by establishing initial authenticator distribution procedures',
        prefilledTemplate: 'Temporary passwords are randomly generated with high entropy, distributed securely out-of-band via encrypted SMS/voice verification, and forced to change upon first logon.',
      },
      {
        letter: 'b',
        text: 'the system enforces minimum password length and complexity requirements',
        prefilledTemplate: 'Passphrases must be a minimum of [ODP: 15 characters] containing uppercase, lowercase, numbers, and symbols, enforced via Entra Password Protection and Linux pam_pwquality.',
        odpParameters: [{ id: 'ia5_min_password_len', label: 'Minimum Password Length', defaultValue: '15 characters' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_minlen',
      },
      {
        letter: 'c',
        text: 'the system enforces password lifetime and expiration at the defined frequency when MFA is not utilized',
        prefilledTemplate: 'Where legacy authenticators exist without FIDO2, passwords expire every [ODP: 90 days]. Where phishing-resistant MFA is strictly enforced, password expirations follow NIST SP 800-63B guidelines prohibiting arbitrary expiration.',
        odpParameters: [{ id: 'ia5_password_rotation_cadence', label: 'Password Rotation Cadence', defaultValue: '90 days' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_maxindays',
      },
      {
        letter: 'd',
        text: 'the system prohibits password reuse for the defined number of generations',
        prefilledTemplate: 'The system remembers previous passwords and prohibits reuse for [ODP: 24 password generations] via pam_pwhistory and Active Directory GPO.',
        odpParameters: [{ id: 'ia5_password_history', label: 'Password History Buffer', defaultValue: '24 password generations' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'accounts_password_pam_remember',
      },
    ],
  },

  // ── 8. IR: INCIDENT RESPONSE ──────────────────────────────────────────────
  'IR-1': {
    controlNumber: 'IR-1',
    family: 'IR',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates an incident response policy',
        prefilledTemplate: 'The Incident Response Policy establishes incident severities, escalation chains of command, and federal reporting thresholds.',
      },
      {
        letter: 'b',
        text: 'the incident response policy and procedures are reviewed at the defined frequency',
        prefilledTemplate: 'The IR policy is reviewed and updated [ODP: annually] by the Incident Response Commander.',
        odpParameters: [{ id: 'ir1_review_cadence', label: 'IR Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'IR-4': {
    controlNumber: 'IR-4',
    family: 'IR',
    title: 'Incident Handling',
    objectives: [
      {
        letter: 'a',
        text: 'the organization implements an incident handling capability for security incidents that includes preparation, detection, containment, eradication, and recovery',
        prefilledTemplate: 'The organization maintains an Incident Response Team (IRT) supported by a 24/7 Managed Detection and Response (MDR) provider. Standardized playbooks govern ransomware, credential theft, and unauthorized exfiltration.',
      },
      {
        letter: 'b',
        text: 'the organization coordinates incident handling activities with contingency planning personnel',
        prefilledTemplate: 'IR procedures integrate with disaster recovery failover triggers when containment requires isolating critical production workloads.',
      },
      {
        letter: 'c',
        text: 'the organization incorporates lessons learned from incident handling activities into incident response procedures and training',
        prefilledTemplate: 'Post-incident reviews (Root Cause Analyses) are conducted within [ODP: 14 days of incident resolution], updating SIEM correlation rules and playbooks.',
        odpParameters: [{ id: 'ir4_post_incident_window', label: 'Post-Mortem Review Window', defaultValue: '14 days of incident resolution' }],
      },
    ],
  },
  'IR-6': {
    controlNumber: 'IR-6',
    family: 'IR',
    title: 'Incident Reporting',
    objectives: [
      {
        letter: 'a',
        text: 'the organization requires personnel to report suspected security incidents to the incident response authority within the defined time period',
        prefilledTemplate: 'Personnel must report suspected incidents to the SOC within [ODP: 1 hour of discovery] via the emergency hotline or the Report Phishing button in Outlook.',
        odpParameters: [{ id: 'ir6_internal_report_sla', label: 'Internal Reporting SLA', defaultValue: '1 hour of discovery' }],
      },
      {
        letter: 'b',
        text: 'the organization reports security incidents to designated external authorities within specified timeframes',
        prefilledTemplate: 'Confirmed cyber incidents affecting CUI or federal data are reported to DoD DC3 within [ODP: 72 hours] pursuant to DFARS 252.204-7012 and to US-CERT / CISA within [ODP: 1 hour for major incidents].',
        odpParameters: [
          { id: 'ir6_dod_reporting_window', label: 'DoD DC3 Reporting Mandate', defaultValue: '72 hours' },
          { id: 'ir6_cisa_reporting_window', label: 'CISA Emergency Reporting Mandate', defaultValue: '1 hour for major incidents' },
        ],
      },
    ],
  },

  // ── 9. MA: MAINTENANCE ────────────────────────────────────────────────────
  'MA-1': {
    controlNumber: 'MA-1',
    family: 'MA',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a system maintenance policy',
        prefilledTemplate: 'The System Maintenance Policy governs preventive maintenance windows, vendor escort protocols, and remote diagnostic session controls.',
      },
      {
        letter: 'b',
        text: 'the maintenance policy is reviewed at the defined frequency',
        prefilledTemplate: 'Maintenance policies are reviewed [ODP: annually] by the Director of Cloud Operations.',
        odpParameters: [{ id: 'ma1_review_cadence', label: 'MA Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'MA-2': {
    controlNumber: 'MA-2',
    family: 'MA',
    title: 'Controlled Maintenance',
    objectives: [
      {
        letter: 'a',
        text: 'the organization schedules, performs, and documents maintenance and repairs on system components in accordance with manufacturer or vendor specifications',
        prefilledTemplate: 'Maintenance is scheduled during off-peak maintenance windows ([ODP: Sundays 02:00-06:00 EST]) and documented in change management tickets.',
        odpParameters: [{ id: 'ma2_maintenance_window', label: 'Scheduled Maintenance Window', defaultValue: 'Sundays 02:00-06:00 EST' }],
      },
      {
        letter: 'b',
        text: 'the organization approves and monitors all maintenance activities',
        prefilledTemplate: 'On-premise hardware maintenance requires physical escort by an authorized technician. Cloud infrastructure maintenance is monitored via cloud provider trust center notices.',
      },
      {
        letter: 'c',
        text: 'the organization inspects maintenance tools prior to connection to the system',
        prefilledTemplate: 'Vendor diagnostic tools and USB keys are checked for malware and approved by the ISSO prior to connecting to any enclave server.',
      },
    ],
  },
  'MA-4': {
    controlNumber: 'MA-4',
    family: 'MA',
    title: 'Nonlocal Maintenance',
    objectives: [
      {
        letter: 'a',
        text: 'the organization authorizes nonlocal maintenance sessions before connections are established',
        prefilledTemplate: 'Remote vendor maintenance sessions require prior authorization and are established strictly via temporary, supervised screen-sharing sessions.',
      },
      {
        letter: 'b',
        text: 'the system enforces strong authenticators and encryption for nonlocal maintenance sessions',
        prefilledTemplate: 'Nonlocal maintenance is conducted over TLS 1.3 encrypted bastion hosts with MFA authentication and full session keystroke recording.',
      },
      {
        letter: 'c',
        text: 'the organization monitors and terminates nonlocal maintenance sessions when maintenance is complete',
        prefilledTemplate: 'An internal systems administrator oversees the remote technician session at all times and immediately terminates remote access upon work completion.',
      },
    ],
  },

  // ── 10. MP: MEDIA PROTECTION ──────────────────────────────────────────────
  'MP-1': {
    controlNumber: 'MP-1',
    family: 'MP',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a media protection policy',
        prefilledTemplate: 'The Media Protection Policy establishes markings, transport safeguards, sanitization protocols, and USB restrictions for digital and physical media.',
      },
      {
        letter: 'b',
        text: 'the media protection policy is reviewed at the defined frequency',
        prefilledTemplate: 'Media protection policies are reviewed [ODP: annually] by the Compliance Director.',
        odpParameters: [{ id: 'mp1_review_cadence', label: 'MP Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'MP-6': {
    controlNumber: 'MP-6',
    family: 'MP',
    title: 'Media Sanitization',
    objectives: [
      {
        letter: 'a',
        text: 'the organization sanitizes system media prior to disposal, release out of organizational control, or release for reuse',
        prefilledTemplate: 'All digital media (hard drives, SSDs, backup tapes) are sanitized per NIST SP 800-88 Rev. 1 guidelines (cryptographic erase or degaussing/physical degaussing and shredding to <2mm particles).',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the organization employs sanitization mechanisms with the strength and integrity commensurate with the security category or classification of the information',
        prefilledTemplate: 'Cloud virtual disks are cryptographically erased upon resource de-allocation via Azure storage crypto-erase mechanisms.',
      },
      {
        letter: 'c',
        text: 'the organization verifies and documents media sanitization actions',
        prefilledTemplate: 'Certificates of Destruction detailing drive serial numbers, date, method, and witness signatures are maintained for [ODP: 5 years] in the Compliance Vault.',
        odpParameters: [{ id: 'mp6_cert_retention', label: 'Certificate of Destruction Retention', defaultValue: '5 years' }],
      },
    ],
  },

  // ── 11. PE: PHYSICAL AND ENVIRONMENTAL PROTECTION ─────────────────────────
  'PE-1': {
    controlNumber: 'PE-1',
    family: 'PE',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a physical and environmental protection policy',
        prefilledTemplate: 'The Physical Security Policy governs badge access, visitor escorting, HVAC monitoring, and fire suppression for corporate facilities.',
      },
      {
        letter: 'b',
        text: 'the physical security policy is reviewed at the defined frequency',
        prefilledTemplate: 'Physical security policies are reviewed [ODP: annually] by the Facilities and Security Manager.',
        odpParameters: [{ id: 'pe1_review_cadence', label: 'PE Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'PE-2': {
    controlNumber: 'PE-2',
    family: 'PE',
    title: 'Physical Access Authorizations',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops and keeps current a list of personnel with authorized access to facilities containing system components',
        prefilledTemplate: 'The organization maintains an access list in the electronic badge system designating authorized personnel for server rooms and sensitive project areas.',
      },
      {
        letter: 'b',
        text: 'the organization reviews and updates the physical access authorization list at the defined frequency',
        prefilledTemplate: 'Physical facility access lists are reviewed and reconciled against HR employment rolls [ODP: quarterly].',
        odpParameters: [{ id: 'pe2_audit_cadence', label: 'Physical Access Roster Review', defaultValue: 'quarterly' }],
      },
    ],
  },
  'PE-3': {
    controlNumber: 'PE-3',
    family: 'PE',
    title: 'Physical Access Control',
    objectives: [
      {
        letter: 'a',
        text: 'the organization enforces physical access control at entry and exit points to facilities containing system components',
        prefilledTemplate: 'Perimeter doors and internal server spaces enforce encrypted RFID badge readers and biometric door locks with anti-passback controls.',
      },
      {
        letter: 'b',
        text: 'the organization controls physical access to system components by monitoring physical access logs',
        prefilledTemplate: 'Badge entry attempts are logged to an immutable physical security database and CCTV cameras record all ingress/egress points with [ODP: 90-day video retention].',
        odpParameters: [{ id: 'pe3_cctv_retention', label: 'CCTV Footage Retention', defaultValue: '90-day video retention' }],
      },
      {
        letter: 'c',
        text: 'the organization escorts visitors and monitors visitor activity in sensitive areas',
        prefilledTemplate: 'Visitors must present government ID, sign the physical visitor ledger, wear visitor badges, and remain under continuous escort by cleared personnel.',
      },
    ],
  },

  // ── 12. PL: PLANNING ──────────────────────────────────────────────────────
  'PL-1': {
    controlNumber: 'PL-1',
    family: 'PL',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a security and privacy planning policy',
        prefilledTemplate: 'The Security Planning Policy establishes System Security Plan (SSP) authoring standards, boundary scoping, and Authorizing Official coordination.',
      },
      {
        letter: 'b',
        text: 'the planning policy is reviewed at the defined frequency',
        prefilledTemplate: 'Planning policies are reviewed [ODP: annually] by the Principal GRC Architect.',
        odpParameters: [{ id: 'pl1_review_cadence', label: 'PL Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'PL-2': {
    controlNumber: 'PL-2',
    family: 'PL',
    title: 'System Security and Privacy Plan',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops a System Security and Privacy Plan (SSP) that describes system boundaries, operational environment, and control implementations',
        prefilledTemplate: 'The organization authors and maintains a comprehensive System Security Plan (SSP) in the Singularity GRC platform detailing cloud and on-premise security boundaries.',
      },
      {
        letter: 'b',
        text: 'the system security plan is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The SSP is reviewed, updated, and re-approved by the Authorizing Official [ODP: annually or upon significant system modification].',
        odpParameters: [{ id: 'pl2_update_cadence', label: 'SSP Review Cadence', defaultValue: 'annually or upon significant system modification' }],
      },
      {
        letter: 'c',
        text: 'the system security plan is distributed to designated individuals with authorization and need-to-know',
        prefilledTemplate: 'The SSP is stored in the encrypted Singularity repository with RBAC restricting read/edit access strictly to authorized compliance officers and federal auditors.',
      },
    ],
  },
  'PL-4': {
    controlNumber: 'PL-4',
    family: 'PL',
    title: 'Rules of Behavior',
    objectives: [
      {
        letter: 'a',
        text: 'the organization establishes rules of behavior for individuals accessing the system',
        prefilledTemplate: 'The Acceptable Use Policy / Rules of Behavior (RoB) outlines user responsibilities, authorized device handling, password standards, and social media constraints.',
      },
      {
        letter: 'b',
        text: 'the organization verifies that individuals sign an acknowledgment indicating they have read and agree to abide by the rules of behavior before granting access and at the defined frequency thereafter',
        prefilledTemplate: 'Users sign electronic RoB acknowledgments during initial onboarding and [ODP: annually thereafter] as part of cybersecurity awareness training.',
        odpParameters: [{ id: 'pl4_rob_signature_freq', label: 'Rules of Behavior Re-signing Cadence', defaultValue: 'annually thereafter' }],
      },
    ],
  },

  // ── 13. PM: PROGRAM MANAGEMENT ────────────────────────────────────────────
  'PM-1': {
    controlNumber: 'PM-1',
    family: 'PM',
    title: 'Information Security Program Plan',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops and disseminates an organization-wide information security program plan',
        prefilledTemplate: 'The Executive Leadership team approves an Information Security Program Plan defining governance structures, budget allocation, and executive accountability.',
      },
      {
        letter: 'b',
        text: 'the information security program plan is reviewed at the defined frequency',
        prefilledTemplate: 'The Information Security Program Plan is reviewed and updated [ODP: biennially (every 2 years)] by the CISO and Board of Directors.',
        odpParameters: [{ id: 'pm1_review_cadence', label: 'Program Plan Review Cadence', defaultValue: 'biennially (every 2 years)' }],
      },
      {
        letter: 'c',
        text: 'the information security program plan is updated to reflect organizational changes and emerging cybersecurity priorities',
        prefilledTemplate: 'Updates reflect evolving federal mandates (e.g., CMMC 2.0, NIST SP 800-53 Rev. 5, OMB memoranda).',
      },
    ],
  },
  'PM-9': {
    controlNumber: 'PM-9',
    family: 'PM',
    title: 'Risk Management Strategy',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops a comprehensive risk management strategy that addresses risk tolerance, identification, and mitigation',
        prefilledTemplate: 'The enterprise Risk Management Strategy outlines threat likelihood scoring, impact matrices, and formal risk acceptance thresholds for CUI and operational systems.',
      },
      {
        letter: 'b',
        text: 'the risk management strategy is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The Risk Management Strategy is reviewed and refreshed [ODP: annually] by the Enterprise Risk Committee.',
        odpParameters: [{ id: 'pm9_review_cadence', label: 'Risk Strategy Review Cadence', defaultValue: 'annually' }],
      },
      {
        letter: 'c',
        text: 'the strategy is integrated into the organizational System Development Life Cycle (SDLC) and procurement processes',
        prefilledTemplate: 'Risk assessments are mandatory gates in software deployment pipelines and vendor acquisition onboarding.',
      },
    ],
  },

  // ── 14. PS: PERSONNEL SECURITY ────────────────────────────────────────────
  'PS-1': {
    controlNumber: 'PS-1',
    family: 'PS',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a personnel security policy',
        prefilledTemplate: 'The Personnel Security Policy defines background check standards, employee transfer processes, and immediate access termination mandates.',
      },
      {
        letter: 'b',
        text: 'the personnel security policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by Human Resources and the Chief Compliance Officer.',
        odpParameters: [{ id: 'ps1_review_cadence', label: 'PS Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'PS-2': {
    controlNumber: 'PS-2',
    family: 'PS',
    title: 'Position Risk Designation',
    objectives: [
      {
        letter: 'a',
        text: 'the organization assigns a risk designation to all organizational positions',
        prefilledTemplate: 'Every job role is categorized as High, Moderate, or Low Risk based on access to privileged credentials, financial systems, or Controlled Unclassified Information (CUI).',
      },
      {
        letter: 'b',
        text: 'the organization establishes screening criteria for individuals filling positions of differing risk levels',
        prefilledTemplate: 'High-risk positions mandate Tier 3 (Secret) or Tier 5 (Top Secret) federal background investigations, while moderate positions require Tier 1 checks.',
      },
    ],
  },
  'PS-3': {
    controlNumber: 'PS-3',
    family: 'PS',
    title: 'Personnel Screening',
    objectives: [
      {
        letter: 'a',
        text: 'the organization screens individuals prior to authorizing access to the system',
        prefilledTemplate: 'Candidates undergo comprehensive criminal background, credit, drug screening, and identity verification before account credentials are provisioned.',
      },
      {
        letter: 'b',
        text: 'the organization rescreens personnel at the defined frequency',
        prefilledTemplate: 'Personnel in sensitive or privileged roles undergo recurring background rescreening every [ODP: 5 years] or upon assignment to classified defense contracts.',
        odpParameters: [{ id: 'ps3_rescreen_period', label: 'Rescreening Frequency', defaultValue: '5 years' }],
      },
    ],
  },
  'PS-4': {
    controlNumber: 'PS-4',
    family: 'PS',
    title: 'Personnel Termination',
    objectives: [
      {
        letter: 'a',
        text: 'the organization disables system access within the defined time period upon termination of employment',
        prefilledTemplate: 'HR ticketing triggers automated deprovisioning in Entra ID, revoking all tokens, active sessions, and VPN access within [ODP: 4 hours of notification] (or immediately for involuntary terminations).',
        odpParameters: [{ id: 'ps4_termination_sla', label: 'Deprovisioning SLA Upon Separation', defaultValue: '4 hours of notification' }],
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the organization conducts exit interviews and retrieves all organizational property',
        prefilledTemplate: 'HR conducts formal exit interviews, reviews continuing NDA/CUI obligations, and retrieves corporate laptops, security keys, and building badges.',
      },
      {
        letter: 'c',
        text: 'the organization retains termination records to verify timely deprovisioning compliance',
        prefilledTemplate: 'Completed termination checklists with audit timestamps are stored in the employee HR compliance file.',
      },
    ],
  },

  // ── 15. PT: PII PROCESSING AND TRANSPARENCY ───────────────────────────────
  'PT-1': {
    controlNumber: 'PT-1',
    family: 'PT',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a PII processing and transparency policy',
        prefilledTemplate: 'The Privacy and PII Protection Policy governs collection, processing, retention, and lawful disclosure of personally identifiable information.',
      },
      {
        letter: 'b',
        text: 'the PII processing and transparency policy is reviewed at the defined frequency',
        prefilledTemplate: 'The privacy policy is reviewed [ODP: annually] by the Chief Privacy Officer.',
        odpParameters: [{ id: 'pt1_review_cadence', label: 'Privacy Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'PT-2': {
    controlNumber: 'PT-2',
    family: 'PT',
    title: 'Authority to Process Personally Identifiable Information',
    objectives: [
      {
        letter: 'a',
        text: 'the organization determines and documents the legal authority that permits the processing of PII',
        prefilledTemplate: 'The organization maintains legal and contractual documentation establishing lawful basis for processing employee and contractor personal data under federal guidelines.',
      },
      {
        letter: 'b',
        text: 'the organization maintains an inventory of all PII processing systems',
        prefilledTemplate: 'Privacy Impact Assessments (PIAs) document data flow, storage endpoints, and access boundaries for any enclave storing PII.',
      },
    ],
  },
  'PT-3': {
    controlNumber: 'PT-3',
    family: 'PT',
    title: 'Privacy Notice',
    objectives: [
      {
        letter: 'a',
        text: 'the organization provides a privacy notice to individuals regarding the processing of PII',
        prefilledTemplate: 'A prominent Privacy Notice is published on all public web interfaces and in employee onboarding portals detailing collected data, purpose, and rights.',
      },
      {
        letter: 'b',
        text: 'the privacy notice is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The Privacy Notice is reviewed and updated [ODP: annually] or upon changes in data collection practices.',
        odpParameters: [{ id: 'pt3_review_cadence', label: 'Privacy Notice Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },

  // ── 16. RA: RISK ASSESSMENT ───────────────────────────────────────────────
  'RA-1': {
    controlNumber: 'RA-1',
    family: 'RA',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a risk assessment policy',
        prefilledTemplate: 'The Risk Assessment Policy defines vulnerability scanning cadences, threat modeling methodologies, and risk mitigation SLAs.',
      },
      {
        letter: 'b',
        text: 'the risk assessment policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by the Information System Security Manager (ISSM).',
        odpParameters: [{ id: 'ra1_review_cadence', label: 'RA Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'RA-3': {
    controlNumber: 'RA-3',
    family: 'RA',
    title: 'Risk Assessment',
    objectives: [
      {
        letter: 'a',
        text: 'the organization assesses the risk, including the likelihood and magnitude of harm, from the unauthorized access, use, disclosure, disruption, modification, or destruction of the system and the information it processes',
        prefilledTemplate: 'Formal risk assessments evaluate internal and external threat actors against NIST SP 800-30 Rev. 1 criteria, scoring threats by likelihood and operational impact.',
      },
      {
        letter: 'b',
        text: 'the organization conducts risk assessments at the defined frequency or upon significant architectural changes',
        prefilledTemplate: 'Risk assessments are conducted [ODP: annually or prior to deploying major infrastructure changes].',
        odpParameters: [{ id: 'ra3_frequency', label: 'Risk Assessment Cadence', defaultValue: 'annually or prior to deploying major infrastructure changes' }],
      },
      {
        letter: 'c',
        text: 'the organization documents risk assessment results in a formal risk assessment report',
        prefilledTemplate: 'Results are documented in the Security Assessment Report (SAR) and tracked via the Singularity POA&M dashboard.',
      },
    ],
  },
  'RA-5': {
    controlNumber: 'RA-5',
    family: 'RA',
    title: 'Vulnerability Monitoring and Scanning',
    objectives: [
      {
        letter: 'a',
        text: 'the organization monitors for vulnerabilities in the system and application components using automated scanning tools at the defined frequency',
        prefilledTemplate: 'Automated vulnerability scans are performed [ODP: weekly for operating systems and containers, and monthly for web applications] using Tenable Nessus and Microsoft Defender for Cloud.',
        odpParameters: [{ id: 'ra5_scan_cadence', label: 'Vulnerability Scanning Cadence', defaultValue: 'weekly for operating systems and containers, and monthly for web applications' }],
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the organization analyzes vulnerability scan reports and results from other sources',
        prefilledTemplate: 'Scan results are triaged within 24 hours of scan completion. False positives are validated and documented with ISSO approval.',
      },
      {
        letter: 'c',
        text: 'the organization remediates legitimate vulnerabilities in accordance with organizational risk assessments and defined remediation timeframes',
        prefilledTemplate: 'Critical vulnerabilities are remediated within [ODP: 15 days], High within [ODP: 30 days], and Moderate within [ODP: 90 days] in alignment with FedRAMP standards.',
        odpParameters: [
          { id: 'ra5_crit_sla', label: 'Critical Vulnerability SLA', defaultValue: '15 days' },
          { id: 'ra5_high_sla', label: 'High Vulnerability SLA', defaultValue: '30 days' },
          { id: 'ra5_mod_sla', label: 'Moderate Vulnerability SLA', defaultValue: '90 days' },
        ],
      },
      {
        letter: 'd',
        text: 'the organization shares vulnerability information with designated personnel and collaborative security entities',
        prefilledTemplate: 'Discovered zero-days and active exploit attempts are shared with CISA and vendor threat research groups.',
      },
    ],
  },

  // ── 17. SA: SYSTEM AND SERVICES ACQUISITION ───────────────────────────────
  'SA-1': {
    controlNumber: 'SA-1',
    family: 'SA',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a system and services acquisition policy',
        prefilledTemplate: 'The Acquisition Security Policy establishes vendor vetting criteria, FedRAMP authorization mandates, and supply chain integrity requirements.',
      },
      {
        letter: 'b',
        text: 'the acquisition policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by the Procurement and Security Officers.',
        odpParameters: [{ id: 'sa1_review_cadence', label: 'SA Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SA-4': {
    controlNumber: 'SA-4',
    family: 'SA',
    title: 'Acquisition Process',
    objectives: [
      {
        letter: 'a',
        text: 'the organization includes security and privacy requirements in acquisition contracts based on risk assessments',
        prefilledTemplate: 'Procurement contracts mandate adherence to NIST SP 800-171, FedRAMP Moderate, and DFARS 252.204-7012 for all cloud service providers and software vendors.',
      },
      {
        letter: 'b',
        text: 'the organization requires developers of systems or system components to implement security controls throughout the SDLC',
        prefilledTemplate: 'Third-party software vendors must provide software bill of materials (SBOM) and verified clean static code analysis reports prior to software acceptance.',
      },
    ],
  },
  'SA-9': {
    controlNumber: 'SA-9',
    family: 'SA',
    title: 'External System Services',
    objectives: [
      {
        letter: 'a',
        text: 'the organization requires that external service providers comply with organizational security requirements and establish of a monitoring process',
        prefilledTemplate: 'All cloud service providers (CSPs) hosting CUI must possess an active FedRAMP Moderate or High Joint Authorization Board (JAB) / Agency ATO.',
      },
      {
        letter: 'b',
        text: 'the organization monitors provider compliance with security requirements at the defined frequency',
        prefilledTemplate: 'Vendor SOC 2 Type II reports and FedRAMP continuous monitoring deliverables are reviewed [ODP: annually] by the GRC team.',
        odpParameters: [{ id: 'sa9_vendor_review_freq', label: 'External Provider Audit Cadence', defaultValue: 'annually' }],
      },
    ],
  },

  // ── 18. SC: SYSTEM AND COMMUNICATIONS PROTECTION ──────────────────────────
  'SC-1': {
    controlNumber: 'SC-1',
    family: 'SC',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a system and communications protection policy',
        prefilledTemplate: 'The System and Communications Protection Policy establishes network segmentation rules, encryption standards, and cryptographic key management lifecycles.',
      },
      {
        letter: 'b',
        text: 'the system and communications protection policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by the Principal Network Security Architect.',
        odpParameters: [{ id: 'sc1_review_cadence', label: 'SC Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SC-7': {
    controlNumber: 'SC-7',
    family: 'SC',
    title: 'Boundary Protection',
    objectives: [
      {
        letter: 'a',
        text: 'the system monitors and controls communications at the external boundary of the system and at key internal boundaries within the system',
        prefilledTemplate: 'Network boundaries are protected via Azure Virtual Network Security Groups (NSGs), AWS Security Groups, and Next-Generation Firewalls (NGFW) with intrusion prevention systems (IPS) actively blocking unauthorized ingress and egress traffic.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'firewalld_service_enabled',
      },
      {
        letter: 'b',
        text: 'the system connects to external networks only through managed interfaces consisting of boundary protection devices arranged in accordance with organizational security architecture',
        prefilledTemplate: 'All external network connectivity routes through a central egress DMZ hub inspecting outbound traffic with SSL/TLS decryption and Deep Packet Inspection (DPI).',
      },
      {
        letter: 'c',
        text: 'the system isolates security-critical system components into separate subnets or virtual local area networks',
        prefilledTemplate: 'Database tiers, identity controllers, and public-facing gateways reside in dedicated, micro-segmented subnets with zero direct internet routability.',
      },
    ],
  },
  'SC-7(7)': {
    controlNumber: 'SC-7(7)',
    family: 'SC',
    title: 'Prevent Split Tunneling for Remote Devices',
    objectives: [
      {
        letter: 'a',
        text: 'the system prevents remote devices from simultaneously establishing non-remote connections with the system and communicating with external systems',
        prefilledTemplate: 'GlobalProtect and Azure VPN clients enforce a strict full-tunnel configuration pushed via Intune GPO. Split-tunneling is blocked at the kernel network driver level, preventing dual-homed routing to the public internet.',
        isAutoVerifiedByTelemetry: true,
      },
      {
        letter: 'b',
        text: 'the remote connection configuration is verified and validated continuously',
        prefilledTemplate: 'Endpoint compliance policies monitor the active routing table and disconnect corporate sessions if an unencrypted adapter or secondary physical NIC is activated.',
      },
    ],
  },
  'SC-8': {
    controlNumber: 'SC-8',
    family: 'SC',
    title: 'Transmission Confidentiality and Integrity',
    objectives: [
      {
        letter: 'a',
        text: 'the system protects the confidentiality and integrity of transmitted information',
        prefilledTemplate: 'All sensitive data and network communications in transit are encrypted using FIPS 140-3 validated TLS 1.3 / IPsec tunnels with AES-256-GCM ciphers. Deprecated ciphers (SSLv3, TLS 1.0, TLS 1.1, RC4, 3DES) are disabled.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'sshd_use_approved_ciphers',
      },
      {
        letter: 'b',
        text: 'the system enforces cryptographic mechanisms to detect data transmission tampering',
        prefilledTemplate: 'Network message integrity is validated through HMAC-SHA-256 and authenticated GCM tags verifying tamper-free delivery.',
      },
    ],
  },
  'SC-12': {
    controlNumber: 'SC-12',
    family: 'SC',
    title: 'Cryptographic Key Establishment and Management',
    objectives: [
      {
        letter: 'a',
        text: 'the organization establishes and manages cryptographic keys for required cryptography in accordance with key management procedures',
        prefilledTemplate: 'Cryptographic keys are generated and protected within FIPS 140-3 Level 3 Hardware Security Modules (HSMs) using Azure Key Vault and AWS KMS with dual-custody access controls.',
      },
      {
        letter: 'b',
        text: 'the organization rotates cryptographic keys at the defined frequency',
        prefilledTemplate: 'Encryption keys and TLS certificates are automatically rotated [ODP: annually] via automated Key Vault certificate renewal triggers.',
        odpParameters: [{ id: 'sc12_key_rotation_freq', label: 'Cryptographic Key Rotation Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SC-13': {
    controlNumber: 'SC-13',
    family: 'SC',
    title: 'Cryptographic Protection',
    objectives: [
      {
        letter: 'a',
        text: 'the system implements FIPS-validated cryptographic modules in accordance with applicable federal laws and policies',
        prefilledTemplate: 'Operating systems operate in FIPS mode (fips=1 in GRUB on Linux, FIPSMode enabled via Windows GPO). All encryption libraries are certified under NIST Cryptographic Module Validation Program (CMVP).',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'enable_fips_mode',
      },
      {
        letter: 'b',
        text: 'cryptographic mechanisms comply with designated cryptographic key lengths and algorithm standards',
        prefilledTemplate: 'Algorithms adhere to NIST SP 800-131A Rev. 2 guidelines: RSA >= 3072 bits, ECDSA >= 256 bits, and AES >= 256 bits.',
      },
    ],
  },
  'SC-28': {
    controlNumber: 'SC-28',
    family: 'SC',
    title: 'Protection of Information at Rest',
    objectives: [
      {
        letter: 'a',
        text: 'the system protects the confidentiality and integrity of information at rest',
        prefilledTemplate: 'All information at rest is encrypted using AES-256 BitLocker on Windows endpoints, dm-crypt/LUKS on Linux systems, and cloud storage server-side encryption with customer-managed keys (CMK).',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'encrypt_partitions',
      },
      {
        letter: 'b',
        text: 'cryptographic mechanisms used for information at rest protection are managed to prevent unauthorized access or disclosure',
        prefilledTemplate: 'BitLocker recovery keys and LUKS key material are backed up to Entra ID with access restricted to authorized Tier 3 Systems Administrators.',
      },
    ],
  },

  // ── 19. SI: SYSTEM AND INFORMATION INTEGRITY ──────────────────────────────
  'SI-1': {
    controlNumber: 'SI-1',
    family: 'SI',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a system and information integrity policy',
        prefilledTemplate: 'The System and Information Integrity Policy establishes patch timelines, antivirus/EDR mandates, SIEM alerting rules, and flaw remediation criteria.',
      },
      {
        letter: 'b',
        text: 'the system and information integrity policy is reviewed at the defined frequency',
        prefilledTemplate: 'The policy is reviewed [ODP: annually] by the Chief Technology Officer.',
        odpParameters: [{ id: 'si1_review_cadence', label: 'SI Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SI-2': {
    controlNumber: 'SI-2',
    family: 'SI',
    title: 'Flaw Remediation',
    objectives: [
      {
        letter: 'a',
        text: 'the organization identifies, reports, and corrects system flaws',
        prefilledTemplate: 'Flaws and vulnerabilities are tracked in Jira and remediated through automated patch management using Microsoft Intune and Ansible Automation Platform.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'security_patches_up_to_date',
      },
      {
        letter: 'b',
        text: 'the organization tests software and firmware updates related to flaw remediation for effectiveness and potential side effects before installation',
        prefilledTemplate: 'Patches are tested in a non-production staging environment for [ODP: 72 hours] to verify stability before production roll-out.',
        odpParameters: [{ id: 'si2_testing_window', label: 'Patch Staging Validation Window', defaultValue: '72 hours' }],
      },
      {
        letter: 'c',
        text: 'the organization installs security-relevant software and firmware updates within the defined time period of release',
        prefilledTemplate: 'Security patches are deployed within [ODP: 30 days of vendor release for High/Medium, and within 7 days for Critical/Zero-Day vulnerabilities].',
        odpParameters: [{ id: 'si2_patch_deployment_sla', label: 'Patch Remediation Window', defaultValue: '30 days of vendor release for High/Medium, and within 7 days for Critical/Zero-Day vulnerabilities' }],
      },
    ],
  },
  'SI-3': {
    controlNumber: 'SI-3',
    family: 'SI',
    title: 'Malicious Code Protection',
    objectives: [
      {
        letter: 'a',
        text: 'the organization employs malicious code protection mechanisms at system entry and exit points and on endpoint devices',
        prefilledTemplate: 'Endpoint Detection and Response (EDR) via Microsoft Defender for Endpoint is active on all Windows, macOS, and Linux endpoints, with cloud-delivered protection and automated behavioral heuristics blocking malware execution.',
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'service_defender_active',
      },
      {
        letter: 'b',
        text: 'the organization updates malicious code protection mechanisms with signature and behavioral definitions at the defined frequency',
        prefilledTemplate: 'Antivirus and EDR definition updates download automatically [ODP: multiple times daily (every 4 hours)] directly from cloud intelligence backends.',
        odpParameters: [{ id: 'si3_def_update_freq', label: 'Antivirus Definition Update Cadence', defaultValue: 'multiple times daily (every 4 hours)' }],
      },
      {
        letter: 'c',
        text: 'the system performs real-time and periodic scans of the system for malicious code',
        prefilledTemplate: 'On-access real-time scanning inspects all file read/write operations, downloads, and USB attachments; full endpoint scans run [ODP: weekly on Sundays].',
        odpParameters: [{ id: 'si3_scan_cadence', label: 'Full System Antivirus Scan Cadence', defaultValue: 'weekly on Sundays' }],
      },
    ],
  },
  'SI-4': {
    controlNumber: 'SI-4',
    family: 'SI',
    title: 'System Monitoring',
    objectives: [
      {
        letter: 'a',
        text: 'the system monitors for attacks and indicators of potential compromise at strategic locations',
        prefilledTemplate: 'Microsoft Sentinel, Azure Network Watcher, and Sysmon continuously ingest network flow logs, DNS queries, and endpoint telemetry across [ODP: Azure Government and AWS GovCloud enclaves].',
        odpParameters: [{ id: 'si4_monitored_enclave', label: 'Monitored Cloud Enclaves', defaultValue: 'Azure Government and AWS GovCloud enclaves' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'service_syslog_enabled',
      },
      {
        letter: 'b',
        text: 'the system detects inbound and outbound network traffic for unauthorized connections and malicious behavior',
        prefilledTemplate: 'Intrusion Detection/Prevention Systems (IDS/IPS) detect unauthorized outbound C2 beacons and block port scans in real time.',
      },
      {
        letter: 'c',
        text: 'the organization heightened system monitoring activities during times of heightened threat risk',
        prefilledTemplate: 'SOC engineers adjust Sentinel detection sensitivity and increase packet capture buffer retention during CISA Shields Up alerts or active attack campaigns.',
      },
      {
        letter: 'd',
        text: 'the system alerts designated personnel of detected anomalous behavior within the defined time period',
        prefilledTemplate: 'High-severity detection rules trigger automated incident alerts [ODP: within 15 minutes of detection to the SOC] via PagerDuty and secure messaging.',
        odpParameters: [{ id: 'si4_incident_alert_sla', label: 'SOC Escalation Notification SLA', defaultValue: 'within 15 minutes of detection to the SOC' }],
        isAutoVerifiedByTelemetry: true,
        scapRuleId: 'soar_alerting_sla_configured',
      },
    ],
  },
  'SI-5': {
    controlNumber: 'SI-5',
    family: 'SI',
    title: 'Security Alerts, Advisories, and Directives',
    objectives: [
      {
        letter: 'a',
        text: 'the organization receives system security alerts, advisories, and directives from external organizations on an ongoing basis',
        prefilledTemplate: 'Security leads subscribe to CISA Cyber Bulletins, US-CERT automated feeds, Microsoft Security Response Center (MSRC), and Red Hat Security Advisories.',
      },
      {
        letter: 'b',
        text: 'the organization generates internal security advisories and takes directive actions within the defined time period',
        prefilledTemplate: 'Internal security advisories are issued within [ODP: 24 hours of receiving critical CVE disclosures], prompting patch deployment or compensating firewall mitigations.',
        odpParameters: [{ id: 'si5_advisory_sla', label: 'Internal Advisory SLA', defaultValue: '24 hours of receiving critical CVE disclosures' }],
      },
    ],
  },

  // ── 20. SR: SUPPLY CHAIN RISK MANAGEMENT ──────────────────────────────────
  'SR-1': {
    controlNumber: 'SR-1',
    family: 'SR',
    title: 'Policy and Procedures',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops, documents, and disseminates a supply chain risk management policy',
        prefilledTemplate: 'The Supply Chain Risk Management (SCRM) Policy establishes vendor integrity vetting, counterfeit part prevention, and foreign ownership control checks.',
      },
      {
        letter: 'b',
        text: 'the supply chain risk management policy is reviewed at the defined frequency',
        prefilledTemplate: 'The SCRM policy is reviewed [ODP: annually] by the Supply Chain Security Council.',
        odpParameters: [{ id: 'sr1_review_cadence', label: 'SCRM Policy Review Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SR-2': {
    controlNumber: 'SR-2',
    family: 'SR',
    title: 'Supply Chain Risk Management Plan',
    objectives: [
      {
        letter: 'a',
        text: 'the organization develops a plan for managing supply chain risks associated with the research, development, design, manufacturing, acquisition, delivery, integration, operations, and disposal of system components',
        prefilledTemplate: 'The organization maintains a formal SCRM Plan detailing supplier tier mapping, third-party dependency scanning, and hardware provenance verification.',
      },
      {
        letter: 'b',
        text: 'the supply chain risk management plan is reviewed and updated at the defined frequency',
        prefilledTemplate: 'The SCRM Plan is reviewed and updated [ODP: annually] to incorporate federal NDAA Section 889 and Section 5949 prohibitions.',
        odpParameters: [{ id: 'sr2_update_cadence', label: 'SCRM Plan Update Cadence', defaultValue: 'annually' }],
      },
    ],
  },
  'SR-3': {
    controlNumber: 'SR-3',
    family: 'SR',
    title: 'Supply Chain Controls and Processes',
    objectives: [
      {
        letter: 'a',
        text: 'the organization establishes a supply chain risk management process that identifies and assesses supply chain risks',
        prefilledTemplate: 'Vendors providing hardware, software, or services must complete third-party risk questionnaires and verify absence of prohibited foreign components (e.g., Huawei, ZTE, Dahua, Hikvision, Kaspersky).',
      },
      {
        letter: 'b',
        text: 'the organization implements processes to verify that acquired hardware, software, and firmware are authentic and not counterfeit',
        prefilledTemplate: 'Hardware is purchased exclusively through authorized manufacturer distribution channels with tamper-evident seals and cryptographic serial verification.',
      },
    ],
  },
};

/**
 * Main seed execution routine:
 * Reads src/data/frameworks/assessmentObjectives.ts, injects NIST_800_53A_CATALOG into
 * the registry, adds recalculateControlStatusFromObjectives, and formats cleanly.
 */
export function seedNist80053Objectives(): void {
  const targetFilePath = path.resolve(process.cwd(), 'src/data/frameworks/assessmentObjectives.ts');

  console.log(`[Seed Script] Reading ${targetFilePath}...`);
  if (!fs.existsSync(targetFilePath)) {
    throw new Error(`Target file not found: ${targetFilePath}`);
  }

  let content = fs.readFileSync(targetFilePath, 'utf8');

  // Format the NIST SP 800-53 catalog as clean TypeScript code
  const formattedCatalogEntries = Object.entries(NIST_800_53A_CATALOG)
    .map(([key, template]) => {
      const json = JSON.stringify(template, null, 2);
      // Indent appropriately for placement inside NIST_800_171A_REGISTRY
      const indented = json
        .split('\n')
        .map((line, idx) => (idx === 0 ? `  '${key}': ${line}` : `  ${line}`))
        .join('\n');
      return `${indented},`;
    })
    .join('\n');

  // Replace or inject into NIST_800_171A_REGISTRY
  const marker = '// ──────────────────────────────────────────────────────────────────────────\n  // NIST SP 800-53 REV. 5 / 800-53A RMF CONTROLS & ATO NARRATIVE BASELINES\n  // ──────────────────────────────────────────────────────────────────────────';

  let updatedContent = '';
  if (content.includes(marker)) {
    const splitIndex = content.indexOf(marker);
    const beforeMarker = content.substring(0, splitIndex + marker.length);
    // Find where the registry ends (the closing }; before getAssessmentObjectivesForControl)
    const afterMarkerSub = content.substring(splitIndex + marker.length);
    const registryCloseIndex = afterMarkerSub.indexOf('};\n\n/**\n * Creates standardized determination');
    
    if (registryCloseIndex === -1) {
      throw new Error('Could not find registry closure in assessmentObjectives.ts');
    }

    const remainder = afterMarkerSub.substring(registryCloseIndex);
    updatedContent = `${beforeMarker}\n${formattedCatalogEntries}\n${remainder}`;
  } else {
    // If marker not found, insert before closing }; of registry
    const registryEndPattern = '};\n\n/**\n * Creates standardized determination';
    const splitIndex = content.indexOf(registryEndPattern);
    if (splitIndex === -1) {
      throw new Error('Could not find registry end pattern in assessmentObjectives.ts');
    }
    const before = content.substring(0, splitIndex);
    const after = content.substring(splitIndex);
    updatedContent = `${before}\n  ${marker}\n${formattedCatalogEntries}\n${after}`;
  }

  // Ensure recalculateControlStatusFromObjectives is exported
  if (!updatedContent.includes('export function recalculateControlStatusFromObjectives')) {
    const helperToAdd = `
/**
 * Evaluates individual objectives to determine overall control status (MET, NOT_MET, IN_PROGRESS, NOT_STARTED).
 * Fully aligned with NIST SP 800-53A Rev. 5 and NIST SP 800-171A C3PAO assessment methods.
 */
export function recalculateControlStatusFromObjectives(objectives: AssessmentObjective[]): ObjectiveStatus {
  return calculateControlRollup(objectives).calculatedStatus;
}
`;
    updatedContent += helperToAdd;
  }

  // Also export NIST_800_53A_OBJECTIVES alias
  if (!updatedContent.includes('export const NIST_800_53A_OBJECTIVES')) {
    const aliasToAdd = `
/**
 * Exported alias containing complete NIST SP 800-53A Rev. 5 determination statements and baseline templates
 */
export const NIST_800_53A_OBJECTIVES: Record<string, ControlObjectivesTemplate> = Object.fromEntries(
  Object.entries(NIST_800_171A_REGISTRY).filter(([k]) => k.includes('-') && !k.includes('.L'))
);
`;
    // Add before the helper functions
    const insertPoint = updatedContent.indexOf('export function getAssessmentObjectivesForControl');
    if (insertPoint !== -1) {
      updatedContent = updatedContent.substring(0, insertPoint) + aliasToAdd + '\n' + updatedContent.substring(insertPoint);
    } else {
      updatedContent += aliasToAdd;
    }
  }

  fs.writeFileSync(targetFilePath, updatedContent, 'utf8');

  const families = new Set(Object.values(NIST_800_53A_CATALOG).map(c => c.family));
  const totalObjectives = Object.values(NIST_800_53A_CATALOG).reduce((acc, c) => acc + c.objectives.length, 0);

  console.log(`[Seed Script] Successfully populated ${targetFilePath}!`);
  console.log(`[Seed Script] NIST SP 800-53 Rev. 5 Families: ${families.size} (${Array.from(families).join(', ')})`);
  console.log(`[Seed Script] Controls Populated: ${Object.keys(NIST_800_53A_CATALOG).length}`);
  console.log(`[Seed Script] Total 800-53A Determination Objectives: ${totalObjectives}`);
}

// Execute if run directly via npx tsx scripts/seed80053Objectives.ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.includes('seed80053Objectives')) {
  seedNist80053Objectives();
}
