import fs from 'fs';
import path from 'path';
import { guideFor, fillGuideText } from '../src/data/guidance/frameworkGuides';
import { guidanceDomainSummary } from '../src/data/guidance/guidanceDomains';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { programFrameworkControls } from '../src/data/programScope';

/** The Framework Guidance page: per-framework guide content and the per-domain summary. Pure data plus source checks. No rendering. */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const ruleText = (g: ReturnType<typeof guideFor>) => g.rules.map((r) => `${r.title} ${r.body}`).join('\n');

const l1 = guideFor('CMMC_L1');
assert(l1.title.includes('FAR 52.204-21') && l1.approval.status === 'APPROVED', 'Level 1 keeps its approved title');
const l2 = guideFor('CMMC_L2');
assert(ruleText(l2).includes('SPRS') && ruleText(l2).includes('C3PAO') && !ruleText(l2).includes('NOT permitted'), 'Level 2 talks about SPRS and the C3PAO and does not carry the Level 1 zero-POA&M rule', ruleText(l2));
assert(!/Level 1/.test(l2.title) && l2.approval.status === 'DRAFT', 'Level 2 has its own title and is a draft', l2.title);
assert(guideFor('SOC_2_TYPE_II').key === 'GENERIC' && guideFor('HIPAA_SECURITY').key === 'GENERIC', 'SOC 2 and HIPAA use the generic guide');
assert(guideFor('nist-800-53-r5').key === 'NIST_800_53_REV5', 'the NIST alias resolves to the NIST guide');

for (const id of ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY']) {
  const g = guideFor(id, 'MODERATE');
  assert(g.title.length > 0 && g.rules.length >= 1 && g.sources.length >= 1, `${id}: a title, rules and sources`);
}

for (const [b, label] of [['HIGH', 'High'], ['LOW', 'Low'], ['MODERATE', 'Moderate']] as const) {
  assert(guideFor('NIST_800_53_REV5', b).subtitle.includes(label), `NIST subtitle names the ${label} baseline`);
}
assert(guideFor('NIST_800_53_REV5', null).subtitle.length > 0 && guideFor('NIST_800_53_REV5', 'MODERATE').sections.length >= 2, 'NIST without a baseline still has a subtitle; it has RMF and tailoring sections');

// Counts are placeholders, never literals (whole numbers only: "800-171" is a document name, not a count)
for (const id of ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY']) {
  const text = guideFor(id, 'HIGH').rules.map((r) => r.body).join('\n');
  assert(!/\b17\b/.test(text) && !/\b110\b/.test(text), `${id}: no literal control count in the rule text`);
}
assert(fillGuideText('All {controls} of {x}', { controls: 17 }) === 'All 17 of {x}', 'fillGuideText fills known placeholders and leaves unknown ones');

// The capabilities lists name no product
const vendors = /\b(microsoft|entra|defender|intune|bitlocker|okta|crowdstrike|splunk|jamf|sentinel|elastic)\b/i;
for (const g of [l1, l2]) {
  const caps = g.sections.map((s) => JSON.stringify(s)).join('\n');
  assert(!vendors.test(caps), `${g.key}: sections name no vendor product`);
}

// Domain summaries
const l1Controls = getFrameworkControls('CMMC_L1');
const l1Domains = guidanceDomainSummary('CMMC_L1', l1Controls);
assert(l1Domains.length === 6 && l1Domains.reduce((n, d) => n + d.count, 0) === l1Controls.length, 'Level 1: 6 domains, counts add up to the controls', l1Domains.map((d) => d.count));
const l2Controls = getFrameworkControls('CMMC_L2');
const l2Domains = guidanceDomainSummary('CMMC_L2', l2Controls);
assert(l2Domains.length === 14 && l2Domains.reduce((n, d) => n + d.count, 0) === 110, 'Level 2: 14 domains, counts add up to 110', l2Domains.map((d) => d.count));
const nistControls = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE', privacyBaseline: false }, { nonNetworkedOnly: false });
const nistDomains = guidanceDomainSummary('NIST_800_53_REV5', nistControls);
assert(nistControls.length > 0 && nistDomains.reduce((n, d) => n + d.count, 0) === nistControls.length && nistDomains.every((d) => d.count > 0), 'NIST Moderate: counts add up to the controls and no domain is empty', nistDomains.length);
const big = guidanceDomainSummary('NIST_800_53_REV5', nistControls).find((d) => d.count === 22);
const bigAny = nistDomains.find((d) => d.count > 6)!;
assert(bigAny.ids.length === 6 && bigAny.more === bigAny.count - 6, 'a large domain lists 6 ids and counts the rest', { count: bigAny.count, more: bigAny.more });
if (big) assert(big.ids.length === 6 && big.more === 16, 'a 22-control domain: 6 ids, 16 more');
const fake = Array.from({ length: 22 }, (_, i) => ({ id: `AC-${i + 1}`, domain: 'AC' }));
const fakeDomains = guidanceDomainSummary('NIST_800_53_REV5', fake, 6);
assert(fakeDomains.length === 1 && fakeDomains[0].ids.length === 6 && fakeDomains[0].more === 16, '22 controls with maxIds 6: ids 6, more 16', fakeDomains);
assert(guidanceDomainSummary('NO_SUCH_FRAMEWORK', l1Controls).length === 0, 'an unknown framework has no domains');

// Source checks
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const view = read('src/components/guidance/AssessmentGuidanceView.tsx');
assert(view.includes('useTenant(') && view.includes('guideFor('), 'the view follows the active program');
assert(!view.includes('CMMC_LEVEL_1_CONTROLS') && !view.includes('CMMC Level 1 & FAR'), 'the view has no fixed Level 1 content');
assert(!view.includes('dangerouslySetInnerHTML'), 'the view injects no HTML');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
