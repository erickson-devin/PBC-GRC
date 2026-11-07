import fs from 'fs';
import path from 'path';
import {
  draftFromSaved,
  isDraftComplete,
  draftToProfile,
  stackValueLabel,
  odpSummaryLabel,
  chosenStepCount,
  DEFAULT_ODP_PARAMS,
  type StackDraft,
} from '../src/data/stackDraftView';
import { STACK_PROFILE_ENUMS, STACK_PROFILE_ENUM_KEYS, validateStackProfile } from '../src/data/stackProfileSchema';
import type { EnclaveStackProfile, Tenant } from '../src/types/tenant';
import { effectiveStackProfile, withEffectiveStack } from '../src/data/effectiveStackProfile';

/** The Enclave Stack Survey draft: nothing is chosen for the user, a custom solution carries its own label. Pure, plus source checks. */
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const empty = draftFromSaved(undefined);
assert(STACK_PROFILE_ENUM_KEYS.every((k) => empty[k] === undefined) && same(empty.odpParams, {}) && same(empty.customLabels, {}), 'no profile: nothing chosen, no ODP values', empty);
assert(!isDraftComplete(empty) && chosenStepCount(empty) === 0, 'an empty draft is incomplete');
assert(draftToProfile({ identityProvider: 'OKTA', odpParams: {}, customLabels: {} }) === null, 'a partial draft has no profile');
assert(Object.keys(DEFAULT_ODP_PARAMS).length > 0 && same(draftFromSaved(null).odpParams, {}), 'the ODP defaults are not copied into a draft');

const full: EnclaveStackProfile = {
  identityProvider: 'OKTA',
  edrSolution: 'SENTINELONE',
  infrastructure: 'ON_PREM_RHEL',
  mdmSolution: 'JAMF',
  siemSolution: 'ELASTIC',
  odpParams: { INACTIVITY_TIMEOUT: '10 minutes' },
};
const back = draftToProfile(draftFromSaved(full));
assert(same(back, full), 'a full valid profile round-trips', back);
assert(isDraftComplete(draftFromSaved(full)), 'a full profile is a complete draft');

const customNoLabel: StackDraft = { ...draftFromSaved(full), identityProvider: 'CUSTOM' };
assert(!isDraftComplete(customNoLabel) && draftToProfile(customNoLabel) === null, 'CUSTOM without a label is incomplete and has no profile');
const blankLabel: StackDraft = { ...customNoLabel, customLabels: { identityProvider: '   ' } };
assert(!isDraftComplete(blankLabel), 'a blank label does not count');
const customOk: StackDraft = { ...customNoLabel, customLabels: { identityProvider: ' Keycloak ' } };
const customProfile = draftToProfile(customOk);
assert(customProfile !== null && customProfile.identityProvider === 'CUSTOM' && customProfile.customLabels?.identityProvider === 'Keycloak', 'CUSTOM with a label is valid and the label is trimmed', customProfile);
assert(stackValueLabel('identityProvider', 'CUSTOM', { identityProvider: 'Keycloak' }) === 'Keycloak', 'the label of a custom choice is shown');
assert(stackValueLabel('identityProvider', 'CUSTOM') === 'Custom solution', 'a custom choice without a label reads Custom solution');
assert(stackValueLabel('identityProvider', undefined) === null, 'an unset step has no label');
assert(stackValueLabel('identityProvider', 'ACTIVE_DIRECTORY') === 'Active Directory', 'a known value has its short name');

for (const key of STACK_PROFILE_ENUM_KEYS) {
  const labels = STACK_PROFILE_ENUMS[key].map((v) => stackValueLabel(key, v));
  assert(labels.every((l) => typeof l === 'string' && l.length > 0) && new Set(labels).size === labels.length, `${key}: every value has its own non-empty label`, labels);
}
assert(stackValueLabel('edrSolution', 'NOT_A_VALUE') === null, 'an unknown value falls through to nothing, not to another option');

assert(odpSummaryLabel({}) === 'none entered' && odpSummaryLabel(undefined) === 'none entered', 'no ODP values: none entered');
assert(odpSummaryLabel({ A: 'x', B: ' ', C: 'y' }) === '2 entered', 'blank ODP values are not counted');
const dropped = draftToProfile({ ...draftFromSaved(full), odpParams: { INACTIVITY_TIMEOUT: '', LOCKOUT_LIMIT: '5' } });
assert(same(dropped?.odpParams, { LOCKOUT_LIMIT: '5' }), 'a blank ODP value is not saved', dropped);

// validateStackProfile
const withLabelNotCustom = validateStackProfile({ ...full, customLabels: { identityProvider: 'Keycloak' } });
assert(!withLabelNotCustom.ok, 'a custom label on a step that is not CUSTOM is rejected');
const longLabel = validateStackProfile({ ...full, identityProvider: 'CUSTOM', customLabels: { identityProvider: 'x'.repeat(200) } });
assert(!longLabel.ok, 'a 200-character label is rejected');
const edge = validateStackProfile({ ...full, identityProvider: 'CUSTOM', customLabels: { identityProvider: 'x'.repeat(120) } });
assert(edge.ok, 'a 120-character label is accepted');
const ctrl = validateStackProfile({ ...full, identityProvider: 'CUSTOM', customLabels: { identityProvider: 'bad\u0007label' } });
assert(!ctrl.ok, 'a label with a control character is rejected');
const missing = validateStackProfile({ ...full, identityProvider: 'CUSTOM' });
assert(!missing.ok, 'CUSTOM without a label is rejected by the schema');
const badKey = validateStackProfile({ ...full, customLabels: { nope: 'x' } });
assert(!badKey.ok, 'a label for an unknown step is rejected');
const emptyLabel = validateStackProfile({ ...full, identityProvider: 'CUSTOM', customLabels: { identityProvider: '' } });
assert(!emptyLabel.ok, 'an empty label is rejected');

// Source checks
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const modal = read('src/components/admin/EnclaveStackSurveyModal.tsx');
assert(!modal.includes('|| DEFAULT_STACK.') && !modal.includes('Cascade to All Objectives'), 'the modal fills nothing in behind the user');
assert(modal.includes('draftFromSaved(') && modal.includes('isDraftComplete(') && modal.includes('id="stack-save-note"'), 'the modal uses the draft helpers and has the save note');
const inspect = read('src/components/matrix/InspectDocumentModal.tsx');
assert(!inspect.includes("|| 'ENTRA_ID_COMMERCIAL'") && !inspect.includes("|| 'DEFENDER_FOR_ENDPOINT'"), 'the document inspector invents no stack');
assert(inspect.includes('NO_STACK_PROFILE_RECORDED'), 'the document inspector says so when no stack is recorded');

// #230: the program's stack profile, else the tenant's
const okta = { identityProvider: 'OKTA', edrSolution: 'SENTINELONE', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'JAMF', siemSolution: 'ELASTIC' } as unknown as EnclaveStackProfile;
const entra = { ...okta, identityProvider: 'ENTRA_ID_GOV' } as unknown as EnclaveStackProfile;
const orgTenant = { stackProfile: okta } as Tenant;
assert(effectiveStackProfile(orgTenant, null) === okta, 'E1 no program: the tenant profile');
assert(effectiveStackProfile(orgTenant, { stackProfile: null }) === okta, 'E2 a program without one: the tenant profile');
assert(effectiveStackProfile(orgTenant, { stackProfile: entra })?.identityProvider === 'ENTRA_ID_GOV', 'E3 the program profile wins');
assert(effectiveStackProfile({} as Tenant, { stackProfile: null }) === undefined, 'E4 neither: undefined');
assert(withEffectiveStack(orgTenant, null) === orgTenant, 'E5 the same object when nothing changes');
const merged = withEffectiveStack(orgTenant, { stackProfile: entra });
assert(merged.stackProfile?.identityProvider === 'ENTRA_ID_GOV' && orgTenant.stackProfile === okta && merged !== orgTenant, 'E6 a copy carries the program profile; the tenant is not mutated');
const settingsSrc = read('src/components/settings/EnclaveSettings.tsx');
const policyViewSrc = read('src/views/PolicyLibraryView.tsx');
assert([policyViewSrc, settingsSrc, inspect].every(s => s.includes('withEffectiveStack(')) && modal.includes('effectiveStackProfile('), 'E7 the four consumers read the effective profile');
assert(!policyViewSrc.includes('currentTenant.stackProfile') && !inspect.includes('currentTenant.stackProfile'), 'E7b the policy view and the document inspector never read the tenant profile directly');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
