/**
 * Plans shown on the PUBLIC landing page (pricing section and the "request a license" form).
 *
 * This is marketing content only. Nothing in the application knows about plans: a tenant, a user and an invitation have no
 * price or tier, and an installation has no billing. What a tenant may do is decided by its assessment program (the
 * frameworks a platform administrator enabled for it): see data/programs.ts.
 */

export type MarketingPlanId = 'FOUNDATIONAL' | 'DEFENSE_PRO' | 'ENTERPRISE';
export type LegacyPlanId = 'single-org' | 'msp-assessor';
export type PlanId = MarketingPlanId | LegacyPlanId;

export interface MarketingPlan {
  id: MarketingPlanId;
  name: string;
  badgeLabel: string;
  price: number;
  priceFormatted: string;
  priceSubtext: string;
  target: string;
  features: string[];
  recommended?: boolean;
}

export const MARKETING_PLANS: Record<MarketingPlanId, MarketingPlan> = {
  FOUNDATIONAL: {
    id: 'FOUNDATIONAL',
    name: 'Foundational Enclave',
    badgeLabel: 'Foundational ($3,500/yr)',
    price: 3500,
    priceFormatted: '$3,500',
    priceSubtext: '/ year',
    target: 'Small Suppliers & Commercial Organizations (FAR 52.204-21, HIPAA, SOC 2 Type II)',
    features: [
      '1 Enclave Boundary (Cloud SQL RLS isolation)',
      'CMMC Level 1 (17 Controls) or HIPAA / SOC 2',
      'PDF Artifact Exporter & evidence hashing',
      'Single-User Owner administrative seat',
      'Standard Support & Knowledge Base',
    ],
  },
  DEFENSE_PRO: {
    id: 'DEFENSE_PRO',
    name: 'Defense Professional',
    badgeLabel: 'Defense Pro ($7,000/yr)',
    price: 7000,
    priceFormatted: '$7,000',
    priceSubtext: '/ year',
    recommended: true,
    target: 'DoD Prime & Sub-Contractors handling CUI (NIST SP 800-171 / CMMC Level 2)',
    features: [
      'CMMC Level 2 (110 Controls) & NIST SP 800-171',
      'NIST SP 800-53 Rev 5 (Low/Mod + Tactical Overlays)',
      'DISA STIG Library & Ansible/PowerShell Script Generator',
      'Dynamic NIST SP 800-18 SSP & POA&M Compiler',
      'Cross-Framework Evidence Inheritance',
      '5 User Seats included',
    ],
  },
  ENTERPRISE: {
    id: 'ENTERPRISE',
    name: 'Enterprise & Assessor Enclave',
    badgeLabel: 'Enterprise ($14,000/yr)',
    price: 14000,
    priceFormatted: '$14,000',
    priceSubtext: '/ year',
    target: 'Defense MSPs, Multi-CAGE Enterprise Organizations & C3PAO Assessor Networks',
    features: [
      'Unlimited Enclaves / Multi-Boundary Management',
      'OpenSCAP Engine & Asset Sensor API Integration',
      'Custom Baseline Overlays & Tailored Control Scopes',
      'Dedicated Database Isolation & Cloud SQL RLS',
      'Priority 24/7 Defense Engineering Support',
      'Unlimited Assessor & Lead Auditor Team Seats',
    ],
  },
};

export function normalizePlanId(tier?: string | null): MarketingPlanId {
  if (!tier) return 'FOUNDATIONAL';
  if (tier === 'DEFENSE_PRO') return 'DEFENSE_PRO';
  if (tier === 'ENTERPRISE' || tier === 'msp-assessor') return 'ENTERPRISE';
  if (tier === 'FOUNDATIONAL' || tier === 'single-org') return 'FOUNDATIONAL';
  return 'FOUNDATIONAL';
}

export function getPlanPrice(tier?: string | null): number {
  const norm = normalizePlanId(tier);
  return MARKETING_PLANS[norm].price;
}

export function getPlanLabel(tier?: string | null): string {
  const norm = normalizePlanId(tier);
  return MARKETING_PLANS[norm].name;
}

export function getPlanBadge(tier?: string | null): { label: string; badge: string; priceFormatted: string } {
  const norm = normalizePlanId(tier);
  const details = MARKETING_PLANS[norm];
  return {
    label: details.name,
    badge: details.badgeLabel,
    priceFormatted: details.priceFormatted,
  };
}
