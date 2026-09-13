import { ControlMapping } from '../../types/framework';

/**
 * Cross-Framework Control Mappings
 * Connects CMMC Level 1 & 2, NIST SP 800-53 Rev 5, SOC 2 Type II, and HIPAA Security Rule.
 */
export const CANONICAL_CONTROL_MAPPINGS: ControlMapping[] = [
  // -------------------------------------------------------------
  // ACCESS CONTROL (CMMC AC.L1 / NIST AC / SOC 2 CC6 / HIPAA 164.312)
  // -------------------------------------------------------------
  {
    id: 'map-ac-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-2',
    mappingType: 'EQUIVALENT',
    notes: 'Account Management and Authorized System Access',
  },
  {
    id: 'map-ac-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.1',
    mappingType: 'EQUIVALENT',
    notes: 'Logical Access Security and Registration',
  },
  {
    id: 'map-ac-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.312(a)(1)',
    mappingType: 'EQUIVALENT',
    notes: 'Access Control: Unique User Identification',
  },
  {
    id: 'map-ac-4',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.2',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-3',
    mappingType: 'EQUIVALENT',
    notes: 'Access Enforcement / Role-Based Access Control',
  },
  {
    id: 'map-ac-5',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.2',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.2',
    mappingType: 'EQUIVALENT',
    notes: 'Access Credential Authorization & Least Privilege',
  },
  {
    id: 'map-ac-6',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.2',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.312(a)(1)',
    mappingType: 'EQUIVALENT',
    notes: 'Emergency Access & Role-Based Enforcement',
  },
  {
    id: 'map-ac-7',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.20',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-20',
    mappingType: 'EQUIVALENT',
    notes: 'Use of External Information Systems',
  },
  {
    id: 'map-ac-8',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.20',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.6',
    mappingType: 'EQUIVALENT',
    notes: 'Boundary Protection and External System Connections',
  },
  {
    id: 'map-ac-9',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.22',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-22',
    mappingType: 'EQUIVALENT',
    notes: 'Publicly Accessible Content Control',
  },
  {
    id: 'map-ac-10',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'AC.L1-3.1.22',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.7',
    mappingType: 'EQUIVALENT',
    notes: 'Data Classification and Public Posting Restrictions',
  },

  // -------------------------------------------------------------
  // IDENTIFICATION & AUTHENTICATION (IA)
  // -------------------------------------------------------------
  {
    id: 'map-ia-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'IA-2',
    mappingType: 'EQUIVALENT',
    notes: 'Identification and Authentication of Organizational Users',
  },
  {
    id: 'map-ia-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.1',
    mappingType: 'EQUIVALENT',
    notes: 'User Authentication & Multi-Factor Authentication',
  },
  {
    id: 'map-ia-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.312(d)',
    mappingType: 'EQUIVALENT',
    notes: 'Person or Entity Authentication',
  },
  {
    id: 'map-ia-4',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.2',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'IA-5',
    mappingType: 'EQUIVALENT',
    notes: 'Authenticator Management and Password Complexity',
  },
  {
    id: 'map-ia-5',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.2',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.1',
    mappingType: 'EQUIVALENT',
    notes: 'Credential Management Policies',
  },
  {
    id: 'map-ia-6',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'IA.L1-3.5.2',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.308(a)(5)(ii)(D)',
    mappingType: 'EQUIVALENT',
    notes: 'Password Management Safeguard',
  },

  // -------------------------------------------------------------
  // MEDIA PROTECTION (MP)
  // -------------------------------------------------------------
  {
    id: 'map-mp-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'MP.L1-3.8.3',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'MP-6',
    mappingType: 'EQUIVALENT',
    notes: 'Media Sanitization and Destruction',
  },
  {
    id: 'map-mp-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'MP.L1-3.8.3',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.5',
    mappingType: 'EQUIVALENT',
    notes: 'Logical & Physical Asset Disposal',
  },
  {
    id: 'map-mp-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'MP.L1-3.8.3',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.310(d)(2)(i)',
    mappingType: 'EQUIVALENT',
    notes: 'Device and Media Disposal and Reuse',
  },

  // -------------------------------------------------------------
  // PHYSICAL PROTECTION (PE)
  // -------------------------------------------------------------
  {
    id: 'map-pe-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'PE-2',
    mappingType: 'EQUIVALENT',
    notes: 'Physical Access Authorizations',
  },
  {
    id: 'map-pe-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.4',
    mappingType: 'EQUIVALENT',
    notes: 'Physical Facility Access Boundaries',
  },
  {
    id: 'map-pe-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.310(a)(1)',
    mappingType: 'EQUIVALENT',
    notes: 'Facility Access Controls: Contingency & Security Operations',
  },
  {
    id: 'map-pe-4',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.3',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'PE-3',
    mappingType: 'EQUIVALENT',
    notes: 'Physical Access Control & Visitor Escorts',
  },
  {
    id: 'map-pe-5',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.3',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.4',
    mappingType: 'EQUIVALENT',
    notes: 'Visitor Escorts and Facility Logs',
  },
  {
    id: 'map-pe-6',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.4',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'PE-4',
    mappingType: 'EQUIVALENT',
    notes: 'Access Control for Transmission Medium and Logs',
  },
  {
    id: 'map-pe-7',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'PE.L1-3.10.5',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'PE-5',
    mappingType: 'EQUIVALENT',
    notes: 'Access Control for Display Devices',
  },

  // -------------------------------------------------------------
  // SYSTEM & COMMUNICATIONS PROTECTION (SC)
  // -------------------------------------------------------------
  {
    id: 'map-sc-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SC.L1-3.13.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SC-7',
    mappingType: 'EQUIVALENT',
    notes: 'Boundary Protection (Network Firewalls & DMZs)',
  },
  {
    id: 'map-sc-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SC.L1-3.13.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.6',
    mappingType: 'EQUIVALENT',
    notes: 'Network Perimeter Defenses and Ingress/Egress Filtering',
  },
  {
    id: 'map-sc-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SC.L1-3.13.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.312(e)(1)',
    mappingType: 'EQUIVALENT',
    notes: 'Transmission Security - Network Integrity & Guards',
  },
  {
    id: 'map-sc-4',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SC.L1-3.13.5',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SC-7(7)',
    mappingType: 'EQUIVALENT',
    notes: 'Subnetwork Segregation for Public Facing Services',
  },
  {
    id: 'map-sc-5',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SC.L1-3.13.5',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.6',
    mappingType: 'EQUIVALENT',
    notes: 'DMZ Subnet Isolation and Micro-segmentation',
  },

  // -------------------------------------------------------------
  // SYSTEM & INFORMATION INTEGRITY (SI)
  // -------------------------------------------------------------
  {
    id: 'map-si-1',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SI-2',
    mappingType: 'EQUIVALENT',
    notes: 'Flaw Remediation / Vulnerability Management',
  },
  {
    id: 'map-si-2',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC7.1',
    mappingType: 'EQUIVALENT',
    notes: 'Patch Management and Vulnerability Detection',
  },
  {
    id: 'map-si-3',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.308(a)(1)(ii)(D)',
    mappingType: 'EQUIVALENT',
    notes: 'Information System Activity Review & Flaw Correction',
  },
  {
    id: 'map-si-4',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.2',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SI-3',
    mappingType: 'EQUIVALENT',
    notes: 'Malicious Code Protection (EDR / Anti-malware)',
  },
  {
    id: 'map-si-5',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.2',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC6.8',
    mappingType: 'EQUIVALENT',
    notes: 'Endpoint Detection and Malicious Code Prevention',
  },
  {
    id: 'map-si-6',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.2',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.308(a)(5)(ii)(B)',
    mappingType: 'EQUIVALENT',
    notes: 'Protection from Malicious Software',
  },
  {
    id: 'map-si-7',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.4',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SI-4',
    mappingType: 'EQUIVALENT',
    notes: 'Information System Monitoring / Threat Signatures',
  },
  {
    id: 'map-si-8',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.4',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC7.2',
    mappingType: 'EQUIVALENT',
    notes: 'Security Anomaly and Threat Event Monitoring',
  },
  {
    id: 'map-si-9',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.5',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'SI-5',
    mappingType: 'EQUIVALENT',
    notes: 'System Alerts, Advisories, and Directives',
  },
  {
    id: 'map-si-10',
    sourceFramework: 'CMMC_L1',
    sourceControlId: 'SI.L1-3.14.5',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC7.3',
    mappingType: 'EQUIVALENT',
    notes: 'Security Incident Detection and Vulnerability Advisories',
  },

  // -------------------------------------------------------------
  // CMMC LEVEL 2 / NIST SP 800-171 ADVANCED MAPPINGS
  // -------------------------------------------------------------
  {
    id: 'map-l2-ac-1',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AC.L2-3.1.3',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-4',
    mappingType: 'EQUIVALENT',
    notes: 'Information Flow Enforcement',
  },
  {
    id: 'map-l2-ac-2',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AC.L2-3.1.7',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-6',
    mappingType: 'EQUIVALENT',
    notes: 'Least Privilege and Non-Privileged Account Usage',
  },
  {
    id: 'map-l2-ac-3',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AC.L2-3.1.12',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AC-17',
    mappingType: 'EQUIVALENT',
    notes: 'Remote Access Monitoring & Encryption',
  },
  {
    id: 'map-l2-au-1',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AU.L2-3.3.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'AU-2',
    mappingType: 'EQUIVALENT',
    notes: 'Audit Events and Log Creation',
  },
  {
    id: 'map-l2-au-2',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AU.L2-3.3.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC7.2',
    mappingType: 'EQUIVALENT',
    notes: 'Security Log Generation and Monitoring',
  },
  {
    id: 'map-l2-au-3',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'AU.L2-3.3.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.312(b)',
    mappingType: 'EQUIVALENT',
    notes: 'Audit Controls for Hardware, Software & Mechanisms',
  },
  {
    id: 'map-l2-cm-1',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'CM.L2-3.4.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'CM-2',
    mappingType: 'EQUIVALENT',
    notes: 'Baseline Configuration Creation and Maintenance',
  },
  {
    id: 'map-l2-cm-2',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'CM.L2-3.4.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC8.1',
    mappingType: 'EQUIVALENT',
    notes: 'Change Management and Baseline Configuration',
  },
  {
    id: 'map-l2-ir-1',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'IR.L2-3.6.1',
    targetFramework: 'NIST_800_53_REV5',
    targetControlId: 'IR-4',
    mappingType: 'EQUIVALENT',
    notes: 'Incident Handling and Investigation',
  },
  {
    id: 'map-l2-ir-2',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'IR.L2-3.6.1',
    targetFramework: 'SOC_2_TYPE_II',
    targetControlId: 'CC7.3',
    mappingType: 'EQUIVALENT',
    notes: 'Incident Response and Remediation Protocol',
  },
  {
    id: 'map-l2-ir-3',
    sourceFramework: 'CMMC_L2',
    sourceControlId: 'IR.L2-3.6.1',
    targetFramework: 'HIPAA_SECURITY',
    targetControlId: '164.308(a)(6)(i)',
    mappingType: 'EQUIVALENT',
    notes: 'Security Incident Procedures',
  },
];

/**
 * Returns all mapped control definitions for a given source or target control ID
 * Bidirectional lookup supported!
 */
export function getCrossFrameworkMappings(controlId: string): ControlMapping[] {
  const cleanId = controlId.trim().toUpperCase();
  return CANONICAL_CONTROL_MAPPINGS.filter(
    m => m.sourceControlId.toUpperCase() === cleanId || m.targetControlId.toUpperCase() === cleanId
  );
}

/**
 * Returns a list of equivalent control IDs across other frameworks
 */
export function getEquivalentControlIds(controlId: string): string[] {
  const mappings = getCrossFrameworkMappings(controlId);
  const ids = new Set<string>();
  const cleanId = controlId.trim().toUpperCase();

  for (const m of mappings) {
    if (m.sourceControlId.toUpperCase() === cleanId) {
      ids.add(m.targetControlId);
    } else {
      ids.add(m.sourceControlId);
    }
  }

  return Array.from(ids);
}
