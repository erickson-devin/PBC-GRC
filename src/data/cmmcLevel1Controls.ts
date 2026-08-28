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
    totalControls: 2,
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
        narrative: 'All user accounts are provisioned exclusively through Microsoft Entra ID (Azure AD). Individual named user accounts are required for all staff; generic and shared accounts are prohibited. Device access is restricted to company-managed laptops enrolled in Microsoft Intune MDM with compliant device status policies enforced via Entra Conditional Access.',
        recommendedEvidence: ['M365_ActiveUsers_Export.csv', 'Intune_EnrolledDevices_List.pdf', 'Access_Control_Policy_v2.pdf']
      },
      {
        title: 'Hybrid Active Directory & On-Premises Environment',
        description: 'Traditional on-premises Windows Server Domain Controller with local network controls.',
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
        narrative: 'Standard day-to-day user accounts do not possess local administrator rights on company endpoints. Elevated privileges are strictly assigned to dedicated secondary administrative accounts (e.g. `admin-jdoe`) used exclusively for system configuration. Role-based access control (RBAC) in cloud applications ensures employees only access folders and repositories required for their assigned job duties.',
        recommendedEvidence: ['Endpoint_LocalAdmins_Audit.png', 'M365_AdminRoles_Screenshot.png', 'RBAC_Permissions_Matrix.xlsx']
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
        narrative: 'All remote access to internal corporate systems requires encrypted WireGuard/IPsec VPN connections authenticated with Multi-Factor Authentication (MFA). Direct Remote Desktop Protocol (RDP) ports (3389) are strictly blocked at the perimeter firewall. Cloud services are protected by Entra ID Conditional Access policies requiring trusted locations or compliant devices.',
        recommendedEvidence: ['Network_Topology_Diagram.pdf', 'Firewall_InboundRules_Export.png', 'VPN_Config_Settings.pdf']
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
        narrative: 'All employees are issued unique User Principal Names (UPNs) formatted as `firstname.lastname@company.com`. Generic and shared credentials are prohibited. All corporate laptops and workstations are assigned unique asset identifiers (e.g. `CORP-LAP-042`) and registered in the centralized device management directory.',
        recommendedEvidence: ['User_Directory_Roster.png', 'Device_Asset_Inventory.xlsx']
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
        narrative: 'Authentication is enforced centrally via Microsoft Entra ID. Password complexity requirements mandate a minimum length of 14 characters. Multi-Factor Authentication (MFA) using the Microsoft Authenticator app (Number Matching) is strictly enforced for 100% of user accounts. Account lockout is triggered after 5 consecutive failed attempts.',
        recommendedEvidence: ['M365_MFA_Registration_Report.png', 'Password_Policy_GPO_Export.png']
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
        narrative: 'All digital storage media (SSDs, NVMe drives) are encrypted with BitLocker (AES-256) throughout their lifecycle. Prior to decommissioning or hardware reuse, drives undergo cryptographic wipe using DoD 5220.22-M / NIST SP 800-88 Clear/Purge standards. Non-reusable storage media are sent to a NAID-certified electronic destruction partner with serialized certificates of destruction retained.',
        recommendedEvidence: ['Media_Sanitization_Policy.pdf', 'Sample_Destruction_Certificate.pdf', 'Shredder_Purchase_Receipt.png']
      }
    ]
  },

  // -------------------------------------------------------------
  // PHYSICAL PROTECTION (PE) - 2 Controls
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
        narrative: 'Physical entrance to the corporate office is secured 24/7 via electronic RFID badge access. Only vetted full-time personnel are provisioned active access cards. The network server closet and patch panels are housed in a dedicated, climate-controlled room secured by a dedicated physical deadbolt accessible only by designated IT administrators.',
        recommendedEvidence: ['Office_Keycard_System_Screenshot.png', 'Server_Closet_Locked_Photo.jpg', 'Facility_Security_Plan.pdf']
      },
      {
        title: 'Small Business / Remote Office Facility Controls',
        description: 'Small commercial suite with commercial lockset and locked file cabinets.',
        narrative: 'The company facility is secured by commercial keyed deadbolts and an alarm system armed during non-business hours. All networking gear is housed in a locked wall-mount data enclosure. Physical contract records are stored in locked fireproof filing cabinets with keys held exclusively by the Operations Officer.',
        recommendedEvidence: ['Locked_Network_Cabinet_Photo.jpg', 'Key_Issuance_Log.pdf']
      }
    ]
  },
  {
    id: 'PE.L1-3.10.3',
    title: 'Escort Visitors and Maintain Audit Logs',
    domain: 'PE',
    farReference: 'FAR 52.204-21(b)(1)(ix)',
    plainEnglishSummary: 'Escort all visitors inside your facility, make them wear visitor badges, and keep a signed visitor logbook with dates and times.',
    discussion: 'Unescorted visitors in physical facilities present risks of eavesdropping, unauthorized physical network tapping, or theft. Visitors must be escorted at all times in areas containing information systems, and their entry/exit must be recorded in an auditable physical or electronic log.',
    assessmentObjectives: [
      'Visitors are escorted.',
      'Audit logs of physical access by visitors are maintained.'
    ],
    auditorChecklist: [
      'Visitor Access Policy.',
      'Physical Visitor Sign-in/Sign-out Logbook or digital visitor kiosk records.',
      'Visitor badge protocol (temporary visitor badges issued upon arrival).'
    ],
    starterTemplates: [
      {
        title: 'Formal Visitor Logbook and Continuous Escort Protocol',
        description: 'Standard visitor reception sign-in and escort protocol.',
        narrative: 'All external visitors (contractors, vendors, clients) must report to reception, show government-issued photo ID, sign the Visitor Logbook (recording name, organization, arrival/departure time, and host employee), and wear a visible high-contrast "VISITOR" badge. Visitors must be continuously escorted by an authorized employee throughout their visit.',
        recommendedEvidence: ['Visitor_Sign_In_Log_Sample.pdf', 'Visitor_Badge_Photo.jpg', 'Visitor_Management_Policy.pdf']
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
        narrative: 'Perimeter network boundaries are defended by a commercial Next-Generation Firewall (NGFW). The firewall enforces a default-deny inbound rule, allowing only established outbound connections. In addition, host-based firewalls (Windows Defender Firewall) are centrally managed via Intune/GPO and forced active on all Domain, Private, and Public network profiles.',
        recommendedEvidence: ['Perimeter_Firewall_Rules_Config.pdf', 'Intune_Endpoint_Firewall_Profile.png', 'Network_Boundary_Diagram.png']
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
        narrative: 'The corporate network is segmented into isolated VLANs: VLAN 10 (Corporate Systems & Workstations), VLAN 20 (Guest Wi-Fi with client isolation and no routing to internal LAN), and VLAN 30 (IoT/Printers). The public website is hosted externally on a third-party cloud platform completely outside the corporate network boundary.',
        recommendedEvidence: ['VLAN_Configuration_Report.png', 'Guest_WiFi_Isolation_Settings.png', 'Network_Segmentation_Diagram.pdf']
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
        narrative: 'Operating system and application patch management is automated via Microsoft Intune Windows Update rings. Critical and security updates are set to automatically install within 5 days of release with forced reboots scheduled outside business hours. Third-party applications (browsers, Adobe, Zoom) are managed and kept up-to-date automatically.',
        recommendedEvidence: ['Intune_Patch_Compliance_Report.png', 'Patch_Management_Policy.pdf', 'Software_Update_Ring_Config.png']
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
        narrative: 'Microsoft Defender for Business (EDR) is deployed across 100% of company workstations and servers via Microsoft Intune. Real-time behavioral monitoring, cloud-delivered protection, and automatic remediation of detected threats are enforced. Tamper protection is enabled to prevent end-users from disabling antivirus services.',
        recommendedEvidence: ['Defender_Security_Center_Dashboard.png', 'Intune_Antivirus_Policy_Settings.png', 'EDR_Agent_Roster.xlsx']
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
        narrative: 'All managed endpoints are configured via Intune policy to perform a scheduled quick antivirus scan daily at 12:00 PM and a full deep system scan every Friday evening. In addition, real-time scanning automatically inspects all files downloaded from the internet, email attachments, and connected USB storage devices upon insertion.',
        recommendedEvidence: ['Defender_Scheduled_Scan_Policy.png', 'Sample_Endpoint_Scan_History.png']
      }
    ]
  },
];
