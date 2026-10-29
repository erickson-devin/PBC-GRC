import fs from 'fs';
import path from 'path';
import { defaultCloneSourceId } from '../src/data/programCloneSource';
import {
  DEFAULT_CLOUD_PROVIDERS,
  defaultBoundaryNarrative,
  refreshBoundaryNarrative,
  refreshSystemName,
} from '../src/data/onboardingDefaults';

/**
 * #29(d) / #29(e): the clone-source default follows the chosen framework (no same-framework program: the user must choose),
 * and the onboarding wizard's proposed texts follow the organization name and name no vendor. Pure test: no server.
 */
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

const P = [
  { id: 'a', framework: 'CMMC_L2' },
  { id: 'b', framework: 'NIST_800_53_REV5' },
  { id: 'c', framework: 'NIST_800_53_REV5' },
] as const;

console.log('--- clone source default ---');
assert(defaultCloneSourceId(P, 'a', 'CMMC_L2') === 'a', 'the active program of the same framework');
assert(defaultCloneSourceId(P, 'a', 'NIST_800_53_REV5') === 'b', 'first program of the framework when the active one is another framework');
assert(defaultCloneSourceId(P, 'c', 'NIST_800_53_REV5') === 'c', 'the active program wins over an earlier one of the same framework');
assert(defaultCloneSourceId(P, 'a', 'CMMC_L1') === '', 'no program of the framework: empty, the user must choose');
assert(defaultCloneSourceId(P, null, 'CMMC_L2') === 'a', 'no active program: first of the framework');
assert(defaultCloneSourceId(P, 'gone', 'CMMC_L2') === 'a', 'an active program that is not open: first of the framework');

console.log('--- onboarding defaults ---');
assert(refreshSystemName('Acme LLC Operations Boundary', 'Acme LLC', 'Acme Defense, Inc.') === 'Acme Defense, Inc. Operations Boundary', 'proposed Operations Boundary follows the organization name');
assert(refreshSystemName('Acme LLC Information Network (CIN)', 'Acme LLC', 'Acme Defense') === 'Acme Defense Information Network (CIN)', 'proposed CIN name follows the organization name');
assert(refreshSystemName('Prod CUI Enclave', 'Acme LLC', 'Acme Defense') === 'Prod CUI Enclave', 'a typed system name is kept');
assert(refreshSystemName('Corporate Operations Boundary', '', 'Acme') === 'Acme Operations Boundary', 'an empty previous organization derives from "Corporate"');
assert(refreshBoundaryNarrative(defaultBoundaryNarrative('Acme LLC'), 'Acme LLC', 'Acme Defense') === defaultBoundaryNarrative('Acme Defense'), 'the proposed narrative follows the organization name');
assert(refreshBoundaryNarrative('My own text', 'Acme LLC', 'Acme Defense') === 'My own text', 'a typed narrative is kept');
const narrative = defaultBoundaryNarrative('Acme');
assert(narrative.includes('Acme') && !/Microsoft|Google|Entra|Cloudflare|cloud/i.test(narrative), 'the narrative names the organization and no vendor');
assert(DEFAULT_CLOUD_PROVIDERS === '', 'the cloud-services field starts empty');

console.log('--- sources ---');
const onboarding = fs.readFileSync(path.join(process.cwd(), 'src/components/onboarding/OnboardingModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
assert(!/Microsoft Entra ID|Google Workspace|Google Cloud Platform|Cloudflare/.test(onboarding), 'OnboardingModal.tsx names no vendor');
assert(onboarding.includes('refreshSystemName(') && onboarding.includes('refreshBoundaryNarrative('), 'OnboardingModal.tsx refreshes the proposed texts');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
process.exit(passed === total ? 0 : 1);
