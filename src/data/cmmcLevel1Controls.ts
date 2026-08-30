import { ControlDefinition, DomainCode, DomainInfo } from '../types/cmmc';

export const DOMAINS: Record<DomainCode, DomainInfo> = {
  AC: {
    code: 'AC',
    name: 'Access Control',
    description: 'Limit information system access to authorized users, processes acting on behalf of authorized users, and devices (including other systems).',
    totalControls: 4,
    iconName: 'ShieldCheck',
    color: '#0284c7', // Sky blue
  },
  IA: {
    code: 'IA',
    name: 'Identification & Authentication',
    description: 'Identify information system users, processes acting on behalf of users, or devices and authenticate (verify) the identities before granting access.',
    totalControls: 2,
    iconName: 'KeyRound',
    color: '#8b5cf6', // Violet
  },
  MP: {
    code: 'MP',
    name: 'Media Protection',
    description: 'Sanitize or destroy information system media containing Federal Contract Information (FCI) before disposal or release for reuse.',
    totalControls: 1,
    iconName: 'HardDriveDownload',
    color: '#ec4899', // Pink
  },
  PE: {
    code: 'PE',
    name: 'Physical Protection',
    description: 'Limit physical access to organizational information systems, equipment, and the respective operating environments to authorized individuals.',
    totalControls: 4,
    iconName: 'Building2',
    color: '#f59e0b', // Amber
  },
  SC: {
    code: 'SC',
    name: 'System & Communications Protection',
    description: 'Monitor, control, and protect organizational communications (i.e., information transmitted or received by information systems) at system boundaries.',
    totalControls: 2,
    iconName: 'Network',
    color: '#10b981', // Emerald
  },
  SI: {
    code: 'SI',
    name: 'System & Information Integrity',
    description: 'Identify, report, and correct information and information system flaws in a timely manner; provide protection from malicious code.',
    totalControls: 4,
    iconName: 'CheckCircle2',
    color: '#06b6d4', // Cyan
  },
};

export const CMMC_LEVEL_1_CONTROLS: ControlDefinition[] = [
  // -------------------------------------------------------------
  // ACCESS CONTROL (AC) - 4 Controls
  // -------------------------------------------------------------
  {
    id: 'AC.L1-3.1.1',
    title: 'Authorized Access Control',
    domain: 'AC',
    farReference: 'FAR 52.204-21(b)(1)(i)',
    plainEnglishSummary: 'Only allow authorized users, devices, and automated processes to log into and access your company systems and data.',
    discussion: 'This requirement ensures that organizations control who connects to their systems. Access must be limited to designated employees, contractors, and managed devices with an approved business need. Shared accounts or guest access without authorization are strictly forbidden.',
    assessmentObjectives: [
      'Authorized users are identified.',
      'Processes acting on behalf of authorized users are identified.',
      'Devices (and other systems) authorized to connect to systems are identified.',
      'System access is limited to authorized users, processes, and devices.'
    ],
    auditorChecklist: [
      'Active directory / Identity provider user roster with active status.',
      'Formal user onboarding & offboarding policy or checklist.',
      'Approved device inventory list (MDM / Intune / Active Directory).',
      'Proof that terminated employees are disabled promptly.'
    ],
    starterTemplates: [
      {
        title: 'Microsoft 365 / Entra ID Cloud Architecture',
        description: 'Standard M365 Business Premium setup with cloud identity management.',
        category: 'm365',
        narrative: 'All user accounts are provisioned exclusively through Microsoft Entra ID (Azure AD). Individual named user accounts are required for all staff; generic and shared accounts are prohibited. Device access is restricted to company-managed laptops enrolled in Microsoft Intune MDM with compliant device status policies enforced via Entra Conditional Access.',
        recommendedEvidence: ['M365_ActiveUsers_Export.csv', 'Intune_EnrolledDevices_List.pdf', 'Access_Control_Policy_v2.pdf']
      },
      {
        title: 'Google Cloud & Google Workspace Identity Baseline',
        description: 'Google Workspace Enterprise with Google Cloud IAM and Context-Aware Access.',
        category: 'gcp',
        narrative: 'User identities are managed centrally through Google Workspace and Google Cloud Identity. Each employee is assigned an individual corporate Google Workspace account. Access to internal resources and GCP enclaves is governed by Google Cloud IAM and Context-Aware Access policies requiring company-managed hardware with verified endpoint certificates.',
        recommendedEvidence: ['Google_Workspace_User_List.pdf', 'GCP_IAM_Policy_Export.json', 'Context_Aware_Access_Rules.png']
      },
      {
        title: 'Hybrid Active Directory & On-Premises Environment',
        description: 'Traditional on-premises Windows Server Domain Controller with local network controls.',
        category: 'activedirectory',
        narrative: 'User identities are managed via on-premises Active Directory Domain Services (AD DS). Access is granted following the principle of least privilege using role-based security groups. Device MAC filtering and 802.1X network access control ensure only company-tagged hardware can join the corporate domain.',
        recommendedEvidence: ['AD_Users_and_Computers_Roster.png', 'Domain_Group_Policy_Export.html']
      }
    ]
  },
  {
    id: 'AC.L1-3.1.2',
    title: 'Limit User Function Access',
    domain: 'AC',
    farReference: 'FAR 52.204-21(b)(1)(ii)',
    plainEnglishSummary: 'Restrict standard users to only the transactions, files, and functions they need to do their jobs. Limit administrative privileges.',
    discussion: 'Organizations must enforce separation of duties and least privilege. Regular staff members must not possess administrative rights on their workstations or cloud tenants. Elevated administrative actions must require separate dedicated admin credentials used only when performing maintenance.',
    assessmentObjectives: [
      'Types of transactions and functions that authorized users are permitted to execute are defined.',
      'System access is limited to the defined permitted transactions and functions.'
    ],
    auditorChecklist: [
      'Role-Based Access Control (RBAC) matrix or access permissions chart.',
      'Proof that standard users do NOT have local administrator rights on endpoints.',
      'List of designated system administrators with separate `.admin` accounts.'
    ],
    starterTemplates: [
      {
        title: 'Standard Enterprise Role-Based Access (Least Privilege)',
        description: 'Standard corporate model removing local admin rights from daily users.',
        category: 'm365',
        narrative: 'Standard day-to-day user accounts do not possess local administrator rights on company endpoints. Elevated privileges are strictly assigned to dedicated secondary administrative accounts (e.g. `admin-jdoe`) used exclusively for system configuration. Role-based access control (RBAC) in cloud applications ensures employees only access folders and repositories required for their assigned job duties.',
        recommendedEvidence: ['Endpoint_LocalAdmins_Audit.png', 'M365_AdminRoles_Screenshot.png', 'RBAC_Permissions_Matrix.xlsx']
      },
      {
        title: 'GCP Predefined IAM Roles & Cloud Identity Groups',
        description: 'Cloud IAM least privilege configuration with security groups.',
        category: 'gcp',
        narrative: 'Access to cloud systems is restricted using GCP predefined IAM roles and Google Workspace Security Groups. Daily user identities hold zero project-level admin rights. All administrative changes to cloud compute, database, and storage assets require separate PIM/PAM or dedicated elevated administrator accounts with audit logging enabled in Cloud Audit Logs.',
        recommendedEvidence: ['GCP_IAM_Role_Assignments.json', 'Workspace_Admin_Roles.pdf']
      }
    ]
  },
  {
    id: 'AC.L1-3.1.20',
    title: 'Control External Connections',
    domain: 'AC',
    farReference: 'FAR 52.204-21(b)(1)(iii)',
    plainEnglishSummary: 'Verify and control all external connections to your systems (such as VPNs, remote desktop tools, and partner networks).',
    discussion: 'External connections represent key ingress points for potential adversaries. Any connection originating outside the organization boundary must be explicitly identified, authorized, monitored, and secured with strong encryption and multi-factor authentication.',
    assessmentObjectives: [
      'Connections to external systems are identified and verified.',
      'Connections to external systems are authorized.',
      'Use of external connections is monitored and controlled.'
    ],
    auditorChecklist: [
      'Network diagram illustrating external connection points and VPN gateways.',
      'Firewall / VPN configuration rules showing encrypted remote access protocols.',
      'List of authorized third-party SaaS vendors and API connections.'
    ],
    starterTemplates: [
      {
        title: 'Remote Workforce with Secure VPN & Conditional Access',
        description: 'Remote / hybrid team utilizing encrypted VPN or Cloud Zero Trust gateways.',
        category: 'm365',
        narrative: 'All remote access to internal corporate systems requires encrypted WireGuard/IPsec VPN connections authenticated with Multi-Factor Authentication (MFA). Direct Remote Desktop Protocol (RDP) ports (3389) are strictly blocked at the perimeter firewall. Cloud services are protected by Entra ID Conditional Access policies requiring trusted locations or compliant devices.',
        recommendedEvidence: ['Network_Topology_Diagram.pdf', 'Firewall_InboundRules_Export.png', 'VPN_Config_Settings.pdf']
      },
      {
        title: 'Google Cloud Identity-Aware Proxy (IAP) & Zero Trust',
        description: 'Zero Trust external connection verification without exposing public IP addresses.',
        category: 'gcp',
        narrative: 'Remote administrative and operational access to backend resources is mediated strictly via Google Cloud Identity-Aware Proxy (IAP). No external IP addresses or open remote management ports (SSH/RDP) are exposed directly to the public internet. All external sessions are verified via Context-Aware access rules before tunneling.',
        recommendedEvidence: ['IAP_Access_Policies.png', 'Firewall_Ingress_Rules_GCP.json']
      }
    ]
  },
  {
    id: 'AC.L1-3.1.22',
    title: 'Control Public Information',
    domain: 'AC',
    farReference: 'FAR 52.204-21(b)(1)(iv)',
    plainEnglishSummary: 'Review and approve all information before it is posted on publicly accessible systems (like public websites, marketing blogs, or social media).',
    discussion: 'Organizations must have a formal review procedure to prevent the accidental disclosure of Federal Contract Information (FCI), Controlled Unclassified Information (CUI), or proprietary system architectural data onto public-facing channels.',
    assessmentObjectives: [
      'Individuals authorized to post information onto publicly accessible systems are identified.',
      'Procedures to review information prior to posting onto publicly accessible systems are established and implemented.'
    ],
    auditorChecklist: [
      'Public Information Review and Approval Policy.',
      'Designated list of marketing / web publishing approvers.',
      'Sample marketing release or web post approval sign-off record.'
    ],
    starterTemplates: [
      {
        title: 'Formal Public Release Review Process',
        description: 'Policy and workflow requiring executive review before web postings.',
        category: 'physical',
        narrative: 'The organization maintains a Public Information Posting Policy. Only designated Communications and Executive staff are authorized to post content to the public company website and social channels. All marketing materials, technical whitepapers, and public posts undergo a pre-publication review by the Security Lead to ensure no contract information or sensitive operational details are disclosed.',
        recommendedEvidence: ['Public_Information_Review_Policy.pdf', 'Sample_Public_Post_Signoff.pdf']
      }
    ]
  },

  // -------------------------------------------------------------
  // IDENTIFICATION & AUTHENTICATION (IA) - 2 Controls
  // -------------------------------------------------------------
  {
    id: 'IA.L1-3.5.1',
    title: 'Identify Users and Devices',
    domain: 'IA',
    farReference: 'FAR 52.204-21(b)(1)(v)',
    plainEnglishSummary: 'Ensure every user and device has a unique, identifiable name before allowing them to access systems.',
    discussion: 'Accountability requires that every action on a system can be traced back to an identifiable individual or device. Shared generic accounts (such as "shop_user" or "admin") undermine auditability and are not allowed.',
    assessmentObjectives: [
      'System users are uniquely identified.',
      'Processes acting on behalf of users are identified.',
      'Devices accessing organizational systems are uniquely identified.'
    ],
    auditorChecklist: [
      'User account naming convention policy (e.g. `first.last@domain.com`).',
      'Inventory of unique device hostnames and asset tags.',
      'Screenshot of user directory showing absence of generic / shared accounts.'
    ],
    starterTemplates: [
      {
        title: 'Unique User UPN and Asset Tag Identity Scheme',
        description: 'Standard unique naming convention for employees and hardware.',
        category: 'm365',
        narrative: 'All employees are issued unique User Principal Names (UPNs) formatted as `firstname.lastname@company.com`. Generic and shared credentials are prohibited. All corporate laptops and workstations are assigned unique asset identifiers (e.g. `CORP-LAP-042`) and registered in the centralized device management directory.',
        recommendedEvidence: ['User_Directory_Roster.png', 'Device_Asset_Inventory.xlsx']
      },
      {
        title: 'Google Cloud Identity & Service Account Uniqueness',
        description: 'Google Workspace user naming and GCP service account naming convention.',
        category: 'gcp',
        narrative: 'All employees are assigned unique Google Workspace email addresses (`username@company.com`). Automated processes and system services run under dedicated Google Cloud Service Accounts with distinct display names and descriptions specifying their exact purpose. Shared accounts are strictly disabled in Google Admin.',
        recommendedEvidence: ['Google_Workspace_Users_Export.csv', 'GCP_Service_Accounts_List.pdf']
      }
    ]
  },
  {
    id: 'IA.L1-3.5.2',
    title: 'Authenticate Users and Devices',
    domain: 'IA',
    farReference: 'FAR 52.204-21(b)(1)(vi)',
    plainEnglishSummary: 'Verify the identity of each user and device (passwords, MFA, passkeys, or certificates) before granting access.',
    discussion: 'Authentication is the mechanism by which the claimed identity is validated. Robust password standards, account lockout policies, and Multi-Factor Authentication (MFA) must be enforced across all systems holding FCI.',
    assessmentObjectives: [
      'The identity of each user is authenticated (verified) as a prerequisite to allowing system access.',
      'The identity of each device is authenticated as a prerequisite to allowing system access.'
    ],
    auditorChecklist: [
      'Password policy configuration (min 14 characters, complexity, lockout threshold).',
      'Multi-Factor Authentication (MFA) enforcement dashboard or report.',
      'Wi-Fi / 802.1X authentication configuration (WPA3-Enterprise or pre-shared certificate).'
    ],
    starterTemplates: [
      {
        title: 'Entra ID MFA & NIST 800-63B Password Standard',
        description: 'MFA enforced across all accounts with strong password complexity.',
        category: 'm365',
        narrative: 'Authentication is enforced centrally via Microsoft Entra ID. Password complexity requirements mandate a minimum length of 14 characters. Multi-Factor Authentication (MFA) using the Microsoft Authenticator app (Number Matching) or FIDO2 security keys is strictly enforced for 100% of user accounts. Account lockout is triggered after 5 consecutive failed attempts.',
        recommendedEvidence: ['M365_MFA_Registration_Report.png', 'Password_Policy_GPO_Export.png']
      },
      {
        title: 'Google 2-Step Verification (2SV) & FIDO2 Security Keys',
        description: 'Google Workspace mandatory 2-step verification policy.',
        category: 'gcp',
        narrative: 'Two-Step Verification (2SV) is enforced for all Google Workspace and GCP user accounts via organization-level policy. Acceptable second factors include hardware security keys (FIDO2/WebAuthn) and Google Prompt/Authenticator. SMS verification is deprecated in accordance with NIST SP 800-63B guidelines.',
        recommendedEvidence: ['Google_2SV_Enforcement_Report.png', 'Security_Key_Distribution_Log.pdf']
      }
    ]
  },

  // -------------------------------------------------------------
  // MEDIA PROTECTION (MP) - 1 Control
  // -------------------------------------------------------------
  {
    id: 'MP.L1-3.8.3',
    title: 'Sanitize or Destroy Media',
    domain: 'MP',
    farReference: 'FAR 52.204-21(b)(1)(vii)',
    plainEnglishSummary: 'Securely wipe, sanitize, or physically destroy hard drives, USBs, and paper documents containing contract info before discarding or reusing them.',
    discussion: 'Information media (digital hard drives, SSDs, USB flash drives, backup tapes, as well as physical paper documents) must be sanitized in accordance with NIST SP 800-88 guidelines to prevent data recovery by unauthorized parties.',
    assessmentObjectives: [
      'System media containing Federal Contract Information is sanitized or destroyed before disposal.',
      'System media containing Federal Contract Information is sanitized or destroyed before release for reuse.'
    ],
    auditorChecklist: [
      'Media Sanitization and Disposal Policy.',
      'Cross-cut shredder specifications for paper documents (DIN 66399 Level P-4 or higher).',
      'Certificate of destruction from certified third-party electronic recycling vendor (NAID/R2).',
      'Cryptographic erasure / BitLocker wipe records for decommissioned drives.'
    ],
    starterTemplates: [
      {
        title: 'NIST SP 800-88 Media Sanitization & Certified Disposal',
        description: 'Procedures for digital drive wiping and certified physical destruction.',
        category: 'physical',
        narrative: 'All digital storage media (SSDs, NVMe drives) are encrypted with BitLocker/FileVault (AES-256) throughout their lifecycle. Prior to decommissioning or hardware reuse, drives undergo cryptographic wipe using DoD 5220.22-M / NIST SP 800-88 Clear/Purge standards. Non-reusable storage media are sent to a NAID-certified electronic destruction partner with serialized certificates of destruction retained.',
        recommendedEvidence: ['Media_Sanitization_Policy.pdf', 'Sample_Destruction_Certificate.pdf', 'Shredder_Purchase_Receipt.png']
      }
    ]
  },

  // -------------------------------------------------------------
  // PHYSICAL PROTECTION (PE) - 4 Controls
  // -------------------------------------------------------------
  {
    id: 'PE.L1-3.10.1',
    title: 'Limit Physical Access',
    domain: 'PE',
    farReference: 'FAR 52.204-21(b)(1)(viii)',
    plainEnglishSummary: 'Protect your office, server rooms, and work areas with locked doors, keycards, or badges so only authorized staff can enter.',
    discussion: 'Physical security safeguards the hardware and paper documents from unauthorized observation or theft. Physical perimeters must have access controls such as electronic badge readers, key locks, or security personnel.',
    assessmentObjectives: [
      'Physical access to organizational systems is limited to authorized individuals.',
      'Physical access to equipment is limited to authorized individuals.',
      'Physical access to operating environments is limited to authorized individuals.'
    ],
    auditorChecklist: [
      'Physical facility security policy.',
      'Keycard access log or key issuance register.',
      'Photos of locked server rack / comms closet with restricted key/card access.',
      'Clean desk and screen lock policy (auto-lock after 10-15 minutes).'
    ],
    starterTemplates: [
      {
        title: 'Keycard Access & Secure Server Enclosure',
        description: 'Commercial facility with badge access and locked IT comms rack.',
        category: 'physical',
        narrative: 'Physical entrance to the corporate office is secured 24/7 via electronic RFID badge access. Only vetted full-time personnel are provisioned active access cards. The network server closet and patch panels are housed in a dedicated, climate-controlled room secured by a dedicated physical deadbolt accessible only by designated IT administrators.',
        recommendedEvidence: ['Office_Keycard_System_Screenshot.png', 'Server_Closet_Locked_Photo.jpg', 'Facility_Security_Plan.pdf']
      },
      {
        title: 'Small Business / Remote Office Facility Controls',
        description: 'Small commercial suite with commercial lockset and locked file cabinets.',
        category: 'physical',
        narrative: 'The company facility is secured by commercial keyed deadbolts and an alarm system armed during non-business hours. All networking gear is housed in a locked wall-mount data enclosure. Physical contract records are stored in locked fireproof filing cabinets with keys held exclusively by the Operations Officer.',
        recommendedEvidence: ['Locked_Network_Cabinet_Photo.jpg', 'Key_Issuance_Log.pdf']
      }
    ]
  },
  {
    id: 'PE.L1-3.10.3',
    title: 'Escort Visitors and Monitor Visitor Activity',
    domain: 'PE',
    farReference: 'FAR 52.204-21(b)(1)(ix)',
    plainEnglishSummary: 'Escort all visitors inside your facility, make them wear visitor badges, and continuously monitor their activity in work areas.',
    discussion: 'Unescorted visitors in physical facilities present risks of eavesdropping, unauthorized physical network tapping, or theft. Visitors must be escorted at all times in areas containing information systems.',
    assessmentObjectives: [
      'Visitors are escorted within facility areas containing organizational systems.',
      'Visitor activity is continuously monitored during their stay.'
    ],
    auditorChecklist: [
      'Visitor Escort and Monitoring Policy.',
      'High-contrast visitor badges issued at reception.',
      'Sample employee training sign-off on visitor escort responsibilities.'
    ],
    starterTemplates: [
      {
        title: 'Continuous Visitor Escort & Badge Protocol',
        description: 'Standard visitor reception check-in and continuous escort protocol.',
        category: 'physical',
        narrative: 'All external visitors (contractors, clients, repair technicians) are required to check in at the reception desk, present government-issued photo ID, receive a high-visibility numbered visitor badge, and be met by their designated host employee. Visitors must be escorted continuously at all times while inside the physical facility boundary.',
        recommendedEvidence: ['Visitor_Policy_Document.pdf', 'Visitor_Badge_Photo.jpg', 'Host_Escort_Procedure.pdf']
      }
    ]
  },
  {
    id: 'PE.L1-3.10.4',
    title: 'Maintain Audit Logs of Physical Access',
    domain: 'PE',
    farReference: 'FAR 52.204-21(b)(1)(ix)',
    plainEnglishSummary: 'Keep an auditable physical or digital log of all visitors entering and leaving your facility with dates, times, and signatures.',
    discussion: 'Maintaining physical access logs enables retrospective investigation in the event of a security incident or lost hardware. Visitor logs must record the visitor name, organization, date, entry/exit time, and authorized host.',
    assessmentObjectives: [
      'Audit logs of physical access by visitors are maintained.',
      'Physical access audit logs are retained for compliance review.'
    ],
    auditorChecklist: [
      'Physical Visitor Sign-in/Sign-out Logbook or digital visitor management kiosk logs.',
      'Retention policy showing logs are preserved for minimum 1 year.',
      'Sample log entries showing visitor name, company, date, time-in, time-out, and host signature.'
    ],
    starterTemplates: [
      {
        title: 'Digital Visitor Kiosk & Retained Audit Logs',
        description: 'Digital check-in kiosk system with automated log archiving.',
        category: 'physical',
        narrative: 'Visitor entries and exits are recorded electronically via a digital iPad check-in kiosk at the main entrance. The system records full name, organization, purpose of visit, host employee, timestamp of arrival, and timestamp of departure. Electronic logs are backed up automatically to secure cloud storage and retained for a minimum of 12 months for compliance audit.',
        recommendedEvidence: ['Visitor_Log_Export_Report.pdf', 'Digital_Kiosk_Configuration.png', 'Log_Retention_Policy.pdf']
      },
      {
        title: 'Physical Reception Logbook Protocol',
        description: 'Physical bound visitor register maintained by front desk staff.',
        category: 'physical',
        narrative: 'A physical bound visitor logbook is maintained at the main reception entrance. All visitors must record their name, organization, citizenship/ID verification, time in, time out, and host employee name. Completed logbooks are archived in a locked administrative filing cabinet and retained for at least one year.',
        recommendedEvidence: ['Sample_Visitor_Log_Sheet.pdf', 'Reception_Staff_SOP.pdf']
      }
    ]
  },
  {
    id: 'PE.L1-3.10.5',
    title: 'Control Physical Access Devices',
    domain: 'PE',
    farReference: 'FAR 52.204-21(b)(1)(ix)',
    plainEnglishSummary: 'Control and track all keys, keycards, access fobs, and lock combinations that grant entrance into your building and offices.',
    discussion: 'Physical access devices (brass keys, RFID badges, alarm codes, smart locks) must be formally inventoried, issued only to authorized personnel, revoked upon employee termination, and audited periodically.',
    assessmentObjectives: [
      'Physical access devices (keys, keycards, fobs) are identified and inventoried.',
      'Physical access devices are controlled and managed throughout their lifecycle.'
    ],
    auditorChecklist: [
      'Physical key & badge issuance inventory log.',
      'Employee termination / offboarding checklist showing return of keys and deactivation of keycards.',
      'Lock re-keying or access code change procedures.'
    ],
    starterTemplates: [
      {
        title: 'Centralized Electronic Badge Management & Master Key Registry',
        description: 'Procedures for managing electronic badges and physical keys.',
        category: 'physical',
        narrative: 'All physical brass keys and electronic RFID keycards are cataloged in a master Key Control Registry managed by the Facilities Officer. Keycards are assigned to individuals by badge number; brass keys for the server room are stamped with unique serial numbers and signed out. When an employee leaves the company, badge deactivation and key return are mandatory offboarding checklist items.',
        recommendedEvidence: ['Master_Key_Badge_Register.xlsx', 'Offboarding_Checklist_KeyReturn.pdf', 'Key_Control_Policy.pdf']
      }
    ]
  },

  // -------------------------------------------------------------
  // SYSTEM & COMMUNICATIONS PROTECTION (SC) - 2 Controls
  // -------------------------------------------------------------
  {
    id: 'SC.L1-3.13.1',
    title: 'Boundary Defense and Firewalls',
    domain: 'SC',
    farReference: 'FAR 52.204-21(b)(1)(x)',
    plainEnglishSummary: 'Deploy and maintain firewalls and boundary defenses at all external network entry points to block unauthorized network traffic.',
    discussion: 'Firewalls, gateway security appliances, and host-based firewalls form the outer and inner perimeter defense against unauthorized network connections, port scanning, and unauthorized inbound data flows.',
    assessmentObjectives: [
      'Organizational communications are monitored at external boundaries of the systems.',
      'Organizational communications are controlled at external boundaries of the systems.',
      'Organizational communications are protected at external boundaries of the systems.',
      'Key internal boundaries of the systems are identified.',
      'Organizational communications are monitored at key internal boundaries of the systems.',
      'Organizational communications are controlled at key internal boundaries of the systems.'
    ],
    auditorChecklist: [
      'Next-Gen Firewall (NGFW) configuration report (default-deny inbound rule).',
      'Host-based firewall policy (Windows Defender Firewall active on all profiles).',
      'IDS/IPS (Intrusion Detection/Prevention) configuration and active subscription.'
    ],
    starterTemplates: [
      {
        title: 'Next-Generation Perimeter Firewall & Windows Defender Firewall',
        description: 'Perimeter gateway firewall combined with endpoint host firewalls.',
        category: 'm365',
        narrative: 'Perimeter network boundaries are defended by a commercial Next-Generation Firewall (NGFW). The firewall enforces a default-deny inbound rule, allowing only established outbound connections. In addition, host-based firewalls (Windows Defender Firewall) are centrally managed via Intune/GPO and forced active on all Domain, Private, and Public network profiles.',
        recommendedEvidence: ['Perimeter_Firewall_Rules_Config.pdf', 'Intune_Endpoint_Firewall_Profile.png', 'Network_Boundary_Diagram.png']
      },
      {
        title: 'GCP Cloud Armor & VPC Firewall Rules',
        description: 'Google Cloud VPC firewall rules enforcing boundary isolation.',
        category: 'gcp',
        narrative: 'Cloud network boundaries are secured using Google Cloud VPC firewall rules and Google Cloud Armor. Inbound network connections from untrusted external networks are blocked by default. Traffic between microservices and database subnets is restricted via internal firewall tags and service account ingress filtering.',
        recommendedEvidence: ['GCP_VPC_Firewall_Rules.json', 'Cloud_Armor_Policy_Settings.png']
      }
    ]
  },
  {
    id: 'SC.L1-3.13.5',
    title: 'Subnetwork Isolation (DMZ / Guest Wi-Fi)',
    domain: 'SC',
    farReference: 'FAR 52.204-21(b)(1)(xi)',
    plainEnglishSummary: 'Isolate publicly accessible servers and guest Wi-Fi networks from your internal company network on separate VLANs or subnetworks.',
    discussion: 'Public-accessible services (e.g. public web servers) and guest Wi-Fi networks must be isolated from the internal network holding FCI so that a compromise of the public service or guest network does not allow lateral movement into internal systems.',
    assessmentObjectives: [
      'Publicly accessible systems are identified.',
      'Subnetworks for publicly accessible system components are separated from internal organizational networks.'
    ],
    auditorChecklist: [
      'VLAN and subnet configuration sheet from managed switches/firewall.',
      'Guest Wi-Fi network configuration showing client isolation and separate VLAN.',
      'Cloud hosting verification for public company website (outside internal boundary).'
    ],
    starterTemplates: [
      {
        title: 'VLAN Segmentation & Isolated Guest Wi-Fi',
        description: 'Network segmentation separating corporate devices from guest Wi-Fi and IoT.',
        category: 'physical',
        narrative: 'The corporate network is segmented into isolated VLANs: VLAN 10 (Corporate Systems & Workstations), VLAN 20 (Guest Wi-Fi with client isolation and no routing to internal LAN), and VLAN 30 (IoT/Printers). The public website is hosted externally on a third-party cloud platform completely outside the corporate network boundary.',
        recommendedEvidence: ['VLAN_Configuration_Report.png', 'Guest_WiFi_Isolation_Settings.png', 'Network_Segmentation_Diagram.pdf']
      },
      {
        title: 'GCP VPC Subnet Segregation & Serverless VPC Access',
        description: 'VPC subnets isolating public services from private Cloud SQL and compute workloads.',
        category: 'gcp',
        narrative: 'Workloads are deployed across distinct VPC subnets. Public HTTP/S traffic terminates at an external Cloud Load Balancer, while application containers (Cloud Run) and databases (Cloud SQL) reside in private IP subnets with Private Google Access enabled. No public database or internal application ports are reachable from the public internet.',
        recommendedEvidence: ['GCP_Subnet_Topology.pdf', 'Private_Service_Access_Config.png']
      }
    ]
  },

  // -------------------------------------------------------------
  // SYSTEM & INFORMATION INTEGRITY (SI) - 4 Controls
  // -------------------------------------------------------------
  {
    id: 'SI.L1-3.14.1',
    title: 'Flaw Remediation and Patch Management',
    domain: 'SI',
    farReference: 'FAR 52.204-21(b)(1)(xii)',
    plainEnglishSummary: 'Regularly identify, test, and install security updates and software patches on all operating systems and applications in a timely manner.',
    discussion: 'Known vulnerabilities are the most common entry point for malware and threat actors. Organizations must maintain an active patch management routine to apply critical OS and third-party software updates within defined SLAs (e.g. within 14-30 days of release).',
    assessmentObjectives: [
      'Information system flaws are identified.',
      'Information system flaws are reported.',
      'Information system flaws are corrected.'
    ],
    auditorChecklist: [
      'Patch Management Policy with defined installation SLAs.',
      'Windows Update for Business / Intune / RMM patch compliance report.',
      'Vulnerability scan report or software patch audit logs.'
    ],
    starterTemplates: [
      {
        title: 'Automated Patch Management via Intune / Windows Update',
        description: 'Automated patch rings and third-party software update management.',
        category: 'm365',
        narrative: 'Operating system and application patch management is automated via Microsoft Intune Windows Update rings. Critical and security updates are set to automatically install within 5 days of release with forced reboots scheduled outside business hours. Third-party applications (browsers, Adobe, Zoom) are managed and kept up-to-date automatically.',
        recommendedEvidence: ['Intune_Patch_Compliance_Report.png', 'Patch_Management_Policy.pdf', 'Software_Update_Ring_Config.png']
      },
      {
        title: 'Google Cloud OS Patch Management & Container Vulnerability Scanning',
        description: 'Automated GCP OS Patching and Artifact Analysis container vulnerability scanning.',
        category: 'gcp',
        narrative: 'Virtual machines utilize GCP VM Manager OS Patch Management with scheduled maintenance windows for kernel and security patching. Application containers deployed to Cloud Run are continuously scanned for vulnerabilities upon push to Artifact Registry via Google Cloud Container Analysis.',
        recommendedEvidence: ['GCP_Patch_Deployment_Schedule.png', 'Artifact_Registry_Vulnerability_Scan.pdf']
      }
    ]
  },
  {
    id: 'SI.L1-3.14.2',
    title: 'Malicious Code Protection (Anti-Malware / EDR)',
    domain: 'SI',
    farReference: 'FAR 52.204-21(b)(1)(xiii)',
    plainEnglishSummary: 'Install and maintain anti-virus, anti-malware, or Endpoint Detection & Response (EDR) software on all workstations and servers.',
    discussion: 'Endpoints must have active endpoint security software running to detect, block, and quarantine malicious code (viruses, worms, Trojan horses, spyware, ransomware) at designated system entry and exit points.',
    assessmentObjectives: [
      'Designated locations within organizational systems are identified for malicious code protection.',
      'Malicious code protection is provided at designated locations within organizational systems.'
    ],
    auditorChecklist: [
      'Endpoint Detection and Response (EDR) / Antivirus central management dashboard.',
      'Proof of anti-malware agent installation across 100% of endpoints.',
      'Real-time protection policy configuration.'
    ],
    starterTemplates: [
      {
        title: 'Microsoft Defender for Business / Endpoint EDR',
        description: 'Enterprise EDR deployed across all company endpoints.',
        category: 'm365',
        narrative: 'Microsoft Defender for Business (EDR) is deployed across 100% of company workstations and servers via Microsoft Intune. Real-time behavioral monitoring, cloud-delivered protection, and automatic remediation of detected threats are enforced. Tamper protection is enabled to prevent end-users from disabling antivirus services.',
        recommendedEvidence: ['Defender_Security_Center_Dashboard.png', 'Intune_Antivirus_Policy_Settings.png', 'EDR_Agent_Roster.xlsx']
      },
      {
        title: 'Google Security Command Center & CrowdStrike Falcon',
        description: 'Cloud posture monitoring paired with endpoint protection agent.',
        category: 'gcp',
        narrative: 'All corporate endpoints are equipped with CrowdStrike Falcon / Defender EDR reporting to a central console with real-time prevention enabled. Google Cloud infrastructure is monitored continuously by Google Security Command Center (SCC) to detect malware, unauthorized cryptomining, and anomaly indicators.',
        recommendedEvidence: ['Security_Command_Center_Dashboard.png', 'CrowdStrike_Agent_Deployment_Report.pdf']
      }
    ]
  },
  {
    id: 'SI.L1-3.14.4',
    title: 'Update Malicious Code Protection',
    domain: 'SI',
    farReference: 'FAR 52.204-21(b)(1)(xiv)',
    plainEnglishSummary: 'Ensure anti-virus definitions and security signatures update automatically as soon as new releases become available.',
    discussion: 'Antivirus software is only effective if its threat intelligence signatures and detection algorithms are current. Definitions must be updated automatically, multiple times per day.',
    assessmentObjectives: [
      'Malicious code protection mechanisms are updated as new releases are available.'
    ],
    auditorChecklist: [
      'Automatic signature update policy settings in EDR / Antivirus portal.',
      'Evidence showing definition updates occurring at least daily (or continuously via cloud intelligence).',
      'Alert notification setup for endpoints with outdated signatures (>48 hours).'
    ],
    starterTemplates: [
      {
        title: 'Continuous Cloud-Delivered Antivirus Definition Updates',
        description: 'Cloud intelligence and daily signature updates for antivirus engines.',
        category: 'm365',
        narrative: 'Antivirus signatures and cloud-delivered protection definitions update automatically multiple times per day through Microsoft Defender Cloud Intelligence. Endpoints check for definition updates every 4 hours. Centralized telemetry in the security center alerts administrators if an endpoint fails to update signatures within 48 hours.',
        recommendedEvidence: ['Defender_Signature_Update_Schedule.png', 'Security_Center_Device_Health.png']
      }
    ]
  },
  {
    id: 'SI.L1-3.14.5',
    title: 'Perform Periodic System Scans',
    domain: 'SI',
    farReference: 'FAR 52.204-21(b)(1)(xv)',
    plainEnglishSummary: 'Run regular full or quick system scans for malware and automatically scan external files and USB drives when opened.',
    discussion: 'In addition to real-time on-access scanning, systems must undergo periodic scheduled full/quick scans, and external media (USB drives, downloads, email attachments) must be scanned prior to execution.',
    assessmentObjectives: [
      'Periodic scans of organizational systems are performed.',
      'Real-time scans of files from external sources are performed as the files are downloaded, opened, or executed.'
    ],
    auditorChecklist: [
      'Scheduled scan configuration policy (weekly quick/full scans).',
      'On-access scan settings for external USB drives and downloads.',
      'Scan logs indicating historical scan execution.'
    ],
    starterTemplates: [
      {
        title: 'Weekly Scheduled Antivirus Scans & Real-Time Download Scanning',
        description: 'Automated weekly system scans plus on-access scanning for USB and downloads.',
        category: 'm365',
        narrative: 'All managed endpoints are configured via Intune policy to perform a scheduled quick antivirus scan daily at 12:00 PM and a full deep system scan every Friday evening. In addition, real-time scanning automatically inspects all files downloaded from the internet, email attachments, and connected USB storage devices upon insertion.',
        recommendedEvidence: ['Defender_Scheduled_Scan_Policy.png', 'Sample_Endpoint_Scan_History.png']
      }
    ]
  },
];
