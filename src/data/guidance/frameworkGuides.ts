// Practitioner guides for the Framework Guidance page, one per framework of the active program. Pure data.
// Counts (controls, domains, SPRS points) are never written into the text: they are placeholders such as {controls} that the
// view fills from the program's own controls (see fillGuideText). Body text may use **bold**.
import { getFrameworkGuidanceText } from '../frameworks/frameworkHelpers';
import { FRAMEWORK_REGISTRY, normalizeFrameworkId } from '../frameworks/frameworkRegistry';
import type { ComplianceFramework } from '../../types/framework';

export type GuideTone = 'amber' | 'brand' | 'emerald' | 'sky' | 'violet' | 'rose';
export type GuideIcon = 'alert' | 'shield' | 'lock' | 'layers' | 'scale' | 'clipboard' | 'sparkles';

export interface GuideCard {
  id: string;
  icon: GuideIcon;
  tone: GuideTone;
  title: string;
  body: string;
}

export interface GuideSection {
  id: string;
  heading: string;
  icon: GuideIcon;
  intro?: string;
  cards: GuideCard[];
}

export interface FrameworkGuide {
  key: 'CMMC_L1' | 'CMMC_L2' | 'NIST_800_53_REV5' | 'GENERIC';
  title: string;
  subtitle: string;
  rules: GuideCard[];
  domainsHeading: (count: number) => string;
  /** [singular, plural] noun for one item of a domain ("Practice", "requirement", ...). */
  domainUnit: [string, string];
  showDomainIds: boolean;
  sections: GuideSection[];
  /** Plain text citations (no links) to check the guide against. */
  sources: string[];
  approval: { status: 'DRAFT' | 'APPROVED' };
}

/** Replaces {name} placeholders with the given values; an unknown placeholder is left as written. */
export function fillGuideText(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

// Vendor-neutral capabilities (the app is tool-agnostic): what to have, not which product to buy.
const CAPABILITY_CARDS_L1: GuideCard[] = [
  {
    id: 'identity',
    icon: 'shield',
    tone: 'brand',
    title: 'Identity & Access',
    body: 'A central identity provider with multi-factor authentication (number matching or a hardware key) for every account, and role-based access control.',
  },
  {
    id: 'endpoint',
    icon: 'layers',
    tone: 'violet',
    title: 'Endpoint & EDR',
    body: 'Endpoint detection and response on every workstation, plus automated patch update rings managed from one console.',
  },
  {
    id: 'media',
    icon: 'lock',
    tone: 'emerald',
    title: 'Disk Encryption & Media',
    body: 'Full-disk encryption centrally enforced on every laptop and desktop, plus a cross-cut paper shredder for printed FCI.',
  },
  {
    id: 'perimeter',
    icon: 'alert',
    tone: 'amber',
    title: 'Perimeter Security',
    body: 'A next-generation firewall with default-deny inbound rules and an isolated guest Wi-Fi network.',
  },
  {
    id: 'physical',
    icon: 'clipboard',
    tone: 'sky',
    title: 'Physical Access',
    body: 'A locked network cabinet, a visitor sign-in/out logbook at reception and an escort protocol.',
  },
  {
    id: 'public',
    icon: 'sparkles',
    tone: 'rose',
    title: 'Public Information',
    body: 'A formal pre-publication review process for marketing material and public web posts.',
  },
];

const CMMC_L1_GUIDE: FrameworkGuide = {
  key: 'CMMC_L1',
  title: 'CMMC Level 1 & FAR 52.204-21 Practitioner Guide',
  subtitle: 'Essential regulatory frameworks, assessment scoping rules, and SPRS reporting standards for defense contractors.',
  rules: [
    {
      id: 'zero-poam',
      icon: 'alert',
      tone: 'amber',
      title: 'Zero POA&M Rule',
      body: 'Under CMMC 2.0 Level 1, **Plans of Action & Milestones (POA&Ms) are NOT permitted**. All {controls} controls must be completely implemented and evaluated as **MET** before an organization can claim Level 1 compliance.',
    },
    {
      id: 'self-attestation',
      icon: 'shield',
      tone: 'brand',
      title: 'Annual Self-Attestation',
      body: 'CMMC Level 1 requires an **annual self-assessment** and executive affirmation entered into the Supplier Performance Risk System (SPRS) signed by a senior corporate official (C-Suite).',
    },
    {
      id: 'fci-scope',
      icon: 'lock',
      tone: 'emerald',
      title: 'FCI Protection Scope',
      body: 'Level 1 safeguards **Federal Contract Information (FCI)**—information not intended for public release, provided by or generated for the Government under a contract. (Controlled Unclassified Information requires Level 2).',
    },
  ],
  domainsHeading: (count) => `The ${count} Level 1 Security Domains Explained`,
  domainUnit: ['Practice', 'Practices'],
  showDomainIds: true,
  sections: [
    {
      id: 'capabilities',
      heading: 'Recommended Small Business Compliance Stack',
      icon: 'sparkles',
      intro: 'For small contractors looking for the most cost-effective and auditor-proven set of capabilities to satisfy all {controls} practices. Pick the products that fit your environment; what matters is that each capability is in place:',
      cards: CAPABILITY_CARDS_L1,
    },
  ],
  sources: [
    'FAR 52.204-21, Basic Safeguarding of Covered Contractor Information Systems',
    '32 CFR Part 170, Cybersecurity Maturity Model Certification (CMMC) Program',
    'NIST SP 800-171 Rev. 2, Protecting Controlled Unclassified Information in Nonfederal Systems and Organizations',
  ],
  approval: { status: 'APPROVED' },
};

const CMMC_L2_GUIDE: FrameworkGuide = {
  key: 'CMMC_L2',
  title: 'CMMC Level 2 & NIST SP 800-171 Rev. 2 Practitioner Guide',
  subtitle: 'Scoping rules, SPRS scoring and POA&M limits for contractors that handle Controlled Unclassified Information (CUI).',
  rules: [
    {
      id: 'cui-scope',
      icon: 'lock',
      tone: 'emerald',
      title: 'CUI Protection Scope',
      body: 'Level 2 requires **{controls} requirements in {domains} families** that protect **Controlled Unclassified Information (CUI)**. Every requirement must be met, or covered by an allowed POA&M, before the assessment can lead to certification.',
    },
    {
      id: 'sprs',
      icon: 'scale',
      tone: 'brand',
      title: 'SPRS Score',
      body: 'Your SPRS score starts at **{sprsMax}** and drops by **5, 3 or 1 point** for each unmet requirement, down to a floor of **{sprsMin}**. Of the {controls} requirements in this program, {five} are worth 5 points, {three} are worth 3 points and {one} are worth 1 point. SSP requirement 3.12.4 carries no points but must be met.',
    },
    {
      id: 'poam',
      icon: 'alert',
      tone: 'amber',
      title: 'POA&M Limits',
      body: 'A **Conditional** status needs a score of **at least 88**. Only **1-point** requirements may stay open, except SC.L2-3.13.11 when encryption is used but is not FIPS-validated. AC.L2-3.1.20, AC.L2-3.1.22, CA.L2-3.12.4, PE.L2-3.10.3, PE.L2-3.10.4 and PE.L2-3.10.5 may **never** be on a POA&M. Close every item out within **180 days**.',
    },
    {
      id: 'assessment',
      icon: 'shield',
      tone: 'violet',
      title: 'Assessment & Affirmation',
      body: 'A **C3PAO** certification assessment is repeated **every 3 years** (or a self-assessment, where the contract allows it), plus an **annual affirmation** by a senior official in SPRS.',
    },
  ],
  domainsHeading: (count) => `The ${count} Security Requirement Families Explained`,
  domainUnit: ['requirement', 'requirements'],
  showDomainIds: true,
  sections: [
    {
      id: 'scoping',
      heading: 'Scoping your CUI assets',
      icon: 'layers',
      intro: 'Sort every asset into one of five categories before you assess. The category decides how much of the requirement set applies to it.',
      cards: [
        {
          id: 'cui-assets',
          icon: 'lock',
          tone: 'emerald',
          title: 'CUI Assets',
          body: 'Assets that process, store or transmit CUI. All requirements apply and they are assessed in full.',
        },
        {
          id: 'security-protection',
          icon: 'shield',
          tone: 'brand',
          title: 'Security Protection Assets',
          body: 'Assets that provide security functions for the CUI environment, such as identity, logging and firewalls. They are assessed against the requirements that relate to their function.',
        },
        {
          id: 'crm',
          icon: 'scale',
          tone: 'violet',
          title: 'Contractor Risk Managed Assets',
          body: 'Assets that can, but are not intended to, handle CUI. Document them in the SSP and manage them by your own risk-based policy; they are not assessed in depth.',
        },
        {
          id: 'specialized',
          icon: 'alert',
          tone: 'amber',
          title: 'Specialized Assets',
          body: 'Operational technology, IoT and test equipment. Document them in the SSP and show how you manage their risk.',
        },
        {
          id: 'out-of-scope',
          icon: 'clipboard',
          tone: 'sky',
          title: 'Out-of-Scope Assets',
          body: 'Assets that cannot handle CUI because they are physically or logically separated from it. No requirements apply, but the separation has to be defensible.',
        },
      ],
    },
    {
      id: 'dfars',
      heading: 'DFARS 252.204-7012 obligations',
      icon: 'scale',
      intro: 'Beyond the requirement set, the DFARS clause puts two contract obligations on you.',
      cards: [
        {
          id: 'incident-reporting',
          icon: 'alert',
          tone: 'rose',
          title: 'Cyber incident reporting',
          body: 'Report a cyber incident that affects covered defense information to the DoD within **72 hours** of discovery, and preserve the images and logs for the investigation.',
        },
        {
          id: 'cloud',
          icon: 'shield',
          tone: 'sky',
          title: 'Cloud service providers',
          body: 'A cloud service that stores or processes CUI must meet **FedRAMP Moderate** or an equivalent set of security requirements, and must follow the same incident reporting rules.',
        },
      ],
    },
    {
      id: 'capabilities',
      heading: 'Example capabilities',
      icon: 'sparkles',
      intro: 'Most Level 2 environments need the capabilities below. Choose products that fit your environment; the guide does not recommend a vendor.',
      cards: [
        {
          id: 'identity',
          icon: 'shield',
          tone: 'brand',
          title: 'Identity & Access',
          body: 'A central identity provider with phishing-resistant multi-factor authentication for every account that touches CUI.',
        },
        {
          id: 'edr',
          icon: 'layers',
          tone: 'violet',
          title: 'Endpoint detection & response',
          body: 'Endpoint detection and response on every CUI asset, with alerts someone actually reads.',
        },
        {
          id: 'logging',
          icon: 'clipboard',
          tone: 'sky',
          title: 'Centralized logging',
          body: 'Audit logs from the CUI assets collected in one place (a SIEM or a log server), protected from tampering and reviewed on a schedule.',
        },
        {
          id: 'mdm',
          icon: 'lock',
          tone: 'amber',
          title: 'Device management',
          body: 'Mobile device management or group policy that enforces configuration baselines and full-disk encryption.',
        },
        {
          id: 'fips',
          icon: 'lock',
          tone: 'emerald',
          title: 'FIPS-validated encryption',
          body: 'Cryptography that protects CUI in transit and at rest uses FIPS-validated modules.',
        },
      ],
    },
  ],
  sources: [
    'NIST SP 800-171 Rev. 2, Protecting Controlled Unclassified Information in Nonfederal Systems and Organizations',
    'NIST SP 800-171A, Assessing Security Requirements for Controlled Unclassified Information',
    '32 CFR Part 170, Cybersecurity Maturity Model Certification (CMMC) Program',
    'DoD Assessment Methodology (NIST SP 800-171 DoD Assessment Methodology)',
    'DFARS 252.204-7012, Safeguarding Covered Defense Information and Cyber Incident Reporting',
    'CMMC Scoping Guide, Level 2',
  ],
  approval: { status: 'DRAFT' },
};

const NIST_BASELINE_LABEL: Record<string, string> = { LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High' };

function nistGuide(baseline?: string | null): FrameworkGuide {
  const label = baseline ? NIST_BASELINE_LABEL[baseline.trim().toUpperCase()] : undefined;
  return {
    key: 'NIST_800_53_REV5',
    title: 'NIST SP 800-53 Rev. 5 Practitioner Guide',
    subtitle: label
      ? `${label} baseline, per SP 800-53B. Selecting, tailoring and assessing security and privacy controls.`
      : 'Security and privacy baselines, per SP 800-53B. Selecting, tailoring and assessing controls.',
    rules: [
      {
        id: 'baselines',
        icon: 'layers',
        tone: 'brand',
        title: 'Baselines',
        body: 'SP 800-53B defines **Low**, **Moderate** and **High** security baselines and a separate **Privacy** baseline that can be added on top. This program uses {controls} controls.',
      },
      {
        id: 'categorization',
        icon: 'scale',
        tone: 'violet',
        title: 'Categorization drives the baseline',
        body: 'The **FIPS 199** impact level of the system (confidentiality, integrity and availability) decides which baseline you start from.',
      },
      {
        id: 'poam',
        icon: 'alert',
        tone: 'amber',
        title: 'POA&M and authorization',
        body: 'Every deficiency is tracked in a **POA&M** with milestones. The **Authorizing Official** weighs the residual risk and decides whether to grant the ATO.',
      },
    ],
    domainsHeading: (count) => `The ${count} Control Families in Your Baseline`,
    domainUnit: ['control', 'controls'],
    showDomainIds: true,
    sections: [
      {
        id: 'rmf',
        heading: 'Risk Management Framework steps',
        icon: 'clipboard',
        intro: 'SP 800-37 organizes the work into seven steps.',
        cards: [
          { id: 'prepare', icon: 'clipboard', tone: 'sky', title: '1. Prepare', body: 'Set roles, risk tolerance and the common controls the system can inherit.' },
          { id: 'categorize', icon: 'scale', tone: 'violet', title: '2. Categorize', body: 'Decide the impact level of the system and its information with FIPS 199.' },
          { id: 'select', icon: 'layers', tone: 'brand', title: '3. Select', body: 'Start from the baseline for that impact level, then tailor it.' },
          { id: 'implement', icon: 'lock', tone: 'emerald', title: '4. Implement', body: 'Put the controls in place and document how in the System Security Plan.' },
          { id: 'assess', icon: 'shield', tone: 'amber', title: '5. Assess', body: 'An assessor checks that the controls work as intended and reports the gaps.' },
          { id: 'authorize', icon: 'alert', tone: 'rose', title: '6. Authorize', body: 'The Authorizing Official accepts the risk and issues, or refuses, the authorization to operate.' },
          { id: 'monitor', icon: 'sparkles', tone: 'sky', title: '7. Monitor', body: 'Watch the controls and the system continuously and report changes in risk.' },
        ],
      },
      {
        id: 'tailoring',
        heading: 'Tailoring and overlays',
        icon: 'layers',
        intro: 'A baseline is a starting point. Tailor it to the system before you assess.',
        cards: [
          {
            id: 'odp',
            icon: 'clipboard',
            tone: 'brand',
            title: 'Organization-defined parameters',
            body: 'Many controls leave a value for you to set (a frequency, a time limit, a list). Fill in every ODP and keep the values with the SSP.',
          },
          {
            id: 'non-networked',
            icon: 'shield',
            tone: 'emerald',
            title: 'Non-networked overlay',
            body: 'For a stand-alone or air-gapped system, the non-networked overlay removes the controls that only make sense with a network connection. Record the reason for the scope you choose.',
          },
        ],
      },
    ],
    sources: [
      'NIST SP 800-53 Rev. 5, Security and Privacy Controls for Information Systems and Organizations',
      'NIST SP 800-53B, Control Baselines for Information Systems and Organizations',
      'NIST SP 800-37 Rev. 2, Risk Management Framework for Information Systems and Organizations',
      'FIPS 199, Standards for Security Categorization of Federal Information and Information Systems',
    ],
    approval: { status: 'DRAFT' },
  };
}

function genericGuide(framework: string): FrameworkGuide {
  const info = getFrameworkGuidanceText(normalizeFrameworkId(framework) as ComplianceFramework);
  const label = FRAMEWORK_REGISTRY[framework]?.shortName ?? framework;
  return {
    key: 'GENERIC',
    title: `${label} Practitioner Guide`,
    subtitle: info.scopeDescription,
    rules: [
      { id: 'authority', icon: 'scale', tone: 'brand', title: 'Authority', body: `${info.authority}. Reference: ${info.standardRef}.` },
      { id: 'exceptions', icon: 'alert', tone: 'amber', title: 'Exceptions and corrective action', body: info.poamPolicyText },
      { id: 'scope', icon: 'shield', tone: 'emerald', title: 'What to satisfy', body: info.inProgressGuidance },
    ],
    domainsHeading: (count) => `The ${count} Control Areas in Your Program`,
    domainUnit: ['control', 'controls'],
    showDomainIds: false,
    sections: [],
    sources: [info.authority, info.standardRef],
    approval: { status: 'DRAFT' },
  };
}

/** The guide for a framework id (any alias); SOC 2, HIPAA and anything unknown get the generic guide. */
export function guideFor(framework: string, baseline?: string | null): FrameworkGuide {
  switch (normalizeFrameworkId(framework)) {
    case 'CMMC_L1':
      return CMMC_L1_GUIDE;
    case 'CMMC_L2':
      return CMMC_L2_GUIDE;
    case 'NIST_800_53_REV5':
      return nistGuide(baseline);
    default:
      return genericGuide(framework);
  }
}
